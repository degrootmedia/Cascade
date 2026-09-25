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
import type { CameraGridData, Graph, Production, ProductionShot } from "../src/shared/ipc.js";

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

import { applyRendererState, applyMagicPromptDelta, importProduction, loadProduction, saveProduction, unclaimedReferenceFiles, referenceThumbnailPaths } from "../src/main/productions.js";
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

  it("keeps the main-owned outdated panels over a stale renderer snapshot", () => {
    const live: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "v" };
    const old: ProductionShot = {
      id: "old", number: "0100", audio: "a", visual: "v",
      outdated: true, outdatedAt: "2026-01-01T00:00:00.000Z",
      artwork: "boards/outdated/old/shot-0100-old.jpg",
    };
    const fresh = baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [live] }],
      outdatedShots: [old],
    });
    // A renderer snapshot that never saw the outdated bucket (or is stale).
    const incoming = baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [live] }],
      outdatedShots: [],
    });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.outdatedShots).toEqual([old]);
  });

  it("preserves sanitized openArt params/quality and drops non-scalar shapes", () => {
    // Regression: the whitelist once rebuilt openArt with model/resolution
    // (+quality) only, silently reverting every storyboard params pick —
    // and its quote — on the next reload.
    const fresh = baseProduction();
    // Parsed from the wire, so corrupt shapes are representable.
    const dirtyParams = JSON.parse(JSON.stringify({
      variant: "sunburst", seed: 7, deep: { nested: true }, list: ["a", 1],
    }));
    const incoming = baseProduction({
      openArt: {
        model: "higgsfield-cli:gpt_image_2_5", resolution: "2k", quality: " high ",
        params: dirtyParams,
      },
    });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.openArt).toEqual({
      model: "higgsfield-cli:gpt_image_2_5", resolution: "2k", quality: "high",
      params: { variant: "sunburst", seed: 7 },
    });
    // Absent params stay absent (no empty bag written).
    const bare = applyRendererState(baseProduction(), baseProduction({
      openArt: { model: "auto", resolution: "1k" },
    }));
    expect(bare.openArt).toEqual({ model: "auto", resolution: "1k" });
  });

  it("merges the camera-grid node: fresh owns the sheet, renderer owns the wiring", () => {
    const fresh = baseProduction({
      scenes: [{
        number: 1, title: "S1",
        shots: [{
          id: "s1", number: "0100", audio: "", visual: "",
          graphCameraGrid: {
            cols: 4, rows: 4,
            sheetPath: "references/grids/new.png",
            panels: [{ x: 0, y: 0, w: 1, h: 1 }],
            generation: { provider: "openart", model: "m", prompt: "old prompt" },
          },
        }],
      }],
    });
    const incoming = baseProduction({
      scenes: [{
        number: 1, title: "S1",
        shots: [{
          id: "s1", number: "0100", audio: "", visual: "",
          graphCameraGrid: {
            cols: 4, rows: 4,
            sheetPath: "references/grids/stale.png",
            source: { kind: "ref", refId: "r1" },
            refIds: ["r1", "r2"],
            model: "higgsfield-cli:x",
            resolution: "2k",
          },
        }],
      }],
    });
    const grid = applyRendererState(fresh, incoming).scenes[0].shots[0].graphCameraGrid!;
    // Main-owned sheet + provenance win over the stale snapshot.
    expect(grid.sheetPath).toBe("references/grids/new.png");
    expect(grid.generation?.prompt).toBe("old prompt");
    // Renderer-owned wiring + picks ride through.
    expect(grid.source).toEqual({ kind: "ref", refId: "r1" });
    expect(grid.refIds).toEqual(["r1", "r2"]);
    expect(grid.model).toBe("higgsfield-cli:x");
    expect(grid.resolution).toBe("2k");
  });

  it("keeps a plugged grid image's sheet across a save (newer sheetAt wins)", () => {
    const gridShot = (grid: CameraGridData, graph?: Graph) => ({
      id: "s1", number: "0100", audio: "", visual: "",
      graphCameraGrid: grid,
      ...(graph ? { graph } : {}),
    });
    const fresh = baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [gridShot({
        cols: 4, rows: 4,
        sheetPath: "references/grids/generated.png",
        sheetAt: "2026-01-01T00:00:00.000Z",
        generation: { provider: "openart", model: "m", prompt: "p" },
      })] }],
    });
    const incoming = baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [gridShot(
        {
          cols: 4, rows: 4,
          sheetPath: "references/grids/imported.png",
          sheetAt: "2026-01-01T00:00:01.000Z",
          gridSource: { kind: "ref", refId: "r1" },
        },
        {
          version: 1,
          nodes: [
            { id: "cameraGrid", kind: "cameraGrid", pos: { x: 0, y: 0 } },
            { id: "ref:r1", kind: "ref", pos: { x: 0, y: 0 } },
          ],
          edges: [{ id: "e-ref-camgrid-grid", from: { node: "ref:r1", port: "out" }, to: { node: "cameraGrid", port: "in-grid" } }],
        },
      )] }],
    });
    const shot = applyRendererState(fresh, incoming).scenes[0].shots[0] as ProductionShot & { graph?: Graph };
    expect(shot.graphCameraGrid?.gridSource).toEqual({ kind: "ref", refId: "r1" });
    expect(shot.graphCameraGrid?.sheetPath).toBe("references/grids/imported.png");
    expect((shot.graph?.edges ?? []).some((e) => e.to.port === "in-grid")).toBe(true);
  });

  it("a fresh generation still beats a stale renderer save (older sheetAt loses)", () => {
    const mk = (grid: CameraGridData) => baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [{ id: "s1", number: "0100", audio: "", visual: "", graphCameraGrid: grid }] }],
    });
    const fresh = mk({
      cols: 4, rows: 4,
      sheetPath: "references/grids/regenerated.png",
      sheetAt: "2026-01-01T00:00:10.000Z",
      generation: { provider: "openart", model: "m", prompt: "new" },
    });
    const incoming = mk({
      cols: 4, rows: 4,
      sheetPath: "references/grids/old.png",
      sheetAt: "2026-01-01T00:00:00.000Z",
      gridSource: { kind: "ref", refId: "r1" },
    });
    const grid = applyRendererState(fresh, incoming).scenes[0].shots[0].graphCameraGrid!;
    expect(grid.sheetPath).toBe("references/grids/regenerated.png");
    expect(grid.generation?.prompt).toBe("new");
  });

  it("adopts a camera-grid node the fresh document lacks", () => {
    const fresh = baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [{ id: "s1", number: "0100", audio: "", visual: "" }] }],
    });
    const incoming = baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [{ id: "s1", number: "0100", audio: "", visual: "", graphCameraGrid: { cols: 4, rows: 4, refIds: ["r1"] } }] }],
    });
    expect(applyRendererState(fresh, incoming).scenes[0].shots[0].graphCameraGrid).toEqual({ cols: 4, rows: 4, refIds: ["r1"] });
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

  it("keeps the main-owned magicPrompts map over a whole-document save", () => {
    // magicPrompts is written main-side (bulk/per-shot generation and the
    // prompt drawer's updateBoardPrompt). A whole-document save carries a
    // snapshot that can predate a generation, so accepting its map would
    // revert fresh prompts on other shots — the fresh on-disk map always wins.
    const fresh = baseProduction({ magicPrompts: { shot1: "fresh generated", shot2: "untouched" } });
    const incoming = baseProduction({ magicPrompts: { shot1: "stale typed edit", shot3: "   " } });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.magicPrompts).toEqual({ shot1: "fresh generated", shot2: "untouched" });
  });

  it("rebases only the magic keys a job changed, preserving concurrent edits", () => {
    // A generation job holds a snapshot from before it ran. Rebasing must fold
    // back ONLY the keys it changed (shot1), never its stale copy of keys
    // written while it ran (shot2's concurrent edit).
    const fresh = { shot2: "edited during the job", shot3: "untouched" };
    const before = { shot1: "old one", shot2: "old two" };
    const after = { shot1: "fresh one", shot2: "old two" };
    expect(applyMagicPromptDelta(fresh, before, after)).toEqual({
      shot1: "fresh one",
      shot2: "edited during the job",
      shot3: "untouched",
    });
  });

  it("deletes a magic key the job cleared but leaves other keys alone", () => {
    const fresh = { shot1: "stale", shot2: "keep" };
    expect(applyMagicPromptDelta(fresh, { shot1: "stale" }, {})).toEqual({ shot2: "keep" });
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
      expect(restored.graphVideoNodes?.[0]?.gens).toEqual(selected.graphVideoGens);
      expect(restored.graphVideoNodes?.[0]?.source).toEqual({ kind: "imagegen" });
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
      expect(restored.graphVideoNodes?.[0]?.source).toEqual({ kind: "imagegen" });
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
    expect(restored.graphVideoNodes![0].gens![0].path).toBe("boards/0100/video/shot-0100-clip.mp4");
    expect(restored.videoPath).toBe("boards/0100/video/shot-0100-clip.mp4");
    expect(fs.existsSync(path.join(folder, "boards", "0100", "video", "shot-0100-clip.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(folder, "videos", "shot-0100-clip.mp4"))).toBe(false);
    expect((loaded.assets as { videosDir?: string }).videosDir).toBeUndefined();
    expect(loaded.schemaVersion).toBe(3);
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

describe("referenceThumbnailPaths", () => {
  it("collects absolute asset paths for every artwork-bearing reference, images and video clips", () => {
    const p = baseProduction({
      characters: [{ id: "c1", name: "Mara", key: "", imagePath: "references/mara.png" }],
      products: [{ id: "pr1", name: "Compass", imagePath: "references/compass.jpg" }],
      references: [
        { id: "r1", name: "Silk", imagePath: "references/silk.webp" },
        { id: "r2", name: "Clip", media: "video", mediaPath: "references/clip.mp4" },
        { id: "r3", name: "Blank" },
      ],
    });
    expect(referenceThumbnailPaths(p)).toEqual([
      path.join("C:/workspace/prod", "references/mara.png"),
      path.join("C:/workspace/prod", "references/compass.jpg"),
      path.join("C:/workspace/prod", "references/silk.webp"),
      path.join("C:/workspace/prod", "references/clip.mp4"),
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

describe("too-old production guard (step 10 T5)", () => {
  it("a production below the minimum schema fails loudly with the version named", () => {
    const p = baseProduction({ schemaVersion: 0 });
    saveProduction(p);
    expect(() => loadProduction(p.meta.id)).toThrow(/schema version 0.*minimum supported version 1/);
  });

  it("v1 and unversioned legacy documents still migrate", () => {
    const v1 = baseProduction({ schemaVersion: 1 });
    saveProduction(v1);
    expect(loadProduction(v1.meta.id)?.schemaVersion).toBe(3);
    const legacy = baseProduction();
    delete (legacy as { schemaVersion?: number }).schemaVersion;
    saveProduction(legacy);
    expect(loadProduction(legacy.meta.id)?.schemaVersion).toBe(3);
  });
});
