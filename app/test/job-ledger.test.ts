/**
 * Main-process job ledger (architecture hardening workstream 3,
 * recommendation 3 of the brief).
 *
 * One authoritative lifecycle for every generation: these tests pin the
 * ledger's contract —
 *   - every job is visible while running and terminal afterwards (no state a
 *     window can't learn by snapshotting + subscribing),
 *   - a window opened mid-generation sees the running job immediately,
 *   - completion clears it everywhere (one snapshot, many subscribers),
 *   - a crash after the provider returned leaves the job `interrupted` — a
 *     visible recoverable state, never an indefinite spinner,
 *   - the channel → job mapping covers every generation channel, and the
 *     canvas projection drives the same busy shape the windows render.
 */
import { describe, it, expect, vi } from "vitest";
import { createJobLedger } from "../src/main/jobs.js";
import { jobForChannel, jobLabel, jobsToCanvasBusy, type JobRecord } from "../src/shared/ipc.js";

const makeLedger = (persisted: JobRecord[] = []) => {
  const persistedRuns: JobRecord[][] = [];
  return {
    ledger: createJobLedger({
      newId: (() => { let i = 0; return () => `job-${++i}`; })(),
      persist: (active) => persistedRuns.push(active),
      loadPersisted: () => persisted,
    }),
    persistedRuns,
  };
};

describe("job ledger lifecycle", () => {
  it("records running jobs in the snapshot and clears them on success", () => {
    const { ledger } = makeLedger();
    const seen: string[][] = [];
    ledger.subscribe((s) => seen.push(s.jobs.map((j) => `${j.id}:${j.state}`)));
    const h = ledger.begin({ productionId: "p1", kind: "frameNode", label: "Generating a node frame", shotId: "s1" });
    const snap = ledger.snapshot("p1");
    expect(snap.jobs).toHaveLength(1);
    expect(snap.jobs[0].state).toBe("running");
    expect(snap.jobs[0].shotId).toBe("s1");
    h.succeed();
    expect(ledger.snapshot("p1").jobs[0].state).toBe("succeeded");
    expect(ledger.snapshot("p1").jobs[0].finishedAt).toBeDefined();
    expect(seen[seen.length - 1][0]).toBe("job-1:succeeded");
  });

  it("records failures with a reason", () => {
    const { ledger } = makeLedger();
    const h = ledger.begin({ productionId: "p1", kind: "video", label: "Generating a video" });
    h.fail("no credits");
    const job = ledger.snapshot("p1").jobs[0];
    expect(job.state).toBe("failed");
    expect(job.error).toBe("no credits");
  });

  it("scopes snapshots per production", () => {
    const { ledger } = makeLedger();
    ledger.begin({ productionId: "p1", kind: "video", label: "v" });
    ledger.begin({ productionId: "p2", kind: "boards", label: "b" });
    expect(ledger.snapshot("p1").jobs.map((j) => j.productionId)).toEqual(["p1"]);
    expect(ledger.snapshot().jobs).toHaveLength(2);
  });

  it("unsubscribes cleanly", () => {
    const { ledger } = makeLedger();
    let calls = 0;
    const off = ledger.subscribe(() => { calls++; });
    ledger.begin({ productionId: "p1", kind: "video", label: "v" });
    expect(calls).toBe(1);
    off();
    ledger.begin({ productionId: "p1", kind: "video", label: "v" });
    expect(calls).toBe(1);
  });

  it("keeps only a bounded window of finished jobs", () => {
    const { ledger } = makeLedger();
    for (let i = 0; i < 15; i++) {
      const h = ledger.begin({ productionId: "p1", kind: "video", label: "v" });
      h.succeed();
    }
    expect(ledger.snapshot("p1").jobs).toHaveLength(12);
  });
});

describe("crash reconciliation", () => {
  it("marks jobs that were running at crash time as interrupted (recoverable, not spinning)", () => {
    const persisted: JobRecord[] = [{
      id: "job-old", productionId: "p1", kind: "videoNode", state: "running",
      label: "Generating a video (node graph)", shotId: "s1", nodeId: "vid0",
      startedAt: "2026-10-12T00:00:00.000Z",
    }];
    const { ledger } = makeLedger(persisted);
    expect(ledger.interrupted).toHaveLength(1);
    const snap = ledger.snapshot("p1");
    expect(snap.jobs).toHaveLength(1);
    expect(snap.jobs[0].state).toBe("interrupted");
    expect(snap.jobs[0].finishedAt).toBeDefined();
    // Dismissing removes it from the visible ledger.
    ledger.dismiss("job-old");
    expect(ledger.snapshot("p1").jobs).toHaveLength(0);
    expect(ledger.interrupted).toHaveLength(0);
  });

  it("persists only non-terminal jobs", () => {
    const { ledger, persistedRuns } = makeLedger();
    ledger.begin({ productionId: "p1", kind: "video", label: "v" });
    const h = ledger.begin({ productionId: "p1", kind: "boards", label: "b" });
    h.succeed();
    const last = persistedRuns[persistedRuns.length - 1];
    expect(last.map((j) => j.state)).toEqual(["running"]);
  });
});

