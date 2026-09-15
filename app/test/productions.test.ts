/**
 * productions tests — the production document's shape rules: the read-side
 * normalize back-fill and the write-side applyRendererState whitelist merge
 * (which used to live inline in index.ts's production:save handler). Pins that
 * the merge copies only renderer-editable fields and never clobbers concurrent
 * state that the renderer doesn't send.
 */
import { afterAll, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/opencode/cascade-productions-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));

// productions.ts imports pipeline.ts (soft electron + scripting); the tests
// never call the text-extraction helpers, and scripting's dynamic pdf-parse
// import doesn't resolve under Vitest — replace it with a factory.
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { applyRendererState, importProduction, loadProduction, saveProduction, unclaimedReferenceFiles, referenceImagePaths } from "../src/main/productions.js";
import type { ProductionFile } from "../src/main/productions.js";
import { recordBoardEdit, recordGraphEditGen, selectBoardFrame, syncBoardOutputToPipe } from "../src/main/pipeline.js";
import { boardFrameHistory } from "../src/shared/board-frames.js";

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function baseProduction(overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "p1", name: "Prod", folder: "C:/workspace/prod", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 1,
    visualStyle: "",
    styles: [],
    scenes: [],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    ...overrides,
  };
}

describe("applyRendererState", () => {
  it("copies the renderer-editable fields onto the fresh document", () => {
    const fresh = baseProduction();
    const incoming = baseProduction({
      currentStep: 3,
      styles: [{ id: "s1", index: 1, name: "Heroic", prompt: "Heroic 3D" }],
      openArt: { model: "kling", resolution: "2k" },
      status: { 3: "done" },
      scriptSource: "C:/script.md",
    });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.currentStep).toBe(3);
    expect(merged.styles).toEqual(incoming.styles);
    expect(merged.openArt).toEqual({ model: "kling", resolution: "2k" });
    expect(merged.status).toEqual({ 3: "done" });
    expect(merged.scriptSource).toBe("C:/script.md");
  });

  it("never clobbers scene structure the renderer doesn't own", () => {
    // The fresh doc carries the post-reorder scene order; the incoming
    // renderer copy predates it (or simply echoes an empty list) — the fresh
    // scenes must survive wholesale.
    const fresh = baseProduction({
      scenes: [
        {
          number: 1,
          title: "S1",
          shots: [
            {
              id: "shot1",
              number: "0100",
              audio: "",
              visual: "Hero walks",
              artwork: "boards/0100/shot-0100-new.jpg",
              graphVideoGens: [{ path: "videos/shot-0100-new.mp4", prompt: "p", model: "m", at: "" }],
            },
          ],
        },
      ],
    });
    const incoming = baseProduction({ scenes: [] });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.scenes).toEqual(fresh.scenes); // fresh owns membership, order, numbers, paths
    expect(merged.meta.name).toBe("Prod");
  });

  it("keeps fresh media paths while applying the renderer's text edits", () => {
    const fresh = baseProduction({
      scenes: [
        {
          number: 1,
          title: "S1",
          shots: [
            {
              id: "shot1",
              number: "0100",
              audio: "",
              visual: "Hero walks",
              artwork: "boards/0100/shot-0100-new.jpg",
              graphVideoGens: [{ path: "videos/shot-0100-new.mp4", prompt: "p", model: "m", at: "" }],
            },
          ],
        },
      ],
    });
    // Renderer sends the same shot from a stale snapshot (old artwork, no
    // video gens) plus a fresh audio edit typed after the snapshot.
    const incoming = baseProduction({
      scenes: [
        {
          number: 1,
          title: "S1",
          shots: [{ id: "shot1", number: "0100", audio: "New line", visual: "Hero walks", artwork: "boards/0100/shot-0100-old.jpg" }],
        },
      ],
    });
    const merged = applyRendererState(fresh, incoming);
    // The audio edit applies; the stale media paths do not clobber the fresh ones.
    expect(merged.scenes[0].shots[0].audio).toBe("New line");
    expect(merged.scenes[0].shots[0].artwork).toBe("boards/0100/shot-0100-new.jpg");
    expect(merged.scenes[0].shots[0].graphVideoGens).toEqual(fresh.scenes[0].shots[0].graphVideoGens);
  });

  it("keeps fresh order, numbers, and media paths when the renderer save predates a shot reorder", () => {
    // Pre-reorder: scene 1 holds A(0100), scene 2 holds B(0200). The user
    // drags B before A: B joins scene 1 as 0100, A becomes 0200, and both
    // shots' folders + stored paths follow their shots. An in-flight renderer
    // save captured before the drag then lands — it must apply its text edit
    // without reverting the order or cross-wiring the frames.
    const shotA = {
      id: "shotA",
      number: "0200",
      audio: "",
      visual: "A visual",
      artwork: "boards/0200/shot-0200-a-edit.jpg",
      artworkHistory: ["boards/0200/shot-0200-a-pure.jpg"],
      graphImageGens: [{ path: "boards/0200/shot-0200-a-pure.jpg", prompt: "pure", model: "m", at: "" }],
      graphImageGenIndex: 0,
      graphEditNodes: [{
        id: "edit0",
        prompt: "night",
        gens: [{ path: "boards/0200/shot-0200-a-edit.jpg", prompt: "night", model: "m", at: "" }],
        genIndex: 0,
      }],
      graphOutputSource: "editgen" as const,
      graphOutputEditNodeId: "edit0",
    };
    const shotB = {
      id: "shotB",
      number: "0100",
      audio: "",
      visual: "B visual",
      artwork: "boards/0100/shot-0100-b.jpg",
      graphImageGens: [{ path: "boards/0100/shot-0100-b.jpg", prompt: "b", model: "m", at: "" }],
      graphImageGenIndex: 0,
      graphOutputSource: "imagegen" as const,
    };
    const fresh = baseProduction({
      scenes: [
        { number: 1, title: "S1", shots: [structuredClone(shotB), structuredClone(shotA)] },
        { number: 2, title: "S2", shots: [] },
      ],
    });
    const incoming = baseProduction({
      scenes: [
        {
          number: 1,
          title: "S1",
          shots: [{
            ...structuredClone(shotA),
            number: "0100", // stale number
            audio: "A new line", // typed after the snapshot
            artwork: "boards/0100/shot-0100-a-pure.jpg", // stale path
            artworkHistory: ["boards/0100/shot-0100-a-pure.jpg"],
            graphImageGens: [{ path: "boards/0100/shot-0100-a-pure.jpg", prompt: "pure", model: "m", at: "" }],
            graphEditNodes: [{
              id: "edit0",
              prompt: "night",
              gens: [{ path: "boards/0100/shot-0100-a-edit.jpg", prompt: "night", model: "m", at: "" }],
              genIndex: 0,
            }],
          }],
        },
        {
          number: 2,
          title: "S2",
          shots: [{
            ...structuredClone(shotB),
            number: "0200", // stale number
            artwork: "boards/0200/shot-0200-b.jpg", // stale path
            graphImageGens: [{ path: "boards/0200/shot-0200-b.jpg", prompt: "b", model: "m", at: "" }],
          }],
        },
      ],
    });
    const merged = applyRendererState(fresh, incoming);
    // Order, scene membership, and numbers stay exactly as the reorder left them.
    expect(merged.scenes.map((s) => s.shots.map((x) => x.id))).toEqual([["shotB", "shotA"], []]);
    expect(merged.scenes[0].shots.map((x) => x.number)).toEqual(["0100", "0200"]);
    const mergedA = merged.scenes[0].shots[1];
    const mergedB = merged.scenes[0].shots[0];
    // Frames follow their shots — the edit stays on A, the pure gen stays on B.
    expect(mergedA.artwork).toBe("boards/0200/shot-0200-a-edit.jpg");
    expect(mergedA.artworkHistory).toEqual(["boards/0200/shot-0200-a-pure.jpg"]);
    expect(mergedA.graphImageGens![0].path).toBe("boards/0200/shot-0200-a-pure.jpg");
    expect(mergedA.graphEditNodes![0].gens![0].path).toBe("boards/0200/shot-0200-a-edit.jpg");
    expect(mergedB.artwork).toBe("boards/0100/shot-0100-b.jpg");
    expect(mergedB.graphImageGens![0].path).toBe("boards/0100/shot-0100-b.jpg");
    // ...while the text edit typed after the snapshot still applies.
    expect(mergedA.audio).toBe("A new line");
  });

  it("drops shots the fresh document no longer has but keeps edits to survivors", () => {
    // The renderer snapshot predates a shot deletion: it still carries the
    // deleted shot plus an audio edit to a surviving shot. The deletion wins;
    // the surviving edit applies.
    const fresh = baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [{ id: "keep", number: "0100", audio: "", visual: "Keep" }] }],
    });
    const incoming = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [
          { id: "keep", number: "0100", audio: "Keep talking", visual: "Keep" },
          { id: "ghost", number: "0200", audio: "", visual: "Deleted after the snapshot" },
        ],
      }],
    });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.scenes[0].shots.map((s) => s.id)).toEqual(["keep"]);
    expect(merged.scenes[0].shots[0].audio).toBe("Keep talking");
  });

  it("honours an explicit output unpipe from the renderer", () => {
    // unpipeOutput sends source/artwork/videoPath as explicit nulls through
    // the whole-document save — the storyboard frame must go blank.
    const fresh = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [{
          id: "shot1",
          number: "0100",
          audio: "",
          visual: "Hero",
          artwork: "boards/0100/shot-0100-x.jpg",
          graphImageGens: [{ path: "boards/0100/shot-0100-x.jpg", prompt: "p", model: "m", at: "" }],
          graphImageGenIndex: 0,
          graphOutputSource: "imagegen" as const,
        }],
      }],
    });
    const incoming = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [{
          id: "shot1",
          number: "0100",
          audio: "",
          visual: "Hero",
          artwork: undefined,
          videoPath: undefined,
          graphImageGens: [{ path: "boards/0100/shot-0100-x.jpg", prompt: "p", model: "m", at: "" }],
          graphImageGenIndex: 0,
          graphOutputSource: undefined,
        }],
      }],
    });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.scenes[0].shots[0].graphOutputSource).toBeUndefined();
    expect(merged.scenes[0].shots[0].artwork).toBeUndefined();
    expect(merged.scenes[0].shots[0].videoPath).toBeUndefined();
    // The generation history itself survives the unpipe.
    expect(merged.scenes[0].shots[0].graphImageGens).toHaveLength(1);
  });

  it("keeps an edit-video clip path the renderer selects", () => {
    // pipeEditVideoToOutput is a whole-document save with no follow-up
    // channel, and no pipe sync derives the edit-video path — so the string
    // must ride through the merge.
    const fresh = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [{
          id: "shot1",
          number: "0100",
          audio: "",
          visual: "Hero",
          videoPath: "boards/0100/video/shot-0100-old.mp4",
          graphEditVideoGens: [
            { path: "boards/0100/video/shot-0100-new.mp4", prompt: "e", model: "m", at: "" },
            { path: "boards/0100/video/shot-0100-old.mp4", prompt: "e", model: "m", at: "" },
          ],
          graphEditVideoGenIndex: 1,
          graphOutputSource: "editvideo" as const,
        }],
      }],
    });
    const incoming = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [{
          id: "shot1",
          number: "0100",
          audio: "",
          visual: "Hero",
          videoPath: "boards/0100/video/shot-0100-new.mp4",
          graphEditVideoGens: [
            { path: "boards/0100/video/shot-0100-new.mp4", prompt: "e", model: "m", at: "" },
            { path: "boards/0100/video/shot-0100-old.mp4", prompt: "e", model: "m", at: "" },
          ],
          graphEditVideoGenIndex: 0,
          graphOutputSource: "editvideo" as const,
        }],
      }],
    });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.scenes[0].shots[0].videoPath).toBe("boards/0100/video/shot-0100-new.mp4");
    expect(merged.scenes[0].shots[0].graphEditVideoGenIndex).toBe(0);
  });

  it("adopts edit nodes created after the snapshot and keeps fresh histories", () => {
    const fresh = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [{
          id: "shot1",
          number: "0100",
          audio: "",
          visual: "Hero",
          graphEditNodes: [{
            id: "edit0",
            prompt: "old prompt",
            gens: [{ path: "boards/0100/shot-0100-e0.jpg", prompt: "old prompt", model: "m", at: "" }],
            genIndex: 0,
          }],
        }],
      }],
    });
    const incoming = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [{
          id: "shot1",
          number: "0100",
          audio: "",
          visual: "Hero",
          graphEditNodes: [
            {
              id: "edit0",
              prompt: "new prompt",
              gens: [{ path: "boards/0100/shot-0100-e0.jpg", prompt: "old prompt", model: "m", at: "" }],
              genIndex: 0,
            },
            { id: "edit1", prompt: "second pass" },
          ],
        }],
      }],
    });
    const merged = applyRendererState(fresh, incoming);
    const nodes = merged.scenes[0].shots[0].graphEditNodes!;
    expect(nodes.map((n) => n.id)).toEqual(["edit0", "edit1"]);
    expect(nodes[0].prompt).toBe("new prompt");
    expect(nodes[0].gens).toEqual(fresh.scenes[0].shots[0].graphEditNodes![0].gens);
    expect(nodes[1].prompt).toBe("second pass");
  });

  it("overlays tween block prompts by keyframe pair and keeps fresh histories", () => {
    const block = {
      id: "tw0",
      startRefId: "imagegen",
      endRefId: "editgen",
      prompt: "old prompt",
      startSec: 0,
      durationSec: 2,
      gens: [{ path: "boards/0100/video/shot-0100-b0.mp4", prompt: "old prompt", model: "m", at: "" }],
      genIndex: 0,
    };
    const fresh = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [{
          id: "shot1", number: "0100", audio: "", visual: "Hero",
          graphTweenRefIds: ["imagegen", "editgen"],
          graphTweenBlocks: [structuredClone(block)],
        }],
      }],
    });
    const incoming = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [{
          id: "shot1", number: "0100", audio: "", visual: "Hero",
          graphTweenRefIds: ["imagegen", "editgen"],
          graphTweenBlocks: [{ ...structuredClone(block), prompt: "new prompt", durationSec: 3 }],
        }],
      }],
    });
    const merged = applyRendererState(fresh, incoming);
    const mergedBlock = merged.scenes[0].shots[0].graphTweenBlocks![0];
    expect(mergedBlock.prompt).toBe("new prompt");
    expect(mergedBlock.durationSec).toBe(3);
    expect(mergedBlock.gens).toEqual(block.gens);
  });

  it("keeps the fresh generation index when histories diverged after the snapshot", () => {
    const shots = (gens: { path: string; prompt: string; model: string; at: string }[], index: number) => [{
      id: "shot1", number: "0100", audio: "", visual: "Hero",
      artwork: gens[index]?.path,
      graphImageGens: gens,
      graphImageGenIndex: index,
      graphOutputSource: "imagegen" as const,
    }];
    // A generation landed after the snapshot: the stale index 1 would select
    // the wrong take on the fresh array, so the fresh index stands.
    const diverged = applyRendererState(
      baseProduction({ scenes: [{ number: 1, title: "S1", shots: shots([{ path: "n", prompt: "", model: "", at: "" }, { path: "o", prompt: "", model: "", at: "" }], 0) }] }),
      baseProduction({ scenes: [{ number: 1, title: "S1", shots: shots([{ path: "o", prompt: "", model: "", at: "" }], 1) }] })
    );
    expect(diverged.scenes[0].shots[0].graphImageGenIndex).toBe(0);
    expect(diverged.scenes[0].shots[0].artwork).toBe("n");
    // Histories agree: the incoming selection applies and the frame follows it.
    const agreed = applyRendererState(
      baseProduction({ scenes: [{ number: 1, title: "S1", shots: shots([{ path: "a", prompt: "", model: "", at: "" }, { path: "b", prompt: "", model: "", at: "" }], 0) }] }),
      baseProduction({ scenes: [{ number: 1, title: "S1", shots: shots([{ path: "a", prompt: "", model: "", at: "" }, { path: "b", prompt: "", model: "", at: "" }], 1) }] })
    );
    expect(agreed.scenes[0].shots[0].graphImageGenIndex).toBe(1);
    expect(agreed.scenes[0].shots[0].artwork).toBe("b");
  });

  it("strips legacy per-shot fields (single-VO model, cuts-only timeline)", () => {
    const legacyShot = { id: "shot1", number: "0100", audio: "", visual: "Hero" } as unknown as Record<string, unknown>;
    legacyShot.voiceoverPath = "voiceover/legacy.mp3";
    legacyShot.transition = "cut";
    const scenes = (shot: unknown) => [{
      number: 1,
      title: "S1",
      shots: [shot as unknown as Production["scenes"][number]["shots"][number]],
    }];
    const fresh = baseProduction({ scenes: scenes(structuredClone(legacyShot)) });
    const incoming = baseProduction({ scenes: scenes(structuredClone(legacyShot)) });
    const merged = applyRendererState(fresh, incoming);
    const shot = merged.scenes[0].shots[0] as unknown as Record<string, unknown>;
    expect(shot.voiceoverPath).toBeUndefined();
    expect(shot.transition).toBeUndefined();
    expect(shot.visual).toBe("Hero");
  });

  it("slices brand colors to 5 and stringifies", () => {
    const incoming = baseProduction({ brand: { colors: ["#aabbcc", "#ddeeff", "#112233", "#445566", "#778899", "#000000"], font: "Baskerville" } });
    const merged = applyRendererState(baseProduction(), incoming);
    expect(merged.brand?.colors).toHaveLength(5);
    expect(merged.brand?.colors).toEqual(["#aabbcc", "#ddeeff", "#112233", "#445566", "#778899"]);
    expect(merged.brand?.font).toBe("Baskerville");
  });

  it("keeps the fresh promptOverrides map (renderer never edits it through a save)", () => {
    // promptOverrides is keyed by displayed shot number and written main-side
    // (ingest stashes manual prompts, reorder remaps them). A stale renderer
    // snapshot must not reattach overrides to the wrong shots.
    const fresh = baseProduction({ promptOverrides: { "0200": "kept prompt" } });
    const incoming = baseProduction({ promptOverrides: { "0100": "stale prompt", "0200": "   " } });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.promptOverrides).toEqual({ "0200": "kept prompt" });
  });

  it("merges magicPrompts per key so stale snapshots can't wipe fresh entries", () => {
    // The prompt drawer writes magicPrompts[shotId] through saves, so
    // incoming non-blank entries win — but fresh-only keys (e.g. from a bulk
    // generation that landed after the snapshot) survive.
    const fresh = baseProduction({ magicPrompts: { shot1: "fresh generated", shot2: "untouched" } });
    const incoming = baseProduction({ magicPrompts: { shot1: "typed edit", shot3: "   " } });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.magicPrompts).toEqual({ shot1: "typed edit", shot2: "untouched" });
  });

  it("clamps volume fields to [0, 1]", () => {
    const incoming = baseProduction({ voiceoverVolume: 2, musicVolume: -1 } as Production);
    const merged = applyRendererState(baseProduction(), incoming);
    expect(merged.voiceoverVolume).toBe(1);
    expect(merged.musicVolume).toBe(0);
  });

  it("renames the production when the renderer sends a new name", () => {
    const incoming = baseProduction({ meta: { ...baseProduction().meta, name: "Renamed" } });
    const merged = applyRendererState(baseProduction(), incoming);
    expect(merged.meta.name).toBe("Renamed");
  });

  it("re-derives the storyboard frame from the output pipe when the renderer's save is stale", () => {
    // The renderer sends the shot with the edit-image node piped to the output
    // but a stale/empty `artwork` (the apply raced its save). The pipe owns the
    // frame, so the merged document must mirror the node graph's output node.
    const shot = {
      id: "shot1",
      number: "0100",
      audio: "",
      visual: "Hero walks",
      graphOutputSource: "editgen" as const,
      graphOutputEditNodeId: "edit0",
      graphEditNodes: [{ id: "edit0", prompt: "make it night", gens: [{ path: "boards/0100/shot-0100-edit.jpg", prompt: "make it night", model: "auto", at: "" }], genIndex: 0 }],
      artwork: undefined,
      videoPath: "videos/stale.mp4",
    };
    const fresh = baseProduction({ scenes: [{ number: 1, title: "S1", shots: [structuredClone(shot)] }] });
    const incoming = baseProduction({ scenes: [{ number: 1, title: "S1", shots: [structuredClone(shot)] }] });
    const merged = applyRendererState(fresh, incoming);
    const restored = merged.scenes[0].shots[0];
    expect(restored.artwork).toBe("boards/0100/shot-0100-edit.jpg");
    expect(restored.videoPath).toBeUndefined();
  });
});

