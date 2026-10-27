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

import { applyRendererState, applyMagicPromptDelta, assertFreshRevision, importProduction, loadProduction, saveProduction, unclaimedReferenceFiles, referenceThumbnailPaths, generationVideoThumbnailPaths, generationImageThumbnailPaths, resetProductionLoadCacheForTests } from "../src/main/productions.js";
import type { ProductionFile } from "../src/main/productions.js";
import { recordBoardEdit, recordGraphEditGen, selectBoardFrame, syncBoardOutputToPipe } from "../src/main/pipeline.js";
import { assemblyPlan } from "../src/main/assembly.js";
import { boardFrameHistory } from "../src/shared/board-frames.js";
import { mediaEntryForPath } from "../src/shared/media-registry.js";
import { resolveShotDisplay } from "../src/shared/selected-output.js";

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

  it("applies a renderer pipe unbind while ignoring stale mirror nulls", () => {
    // unpipeOutput clears the pipe fields; the explicit mirror nulls a
    // whole-document save still carries are denied (command-owned) — the pipe
    // unbind applies, the frozen mirrors stay. The real unpipe flows through
    // the `selectGraphTake` command, which blanks main-side.
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
    // The denied mirror nulls can't clear the frozen frame (the legacy read
    // still sees it) — only the unpipe command blanks.
    expect(merged.scenes[0].shots[0].artwork).toBe("boards/0100/shot-0100-x.jpg");
    // The generation history itself survives the unpipe.
    expect(merged.scenes[0].shots[0].graphImageGens).toHaveLength(1);
  });

  it("keeps an edit-video clip selection on the pipe (the display resolves the node's take)", () => {
    // An edit-mode video node owns the take history; the take selection rides
    // the node merge, and the display resolves the clip from the pipe — no
    // mirror ride-through needed anymore.
    const gens = [
      { path: "boards/0100/video/shot-0100-new.mp4", prompt: "e", model: "m", at: "" },
      { path: "boards/0100/video/shot-0100-old.mp4", prompt: "e", model: "m", at: "" },
    ];
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
          graphVideoNodes: [{ id: "ev0", mode: "edit" as const, prompt: "e", gens, genIndex: 1 }],
          graphOutputSource: "videogen" as const,
          graphOutputVideoNodeId: "ev0",
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
          graphVideoNodes: [{ id: "ev0", mode: "edit" as const, prompt: "e", gens, genIndex: 0 }],
          graphOutputSource: "videogen" as const,
          graphOutputVideoNodeId: "ev0",
        }],
      }],
    });
    const merged = applyRendererState(fresh, incoming);
    expect(resolveShotDisplay(merged.scenes[0].shots[0])).toMatchObject({
      media: "clip", path: "boards/0100/video/shot-0100-new.mp4",
    });
    expect(merged.scenes[0].shots[0].graphVideoNodes?.[0].genIndex).toBe(0);
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

  it("keeps graph nodes the renderer deleted deleted (renderer owns membership)", () => {
    // The renderer's node list is authoritative: an empty list means "deleted",
    // not "stale snapshot". The previous id-keyed union kept every fresh node
    // the incoming list omitted, resurrecting deleted edit/video nodes on the
    // next reload.
    const fresh = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [{
          id: "shot1",
          number: "0100",
          audio: "",
          visual: "Hero",
          graphEditNodes: [
            { id: "edit0", prompt: "a", gens: [{ path: "boards/0100/a.jpg", prompt: "a", model: "m", at: "" }] },
            { id: "edit1", prompt: "b" },
            { id: "edit2", prompt: "c" },
          ],
          graphVideoNodes: [
            { id: "vid0", prompt: "v" },
            { id: "ev0", mode: "edit" as const, prompt: "e" },
          ],
        }],
      }],
    });
    const incoming = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [{ id: "shot1", number: "0100", audio: "", visual: "Hero", graphEditNodes: [], graphVideoNodes: [] }],
      }],
    });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.scenes[0].shots[0].graphEditNodes).toEqual([]);
    expect(merged.scenes[0].shots[0].graphVideoNodes).toEqual([]);
  });

  it("drops a surviving node's fresh history onto the incoming list by id", () => {
    const fresh = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [{
          id: "shot1",
          number: "0100",
          audio: "",
          visual: "Hero",
          graphVideoNodes: [
            { id: "vid0", prompt: "keep", gens: [{ path: "boards/0100/v0.mp4", prompt: "keep", model: "m", at: "" }] },
            { id: "vid1", prompt: "gone" },
          ],
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
          // vid1 deleted; vid0's prompt edited after the snapshot.
          graphVideoNodes: [{ id: "vid0", prompt: "edited" }],
        }],
      }],
    });
    const merged = applyRendererState(fresh, incoming);
    const nodes = merged.scenes[0].shots[0].graphVideoNodes!;
    expect(nodes.map((n) => n.id)).toEqual(["vid0"]);
    expect(nodes[0].prompt).toBe("edited");
    // Main-owned clip history survives on the kept node.
    expect(nodes[0].gens).toEqual(fresh.scenes[0].shots[0].graphVideoNodes![0].gens);
  });

  it("honours an explicit camera-grid/upscale deletion but keeps an untouched fresh one", () => {
    const fresh = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [
          {
            id: "deleted",
            number: "0100",
            audio: "",
            visual: "A",
            graphCameraGrid: { cols: 4, rows: 4, source: { kind: "imagegen" } } as CameraGridData,
            graphUpscale: { source: { kind: "imagegen" }, model: "topaz" },
          },
          {
            id: "kept",
            number: "0200",
            audio: "",
            visual: "B",
            graphCameraGrid: { cols: 4, rows: 4, sheetPath: "references/grids/g.png" } as CameraGridData,
          },
        ],
      }],
    });
    const incoming = baseProduction({
      scenes: [{
        number: 1,
        title: "S1",
        shots: [
          // Explicit undefined = the renderer deleted the singleton nodes.
          { id: "deleted", number: "0100", audio: "", visual: "A", graphCameraGrid: undefined, graphUpscale: undefined },
          // Untouched: no explicit clear, so the fresh main-written sheet stays.
          { id: "kept", number: "0200", audio: "", visual: "B" },
        ],
      }],
    });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.scenes[0].shots[0].graphCameraGrid).toBeUndefined();
    expect(merged.scenes[0].shots[0].graphUpscale).toBeUndefined();
    expect(merged.scenes[0].shots[1].graphCameraGrid?.sheetPath).toBe("references/grids/g.png");
  });

  it("camera-grid geometry follows the renderer size pick", () => {
    const withGrid = (grid: unknown) => baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [{ id: "s1", number: "0100", audio: "", visual: "", graphCameraGrid: grid } as never] }],
    });
    const fresh = withGrid({
      cols: 4, rows: 4, sheetPath: "references/grids/g.png", sheetAt: "2026-01-02T00:00:00.000Z",
      generation: { provider: "higgsfield", model: "m", prompt: "p" },
    } as CameraGridData);
    // Same sheet timestamp (the pick was made against the current sheet),
    // new geometry, panels cleared so they re-derive.
    const incoming = withGrid({
      cols: 3, rows: 3, sheetPath: "references/grids/g.png", sheetAt: "2026-01-02T00:00:00.000Z",
    } as CameraGridData);
    const merged = applyRendererState(fresh, incoming);
    const grid = merged.scenes[0].shots[0].graphCameraGrid;
    expect(grid?.cols).toBe(3);
    expect(grid?.rows).toBe(3);
    // Main still owns the generation record and the sheet itself.
    expect(grid?.generation?.model).toBe("m");
    expect(grid?.sheetPath).toBe("references/grids/g.png");
  });

  it("a stale pre-generation snapshot cannot revert the generated camera-grid geometry", () => {
    const withGrid = (grid: unknown) => baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [{ id: "s1", number: "0100", audio: "", visual: "", graphCameraGrid: grid } as never] }],
    });
    const fresh = withGrid({
      cols: 3, rows: 3, sheetPath: "references/grids/new.png", sheetAt: "2026-01-03T00:00:00.000Z",
      generation: { provider: "higgsfield", model: "m", prompt: "p" },
    } as CameraGridData);
    const incoming = withGrid({
      cols: 4, rows: 4, sheetPath: "references/grids/old.png", sheetAt: "2026-01-01T00:00:00.000Z",
    } as CameraGridData);
    const merged = applyRendererState(fresh, incoming);
    const grid = merged.scenes[0].shots[0].graphCameraGrid;
    expect(grid?.cols).toBe(3);
    expect(grid?.rows).toBe(3);
    expect(grid?.sheetPath).toBe("references/grids/new.png");
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
    // the wrong take on the fresh array, so the fresh index stands — and the
    // display resolves it (no mirror repair pass runs anymore).
    const diverged = applyRendererState(
      baseProduction({ scenes: [{ number: 1, title: "S1", shots: shots([{ path: "n", prompt: "", model: "", at: "" }, { path: "o", prompt: "", model: "", at: "" }], 0) }] }),
      baseProduction({ scenes: [{ number: 1, title: "S1", shots: shots([{ path: "o", prompt: "", model: "", at: "" }], 1) }] })
    );
    expect(diverged.scenes[0].shots[0].graphImageGenIndex).toBe(0);
    expect(resolveShotDisplay(diverged.scenes[0].shots[0])).toMatchObject({ media: "still", path: "n" });
    // Histories agree: the incoming selection applies and the display follows it.
    const agreed = applyRendererState(
      baseProduction({ scenes: [{ number: 1, title: "S1", shots: shots([{ path: "a", prompt: "", model: "", at: "" }, { path: "b", prompt: "", model: "", at: "" }], 0) }] }),
      baseProduction({ scenes: [{ number: 1, title: "S1", shots: shots([{ path: "a", prompt: "", model: "", at: "" }, { path: "b", prompt: "", model: "", at: "" }], 1) }] })
    );
    expect(agreed.scenes[0].shots[0].graphImageGenIndex).toBe(1);
    expect(resolveShotDisplay(agreed.scenes[0].shots[0])).toMatchObject({ media: "still", path: "b" });
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

  it("keeps the main-owned magicBible over a whole-document save, but takes renderer dismissals", () => {
    // The bible is written by the bulk Magic pass main-side; a renderer
    // snapshot can predate it, so the fresh bible always wins. Dismissals
    // from the reconciliation queue ARE renderer-owned and must land.
    const bible = { version: 1 as const, synopsis: "fresh", assumptions: [], scenes: [], entities: [], shotPlans: [], inputHash: "h1", generatedAt: "2026-01-01" };
    const stale = { ...bible, synopsis: "stale", inputHash: "h0" };
    const fresh = baseProduction({ magicBible: bible });
    const incoming = baseProduction({ magicBible: stale, magicDismissedRefs: [" MysteryFigure ", "mysteryfigure"] });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.magicBible?.synopsis).toBe("fresh");
    expect(merged.magicDismissedRefs).toEqual(["mysteryfigure"]);
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

  it("resolves the storyboard frame from the output pipe when the renderer's save is stale", () => {
    // The renderer sends the shot with the edit-image node piped to the output
    // but a stale/empty `artwork` (the apply raced its save). The pipe owns the
    // frame: the merge keeps the pipe, and the shared display resolves it —
    // no mirror repair pass runs anymore.
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
    expect(resolveShotDisplay(restored)).toMatchObject({ media: "still", path: "boards/0100/shot-0100-edit.jpg" });
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
    // A stale artwork mirror cannot replace the newly selected node output —
    // the merge keeps the pipe + selection, and the display resolves it.
    shot.artwork = "boards/0100/current.jpg";
    shot.videoPath = "videos/clip.mp4";
    const merged = applyRendererState(fresh, incoming);
    expect(resolveShotDisplay(merged.scenes[0].shots[0])).toMatchObject({ media: "still", path: rel });
    saveProduction(merged);

    for (let i = 0; i < 2; i++) {
      const loaded = loadProduction(incoming.meta.id);
      expect(loaded).not.toBeNull();
      const restored = loaded!.scenes[0].shots[0];
      expect(resolveShotDisplay(restored)).toMatchObject({ media: "still", path: rel });
      expect(restored.graphOutputSource).toBe(kind === "edit" ? "editgen" : "imagegen");
      expect(restored.graphImageGenIndex).toBe(selected.graphImageGenIndex);
      expect(restored.graphEditNodes?.map((n) => ({ ...n, gens: n.gens?.map(({ mediaId: _mediaId, ...g }) => g) }))).toEqual(selected.graphEditNodes?.map((n) => ({ ...n, gens: n.gens?.map(({ mediaId: _mediaId2, ...g }) => g) })));
      expect(restored.graphImageGens?.map(({ mediaId: _mediaId, ...g }) => g)).toEqual(selected.graphImageGens);
      expect(restored.graphVideoNodes?.[0]?.gens?.map(({ mediaId: _mediaId, ...g }) => g)).toEqual(selected.graphVideoGens);
      expect(restored.graphVideoNodes?.[0]?.source).toEqual({ kind: "imagegen" });
      expect(boardFrameHistory(restored)).toEqual(history);
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
      expect(resolveShotDisplay(restored)).toMatchObject({ media: "still", path: rel });
      expect(restored.graphOutputSource).toBe("editgen");
      const active = (restored.graphEditNodes ?? []).find((n) => n.id === restored.graphOutputEditNodeId)!;
      expect(active.genIndex).toBe(0);
      expect(active.source).toEqual(expectedSource);
      expect(restored.graphImageGenIndex).toBe(1);
      expect(restored.graphEditPrompt).toBe(prompt);
      expect(restored.graphEditNodes?.map((n) => ({ ...n, gens: n.gens?.map(({ mediaId: _mediaId, ...g }) => g) }))).toEqual(selected.graphEditNodes?.map((n) => ({ ...n, gens: n.gens?.map(({ mediaId: _mediaId2, ...g }) => g) })));
      expect(restored.graphImageGens?.map(({ mediaId: _mediaId, ...g }) => g)).toEqual(images);
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

describe("color tag migration", () => {
  it("turns the legacy complete marker into a green tag and drops invalid tags on load", () => {
    const folder = path.join(dataDir, "color-tag-migration");
    fs.mkdirSync(folder, { recursive: true });
    const legacy = { id: "shot1", number: "0100", audio: "", visual: "Hero", complete: true } as unknown as ProductionShot;
    const invalid = { id: "shot2", number: "0200", audio: "", visual: "Sidekick", colorTag: "blue" } as unknown as ProductionShot;
    const doc = baseProduction({
      meta: { ...baseProduction().meta, id: "color-tag-migration", folder },
      scenes: [{ number: 1, title: "S1", shots: [legacy, invalid] }],
    });
    saveProduction(doc as unknown as ProductionFile);
    const loaded = loadProduction("color-tag-migration")!;
    const [a, b] = loaded.scenes[0].shots;
    expect(a.colorTag).toBe("green");
    expect((a as { complete?: unknown }).complete).toBeUndefined();
    expect(b.colorTag).toBeUndefined();
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

  it("rebuilds scenes, shots, and board artwork from script.md + boards/", () => {
    const folder = path.join(dataDir, "external", "recovered-film-folder");
    fs.mkdirSync(path.join(folder, "boards", "0100"), { recursive: true });
    fs.mkdirSync(path.join(folder, "boards", "0200"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "0100", "shot-0100-a.jpg"), "fake-jpeg");
    fs.writeFileSync(path.join(folder, "boards", "0200", "shot-0200-a.jpg"), "fake-jpeg");
    fs.writeFileSync(
      path.join(folder, "script.md"),
      [
        "# Recovered Film — Shot Breakdown",
        "",
        "## Scene 1 — Opening",
        "",
        "| Shot | Audio | Visual |",
        "|------|-------|--------|",
        "| 0100 | Narration \\| one | A lighthouse at dawn |",
        "| 0200 |  | Waves on rocks |",
        "",
        "## Scene 2 — The Letter",
        "",
        "| Shot | Audio | Visual |",
        "|------|-------|--------|",
        "| 0300 | Dear Mara | Hands open an envelope |",
        "",
      ].join("\n"),
      "utf8"
    );

    const p = importProduction(folder);
    // The script.md title wins over the folder basename.
    expect(p.meta.name).toBe("Recovered Film");
    expect(p.scenes.map((s) => s.title)).toEqual(["Opening", "The Letter"]);
    const shots = p.scenes.flatMap((s) => s.shots);
    expect(shots.map((s) => s.number)).toEqual(["0100", "0200", "0300"]);
    expect(shots[0].audio).toBe("Narration | one");
    expect(shots[0].visual).toBe("A lighthouse at dawn");
    // Existing frames are linked; the unframed shot stays blank.
    expect(shots[0].artwork).toBe("boards/0100/shot-0100-a.jpg");
    expect(shots[1].artwork).toBe("boards/0200/shot-0200-a.jpg");
    expect(shots[2].artwork).toBeUndefined();
    expect(p.status[1]).toBe("done");
    expect(p.status[3]).toBeUndefined();
    // The returned document is fully loaded (stored graphs materialized),
    // exactly as if it had been opened via production:load.
    expect(shots[0].graph).toBeTruthy();
    // And it persists: a fresh load sees the same breakdown.
    expect(loadProduction(p.meta.id)?.scenes.flatMap((s) => s.shots).map((s) => s.number)).toEqual(["0100", "0200", "0300"]);
  });

  it("marks the storyboard step done when every recovered shot has a frame", () => {
    const folder = path.join(dataDir, "external", "Fully Framed");
    fs.mkdirSync(path.join(folder, "boards", "0100"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "0100", "shot-0100-a.jpg"), "fake-jpeg");
    fs.writeFileSync(
      path.join(folder, "script.md"),
      "# Fully Framed — Shot Breakdown\n\n## Scene 1 — Only\n\n| Shot | Audio | Visual |\n|------|-------|--------|\n| 0100 | Hi | A door |\n",
      "utf8"
    );

    const p = importProduction(folder);
    expect(p.status[3]).toBe("done");
    expect(p.currentStep).toBe(3);
  });

  it("synthesizes shots from board folders when script.md is missing", () => {
    const folder = path.join(dataDir, "external", "Boards Only");
    fs.mkdirSync(path.join(folder, "boards", "0300"), { recursive: true });
    fs.mkdirSync(path.join(folder, "boards", "0100"), { recursive: true });
    fs.mkdirSync(path.join(folder, "boards", "outdated", "x"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "0100", "shot-0100-a.jpg"), "fake-jpeg");
    fs.writeFileSync(path.join(folder, "boards", "0300", "shot-0300-a.jpg"), "fake-jpeg");

    const p = importProduction(folder);
    const shots = p.scenes.flatMap((s) => s.shots);
    expect(shots.map((s) => s.number)).toEqual(["0100", "0300"]);
    expect(shots.every((s) => !!s.artwork)).toBe(true);
    // No script was recovered, so Step 1 is not claimed done.
    expect(p.status[1]).toBeUndefined();
  });

  it("adopts reference images, style frames, voiceover, and music from disk", () => {
    const folder = path.join(dataDir, "external", "Assets Film");
    fs.mkdirSync(path.join(folder, "references"), { recursive: true });
    fs.mkdirSync(path.join(folder, "styles"), { recursive: true });
    fs.mkdirSync(path.join(folder, "voiceover"), { recursive: true });
    fs.mkdirSync(path.join(folder, "music"), { recursive: true });
    fs.writeFileSync(path.join(folder, "references", "Mara.png"), "fake-png");
    fs.writeFileSync(path.join(folder, "references", "Old Map.jpg"), "fake-jpeg");
    fs.writeFileSync(path.join(folder, "styles", "style-abc.png"), "fake-png");
    fs.writeFileSync(path.join(folder, "voiceover", "narration.mp3"), "fake-mp3");
    fs.writeFileSync(path.join(folder, "music", "theme.mp3"), "fake-mp3");

    const p = importProduction(folder);
    expect((p.references ?? []).map((r) => r.name).sort()).toEqual(["Mara", "Old Map"]);
    expect((p.references ?? []).map((r) => r.imagePath).sort()).toEqual(["references/Mara.png", "references/Old Map.jpg"]);
    expect(p.styles).toHaveLength(1);
    expect(p.styles[0].imagePath).toBe("styles/style-abc.png");
    expect(p.voiceoverPath).toBe("voiceover/narration.mp3");
    expect(p.musicPath).toBe("music/theme.mp3");
  });

  it("restores shot prompts from boards/prompts.md as content only", () => {
    const folder = path.join(dataDir, "external", "Prompted Film");
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    fs.writeFileSync(
      path.join(folder, "script.md"),
      "# Prompted Film — Shot Breakdown\n\n## Scene 1 — Only\n\n| Shot | Audio | Visual |\n|------|-------|--------|\n| 0100 | Hi | A door |\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(folder, "boards", "prompts.md"),
      "# Prompted Film — Storyboard Prompts\n\n## Shot 0100\n\nStyle: moody watercolor\n\nA red door, close up, brass knob\n\nReferences: @image1 — Mara (artwork attached)\n",
      "utf8"
    );

    const p = importProduction(folder);
    const shot = p.scenes[0].shots[0];
    expect(shot.prompt).toContain("A red door, close up, brass knob");
    expect(shot.prompt).not.toContain("Style:");
    expect(shot.prompt).not.toContain("References:");
    expect(shot.promptManual).toBe(true);
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

describe("shotSequences persistence", () => {
  type SeqGraph = NonNullable<Production["shotSequences"]>[number]["graph"];
  const live = (): Production["scenes"] => [
    { number: 1, title: "S1", shots: [
      { id: "a", number: "0100", audio: "", visual: "v" },
      { id: "b", number: "0200", audio: "", visual: "v" },
      { id: "c", number: "0300", audio: "", visual: "v" },
    ] },
  ];

  it("keeps the fresh take history against a stale renderer snapshot", () => {
    // A generation landed after the renderer snapshotted: the stale snapshot's
    // empty history must not revert the finished sequence clip.
    const gens = [{ path: "out/sequences/s1/clip.mp4", prompt: "motion", model: "m", at: "2026-01-01T00:00:00.000Z" }];
    const graph = (nodes: unknown[]) => ({ id: "s1", number: "Sequence 01", audio: "", visual: "", graphVideoNodes: nodes }) as SeqGraph;
    const fresh = baseProduction({
      scenes: live(),
      shotSequences: [{ id: "s1", name: "Sequence 01", shotIds: ["a", "b"], graph: graph([{ id: "vid0", prompt: "", gens }]) }],
    });
    const incoming = baseProduction({
      scenes: live(),
      shotSequences: [{ id: "s1", name: "Sequence 01", shotIds: ["a", "b"], graph: graph([{ id: "vid0", prompt: "new prompt" }]) }],
    });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.shotSequences![0].graph!.graphVideoNodes![0].gens).toEqual(gens);
    // Renderer-owned fields (the prompt / wiring) still ride through.
    expect(merged.shotSequences![0].graph!.graphVideoNodes![0].prompt).toBe("new prompt");
  });

  it("follows the renderer's take selection when the histories agree", () => {
    const gens = [{ path: "v1.mp4", prompt: "", model: "m", at: "" }, { path: "v0.mp4", prompt: "", model: "m", at: "" }];
    const seqWith = (genIndex: number) => baseProduction({
      scenes: live(),
      shotSequences: [{
        id: "s1", name: "Sequence 01", shotIds: ["a", "b"],
        graph: { id: "s1", number: "Sequence 01", audio: "", visual: "", graphVideoNodes: [{ id: "vid0", prompt: "", gens, genIndex }] } as SeqGraph,
      }],
    });
    const merged = applyRendererState(seqWith(0), seqWith(1));
    expect(merged.shotSequences![0].graph!.graphVideoNodes![0].genIndex).toBe(1);
  });

  it("adopts renderer creations and keeps renderer deletions", () => {
    const created = baseProduction({
      scenes: live(),
      shotSequences: [{ id: "s1", name: "Sequence 01", shotIds: ["a", "b"] }],
    });
    expect(applyRendererState(baseProduction({ scenes: live() }), created).shotSequences).toHaveLength(1);
    // Deleted in the renderer: the stale fresh entry stays gone.
    const deleted = applyRendererState(
      baseProduction({ scenes: live(), shotSequences: [{ id: "s1", name: "Sequence 01", shotIds: ["a", "b"] }] }),
      baseProduction({ scenes: live(), shotSequences: [] })
    );
    expect(deleted.shotSequences).toEqual([]);
  });

  it("leaves the field absent when neither side has sequences", () => {
    const merged = applyRendererState(baseProduction({ scenes: live() }), baseProduction({ scenes: live() }));
    expect(merged.shotSequences).toBeUndefined();
  });

  it("repairs the array on save: dead members pruned, empty sequences dropped", () => {
    const p = baseProduction({
      scenes: live(),
      shotSequences: [
        { id: "s1", name: "Sequence 01", shotIds: ["a", "gone", "b", "b"] },
        { id: "s2", name: "Sequence 02", shotIds: ["gone"] },
        { id: "s1", name: "dupe", shotIds: ["c"] },
      ] as Production["shotSequences"],
    });
    saveProduction(p);
    const reloaded = loadProduction(p.meta.id)!;
    expect(reloaded.shotSequences).toHaveLength(1);
    expect(reloaded.shotSequences![0]).toMatchObject({ id: "s1", shotIds: ["a", "b"] });
    expect(reloaded.shotSequences![0].name).toBe("Sequence 01");
  });

  it("folds the legacy flat sequence model into its graph on save", () => {
    const p = baseProduction({
      scenes: live(),
      shotSequences: [{
        id: "s1", name: "Sequence 01", shotIds: ["a", "b"],
        graph: { id: "s1", number: "Sequence 01", audio: "", visual: "", graphVideoNodes: [{ id: "vid0", prompt: "", refIds: ["a", "b"] }] } as SeqGraph,
      }],
    });
    saveProduction(p);
    const reloaded = loadProduction(p.meta.id)!;
    expect(reloaded.shotSequences![0].graph!.graphVideoNodes![0].refIds).toEqual(["a", "b"]);
    // Legacy flat fields on disk fold in too (raw shape bypasses the type).
    const legacy = baseProduction({
      scenes: live(),
      shotSequences: [{
        id: "s1", name: "Sequence 01", shotIds: ["a"],
        videoNodes: [{ id: "vid0", prompt: "", gens: [{ path: "v1.mp4", prompt: "", model: "m", at: "" }] }],
        output: { kind: "videogen", nodeId: "vid0" },
      } as unknown as NonNullable<Production["shotSequences"]>[number]],
    });
    saveProduction(legacy);
    const reloadedLegacy = loadProduction(legacy.meta.id)!;
    expect(reloadedLegacy.shotSequences![0].graph!.graphOutputSource).toBe("videogen");
    expect(reloadedLegacy.shotSequences![0].graph!.graphVideoNodes![0].gens).toHaveLength(1);
  });
});

describe("media registry (architecture hardening)", () => {
  it("is main-owned: a stale renderer snapshot cannot revert it", () => {
    const fresh = baseProduction({
      media: [{ id: "m1", path: "boards/0100/shot-0100-a.jpg", kind: "image", origin: "generated", state: "present" }],
      scenes: [{ number: 1, title: "S1", shots: [{ id: "s1", number: "0100", audio: "", visual: "v", artwork: "boards/0100/shot-0100-a.jpg" }] }],
    });
    const incoming = baseProduction({
      media: [],
      scenes: [{ number: 1, title: "S1", shots: [{ id: "s1", number: "0100", audio: "edited", visual: "v" }] }],
    });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.media).toHaveLength(1);
    expect(merged.scenes[0].shots[0].audio).toBe("edited");
  });

  it("bootstraps the registry on load: present files and missing files both record state", () => {
    const folder = path.join(dataDir, "media-bootstrap");
    fs.mkdirSync(path.join(folder, "boards", "0100"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "0100", "shot-0100-a.jpg"), "bytes");
    const doc = baseProduction({
      meta: { ...baseProduction().meta, id: "media-bootstrap", folder },
      schemaVersion: 3,
      scenes: [{ number: 1, title: "S1", shots: [{
        id: "s1", number: "0100", audio: "", visual: "v",
        artwork: "boards/0100/shot-0100-a.jpg",
        artworkHistory: ["boards/0100/shot-0100-gone.jpg"],
      }] }],
    });
    saveProduction(doc);
    const loaded = loadProduction("media-bootstrap")!;
    expect(mediaEntryForPath(loaded.media, "boards/0100/shot-0100-a.jpg")?.state).toBe("present");
    expect(mediaEntryForPath(loaded.media, "boards/0100/shot-0100-gone.jpg")?.state).toBe("missing");
  });

  it("repeat loads of the unchanged cached document reuse the bootstrap (perf phase 3)", () => {
    const folder = path.join(dataDir, "media-bootstrap-cache");
    const file = path.join(folder, "boards", "0100", "shot-0100-a.jpg");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "bytes");
    const doc = baseProduction({
      meta: { ...baseProduction().meta, id: "media-bootstrap-cache", folder },
      schemaVersion: 3,
      scenes: [{ number: 1, title: "S1", shots: [{ id: "s1", number: "0100", audio: "", visual: "v", artwork: "boards/0100/shot-0100-a.jpg" }] }],
    });
    resetProductionLoadCacheForTests();
    saveProduction(doc);
    expect(mediaEntryForPath(loadProduction("media-bootstrap-cache")!.media, "boards/0100/shot-0100-a.jpg")?.state).toBe("present");
    // File vanishes externally: an immediate repeat load reuses the sweep
    // (bounded staleness), a forced re-sweep sees the truth.
    fs.rmSync(file);
    expect(mediaEntryForPath(loadProduction("media-bootstrap-cache")!.media, "boards/0100/shot-0100-a.jpg")?.state).toBe("present");
    resetProductionLoadCacheForTests();
    expect(mediaEntryForPath(loadProduction("media-bootstrap-cache")!.media, "boards/0100/shot-0100-a.jpg")?.state).toBe("missing");
  });

  it("generationVideoThumbnailPaths lists every referenced clip, stills excluded", () => {
    const p = baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [{
        id: "s1", number: "0100", audio: "", visual: "v",
        artwork: "boards/0100/shot-0100-a.jpg",
        graphVideoNodes: [{ id: "vid0", prompt: "", gens: [{ path: "boards/0100/video/shot-0100-x.mp4", prompt: "", model: "", at: "" }] }],
      }] }],
    });
    const paths = generationVideoThumbnailPaths(p as never);
    expect(paths.some((abs) => abs.endsWith("shot-0100-x.mp4"))).toBe(true);
    expect(paths.some((abs) => abs.endsWith(".jpg"))).toBe(false);
  });

  it("generationImageThumbnailPaths lists every referenced still, clips excluded", () => {
    const p = baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [{
        id: "s1", number: "0100", audio: "", visual: "v",
        artwork: "boards/0100/shot-0100-a.jpg",
        graphVideoNodes: [{ id: "vid0", prompt: "", gens: [{ path: "boards/0100/video/shot-0100-x.mp4", prompt: "", model: "", at: "" }] }],
      }] }],
    });
    const paths = generationImageThumbnailPaths(p as never);
    expect(paths.some((abs) => abs.endsWith("shot-0100-a.jpg"))).toBe(true);
    expect(paths.some((abs) => abs.endsWith(".mp4"))).toBe(false);
  });
});

