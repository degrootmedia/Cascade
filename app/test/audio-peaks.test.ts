/**
 * Waveform peak downsampling (the audio tile's pure math): min/max per
 * bucket, degenerate inputs collapse to empty (flat-bar fallback).
 */
import { describe, it, expect } from "vitest";
import { computePeaks } from "../src/renderer/src/components/graph/audio-peaks.js";

describe("computePeaks", () => {
  it("takes the min/max of each bucket", () => {
    const { mins, maxs } = computePeaks(Float32Array.from([0, 0.5, -0.5, 1, -1, 0.25]), 3);
    expect([...mins]).toEqual([0, -0.5, -1]);
    expect([...maxs]).toEqual([0.5, 1, 0.25]);
  });

  it("returns empty peaks for empty input or no buckets", () => {
    expect(computePeaks(new Float32Array(0), 128).mins.length).toBe(0);
    expect(computePeaks(Float32Array.from([0.5]), 0).mins.length).toBe(0);
  });

  it("never returns more buckets than samples", () => {
    const { mins, maxs } = computePeaks(Float32Array.from([0.25, -0.75]), 512);
    expect([...mins]).toEqual([0.25, -0.75]);
    expect([...maxs]).toEqual([0.25, -0.75]);
  });

  it("keeps silence at zero", () => {
    const { mins, maxs } = computePeaks(new Float32Array(1000), 10);
    expect([...mins]).toEqual(Array(10).fill(0));
    expect([...maxs]).toEqual(Array(10).fill(0));
  });
});
