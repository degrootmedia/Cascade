/**
 * Pure encoded-image dimension reader (no decode, no dependencies).
 *
 * Some media models require explicit output dimensions (Higgsfield's Topaz
 * upscalers declare `output_width`/`output_height` with no default), so the
 * submit path derives a target size from the source image's own pixels. This
 * reads just enough of the header to report `{ width, height }` for the
 * formats Cascade uploads (PNG / JPEG / WebP / GIF / BMP). Returns null for an
 * unrecognized or truncated payload — callers then leave the field to the user.
 */

function u16be(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1];
}
function u32be(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}
function u16le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8);
}
function i32le(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) | 0;
}

/** Pixel dimensions of an encoded image, or null when unreadable. */
export function imagePixelSize(bytes: Uint8Array | null | undefined): { width: number; height: number } | null {
  if (!bytes || bytes.length < 16) return null;
  const b = bytes;
  const positive = (w: number, h: number): { width: number; height: number } | null =>
    w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : null;

  // PNG: signature then IHDR width/height (big-endian).
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return positive(u32be(b, 16), u32be(b, 20));
  }
  // GIF: "GIF8" then little-endian width/height.
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return positive(u16le(b, 6), u16le(b, 8));
  }
  // BMP: "BM", little-endian width/height (height may be negative for top-down).
  if (b[0] === 0x42 && b[1] === 0x4d) {
    return positive(i32le(b, 18), Math.abs(i32le(b, 22)));
  }
  // WebP: RIFF container; the VP8/VP8L/VP8X chunk carries the size.
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fourcc === "VP8X") {
      // Extended: 24-bit canvas size minus one, at 24/27.
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return positive(w, h);
    }
    if (fourcc === "VP8 ") {
      // Lossy: 14-bit dimensions after the 3-byte start code.
      return positive(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    }
    if (fourcc === "VP8L") {
      // Lossless: 14-bit width/height packed into 28 bits after the signature.
      const packed = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return positive((packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1);
    }
    return null;
  }
  // JPEG: walk segments to a Start-Of-Frame marker carrying the dimensions.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      // Standalone markers carry no length.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = u16be(b, i + 2);
      if (len < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        // SOF: length(2) precision(1) height(2) width(2).
        return positive(u16be(b, i + 7), u16be(b, i + 5));
      }
      i += 2 + len;
    }
  }
  return null;
}
