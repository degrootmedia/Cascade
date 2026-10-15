/**
 * Bounded undo/redo history for the node view (feature-scoped snapshot
 * stack). The modal captures a snapshot of the shot's graph-owned fields +
 * canvas layout BEFORE each mutation (at the save funnels, so every
 * mutation path is covered without touching call sites); undo restores the
 * previous snapshot through the same narrow commands that wrote it.
 *
 * Bursts (node drags, keystrokes) coalesce: a push inside the coalesce
 * window of the last accepted push is dropped, so one gesture is one step.
 * Explicit gestures (CTRL+Click, Tidy, deletes) force their own step.
 */

export interface UndoHistory<S> {
  /** Capture a pre-mutation state. Returns false when coalesced/deduped. */
  push(state: S, opts?: { force?: boolean; now?: number }): boolean;
  /** Move to the previous state; `current` is parked on the redo stack. */
  undo(current: S): S | null;
  redo(current: S): S | null;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
  readonly size: number;
}

export function createUndoHistory<S>(opts?: {
  limit?: number;
  coalesceMs?: number;
  equals?: (a: S, b: S) => boolean;
}): UndoHistory<S> {
  const limit = opts?.limit ?? 50;
  const coalesceMs = opts?.coalesceMs ?? 1200;
  const equals = opts?.equals ?? ((a: S, b: S) => JSON.stringify(a) === JSON.stringify(b));
  let past: S[] = [];
  let future: S[] = [];
  let lastPushAt = -Infinity;

  return {
    push(state, pushOpts) {
      const now = pushOpts?.now ?? Date.now();
      if (!pushOpts?.force && now - lastPushAt < coalesceMs) return false;
      const top = past[past.length - 1];
      if (top !== undefined && equals(top, state)) return false;
      past.push(state);
      if (past.length > limit) past = past.slice(past.length - limit);
      future = [];
      lastPushAt = now;
      return true;
    },
    undo(current) {
      const prev = past.pop();
      if (prev === undefined) return null;
      future.push(current);
      lastPushAt = -Infinity;
      return prev;
    },
    redo(current) {
      const next = future.pop();
      if (next === undefined) return null;
      past.push(current);
      lastPushAt = -Infinity;
      return next;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    clear() {
      past = [];
      future = [];
      lastPushAt = -Infinity;
    },
    get size() {
      return past.length;
    },
  };
}
