/**
 * Animatic timeline video-end snapping — pure helpers.
 *
 * A timeline block with a video shows a vertical marker at the clip's true
 * length. Dragging the block's right edge snaps to that length when close,
 * but the edge can still rest on either side of it. Keeping the math here
 * (no DOM, no React) makes it unit-testable without mounting the timeline.
 */

/** Pixel distance that counts as "close enough" to snap. */
export const VIDEO_END_SNAP_PX = 10;

/** Timeline durations are clamped to this window (mirrors the drag handler). */
export const TIMELINE_MIN_SEC = 0.5;
export const TIMELINE_MAX_SEC = 20;

/**
 * Snap radius in seconds for the current strip scale. Pixel-based so the
 * feel is zoom-independent, bounded so a zoomed-out strip doesn't grab the
 * edge from half a second away.
 */
export function videoEndSnapThresholdSec(pps: number, snapPx = VIDEO_END_SNAP_PX): number {
  if (!Number.isFinite(pps) || pps <= 0) return 0;
  if (!Number.isFinite(snapPx) || snapPx <= 0) return 0;
  return Math.min(0.5, Math.max(0.05, snapPx / pps));
}

/**
 * Snap a dragged duration to the video's true length when within the radius.
 * The snapped value is rounded to the timeline's 0.1s grid so the committed
 * duration matches what the drag handler would store anyway. Returns `nextSec`
 * unchanged when snapping doesn't apply (unknown video length, target outside
 * the timeline window, or too far away) — the edge stays freely placeable on
 * either side of the marker.
 */
export function snapDurationToVideoEnd(
  nextSec: number,
  videoSec: number,
  pps: number,
  snapPx = VIDEO_END_SNAP_PX,
): number {
  if (!Number.isFinite(nextSec) || !Number.isFinite(videoSec)) return nextSec;
  if (videoSec <= 0 || pps <= 0) return nextSec;
  const threshold = videoEndSnapThresholdSec(pps, snapPx);
  if (threshold <= 0) return nextSec;
  if (Math.abs(nextSec - videoSec) > threshold) return nextSec;
  const snapped = Math.round(videoSec * 10) / 10;
  if (!Number.isFinite(snapped)) return nextSec;
  if (snapped < TIMELINE_MIN_SEC || snapped > TIMELINE_MAX_SEC) return nextSec;
  return snapped;
}
