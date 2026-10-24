/**
 * Pure zoom/pan math for the shared media lightbox. The viewport model
 * mirrors the moodboard canvas (`moodboard-layout.ts`): the image is drawn
 * at its fit size, centered in the stage, then transformed by
 * `translate(x, y) scale(zoom)` where x/y are px offsets from stage center
 * and zoom 1 is the fit. Cursor-anchored zoom keeps the image point under
 * the pointer fixed; pan is clamped so an edge can never pass the center.
 */

export interface LightboxViewport {
  /** Px offset of the image center from the stage center. */
  x: number;
  y: number;
  /** 1 = fit in the stage. */
  zoom: number;
}

export const LIGHTBOX_IDENTITY: LightboxViewport = { x: 0, y: 0, zoom: 1 };
export const LIGHTBOX_MIN_ZOOM = 1;
export const LIGHTBOX_MAX_ZOOM = 8;
/** Double-click toggles between fit and this zoom. */
export const LIGHTBOX_TOGGLE_ZOOM = 2.5;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The size an image is drawn at zoom 1: scaled to fit `maxW`×`maxH`,
 *  upscaling small images (a lightbox should fill its stage; the user can
 *  zoom back out to fit, never below it). Degenerate inputs give 1×1. */
export function lightboxFitSize(
  natW: number,
  natH: number,
  maxW: number,
  maxH: number,
): { w: number; h: number } {
  if (!(natW > 0) || !(natH > 0) || !(maxW > 0) || !(maxH > 0)) return { w: 1, h: 1 };
  const scale = Math.min(maxW / natW, maxH / natH);
  return { w: Math.max(1, natW * scale), h: Math.max(1, natH * scale) };
}

/** Zoom by `factor` anchored at (cx, cy) — px offsets from the stage
 *  center — so the image point under the cursor stays under it. */
export function lightboxZoomAt(
  vp: LightboxViewport,
  cx: number,
  cy: number,
  factor: number,
): LightboxViewport {
  const zoom = clamp(vp.zoom * factor, LIGHTBOX_MIN_ZOOM, LIGHTBOX_MAX_ZOOM);
  if (zoom === vp.zoom) return vp;
  const px = (cx - vp.x) / vp.zoom;
  const py = (cy - vp.y) / vp.zoom;
  return { x: cx - px * zoom, y: cy - py * zoom, zoom };
}

/** Set an absolute zoom anchored at (cx, cy) (toolbar +/−, double-click). */
export function lightboxZoomTo(
  vp: LightboxViewport,
  cx: number,
  cy: number,
  zoom: number,
): LightboxViewport {
  return vp.zoom > 0 ? lightboxZoomAt(vp, cx, cy, zoom / vp.zoom) : LIGHTBOX_IDENTITY;
}

/** Clamp pan so the image always covers the stage center: per axis the
 *  offset may not exceed half the overflow. At fit zoom the image is
 *  recentered exactly. `base` is the fit size from `lightboxFitSize`. */
export function lightboxClampPan(
  vp: LightboxViewport,
  stageW: number,
  stageH: number,
  baseW: number,
  baseH: number,
): LightboxViewport {
  if (vp.zoom <= LIGHTBOX_MIN_ZOOM) return { x: 0, y: 0, zoom: LIGHTBOX_MIN_ZOOM };
  const maxX = Math.max(0, (baseW * vp.zoom - stageW) / 2);
  const maxY = Math.max(0, (baseH * vp.zoom - stageH) / 2);
  return { x: clamp(vp.x, -maxX, maxX), y: clamp(vp.y, -maxY, maxY), zoom: vp.zoom };
}
