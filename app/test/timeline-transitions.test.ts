/**
 * Cross-dissolve transition tests — Animatic Editor Expansion Item A8.
 *
 * Transitions are timeline DATA (type/duration/edit point derived from
 * adjacency), CENTERED on the edit point (adopted convention): the
 * blend window is [edit − d/2, edit + d/2], fed by the incoming clip's
 * pre-in handle and the outgoing clip's post-out handle. Setting one
 * refuses when handles are (known to be) insufficient; removing one
 * restores a clean cut with zero duration change. The assembly plan
 * merges the two half-window events into one blend event the render
 * xfades; plans without transitions stay byte-identical.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production, ProductionTimeline, TimelineClip } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  clipSourceTimeAtLoose,
  maxDissolveSec,
  normalizeTimeline,
  resolveTimeline,
  setClipTransition,
  splitClipAt,
  transitionFor,
  trimClip,
  validateTimeline,
} from "../src/shared/ipc.js";
import { assemblyPlanFromTimeline, buildEdl, buildXfadeArgs } from "../src/main/assembly.js";

let n = 0;
const newId = (p: string): string => `${p}${++n}`;

/** Two adjacent 4s video clips: a = [2..6] of an 8s source at 0,
 *  b = [3..7] of an 8s source at 4. Handles: a tail 2s, b head 3s. */
const pair = (): ProductionTimeline => ({
  version: 1,
  tracks: [{ id: "v1", kind: "video", name: "V1" }],
  clips: [
    { id: "a", trackId: "v1", sourceKind: "video", srcRel: "a.mp4", sourceInSec: 2, sourceOutSec: 6, timelineStartSec: 0 },
    { id: "b", trackId: "v1", sourceKind: "video", srcRel: "b.mp4", sourceInSec: 3, sourceOutSec: 7, timelineStartSec: 4 },
  ],
});
const durs = { sourceDurationsSec: { "a.mp4": 8, "b.mp4": 8 } };

