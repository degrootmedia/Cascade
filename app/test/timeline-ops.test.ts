/**
 * Timeline edit-operation tests — Animatic Editor Expansion Item A2.
 *
 * Split, trim, slip, roll, slide, ripple (trim/delete, all-track and
 * per-track), multi-clip move/delete, and linked clips — all pure
 * functions on the ProductionTimeline model. Every result must satisfy
 * the model invariants (`validateTimeline`): no overlaps, no negative
 * durations, no source range outside its source (where known). Locked
 * tracks refuse. Each op returns a fresh timeline (one undo step) and
 * never mutates its input.
 */
import { describe, it, expect } from "vitest";
import type { ProductionTimeline, TimelineClip, TimelineTrack } from "../src/shared/ipc.js";
import {
  clipDurationSec,
  clipEndSec,
  deleteClips,
  linkClips,
  linkedClipIds,
  moveClipsBy,
  normalizeTimeline,
  rollEdit,
  slideClip,
  slipClip,
  splitAtPlayhead,
  splitClipAt,
  trimClip,
  unlinkClips,
  validateTimeline,
} from "../src/shared/ipc.js";

let n = 0;
const newId = (prefix: string): string => `${prefix}-${++n}`;

function vTrack(id: string, over: Partial<TimelineTrack> = {}): TimelineTrack {
  return { id, kind: "video", name: id.toUpperCase(), ...over };
}
function aTrack(id: string, over: Partial<TimelineTrack> = {}): TimelineTrack {
  return { id, kind: "audio", name: id.toUpperCase(), ...over };
}
/** A video clip with an explicit source range. */
function vClip(
  id: string,
  trackId: string,
  startSec: number,
  inSec: number,
  outSec: number,
  over: Partial<TimelineClip> = {}
): TimelineClip {
  return {
    id,
    trackId,
    sourceKind: "video",
    srcRel: `clips/${id}.mp4`,
    sourceInSec: inSec,
    sourceOutSec: outSec,
    timelineStartSec: startSec,
    ...over,
  };
}
function aClip(id: string, trackId: string, startSec: number, inSec: number, outSec: number, over: Partial<TimelineClip> = {}): TimelineClip {
  return { ...vClip(id, trackId, startSec, inSec, outSec, over), sourceKind: "audio", srcRel: `audio/${id}.mp3` };
}
function stillClip(id: string, trackId: string, startSec: number, holdSec: number): TimelineClip {
  return { id, trackId, sourceKind: "still", srcRel: `stills/${id}.jpg`, holdSec, timelineStartSec: startSec };
}

/** V1: a[0..4] b[4..9] c[11..14] (gap 9..11); A1: x[0..14]. Sources 20s. */
function base(): ProductionTimeline {
  return {
    version: 1,
    tracks: [vTrack("v1"), aTrack("a1")],
    clips: [
      vClip("a", "v1", 0, 2, 6),
      vClip("b", "v1", 4, 0, 5),
      vClip("c", "v1", 11, 1, 4),
      aClip("x", "a1", 0, 0, 14),
    ],
  };
}
const SRC20 = { "clips/a.mp4": 20, "clips/b.mp4": 20, "clips/c.mp4": 20, "audio/x.mp3": 20, "clips/v.mp4": 20, "audio/au.mp3": 20 };
const byId = (t: ProductionTimeline, id: string): TimelineClip => t.clips.find((c) => c.id === id)!;
const valid = (t: ProductionTimeline | null): ProductionTimeline => {
  expect(t).not.toBeNull();
  expect(validateTimeline(t!)).toEqual([]);
  return t!;
};

// ---- split ---------------------------------------------------------------------

