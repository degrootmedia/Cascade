/**
 * App-wide undo/redo for the production document — the pure core.
 *
 * Classic view and node view are two views of ONE canonical production
 * document, so history lives at the document layer, once (Item 1). This
 * module is the machinery: structural-sharing reconcile, the undoable
 * projection (the document/world boundary of Item 4), restore merging,
 * and the bounded snapshot stack. The main-process service
 * (`main/production-history.ts`) feeds it one snapshot per committed
 * `saveProduction` and performs restores (document write + board-folder
 * reconciliation). Snapshots are frozen and reference media by file path
 * only — history never holds media bytes.
 */
import type { Production, ProductionShot } from "./ipc/production.js";

/** Undo/redo availability for one production (menu/buttons state). */
export interface ProductionHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  depth: number;
}

/** Starting bound for retained undo steps (flagged judgment call 4). */
export const HISTORY_STEP_CAP = 100;

/** How one committed save should enter history (Item 2 granularity). */
export interface HistoryCommitMeta {
  /** Saves carrying the same key merge into one step while the gesture is
   *  open (typing in one field, a slider drag, a node drag burst). */
  coalesceKey?: string;
  /** Merge window for this key (ms). Prompt-field sessions pass a long
   *  window and close explicitly on blur; sliders pass a short one. */
  coalesceMs?: number;
  /** This save closes the keyed gesture: the next save starts a new step
   *  even inside the window. Leaving a field commits once (Bug #18). */
  coalesceEnd?: boolean;
  /** Never merge this save into the previous step (discrete gestures:
   *  deletes, connects, drops). */
  forceStep?: boolean;
  /** The save must not enter history at all (a history restore write). */
  suppress?: boolean;
}

/**
 * Reconcile `next` onto `prev` with structural sharing: every subtree
 * that is deep-equal to its predecessor keeps the predecessor's object
 * identity, so a snapshot retains new objects only along changed paths.
 * Returns `prev` itself when the two are deep-equal. JSON-shaped data
 * only (the production document is JSON by construction).
 */
export function reconcileShare<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (
    prev === null || next === null ||
    typeof prev !== "object" || typeof next !== "object"
  ) {
    return next;
  }
  if (Array.isArray(prev) || Array.isArray(next)) {
    if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return next;
    let same = true;
    const out: unknown[] = new Array(next.length);
    for (let i = 0; i < next.length; i++) {
      out[i] = reconcileShare(prev[i], next[i]);
      if (out[i] !== prev[i]) same = false;
    }
    return (same ? prev : (out as T));
  }
  const prevRec = prev as Record<string, unknown>;
  const nextRec = next as Record<string, unknown>;
  const nextKeys = Object.keys(nextRec);
  if (nextKeys.length !== Object.keys(prevRec).length) {
    // Key sets differ: still share per-key where both sides carry the key.
    const out: Record<string, unknown> = {};
    for (const k of nextKeys) out[k] = k in prevRec ? reconcileShare(prevRec[k], nextRec[k]) : nextRec[k];
    return out as T;
  }
  let same = true;
  const out: Record<string, unknown> = {};
  for (const k of nextKeys) {
    if (!(k in prevRec)) return next;
    out[k] = reconcileShare(prevRec[k], nextRec[k]);
    if (out[k] !== prevRec[k]) same = false;
  }
  return (same ? prev : (out as T));
}

/** Deep-freeze a snapshot so in-place mutation of any live document can
 *  never corrupt retained history. Already-frozen subtrees are shared
 *  with earlier snapshots and skipped. */
export function freezeSnapshot<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object" || seen.has(v as object)) return;
    seen.add(v as object);
    if (Object.isFrozen(v)) return;
    for (const val of Object.values(v as Record<string, unknown>)) walk(val);
    Object.freeze(v);
  };
  walk(value);
  return value;
}

/**
 * The undoable projection of a production: the document minus the
 * world/bookkeeping fields an undo must never rewind (Item 4) and the
 * view state history never moves (Item 1):
 *
 * - `rev` / `meta.updatedAt` — write stamps; a restore writes fresh ones.
 * - `status` — pipeline run markers (the world ran; undo doesn't un-run).
 * - `currentStep` — which pipeline step is focused (view state).
 * - `media` — the media registry: main-maintained present/missing truth,
 *   re-bootstrapped from the referenced fields on load.
 * - `pendingImageGen` / `pendingVideoGen` (shots + style frames) — live
 *   vendor-job receipts. A submitted generation is out of scope for undo;
 *   losing its receipt would strand a paid, still-rendering job.
 * - assembly run bookkeeping (`assembledAt`, `renderPath`, …) — exports
 *   are out of scope; assembly *settings* (fps/size/exportDir) stay.
 * - `graphLayout.viewport` / `moodboard.viewport` — pan/zoom is view
 *   state; node positions/sizes/waypoints are document and stay.
 *
 * Takes ownership of the passed clone and strips in place.
 */