describe("revision gating (phase 4: stale destructive edits are rejected, not silently applied)", () => {
  it("passes when the caller names the current revision, and when it names none", () => {
    const p = baseProduction() as ProductionFile;
    p.rev = 7;
    expect(() => assertFreshRevision(p, 7)).not.toThrow();
    expect(() => assertFreshRevision(p, undefined)).not.toThrow();
    expect(() => assertFreshRevision({ ...p, rev: undefined } as ProductionFile, 7)).not.toThrow();
  });

  it("rejects a stale base revision with the fresh revision attached", () => {
    const p = baseProduction() as ProductionFile;
    p.rev = 9;
    let caught: unknown;
    try {
      assertFreshRevision(p, 7);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/Stale edit:.*rev 7 → 9/);
    expect((caught as { freshRev?: number }).freshRev).toBe(9);
  });
});

describe("reorder vs stale whole-document save (phase 3)", () => {  it("keeps a fresh storyboard reorder while applying a stale layout edit", () => {
    const layout = (x: number, y: number): ProductionShot["graphLayout"] => ({ positions: { composer: { x, y } } });
    // The fresh document: storyboard reordered (B now first) via the
    // `production:reorderShot` command.
    const fresh = baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [
        { id: "b", number: "0100", audio: "", visual: "B" },
        { id: "a", number: "0200", audio: "", visual: "A", graphLayout: layout(1, 1) },
      ] }],
    });
    // A renderer snapshot captured before the reorder lands with a graph
    // layout edit (a node drag) — in the OLD order.
    const stale = baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [
        { id: "a", number: "0100", audio: "", visual: "A", graphLayout: layout(2, 2) },
        { id: "b", number: "0200", audio: "", visual: "B" },
      ] }],
    });
    const merged = applyRendererState(fresh, stale);
    // The fresh order stands (main owns structure)…
    expect(merged.scenes[0].shots.map((s) => s.id)).toEqual(["b", "a"]);
    // …and the renderer-owned layout edit still lands on its shot.
    const a = merged.scenes[0].shots.find((s) => s.id === "a")!;
    expect(a.graphLayout).toEqual(layout(2, 2));
  });
});

