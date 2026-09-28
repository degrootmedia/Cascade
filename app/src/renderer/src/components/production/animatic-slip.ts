/**
 * Animatic timeline slip-edit — pure helpers.
 *
 * Slipping shifts the source window a timeline block plays ([offset,
 * offset+window]) while the window itself stays put. The offset persists per
 * clip (`ProductionShot.videoOffsetSec` / `ShotSequence.videoOffsetSec`) and
 * is honoured by the preview, the export, the EDL, and the AE script, so all
 * four always agree. DOM/React-free for unit tests.
 */

/** Timeline grid: slip offsets commit on the same 0.1s grid as durations. */
export const SLIP_GRID_SEC = 0.1;

/**
 * Furthest a window may slip into its source: the source must still cover
 * the whole window, so no slip exists when the source is shorter than (or
 * unknown alongside) the window. Unknown length = unbounded above (the probe
 * may still be pending); the lower bound is always 0.
 */
export function maxSlipOffsetSec(videoLenSec: number | undefined, windowSec: number): number {
  if (!Number.isFinite(windowSec) || windowSec <= 0) return 0;
  if (videoLenSec == null) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(videoLenSec) || videoLenSec <= 0) return 0;
  return Math.max(0, Math.round((videoLenSec - windowSec) * 10) / 10);
}

/** Clamp a slip offset to its valid range, on the timeline grid. */
export function clampSlipOffsetSec(
  offsetSec: number,
  videoLenSec: number | undefined,
  windowSec: number,
): number {
  if (!Number.isFinite(offsetSec)) return 0;
  const rounded = Math.round(offsetSec * 10) / 10;
  const max = maxSlipOffsetSec(videoLenSec, windowSec);
  if (!Number.isFinite(max)) return Math.max(0, rounded);
  return Math.max(0, Math.min(max, rounded));
}

/**
 * Slip offset from a horizontal drag. Content follows the cursor: dragging
 * right pulls earlier source frames under the fixed window (offset shrinks),
 * dragging left pushes the start further into the source (offset grows).
 * Unclamped — the caller clamps with `clampSlipOffsetSec` once the source
 * length is known.
 */
export function slipOffsetFromDx(startOffsetSec: number, dxPx: number, pxPerSec: number): number {
  if (!Number.isFinite(startOffsetSec) || !Number.isFinite(dxPx)) return startOffsetSec;
  if (!Number.isFinite(pxPerSec) || pxPerSec <= 0) return startOffsetSec;
  return startOffsetSec - dxPx / pxPerSec;
}

/**
 * Source timestamp to show for a playhead sitting `localSec` inside a
 * slipped window. Past the source end it wraps (the preview loops short
 * clips, and the offset math preserves that); unknown length passes through
 * for the element to clamp natively.
 */
export function videoTimeForPlayback(
  offsetSec: number,
  localSec: number,
  videoLenSec?: number,
): number {
  const off = Number.isFinite(offsetSec) && offsetSec > 0 ? offsetSec : 0;
  const local = Number.isFinite(localSec) && localSec > 0 ? localSec : 0;
  const t = off + local;
  if (videoLenSec != null && Number.isFinite(videoLenSec) && videoLenSec > 0 && t >= videoLenSec) {
    return t % videoLenSec;
  }
  return t;
}

/**
 * Source remaining after the slip — where the end-of-video marker sits and
 * what the edge snaps to. Undefined while the length is unknown or the
 * offset already covers the source.
 */
export function effectiveVideoEndSec(
  videoLenSec: number | undefined,
  offsetSec: number | undefined,
): number | undefined {
  if (videoLenSec == null || !Number.isFinite(videoLenSec) || videoLenSec <= 0) return undefined;
  const off = offsetSec != null && Number.isFinite(offsetSec) && offsetSec > 0 ? offsetSec : 0;
  const remaining = videoLenSec - off;
  return remaining > 0 ? remaining : undefined;
}
