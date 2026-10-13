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

import { resolveSelectedOutput } from "../src/shared/selected-output.js";
import {
  applyVideoOutput,
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
  it("binds imagegen, derives artwork, clears a stale clip, and marks the shot migrated", () => {
    const shot = makeShot({ graphImageGens: [take("b/f.jpg")], graphImageGenIndex: 0, videoPath: "v/stale.mp4" });
    setShotSelectedOutput(shot, { kind: "imagegen" });
    expect(shot.graphOutputSource).toBe("imagegen");
    expect(shot.graphOutputRefId).toBeUndefined();
    expect(shot.graphMigrated).toBe(true);
    expect(shot.artwork).toBe("b/f.jpg");
    expect(shot.videoPath).toBeUndefined();
  });

  it("binds videogen, derives the clip, and backfills the still from the source pipe", () => {
    const shot = makeShot({
      graphImageGens: [take("b/src.jpg")],
      graphImageGenIndex: 0,
      graphVideoNodes: [{ id: "vid0", prompt: "", gens: [take("v/clip.mp4")], genIndex: 0, source: { kind: "imagegen" } }],
    });
    setShotSelectedOutput(shot, { kind: "videogen", nodeId: "vid0" });
    expect(shot.graphOutputSource).toBe("videogen");
    expect(shot.graphOutputVideoNodeId).toBe("vid0");
    expect(shot.videoPath).toBe("v/clip.mp4");
    expect(shot.artwork).toBe("b/src.jpg");
  });

  it("unpipe clears exactly the mirror of the unpiped kind", () => {
    const clip = makeShot({ graphOutputSource: "videogen", videoPath: "v/clip.mp4", artwork: "b/still.jpg" });
    setShotSelectedOutput(clip, { kind: "unpipe" });
    expect(clip.graphOutputSource).toBeUndefined();
    expect(clip.videoPath).toBeUndefined();
    expect(clip.artwork).toBe("b/still.jpg"); // a still survives a clip unpipe

    const still = makeShot({ graphOutputSource: "imagegen", artwork: "b/f.jpg", videoPath: "v/old.mp4" });
    setShotSelectedOutput(still, { kind: "unpipe" });
    expect(still.artwork).toBeUndefined();
  });

  it("ref still and clip selections set the mirrors directly (the production owns the file)", () => {
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
  it("selecting an older image take re-derives the storyboard mirror", () => {
    const shot = makeShot({
      graphImageGens: [take("b/new.jpg"), take("b/older.jpg")],
      graphImageGenIndex: 0,
      graphOutputSource: "imagegen",
      artwork: "b/new.jpg",
      graphMigrated: true,
    });
    shot.graphImageGenIndex = 1;
    setShotSelectedOutput(shot, { kind: "imagegen" });
    expect(shot.artwork).toBe("b/older.jpg");
    expect(shot.artworkHistory).toContain("b/new.jpg");
  });

  it("a selection on an UNBOUND node moves the index without touching the output", () => {
    const shot = makeShot({
      graphImageGens: [take("b/f.jpg")],
      graphImageGenIndex: 0,
      graphOutputSource: "videogen",
      graphVideoNodes: [{ id: "vid0", prompt: "", gens: [take("v/clip.mp4")], genIndex: 0 }],
      videoPath: "v/clip.mp4",
    });
    shot.graphVideoNodes![0].genIndex = 0;
    // (the command sets the index and skips the write-through when unbound)
    expect(shot.videoPath).toBe("v/clip.mp4");
    expect(shot.graphOutputSource).toBe("videogen");
  });

  it("storyboard promote settles at a fixed point (sync is a no-op afterwards)", () => {
    const shot = makeShot({
      graphImageGens: [take("b/new.jpg"), take("b/older.jpg")],
      graphImageGenIndex: 0,
      artwork: "b/new.jpg",
      artworkHistory: [],
      graphMigrated: true,
    });
    selectBoardFrame(shot, "b/older.jpg");
    expect(shot.graphOutputSource).toBe("imagegen");
    expect(shot.graphImageGenIndex).toBe(1);
    expect(shot.artwork).toBe("b/older.jpg");
    expect(syncBoardOutputToPipe(shot)).toBe(false);
  });

  it("classic edit and video auto-apply route through the write-through", () => {
    const edit = makeShot({ graphImageGens: [take("b/src.jpg")], graphImageGenIndex: 0, graphEditNodes: [{ id: "edit0", prompt: "" }] });
    hookImageGenToOutput(edit);
    expect(edit.graphOutputSource).toBe("imagegen");
    expect(edit.artwork).toBe("b/src.jpg");
    recordGraphEditGen(edit, "edit0", "b/edit.jpg", "fix", "auto");
    setShotSelectedOutput(edit, { kind: "editgen", nodeId: "edit0" });
    expect(edit.graphOutputSource).toBe("editgen");
    expect(edit.artwork).toBe("b/edit.jpg");

    const vid = makeShot({ artwork: "b/still.jpg" });
    recordGraphVideoGen(vid, "vid0", "v/clip.mp4", "drift", "auto");
    hookVideoGenToOutput(vid, "vid0");
    applyVideoOutput(vid, "v/clip.mp4");
    expect(vid.graphOutputSource).toBe("videogen");
    expect(vid.videoPath).toBe("v/clip.mp4");
    expect(vid.artwork).toBe("b/still.jpg"); // unchanged still survives

    const hooked = makeShot({ graphVideoNodes: [{ id: "vid0", prompt: "", gens: [take("v/clip.mp4")], genIndex: 0 }] });
    hookVideoGenToOutput(hooked, "vid0");
    expect(hooked.graphOutputSource).toBe("videogen");
    expect(hooked.videoPath).toBe("v/clip.mp4");
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
    expect(shot.artwork).toBe("b/new.jpg");

    // The user then selects the older take in the canvas — the command moves
    // the index and re-derives the storyboard mirror.
    shot.graphImageGenIndex = 1;
    setShotSelectedOutput(shot, { kind: "imagegen" });
    expect(shot.artwork).toBe("b/old.jpg");
    expect(syncBoardOutputToPipe(shot)).toBe(false);

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
    // The diverged history keeps the fresh selection, and the pipe re-derives
    // the mirrors so the storyboard and the canvas agree.
    expect(mergedShot.graphImageGenIndex).toBe(1);
    expect(mergedShot.artwork).toBe("b/old.jpg");
    expect(syncBoardOutputToPipe(mergedShot)).toBe(false);

    // Export resolves exactly the shown output.
    const plan = assemblyPlan(merged);
    const event = plan.events.find((e) => e.kind === "still");
    expect(event?.srcRel).toBe("b/old.jpg");
  });
});
