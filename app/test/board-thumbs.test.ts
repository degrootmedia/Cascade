import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CONCURRENT_THUMBS,
  afterFirstPaint,
  queueBoardThumb,
  resetBoardThumbSchedulerForTests,
} from "../src/renderer/src/components/production/board-thumbs.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("queueBoardThumb", () => {
  beforeEach(() => resetBoardThumbSchedulerForTests());

  it("caps concurrency and drains FIFO", async () => {
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const tasks = Array.from({ length: MAX_CONCURRENT_THUMBS + 2 }, (_, i) =>
      queueBoardThumb(
        () =>
          new Promise<number>((resolve) => {
            started.push(i);
            releases.push(() => resolve(i));
          }),
      ),
    );
    await tick();
    // Only a full window runs; the rest wait.
    expect(started).toEqual(Array.from({ length: MAX_CONCURRENT_THUMBS }, (_, i) => i));
    // Release in FIFO order — each release frees a slot, so the next queued
    // task starts (appending its own release) before the next tick.
    for (let i = 0; i < MAX_CONCURRENT_THUMBS + 2; i++) {
      releases[i]();
      await tick();
    }
    await expect(Promise.all(tasks)).resolves.toEqual(
      Array.from({ length: MAX_CONCURRENT_THUMBS + 2 }, (_, i) => i),
    );
    expect(started).toEqual(Array.from({ length: MAX_CONCURRENT_THUMBS + 2 }, (_, i) => i));
  });

  it("releases the slot on rejection", async () => {
    const gate = queueBoardThumb(() => Promise.reject(new Error("thumb failed")));
    await expect(gate).rejects.toThrow("thumb failed");
    // A follow-up task still runs — the failed one didn't leak its slot.
    await expect(queueBoardThumb(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});

describe("afterFirstPaint", () => {
  beforeEach(() => resetBoardThumbSchedulerForTests());

  it("resolves once and memoizes", async () => {
    // setup-dom.ts stubs rAF as a no-op — install one that actually fires.
    const g = globalThis as Record<string, unknown>;
    const prev = g.requestAnimationFrame;
    g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0) as unknown as number;
    try {
      const a = afterFirstPaint();
      const b = afterFirstPaint();
      expect(a).toBe(b);
      await expect(a).resolves.toBeUndefined();
    } finally {
      g.requestAnimationFrame = prev;
    }
  });
});
