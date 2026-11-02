import { describe, it, expect } from "vitest";
import { createJobScheduler } from "../src/main/job-scheduler.js";
import { createJobLedger, runWithJobLedger } from "../src/main/jobs.js";
import { jobTargetKey } from "../src/shared/ipc.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("job scheduler (main process)", () => {
  it("serializes one job per target key, FIFO, while other keys run concurrently", async () => {
    const s = createJobScheduler();
    const order: string[] = [];
    const a1 = await s.acquire({ key: "image:s1" });
    const a2p = s.acquire({ key: "image:s1" }).then((r) => { order.push("a2"); return r; });
    const b = await s.acquire({ key: "image:s2" });
    expect(b).not.toBeNull();
    await tick();
    expect(order).toEqual([]);
    a1!();
    const a2 = await a2p;
    expect(order).toEqual(["a2"]);
    a2!(); b!();
  });

  it("defaults the per-provider limit to 1 and honours overrides", async () => {
    const s = createJobScheduler({ providerLimits: { fast: 2 } });
    const got: string[] = [];
    const p1 = await s.acquire({ provider: "slow" });
    void s.acquire({ provider: "slow" }).then(() => got.push("slow2"));
    const f1 = await s.acquire({ provider: "fast" });
    const f2 = await s.acquire({ provider: "fast" });
    expect(f1 && f2).toBeTruthy();
    await tick();
    expect(got).toEqual([]);
    p1!();
    await tick();
    expect(got).toEqual(["slow2"]);
  });

  it("a cancelled waiter is dropped and never blocks the one behind it", async () => {
    const s = createJobScheduler();
    const first = await s.acquire({ key: "k" });
    let cancelled = false;
    const mid = s.acquire({ key: "k", isCancelled: () => cancelled });
    let lastGot = false;
    void s.acquire({ key: "k" }).then(() => { lastGot = true; });
    cancelled = true;
    s.poke();
    expect(await mid).toBeNull();
    first!();
    await tick();
    expect(lastGot).toBe(true);
  });

  it("maps targets to the keys the renderer used", () => {
    expect(jobTargetKey("frameNode", ["p", "s1", {}])).toBe("image:s1");
    expect(jobTargetKey("editNode", ["p", "s1", { nodeId: "e1" }])).toBe("edit:s1:e1");
    expect(jobTargetKey("suite", ["p", {}])).toBe("suite:p");
    expect(jobTargetKey("videoNode", ["p", "s1", {}])).toBeNull();
  });
});

describe("wrapper scheduling through the ledger", () => {
  it("records the 2nd same-target job as queued while the 1st runs; a failure does not stall it", async () => {
    const ledger = createJobLedger();
    let release1!: () => void;
    const first = runWithJobLedger(ledger, "production:generateFrameNode", ["p", "s1", {}], () => new Promise<void>((_r, rej) => { release1 = () => rej(new Error("unusable reference")); }));
    first.catch(() => {});
    const second = runWithJobLedger(ledger, "production:generateFrameNode", ["p", "s1", {}], async () => "ok");
    const other = runWithJobLedger(ledger, "production:generateFrameNode", ["p", "s2", {}], async () => "ok2");
    await tick();
    const states = () => ledger.snapshot("p").jobs.map((j) => j.state);
    expect(states()).toEqual(["submitting", "queued", "succeeded"]);
    expect(await other).toBe("ok2");
    release1();
    expect(await second).toBe("ok");
    expect(states()).toEqual(["failed", "succeeded", "succeeded"]);
  });

  it("cancelling a queued job removes it from the line", async () => {
    const ledger = createJobLedger();
    let release1!: () => void;
    const first = runWithJobLedger(ledger, "production:generateFrameNode", ["p", "s1", {}], () => new Promise<void>((r) => { release1 = r; }));
    const second = runWithJobLedger(ledger, "production:generateFrameNode", ["p", "s1", {}], async () => "never");
    second.catch(() => {});
    await tick();
    ledger.cancel(ledger.snapshot("p").jobs[1].id);
    await expect(second).rejects.toThrow(/cancelled/);
    release1();
    await first;
    expect(ledger.snapshot("p").jobs.map((j) => j.state)).toEqual(["succeeded", "cancelled"]);
  });
});
