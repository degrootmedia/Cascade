/**
 * Camera-grid cutout (Spec 04) — the deep module behind `cameraGrid:cutout`.
 *
 * Crops marqueed panel rects (of any cols x rows grid) out of a grid sheet into
 * new reference image files. The image decoder, path resolver, writer,
 * existence check, and id generator are all injected: that injection IS the
 * test surface (the real wiring in `main/index.ts` supplies Electron's
 * `nativeImage`, `assetPath`, `fs`, and `newRefId`; tests supply fakes with no
 * Electron/disk).
 *
 * Decoding happens in main (not `canvas.toDataURL` in the renderer) so the
 * exported PNG is identical in quality to the source and the canvas-taint /
 * CSP problems of a cross-origin `cascade-media://` image never arise.
 */
import type { CameraGridPanel, CustomRef } from "../shared/ipc.js";
import { clampGridRect, panelLabelFor } from "../shared/ipc.js";

/** The slice of Electron's `NativeImage` the cutout needs. */
export interface CropImage {
  getSize(): { width: number; height: number };
  crop(rect: { x: number; y: number; width: number; height: number }): { toPNG(): Buffer };
}

export interface CameraGridDeps {
  /** Decode a sheet file to a crop-capable image (nativeImage in production). */
  decodeImage(absPath: string): CropImage | null;
  /** Resolve a production-relative path to an absolute one (containment-checked). */
  resolvePath(rel: string): string;
  /** Write bytes at a production-relative path (atomically in production). */
  writeFile(rel: string, bytes: Buffer): void;
  /** Whether a production-relative path already exists (name collision check). */
  exists(rel: string): boolean;
  /** A fresh reference id. */
  newRefId(): string;
}

export interface CutoutOptions {
  nodeId: string;
  /** Production-relative references directory (crops land directly in it). */
  referencesDir: string;
  /** Production-relative path of the grid sheet. */
  sheetPath: string;
  /** Normalized crop rects (one reference is created per rect). */
  rects: CameraGridPanel[];
  /** Labels aligned 1:1 with `rects`; absent entries fall back to "Angle N". */
  labels?: string[];
  /** Category id the created references belong to. */
  categoryId?: string;
}

export interface CutoutResult {
  refs: CustomRef[];
  /** Production-relative paths of the written crops, aligned with `refs`. */
  paths: string[];
}

/** Map a normalized rect to a clamped pixel rect, or null when degenerate. */
export function pixelRect(
  rect: CameraGridPanel,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  const r = clampGridRect(rect);
  if (r.w * width < 1 || r.h * height < 1) return null;
  const x = Math.max(0, Math.min(width - 1, Math.round(r.x * width)));
  const y = Math.max(0, Math.min(height - 1, Math.round(r.y * height)));
  const w = Math.max(1, Math.min(width - x, Math.round(r.w * width)));
  const h = Math.max(1, Math.min(height - y, Math.round(r.h * height)));
  return { x, y, width: w, height: h };
}

/** Strip anything unsafe from a node id used in a filename. */
function safeSegment(id: string): string {
  return (id || "node").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "node";
}

/** Crop each rect into a new reference file. Throws when the sheet can't be
 *  decoded; skips degenerate rects. Never partially overwrites (collisions
 *  get a numeric suffix). */
export function cutoutCameraGrid(opts: CutoutOptions, deps: CameraGridDeps): CutoutResult {
  const image = deps.decodeImage(deps.resolvePath(opts.sheetPath));
  if (!image) throw new Error("The camera-grid sheet couldn't be read (missing or unsupported image).");
  const { width, height } = image.getSize();
  if (!(width > 0) || !(height > 0)) {
    throw new Error("The camera-grid sheet has no readable dimensions.");
  }
  const dir = opts.referencesDir.replace(/\/+$/, "");
  const refs: CustomRef[] = [];
  const paths: string[] = [];
  opts.rects.forEach((rawRect, i) => {
    const px = pixelRect(rawRect, width, height);
    if (!px) return;
    const bytes = image.crop(px).toPNG();
    const base = `camera-grid-${safeSegment(opts.nodeId)}-${i + 1}`;
    let rel = `${dir}/${base}.png`;
    let n = 2;
    while (deps.exists(rel)) {
      rel = `${dir}/${base}-${n}.png`;
      n++;
    }
    deps.writeFile(rel, bytes);
    const ref: CustomRef = {
      id: deps.newRefId(),
      name: panelLabelFor(opts.labels, i),
      imagePath: rel,
      shotIds: [],
    };
    if (opts.categoryId) ref.categoryId = opts.categoryId;
    refs.push(ref);
    paths.push(rel);
  });
  return { refs, paths };
}
