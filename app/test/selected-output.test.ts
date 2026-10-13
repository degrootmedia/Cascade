/**
 * Selected-output unification (architecture hardening workstream 2,
 * recommendation 5 of the brief).
 *
 * The node-graph output pipe is the ONE source of truth for a shot's primary
 * visual. These tests pin:
 *   - the pure resolver (`resolveSelectedOutput`) the renderer and main
 *     share, branch for branch;
 *   - the one write-through (`setShotSelectedOutput`) — every flow that
 *     changes what a shot is showing lands there, so the `artwork`/
 *     `videoPath` mirrors cannot disagree with the pipe;
 *   - the canvas↔storyboard interop: selecting an older take re-derives the
 *     storyboard mirrors, promoting from history re-points the canvas
 *     selection, and both settle at a fixed point (`syncBoardOutputToPipe`
 *     becomes a no-op);
 *   - the end-to-end regression scenario: generate → select → a stale
 *     whole-document save → reload → export resolves exactly the shown output.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { resolveSelectedOutput, resolveShotDisplay } from "../src/shared/selected-output.js";
import {
  hookImageGenToOutput,
  hookVideoGenToOutput,
  recordBoardArtwork,
  recordGraphEditGen,
  recordGraphImageGen,
  recordGraphVideoGen,
  selectBoardFrame,
  setShotSelectedOutput,
  syncBoardOutputToPipe,
} from "../src/main/pipeline.js";
import { applyRendererState } from "../src/main/productions.js";
import { assemblyPlan } from "../src/main/assembly.js";

const take = (p: string, at = "2026-01-01T00:00:00.000Z") => ({ path: p, prompt: "", model: "auto", at });

function makeShot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: "s1", number: "0100", audio: "", visual: "A hero walks.", ...overrides };
}

function makeProduction(shots: ProductionShot[], overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "p1", name: "Prod", folder: "C:/w", createdAt: "", updatedAt: "", stepDone: 3, shotCount: shots.length },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: [{ number: 1, title: "S1", shots }],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    ...overrides,
  };
}

describe("resolveSelectedOutput", () => {
  it("resolves the image node's selected take", () => {
    const shot = makeShot({
      graphImageGens: [take("b/new.jpg"), take("b/old.jpg")],
      graphImageGenIndex: 1,
      graphOutputSource: "imagegen",
    });
    expect(resolveSelectedOutput(shot)).toEqual({ source: "imagegen", media: "still", path: "b/old.jpg" });
  });

  it("resolves an empty piped node as none (the output preview goes blank)", () => {
    expect(resolveSelectedOutput(makeShot({ graphOutputSource: "imagegen" }))).toEqual({ source: "imagegen", media: "none" });
  });

  it("resolves edit nodes by id, falling back to the first node", () => {
    const shot = makeShot({
      graphEditNodes: [
        { id: "edit0", prompt: "", gens: [take("b/e0.jpg")], genIndex: 0 },
        { id: "edit1", prompt: "", gens: [take("b/e1.jpg")], genIndex: 0 },
      ],
      graphOutputSource: "editgen",
      graphOutputEditNodeId: "edit1",
    });
    expect(resolveSelectedOutput(shot)).toEqual({ source: "editgen", nodeId: "edit1", media: "still", path: "b/e1.jpg" });
    expect(resolveSelectedOutput({ ...shot, graphOutputEditNodeId: undefined })).toEqual(
      { source: "editgen", nodeId: "edit0", media: "still", path: "b/e0.jpg" }
    );
  });

  it("resolves upscale, videogen, tween, and ref sources", () => {
    expect(resolveSelectedOutput(makeShot({
      graphUpscale: { gens: [take("b/up.jpg")], genIndex: 0 },
      graphOutputSource: "upscale",
    }))).toEqual({ source: "upscale", media: "still", path: "b/up.jpg" });

    expect(resolveSelectedOutput(makeShot({
      graphVideoNodes: [{ id: "vid0", prompt: "", gens: [take("v/clip.mp4")], genIndex: 0 }],
      graphOutputSource: "videogen",
    }))).toEqual({ source: "videogen", nodeId: "vid0", media: "clip", path: "v/clip.mp4" });

    expect(resolveSelectedOutput(makeShot({ graphTweenOutput: "v/stitch.mp4", graphOutputSource: "tween" })))
      .toEqual({ source: "tween", media: "clip", path: "v/stitch.mp4" });

    expect(resolveSelectedOutput(makeShot({
      graphOutputSource: "ref", graphOutputRefId: "r1", artwork: "b/ref.jpg",
    }))).toEqual({ source: "ref", refId: "r1", media: "still", path: "b/ref.jpg" });
  });

  it("returns none when nothing is piped", () => {
    expect(resolveSelectedOutput(makeShot())).toEqual({ media: "none" });
  });
});

describe("setShotSelectedOutput (the one write-through)", () => {
  it("binds imagegen and marks the shot migrated (the display resolves the take — no mirrors written)", () => {
    const shot = makeShot({ graphImageGens: [take("b/f.jpg")], graphImageGenIndex: 0 });
    setShotSelectedOutput(shot, { kind: "imagegen" });
    expect(shot.graphOutputSource).toBe("imagegen");
    expect(shot.graphOutputRefId).toBeUndefined();
    expect(shot.graphMigrated).toBe(true);
    expect(resolveShotDisplay(shot)).toMatchObject({ media: "still", path: "b/f.jpg" });
  });

  it("binds videogen and names the node (the clip + feed still resolve live)", () => {
    const shot = makeShot({
      graphImageGens: [take("b/src.jpg")],
      graphImageGenIndex: 0,
      graphVideoNodes: [{ id: "vid0", prompt: "", gens: [take("v/clip.mp4")], genIndex: 0, source: { kind: "imagegen" } }],
    });
    setShotSelectedOutput(shot, { kind: "videogen", nodeId: "vid0" });
    expect(shot.graphOutputSource).toBe("videogen");
    expect(shot.graphOutputVideoNodeId).toBe("vid0");
    expect(resolveShotDisplay(shot)).toMatchObject({
      media: "clip", path: "v/clip.mp4", stillPath: "b/src.jpg",
    });
  });

  it("unpipe clears the pipe so the display goes blank (legacy/ref mirrors cleared for their kind)", () => {
    const clip = makeShot({ graphOutputSource: "videogen", videoPath: "v/clip.mp4", artwork: "b/still.jpg" });
    setShotSelectedOutput(clip, { kind: "unpipe" });
    expect(clip.graphOutputSource).toBeUndefined();
    // The clip mirror is cleared; the frozen still survives as the legacy
    // fallback (the pre-cutover unpipe showed the still too).
    expect(resolveShotDisplay(clip)).toMatchObject({ media: "still", path: "b/still.jpg", legacy: true });
    expect(clip.artwork).toBe("b/still.jpg"); // a still survives a clip unpipe

    const still = makeShot({ graphOutputSource: "imagegen", artwork: "b/f.jpg", videoPath: "v/old.mp4" });
    setShotSelectedOutput(still, { kind: "unpipe" });
    expect(still.artwork).toBeUndefined();
  });

  it("ref still and clip selections record the rendered frame (their only take store)", () => {
    const still = makeShot({ artwork: "b/prev.jpg" });
    setShotSelectedOutput(still, { kind: "ref", refId: "r1", media: "still", path: "b/ref.jpg" });
    expect(still.graphOutputSource).toBe("ref");
    expect(still.graphOutputRefId).toBe("r1");
    expect(still.artwork).toBe("b/ref.jpg");
    expect(still.artworkHistory).toContain("b/prev.jpg");
    expect(still.videoPath).toBeUndefined();

    const clip = makeShot({ artwork: "b/prev.jpg" });
    setShotSelectedOutput(clip, { kind: "ref", refId: "r2", media: "clip", path: "v/dropped.mp4" });
    expect(clip.videoPath).toBe("v/dropped.mp4");
    expect(clip.artwork).toBeUndefined();
  });
});

describe("selection interop (canvas and storyboard share one write-through)", () => {
  it("selecting an older image take changes what the storyboard shows", () => {
    const shot = makeShot({
      graphImageGens: [take("b/new.jpg"), take("b/older.jpg")],
      graphImageGenIndex: 0,
      graphOutputSource: "imagegen",
      graphMigrated: true,
    });
    expect(resolveShotDisplay(shot).path).toBe("b/new.jpg");
    shot.graphImageGenIndex = 1;
    setShotSelectedOutput(shot, { kind: "imagegen" });
    expect(resolveShotDisplay(shot)).toMatchObject({ media: "still", path: "b/older.jpg" });
  });

  it("a selection on an UNBOUND node moves the index without touching the output", () => {
    const shot = makeShot({
      graphImageGens: [take("b/f.jpg")],
      graphImageGenIndex: 0,
      graphOutputSource: "videogen",
      graphVideoNodes: [{ id: "vid0", prompt: "", gens: [take("v/clip.mp4")], genIndex: 0 }],
    });
    shot.graphVideoNodes![0].genIndex = 0;
    // (the command sets the index and skips the write-through when unbound)
    expect(resolveShotDisplay(shot)).toMatchObject({ media: "clip", path: "v/clip.mp4" });
    expect(shot.graphOutputSource).toBe("videogen");
  });

  it("storyboard promote binds the owning node (the display follows the pipe)", () => {
    const shot = makeShot({
      graphImageGens: [take("b/new.jpg"), take("b/older.jpg")],
      graphImageGenIndex: 0,
      artworkHistory: [],
      graphMigrated: true,
    });
    selectBoardFrame(shot, "b/older.jpg");
    expect(shot.graphOutputSource).toBe("imagegen");
    expect(shot.graphImageGenIndex).toBe(1);
    expect(resolveShotDisplay(shot)).toMatchObject({ media: "still", path: "b/older.jpg" });
  });

  it("classic edit and video auto-apply route through the write-through", () => {
    const edit = makeShot({ graphImageGens: [take("b/src.jpg")], graphImageGenIndex: 0, graphEditNodes: [{ id: "edit0", prompt: "" }] });
    hookImageGenToOutput(edit);
    expect(edit.graphOutputSource).toBe("imagegen");
    expect(resolveShotDisplay(edit)).toMatchObject({ media: "still", path: "b/src.jpg" });
    recordGraphEditGen(edit, "edit0", "b/edit.jpg", "fix", "auto");
    setShotSelectedOutput(edit, { kind: "editgen", nodeId: "edit0" });
    expect(edit.graphOutputSource).toBe("editgen");
    expect(resolveShotDisplay(edit)).toMatchObject({ media: "still", path: "b/edit.jpg" });

    const vid = makeShot({ artwork: "b/still.jpg" });
    recordGraphVideoGen(vid, "vid0", "v/clip.mp4", "drift", "auto");
    hookVideoGenToOutput(vid, "vid0");
    expect(vid.graphOutputSource).toBe("videogen");
    // The display resolves the recorded take + its pipe (the retired mirror
    // pin); the pre-existing still is untouched (ref/legacy store only).
    expect(resolveShotDisplay(vid)).toMatchObject({ media: "clip", path: "v/clip.mp4" });
    expect(vid.artwork).toBe("b/still.jpg"); // legacy store value frozen

    const hooked = makeShot({ graphVideoNodes: [{ id: "vid0", prompt: "", gens: [take("v/clip.mp4")], genIndex: 0 }] });
    hookVideoGenToOutput(hooked, "vid0");
    expect(hooked.graphOutputSource).toBe("videogen");
    expect(resolveShotDisplay(hooked)).toMatchObject({ media: "clip", path: "v/clip.mp4" });
  });
});

describe("end-to-end regression: generate → select → stale save → reload → export", () => {
  it("a selection made while a stale save is in flight survives the merge and drives the export", () => {
    // Fresh: a generation landed mid-session (new take at index 0) and is
    // piped in through the write-through.
    const shot = makeShot({
      graphImageGens: [take("b/new.jpg"), take("b/old.jpg")],
      graphImageGenIndex: 0,
      graphMigrated: true,
    });
    setShotSelectedOutput(shot, { kind: "imagegen" });
    expect(resolveShotDisplay(shot)).toMatchObject({ media: "still", path: "b/new.jpg" });

    // The user then selects the older take in the canvas — the command moves
    // the index; the display follows the pipe.
    shot.graphImageGenIndex = 1;
    setShotSelectedOutput(shot, { kind: "imagegen" });
    expect(resolveShotDisplay(shot)).toMatchObject({ media: "still", path: "b/old.jpg" });

    // A whole-document renderer save captured BEFORE the generation lands
    // now: its history predates the new take.
    const stale = makeShot({
      graphImageGens: [take("b/old.jpg")],
      graphImageGenIndex: 0,
      artwork: "b/old.jpg",
      graphMigrated: true,
    });

    const fresh = makeProduction([structuredClone(shot)]);
    const incoming = makeProduction([stale]);
    const merged = applyRendererState(fresh, incoming);
    const mergedShot = merged.scenes[0].shots[0];
    // The diverged history keeps the fresh selection, and the display
    // resolves it — the storyboard and the canvas agree.
    expect(mergedShot.graphImageGenIndex).toBe(1);
    expect(resolveShotDisplay(mergedShot)).toMatchObject({ media: "still", path: "b/old.jpg" });

    // Export resolves exactly the shown output.
    const plan = assemblyPlan(merged);
    const event = plan.events.find((e) => e.kind === "still");
    expect(event?.srcRel).toBe("b/old.jpg");
  });
});
