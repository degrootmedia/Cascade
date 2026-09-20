/**
 * Session goal tests (master plan step 08): the per-chat store round-trips,
 * validation rejects bad input, a restart restores from disk, the file never
 * carries shot status, and the session tool factory persists-before-emit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-goals-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));

import {
  loadSessionGoal,
  setSessionGoalFromModel,
  updateSessionGoalStatus,
  patchSessionGoal,
  makeSessionGoalTools,
} from "../src/main/session-goals.js";
import { ipcContract, type SessionGoal } from "../src/shared/ipc.js";

const SID = "sess-goal-1";

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("session-goals store", () => {
  it("round-trips a goal through atomic save and load", () => {
    const saved = setSessionGoalFromModel(SID, "Ship the animatic", "prod-9");
    expect(saved.goal).toBe("Ship the animatic");
    expect(saved.status).toBe("active");
    expect(saved.productionId).toBe("prod-9");
    expect(loadSessionGoal(SID)).toEqual(saved);
    const leftovers = fs.readdirSync(path.join(dataDir, "session-goals")).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("an untouched chat reads as an empty goal, not an error", () => {
    expect(loadSessionGoal("never")).toEqual({ sessionId: "never", goal: "", status: "active", updatedAt: new Date(0).toISOString() });
  });

  it("rejects invalid input and session ids", () => {
    expect(() => setSessionGoalFromModel(SID, "  ")).toThrow("non-empty");
    expect(() => updateSessionGoalStatus(SID, "eventually")).toThrow("invalid goal status");
    expect(() => loadSessionGoal("../../evil")).toThrow("Invalid session id");
    expect(fs.existsSync(path.join(dataDir, "session-goals"))).toBe(false);
  });

  it("update_status requires an existing goal", () => {
    expect(() => updateSessionGoalStatus(SID, "done")).toThrow("no goal is set");
  });

  it("restart restores from disk: the file is the truth", () => {
    const saved = setSessionGoalFromModel(SID, "survive restart");
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "session-goals", `${SID}.json`), "utf8"));
    expect(raw.goal).toBe("survive restart");
    expect(raw.sessionId).toBe(SID);
    expect(loadSessionGoal(SID)).toEqual(saved);
  });
});

describe("goal is a projection, not a shot-status authority (step 08 T4)", () => {
  it("the goal file carries no shot/production-progress fields", () => {
    setSessionGoalFromModel(SID, "Drive the production", "prod-1");
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "session-goals", `${SID}.json`), "utf8"));
    // Exact key set — the only production link is the id; progress stays in
    // the production file.
    expect(Object.keys(raw).sort()).toEqual(["goal", "productionId", "sessionId", "status", "updatedAt"]);
    for (const forbidden of ["shots", "scenes", "shotStatus", "artwork", "videoPath", "stepDone", "currentStep"]) {
      expect(raw, `goal file must not carry ${forbidden}`).not.toHaveProperty(forbidden);
    }
    expect(typeof raw.status).toBe("string");
  });
});

describe("renderer patch (pause / resume / done / clear / continuation)", () => {
  it("toggles status, continuation, and clears", () => {
    setSessionGoalFromModel(SID, "Objective");
    expect(patchSessionGoal(SID, { status: "paused" }).status).toBe("paused");
    expect(patchSessionGoal(SID, { autoContinue: true }).autoContinue).toBe(true);
    expect(patchSessionGoal(SID, { status: "done" }).status).toBe("done");
    const cleared = patchSessionGoal(SID, { clear: true });
    expect(cleared.goal).toBe("");
    expect(cleared.autoContinue).toBeUndefined();
  });
});

describe("makeSessionGoalTools (host bridge)", () => {
  it("goal_set persists then emits; goal_read returns the same text", async () => {
    const emitted: SessionGoal[] = [];
    const tools = makeSessionGoalTools(() => SID, (g) => void emitted.push(g));
    expect(tools.goal_set.requiresApproval).toBe(false);
    expect(tools.goal_read.requiresApproval).toBe(false);
    expect(tools.goal_update_status.requiresApproval).toBe(false);
    const set = await tools.goal_set.run({ goal: "Move it forward", productionId: "p1" }, "/ws");
    expect(String(set)).toContain("Move it forward");
    expect(emitted).toHaveLength(1);
    expect(emitted[0].goal).toBe(loadSessionGoal(SID).goal);
    const read = await tools.goal_read.run({}, "/ws");
    expect(read).toBe(set);
  });

  it("invalid writes return ERROR text, persist nothing, emit nothing", async () => {
    const emitted: SessionGoal[] = [];
    const tools = makeSessionGoalTools(() => SID, (g) => void emitted.push(g));
    const out = await tools.goal_set.run({ goal: "" }, "/ws");
    expect(String(out)).toContain("ERROR");
    expect(emitted).toHaveLength(0);
    expect(loadSessionGoal(SID).goal).toBe("");
  });
});

describe("goals IPC contract", () => {
  it("exposes goals:get for the renderer's mount-time read", () => {
    expect(ipcContract["goals:get"]).toEqual({ method: "getSessionGoal", kind: "invoke" });
    expect(ipcContract["goals:set"]).toEqual({ method: "setSessionGoal", kind: "invoke" });
  });
});
