/**
 * animatic-snap tests — pure video-end snap math for the animatic timeline.
 * No DOM/React: exercises the threshold + snap helpers directly.
 */
import { describe, it, expect } from "vitest";
import {
  snapDurationToVideoEnd,
  videoEndSnapThresholdSec,
} from "../src/renderer/src/components/production/animatic-snap.js";

describe("videoEndSnapThresholdSec", () => {
  it("is pixel-based (grows as the strip scale shrinks)", () => {
    const zoomedIn = videoEndSnapThresholdSec(100);
    const zoomedOut = videoEndSnapThresholdSec(20);
    expect(zoomedIn).toBeCloseTo(0.1, 5);
    expect(zoomedOut).toBeCloseTo(0.5, 5);
    expect(zoomedOut).toBeGreaterThan(zoomedIn);
  });

  it("is bounded so a zoomed-out strip never grabs from far away", () => {
    expect(videoEndSnapThresholdSec(5)).toBe(0.5);
    expect(videoEndSnapThresholdSec(1000)).toBeCloseTo(0.05, 5);
  });

  it("returns 0 for a dead scale", () => {
    expect(videoEndSnapThresholdSec(0)).toBe(0);
    expect(videoEndSnapThresholdSec(-4)).toBe(0);
    expect(videoEndSnapThresholdSec(Number.NaN)).toBe(0);
  });
});

describe("snapDurationToVideoEnd", () => {
  it("snaps to the 0.1s grid when close to the video end", () => {
    // pps=50 → threshold 0.2s; 3.27s video rounds to the 3.3s grid.
    expect(snapDurationToVideoEnd(3.35, 3.27, 50)).toBe(3.3);
    expect(snapDurationToVideoEnd(3.2, 3.27, 50)).toBe(3.3);
  });

  it("leaves the edge alone when far from the marker (either side)", () => {
    expect(snapDurationToVideoEnd(4.5, 3.27, 50)).toBe(4.5);
    expect(snapDurationToVideoEnd(2.0, 3.27, 50)).toBe(2.0);
  });

  it("ignores unknown or non-positive video lengths", () => {
    expect(snapDurationToVideoEnd(3.0, Number.NaN, 50)).toBe(3.0);
    expect(snapDurationToVideoEnd(3.0, 0, 50)).toBe(3.0);
    expect(snapDurationToVideoEnd(3.0, -2, 50)).toBe(3.0);
  });

  it("never snaps outside the timeline window", () => {
    expect(snapDurationToVideoEnd(19.9, 25, 50)).toBe(19.9);
    expect(snapDurationToVideoEnd(0.5, 0.2, 50)).toBe(0.5);
  });

  it("does nothing without a live scale", () => {
    expect(snapDurationToVideoEnd(3.27, 3.27, 0)).toBe(3.27);
  });
});
