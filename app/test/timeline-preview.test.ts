/**
 * Timeline preview mapping tests — Animatic Editor Expansion Item A6.
 *
 * buildTimelineOverride turns resolved spans into preview items:
 * proxies preferred for playback, sourceAt honoring speed/reverse via
 * the shared timing code, stills and gaps as slate items. Every
 * audible audio-track clip becomes an audioItem for track playback.
 */
import { describe, it, expect } from "vitest";
import type { ProductionTimeline } from "../src/shared/ipc.js";
import {
  blendUnderShouldSeek, buildTimelineOverride, EMPTY_LOOP_REGION,
  loopSpan, loopWrapAt, withLoopPoint,
} from "../src/renderer/src/components/production/timeline-preview.js";

const timeline: ProductionTimeline = {
  version: 1,
  tracks: [
    { id: "v2", kind: "video", name: "V2" },
    { id: "v1", kind: "video", name: "V1" },
    { id: "a1", kind: "audio", name: "Voiceover" },
    { id: "a2", kind: "audio", name: "Music" },
  ],
  clips: [
    { id: "base", trackId: "v1", sourceKind: "video", srcRel: "clips/base.mp4", sourceInSec: 2, sourceOutSec: 12, timelineStartSec: 0, speed: 2 },
    { id: "top", trackId: "v2", sourceKind: "video", srcRel: "clips/top.mp4", sourceInSec: 0, sourceOutSec: 4, timelineStartSec: 1, reversed: true },
    { id: "still", trackId: "v1", sourceKind: "still", srcRel: "stills/s.jpg", holdSec: 2, timelineStartSec: 6 },
    { id: "vo", trackId: "a1", sourceKind: "audio", srcRel: "vo.mp3", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0, role: "voiceover", volume: 0.8 },
    { id: "mu", trackId: "a2", sourceKind: "audio", srcRel: "mu.mp3", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0, role: "music", volume: 0.4 },
  ],
};

describe("buildTimelineOverride", () => {
  it("flattens topmost-wins spans and prefers ready proxies", () => {
    const o = buildTimelineOverride(timeline, [], { "clips/base.mp4": "out/proxies/base-x.mp4" }, new Map());
    // base runs 0..5 at 2x (10s source); top covers 1..5 reversed; still 6..8; gap 5..6.
    const paths = o.items.map((i) => i.videoPath ?? i.artwork ?? "blank");
    expect(paths).toEqual(["out/proxies/base-x.mp4", "clips/top.mp4", "blank", "stills/s.jpg"]);
    expect(o.items.map((i) => i.durationSec)).toEqual([1, 4, 1, 2]);
  });

  it("sourceAt maps through speed and reverse exactly", () => {
    const o = buildTimelineOverride(timeline, [], {}, new Map());
    const baseItem = o.items[0];
    // base: in=2 at 2x: local 0.5 → source 3.
    expect(o.sourceAt.get(baseItem.id)!(0.5)).toBeCloseTo(3, 9);
    const topItem = o.items[1];
    // top reversed over [0,4]: local 0 → 4, local 4 → 0.
    expect(o.sourceAt.get(topItem.id)!(0)).toBe(4);
    expect(o.sourceAt.get(topItem.id)!(4)).toBe(0);
    expect(o.sourceAt.get(topItem.id)!(1)).toBe(3);
  });

  it("uses shot numbers for labels when provenance exists", () => {
    const t2: ProductionTimeline = {
      ...timeline,
      clips: timeline.clips.map((c) => (c.id === "base" ? { ...c, shotId: "s1" } : c)),
    };
    const o = buildTimelineOverride(t2, [], {}, new Map([["s1", "0100"]]));
    expect(o.items[0].number).toBe("0100");
  });
});

describe("audio preview gain (Item 7)", () => {
  it("override gainAt folds clip volume, fades, and track volume", () => {
    const t: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1", volume: 0.5 }],
      clips: [
        { id: "c", trackId: "v1", sourceKind: "video", srcRel: "c.mp4", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0, volume: 0.8, fadeInSec: 2, fadeOutSec: 2 },
      ],
    };
    const o = buildTimelineOverride(t, [], {}, new Map());
    const g = o.gainAt.get(o.items[0].id)!;
    expect(g(0)).toBe(0);
    expect(g(1)).toBeCloseTo(0.2, 9); // 0.8 × 0.5 × ½ fade-in
    expect(g(4)).toBeCloseTo(0.4, 9);
    expect(g(7)).toBeCloseTo(0.2, 9);
    expect(g(8)).toBe(0);
  });

  it("audio items carry fades + track volume; gainAt follows the drawn curve", () => {
    const t: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "a1", kind: "audio", name: "VO", volume: 0.5 }],
      clips: [
        { id: "vo", trackId: "a1", sourceKind: "audio", srcRel: "vo.mp3", sourceInSec: 0, sourceOutSec: 10, timelineStartSec: 2, volume: 0.8, fadeOutSec: 2 },
      ],
    };
    const item = buildTimelineOverride(t, [], {}, new Map()).audioItems[0];
    expect(item).toMatchObject({ id: "vo", rel: "vo.mp3", startSec: 2, durationSec: 10 });
    expect(item.gainAt(4)).toBeCloseTo(0.4, 9); // 0.8 clip x 0.5 track
    expect(item.gainAt(9)).toBeCloseTo(0.2, 9); // halfway down the 2s fade
    expect(item.gainAt(10)).toBe(0); // clip end: silence
    expect(item.sourceAt(3)).toBeCloseTo(3, 9);
    expect(item.rateAt(3)).toBeCloseTo(1, 6);
  });
});

