/**
 * Main-process generation scheduler (queue step 1b).
 *
 * Owns concurrency so it survives a closed window and is identical for every
 * renderer and the chat agent. Constraints:
 *  - one job per target key at a time (what the renderer GenerationQueue
 *    used to enforce), FIFO within a key; distinct keys run concurrently;
 *  - a per-provider concurrency limit (default 1 until parallel jobs for that
 *    provider are verified safe; overridable through `providerLimits`).
 * One job finishing, failing or being cancelled always releases its slots, so
 * it can never block the jobs behind it.
 */
export interface SchedulerRequest {
  /** Target key; null/undefined = no per-target serialization. */
  key?: string | null;
  /** Provider id; null/undefined = no provider limit applied. */
  provider?: string | null;
  /** Polled while waiting; return true to abandon the wait (cancelled). */
  isCancelled?: () => boolean;
}

export interface JobScheduler {
  /** Resolves with a release function once every constraint allows the job to
   *  start, or with null when `isCancelled` became true while waiting. */
  acquire(req: SchedulerRequest): Promise<(() => void) | null>;
  /** Wake waiters so cancelled ones are dropped immediately. */
  poke(): void;
  /** Jobs waiting behind the given key. */
  waiting(key: string): number;
}

export interface SchedulerOptions {
  defaultProviderLimit?: number;
  providerLimits?: Record<string, number>;
}

export function createJobScheduler(opts: SchedulerOptions = {}): JobScheduler {
  const activeKeys = new Set<string>();
  const activeProvider = new Map<string, number>();
  const limitFor = (p: string): number => Math.max(1, opts.providerLimits?.[p] ?? opts.defaultProviderLimit ?? 1);
  interface Waiter { req: SchedulerRequest; resolve: (r: (() => void) | null) => void }
  const queue: Waiter[] = [];

  const canStart = (req: SchedulerRequest): boolean => {
    if (req.key && activeKeys.has(req.key)) return false;
    if (req.provider && (activeProvider.get(req.provider) ?? 0) >= limitFor(req.provider)) return false;
    return true;
  };

  const pump = (): void => {
    // Scan in arrival order; a blocked waiter never blocks later ones whose
    // constraints are free (distinct targets/providers keep moving).
    for (let i = 0; i < queue.length; ) {
      const w = queue[i];
      if (w.req.isCancelled?.()) {
        queue.splice(i, 1);
        w.resolve(null);
        continue;
      }
      if (!canStart(w.req)) { i++; continue; }
      queue.splice(i, 1);
      const { key, provider } = w.req;
      if (key) activeKeys.add(key);
      if (provider) activeProvider.set(provider, (activeProvider.get(provider) ?? 0) + 1);
      let released = false;
      w.resolve(() => {
        if (released) return;
        released = true;
        if (key) activeKeys.delete(key);
        if (provider) activeProvider.set(provider, Math.max(0, (activeProvider.get(provider) ?? 1) - 1));
        pump();
      });
    }
  };

  return {
    acquire(req) {
      return new Promise((resolve) => {
        queue.push({ req, resolve });
        pump();
      });
    },
    poke: pump,
    waiting(key) { return queue.filter((w) => w.req.key === key).length; },
  };
}
