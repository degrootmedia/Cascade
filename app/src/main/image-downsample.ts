/**
 * Oversize image import: shrink an image to a JPEG that fits the import
 * limit. The decoder is injected (Electron's `nativeImage` in production,
 * fakes in tests) — that injection IS the test surface, like
 * `camera-grid.ts`. The input bytes are only ever read: the caller's
 * original file is never modified, the converted JPEG is what imports.
 *
 * Ladder: try descending JPEG qualities at full size first (a big PNG
 * usually fits as a same-size JPEG); only when no quality fits, scale the
 * dimensions down in steps and retry a short quality ladder at each size.
 * Gives up loudly rather than returning something still over the limit.
 */
import { IMAGE_IMPORT_LIMIT_BYTES } from "../shared/image-import.js";

/** The slice of Electron's `NativeImage` the shrink needs. */
export interface DownsampleImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width?: number; height?: number }): DownsampleImage;
  toJPEG(quality: number): Buffer;
}

export interface ImageDownsampleDeps {
  /** Decode image bytes (nativeImage.createFromBuffer in production). */
  decode(bytes: Buffer): DownsampleImage | null;
}

const FULL_SIZE_QUALITIES = [90, 82, 74, 66, 58, 50, 42, 34, 26, 18];
const SCALED_QUALITIES = [82, 66, 50, 34, 18];
const SCALES = [0.75, 0.5, 0.35, 0.25, 0.15];

/**
 * Convert `bytes` to a JPEG of at most `limit` bytes. Throws when the image
 * can't be decoded or no rung of the ladder fits. Never mutates `bytes`.
 */
export function shrinkImageToJpeg(bytes: Buffer, deps: ImageDownsampleDeps, limit: number = IMAGE_IMPORT_LIMIT_BYTES): Buffer {
  const image = deps.decode(bytes);
  if (!image || image.isEmpty()) throw new Error("That image couldn't be decoded for conversion.");
  for (const quality of FULL_SIZE_QUALITIES) {
    const out = image.toJPEG(quality);
    if (out.length <= limit) return out;
  }
  const { width, height } = image.getSize();
  const longEdge = Math.max(width, height);
  for (const scale of SCALES) {
    const target = Math.max(1, Math.round(longEdge * scale));
    const resized = width >= height ? image.resize({ width: target }) : image.resize({ height: target });
    if (!resized || resized.isEmpty()) continue;
    for (const quality of SCALED_QUALITIES) {
      const out = resized.toJPEG(quality);
      if (out.length <= limit) return out;
    }
  }
  throw new Error("Couldn't shrink that image below 15 MB.");
}

/** Parse a `data:image/…;base64,…` URL to its bytes (the import transport). */
export function imageDataUrlToBuffer(dataUrl: string): Buffer {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) throw new Error("Not a data-URL image.");
  const comma = dataUrl.indexOf(",");
  if (comma === -1) throw new Error("Not a data-URL image.");
  const mime = dataUrl.slice(5, comma).split(";")[0];
  if (!mime.startsWith("image/")) throw new Error("Not an image — videos and audio are added as media references instead.");
  const buf = Buffer.from(dataUrl.slice(comma + 1), "base64");
  if (!buf.length) throw new Error("The image is empty.");
  return buf;
}