describe("setClipTransition / maxDissolveSec", () => {
  it("max is bounded by handles and clip lengths", () => {
    // a tail handle 2s, b head handle 3s, clips 4s each → d/2 ≤ 2.
    expect(maxDissolveSec(pair(), "a", durs)).toBeCloseTo(4, 9);
    // Unknown source lengths: tail unbounded, head handle known (3s in).
    expect(maxDissolveSec(pair(), "a", {})).toBeCloseTo(6, 9);
    expect(maxDissolveSec(pair(), "b", durs)).toBe(0); // no successor
  });

  it("sets a centered dissolve as sparse timeline data; total duration unchanged", () => {
    const t1 = setClipTransition(pair(), "a", 1, newId, durs)!;
    expect(t1.transitions).toHaveLength(1);
    expect(t1.transitions![0]).toMatchObject({ type: "dissolve", outgoingClipId: "a", incomingClipId: "b", durationSec: 1 });
    expect(transitionFor(t1, "a")!.durationSec).toBe(1);
    expect(resolveTimeline(t1).totalSec).toBe(8);
    expect(validateTimeline(t1)).toEqual([]);
  });

  it("removing restores the exact pre-transition timeline", () => {
    const t0 = pair();
    const t1 = setClipTransition(t0, "a", 2, newId, durs)!;
    const t2 = setClipTransition(t1, "a", null, newId, durs)!;
    expect(t2).toEqual(t0);
    expect(setClipTransition(t0, "a", null, newId, durs)).toBeNull(); // nothing to remove
  });

  it("refuses when the incoming head handle is too short", () => {
    const t = pair();
    t.clips[1] = { ...t.clips[1], sourceInSec: 0.2, sourceOutSec: 4.2 };
    expect(maxDissolveSec(t, "a", durs)).toBeCloseTo(0.4, 9);
    expect(setClipTransition(t, "a", 1, newId, durs)).toBeNull();
    expect(setClipTransition(t, "a", 0.4, newId, durs)).not.toBeNull();
  });

  it("refuses when the outgoing tail handle is known-short; stills have infinite handles", () => {
    const short = { sourceDurationsSec: { "a.mp4": 6.2, "b.mp4": 8 } };
    expect(maxDissolveSec(pair(), "a", short)).toBeCloseTo(0.4, 9);
    expect(setClipTransition(pair(), "a", 1, newId, short)).toBeNull();
    const stillPair: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        { id: "s", trackId: "v1", sourceKind: "still", srcRel: "s.jpg", holdSec: 3, timelineStartSec: 0 },
        { id: "b", trackId: "v1", sourceKind: "video", srcRel: "b.mp4", sourceInSec: 1, sourceOutSec: 5, timelineStartSec: 3 },
      ],
    };
    expect(maxDissolveSec(stillPair, "s", {})).toBeCloseTo(2, 9); // b head 1s → d ≤ 2
  });

  it("refuses non-adjacent, locked, and overlapping-neighbor cases", () => {
    const gapped = pair();
    gapped.clips[1] = { ...gapped.clips[1], timelineStartSec: 5 };
    expect(setClipTransition(gapped, "a", 1, newId, durs)).toBeNull();
    const locked = pair();
    locked.tracks[0] = { ...locked.tracks[0], locked: true };
    expect(setClipTransition(locked, "a", 1, newId, durs)).toBeNull();
    // A third clip with its own dissolve eating b's tail limits b's head room.
    const trio = pair();
    trio.clips.push({ id: "c", trackId: "v1", sourceKind: "video", srcRel: "b.mp4", sourceInSec: 3, sourceOutSec: 7, timelineStartSec: 8 });
    const longDurs = { sourceDurationsSec: { "a.mp4": 8, "b.mp4": 30 } };
    const withTail = setClipTransition(trio, "b", 4, newId, longDurs)!; // eats 2s of b's tail
    expect(maxDissolveSec(withTail, "a", longDurs)).toBeCloseTo(4, 9); // b: head room 4-2=2 → d≤4
  });

  it("sped clips measure handles in timeline seconds", () => {
    const t = pair();
    t.clips[1] = { ...t.clips[1], speed: 2, sourceOutSec: 11, timelineStartSec: 4 }; // (11-3)/2 = 4s dur
    // b head handle: 3 source sec at 2x = 1.5 timeline sec → d ≤ 3.
    expect(maxDissolveSec(t, "a", { sourceDurationsSec: { "a.mp4": 8, "b.mp4": 20 } })).toBeCloseTo(3, 9);
  });
});

describe("normalize / validate / edit integrity", () => {
  it("normalize drops transitions that no longer join adjacent clips", () => {
    const raw = pair() as unknown as Record<string, unknown>;
    raw.transitions = [
      { id: "x1", type: "dissolve", outgoingClipId: "a", incomingClipId: "b", durationSec: 1 },
      { id: "x2", type: "dissolve", outgoingClipId: "b", incomingClipId: "a", durationSec: 1 },
      { id: "x3", type: "wipe", outgoingClipId: "a", incomingClipId: "b", durationSec: 1 },
    ];
    const t = normalizeTimeline(raw)!;
    expect(t.transitions).toHaveLength(1);
    expect(t.transitions![0].id).toBe("x1");
  });

  it("validate flags a transition over non-adjacent clips", () => {
    const t = pair();
    t.transitions = [{ id: "x", type: "dissolve", outgoingClipId: "b", incomingClipId: "a", durationSec: 1 }];
    expect(validateTimeline(t).join(" ")).toMatch(/transition/i);
  });

  it("split remaps the outgoing side; trimming the join away prunes the transition", () => {
    const t1 = setClipTransition(pair(), "a", 1, newId, durs)!;
    const t2 = splitClipAt(t1, "a", 2, newId)!;
    const rightHalf = t2.clips.find((c) => c.timelineStartSec === 2 && c.trackId === "v1")!;
    expect(t2.transitions).toHaveLength(1);
    expect(t2.transitions![0].outgoingClipId).toBe(rightHalf.id);
    // Shrink b from the head (negative head delta) → gap at the old join.
    const t3 = trimClip(t2, "b", "head", -1, durs);
    expect(t3).not.toBeNull();
    expect(t3!.transitions ?? []).toHaveLength(0);
  });
});