describe("board frame selection persistence", () => {
  it.each(["image", "edit", "legacy", "current"] as const)("preserves a %s selection through renderer state and repeated disk save/load", (kind) => {
    const images = [0, 1, 2].map((i) => ({
      path: `boards/0100/image-${i}.jpg`, prompt: `image ${i}`, model: "image-model", at: `2026-09-0${3 - i}T00:00:00.000Z`,
    }));
    const edits = [0, 1, 2].map((i) => ({
      path: `boards/0100/edit-${i}.jpg`, prompt: `edit ${i}`, model: "edit-model", at: `2026-09-0${6 - i}T00:00:00.000Z`,
    }));
    const shot: ProductionShot = {
      id: "shot1", number: "0100", audio: "", visual: "Hero walks",
      artwork: "boards/0100/current.jpg", artworkHistory: ["boards/0100/legacy.jpg", "boards/0100/older.jpg"],
      graphImageGens: images, graphImageGenIndex: 0,
      graphEditNodes: [{ id: "edit0", prompt: "", gens: edits, genIndex: 1 }],
      graphOutputSource: "videogen", videoPath: "videos/clip.mp4", graphImageToVideo: true,
      graphVideoGens: [{ path: "videos/clip.mp4", prompt: "motion", model: "video-model", at: "" }],
      graphVideoGenIndex: 0,
      // Deliberately omit graphMigrated: an explicit selection must also survive legacy migration.
    };
    const incoming = baseProduction({
      meta: { ...baseProduction().meta, id: `selection-${kind}`, folder: path.join(dataDir, "assets") },
      scenes: [{ number: 1, title: "S1", shots: [shot] }],
    });
    const rel = kind === "image" ? images[2].path : kind === "edit" ? edits[2].path
      : kind === "legacy" ? "boards/0100/legacy.jpg" : shot.artwork!;
    selectBoardFrame(shot, rel);
    const selected = structuredClone(shot);
    const history = boardFrameHistory(shot);
    // The fresh document already holds the selection (the select channel
    // saved it); the incoming renderer save arrives with stale mirrors.
    const fresh = baseProduction({
      meta: { ...incoming.meta },
      scenes: [{ number: 1, title: "S1", shots: [structuredClone(shot)] }],
    });
    // A stale artwork mirror cannot replace the newly selected node output.
    shot.artwork = "boards/0100/current.jpg";
    shot.videoPath = "videos/clip.mp4";
    const merged = applyRendererState(fresh, incoming);
    expect(merged.scenes[0].shots[0].artwork).toBe(rel);
    expect(merged.scenes[0].shots[0].videoPath).toBeUndefined();
    saveProduction(merged);

    for (let i = 0; i < 2; i++) {
      const loaded = loadProduction(incoming.meta.id);
      expect(loaded).not.toBeNull();
      const restored = loaded!.scenes[0].shots[0];
      expect(restored.artwork).toBe(rel);
      expect(restored.videoPath).toBeUndefined();
      expect(restored.graphOutputSource).toBe(kind === "edit" ? "editgen" : "imagegen");
      expect(restored.graphImageGenIndex).toBe(selected.graphImageGenIndex);
      expect(restored.graphEditNodes).toEqual(selected.graphEditNodes);
      expect(restored.graphImageGens).toEqual(selected.graphImageGens);
      expect(restored.graphVideoGens).toEqual(selected.graphVideoGens);
      expect(restored.graphImageToVideo).toBe(true);
      expect(boardFrameHistory(restored)).toEqual(history);
      expect(syncBoardOutputToPipe(restored)).toBe(false);
      saveProduction(loaded!);
    }
  });

  it("persists a classic edit and re-edit with the correct source fallback and complete node history", () => {
    const shot: ProductionShot = {
      id: "shot1", number: "0100", audio: "", visual: "Hero walks",
      artwork: "boards/0100/image-1.jpg", graphImageGenIndex: 0, graphImageToVideo: true,
      graphImageGens: [0, 1].map((i) => ({ path: `boards/0100/image-${i}.jpg`, prompt: `image ${i}`, model: "image-model", at: "" })),
    };
    const incoming = baseProduction({
      meta: { ...baseProduction().meta, id: "classic-edit", folder: path.join(dataDir, "assets") },
      scenes: [{ number: 1, title: "S1", shots: [shot] }],
    });
    const images = structuredClone(shot.graphImageGens);
    for (const [rel, prompt, expectedSource] of [
      ["boards/0100/edit-1.jpg", "make it night", { kind: "imagegen" }],
      ["boards/0100/edit-2.jpg", "add rain", { kind: "editgen", nodeId: "edit0" }],
    ] as const) {
      recordBoardEdit(incoming.scenes[0].shots[0], rel, prompt, "edit-model");
      const selected = structuredClone(incoming.scenes[0].shots[0]);
      // The fresh document already holds the edit (the edit channel saved
      // it); the incoming renderer save arrives with a stale frame mirror.
      const fresh = baseProduction({
        meta: { ...incoming.meta },
        scenes: structuredClone(incoming.scenes),
      });
      incoming.scenes[0].shots[0].artwork = "boards/0100/stale.jpg";
      const merged = applyRendererState(fresh, incoming);
      saveProduction(merged);
      const loaded = loadProduction(incoming.meta.id)!;
      const restored = loaded.scenes[0].shots[0];
      expect(restored.artwork).toBe(rel);
      expect(restored.graphOutputSource).toBe("editgen");
      const active = (restored.graphEditNodes ?? []).find((n) => n.id === restored.graphOutputEditNodeId)!;
      expect(active.genIndex).toBe(0);
      expect(active.source).toEqual(expectedSource);
      expect(restored.graphImageGenIndex).toBe(1);
      expect(restored.graphEditPrompt).toBe(prompt);
      expect(restored.graphEditNodes).toEqual(selected.graphEditNodes);
      expect(restored.graphImageGens).toEqual(images);
      expect(restored.artworkHistory).toEqual(selected.artworkHistory);
      expect(restored.graphImageToVideo).toBe(true);
      incoming.scenes = loaded.scenes;
    }
    expect(incoming.scenes[0].shots[0].graphEditNodes).toHaveLength(2);
    expect(boardFrameHistory(incoming.scenes[0].shots[0])).toEqual([
      "boards/0100/edit-1.jpg", "boards/0100/image-0.jpg", "boards/0100/image-1.jpg",
    ]);
  });
});