describe("dissolve preview (Item 8)", () => {
  it("merges the blend window into one item with the outgoing side underneath", () => {
    const t: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        { id: "a", trackId: "v1", sourceKind: "video", srcRel: "a.mp4", sourceInSec: 2, sourceOutSec: 6, timelineStartSec: 0 },
        { id: "b", trackId: "v1", sourceKind: "video", srcRel: "b.mp4", sourceInSec: 3, sourceOutSec: 7, timelineStartSec: 4 },
      ],
      transitions: [{ id: "t1", type: "dissolve", outgoingClipId: "a", incomingClipId: "b", durationSec: 2 }],
    };
    const o = buildTimelineOverride(t, [], {}, new Map());
    expect(o.items.map((i) => i.durationSec)).toEqual([3, 2, 3]);
    const blendItem = o.items[1];
    expect(blendItem.videoPath).toBe("b.mp4");
    // Incoming plays its head handle first: local 0 = source 2 (in 3, 1s early).
    expect(o.sourceAt.get(blendItem.id)!(0)).toBeCloseTo(2, 9);
    expect(o.sourceAt.get(blendItem.id)!(2)).toBeCloseTo(4, 9);
    const under = o.blendFrom.get(blendItem.id)!;
    expect(under.videoPath).toBe("a.mp4");
    // Outgoing keeps playing into its tail handle: local 2 = source 7 (out 6 + 1).
    expect(under.sourceAt(0)).toBeCloseTo(5, 9);
    expect(under.sourceAt(2)).toBeCloseTo(7, 9);
    expect(under.gainAt(0)).toBeCloseTo(1, 9);
    expect(under.gainAt(2)).toBeCloseTo(0, 9);
  });

  it("still-to-still dissolves blend too, not cut (regression: dip/mismatch)", () => {
    const t: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        { id: "a", trackId: "v1", sourceKind: "still", srcRel: "a.jpg", holdSec: 4, timelineStartSec: 0 },
        { id: "b", trackId: "v1", sourceKind: "still", srcRel: "b.jpg", holdSec: 4, timelineStartSec: 4 },
      ],
      transitions: [{ id: "t1", type: "dissolve", outgoingClipId: "a", incomingClipId: "b", durationSec: 2 }],
    };
    const o = buildTimelineOverride(t, [], {}, new Map());
    expect(o.items.map((i) => i.durationSec)).toEqual([3, 2, 3]);
    const blendItem = o.items[1];
    expect(blendItem.artwork).toBe("b.jpg");
    const under = o.blendFrom.get(blendItem.id)!;
    expect(under.stillPath).toBe("a.jpg");
    expect(under.videoPath).toBeUndefined();
  });

  it("video-to-still dissolves keep the outgoing video underneath", () => {
    const t: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        { id: "a", trackId: "v1", sourceKind: "video", srcRel: "a.mp4", sourceInSec: 2, sourceOutSec: 6, timelineStartSec: 0 },
        { id: "b", trackId: "v1", sourceKind: "still", srcRel: "b.jpg", holdSec: 4, timelineStartSec: 4 },
      ],
      transitions: [{ id: "t1", type: "dissolve", outgoingClipId: "a", incomingClipId: "b", durationSec: 2 }],
    };
    const o = buildTimelineOverride(t, [], {}, new Map());
    expect(o.items.map((i) => i.durationSec)).toEqual([3, 2, 3]);
    const blendItem = o.items[1];
    expect(blendItem.artwork).toBe("b.jpg");
    const under = o.blendFrom.get(blendItem.id)!;
    expect(under.videoPath).toBe("a.mp4");
    expect(under.sourceAt(0)).toBeCloseTo(5, 9);
    expect(under.sourceAt(2)).toBeCloseTo(7, 9);
  });
});

describe("blend under-layer seek policy (dip-to-black regression)", () => {
  // While playing, seeking the under-layer every frame starves its
  // decoder and it paints black — the dissolve must free-run and
  // only correct real drift. Paused, the frame pins exactly.
  it("pins when paused, drift-corrects only when playing", () => {
    expect(blendUnderShouldSeek(false, 1.00, 1.01)).toBe(true);
    expect(blendUnderShouldSeek(true, 1.00, 1.01)).toBe(false);
    expect(blendUnderShouldSeek(true, 1.00, 1.39)).toBe(false);
    expect(blendUnderShouldSeek(true, 1.00, 1.41)).toBe(true);
    expect(blendUnderShouldSeek(true, 1.00, 0.50)).toBe(true);
  });
});