describe("resolver + loose source mapping", () => {
  it("blendSpans centers on the edit point; loose mapping walks the handles", () => {
    const t = setClipTransition(pair(), "a", 2, newId, durs)!;
    const r = resolveTimeline(t);
    expect(r.blendSpans).toHaveLength(1);
    expect(r.blendSpans[0]).toMatchObject({ editSec: 4, startSec: 3, endSec: 5 });
    const b = t.clips.find((c) => c.id === "b")!;
    // 1s before b's start: source 1s before its in-point (3 → 2).
    expect(clipSourceTimeAtLoose(b, -1)).toBeCloseTo(2, 9);
    const a = t.clips.find((c) => c.id === "a")!;
    // 1s past a's end: source 1s past its out-point (6 → 7).
    expect(clipSourceTimeAtLoose(a, 5)).toBeCloseTo(7, 9);
  });

  it("a covered edit yields no blend span (data retained)", () => {
    const t = setClipTransition(pair(), "a", 2, newId, durs)!;
    t.tracks.unshift({ id: "v2", kind: "video", name: "V2" });
    t.clips.push({ id: "top", trackId: "v2", sourceKind: "still", srcRel: "t.jpg", holdSec: 8, timelineStartSec: 0 });
    const r = resolveTimeline(t);
    expect(r.blendSpans).toHaveLength(0);
    expect(t.transitions).toHaveLength(1);
  });
});

describe("assembly plan + render args", () => {
  const prodOf = (timeline: ProductionTimeline): Production =>
    ({
      meta: { id: "p8", name: "A8", folder: "/tmp", createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
      currentStep: 4, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
      timeline,
      assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    }) as unknown as Production;

  it("without transitions the plan is untouched (two plain events)", () => {
    const plan = assemblyPlanFromTimeline(prodOf(pair()));
    expect(plan.events).toHaveLength(2);
    expect(plan.events.every((e) => !e.blendWith)).toBe(true);
    expect(plan.totalSec).toBe(8);
  });

  it("a dissolve merges the half-window events into one blend event with extended windows", () => {
    const t = setClipTransition(pair(), "a", 2, newId, durs)!;
    const plan = assemblyPlanFromTimeline(prodOf(t));
    // a-pre [0..3], blend [3..5], b-post [5..8]
    expect(plan.events.map((e) => [e.startSec, e.endSec])).toEqual([[0, 3], [3, 5], [5, 8]]);
    const blend = plan.events[1];
    expect(blend.durationSec).toBe(2);
    expect(blend.srcRel).toBe("a.mp4");
    expect(blend.offsetSec ?? 0).toBeCloseTo(5, 9); // a source at timeline 3 = 2 + 3
    expect(blend.blendWith).toBeDefined();
    expect(blend.blendWith!.srcRel).toBe("b.mp4");
    expect(blend.blendWith!.durationSec).toBe(2);
    // b window starts 1s of handle before its in-point: 3 - 1 = 2.
    expect(blend.blendWith!.offsetSec ?? 0).toBeCloseTo(2, 9);
    expect(plan.totalSec).toBe(8);
  });

  it("xfade args blend two uniform segments over the full window", () => {
    const args = buildXfadeArgs("/a.mov", "/b.mov", 2, 24, "/out.mov");
    const joined = args.join(" ");
    expect(joined).toContain("xfade=transition=fade:duration=2:offset=0");
    expect(joined).toContain("acrossfade=d=2");
    expect(joined).toContain("-frames:v 48");
  });

  it("the EDL states the dissolve instead of dropping it", () => {
    const t = setClipTransition(pair(), "a", 1, newId, durs)!;
    const edl = buildEdl(assemblyPlanFromTimeline(prodOf(t)), 24, "T");
    expect(edl).toMatch(/\bD\s+0?24\b/);
  });
});