describe("channel → job mapping", () => {
  it("maps every generation channel with its kind, shot, and node ids", () => {
    expect(jobForChannel("production:generateVideoNode", ["p1", "s1", { nodeId: "vid1" }]))
      .toEqual({ kind: "videoNode", shotId: "s1", nodeId: "vid1" });
    expect(jobForChannel("production:generateBoards", ["p1"]))
      .toEqual({ kind: "boards", shotId: undefined, nodeId: undefined });
    expect(jobForChannel("production:regenerateBoard", ["p1", "s2"]))
      .toEqual({ kind: "boards", shotId: "s2", nodeId: undefined });
    expect(jobForChannel("cameraGrid:generate", ["p1", "s3", {}]))
      .toEqual({ kind: "cameraGrid", shotId: "s3", nodeId: undefined });
    expect(jobForChannel("production:generateTweenBlock", ["p1", "s4", "tw0", {}]))
      .toEqual({ kind: "tweenBlock", shotId: "s4", nodeId: "tw0" });
    expect(jobForChannel("suite:generate", ["p1", { mode: "generate" }]))
      .toEqual({ kind: "suite", shotId: undefined, nodeId: undefined });
    expect(jobForChannel("production:save", ["p1", {}])).toBeNull();
  });

  it("every mapped kind has a user-facing label", () => {
    for (const channel of Object.keys({
      "production:generateBoards": 1, "production:recheckBoard": 1, "production:editBoard": 1,
      "production:generateFrameNode": 1, "production:generateEditNode": 1,
      "production:generateUpscaleNode": 1, "cameraGrid:generate": 1,
      "production:generateVideo": 1, "production:generateVideoNode": 1,
      "production:upgradeDraftVideo": 1, "production:generateEditVideoNode": 1,
      "production:generateSequenceVideo": 1, "production:generateSequenceEditVideo": 1,
      "production:recheckVideo": 1, "production:generateTweenBlock": 1,
      "production:stitchTween": 1, "production:unstitchTween": 1,
      "production:generateStyleFrame": 1, "production:recheckStyleFrame": 1,
      "production:generateReferenceImage": 1, "production:generateCharacterSheet": 1,
      "production:generateMagicPrompts": 1, "production:regenerateMagicPrompt": 1,
      "suite:generate": 1, "production:generate3dModel": 1,
    })) {
      const job = jobForChannel(channel, ["p1", "s1", {}]);
      expect(job, channel).not.toBeNull();
      expect(jobLabel(job!.kind), channel).toBeTruthy();
    }
  });
});

describe("canvas busy projection", () => {
  it("projects only RUNNING node jobs onto the canvas busy shape", () => {
    const running: JobRecord[] = [
      { id: "a", productionId: "p1", kind: "frameNode", state: "running", label: "", shotId: "s1", startedAt: "" },
      { id: "b", productionId: "p1", kind: "videoNode", state: "running", label: "", shotId: "s2", nodeId: "vid1", startedAt: "" },
      { id: "c", productionId: "p1", kind: "editNode", state: "running", label: "", shotId: "s3", nodeId: "edit1", startedAt: "" },
      { id: "d", productionId: "p1", kind: "tweenBlock", state: "running", label: "", shotId: "s4", nodeId: "tw0", startedAt: "" },
      { id: "e", productionId: "p1", kind: "stitch", state: "running", label: "", shotId: "s5", startedAt: "" },
      { id: "f", productionId: "p1", kind: "sequenceVideo", state: "running", label: "", shotId: "seq1", nodeId: "vid0", startedAt: "" },
      { id: "g", productionId: "p1", kind: "frameNode", state: "succeeded", label: "", shotId: "s9", startedAt: "" },
    ];
    expect(jobsToCanvasBusy("p1", running)).toEqual({
      productionId: "p1",
      image: ["s1"],
      video: ["s2:vid1"],
      editVideo: [],
      editNodes: ["s3:edit1"],
      tween: { s4: "tw0" },
      stitching: ["s5"],
      sequences: ["seq1:vid0"],
    });
  });

  it("both windows agree from the ledger alone (no peer mirroring needed)", () => {
    const { ledger } = makeLedger();
    ledger.begin({ productionId: "p1", kind: "videoNode", label: "v", shotId: "s1", nodeId: "vid0" });
    const snap = ledger.snapshot("p1");
    const a = jobsToCanvasBusy("p1", snap.jobs);
    const b = jobsToCanvasBusy("p1", ledger.snapshot("p1").jobs);
    expect(a.video).toEqual(["s1:vid0"]);
    expect(b).toEqual(a);
  });
});