describe("loadProduction isolation", () => {
  function jobDoc(id: string): Production {
    return baseProduction({
      meta: { ...baseProduction().meta, id, folder: path.join(dataDir, "assets") },
      scenes: [
        {
          number: 1,
          title: "S1",
          shots: [
            {
              id: "shot1",
              number: "0100",
              audio: "",
              visual: "Hero walks",
              graphEditNodes: [{ id: "edit0", prompt: "old prompt", gens: [{ path: "boards/0100/a.jpg", prompt: "old prompt", model: "m", at: "" }], genIndex: 0 }],
            },
          ],
        },
      ],
    });
  }

  it("hands out a private copy per load so holders can't alias the store cache", () => {
    saveProduction(jobDoc("load-isolation") as unknown as ProductionFile);
    const a = loadProduction("load-isolation")!;
    const b = loadProduction("load-isolation")!;
    expect(a).not.toBe(b);
    expect(a.scenes).not.toBe(b.scenes);
    expect(a.scenes[0].shots[0]).not.toBe(b.scenes[0].shots[0]);
    expect(a).toEqual(b);
    // Mutating one holder without saving is invisible to the next load.
    a.scenes[0].shots[0].artwork = "boards/0100/mutated.jpg";
    expect(loadProduction("load-isolation")!.scenes[0].shots[0].artwork).toBeUndefined();
  });

  it("a renderer save mid-generation can't detach the job's shot (lost edit history)", () => {
    // The 2026-09-12 incident: an edit-image generation finished and its file
    // landed on disk, but the history entry never persisted. The job held its
    // shot/node references across the generation await; a renderer
    // `production:save` in that window replaced the cached document's scenes,
    // so the job recorded onto detached objects and the commit saved without
    // the new generation — reporting success.
    saveProduction(jobDoc("mid-job-save") as unknown as ProductionFile);
    // Job starts and grabs its references, then awaits the generation.
    const pq = loadProduction("mid-job-save")!;
    const shot = pq.scenes[0].shots[0];
    const node = shot.graphEditNodes![0];
    // ...generation runs... the renderer saves (new prompt, stale gens).
    const existing = loadProduction("mid-job-save")!;
    const incoming = structuredClone(existing);
    incoming.scenes[0].shots[0].graphEditNodes![0].prompt = "new prompt";
    saveProduction(applyRendererState(existing, incoming));
    // Job resumes on its held references: records the finished generation
    // (mirroring the generateEditNode handler) and commits.
    node.prompt = "new prompt";
    recordGraphEditGen(shot, node.id, "boards/0100/b.jpg", "new prompt", "m");
    saveProduction(pq);
    const final = loadProduction("mid-job-save")!;
    const restored = final.scenes[0].shots[0].graphEditNodes![0];
    expect(restored.prompt).toBe("new prompt");
    expect((restored.gens ?? []).map((g) => g.path)).toEqual(["boards/0100/b.jpg", "boards/0100/a.jpg"]);
    expect(restored.genIndex).toBe(0);
  });
});

