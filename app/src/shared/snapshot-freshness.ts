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

/**
 * Whether an IPC failure is the stale-revision conflict a gated structural
 * command (`deleteShot`, `reorderShot`, …) raises when the document moved
 * past the caller's base revision. A renderer receives Electron's wrapped
 * form ("Error invoking remote method '…': Error: Stale edit: …"), so this
 * matches the marker anywhere in the message — a `startsWith` check against
 * the cleaned message never fires and the refresh-and-retry recovery is dead.
 */
export function isStaleRevisionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return msg.includes("Stale edit:");
}

/**
 * Adopt the revision a whole-document save stamped on disk onto the local
 * optimistic snapshot. The save returns the persisted document (rev bumped),
 * but wholesale-applying it would clobber optimistic edits made while the
 * save was in flight — so only the rev moves, and only forward. Returns the
 * same object when the saved revision is not newer (no re-render needed).
 */
export function applySavedRevision<T extends { rev?: number }>(current: T, savedRev: number): T {
  return savedRev > revOf(current) ? { ...current, rev: savedRev } : current;
}

/**
 * True when two snapshots carry identical content apart from `rev` — the
 * save-trip that produced the second one brought no news (no concurrent
 * main-side change rode along), so the caller can adopt just the rev via
 * `applySavedRevision` instead of wholesale-applying the snapshot and
 * busting every downstream object identity. JSON comparison: any key-order
 * surprise degrades to `false` (apply the snapshot), never to a wrong skip.
 */
export function sameSnapshotExceptRev<T extends { rev?: number }>(a: T, b: T): boolean {
  if (a === b) return true;
  try {
    // rev first in both: a snapshot missing the key would otherwise append
    // it at the end and never stringify-equal one that carries it up front.
    const normalize = (o: T) => JSON.stringify(Object.assign({ rev: 0 }, o, { rev: 0 }));
    return normalize(a) === normalize(b);
  } catch {
    return false;
  }
}
