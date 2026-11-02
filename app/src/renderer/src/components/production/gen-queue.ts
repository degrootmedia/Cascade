import { useEffect, useReducer } from "react";
import { isActiveJobState, jobTargetKey, type JobRecord } from "../../../../shared/ipc.js";

/** Snapshot of one generation target's queue. */
export interface GenStatus {
  /** A job is running right now (stays set between consecutive queued jobs). */
  running: boolean;
  /** Jobs waiting behind the running one. */
  pending: number;
}

const IDLE: GenStatus = { running: false, pending: 0 };

/**
 * Per-key serial generation queue. Each key — a shot, a node (`shot:node`),
 * the suite, … — runs ONE job at a time; extra enqueues wait in order. Keys are
 * independent, so different frames can be in flight together. Pure (no React)
 * so the scheduling + counts are unit-testable; the surfaces read it through
 * `useGenStatus` and submit through `genQueue.enqueue`.
 *
 * The running state is authoritative here even where a surface also keeps its
 * own mirror set (the detached window's `canvas:busyChanged` mirror): a job the
 * other window started shows as busy through that set, while queued work is
 * counted locally.
 */
export class GenerationQueue {
  /** Calls dispatched from this window that have not settled yet, per key. */
  private inflight = new Map<string, number>();
  /** Active (queued/running/...) ledger jobs per key, from the main ledger. */
  private ledgerActive = new Map<string, number>();
  private listeners = new Set<() => void>();

  /** Feed the main-process ledger's jobs. The ledger owns scheduling, so this
   *  is the cross-window source of the busy/queued counts. */
  setLedgerJobs(jobs: JobRecord[]): void {
    const next = new Map<string, number>();
    for (const j of jobs) {
      if (!isActiveJobState(j.state)) continue;
      const key = jobTargetKey(j.kind, [j.productionId, j.shotId, j.nodeId ? { nodeId: j.nodeId } : {}]);
      if (key) next.set(key, (next.get(key) ?? 0) + 1);
    }
    let same = next.size === this.ledgerActive.size;
    if (same) for (const [k, v] of next) if (this.ledgerActive.get(k) !== v) same = false;
    this.ledgerActive = next;
    if (!same) this.notify();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  status(key: string): GenStatus {
    // Display only: the larger of what this window just dispatched and what the
    // ledger reports (covers jobs started from the other window / the agent).
    const total = Math.max(this.inflight.get(key) ?? 0, this.ledgerActive.get(key) ?? 0);
    return { running: total > 0, pending: Math.max(0, total - 1) };
  }

  /** Dispatch `job` immediately. The main-process scheduler serializes per
   *  target, so this window never holds work back. `job` owns its own error
   *  handling; rejections are swallowed here. */
  enqueue(key: string, job: () => Promise<unknown>): void {
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
    this.notify();
    const done = (): void => {
      const n = (this.inflight.get(key) ?? 1) - 1;
      if (n > 0) this.inflight.set(key, n);
      else this.inflight.delete(key);
      this.notify();
    };
    let p: Promise<unknown>;
    try { p = Promise.resolve(job()); } catch { p = Promise.resolve(); }
    void p.catch(() => { /* the job surfaces its own error */ }).then(done);
  }
}

/** One queue shared by every surface in a renderer window. */
export const genQueue = new GenerationQueue();

/** Stable queue keys per generation target — the host enqueues under the same
 *  key its button reads, so counts line up. */
export const genKeys = {
  image: (shotId: string) => `image:${shotId}`,
  edit: (shotId: string, nodeId: string) => `edit:${shotId}:${nodeId}`,
  cameraGrid: (shotId: string) => `camgrid:${shotId}`,
  upscale: (shotId: string) => `upscale:${shotId}`,
  suite: (prodId: string) => `suite:${prodId}`,
  reference: (id: string) => `ref:${id}`,
  character: (id: string) => `char:${id}`,
  styleFrame: (styleId: string) => `style:${styleId}`,
} as const;

/** Subscribe a component to a target's queue state. `null`/empty keys are
 *  inert (the hooks can't be called conditionally, so callers pass a key). */
export function useGenStatus(key: string | null | undefined): GenStatus {
  const bump = useReducer((n: number) => n + 1, 0)[1];
  useEffect(() => {
    if (!key) return;
    return genQueue.subscribe(bump);
  }, [key, bump]);
  return key ? genQueue.status(key) : IDLE;
}

/** The shared generate-button label: `idle` while nothing is in flight,
 *  "Generating…" while a job runs, and the queued count when more wait. */
export function genButtonLabel(status: GenStatus, idle: string): string {
  if (!status.running) return idle;
  return status.pending > 0 ? `Generating… (${status.pending} queued)` : "Generating…";
}

/** Split queued shot ids into the next storyboard regen round: ONE occurrence
 *  of each distinct shot (so distinct frames generate in parallel inside a
 *  single `regenerateBoards` batch, as before) plus what stays queued for the
 *  following round. Pure so the storyboard's count/batching is unit-tested. */
export function nextRegenRound(pending: string[]): { batch: string[]; remaining: string[] } {
  const batch: string[] = [];
  const seen = new Set<string>();
  const remaining: string[] = [];
  for (const id of pending) {
    if (seen.has(id)) remaining.push(id);
    else {
      seen.add(id);
      batch.push(id);
    }
  }
  return { batch, remaining };
}

/** Queued-job count per shot id (button labels read this). */
export function countByShot(ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = (out[id] ?? 0) + 1;
  return out;
}
