/** Whole-snapshot freshness guard (storyboard ghost-shot fix).
 *
 * Every Production saved in the main process carries a monotonic `rev`
 * (stamped by saveProduction). The renderer tracks the newest rev it has
 * applied and ignores any arriving snapshot with an older rev — a prompt-save
 * response produced before an insert/delete must not resurrect a deleted shot
 * or drop an inserted one.
 *
 * Equal revisions apply (latest write wins): two snapshots from the same save
 * are equivalent, and a renderer-optimistic local edit bumps its own rev so
 * it is never rejected as stale.
 */

/** True when a snapshot at `incomingRev` may overwrite state at `currentRev`. */
export function isFresh(incomingRev: number, currentRev: number): boolean {
  return incomingRev >= currentRev;
}

/** Normalize a possibly-missing rev to a comparable number. */
export function revOf(prod: { rev?: unknown }): number {
  return typeof prod.rev === "number" && Number.isFinite(prod.rev) ? prod.rev : 0;
}
