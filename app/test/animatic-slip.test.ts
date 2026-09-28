/**
 * animatic-slip tests — pure slip-edit math for the animatic timeline.
 * No DOM/React: exercises the clamp/drag/playback helpers directly.
 */
import { describe, it, expect } from "vitest";
import {
  clampSlipOffsetSec,
  effectiveVideoEndSec,
  maxSlipOffsetSec,
  slipOffsetFromDx,
  videoTimeForPlayback,
} from "../src/renderer/src/components/production/animatic-slip.js";

describe("maxSlipOffsetSec", () => {
  it("is the source remainder past the window", () => {
    expect(maxSlipOffsetSec(10, 4)).toBe(6);
    expect(maxSlipOffsetSec(4, 4)).toBe(0);
  });

  it("is 0 when the source is shorter than the window (nothing to slip)", () => {
    expect(maxSlipOffsetSec(2, 4)).toBe(0);
  });

  it("is unbounded while the length is still unknown", () => {
    expect(maxSlipOffsetSec(undefined, 4)).toBe(Number.POSITIVE_INFINITY);
  });

  it("is 0 for unusable inputs", () => {
    expect(maxSlipOffsetSec(10, 0)).toBe(0);
    expect(maxSlipOffsetSec(0, 4)).toBe(0);
    expect(maxSlipOffsetSec(Number.NaN, 4)).toBe(0);
  });
});

describe("clampSlipOffsetSec", () => {
  it("clamps to the slip range on the 0.1s grid", () => {
    expect(clampSlipOffsetSec(7, 10, 4)).toBe(6);
    expect(clampSlipOffsetSec(-2, 10, 4)).toBe(0);
    expect(clampSlipOffsetSec(2.34, 10, 4)).toBe(2.3);
  });

  it("floors at 0 while the length is unknown", () => {
    expect(clampSlipOffsetSec(-1, undefined, 4)).toBe(0);
    expect(clampSlipOffsetSec(2.34, undefined, 4)).toBe(2.3);
  });

  it("returns 0 for a non-numeric offset", () => {
    expect(clampSlipOffsetSec(Number.NaN, 10, 4)).toBe(0);
  });
});

describe("slipOffsetFromDx", () => {
  it("moves content with the cursor (right shrinks, left grows)", () => {
    expect(slipOffsetFromDx(2, 50, 50)).toBe(1);
    expect(slipOffsetFromDx(2, -50, 50)).toBe(3);
  });

  it("holds still without a live scale", () => {
    expect(slipOffsetFromDx(2, 50, 0)).toBe(2);
  });
});

describe("videoTimeForPlayback", () => {
  it("adds the offset to the local time", () => {
    expect(videoTimeForPlayback(1.5, 2, 10)).toBe(3.5);
    expect(videoTimeForPlayback(0, 2, 10)).toBe(2);
  });

  it("wraps past the source end (the preview loops short clips)", () => {
    expect(videoTimeForPlayback(1, 3, 3)).toBeCloseTo(1, 5);
  });

  it("passes through when the length is unknown", () => {
    expect(videoTimeForPlayback(1.5, 2, undefined)).toBe(3.5);
  });
});

describe("effectiveVideoEndSec", () => {
  it("is the source remainder past the slip", () => {
    expect(effectiveVideoEndSec(10, 2)).toBe(8);
    expect(effectiveVideoEndSec(10, undefined)).toBe(10);
  });

  it("is undefined without a usable length or remainder", () => {
    expect(effectiveVideoEndSec(undefined, 0)).toBeUndefined();
    expect(effectiveVideoEndSec(4, 4)).toBeUndefined();
    expect(effectiveVideoEndSec(4, 9)).toBeUndefined();
  });
});
