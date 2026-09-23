/**
 * `imagePixelSize` — the pure header reader the Higgsfield submit path uses to
 * derive required output dimensions from a source image. Covers each format's
 * dimension field and the unreadable/truncated fallbacks.
 */
import { describe, it, expect } from "vitest";
import { imagePixelSize } from "../src/main/providers/image-size.js";

/** Minimal PNG header carrying a width/height (only the bytes the parser reads). */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

/** Minimal JPEG: SOI + an SOF0 segment with height/width. */
function jpeg(width: number, height: number): Uint8Array {
  const b = new Uint8Array(20);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  const dv = new DataView(b.buffer);
  dv.setUint16(7, height);
  dv.setUint16(9, width);
  return b;
}

function gif(width: number, height: number): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // "GIF89a"
  const dv = new DataView(b.buffer);
  dv.setUint16(6, width, true);
  dv.setUint16(8, height, true);
  return b;
}

function bmp(width: number, height: number): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0x42, 0x4d], 0); // "BM"
  const dv = new DataView(b.buffer);
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true);
  return b;
}

function webpVp8x(width: number, height: number): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  b.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  b.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  b[24] = (width - 1) & 0xff;
  b[25] = ((width - 1) >> 8) & 0xff;
  b[26] = ((width - 1) >> 16) & 0xff;
  b[27] = (height - 1) & 0xff;
  b[28] = ((height - 1) >> 8) & 0xff;
  b[29] = ((height - 1) >> 16) & 0xff;
  return b;
}

describe("imagePixelSize", () => {
  it("reads PNG / JPEG / GIF / BMP / WebP dimensions", () => {
    expect(imagePixelSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(imagePixelSize(jpeg(800, 600))).toEqual({ width: 800, height: 600 });
    expect(imagePixelSize(gif(320, 240))).toEqual({ width: 320, height: 240 });
    expect(imagePixelSize(bmp(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(imagePixelSize(webpVp8x(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("returns null for unknown, truncated, or zero-sized payloads", () => {
    expect(imagePixelSize(null)).toBeNull();
    expect(imagePixelSize(new Uint8Array(0))).toBeNull();
    expect(imagePixelSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]))).toBeNull();
    expect(imagePixelSize(png(0, 0))).toBeNull();
  });
});
