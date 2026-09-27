/**
 * GenerationQueue: per-key serial generation queue behind the "Generating (N
 * queued)" buttons. Pins the scheduling contract the buttons rely on —
 * one job per key at a time, extra enqueues counted and run in order, distinct
 * keys concurrent, and `running` never flickering off between consecutive jobs.
 */
import { describe, it, expect } from "vitest";
import { GenerationQueue, genButtonLabel, nextRegenRound, countByShot } from "../src/renderer/src/components/production/gen-queue.js";

/** A job whose completion the test controls, recording start/end order. */
function deferred(label: string, log: string[]) {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  return {
    release,
    run: async () => {
      log.push(`start:${label}`);
      await gate;
      log.push(`end:${label}`);
    },
  };
}

const flush = () => new Promise<void>((res) => setTimeout(res, 0));

describe("GenerationQueue", () => {
  it("runs one job per key at a time, in enqueue order", async () => {
    const q = new GenerationQueue();
    const log: string[] = [];
    const a = deferred("a", log);
    const b = deferred("b", log);
    q.enqueue("shot", a.run);
    q.enqueue("shot", b.run);
    // Only the first has started; the second waits.
    expect(log).toEqual(["start:a"]);
    expect(q.status("shot")).toEqual({ running: true, pending: 1 });
    a.release();
    await flush();
    expect(log).toEqual(["start:a", "end:a", "start:b"]);
    b.release();
    await flush();
    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(q.status("shot")).toEqual({ running: false, pending: 0 });
  });

  it("keeps `running` set between consecutive jobs (no idle flicker)", async () => {
    const q = new GenerationQueue();
    const log: string[] = [];
    const a = deferred("a", log);
    const b = deferred("b", log);
    const seen: { running: boolean; pending: number }[] = [];
    q.subscribe(() => seen.push(q.status("shot")));
    q.enqueue("shot", a.run);
    q.enqueue("shot", b.run);
    a.release();
    await flush();
    // No notification ever reported idle with work still queued.
    expect(seen.some((s) => !s.running && s.pending > 0)).toBe(false);
    b.release();
    await flush();
  });

  it("runs independent keys concurrently", async () => {
    const q = new GenerationQueue();
    const log: string[] = [];
    const a = deferred("a", log);
    const b = deferred("b", log);
    q.enqueue("shot1", a.run);
    q.enqueue("shot2", b.run);
    expect(log).toEqual(["start:a", "start:b"]);
    expect(q.status("shot1").running).toBe(true);
    expect(q.status("shot2").running).toBe(true);
    a.release();
    b.release();
    await flush();
    expect(q.status("shot1").running).toBe(false);
    expect(q.status("shot2").running).toBe(false);
  });

  it("survives a rejecting job and keeps draining", async () => {
    const q = new GenerationQueue();
    const log: string[] = [];
    q.enqueue("k", async () => {
      log.push("boom");
      throw new Error("nope");
    });
    q.enqueue("k", async () => {
      log.push("after");
    });
    await flush();
    expect(log).toEqual(["boom", "after"]);
    expect(q.status("k")).toEqual({ running: false, pending: 0 });
  });
});

describe("genButtonLabel", () => {
  it("is the idle verb when nothing is in flight", () => {
    expect(genButtonLabel({ running: false, pending: 0 }, "Generate")).toBe("Generate");
  });
  it("is 'Generating…' alone for a single job", () => {
    expect(genButtonLabel({ running: true, pending: 0 }, "Generate")).toBe("Generating…");
  });
  it("appends the queued count when more wait", () => {
    expect(genButtonLabel({ running: true, pending: 2 }, "Generate")).toBe("Generating… (2 queued)");
  });
});

describe("nextRegenRound", () => {
  it("takes one occurrence per shot, leaving duplicates for the next round", () => {
    expect(nextRegenRound(["a", "a", "b"])).toEqual({ batch: ["a", "b"], remaining: ["a"] });
  });
  it("is empty when nothing is queued", () => {
    expect(nextRegenRound([])).toEqual({ batch: [], remaining: [] });
  });
  it("keeps distinct shots concurrent in one batch", () => {
    expect(nextRegenRound(["a", "b", "c"])).toEqual({ batch: ["a", "b", "c"], remaining: [] });
  });
});

describe("countByShot", () => {
  it("counts repeats per id", () => {
    expect(countByShot(["a", "a", "b"])).toEqual({ a: 2, b: 1 });
  });
});

