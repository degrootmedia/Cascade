/**
 * GenerationQueue (renderer): a DISPLAY driven by the main-process ledger.
 * Scheduling (one job per target, FIFO) lives in main (job-scheduler.ts);
 * this window dispatches immediately and derives "Generating (N queued)"
 * from its in-flight calls plus the ledger's active jobs.
 */
import { describe, it, expect } from "vitest";
import { GenerationQueue, genButtonLabel, nextRegenRound, countByShot } from "../src/renderer/src/components/production/gen-queue.js";
import type { JobRecord } from "../src/shared/ipc.js";

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
const job = (id: string, kind: JobRecord["kind"], state: JobRecord["state"], shotId: string): JobRecord =>
  ({ id, productionId: "p", kind, state, label: "", shotId, startedAt: "" });

describe("GenerationQueue (display only)", () => {
  it("dispatches immediately and counts in-flight calls as running + queued", async () => {
    const q = new GenerationQueue();
    const log: string[] = [];
    const a = deferred("a", log);
    const b = deferred("b", log);
    q.enqueue("shot", a.run);
    q.enqueue("shot", b.run);
    expect(log).toEqual(["start:a", "start:b"]);
    expect(q.status("shot")).toEqual({ running: true, pending: 1 });
    a.release();
    b.release();
    await flush();
    expect(q.status("shot")).toEqual({ running: false, pending: 0 });
  });

  it("reads active counts from the ledger, including jobs from another window", () => {
    const q = new GenerationQueue();
    let notified = 0;
    q.subscribe(() => notified++);
    q.setLedgerJobs([job("1", "frameNode", "running", "s1"), job("2", "frameNode", "queued", "s1"), job("3", "frameNode", "succeeded", "s1")]);
    expect(q.status("image:s1")).toEqual({ running: true, pending: 1 });
    expect(q.status("image:s2")).toEqual({ running: false, pending: 0 });
    expect(notified).toBe(1);
    q.setLedgerJobs([]);
    expect(q.status("image:s1").running).toBe(false);
  });

  it("survives a rejecting or throwing job", async () => {
    const q = new GenerationQueue();
    q.enqueue("k", async () => { throw new Error("nope"); });
    q.enqueue("k", () => { throw new Error("sync"); });
    await flush();
    expect(q.status("k")).toEqual({ running: false, pending: 0 });
  });
});

describe("genButtonLabel", () => {
  it("is the idle verb when nothing is in flight", () => {
    expect(genButtonLabel({ running: false, pending: 0 }, "Generate")).toBe("Generate");
  });
  it("is the running label alone for a single job", () => {
    expect(genButtonLabel({ running: true, pending: 0 }, "Generate")).toMatch(/^Generating/);
  });
  it("appends the queued count when more wait", () => {
    expect(genButtonLabel({ running: true, pending: 2 }, "Generate")).toMatch(/\(2 queued\)$/);
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
