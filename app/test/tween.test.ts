/**
 * In-betweener tests — the tween helpers behind the node-graph node and its
 * timeline modal. Pure logic at the pipeline seam (block derivation, timing
 * clamps, history, pipe authority) plus the OpenArt end-frame assignment and
 * the assembly expansion that keeps original block clips out of any
 * recompression.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TWEEN_KEY_IMGGEN, TWEEN_KEY_EDITGEN, isTweenGenKeyframe, type Production, type ProductionShot, type TweenBlock } from "../src/shared/ipc.js";

// pipeline.ts imports scripting.ts; the tests never call its helpers and its
// dynamic pdf-parse import doesn't resolve under Vitest — mock it away.
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  buildTweenConcatList,
  deriveTweenBlocks,
  recordTweenBlockGen,
  syncBoardOutputToPipe,
  syncTweenBlocks,
  tweenClampGap,
  tweenSelectedClips,
  tweenSnapSec,
  unstitchTween,
} from "../src/main/pipeline.js";
import { applyKeyframeDrag, deriveTweenBlocksClient, filterTweenModels, tweenPreviewTake, tweenSupportedLabel, tweenSupportsDuration } from "../src/renderer/src/components/TweenTimelineModal.js";
import { videoRefsAssign } from "../src/main/openart.js";
import { assemblyPlan, buildEdl, edlReelFor } from "../src/main/assembly.js";

function block(overrides: Partial<TweenBlock> = {}): TweenBlock {
  return { id: "tw0", startRefId: "a", endRefId: "b", prompt: "", startSec: 0, durationSec: 2, ...overrides };
}

function shot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: "s1", number: "0100", audio: "", visual: "", ...overrides };
}

describe("tween timing", () => {
  it("snaps to whole seconds and clamps gaps to 1–15s", () => {
    expect(tweenSnapSec(2.4)).toBe(2);
    expect(tweenSnapSec(2.6)).toBe(3);
    expect(tweenClampGap(0)).toBe(1);
    expect(tweenClampGap(99)).toBe(15);
    expect(tweenClampGap(2.4)).toBe(2);
  });

  it("needs at least two keyframes", () => {
    expect(deriveTweenBlocks([], [])).toEqual([]);
    expect(deriveTweenBlocks(["a"], [])).toEqual([]);
  });

  it("derives one block per adjacent pair with cumulative timing", () => {
    const blocks = deriveTweenBlocks(["a", "b", "c"], []);
    expect(blocks.map((b) => [b.id, b.startRefId, b.endRefId, b.startSec, b.durationSec])).toEqual([
      ["tw0", "a", "b", 0, 2],
      ["tw1", "b", "c", 2, 2],
    ]);
  });

  it("preserves prompts, timing, and history across reordering (pair-key match)", () => {
    const prev = [
      block({ id: "tw0", startRefId: "a", endRefId: "b", prompt: "she turns", durationSec: 4, gens: [{ path: "videos/x.mp4", prompt: "she turns", model: "m", at: "" }], genIndex: 0 }),
      block({ id: "tw1", startRefId: "b", endRefId: "c", prompt: "he waves", startSec: 4, durationSec: 3 }),
    ];
    // Full reorder breaks every pair — all blocks come back fresh.
    const fresh = deriveTweenBlocks(["c", "b", "a"], prev);
    expect(fresh.map((b) => b.prompt)).toEqual(["", ""]);
    expect(fresh.map((b) => b.durationSec)).toEqual([2, 2]);
    // Partial reorder keeps the surviving pair intact (prompt, timing, takes).
    const kept = deriveTweenBlocks(["a", "b", "d", "c"], prev);
    expect(kept).toHaveLength(3);
    expect(kept[0].prompt).toBe("she turns");
    expect(kept[0].durationSec).toBe(4);
    expect(kept[0].gens).toHaveLength(1);
    expect(kept[1].prompt).toBe("");
    const same = deriveTweenBlocks(["a", "b", "c"], prev);
    expect(same[0].prompt).toBe("she turns");
    expect(same[0].durationSec).toBe(4);
    expect(same[0].gens).toHaveLength(1);
    expect(same[1].prompt).toBe("he waves");
  });

  it("caps the timeline at 15s total", () => {
    const blocks = deriveTweenBlocks(["a", "b", "c", "d", "e", "f", "g", "h", "i"], []);
    expect(blocks).toHaveLength(8);
    expect(blocks.slice(0, 7).every((b) => b.durationSec === 2)).toBe(true);
    expect(blocks[7].durationSec).toBe(1);
    const total = blocks[blocks.length - 1].startSec + blocks[blocks.length - 1].durationSec;
    expect(total).toBe(15);
  });

  it("client mirror agrees with the canonical derivation", () => {
    const prev = [block({ startRefId: "a", endRefId: "b", prompt: "p", durationSec: 4 })];
    expect(deriveTweenBlocksClient(["a", "b", "c"], prev)).toEqual(deriveTweenBlocks(["a", "b", "c"], prev));
  });
});

describe("applyKeyframeDrag", () => {
  it("drags the second (last) keyframe with only two images", () => {
    const base = deriveTweenBlocks(["a", "b"], []);
    const moved = applyKeyframeDrag(base, 1, 7);
    expect(moved).toHaveLength(1);
    expect(moved[0].durationSec).toBe(7);
    expect(moved[0].startSec).toBe(0);
  });

  it("pins the first keyframe at 0s", () => {
    const base = deriveTweenBlocks(["a", "b"], []);
    expect(applyKeyframeDrag(base, 0, 9)).toEqual(base);
  });

  it("reshapes both neighbors of a middle keyframe", () => {
    const base = deriveTweenBlocks(["a", "b", "c"], []);
    // Keyframes at 0/2/4: dragging the middle to 3 keeps 1s from the next.
    const moved = applyKeyframeDrag(base, 1, 3);
    expect(moved[0].durationSec).toBe(3);
    expect(moved[1].startSec).toBe(3);
    expect(moved[1].durationSec).toBe(1);
    // Dragging past the neighbor clamps to a 1s gap, never through it.
    const clamped = applyKeyframeDrag(base, 1, 9);
    expect(clamped[0].durationSec).toBe(3);
    expect(clamped[1].durationSec).toBe(1);
  });

  it("enforces the 1s min gap and the 15s cap", () => {
    const base = deriveTweenBlocks(["a", "b", "c"], []);
    const squashed = applyKeyframeDrag(base, 1, 0);
    expect(squashed[0].durationSec).toBe(1);
    const far = applyKeyframeDrag(base, 2, 99);
    expect(far[1].startSec + far[1].durationSec).toBe(15);
  });
});

describe("filterTweenModels", () => {
  const models = [
    { id: "tween-pro", displayName: "Tween Pro", description: "", imageInput: false, videoInput: true, cost: null },
    { id: "plain-vid", displayName: "Plain Vid", description: "", imageInput: false, videoInput: true, cost: null },
  ];

  it("keeps the full list only while the probe is pending", () => {
    expect(filterTweenModels(models, null)).toEqual(models);
    expect(filterTweenModels(models, undefined)).toEqual(models);
  });

  it("limits strictly to proven end-frame models", () => {
    expect(filterTweenModels(models, ["tween-pro"])).toEqual([models[0]]);
  });

  it("an empty probe resolves to an empty list (no unproven fallback)", () => {
    expect(filterTweenModels(models, [])).toEqual([]);
  });

  it("a saved non-end-frame selection is dropped", () => {
    expect(filterTweenModels(models, ["ghost"])).toEqual([]);
    expect(filterTweenModels(models, ["ghost", "plain-vid"])).toEqual([models[1]]);
  });
});

describe("tween block history", () => {
  it("records newest-first and selects the newest", () => {
    const b = block();
    recordTweenBlockGen(b, "videos/1.mp4", "p1", "m");
    recordTweenBlockGen(b, "videos/2.mp4", "p2", "m");
    expect(b.gens!.map((g) => g.path)).toEqual(["videos/2.mp4", "videos/1.mp4"]);
    expect(b.genIndex).toBe(0);
  });

  it("selects only blocks with a resolvable clip", () => {
    const blocks = [
      block({ id: "tw0", gens: [{ path: "videos/1.mp4", prompt: "", model: "", at: "" }], genIndex: 0 }),
      block({ id: "tw1", gens: [], genIndex: undefined }),
      block({ id: "tw2", gens: [{ path: "videos/3.mp4", prompt: "", model: "", at: "" }], genIndex: 5 }),
    ];
    expect(tweenSelectedClips(blocks).map((c) => c.blockId)).toEqual(["tw0"]);
  });

  it("builds a quoted concat list (apostrophes escaped)", () => {
    const list = buildTweenConcatList(["/a/b.mp4", "/c/o'clock.mp4"]);
    expect(list).toBe("file '/a/b.mp4'\nfile '/c/o'\\''clock.mp4'\n");
  });
});

describe("tween pipe authority", () => {
  it("re-derives videoPath from the stitched output and backfills artwork", () => {
    const s = shot({
      graphOutputSource: "tween",
      graphTweenOutput: "videos/tween.mp4",
      videoPath: "videos/stale.mp4",
      graphImageGens: [{ path: "boards/1.jpg", prompt: "", model: "", at: "" }],
      graphImageGenIndex: 0,
    });
    expect(syncBoardOutputToPipe(s)).toBe(true);
    expect(s.videoPath).toBe("videos/tween.mp4");
    expect(s.artwork).toBe("boards/1.jpg");
  });

  it("blanks the clip when the stitch is gone", () => {
    const s = shot({ graphOutputSource: "tween", videoPath: "videos/tween.mp4" });
    expect(syncBoardOutputToPipe(s)).toBe(true);
    expect(s.videoPath).toBeUndefined();
  });
});

describe("syncTweenBlocks", () => {
  function prodWithRefs(): Production {
    return {
      meta: { id: "p", name: "P", folder: "/tmp", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
      currentStep: 3,
      visualStyle: "",
      styles: [],
      scenes: [],
      characters: [],
      products: [],
      references: [
        { id: "a", name: "A", imagePath: "references/a.jpg" },
        { id: "b", name: "B", imagePath: "references/b.jpg" },
        { id: "c", name: "C", imagePath: "references/c.jpg" },
      ],
      status: {},
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    };
  }

  it("is a no-op for shots without tween state (keeps load clean)", () => {
    const p = prodWithRefs();
    const s = shot();
    expect(syncTweenBlocks(p, s)).toBe(false);
    expect(s.graphTweenRefIds).toBeUndefined();
  });

  it("prunes dead keyframes and re-derives", () => {
    const p = prodWithRefs();
    // References resolve via imagePath on disk — only a/b exist as files.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-tween-"));
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    fs.writeFileSync(path.join(dir, "references", "a.jpg"), "x");
    fs.writeFileSync(path.join(dir, "references", "b.jpg"), "x");
    (p.meta as { folder: string }).folder = dir;
    // "c" has no file on disk → pruned; "gone" was deleted → pruned.
    const s = shot({ graphTweenRefIds: ["a", "gone", "b", "c"], graphTweenBlocks: [block({ startRefId: "a", endRefId: "gone", prompt: "keep?" })] });
    syncTweenBlocks(p, s);
    expect(s.graphTweenRefIds).toEqual(["a", "b"]);
    expect(s.graphTweenBlocks).toHaveLength(1);
    expect(s.graphTweenBlocks![0].prompt).toBe("");
  });

  it("keeps generation-node keyframes even before they produce output", () => {
    const p = prodWithRefs();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-tween-gen-"));
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    fs.writeFileSync(path.join(dir, "references", "a.jpg"), "x");
    fs.writeFileSync(path.join(dir, "references", "b.jpg"), "x");
    (p.meta as { folder: string }).folder = dir;
    // The image/edit sentinels have no generations yet — a pre-generation wire
    // must survive (it resolves later, and generate reports a clear error if not).
    const s = shot({
      graphTweenRefIds: ["a", TWEEN_KEY_IMGGEN, "b", TWEEN_KEY_EDITGEN, "gone"],
      graphTweenBlocks: [],
    });
    syncTweenBlocks(p, s);
    expect(s.graphTweenRefIds).toEqual(["a", TWEEN_KEY_IMGGEN, "b", TWEEN_KEY_EDITGEN]);
  });

  it("dedupes repeated keyframe ids (duplicate pairs would share one history)", () => {
    const p = prodWithRefs();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-tween-dedupe-"));
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    fs.writeFileSync(path.join(dir, "references", "a.jpg"), "x");
    fs.writeFileSync(path.join(dir, "references", "b.jpg"), "x");
    (p.meta as { folder: string }).folder = dir;
    const s = shot({ graphTweenRefIds: ["a", "b", "a", "b"], graphTweenBlocks: [] });
    syncTweenBlocks(p, s);
    expect(s.graphTweenRefIds).toEqual(["a", "b"]);
    expect(s.graphTweenBlocks).toHaveLength(1);
  });
});

describe("tween duration support", () => {
  it("treats unknown options as compatible (never ghosts or warns)", () => {
    expect(tweenSupportsDuration(null, 2)).toBe(true);
    expect(tweenSupportsDuration(undefined, 2)).toBe(true);
    expect(tweenSupportsDuration({ resolutions: [], durations: [] }, 2)).toBe(true);
  });

  it("matches the block length against the model's accepted lengths", () => {
    const seedance = { resolutions: ["720p"], durations: [4, 5, 6, 7, 8] };
    expect(tweenSupportsDuration(seedance, 2)).toBe(false);
    expect(tweenSupportsDuration(seedance, 4)).toBe(true);
    expect(tweenSupportsDuration({ resolutions: [], durations: [4, 8] }, 5)).toBe(false);
  });

  it("restricts Wan-style models (5/10/15/20s only) from 2s blocks", () => {
    const wan = { resolutions: ["480p", "720p", "1080p"], durations: [5, 10, 15, 20] };
    expect(tweenSupportsDuration(wan, 2)).toBe(false);
    expect(tweenSupportsDuration(wan, 4)).toBe(false);
    expect(tweenSupportsDuration(wan, 5)).toBe(true);
    expect(tweenSupportsDuration(wan, 10)).toBe(true);
    expect(tweenSupportsDuration(wan, 15)).toBe(true);
    expect(tweenSupportsDuration(wan, 20)).toBe(true);
  });

  it("summarizes accepted lengths for tooltips", () => {
    expect(tweenSupportedLabel(undefined)).toBe("");
    expect(tweenSupportedLabel([])).toBe("");
    expect(tweenSupportedLabel([4, 5, 6, 7])).toBe("4–7s");
    expect(tweenSupportedLabel([4, 8])).toBe("4, 8s");
  });
});

describe("tweenPreviewTake", () => {  const take = (path: string) => ({ path, prompt: "", model: "", at: "" });

  it("previews the explicitly selected take", () => {
    const b = block({ gens: [take("videos/new.mp4"), take("videos/old.mp4")], genIndex: 1 });
    expect(tweenPreviewTake(b)?.path).toBe("videos/old.mp4");
  });

  it("shows keyframes when the selection is cleared (the dropdown's Keyframes option)", () => {
    const b = block({ gens: [take("videos/new.mp4")], genIndex: undefined });
    expect(tweenPreviewTake(b)).toBeUndefined();
  });

  it("shows keyframes for a block that never generated", () => {
    expect(tweenPreviewTake(block())).toBeUndefined();
  });

  it("falls back to keyframes for an out-of-range index", () => {
    const b = block({ gens: [take("videos/new.mp4")], genIndex: 4 });
    expect(tweenPreviewTake(b)).toBeUndefined();
  });
});

describe("generation-node keyframes", () => {
  it("isTweenGenKeyframe distinguishes sentinels from reference ids", () => {
    expect(isTweenGenKeyframe(TWEEN_KEY_IMGGEN)).toBe(true);
    expect(isTweenGenKeyframe(TWEEN_KEY_EDITGEN)).toBe(true);
    expect(isTweenGenKeyframe("a")).toBe(false);
    expect(isTweenGenKeyframe("")).toBe(false);
  });

  it("derives blocks across generation-node keyframes like any other source", () => {
    const blocks = deriveTweenBlocks(["a", TWEEN_KEY_IMGGEN, TWEEN_KEY_EDITGEN], []);
    expect(blocks.map((b) => [b.startRefId, b.endRefId])).toEqual([
      ["a", TWEEN_KEY_IMGGEN],
      [TWEEN_KEY_IMGGEN, TWEEN_KEY_EDITGEN],
    ]);
    // The pair-key match also survives re-derivation for sentinel pairs.
    const prev = [block({ startRefId: TWEEN_KEY_IMGGEN, endRefId: TWEEN_KEY_EDITGEN, prompt: "glide", durationSec: 4 })];
    const kept = deriveTweenBlocks(["a", TWEEN_KEY_IMGGEN, TWEEN_KEY_EDITGEN], prev);
    expect(kept[1].prompt).toBe("glide");
    expect(kept[1].durationSec).toBe(4);
  });
});

describe("unstitchTween", () => {
  it("drops the stitched output and unbinds the tween output feed", () => {
    const s = shot({
      graphOutputSource: "tween",
      graphTweenOutput: "videos/tween.mp4",
      graphTweenReencoded: true,
      videoPath: "videos/tween.mp4",
    });
    const { changed, outputRel } = unstitchTween(s);
    expect(changed).toBe(true);
    expect(outputRel).toBe("videos/tween.mp4");
    expect(s.graphTweenOutput).toBeUndefined();
    expect(s.graphTweenReencoded).toBeUndefined();
    expect(s.graphOutputSource).toBeUndefined();
    expect(s.videoPath).toBeUndefined();
  });

  it("removes the clip even when the tween isn't piped to the output", () => {
    const s = shot({ graphTweenOutput: "videos/tween.mp4", graphTweenReencoded: true });
    const { changed, outputRel } = unstitchTween(s);
    expect(changed).toBe(true);
    expect(outputRel).toBe("videos/tween.mp4");
    expect(s.graphTweenOutput).toBeUndefined();
    // The output feed was never bound — it stays untouched.
    expect(s.graphOutputSource).toBeUndefined();
  });

  it("is a no-op when nothing is stitched", () => {
    const s = shot({ graphTweenRefIds: ["a", "b"] });
    expect(unstitchTween(s).changed).toBe(false);
  });

  it("leaves the per-block clips and timeline intact", () => {
    const s = shot({
      graphOutputSource: "tween",
      graphTweenOutput: "videos/tween.mp4",
      graphTweenRefIds: ["a", "b"],
      graphTweenBlocks: [block({ startRefId: "a", endRefId: "b", gens: [{ path: "videos/b0.mp4", prompt: "", model: "", at: "" }], genIndex: 0 })],
    });
    unstitchTween(s);
    expect(s.graphTweenBlocks).toHaveLength(1);
    expect(s.graphTweenBlocks![0].gens![0].path).toBe("videos/b0.mp4");
    expect(s.graphTweenRefIds).toEqual(["a", "b"]);
  });
});

describe("videoRefsAssign end frames", () => {
  const startProps = (extra: Record<string, unknown> = {}) => ({
    startFrame: { type: "object", properties: { type: {}, url: {}, id: {} } },
    ...extra,
  });
  const refs = [
    { type: "image", label: "start", url: "u1", id: "i1" },
    { type: "image", label: "end", url: "u2", id: "i2" },
  ];

  it("fills both object slots when the schema has them", () => {
    const out = videoRefsAssign(refs, {
      ...startProps(),
      endFrame: { type: "object", properties: { type: {}, url: {}, id: {} } },
    }, { frames: true });
    expect(out?.["startFrame"]).toMatchObject({ url: "u1", id: "i1" });
    expect(out?.["endFrame"]).toMatchObject({ url: "u2", id: "i2" });
  });

  it("keeps single-ref behavior identical (no end slot touched)", () => {
    const out = videoRefsAssign([refs[0]], startProps(), { frames: true });
    expect(out).toEqual({ startFrame: { type: "image", url: "u1", id: "i1" } });
  });

  it("merges both frames into the array field when no end slot exists", () => {
    const out = videoRefsAssign(refs, {
      ...startProps(),
      visualReferences: { type: "array", items: {} },
    }, { frames: true });
    expect(out?.["startFrame"]).toMatchObject({ url: "u1" });
    expect(out?.["visualReferences"]).toHaveLength(2);
  });

  it("falls back to the array field alone when no object slots exist", () => {
    const out = videoRefsAssign(refs, { visualReferences: { type: "array", items: {} } });
    expect(out).toEqual({ visualReferences: refs });
  });

  it("never sets an end frame outside in-betweener mode", () => {
    const out = videoRefsAssign(refs, {
      ...startProps(),
      endFrame: { type: "object", properties: { type: {}, url: {}, id: {} } },
      visualReferences: { type: "array", items: {} },
    });
    // startFrame carries the source frame; the second ref must not become an
    // end keyframe — it and the frame ride visualReferences.
    expect(out?.["endFrame"]).toBeUndefined();
    expect(out?.["startFrame"]).toMatchObject({ url: "u1" });
    expect(out?.["visualReferences"]).toEqual(refs);
  });
});

describe("assembly tween expansion", () => {
  it("uses TW reels for block sub-events", () => {
    expect(edlReelFor("0100")).toBe("SHOT0100");
    expect(edlReelFor("0100a")).toBe("TW0100A");
    expect(edlReelFor("0100b")).toBe("TW0100B");
  });

  it("lays original block clips back-to-back, never the stitched preview", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-tween-asm-"));
    const videos = path.join(dir, "videos");
    fs.mkdirSync(videos, { recursive: true });
    fs.writeFileSync(path.join(videos, "b0.mp4"), "clip0");
    fs.writeFileSync(path.join(videos, "b1.mp4"), "clip1");
    fs.writeFileSync(path.join(videos, "stitched.mp4"), "stitched");
    const p: Production = {
      meta: { id: "p", name: "P", folder: dir, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
      currentStep: 5,
      visualStyle: "",
      styles: [],
      scenes: [{
        number: 1,
        title: "S",
        shots: [shot({
          number: "0100",
          durationSec: 9,
          videoPath: "videos/stitched.mp4",
          graphOutputSource: "tween",
          graphTweenOutput: "videos/stitched.mp4",
          graphTweenRefIds: ["a", "b", "c"],
          graphTweenBlocks: [
            block({ id: "tw0", startRefId: "a", endRefId: "b", startSec: 0, durationSec: 2, gens: [{ path: "videos/b0.mp4", prompt: "", model: "", at: "" }], genIndex: 0 }),
            block({ id: "tw1", startRefId: "b", endRefId: "c", startSec: 2, durationSec: 4, gens: [{ path: "videos/b1.mp4", prompt: "", model: "", at: "" }], genIndex: 0 }),
          ],
        })],
      }],
      characters: [],
      products: [],
      status: {},
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    };
    const plan = assemblyPlan(p);
    expect(plan.events.map((e) => [e.number, e.kind, e.durationSec])).toEqual([
      ["0100a", "clip", 2],
      ["0100b", "clip", 4],
    ]);
    expect(plan.totalSec).toBe(6);
    // The stitched preview is NOT gathered; only the original block clips are.
    expect(plan.media.map((m) => m.srcRel).sort()).toEqual(["videos/b0.mp4", "videos/b1.mp4"]);
    const edl = buildEdl(plan, 24, "T");
    expect(edl).toContain("TW0100A");
    expect(edl).toContain("TW0100B");
    expect(edl).not.toContain("stitched");
  });

  it("falls back to the single-clip path when blocks are unready", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-tween-asm2-"));
    const videos = path.join(dir, "videos");
    fs.mkdirSync(videos, { recursive: true });
    fs.writeFileSync(path.join(videos, "stitched.mp4"), "stitched");
    const p: Production = {
      meta: { id: "p", name: "P", folder: dir, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
      currentStep: 5,
      visualStyle: "",
      styles: [],
      scenes: [{
        number: 1,
        title: "S",
        shots: [shot({
          number: "0100",
          videoPath: "videos/stitched.mp4",
          graphOutputSource: "tween",
          graphTweenRefIds: ["a", "b"],
          graphTweenBlocks: [block({ startRefId: "a", endRefId: "b" })],
        })],
      }],
      characters: [],
      products: [],
      status: {},
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    };
    const plan = assemblyPlan(p);
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0].srcRel).toBe("videos/stitched.mp4");
  });
});
