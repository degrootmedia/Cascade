/**
 * Bounded generation queue tests (master plan step 07 T4): the limit is never
 * exceeded, jobs hand off the instant one settles, and a failure is isolated
 * per job (siblings still complete).
 */
import { describe, it, expect } from "vitest";
import { createGenerationQueue, runBatch } from "../src/main/providers/generation-queue.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createGenerationQueue", () => {
  it("never exceeds the limit and hands slots off in order", async () => {
    const q = createGenerationQueue(2);
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    const job = (id: string, ms = 5) =>
      q.run(id, async () => {
        started.push(id);
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, ms));
        active--;
        return id;
      });
    const results = await Promise.all([job("a"), job("b"), job("c"), job("d"), job("e")]);
    expect(results).toEqual(["a", "b", "c", "d", "e"]);
    expect(peak).toBe(2);
    expect(q.active).toBe(0);
    expect(q.pending).toBe(0);
    expect(started.slice(0, 2)).toEqual(["a", "b"]);
  });

  it("clamps a non-positive limit to 1", async () => {
    const q = createGenerationQueue(0);
    expect(q.limit).toBe(1);
    let peak = 0;
    let active = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        q.run("x", async () => {
          active++;
          peak = Math.max(peak, active);
          await tick();
          active--;
        })
      )
    );
    expect(peak).toBe(1);
  });

  it("isolates a rejection — siblings still complete", async () => {
    const q = createGenerationQueue(2);
    const jobs = [
      { id: "ok1", run: async () => "one" },
      { id: "boom", run: async () => { throw new Error("vendor 500"); } },
      { id: "ok2", run: async () => "two" },
    ];
    const settled = await runBatch(q, jobs);
    expect(settled[0]).toEqual({ ok: true, value: "one" });
    expect(settled[1].ok).toBe(false);
    expect(settled[2]).toEqual({ ok: true, value: "two" });
    expect(q.active).toBe(0);
  });

  it("a synchronous throw in fn is caught, not crashed", async () => {
    const q = createGenerationQueue(1);
    await expect(q.run("t", () => { throw new Error("sync"); })).rejects.toThrow("sync");
    // The slot was released, so the next job runs.
    await expect(q.run("n", async () => "ok")).resolves.toBe("ok");
  });
});