describe("video layout migration", () => {
  it("relocates a legacy flat clip into the shot's video/ folder and drops the videosDir field on load", () => {
    const folder = path.join(dataDir, "video-migration");
    fs.mkdirSync(path.join(folder, "videos"), { recursive: true });
    fs.writeFileSync(path.join(folder, "videos", "shot-0100-clip.mp4"), "bytes");
    const shot: ProductionShot = {
      id: "shot1", number: "0100", audio: "", visual: "Hero walks",
      graphOutputSource: "videogen", graphVideoGenIndex: 0,
      videoPath: "videos/shot-0100-clip.mp4",
      graphVideoGens: [{ path: "videos/shot-0100-clip.mp4", prompt: "p", model: "m", at: "" }],
    };
    const doc = baseProduction({
      meta: { ...baseProduction().meta, id: "video-migration", folder },
      scenes: [{ number: 1, title: "S1", shots: [shot] }],
      schemaVersion: 1,
    });
    saveProduction(doc as unknown as ProductionFile);
    const loaded = loadProduction("video-migration")!;
    const restored = loaded.scenes[0].shots[0];
    expect(restored.graphVideoGens![0].path).toBe("boards/0100/video/shot-0100-clip.mp4");
    expect(restored.videoPath).toBe("boards/0100/video/shot-0100-clip.mp4");
    expect(fs.existsSync(path.join(folder, "boards", "0100", "video", "shot-0100-clip.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(folder, "videos", "shot-0100-clip.mp4"))).toBe(false);
    expect((loaded.assets as { videosDir?: string }).videosDir).toBeUndefined();
    expect(loaded.schemaVersion).toBe(2);
  });
});

describe("unclaimedReferenceFiles", () => {
  it("skips files claimed by a character, product, or reference image/media path", () => {
    const p = baseProduction({
      characters: [{ id: "c1", name: "Mara", key: "", imagePath: "references/mara.png" }],
      products: [{ id: "pr1", name: "Compass", imagePath: "references/compass.jpg" }],
      references: [
        { id: "r1", name: "Silk", imagePath: "references/silk.webp" },
        { id: "r2", name: "Clip", media: "video", mediaPath: "references/clip.mp4" },
      ],
    });
    const files = [
      "references/mara.png", "references/compass.jpg", "references/silk.webp", "references/clip.mp4",
      "references/new-drop.png", "references/another (2).jpg",
    ];
    expect(unclaimedReferenceFiles(files, p)).toEqual(["references/new-drop.png", "references/another (2).jpg"]);
  });

  it("claims media paths even for files that look like images and claims on an empty production", () => {
    const p = baseProduction();
    expect(unclaimedReferenceFiles(["references/a.png", "references/b.jpg"], p)).toEqual(["references/a.png", "references/b.jpg"]);
    const media = baseProduction({ references: [{ id: "r1", name: "Odd", mediaPath: "references/a.png" }] });
    expect(unclaimedReferenceFiles(["references/a.png", "references/b.jpg"], media)).toEqual(["references/b.jpg"]);
  });
});

describe("referenceImagePaths", () => {
  it("collects absolute asset paths for every artwork-bearing reference", () => {
    const p = baseProduction({
      characters: [{ id: "c1", name: "Mara", key: "", imagePath: "references/mara.png" }],
      products: [{ id: "pr1", name: "Compass", imagePath: "references/compass.jpg" }],
      references: [
        { id: "r1", name: "Silk", imagePath: "references/silk.webp" },
        { id: "r2", name: "Clip", media: "video", mediaPath: "references/clip.mp4" },
        { id: "r3", name: "Blank" },
      ],
    });
    expect(referenceImagePaths(p)).toEqual([
      path.join("C:/workspace/prod", "references/mara.png"),
      path.join("C:/workspace/prod", "references/compass.jpg"),
      path.join("C:/workspace/prod", "references/silk.webp"),
    ]);
  });
});

describe("importProduction", () => {
  it("adopts the folder itself, names the doc after it, and preserves existing files", () => {
    const folder = path.join(dataDir, "external", "My Film");
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "kept.jpg"), Buffer.from("existing-bytes"));
    fs.writeFileSync(path.join(folder, "script.md"), "# My Film\n", "utf8");

    const p = importProduction(folder);
    // The folder itself is the production folder — no subfolder is created.
    expect(p.meta.folder).toBe(path.resolve(folder));
    expect(p.meta.name).toBe("My Film");
    expect(p.scenes).toEqual([]);
    // Scaffolded dirs exist, pre-existing files untouched.
    expect(fs.existsSync(path.join(folder, "voiceover"))).toBe(true);
    expect(fs.readFileSync(path.join(folder, "boards", "kept.jpg"), "utf8")).toBe("existing-bytes");
    expect(fs.readFileSync(path.join(folder, "script.md"), "utf8")).toBe("# My Film\n");
    expect(loadProduction(p.meta.id)?.meta.folder).toBe(path.resolve(folder));
  });

  it("returns the existing document when the folder is already registered", () => {
    const folder = path.join(dataDir, "external", "Dupe Film");
    fs.mkdirSync(folder, { recursive: true });
    const first = importProduction(folder);
    const second = importProduction(folder);
    expect(second.meta.id).toBe(first.meta.id);
  });

  it("throws for a folder that doesn't exist", () => {
    expect(() => importProduction(path.join(dataDir, "external", "no-such-folder"))).toThrow(/doesn't exist/);
  });
});
