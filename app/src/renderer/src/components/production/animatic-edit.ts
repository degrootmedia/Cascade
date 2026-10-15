/**
 * Animatic edge-drag math: what dragging a block's right edge does to the
 * timeline's durations. Two modes:
 *
 * - **Roll** (the historical behavior): the dragged item trades time with
 *   the following item, so the total runtime and every later edit point
 *   stay put.
 * - **Ripple**: only the dragged item changes; the total grows/shrinks and
 *   every following item shifts with it (starts are cumulative sums, so no
 *   other stored field moves).
 *
 * Pure so the clamps are unit-testable without a rendered timeline. Item
 * durations are bounded [0.5s, 20s] in both modes; a roll additionally
 * keeps the neighbor inside the same bounds by giving back the excess.
 */
export type AnimaticEditMode = "roll" | "ripple";

export interface EdgeDragItem {
  id: string;
  durationSec: number;
}

const MIN_SEC = 0.5;
const MAX_SEC = 20;
const clamp = (v: number): number => Math.max(MIN_SEC, Math.min(MAX_SEC, v));

/** Duration updates for dragging `items[index]`'s right edge to
 *  `requestedSec` (already snapped by the caller, if it snaps). */
export function edgeDragUpdates(
  items: EdgeDragItem[],
  index: number,
  requestedSec: number,
  mode: AnimaticEditMode
): { id: string; durationSec: number }[] {
  const cur = items[index];
  if (!cur) return [];
  let next = clamp(requestedSec);
  const following = items[index + 1];
  if (mode === "ripple" || !following) {
    return [{ id: cur.id, durationSec: next }];
  }
  // Roll: the boundary after the next item stays fixed — it absorbs the delta.
  let nextDur = following.durationSec - (next - cur.durationSec);
  if (nextDur < MIN_SEC) { nextDur = MIN_SEC; next = cur.durationSec + (following.durationSec - MIN_SEC); }
  if (nextDur > MAX_SEC) { nextDur = MAX_SEC; next = cur.durationSec - (MAX_SEC - following.durationSec); }
  next = clamp(next);
  return [
    { id: cur.id, durationSec: next },
    { id: following.id, durationSec: nextDur },
  ];
}