export function projectForHistory(p: Production): Production {
  const rec = p as unknown as Record<string, unknown>;
  delete rec.rev;
  delete rec.status;
  delete rec.currentStep;
  delete rec.media;
  if (p.meta) {
    const meta = { ...p.meta } as unknown as Record<string, unknown>;
    delete meta.updatedAt;
    delete meta.stepDone;
    delete meta.shotCount;
    p.meta = meta as unknown as Production["meta"];
  }
  if (p.assembly) {
    const a = { ...p.assembly } as unknown as Record<string, unknown>;
    delete a.assembledAt;
    delete a.renderPath;
    delete a.renderedAt;
    delete a.totalSec;
    delete a.skippedShots;
    p.assembly = a as unknown as Production["assembly"];
  }
  if (p.moodboard) {
    const mb = { ...p.moodboard } as unknown as Record<string, unknown>;
    delete mb.viewport;
    p.moodboard = mb as unknown as Production["moodboard"];
  }
  for (const style of p.styles ?? []) delete style.pendingImageGen;
  const stripShot = (s: ProductionShot): void => {
    delete s.pendingImageGen;
    delete s.pendingVideoGen;
    if (s.graphLayout) {
      const layout = { ...s.graphLayout } as unknown as Record<string, unknown>;
      delete layout.viewport;
      s.graphLayout = layout as ProductionShot["graphLayout"];
    }
  };
  for (const scene of p.scenes ?? []) for (const s of scene.shots ?? []) stripShot(s);
  for (const s of p.outdatedShots ?? []) stripShot(s);
  for (const seq of p.shotSequences ?? []) if (seq.graph) stripShot(seq.graph);
  return p;
}

/**
 * Build the full document a restore writes: the target snapshot's
 * document state with the *current* document's excluded fields overlaid,
 * so undo rewinds edits without rewinding the world (pending receipts,
 * run status, focused step, viewports, export bookkeeping all stay at
 * their live values). Pure: neither input is mutated.
 */
export function mergeRestoredProduction(target: Production, current: Production): Production {
  const work: Production = structuredClone(target);
  work.currentStep = current.currentStep;
  work.status = structuredClone(current.status ?? {});
  if (current.media !== undefined) work.media = structuredClone(current.media);
  else delete work.media;
  if (current.rev !== undefined) work.rev = current.rev;
  work.meta = { ...work.meta, updatedAt: current.meta?.updatedAt ?? work.meta.updatedAt };
  if (current.assembly) {
    work.assembly = {
      ...(work.assembly ?? current.assembly),
      ...(current.assembly.assembledAt !== undefined ? { assembledAt: current.assembly.assembledAt } : {}),
      ...(current.assembly.renderPath !== undefined ? { renderPath: current.assembly.renderPath } : {}),
      ...(current.assembly.renderedAt !== undefined ? { renderedAt: current.assembly.renderedAt } : {}),
      ...(current.assembly.totalSec !== undefined ? { totalSec: current.assembly.totalSec } : {}),
      ...(current.assembly.skippedShots !== undefined ? { skippedShots: current.assembly.skippedShots } : {}),
    };
  }
  if (work.moodboard && current.moodboard?.viewport) {
    work.moodboard = { ...work.moodboard, viewport: structuredClone(current.moodboard.viewport) };
  }
  const curStyles = new Map((current.styles ?? []).map((s) => [s.id, s]));
  for (const style of work.styles ?? []) {
    const cur = curStyles.get(style.id);
    if (cur?.pendingImageGen) style.pendingImageGen = structuredClone(cur.pendingImageGen);
  }
  const curShots = new Map<string, ProductionShot>();
  for (const sc of current.scenes ?? []) for (const s of sc.shots ?? []) curShots.set(s.id, s);
  for (const s of current.outdatedShots ?? []) curShots.set(s.id, s);
  for (const seq of current.shotSequences ?? []) if (seq.graph) curShots.set(seq.graph.id, seq.graph);
  const overlayShot = (s: ProductionShot): void => {
    const cur = curShots.get(s.id);
    if (!cur) return;
    if (cur.pendingImageGen) s.pendingImageGen = structuredClone(cur.pendingImageGen);
    if (cur.pendingVideoGen) s.pendingVideoGen = structuredClone(cur.pendingVideoGen);
    const curViewport = (cur.graphLayout as { viewport?: unknown } | undefined)?.viewport;
    if (curViewport !== undefined) {
      s.graphLayout = {
        ...(s.graphLayout ?? ({ positions: {} } as ProductionShot["graphLayout"])),
        viewport: structuredClone(curViewport),
      } as ProductionShot["graphLayout"];
    }
  };
  for (const sc of work.scenes ?? []) for (const s of sc.shots ?? []) overlayShot(s);
  for (const s of work.outdatedShots ?? []) overlayShot(s);
  for (const seq of work.shotSequences ?? []) if (seq.graph) overlayShot(seq.graph);
  return work;
}