describe("splitClipAt", () => {
  it("covers the same total range with no gap or overlap", () => {
    n = 0;
    const t = valid(splitClipAt(base(), "b", 6, newId));
    const left = byId(t, "b");
    const right = t.clips.find((c) => c.trackId === "v1" && c.timelineStartSec === 6)!;
    expect([left.sourceInSec, left.sourceOutSec]).toEqual([0, 2]);
    expect([right.sourceInSec, right.sourceOutSec, clipEndSec(right)]).toEqual([2, 5, 9]);
    expect(right.id).not.toBe("b");
  });

  it("refuses splits on the edge, outside, and on locked tracks", () => {
    expect(splitClipAt(base(), "b", 4, newId)).toBeNull();
    expect(splitClipAt(base(), "b", 9, newId)).toBeNull();
    expect(splitClipAt(base(), "b", 99, newId)).toBeNull();
    const locked = base();
    locked.tracks[0].locked = true;
    expect(splitClipAt(locked, "b", 6, newId)).toBeNull();
  });

  it("splits a held still by its hold", () => {
    const t0: ProductionTimeline = { version: 1, tracks: [vTrack("v1")], clips: [stillClip("s", "v1", 2, 6)] };
    const t = valid(splitClipAt(t0, "s", 5, newId));
    expect(t.clips.map((c) => clipDurationSec(c)).sort()).toEqual([3, 3]);
  });

  it("splits linked partners together and re-links the right halves", () => {
    n = 0;
    const t0: ProductionTimeline = {
      version: 1,
      tracks: [vTrack("v1"), aTrack("a1")],
      clips: [vClip("v", "v1", 0, 0, 10, { linkId: "L1" }), aClip("au", "a1", 0, 0, 10, { linkId: "L1" })],
    };
    const t = valid(splitClipAt(t0, "v", 4, newId));
    expect(t.clips).toHaveLength(4);
    const rights = t.clips.filter((c) => c.timelineStartSec === 4);
    expect(rights.map((c) => c.trackId).sort()).toEqual(["a1", "v1"]);
    expect(rights[0].linkId).toBeTruthy();
    expect(rights[0].linkId).toBe(rights[1].linkId);
    expect(rights[0].linkId).not.toBe("L1");
    expect(byId(t, "v").linkId).toBe("L1");
    // Unlinked split touches only the named clip.
    const solo = valid(splitClipAt(t0, "v", 4, newId, { includeLinked: false }));
    expect(solo.clips).toHaveLength(3);
  });

  it("splitAtPlayhead cuts every unlocked track at the point", () => {
    const t = valid(splitAtPlayhead(base(), 6, newId));
    // b and x both contain 6.
    expect(t.clips).toHaveLength(6);
    const locked = base();
    locked.tracks[1].locked = true;
    const t2 = valid(splitAtPlayhead(locked, 6, newId));
    expect(t2.clips).toHaveLength(5); // only b split
  });
});

// ---- trim ----------------------------------------------------------------------

