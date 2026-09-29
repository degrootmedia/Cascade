/**
 * Shot Sequence pure span math (Spec 06): timeline projection, persisted-state
 * repair (including the legacy flat model folding into `graph`), accent
 * cycling, the output-binding resolution, and the storyboard bar's row-span
 * math. Shared by the renderer (animatic projection, bar overlay) and main
 * (prune/merge), so every branch is exercised here.
 */
import { describe, it, expect } from "vitest";
import {
  SEQUENCE_ACCENT_COLORS,
  applyShotSequences,
  createShotSequence,
  defaultSequenceAccent,
  nextSequenceName,
  normalizeSequenceAccent,
  normalizeShotSequences,
  normalizeSequenceSegments,
  seedSequenceSegments,
  sequenceSegmentLine,
  sequenceTotalDuration,
  stripSequenceFrameTags,
  parseSequenceTimelineId,
  recordSequenceVideoGen,
  sequenceAccentHex,
  sequenceBarSpans,
  sequenceGraphShot,
  sanitizeVideoOffset,
  sequenceOutputMedia,
  sequenceOverlapReason,
  sequenceSelectedTake,
  sequenceTimelineId,
  sequenceVideoPath,
} from "../src/shared/ipc.js";
import type { ProductionShot, ShotSequence, SequenceShotView } from "../src/shared/ipc.js";

function shot(id: string, number: string, extra: Partial<SequenceShotView> = {}): SequenceShotView {
  return { id, number, ...extra };
}

function seq(id: string, shotIds: string[], extra: Partial<ShotSequence> = {}): ShotSequence {
  return { id, name: `Sequence ${id}`, shotIds, ...extra };
}

/** A sequence with graph state (the canvas's storage) patched in. */
function gseq(id: string, shotIds: string[], graph: Partial<ProductionShot>, extra: Partial<ShotSequence> = {}): ShotSequence {
  const base = seq(id, shotIds, extra);
  return { ...base, graph: { id, number: base.name, audio: "", visual: "", ...graph } };
}

describe("sequenceGraphShot", () => {
  it("builds the shot-shaped facade the node graph renders", () => {
    const s = gseq("s1", ["a"], { prompt: "hello", graphVideoNodes: [{ id: "vid0", prompt: "@[Shot 0100]" }] });
    expect(sequenceGraphShot(s)).toMatchObject({ id: "s1", number: "Sequence s1", audio: "", visual: "", prompt: "hello" });
    // Without stored graph state the facade is still a valid shot.
    expect(sequenceGraphShot(seq("s2", ["a"]))).toMatchObject({ id: "s2", number: "Sequence s2" });
  });
});

