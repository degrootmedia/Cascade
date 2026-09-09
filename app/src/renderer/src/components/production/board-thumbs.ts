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
}