describe("trimClip", () => {
  it("tail trim clamps at the next clip and at the source end", () => {
    // b ends at 9, c starts 11: at most +2 by the neighbor.
    const t = valid(trimClip(base(), "b", "tail", 10, { sourceDurationsSec: SRC20 }));
    expect(clipEndSec(byId(t, "b"))).toBe(11);
    // a has b adjacent: no room at all.
    const t2 = valid(trimClip(base(), "a", "tail", 3, { sourceDurationsSec: SRC20 }));
    expect(clipDurationSec(byId(t2, "a"))).toBe(4);
    // c can extend only to its source end (20 - out 4 = +16).
    const t3 = valid(trimClip(base(), "c", "tail", 100, { sourceDurationsSec: SRC20 }));
    expect(byId(t3, "c").sourceOutSec).toBe(20);
    // Shortening stops above zero duration.
    const t4 = valid(trimClip(base(), "b", "tail", -100, { sourceDurationsSec: SRC20 }));
    expect(clipDurationSec(byId(t4, "b"))).toBeGreaterThan(0);
  });

  it("head trim anchors the end (non-ripple) and clamps at source start", () => {
    // c: start 11, in=1, previous ends 9 — extending recovers at most 1s.
    const t = valid(trimClip(base(), "c", "head", 10, { sourceDurationsSec: SRC20 }));
    expect([byId(t, "c").sourceInSec, byId(t, "c").timelineStartSec, clipEndSec(byId(t, "c"))]).toEqual([0, 10, 14]);
    // a sits at timeline 0: its head cannot extend at all.
    const tA = valid(trimClip(base(), "a", "head", 10, { sourceDurationsSec: SRC20 }));
    expect([byId(tA, "a").sourceInSec, byId(tA, "a").timelineStartSec]).toEqual([2, 0]);
    // Shortening from the head moves the start later, end fixed.
    const t2 = valid(trimClip(base(), "b", "head", -2, { sourceDurationsSec: SRC20 }));
    expect([byId(t2, "b").timelineStartSec, byId(t2, "b").sourceInSec, clipEndSec(byId(t2, "b"))]).toEqual([6, 2, 9]);
  });

  it("ripple tail trim (all tracks) shifts every later clip by the delta", () => {
    // Shorten a by 2s with ripple: b, c, and x's tail content shift -2
    // (x spans the boundary from 0, so it does not move — it starts at 0).
    const t = valid(trimClip(base(), "a", "tail", -2, { ripple: "all", sourceDurationsSec: SRC20 }));
    expect(byId(t, "b").timelineStartSec).toBe(2);
    expect(byId(t, "c").timelineStartSec).toBe(9);
    expect(byId(t, "x").timelineStartSec).toBe(0);
    // Audio/video sync: a clip that started at b's start still does.
    const t0 = base();
    t0.tracks.push(aTrack("a2"));
    t0.clips.push(aClip("y", "a2", 4, 0, 3));
    const t2 = valid(trimClip(t0, "a", "tail", -2, { ripple: "all", sourceDurationsSec: SRC20 }));
    expect(byId(t2, "y").timelineStartSec).toBe(2);
    expect(byId(t2, "y").timelineStartSec).toBe(byId(t2, "b").timelineStartSec);
  });

  it("ripple scoped to one track leaves other tracks alone", () => {
    const t0 = base();
    t0.tracks.push(aTrack("a2"));
    t0.clips.push(aClip("y", "a2", 4, 0, 3));
    const t = valid(trimClip(t0, "a", "tail", -2, { ripple: "track", sourceDurationsSec: SRC20 }));
    expect(byId(t, "b").timelineStartSec).toBe(2);
    expect(byId(t, "y").timelineStartSec).toBe(4);
  });

  it("ripple head trim anchors the start and shifts the suffix", () => {
    // Shorten b from the head by 2 with ripple: b stays at 4, its source
    // opens 2 later, and c pulls 2 earlier.
    const t = valid(trimClip(base(), "b", "head", -2, { ripple: "all", sourceDurationsSec: SRC20 }));
    expect([byId(t, "b").timelineStartSec, byId(t, "b").sourceInSec, clipDurationSec(byId(t, "b"))]).toEqual([4, 2, 3]);
    expect(byId(t, "c").timelineStartSec).toBe(9);
  });

  it("locked tracks refuse trims", () => {
    const locked = base();
    locked.tracks[0].locked = true;
    expect(trimClip(locked, "b", "tail", 1, { sourceDurationsSec: SRC20 })).toBeNull();
  });
});

// ---- slip ----------------------------------------------------------------------

describe("slipClip", () => {
  it("slip by +1s changes source in/out by exactly +1 and nothing else", () => {
    const t0 = base();
    const t = valid(slipClip(t0, "b", 1, { sourceDurationsSec: SRC20 }));
    expect([byId(t, "b").sourceInSec, byId(t, "b").sourceOutSec]).toEqual([1, 6]);
    expect(byId(t, "b").timelineStartSec).toBe(4);
    expect(clipDurationSec(byId(t, "b"))).toBe(5);
    expect(byId(t0, "b").sourceInSec).toBe(0); // input untouched
  });

  it("slip stops at the source's first and last frames", () => {
    const lo = valid(slipClip(base(), "a", -10, { sourceDurationsSec: SRC20 }));
    expect(byId(lo, "a").sourceInSec).toBe(0);
    const hi = valid(slipClip(base(), "a", 100, { sourceDurationsSec: SRC20 }));
    expect(byId(hi, "a").sourceOutSec).toBe(20);
    // Unknown source length: unbounded above, still floored at 0.
    const unk = valid(slipClip(base(), "a", 100, {}));
    expect(byId(unk, "a").sourceInSec).toBe(102);
  });

  it("stills and blanks cannot slip", () => {
    const t0: ProductionTimeline = { version: 1, tracks: [vTrack("v1")], clips: [stillClip("s", "v1", 0, 5)] };
    expect(slipClip(t0, "s", 1, {})).toBeNull();
  });
});

