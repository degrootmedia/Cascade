/**
 * Field-ownership guardrail (architecture hardening workstream 1,
 * recommendation 6 of the brief).
 *
 * The ownership table (`main/shot-ownership.ts`) classifies every
 * `ProductionShot` field with an owner and a merge policy, and the compile-
 * time `Record<keyof ProductionShot, ShotFieldPolicy>` fails the build the
 * moment a field is added unclassified. These tests pin what the table says
 * against how the merge layer actually behaves:
 *
 *   - every field of a fully-populated shot is classified,
 *   - the deny/index buckets hold exactly the main-owned fields,
 *   - a whole-document renderer save cannot overwrite main-owned generation
 *     results, pending-job contingencies, or archive state — only the
 *     renderer-owned fields ride through.
 *
 * Workflow guardrail (from the brief): after main-process changes, fully
 * rebuild and restart before testing the packaged app.
 */
import { afterAll, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import {
  SHOT_FIELD_OWNERSHIP,
  SHOT_INDEX_FIELDS,
  SHOT_MERGE_DENIED_FIELDS,
} from "../src/main/shot-ownership.js";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/opencode/cascade-ownership-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { applyRendererState } from "../src/main/productions.js";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

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

const FULL_FIELD_SHOT: ProductionShot = {
  id: "s1", number: "0100", audio: "line", visual: "wide",
  artwork: "boards/s1/shot-0100.jpg", artworkHistory: ["boards/s1/old.jpg"],
  videoPath: "videos/s1/clip.mp4", muted: true, videoOffsetSec: 1.5, durationSec: 4,
  style: "st1", styleNone: false, refIds: ["r1"], refExcluded: ["r2"],
  prompt: "heroic", promptManual: true, includeBrandIdentity: true,
  refPromptOverrides: { r1: "override" },
  graphLayout: { positions: { composer: { x: 0, y: 0 } } },
  graph: { version: 1, nodes: [], edges: [] },
  graphImageGens: [{ path: "boards/s1/a.jpg", prompt: "p", model: "m", at: "" }],
  graphImageGenIndex: 0,
  graphImageParams: { variant: "v" }, graphImageModel: "img-model", graphImageResolution: "2k",
  graphVideoGens: [], graphVideoGenIndex: 0,
  graphVideoPrompt: "drift", graphVideoModel: "vid-model", graphVideoResolution: "1080p",
  graphVideoDurationSec: 4, graphVideoParams: { mode: "std" },
  graphVideoNodes: [{ id: "vid0", prompt: "drift" }],
  graphOutputVideoNodeId: "vid0",
  graphEditNodes: [{ id: "edit0", prompt: "fix" }],
  graphOutputEditNodeId: "edit0",
  graphVideoSourceEditNodeId: "edit0",
  graphEditGens: [], graphEditGenIndex: 0, graphEditPrompt: "draft",
  graphEditImageSource: true, graphEditSourceRefId: "r1",
  graphVideoRefIds: ["r1"], graphImageToVideo: true, graphEditToVideo: false,
  graphVideoSourceRefId: "r1",
  graphTweenRefIds: ["imagegen", "r1"],
  graphTweenBlocks: [{ id: "tw0", startRefId: "imagegen", endRefId: "r1", prompt: "walk", startSec: 0, durationSec: 2 }],
  graphTweenModel: "tween-model", graphTweenResolution: "1080p",
  graphEditVideoGens: [], graphEditVideoGenIndex: 0,
  graphEditVideoPrompt: "cut", graphEditVideoModel: "ev-model", graphEditVideoResolution: "1080p",
  graphEditVideoParams: {}, graphEditVideoRefIds: [], graphEditVideoSourceRefId: "r1",
  graphVideoToEditVideo: true,
  graphTweenParams: { aspect_ratio: "16:9" },
  graphCameraGrid: { cols: 4, rows: 4 },
  graphUpscale: { gens: [] },
  graphSequence: { segments: [] },
  graphTweenOutput: "videos/s1/stitch.mp4", graphTweenReencoded: true,
  graphStyleConnected: true, graphVideoStyleConnected: true, graphEditStyleConnected: true,
  graphOutputSource: "videogen", graphOutputRefId: "r1",
  graphMigrated: true,
  pendingImageGen: { prompt: "p", model: "m", at: "" },
  pendingVideoGen: { prompt: "p", model: "m", at: "" },
  disabled: false, outdated: true, outdatedAt: "2026-01-01T00:00:00.000Z",
};

describe("shot field ownership", () => {
  it("classifies every field present on a fully-populated shot", () => {
    for (const key of Object.keys(FULL_FIELD_SHOT)) {
      expect(SHOT_FIELD_OWNERSHIP[key as keyof ProductionShot], key).toBeDefined();
    }
  });

  it("denies main-owned generation results and contingencies", () => {
    for (const key of [
      "id", "number", "artworkHistory", "graphImageGens", "graphVideoGens",
      "graphEditGens", "graphEditVideoGens", "graphTweenOutput", "graphTweenReencoded",
      "pendingImageGen", "pendingVideoGen", "graphMigrated", "outdated", "outdatedAt",
      "graphEditVideoPrompt", "graphEditVideoModel", "graphEditVideoResolution",
      "graphEditVideoParams", "graphEditVideoRefIds", "graphEditVideoSourceRefId",
      "graphVideoToEditVideo",
    ] as (keyof ProductionShot)[]) {
      expect(SHOT_MERGE_DENIED_FIELDS, key).toContain(key);
    }
  });

  it("re-anchors exactly the three selected indexes via takeGenIndex", () => {
    expect([...SHOT_INDEX_FIELDS].sort()).toEqual(
      ["graphImageGenIndex", "graphVideoGenIndex", "graphEditVideoGenIndex"].sort()
    );
  });

  it("classifies the pipe mirrors as derived (never a bare copy)", () => {
    expect(SHOT_FIELD_OWNERSHIP.artwork.owner).toBe("derived");
    expect(SHOT_FIELD_OWNERSHIP.videoPath.owner).toBe("derived");
    expect(SHOT_FIELD_OWNERSHIP.artwork.merge).toBe("special");
    expect(SHOT_FIELD_OWNERSHIP.videoPath.merge).toBe("special");
  });

  it("classifies the generator node lists with dedicated merge rules", () => {
    for (const key of ["graphVideoNodes", "graphEditNodes", "graphTweenBlocks", "graphUpscale", "graphCameraGrid"] as const) {
      expect(SHOT_FIELD_OWNERSHIP[key].merge, key).toBe("special");
    }
  });

  it("keeps main-owned shot state over a stale whole-document save", () => {
    const freshShot: ProductionShot = {
      ...FULL_FIELD_SHOT,
      audio: "fresh audio",
      outdated: true,
      graphTweenReencoded: true,
      graphTweenOutput: "videos/s1/stitch.mp4",
      artworkHistory: ["boards/s1/a.jpg"],
      pendingImageGen: { prompt: "p", model: "m", at: "t" },
      pendingVideoGen: { prompt: "p", model: "m", at: "t" },
      graphMigrated: true,
    };
    const fresh = baseProduction({ scenes: [{ number: 1, title: "S1", shots: [freshShot] }] });
    // A stale renderer snapshot that predates the main-side writes: it would
    // clear every main-owned field if the merge trusted it.
    const incomingShot: ProductionShot = {
      ...FULL_FIELD_SHOT,
      audio: "edited audio",
      outdated: false,
      outdatedAt: undefined,
      graphTweenReencoded: false,
      graphTweenOutput: undefined,
      artworkHistory: [],
      pendingImageGen: undefined,
      pendingVideoGen: undefined,
      graphMigrated: false,
    };
    const incoming = baseProduction({ scenes: [{ number: 1, title: "S1", shots: [incomingShot] }] });
    const merged = applyRendererState(fresh, incoming);
    const shot = merged.scenes[0].shots[0];
    // Renderer-owned text rides through…
    expect(shot.audio).toBe("edited audio");
    // …but main-owned generation results, contingencies, and archive state
    // cannot be overwritten or cleared by the stale snapshot.
    expect(shot.outdated).toBe(true);
    expect(shot.outdatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(shot.graphTweenReencoded).toBe(true);
    expect(shot.graphTweenOutput).toBe("videos/s1/stitch.mp4");
    expect(shot.artworkHistory).toEqual(["boards/s1/a.jpg"]);
    expect(shot.pendingImageGen).toBeDefined();
    expect(shot.pendingVideoGen).toBeDefined();
    expect(shot.graphMigrated).toBe(true);
  });
});
