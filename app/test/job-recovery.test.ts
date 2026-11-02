/**
 * Restart recovery against a FAKE provider that supports task lookup, so the
 * whole path is testable without spending credits.
 */
import { describe, it, expect } from "vitest";
import { createJobLedger, recordProviderTask, resumeRecoveredJobs, runWithJobLedger } from "../src/main/jobs.js";
import { capabilitiesFor } from "../src/main/providers/capabilities.js";
import type { JobRecord } from "../src/shared/ipc.js";

/** Fake provider: submit() returns a task id; lookup(id) is ready after N polls. */
function fakeProvider(readyAfter: number) {
  const submits: string[] = [];
  const polls: Record<string, number> = {};
  return {
    submits,
    polls,
    submit(): string { const id = `task-${submits.length + 1}`; submits.push(id); return id; },
    lookup(id: string): "ready" | "rendering" {
      polls[id] = (polls[id] ?? 0) + 1;
      return polls[id] > readyAfter ? "ready" : "rendering";
    },
  };
}

const noSleep = async () => {};
// Shared "file" standing in for jobs.json across a simulated app restart.
const disk = () => {
  let saved: JobRecord[] = [];
  return { persist: (j: JobRecord[]) => { saved = JSON.parse(JSON.stringify(j)); }, load: () => saved };
};

describe("restart recovery with a resumable fake provider", () => {
  it("resumes by task id, completes, and never submits twice", async () => {
    const fake = fakeProvider(2);
    const d = disk();
    const caps = (j: JobRecord) => j.provider === "fake";
    // --- session 1: submit, provider accepts, then the app "quits" mid-generation.
    const l1 = createJobLedger({ persist: d.persist, loadPersisted: d.load, canResume: caps });
    let taskId = "";
    void runWithJobLedger(l1, "production:generateVideoNode", ["p1", "s1", { nodeId: "v1" }], async () => {
      taskId = fake.submit();
      recordProviderTask(taskId, "fake", "fake:model");
      await new Promise(() => {}); // never returns: process dies
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(l1.snapshot("p1").jobs[0]).toMatchObject({ state: "running", taskId, provider: "fake" });

    // --- session 2: reconcile the ledger from disk, then resume.
    const l2 = createJobLedger({ persist: d.persist, loadPersisted: d.load, canResume: caps });
    expect(l2.resumable).toHaveLength(1);
    expect(l2.get(l2.resumable[0].id)!.state).toBe("running");
    await resumeRecoveredJobs(l2, {
      sleep: noSleep,
      poll: async (job) => (fake.lookup(job.taskId!) === "ready" ? "done" : "pending"),
    });
    const job = l2.snapshot("p1").jobs[0];
    expect(job.state).toBe("succeeded");
    expect(job.taskId).toBe(taskId);       // provider task id never changed
    expect(fake.submits).toHaveLength(1);  // no duplicate submission
    expect(fake.polls[taskId]).toBe(3);
  });

  it("a job left in submitting becomes interrupted and is NOT submitted", async () => {
    const fake = fakeProvider(0);
    const d = disk();
    const l1 = createJobLedger({ persist: d.persist, loadPersisted: d.load });
    void runWithJobLedger(l1, "production:generateVideoNode", ["p1", "s1", {}], () => new Promise(() => {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(l1.snapshot("p1").jobs[0].state).toBe("submitting");
    const l2 = createJobLedger({ persist: d.persist, loadPersisted: d.load, canResume: () => true });
    const j = l2.snapshot("p1").jobs[0];
    expect(j.state).toBe("interrupted");
    expect(j.error).toMatch(/not resubmitted/);
    expect(l2.resumable).toHaveLength(0);
    expect(fake.submits).toHaveLength(0);
    expect(j.settings).toEqual(["s1", {}]); // Retry has what it needs
  });

  it("a non-resumable provider is interrupted with the reason, never resubmitted", async () => {
    const d = disk();
    const l1 = createJobLedger({ persist: d.persist, loadPersisted: d.load });
    void runWithJobLedger(l1, "production:generateVideoNode", ["p1", "s1", {}], async () => {
      recordProviderTask("t9", "legacy");
      await new Promise(() => {});
    });
    await new Promise((r) => setTimeout(r, 0));
    const l2 = createJobLedger({ persist: d.persist, loadPersisted: d.load, canResume: (j) => capabilitiesFor(j.provider).canResume });
    expect(l2.snapshot("p1").jobs[0].state).toBe("interrupted");
    expect(l2.snapshot("p1").jobs[0].error).toMatch(/does not support resuming/);
  });

  it("one resumed job failing does not stop another from completing", async () => {
    const d = disk();
    const base = { productionId: "p1", kind: "videoNode" as const, label: "v", startedAt: "2026-10-31T00:00:00Z", state: "running" as const, provider: "fake" };
    const l = createJobLedger({
      loadPersisted: () => [{ ...base, id: "a", taskId: "ta" }, { ...base, id: "b", taskId: "tb" }],
      canResume: () => true,
    });
    await resumeRecoveredJobs(l, {
      sleep: noSleep,
      poll: async (job) => { if (job.id === "a") throw new Error("provider said FAILED"); return "done"; },
    });
    expect(l.get("a")!.state).toBe("failed");
    expect(l.get("b")!.state).toBe("succeeded");
    void d;
  });

  it("local cancel stops resuming", async () => {
    const l = createJobLedger({
      loadPersisted: () => [{ id: "a", productionId: "p1", kind: "videoNode", label: "v", startedAt: "", state: "running", provider: "fake", taskId: "ta" }],
      canResume: () => true,
    });
    let polls = 0;
    await resumeRecoveredJobs(l, {
      sleep: async () => { l.cancel("a"); },
      poll: async () => { polls++; return "pending"; },
    });
    expect(l.get("a")!.state).toBe("cancelled");
    expect(polls).toBe(1);
  });
});
