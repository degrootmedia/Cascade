/**
 * Bounded generation queue (master plan step 07 T4).
 *
 * One shared limiter for every batch submission ("generate N shots") so the
 * provider seam is the only place concurrency is governed — the previous
 * hand-rolled worker pools each had their own cap. Jobs are independent; a
 * failure is reported per job and never cancels siblings (the queue resolves
 * each job's promise with a settled result).
 *
 * No timers, no polling: a slot is handed to the next queued job the moment a
 * running one settles, so the limit is exact.
 */

export interface GenerationQueue {
  /** Run `fn` under the bound. Resolves/rejects with `fn`'s own outcome; a
   *  rejection never affects other jobs. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Jobs currently executing. */
  readonly active: number;
  /** Jobs waiting for a slot. */
  readonly pending: number;
  /** Hard cap on concurrent jobs. */
  readonly limit: number;
}

interface Waiter {
  start: () => void;
}

/**
 * Create a bounded queue. `limit` is clamped to ≥1; the default (4) matches
 * the board batch's historical cap that avoided vendor 429s.
 */
export function createGenerationQueue(limit = 4): GenerationQueue {
  const max = Math.max(1, Math.floor(limit) || 1);
  const waiters: Waiter[] = [];
  let active = 0;

  const next = (): void => {
    if (active >= max) return;
    const w = waiters.shift();
    if (!w) return;
    active++;
    w.start();
  };

  return {
    get active() {
      return active;
    },
    get pending() {
      return waiters.length;
    },
    get limit() {
      return max;
    },
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          // Run on a microtask so a synchronous throw can't settle the queue
          // recursion before the promise is wired.
          void Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
              active--;
              next();
            });
        };
        waiters.push({ start });
        next();
      });
    },
  };
}

/**
 * Run a batch through a queue and collect per-job settled results in input
 * order. A rejected job yields `{ ok: false, error }`; siblings are unaffected
 * (never an all-or-nothing `Promise.all`).
 */
export async function runBatch<T>(
  queue: GenerationQueue,
  jobs: (() => Promise<T>)[]
): Promise<({ ok: true; value: T } | { ok: false; error: unknown })[]> {
  return Promise.all(
    jobs.map((run) =>
      queue.run(run).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      )
    )
  );
}
