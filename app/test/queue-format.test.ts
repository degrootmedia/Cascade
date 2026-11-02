import { describe, expect, it } from "vitest";
import type { JobRecord } from "../src/shared/ipc.js";
import { clearFinishedIds, formatElapsed, friendlyModel, jobElapsedMs, jobMediaType, jobOpensNodeView, queueFooterText } from "../src/renderer/src/components/production/queue-format.js";

const job = (state: JobRecord["state"], extra: Partial<JobRecord> = {}): JobRecord =>
  ({ id: `${state}-${Math.random()}`, productionId: "p", kind: "videoNode", state, label: "x", startedAt: "2026-01-01T00:00:00.000Z", ...extra });

describe("queue panel formatting", () => {
  it("classifies media type and models", () => {
    expect(jobMediaType("videoNode")).toBe("video");
    expect(jobMediaType("frameNode")).toBe("image");
    expect(friendlyModel({ provider: "higgsfield-cli", model: "higgsfield-cli:kling-2" })).toBe("Kling 2 (Higgsfield)");
    expect(friendlyModel({})).toBe("");
  });
  it("formats elapsed time and freezes it for finished jobs", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(185_000)).toBe("3m 05s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    expect(jobElapsedMs(job("running"), t0 + 10_000)).toBe(10_000);
    expect(jobElapsedMs(job("succeeded", { finishedAt: "2026-01-01T00:00:05.000Z" }), t0 + 99_000)).toBe(5_000);
  });
  it("summarizes counts for the footer", () => {
    const jobs = [job("running"), job("running"), job("queued"), job("failed")];
    expect(queueFooterText(jobs)).toBe("2 generating, 1 queued, 1 failed");
    expect(queueFooterText([])).toBe("Nothing in the queue");
  });
  it("Clear finished removes Completed rows only, never Failed", () => {
    const done = job("succeeded");
    const jobs = [done, job("failed"), job("interrupted"), job("cancelled"), job("running")];
    expect(clearFinishedIds(jobs)).toEqual([done.id]);
  });
  it("routes node jobs to the node view", () => {
    expect(jobOpensNodeView({ kind: "videoNode", nodeId: undefined })).toBe(true);
    expect(jobOpensNodeView({ kind: "boards", nodeId: undefined })).toBe(false);
  });
});
