/**
 * Oversize image import (Item 2): the main-side JPEG shrink behind the
 * "Convert to JPEG" choice. The decoder is injected, so the quality/resize
 * ladder is tested with fakes — no Electron, no real image bytes. The fake
 * encoder's output size is a pure function of (pixels, quality), which pins
 * exactly which rung the ladder must land on.
 */
import { describe, it, expect } from "vitest";
import {
  shrinkImageToJpeg,
  type DownsampleImage,
  type ImageDownsampleDeps,
} from "../src/main/image-downsample.js";
import { IMAGE_IMPORT_LIMIT_BYTES } from "../src/shared/image-import.js";

const LIMIT = IMAGE_IMPORT_LIMIT_BYTES;

/** Fake image: JPEG bytes ≈ pixels * quality / divisor (deterministic size). */
function fakeImage(width: number, height: number, divisor = 100): DownsampleImage {
  const img: DownsampleImage = {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: (opts) => {
      if (opts.width) return fakeImage(opts.width, Math.max(1, Math.round((height * opts.width) / width)), divisor);
      if (opts.height) return fakeImage(Math.max(1, Math.round((width * opts.height) / height)), opts.height, divisor);
      return img;
    },
    toJPEG: (quality) => Buffer.alloc(Math.max(1, Math.round((width * height * quality) / divisor))),
  };
  return img;
}

function depsFor(image: DownsampleImage | null): ImageDownsampleDeps {
  return { decode: () => image };
}

describe("shrinkImageToJpeg", () => {
  it("pins the import limit at 15MB", () => {
    expect(LIMIT).toBe(15 * 1024 * 1024);
  });

  it("returns a JPEG at full size when a quality rung fits under the limit", () => {
    // 4000x3000, divisor 100: 12e6*90/100 = 10.8e6 < LIMIT already at the first rung.
    const out = shrinkImageToJpeg(Buffer.alloc(LIMIT + 1), depsFor(fakeImage(4000, 3000)));
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    expect(out.length).toBe(10_800_000);
  });

  it("walks down the quality ladder until the JPEG fits", () => {
    // 8000x6000: q90 → 43.2MB, q82 → 39.4MB, … q34 → 16.3MB, q26 → 12.5MB fits.
    const out = shrinkImageToJpeg(Buffer.alloc(LIMIT + 1), depsFor(fakeImage(8000, 6000)));
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    expect(out.length).toBe(12_480_000);
  });

  it("resizes when no quality at full size fits", () => {
    // Divisor 10 (near-lossless content): even q18 at 8000x6000 is 86MB, so the
    // ladder must shrink dimensions; any accepted result must fit the limit.
    const out = shrinkImageToJpeg(Buffer.alloc(LIMIT + 1), depsFor(fakeImage(8000, 6000, 10)));
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    expect(out.length).toBeGreaterThan(0);
  });

  it("never mutates the input buffer", () => {
    const input = Buffer.alloc(LIMIT + 1, 7);
    const before = Buffer.from(input);
    shrinkImageToJpeg(input, depsFor(fakeImage(4000, 3000)));
    expect(input.equals(before)).toBe(true);
  });

  it("throws when the image cannot be decoded", () => {
    expect(() => shrinkImageToJpeg(Buffer.from("not an image"), depsFor(null))).toThrow();
    const empty: DownsampleImage = { ...fakeImage(10, 10), isEmpty: () => true };
    expect(() => shrinkImageToJpeg(Buffer.from("junk"), depsFor(empty))).toThrow();
  });

  it("throws when even the smallest encode stays over the limit", () => {
    // Divisor 1: JPEG size == pixels*quality — no rung or resize can fit 48MP under 15MB
    // until extremely small; scale floor keeps the long edge >= 64px so it must give up loudly.
    expect(() => shrinkImageToJpeg(Buffer.alloc(LIMIT + 1), depsFor(fakeImage(8000, 6000, 1)))).toThrow(/below 15 ?MB/i);
  });
});