export interface DocumentHistory<S> {
  /** Seed the current snapshot (no entry). No-op when already seeded. */
  init(state: S): void;
  /** Forget everything; optionally seed a fresh current snapshot. */
  reset(state?: S): void;
  /** Fold load-time repairs into the current snapshot without an entry
   *  (main's read-repair/graph-ensure pass mutates the cached document;
   *  that must neither become a step nor look like an external rewrite). */
  syncCurrent(state: S): void;
  /** Record one committed save. Returns false when nothing document-
   *  visible changed (the caller still persisted excluded fields). */
  record(next: S, meta?: HistoryCommitMeta, now?: number): boolean;
  current(): S | null;
  canUndo(): boolean;
  canRedo(): boolean;
  readonly size: number;
  readonly redoSize: number;
  /** The snapshot an undo/redo would restore, stacks untouched — the
   *  caller commits only after the restore actually persisted. */
  peekUndo(): S | null;
  peekRedo(): S | null;
  /** Settle a successful undo/redo restore with the document as it was
   *  actually written (post-normalize), reconciled for sharing. */
  commitUndo(actual: S): void;
  commitRedo(actual: S): void;
}

export function createDocumentHistory<S>(opts?: {
  limit?: number;
  coalesceMs?: number;
}): DocumentHistory<S> {
  const limit = opts?.limit ?? HISTORY_STEP_CAP;
  const defaultCoalesceMs = opts?.coalesceMs ?? 1200;
  let past: S[] = [];
  let future: S[] = [];
  let currentSnap: S | null = null;
  let activeKey: string | null = null;
  let activeAt = -Infinity;

  const adopt = (state: S): S => freezeSnapshot(currentSnap ? reconcileShare(currentSnap, state) : state);

  return {
    init(state) {
      if (currentSnap !== null) return;
      currentSnap = freezeSnapshot(state);
    },
    reset(state) {
      past = [];
      future = [];
      activeKey = null;
      activeAt = -Infinity;
      currentSnap = state !== undefined ? freezeSnapshot(state) : null;
    },
    syncCurrent(state) {
      if (currentSnap === null) {
        currentSnap = freezeSnapshot(state);
        return;
      }
      currentSnap = adopt(state);
    },
    record(next, meta, now = Date.now()) {
      if (meta?.suppress) return false;
      if (currentSnap === null) {
        currentSnap = freezeSnapshot(next);
        return false;
      }
      const snap = adopt(next);
      if (snap === currentSnap) {
        if (meta?.coalesceEnd) activeKey = null;
        return false;
      }
      const key = meta?.coalesceKey;
      const windowMs = meta?.coalesceMs ?? defaultCoalesceMs;
      const merge =
        !meta?.forceStep &&
        !!key &&
        key === activeKey &&
        future.length === 0 &&
        now - activeAt < windowMs;
      if (merge) {
        // Same open gesture: the step's pre-gesture snapshot already sits
        // on `past`; only the current state advances.
        currentSnap = snap;
        activeAt = now;
        if (meta?.coalesceEnd) activeKey = null;
        return true;
      }
      past.push(currentSnap);
      if (past.length > limit) past = past.slice(past.length - limit);
      future = [];
      currentSnap = snap;
      activeKey = key && !meta?.coalesceEnd ? key : null;
      activeAt = now;
      return true;
    },
    current: () => currentSnap,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    get size() {
      return past.length;
    },
    get redoSize() {
      return future.length;
    },
    peekUndo: () => past[past.length - 1] ?? null,
    peekRedo: () => future[future.length - 1] ?? null,
    commitUndo(actual) {
      const target = past.pop();
      if (target === undefined || currentSnap === null) return;
      future.push(currentSnap);
      currentSnap = freezeSnapshot(reconcileShare(target, actual));
      activeKey = null;
      activeAt = -Infinity;
    },
    commitRedo(actual) {
      const target = future.pop();
      if (target === undefined || currentSnap === null) return;
      past.push(currentSnap);
      if (past.length > limit) past = past.slice(past.length - limit);
      currentSnap = freezeSnapshot(reconcileShare(target, actual));
      activeKey = null;
      activeAt = -Infinity;
    },
  };
}