describe("loop region helpers (Item 4)", () => {
  const region = { inSec: 5, outSec: 10, enabled: true };

  it("span needs both points in order; points set/clear independently", () => {
    expect(loopSpan(EMPTY_LOOP_REGION)).toBeNull();
    expect(loopSpan(withLoopPoint(EMPTY_LOOP_REGION, "in", 5))).toBeNull();
    const both = withLoopPoint(withLoopPoint(EMPTY_LOOP_REGION, "in", 5), "out", 10);
    expect(loopSpan(both)).toEqual({ startSec: 5, endSec: 10 });
    expect(loopSpan(withLoopPoint(both, "in", null))).toBeNull();
    // Out before In is not a region (points kept, nothing loops).
    expect(loopSpan({ inSec: 10, outSec: 5, enabled: true })).toBeNull();
  });

  it("wraps only when enabled, with a region, at/after Out", () => {
    expect(loopWrapAt(region, 4)).toBeNull(); // before the region: play in
    expect(loopWrapAt(region, 9.99)).toBeNull();
    expect(loopWrapAt(region, 10)).toBe(5);
    expect(loopWrapAt(region, 12)).toBe(5);
    expect(loopWrapAt({ ...region, enabled: false }, 12)).toBeNull();
    expect(loopWrapAt(EMPTY_LOOP_REGION, 12)).toBeNull();
  });
});

describe("audio items (all audio lives on tracks)", () => {
  it("carries every audible audio clip, role or not, with its mapping", () => {
    const o = buildTimelineOverride(timeline, [], {}, new Map());
    expect(o.audioItems.map((a) => a.id).sort()).toEqual(["mu", "vo"]);
    const vo = o.audioItems.find((a) => a.id === "vo")!;
    const mu = o.audioItems.find((a) => a.id === "mu")!;
    expect(vo).toMatchObject({ rel: "vo.mp3", startSec: 0, durationSec: 8 });
    expect(vo.gainAt(2)).toBeCloseTo(0.8, 9);
    expect(mu.gainAt(2)).toBeCloseTo(0.4, 9);
    expect(vo.sourceAt(2)).toBeCloseTo(2, 9);
  });

  it("track volume scales preview gain; track Mute removes the clips entirely", () => {
    const t: ProductionTimeline = {
      version: 1,
      tracks: [
        { id: "a1", kind: "audio", name: "A1", volume: 0.5 },
        { id: "a2", kind: "audio", name: "A2", volume: 0.9, muted: true },
      ],
      clips: [
        { id: "x", trackId: "a1", sourceKind: "audio", srcRel: "x.mp3", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0, volume: 0.8 },
        { id: "y", trackId: "a2", sourceKind: "audio", srcRel: "y.mp3", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0 },
      ],
    };
    const o = buildTimelineOverride(t, [], {}, new Map());
    // Muted track: silent regardless of its slider (no item at all).
    expect(o.audioItems.map((a) => a.id)).toEqual(["x"]);
    // 0.8 clip x 0.5 track.
    expect(o.audioItems[0].gainAt(2)).toBeCloseTo(0.4, 9);
    // Slider at zero: gain 0 (audible silence, item still tracked).
    const zeroed = buildTimelineOverride({ ...t, tracks: [{ id: "a1", kind: "audio", name: "A1", volume: 0 }] }, [], {}, new Map());
    expect(zeroed.audioItems[0].gainAt(2)).toBe(0);
  });

  it("rateAt follows a speed ramp so preview playback accelerates", () => {
    const t: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "a1", kind: "audio", name: "A1" }],
      clips: [
        {
          id: "r", trackId: "a1", sourceKind: "audio", srcRel: "r.mp3",
          sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0,
          speedCurve: [{ atSec: 0, speed: 1 }, { atSec: 8, speed: 2 }],
        },
      ],
    };
    const item = buildTimelineOverride(t, [], {}, new Map()).audioItems[0];
    // Sampled just inside the ends (the +-1-frame derivative is
    // one-sided exactly at the boundaries).
    expect(item.rateAt(0.25)).toBeCloseTo(1, 1);
    // Raw (unfitted) curve: duration solves to ~5.86s where speed is ~1.73x.
    expect(item.rateAt(item.durationSec - 0.25)).toBeCloseTo(1.7, 1);
    expect(item.rateAt(item.durationSec / 2)).toBeGreaterThan(item.rateAt(0.25));
    expect(item.rateAt(item.durationSec / 2)).toBeLessThan(item.rateAt(item.durationSec - 0.25));
  });
});
