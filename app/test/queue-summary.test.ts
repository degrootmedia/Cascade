import { describe, expect, it } from "vitest";
import { queueSummary, type JobRecord } from "../src/shared/ipc/jobs";

const j = (state: JobRecord["state"], progress?: number): JobRecord =>
  ({ id: Math.random().toString(), productionId: "p", kind: "generateImage", state, label: "x", startedAt: "", progress }) as unknown as JobRecord;

describe("queueSummary", () => {
  it("is idle with no active jobs", () => {
    expect(queueSummary([j("succeeded")]).fraction).toBeNull();
  });
  it("counts finished jobs and partial progress", () => {
    const s = queueSummary([j("succeeded"), j("running", 50), j("queued")]);
    expect(s).toMatchObject({ active: 2, queued: 1 });
    expect(s.fraction).toBeCloseTo(1.5 / 3);
  });
  it("flags failed and interrupted jobs", () => {
    expect(queueSummary([j("failed"), j("interrupted")]).needsAttention).toBe(2);
  });
});

