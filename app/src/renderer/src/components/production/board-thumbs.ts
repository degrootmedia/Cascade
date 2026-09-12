/**
 * Storyboard thumbnail scheduler — one small interface hiding two behaviors
 * that used to trash the Step 3 load:
 *
 * 1. Icons-first ordering. Every BoardCard used to fire its `boardThumbnail`
 *    IPC the moment it mounted, so N large JPEG decodes raced N tiny icon
 *    `<img>` loads and icons popped in randomly between panels. Thumbnail
 *    work now waits for `afterFirstPaint` (double rAF — the first commit,
 *    icons included, is already on screen before any thumbnail IPC fires).
 * 2. Concurrency cap. Unbounded parallel `boardThumbnail` calls meant N full
 *    production disk-reads + N nativeImage resizes hit the main thread at
 *    once. The queue runs at most MAX_CONCURRENT_THUMBS tasks together; the
 *    rest wait their turn instead of competing.
 *
 * Pure scheduler — no Electron imports, so it stays unit-testable. The IPC
 * call itself stays in boards.tsx; only the *when* is scheduled here.
 */

/** Max simultaneous thumbnail tasks — enough to fill the viewport fast,
 *  few enough that icon decodes and the main thread stay responsive. */
export const MAX_CONCURRENT_THUMBS = 4;

/** Max shot ids per batch IPC (perf 1.4) — keeps any single response small
 *  while turning ~100 round-trips into a handful. */
export const BOARD_THUMB_BATCH_SIZE = 20;

let active = 0;
const waiting: Array<() => void> = [];

/** Run `task` when a concurrency slot frees up. FIFO; rejections propagate
 *  to the caller and still release the slot. */
export function queueBoardThumb<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      active += 1;
      task().then(resolve, reject).finally(() => {
        active -= 1;
        const next = waiting.shift();
        if (next) next();
      });
    };
    if (active < MAX_CONCURRENT_THUMBS) run();
    else waiting.push(run);
  });
}

let paintGate: Promise<void> | null = null;

/** Resolve once the browser has committed first paint (double rAF). Board
 *  thumbnails await this before queueing, so the storyboard's icons — plain
 *  `<img>` tags set during render — always win the race to the screen. */
export function afterFirstPaint(): Promise<void> {
  paintGate ??= new Promise<void>((resolve) => {
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 16);
    raf(() => raf(() => resolve()));
  });
  return paintGate;
}

/** Test seam — reset scheduler + paint state between cases. */
export function resetBoardThumbSchedulerForTests(): void {
  active = 0;
  waiting.length = 0;
  paintGate = null;
  pendingBatch.clear();
  if (batchTimer !== null) { clearTimeout(batchTimer); batchTimer = null; }
}

/**
 * Perf 1.4: coalescing batch fetch. Near-simultaneous per-card requests (one
 * microtask window after first paint) collapse into a single
 * `boardThumbnails` IPC per production instead of N `boardThumbnail` calls.
 * Shots missing from the batch result fall back to the single-shot path so
 * behavior is identical — just fewer round-trips.
 */
type BatchWaiter = { resolve: (v: string | null) => void; reject: (e: unknown) => void };
const pendingBatch = new Map<string, { prodId: string; shotId: string; waiter: BatchWaiter }>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
const BATCH_WINDOW_MS = 30;

function flushBatch(): void {
  batchTimer = null;
  if (pendingBatch.size === 0) return;
  // Group by production so one IPC covers one document load.
  const byProd = new Map<string, Array<{ key: string; shotId: string; waiter: BatchWaiter }>>();
  for (const [key, entry] of pendingBatch) {
    const list = byProd.get(entry.prodId) ?? [];
    list.push({ key, shotId: entry.shotId, waiter: entry.waiter });
    byProd.set(entry.prodId, list);
  }
  pendingBatch.clear();
  for (const [prodId, list] of byProd) {
    for (let i = 0; i < list.length; i += BOARD_THUMB_BATCH_SIZE) {
      const chunk = list.slice(i, i + BOARD_THUMB_BATCH_SIZE);
      const ids = chunk.map((c) => c.shotId);
      void queueBoardThumb(() => window.cascade.boardThumbnails(prodId, ids)).then(
        (res) => {
          for (const c of chunk) {
            const hit = res?.[c.shotId];
            if (hit) { c.waiter.resolve(hit); continue; }
            // Fall back to the single path for artwork-less / missing frames.
            window.cascade.boardThumbnail(prodId, c.shotId).then(
              (d) => c.waiter.resolve(d),
              (e) => c.waiter.reject(e),
            );
          }
        },
        (err) => {
          for (const c of chunk) c.waiter.reject(err);
        },
      );
    }
  }
}

/** Batched single-thumbnail fetch — same result as `boardThumbnail`, but
 *  coalesced with other cards mounting in the same window. Respects the
 *  concurrency cap via queueBoardThumb on flush. */
export function batchedBoardThumb(productionId: string, shotId: string): Promise<string | null> {
  // Prefer the batch channel when available (older preloads lack it).
  if (typeof window.cascade.boardThumbnails !== "function") {
    return queueBoardThumb(() => window.cascade.boardThumbnail(productionId, shotId));
  }
  return new Promise<string | null>((resolve, reject) => {
    pendingBatch.set(`${productionId}:${shotId}`, { prodId: productionId, shotId, waiter: { resolve, reject } });
    if (batchTimer === null) batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS);
  });
}

/** Direct chunked batch fetch for callers that already hold the shot list
 *  (e.g. a storyboard prefetch). Returns only shots that resolved. */
export async function fetchBoardThumbsBatched(productionId: string, shotIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!shotIds.length) return out;
  if (typeof window.cascade.boardThumbnails !== "function") {
    const settled = await Promise.all(
      shotIds.map((id) => queueBoardThumb(() => window.cascade.boardThumbnail(productionId, id)).then(
        (d) => ({ id, d }),
        () => ({ id, d: null as string | null }),
      )),
    );
    for (const { id, d } of settled) if (d) out[id] = d;
    return out;
  }
  for (let i = 0; i < shotIds.length; i += BOARD_THUMB_BATCH_SIZE) {
    const chunk = shotIds.slice(i, i + BOARD_THUMB_BATCH_SIZE);
    try {
      const res = await queueBoardThumb(() => window.cascade.boardThumbnails(productionId, chunk));
      Object.assign(out, res ?? {});
    } catch { /* per-chunk failure skips — singles retry on view */ }
  }
  return out;
}