// ---- roll ----------------------------------------------------------------------

describe("rollEdit", () => {
  it("conserves total duration to the frame across the boundary", () => {
    const t = valid(rollEdit(base(), "a", 1.5, { sourceDurationsSec: SRC20 }));
    expect(clipDurationSec(byId(t, "a")) + clipDurationSec(byId(t, "b"))).toBe(9);
    expect([byId(t, "b").timelineStartSec, byId(t, "b").sourceInSec]).toEqual([5.5, 1.5]);
    expect(clipEndSec(byId(t, "b"))).toBe(9);
  });

  it("clamps by both sources' limits and refuses a gapped boundary", () => {
    // Rolling left: b's head can only extend to its source start (in=0).
    const t = valid(rollEdit(base(), "a", -5, { sourceDurationsSec: SRC20 }));
    expect(byId(t, "b").sourceInSec).toBe(0);
    expect(clipDurationSec(byId(t, "a"))).toBe(4);
    // b..c have a gap (9..11): not a rollable boundary.
    expect(rollEdit(base(), "b", 1, { sourceDurationsSec: SRC20 })).toBeNull();
    // a can extend only to its source end.
    const t2 = valid(rollEdit(base(), "a", 100, { sourceDurationsSec: { "clips/a.mp4": 7, "clips/b.mp4": 20 } }));
    expect(byId(t2, "a").sourceOutSec).toBe(7);
  });
});

// ---- slide ---------------------------------------------------------------------

describe("slideClip", () => {
  it("moves the clip while neighbors absorb; its own range is unchanged", () => {
    const t = valid(slideClip(base(), "b", 1, { sourceDurationsSec: SRC20 }));
    const b = byId(t, "b");
    expect([b.timelineStartSec, b.sourceInSec, b.sourceOutSec]).toEqual([5, 0, 5]);
    expect(clipDurationSec(byId(t, "a"))).toBe(5); // prev stretched +1
    // Next (c at 11) had a 2s gap: the move consumed gap, c untouched.
    expect(byId(t, "c").timelineStartSec).toBe(11);
    expect(clipEndSec(b)).toBe(10);
  });

  it("slides earlier by shrinking the previous clip's tail", () => {
    const t = valid(slideClip(base(), "b", -2, { sourceDurationsSec: SRC20 }));
    expect(byId(t, "b").timelineStartSec).toBe(2);
    expect(clipDurationSec(byId(t, "a"))).toBe(2);
    expect(byId(t, "a").sourceOutSec).toBe(4);
  });

  it("absorbs into the next clip once the gap is consumed", () => {
    // b +2.5: 2s of gap after b, then 0.5s eaten from c's head.
    const t = valid(slideClip(base(), "b", 2.5, { sourceDurationsSec: SRC20 }));
    expect([byId(t, "b").timelineStartSec, clipEndSec(byId(t, "b"))]).toEqual([6.5, 11.5]);
    expect([byId(t, "c").timelineStartSec, byId(t, "c").sourceInSec]).toEqual([11.5, 1.5]);
    expect(byId(t, "a").sourceOutSec).toBe(8.5); // prev stretched the full 2.5
  });

  it("clamps when the previous clip has no more source to stretch into", () => {
    const t = valid(slideClip(base(), "b", 10, { sourceDurationsSec: { "clips/a.mp4": 6.5, "clips/b.mp4": 20, "clips/c.mp4": 20 } }));
    // a's out is 6 of 6.5: only +0.5 of stretch, and b is adjacent to a.
    expect(byId(t, "b").timelineStartSec).toBe(4.5);
    expect(byId(t, "a").sourceOutSec).toBe(6.5);
  });
});

// ---- move / delete ---------------------------------------------------------------