describe("legacy project end-to-end (architecture hardening)", () => {
  it("a schema-v2 project opens, survives a renderer save, accepts a selection, and reopens identically", () => {
    const folder = path.join(dataDir, "legacy-e2e");
    fs.mkdirSync(path.join(folder, "boards", "0100"), { recursive: true });
    fs.mkdirSync(path.join(folder, "videos"), { recursive: true });
    // The pre-v3 shape: flat video fields, artwork/history, no stored graph,
    // a pending contingency, and a classic unpiped second shot.
    const videoShot: ProductionShot = {
      id: "shot1", number: "0100", audio: "line", visual: "wide",
      artwork: "boards/0100/shot-0100-a.jpg",
      artworkHistory: ["boards/0100/shot-0100-old.jpg"],
      graphImageGens: [
        { path: "boards/0100/shot-0100-a.jpg", prompt: "frame", model: "auto", at: "" },
        { path: "boards/0100/shot-0100-old.jpg", prompt: "frame", model: "auto", at: "" },
      ],
      graphImageGenIndex: 0,
      graphVideoGens: [{ path: "videos/shot-0100.mp4", prompt: "motion", model: "auto", at: "" }],
      graphVideoGenIndex: 0,
      graphVideoPrompt: "drift",
      graphImageToVideo: true,
      videoPath: "videos/shot-0100.mp4",
      graphOutputSource: "videogen",
      pendingImageGen: { prompt: "orphan", model: "auto", at: "" },
    };
    const classicShot: ProductionShot = {
      id: "shot2", number: "0200", audio: "", visual: "classic",
      artwork: "boards/0200/shot-0200-x.jpg",
      artworkHistory: ["boards/0200/shot-0200-y.jpg"],
    };
    const doc = baseProduction({
      meta: { ...baseProduction().meta, id: "legacy-e2e", folder },
      scenes: [{ number: 1, title: "S1", shots: [videoShot, classicShot] }],
      schemaVersion: 2,
    });
    saveProduction(doc);

    // First load migrates the flat video fields into vid0 and derives the
    // legacy mirrors once (the migration still runs the pipe sync) — the
    // storyboard/animatic/export all resolve through the shared display.
    const first = loadProduction("legacy-e2e")!;
    const shot1 = first.scenes[0].shots[0];
    expect(shot1.graphVideoNodes![0]).toMatchObject({
      id: "vid0", prompt: "drift", source: { kind: "imagegen" },
    });
    expect(shot1.graphVideoNodes![0].gens![0].path).toBe("videos/shot-0100.mp4");
    expect(resolveShotDisplay(shot1)).toMatchObject({ media: "clip", path: "videos/shot-0100.mp4" });
    expect(shot1.pendingImageGen).toBeDefined();
    expect(syncBoardOutputToPipe(shot1)).toBe(false);

    // A renderer whole-document save (with a stale, pre-migration echo of the
    // legacy fields) cannot clobber main-owned state.
    const stale = baseProduction({
      meta: { ...baseProduction().meta, id: "legacy-e2e", folder },
      scenes: [{ number: 1, title: "S1", shots: [{
        ...videoShot,
        audio: "edited line",
        pendingImageGen: undefined,
        videoPath: undefined,
      }, classicShot] }],
    });
    const merged = applyRendererState(first, stale);
    expect(merged.scenes[0].shots[0].audio).toBe("edited line");
    expect(merged.scenes[0].shots[0].pendingImageGen).toBeDefined();
    expect(resolveShotDisplay(merged.scenes[0].shots[0])).toMatchObject({ media: "clip", path: "videos/shot-0100.mp4" });

    // The user promotes an older frame through the new selection write-through.
    selectBoardFrame(merged.scenes[0].shots[0], "boards/0100/shot-0100-old.jpg");
    expect(resolveShotDisplay(merged.scenes[0].shots[0])).toMatchObject({ media: "still", path: "boards/0100/shot-0100-old.jpg" });
    expect(merged.scenes[0].shots[0].graphOutputSource).toBe("imagegen");
    saveProduction(merged);

    // Second load opens identically — a fixed point, and export resolves the
    // same output the storyboard shows.
    const second = loadProduction("legacy-e2e")!;
    expect(resolveShotDisplay(second.scenes[0].shots[0])).toMatchObject({ media: "still", path: "boards/0100/shot-0100-old.jpg" });
    expect(second.scenes[0].shots[0].graphImageGenIndex).toBe(1);
    const plan = assemblyPlan(second);
    const shot1Event = plan.events.find((e) => e.number === "0100");
    expect(shot1Event?.kind).toBe("still");
    expect(shot1Event?.srcRel).toBe("boards/0100/shot-0100-old.jpg");
  });
});