describe("applyShotSequences", () => {
  const shots = [
    shot("a", "0100", { durationSec: 2 }),
    shot("b", "0200", { durationSec: 4 }),
    shot("c", "0300", { durationSec: 3 }),
    shot("d", "0400"),
    shot("e", "0500"),
  ];

  it("collapses a contiguous member run into one item at the run's first slot", () => {
    const out = applyShotSequences(shots, [seq("s1", ["b", "c"])]);
    expect(out.map((i) => i.id)).toEqual(["a", "seq:s1", "d", "e"]);
    const block = out[1];
    expect(block.kind).toBe("sequence");
    expect(block.sequenceId).toBe("s1");
    expect(block.shotIds).toEqual(["b", "c"]);
    expect(block.number).toBe("Sequence s1");
  });

  it("sums member durations, or uses the sequence's own override", () => {
    const summed = applyShotSequences(shots, [seq("s1", ["b", "c"])]);
    expect(summed[1].durationSec).toBe(7); // 4 + 3
    const overridden = applyShotSequences(shots, [seq("s1", ["b", "c"], { durationSec: 12 })]);
    expect(overridden[1].durationSec).toBe(12);
    const broken = applyShotSequences(shots, [seq("s1", ["b", "c"], { durationSec: 0 })]);
    expect(broken[1].durationSec).toBe(7);
  });

  it("projects the output node's binding: clip, held still, or slate", () => {
    // Unbound: a pure slate block over the span.
    const slate = applyShotSequences(shots, [seq("s1", ["a", "b"])]);
    expect(slate[0].kind).toBe("sequence");
    expect(slate[0].videoPath).toBeUndefined();
    expect(slate[0].artwork).toBeUndefined();
    // Bound to a video node's take: the clip plays, the first member is the poster.
    const video = gseq("s1", ["b", "c"], { graphVideoNodes: [{ id: "vid0", prompt: "", gens: [{ path: "out/sequences/s1/clip.mp4", prompt: "", model: "", at: "" }] }], graphOutputSource: "videogen" });
    const withArt = [shots[0], { ...shots[1], artwork: "boards/0200.jpg" }, shots[2], shots[3], shots[4]];
    const clipped = applyShotSequences(withArt, [video]);
    expect(clipped[1].videoPath).toBe("out/sequences/s1/clip.mp4");
    expect(clipped[1].artwork).toBe("boards/0200.jpg");
    // Bound to a held still (a member frame cited as a reference node).
    const held = gseq("s1", ["a", "b"], { graphOutputSource: "ref", graphOutputRefId: "seqframe:a" });
    const heldArt = [{ ...withArt[0], artwork: "boards/0100.jpg" }, withArt[1], withArt[2], withArt[3], withArt[4]];
    const still = applyShotSequences(heldArt, [held]);
    expect(still[0].artwork).toBe("boards/0100.jpg");
    expect(still[0].videoPath).toBeUndefined();
  });

  it("passes members through individually when disabled", () => {
    const out = applyShotSequences(shots, [seq("s1", ["b", "c"], { enabled: false })]);
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(out.every((i) => i.kind === "shot")).toBe(true);
  });

  it("keeps shots individually when the span is no longer contiguous", () => {
    const out = applyShotSequences(shots, [seq("s1", ["b", "d"])]);
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("skips sequences whose members were consumed by an earlier sequence", () => {
    const out = applyShotSequences(shots, [seq("s1", ["b", "c"]), seq("s2", ["c", "d"])]);
    expect(out.map((i) => i.id)).toEqual(["a", "seq:s1", "d", "e"]);
  });

  it("ignores members that no longer exist and drops fully-dead sequences", () => {
    const out = applyShotSequences(shots, [seq("s2", ["gone"])]);
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c", "d", "e"]);
    const single = applyShotSequences(shots, [seq("s1", ["c", "gone"])]);
    expect(single.map((i) => i.id)).toEqual(["a", "b", "seq:s1", "d", "e"]);
    expect(single[2].shotIds).toEqual(["c"]);
  });

  it("carries mute state onto the block", () => {
    const out = applyShotSequences(shots, [seq("s1", ["a", "b"], { muted: true })]);
    expect(out[0].muted).toBe(true);
  });

  it("drops disabled shots from the projection entirely", () => {
    const withDisabled = [
      shots[0],
      { ...shots[1], disabled: true },
      shots[2],
      shots[3],
      shots[4],
    ];
    const out = applyShotSequences(withDisabled, []);
    expect(out.map((i) => i.id)).toEqual(["a", "c", "d", "e"]);
  });

  it("prunes disabled members from a sequence, like dead members", () => {
    const withDisabled = [
      shots[0],
      { ...shots[1], disabled: true },
      shots[2],
      shots[3],
      shots[4],
    ];
    // b is gone from the live list, so the sequence collapses over its
    // surviving member c (the same rule as pruned dead members).
    const out = applyShotSequences(withDisabled, [seq("s1", ["b", "c"])]);
    expect(out.map((i) => i.id)).toEqual(["a", "seq:s1", "d", "e"]);
    expect(out[1].shotIds).toEqual(["c"]);
  });

  it("collapses a sequence over the live list when members stay contiguous", () => {
    const withDisabled = [
      shots[0],
      shots[1],
      shots[2],
      { ...shots[3], disabled: true },
      shots[4],
    ];
    const out = applyShotSequences(withDisabled, [seq("s1", ["a", "b"])]);
    expect(out.map((i) => i.id)).toEqual(["seq:s1", "c", "e"]);
    expect(out[0].shotIds).toEqual(["a", "b"]);
  });

  it("round-trips the timeline id", () => {
    expect(sequenceTimelineId("s1")).toBe("seq:s1");
    expect(parseSequenceTimelineId("seq:s1")).toBe("s1");
    expect(parseSequenceTimelineId("shot-1")).toBeNull();
  });
});

describe("output binding (the frame output node)", () => {
  const shots = [shot("a", "0100", { artwork: "boards/0100.jpg" }), shot("b", "0200")];
  const refs = [
    { id: "ref-img", imagePath: "references/still.png" },
    { id: "ref-vid", media: "video" as const, mediaPath: "references/clip.mp4" },
    { id: "ref-empty" },
  ];
  const ctx = { shots, refs };

  it("resolves a video-node binding to the node's selected take", () => {
    const s = gseq("s1", ["a", "b"], { graphOutputSource: "videogen", graphOutputVideoNodeId: "vid0" });
    recordSequenceVideoGen(s, "vid0", "v1.mp4", "p", "m");
    recordSequenceVideoGen(s, "vid0", "v2.mp4", "p", "m");
    expect(sequenceOutputMedia(s, ctx)).toEqual({ kind: "video", rel: "v2.mp4" });
    s.graph!.graphVideoNodes![0].genIndex = 1;
    expect(sequenceOutputMedia(s, ctx)).toEqual({ kind: "video", rel: "v1.mp4" });
    expect(sequenceSelectedTake(s)).toBe("v1.mp4");
  });

  it("resolves reference, member-frame, and imagegen bindings to their media", () => {
    const refVideo = gseq("s1", ["a"], { graphOutputSource: "ref", graphOutputRefId: "ref-vid" });
    expect(sequenceOutputMedia(refVideo, ctx)).toEqual({ kind: "video", rel: "references/clip.mp4" });
    const refImage = gseq("s1", ["a"], { graphOutputSource: "ref", graphOutputRefId: "ref-img" });
    expect(sequenceOutputMedia(refImage, ctx)).toEqual({ kind: "image", rel: "references/still.png" });
    const frame = gseq("s1", ["a"], { graphOutputSource: "ref", graphOutputRefId: "seqframe:a" });
    expect(sequenceOutputMedia(frame, ctx)).toEqual({ kind: "image", rel: "boards/0100.jpg" });
    const imagegen = gseq("s1", ["a"], { graphOutputSource: "imagegen", graphImageGens: [{ path: "out/sequences/s1/frame.jpg", prompt: "", model: "", at: "" }] });
    expect(sequenceOutputMedia(imagegen, ctx)).toEqual({ kind: "image", rel: "out/sequences/s1/frame.jpg" });
    const empty = gseq("s1", ["a"], { graphOutputSource: "ref", graphOutputRefId: "ref-empty" });
    expect(sequenceOutputMedia(empty, ctx)).toBeNull();
    expect(sequenceOutputMedia(gseq("s1", ["a"], { graphOutputSource: "ref", graphOutputRefId: "ref-gone" }), ctx)).toBeNull();
    expect(sequenceOutputMedia(gseq("s1", ["a"], { graphOutputSource: "videogen" }), ctx)).toBeNull();
  });

  it("unbound is the slate, while the generated take still exists for the delete flow", () => {
    const s = seq("s1", ["a", "b"]);
    recordSequenceVideoGen(s, "vid0", "v1.mp4", "p", "m");
    s.graph!.graphOutputSource = undefined;
    expect(sequenceOutputMedia(s, ctx)).toBeNull();
    expect(sequenceVideoPath(s, ctx)).toBeUndefined();
    // The delete flow preserves the GENERATED take regardless of the binding.
    expect(sequenceSelectedTake(s)).toBe("v1.mp4");
    expect(sequenceSelectedTake(seq("s2", ["a"]))).toBeUndefined();
  });

  it("sequenceVideoPath reports only video outputs", () => {
    const s = gseq("s1", ["a"], { graphOutputSource: "videogen", graphVideoNodes: [{ id: "vid0", prompt: "", gens: [{ path: "v1.mp4", prompt: "", model: "", at: "" }] }] });
    expect(sequenceVideoPath(s, ctx)).toBe("v1.mp4");
    expect(sequenceVideoPath(gseq("s1", ["a"], { graphOutputSource: "ref", graphOutputRefId: "seqframe:a" }), ctx)).toBeUndefined();
    expect(sequenceVideoPath(gseq("s1", ["a"], { graphOutputSource: "ref", graphOutputRefId: "ref-vid" }), ctx)).toBe("references/clip.mp4");
  });
});

describe("normalizeShotSequences", () => {
  const live = new Set(["a", "b", "c"]);

  it("prunes dead member ids and drops sequences left with none", () => {
    const out = normalizeShotSequences([seq("s1", ["a", "gone", "b"]), seq("s2", ["gone"])], live);
    expect(out.map((s) => s.id)).toEqual(["s1"]);
    expect(out[0].shotIds).toEqual(["a", "b"]);
  });

  it("repairs accents, durations, names, and dedupes ids", () => {
    const out = normalizeShotSequences(
      [
        { id: "s1", name: "  ", shotIds: ["a", "a", "b"], accent: "nope", durationSec: -3 },
        { id: "s1", name: "dupe", shotIds: ["a"] },
      ],
      live
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Sequence");
    expect(out[0].shotIds).toEqual(["a", "b"]);
    expect(out[0].accent).toBe(SEQUENCE_ACCENT_COLORS[0].id);
    expect(out[0].durationSec).toBeUndefined();
  });

  it("keeps a stored graph, pruning its video nodes' wired inputs", () => {
    const liveRefs = new Set(["ref-1"]);
    const out = normalizeShotSequences(
      [{ id: "s1", name: "S", shotIds: ["a"], graph: { graphVideoNodes: [{ id: "vid0", prompt: "@[Shot 0100]", refIds: ["a", "ref-gone"] }] } }],
      live,
      liveRefs
    );
    expect(out[0].graph!.graphVideoNodes![0].refIds).toEqual(["a"]);
    expect(out[0].graph!.id).toBe("s1");
    expect(out[0].graph!.number).toBe("S");
  });

  it("folds the legacy flat model (videoNodes/output/graphLayout) into graph", () => {
    const legacy = normalizeShotSequences(
      [{
        id: "s1", name: "S", shotIds: ["a"],
        videoNodes: [{ id: "vid0", prompt: "", refIds: ["a"], gens: [{ path: "v1.mp4" }] }],
        output: { kind: "videogen", nodeId: "vid0" },
        graphLayout: { positions: { videogen: { x: 1, y: 2 } } },
      }],
      live
    );
    expect(legacy[0].graph!.graphVideoNodes![0].gens).toEqual([{ path: "v1.mp4" }]);
    expect(legacy[0].graph!.graphOutputSource).toBe("videogen");
    expect(legacy[0].graph!.graphOutputVideoNodeId).toBe("vid0");
    expect(legacy[0].graph!.graphLayout).toEqual({ positions: { videogen: { x: 1, y: 2 } } });
    // A legacy "frame" output folds into a member-frame reference binding.
    const frameOut = normalizeShotSequences(
      [{ id: "s2", name: "S", shotIds: ["a"], output: { kind: "frame", shotId: "a" } }],
      live
    );
    expect(frameOut[0].graph!.graphOutputSource).toBe("ref");
    expect(frameOut[0].graph!.graphOutputRefId).toBe("seqframe:a");
    // A legacy reference output keeps its id.
    const refOut = normalizeShotSequences(
      [{ id: "s3", name: "S", shotIds: ["a"], output: { kind: "ref", refId: "r1" } }],
      live
    );
    expect(refOut[0].graph!.graphOutputRefId).toBe("r1");
  });

  it("returns [] for a missing or corrupt array", () => {
    expect(normalizeShotSequences(undefined, live)).toEqual([]);
    expect(normalizeShotSequences("nope", live)).toEqual([]);
    expect(normalizeShotSequences([null, 3, { id: "" }], live)).toEqual([]);
  });
});

describe("accent + naming", () => {
  it("cycles accents across creations", () => {
    expect(defaultSequenceAccent([])).toBe(SEQUENCE_ACCENT_COLORS[0].id);
    expect(defaultSequenceAccent([seq("s1", ["a"])])).toBe(SEQUENCE_ACCENT_COLORS[1].id);
  });

  it("repairs unknown accents and maps them to a hex", () => {
    expect(normalizeSequenceAccent("teal")).toBe("teal");
    expect(normalizeSequenceAccent("nope")).toBe(SEQUENCE_ACCENT_COLORS[0].id);
    expect(sequenceAccentHex("teal")).toBe(SEQUENCE_ACCENT_COLORS.find((c) => c.id === "teal")!.hex);
  });

  it("numbers sequences past collisions", () => {
    expect(nextSequenceName([])).toBe("Sequence 01");
    expect(nextSequenceName([seq("s1", ["a"], { name: "Sequence 01" }), seq("s2", ["a"], { name: "Sequence 03" })])).toBe("Sequence 02");
    expect(nextSequenceName([seq("s1", ["a"], { name: "Custom" })])).toBe("Sequence 01");
  });
});

describe("creation guards", () => {
  it("rejects spans under two frames", () => {
    expect(sequenceOverlapReason([], [])).toMatch(/at least two/i);
    expect(sequenceOverlapReason(["a"], [])).toMatch(/at least two/i);
  });

  it("rejects spans overlapping an existing sequence", () => {
    const reason = sequenceOverlapReason(["a", "b"], [seq("s1", ["b", "c"], { name: "Sequence 01" })]);
    expect(reason).toMatch(/Sequence 01/);
  });

  it("accepts a free span and pre-populates the canvas", () => {
    expect(sequenceOverlapReason(["a", "b"], [seq("s1", ["c"])])).toBeNull();
    const created = createShotSequence(
      "s2",
      [{ shotId: "a", label: "Shot 0100" }, { shotId: "b", label: "Shot 0200" }, { shotId: "a", label: "Shot 0100" }],
      [seq("s1", ["c"], { name: "Sequence 01" })]
    );
    expect(created.name).toBe("Sequence 02");
    expect(created.shotIds).toEqual(["a", "b"]);
    expect(created.enabled).toBe(true);
    expect(created.accent).toBeTruthy();
    // The canvas is the ordinary node graph plus a timed timeline: one segment
    // per member frame (3s each by default) and a pre-loaded video generator
    // node. Unbound until the user pipes an output.
    expect(created.graph!.graphVideoNodes).toEqual([{ id: "vid0", prompt: "" }]);
    expect(created.graph!.graphSequence!.segments).toEqual([
      { shotId: "a", durationSec: 3, prompt: "" },
      { shotId: "b", durationSec: 3, prompt: "" },
    ]);
    expect(created.graph!.graphOutputSource).toBeUndefined();
    expect(sequenceOutputMedia(created, { shots: [] })).toBeNull();
  });
});

describe("sequence timeline (segments)", () => {
  it("clamps each shot's duration to a whole second, min 1", () => {
    const out = normalizeSequenceSegments([
      { shotId: "a", durationSec: 4.4, prompt: "x" },
      { shotId: "b", durationSec: 0, prompt: "" },
      { shotId: "c", durationSec: 12, prompt: "" },
    ]);
    expect(out).toEqual([
      { shotId: "a", durationSec: 4, prompt: "x" },
      { shotId: "b", durationSec: 1, prompt: "" },
      { shotId: "c", durationSec: 12, prompt: "" },
    ]);
  });

  it("migrates a legacy start/end range to a duration and sums the total", () => {
    const out = normalizeSequenceSegments([
      { shotId: "a", startSec: 0, endSec: 5, prompt: "" } as never,
      { shotId: "b", startSec: 5, endSec: 8, prompt: "" } as never,
    ]);
    expect(out).toEqual([
      { shotId: "a", durationSec: 5, prompt: "" },
      { shotId: "b", durationSec: 3, prompt: "" },
    ]);
    expect(sequenceTotalDuration(out)).toBe(8);
    expect(sequenceTotalDuration(seedSequenceSegments([{ shotId: "a" }, { shotId: "b" }, { shotId: "c" }]))).toBe(9);
  });

  it("renders a vendor timeline line and strips legacy frame tags", () => {
    expect(sequenceSegmentLine({ shotId: "a", durationSec: 3, prompt: "pan left" })).toBe("3s: pan left");
    expect(sequenceSegmentLine({ shotId: "a", durationSec: 3, prompt: "  " })).toBe("3s");
    // The multi-shot framing form names the shot + duration + frame token.
    expect(sequenceSegmentLine({ shotId: "a", durationSec: 3, prompt: "wide" }, 2, 4))
      .toBe("Hard Cut to Shot 2. 3 Seconds. Framing Reference <<<image_4>>>\nwide");
    expect(sequenceSegmentLine({ shotId: "a", durationSec: 3, prompt: "" }, 1, 3))
      .toBe("Hard Cut to Shot 1. 3 Seconds. Framing Reference <<<image_3>>>");
    expect(stripSequenceFrameTags("wide @[Shot 0100] then @[Anna]")).toBe("wide  then @[Anna]");
  });
});

describe("normalizeShotSequences timeline migration", () => {
  const live = new Set(["a", "b"]);

  it("seeds a timeline for a legacy sequence and strips frame tags", () => {
    const out = normalizeShotSequences(
      [{ id: "s1", name: "S", shotIds: ["a", "b"], graph: { graphVideoNodes: [{ id: "vid0", prompt: "@[Shot 0100] @[Shot 0200]", gens: [{ path: "v.mp4" }] }] } }],
      live
    );
    expect(out[0].graph!.graphSequence!.segments).toEqual([
      { shotId: "a", durationSec: 3, prompt: "" },
      { shotId: "b", durationSec: 3, prompt: "" },
    ]);
    expect(out[0].graph!.graphVideoNodes![0].prompt).toBe("");
    expect(out[0].graph!.graphVideoNodes![0].gens).toEqual([{ path: "v.mp4" }]);
  });

  it("keeps and repairs a stored timeline, pruning dead members", () => {
    const out = normalizeShotSequences(
      [{ id: "s1", name: "S", shotIds: ["a", "b"], graph: { graphSequence: { segments: [
        { shotId: "a", durationSec: 4, prompt: "one" },
        { shotId: "gone", durationSec: 2, prompt: "" },
        { shotId: "b", durationSec: 5, prompt: "two" },
      ] }, graphVideoNodes: [{ id: "vid0", prompt: "" }] } }],
      live
    );
    expect(out[0].graph!.graphSequence!.segments).toEqual([
      { shotId: "a", durationSec: 4, prompt: "one" },
      { shotId: "b", durationSec: 5, prompt: "two" },
    ]);
  });
});

describe("sequenceBarSpans", () => {
  it("spans one row across the selection's left..right edges", () => {
    const spans = sequenceBarSpans([
      { id: "a", left: 0, top: 0, right: 100, bottom: 80 },
      { id: "b", left: 114, top: 0, right: 214, bottom: 80 },
    ]);
    expect(spans).toEqual([{ left: 0, top: 0, right: 214, bottom: 80 }]);
  });

  it("emits one span per wrapped row, top to bottom", () => {
    const spans = sequenceBarSpans([
      { id: "c", left: 228, top: 94, right: 328, bottom: 174 },
      { id: "a", left: 0, top: 0, right: 100, bottom: 80 },
      { id: "b", left: 114, top: 0, right: 214, bottom: 80 },
    ]);
    expect(spans).toEqual([
      { left: 0, top: 0, right: 214, bottom: 80 },
      { left: 228, top: 94, right: 328, bottom: 174 },
    ]);
  });

  it("ignores degenerate rects", () => {
    expect(sequenceBarSpans([{ id: "a", left: 10, top: 10, right: 10, bottom: 50 }])).toEqual([]);
    expect(sequenceBarSpans([])).toEqual([]);
  });
});

describe("slip offset (Step 4 right-drag)", () => {
  it("sanitizes offsets to the 0.1s grid, dropping absent/unusable ones", () => {
    expect(sanitizeVideoOffset(undefined)).toBeUndefined();
    expect(sanitizeVideoOffset(0)).toBeUndefined();
    expect(sanitizeVideoOffset(-1)).toBeUndefined();
    expect(sanitizeVideoOffset(Number.NaN)).toBeUndefined();
    expect(sanitizeVideoOffset(1.54)).toBe(1.5);
  });

  it("projects a shot's slip offset onto its timeline item", () => {
    const out = applyShotSequences([shot("a", "0100", { durationSec: 2, videoOffsetSec: 1.5 })], []);
    expect(out[0].videoOffsetSec).toBe(1.5);
    const plain = applyShotSequences([shot("a", "0100", { durationSec: 2 })], []);
    expect(plain[0].videoOffsetSec).toBeUndefined();
  });

  it("keeps a repaired sequence slip offset through read repair", () => {
    const live = new Set(["a"]);
    const out = normalizeShotSequences(
      [{ id: "s1", name: "Sequence 01", shotIds: ["a"], videoOffsetSec: 2.34 }],
      live
    );
    expect(out[0].videoOffsetSec).toBe(2.3);
    const dropped = normalizeShotSequences(
      [{ id: "s1", name: "Sequence 01", shotIds: ["a"], videoOffsetSec: -2 }],
      live
    );
    expect(dropped[0].videoOffsetSec).toBeUndefined();
  });
});