describe("moveClipsBy and deleteClips", () => {
  it("moves a selection and clamps at unselected clips", () => {
    const t = valid(moveClipsBy(base(), ["c"], -10));
    expect(byId(t, "c").timelineStartSec).toBe(9); // stops at b's end
    const t2 = valid(moveClipsBy(base(), ["a", "b"], 1));
    expect(byId(t2, "b").timelineStartSec).toBe(5);
  });

  it("delete leaves a gap; ripple delete closes it on the scoped tracks", () => {
    const plain = valid(deleteClips(base(), ["b"]));
    expect(plain.clips.map((c) => c.id)).toEqual(["a", "c", "x"]);
    expect(byId(plain, "c").timelineStartSec).toBe(11);

    const t0 = base();
    t0.tracks.push(aTrack("a2"));
    t0.clips.push(aClip("y", "a2", 9, 0, 2));
    const rip = valid(deleteClips(t0, ["b"], { ripple: "all" }));
    expect(byId(rip, "c").timelineStartSec).toBe(6); // 11 - 5
    expect(byId(rip, "y").timelineStartSec).toBe(4); // 9 - 5, sync kept
    const ripTrack = valid(deleteClips(t0, ["b"], { ripple: "track" }));
    expect(byId(ripTrack, "c").timelineStartSec).toBe(6);
    expect(byId(ripTrack, "y").timelineStartSec).toBe(9);
  });

  it("deleting one linked partner deletes both by default", () => {
    const t0: ProductionTimeline = {
      version: 1,
      tracks: [vTrack("v1"), aTrack("a1")],
      clips: [vClip("v", "v1", 0, 0, 10, { linkId: "L1" }), aClip("au", "a1", 0, 0, 10, { linkId: "L1" })],
    };
    expect(valid(deleteClips(t0, ["v"])).clips).toHaveLength(0);
    const solo = valid(deleteClips(t0, ["v"], { includeLinked: false }));
    expect(solo.clips).toHaveLength(1);
    expect(solo.clips[0].linkId).toBeUndefined(); // singleton link pruned
  });

  it("locked tracks refuse delete and move", () => {
    const locked = base();
    locked.tracks[0].locked = true;
    expect(deleteClips(locked, ["b"])).toBeNull();
    expect(moveClipsBy(locked, ["c"], -1)).toBeNull();
  });
});

// ---- linking ---------------------------------------------------------------------

describe("linkClips / unlinkClips", () => {
  const pair = (): ProductionTimeline => ({
    version: 1,
    tracks: [vTrack("v1"), aTrack("a1")],
    clips: [vClip("v", "v1", 0, 0, 10), aClip("au", "a1", 0, 0, 10)],
  });

  it("links, reports partners, and unlinks cleanly", () => {
    n = 0;
    const t = valid(linkClips(pair(), ["v", "au"], newId));
    expect(byId(t, "v").linkId).toBe(byId(t, "au").linkId);
    expect(linkedClipIds(t, "v").sort()).toEqual(["au", "v"]);
    const un = valid(unlinkClips(t, ["v"]));
    expect(byId(un, "v").linkId).toBeUndefined();
    expect(byId(un, "au").linkId).toBeUndefined(); // singleton pruned
    expect(linkClips(pair(), ["v"], newId)).toBeNull(); // a group needs 2+
  });

  it("normalize keeps link groups of 2+ and strips singletons", () => {
    const raw = pair();
    raw.clips[0].linkId = "L1";
    const lone = normalizeTimeline(raw)!;
    expect(lone.clips[0].linkId).toBeUndefined();
    raw.clips[1].linkId = "L1";
    const both = normalizeTimeline(raw)!;
    expect(both.clips.map((c) => c.linkId)).toEqual(["L1", "L1"]);
  });

  it("a linked trim moves both partners by the same delta", () => {
    const t0 = pair();
    t0.clips.forEach((c) => (c.linkId = "L1"));
    const t = valid(trimClip(t0, "v", "tail", -3, { sourceDurationsSec: SRC20 }));
    expect(clipDurationSec(byId(t, "v"))).toBe(7);
    expect(clipDurationSec(byId(t, "au"))).toBe(7);
  });
});
