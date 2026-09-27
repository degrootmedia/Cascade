import { useEffect, useReducer } from "react";

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
  private queues = new Map<string, (() => Promise<unknown>)[]>();
  private active = new Set<string>();
  private listeners = new Set<() => void>();

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
    const queue = this.queues.get(key);
    return { running: this.active.has(key), pending: queue ? queue.length : 0 };
  }

  /** Queue `job` behind whatever is already running for `key`. `job` owns its
   *  own error handling (the queue swallows rejections so one failure can't
   *  stall the rest). */
  enqueue(key: string, job: () => Promise<unknown>): void {
    const queue = this.queues.get(key) ?? [];
    queue.push(job);
    this.queues.set(key, queue);
    // Already draining: the new pending count is the only change to publish.
    // Otherwise `drain` publishes after it takes the first job.
    if (this.active.has(key)) this.notify();
    else void this.drain(key);
  }

  /** Run the key's jobs back-to-back. `active` stays set across consecutive
   *  jobs so a button never flickers to idle between queued generations. */
  private async drain(key: string): Promise<void> {
    if (this.active.has(key)) return;
    if (!this.queues.get(key)?.length) return;
    this.active.add(key);
    for (;;) {
      const job = this.queues.get(key)?.shift();
      if (!job) break;
      // Published after the shift, so `pending` excludes the running job.
      this.notify();
      try {
        await job();
      } catch {
        /* the job surfaces its own error */
      }
    }
    this.active.delete(key);
    this.queues.delete(key);
    this.notify();
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
