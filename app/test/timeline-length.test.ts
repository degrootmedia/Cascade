/**
 * Timeline length field (Animatic batch, Item 3): explicit total
 * length as mm:ss. Longer pads empty tail space; shorter clamps to
 * the last clip's end without touching clips; invalid text is null
 * so the field reverts.
 */
import { describe, it, expect } from "vitest";
import {
  formatTimelineLength,
  normalizeTimeline,
  parseTimelineLength,
  resolveTimeline,
  setTimelineDuration,
  timelineLengthSec,
  type ProductionTimeline,
} from "../src/shared/ipc.js";

function tl(): ProductionTimeline {
  return {
    version: 1,
    tracks: [{ id: "v1", kind: "video", name: "V1" }],
    clips: [
      { id: "c1", trackId: "v1", sourceKind: "video", srcRel: "a.mp4", sourceInSec: 0, sourceOutSec: 41, timelineStartSec: 0 },
    ],
  };
}

describe("formatTimelineLength / parseTimelineLength", () => {
  it("formats zero-padded mm:ss, rounding to whole seconds", () => {
    expect(formatTimelineLength(0)).toBe("00:00");
    expect(formatTimelineLength(40.9)).toBe("00:41");
    expect(formatTimelineLength(60)).toBe("01:00");
    expect(formatTimelineLength(600)).toBe("10:00");
    expect(formatTimelineLength(3661)).toBe("61:01");
  });

  it("parses mm:ss and plain seconds; rejects everything else", () => {
    expect(parseTimelineLength("01:00")).toBe(60);
    expect(parseTimelineLength("0:41")).toBe(41);
    expect(parseTimelineLength("00:20")).toBe(20);
    expect(parseTimelineLength(" 2:5 ")).toBe(125);
    expect(parseTimelineLength("90")).toBe(90);
    expect(parseTimelineLength("")).toBeNull();
    expect(parseTimelineLength("abc")).toBeNull();
    expect(parseTimelineLength("1:60")).toBeNull();
    expect(parseTimelineLength("1:2:3")).toBeNull();
    expect(parseTimelineLength("-5")).toBeNull();
    expect(parseTimelineLength(":30")).toBeNull();
  });
});

describe("setTimelineDuration", () => {
  it("longer pads the tail with empty space; clips untouched", () => {
    const t = tl();
    const next = setTimelineDuration(t, 60);
    expect(next.durationSec).toBe(60);
    expect(next.clips).toEqual(t.clips);
    expect(timelineLengthSec(next)).toBe(60);
    // Resolution: total reaches 60 and the span tiling tiles the
    // empty tail with a blank span (preview slate / render black).
    const r = resolveTimeline(next);
    expect(r.totalSec).toBe(60);
    expect(r.videoSpans[r.videoSpans.length - 1]).toMatchObject({ clip: null, startSec: 41, endSec: 60 });
  });

  it("shorter clamps to the last clip's end; no clips lost", () => {
    const padded = setTimelineDuration(tl(), 60);
    const next = setTimelineDuration(padded, 20);
    expect(next.durationSec).toBeUndefined();
    expect(next.clips).toEqual(padded.clips);
    expect(timelineLengthSec(next)).toBe(41);
    expect(resolveTimeline(next).totalSec).toBe(41);
  });

  it("clips growing past the explicit length take over (no truncation)", () => {
    const t = setTimelineDuration(tl(), 60);
    const grown: ProductionTimeline = {
      ...t,
      clips: [...t.clips, { id: "c2", trackId: "v1", sourceKind: "video", srcRel: "b.mp4", sourceInSec: 0, sourceOutSec: 30, timelineStartSec: 41 }],
    };
    expect(timelineLengthSec(grown)).toBe(71);
    expect(resolveTimeline(grown).totalSec).toBe(71);
  });

  it("no-op values return the input; normalize round-trips the field", () => {
    const t = tl();
    expect(setTimelineDuration(t, 41)).toBe(t);
    expect(setTimelineDuration(t, Number.NaN)).toBe(t);
    const withLen = setTimelineDuration(t, 60);
    expect(normalizeTimeline(JSON.parse(JSON.stringify(withLen)))!.durationSec).toBe(60);
    // Non-positive / junk stored values are dropped by normalize.
    expect(normalizeTimeline({ ...tl(), durationSec: -3 })!.durationSec).toBeUndefined();
    expect(normalizeTimeline({ ...tl(), durationSec: "x" })!.durationSec).toBeUndefined();
  });
});
