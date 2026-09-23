import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  continuationPrompt,
  formatGoal,
  makeGoalTools,
  parseGoalStatus,
  parseGoalText,
  planContinuation,
  workspaceGoalPersistence,
  type GoalPersistence,
  type GoalRecord,
} from "../src/goal.js";

const rec = (over: Partial<GoalRecord> = {}): GoalRecord => ({
  goal: "Ship the animatic",
  status: "active",
  updatedAt: "2026-09-20T00:00:00.000Z",
  ...over,
});

function memStore(seed: GoalRecord | null = null): GoalPersistence & { saved: GoalRecord[] } {
  let cur = seed;
  const saved: GoalRecord[] = [];
  return {
    saved,
    async load() {
      return cur;
    },
    async save(r) {
      saved.push(r);
      cur = r;
    },
  };
}

describe("parseGoalText", () => {
  it("accepts a non-empty goal and an optional productionId", () => {
    expect(parseGoalText("Do the thing").ok).toBe(true);
    const r = parseGoalText("Do the thing", "prod-1");
    expect(r.ok && r.productionId).toBe("prod-1");
  });
  it("rejects empty/oversized goals and long ids", () => {
    expect(parseGoalText("   ").ok).toBe(false);
    expect(parseGoalText("x".repeat(1001)).ok).toBe(false);
    expect(parseGoalText("ok", "p".repeat(200)).ok).toBe(false);
    expect(parseGoalText(42).ok).toBe(false);
  });
});

describe("parseGoalStatus", () => {
  it("accepts valid statuses with an optional checkpoint", () => {
    expect(parseGoalStatus("done").ok).toBe(true);
    expect(parseGoalStatus("blocked", "waiting on user").ok).toBe(true);
  });
  it("rejects invalid statuses and oversized checkpoints", () => {
    expect(parseGoalStatus("eventually").ok).toBe(false);
    expect(parseGoalStatus("active", "x".repeat(1001)).ok).toBe(false);
  });
});

describe("formatGoal", () => {
  it("renders an unset goal and a rich record", () => {
    expect(formatGoal(null)).toContain("no goal");
    const text = formatGoal(rec({ productionId: "p1", autoContinue: true, lastCheckpoint: "step 2" }));
    expect(text).toContain("Goal: Ship the animatic");
    expect(text).toContain("status: active");
    expect(text).toContain("production: p1");
    expect(text).toContain("Checkpoint: step 2");
  });
});

describe("planContinuation (opt-in gate)", () => {
  it("is off by default and when the flag is absent/false", () => {
    expect(planContinuation(rec(), false).continue).toBe(false);
    expect(planContinuation(rec(), true).continue).toBe(false); // record flag not set
    expect(planContinuation(rec({ autoContinue: false }), true).continue).toBe(false);
  });
  it("continues only an active, opted-in goal", () => {
    expect(planContinuation(rec({ autoContinue: true }), true).continue).toBe(true);
    expect(planContinuation(rec({ autoContinue: true, status: "paused" }), true).continue).toBe(false);
    expect(planContinuation(rec({ autoContinue: true, status: "done" }), true).continue).toBe(false);
    expect(planContinuation(rec({ autoContinue: true, status: "blocked" }), true).continue).toBe(false);
    expect(planContinuation(null, true).continue).toBe(false);
  });
  it("the continuation turn reads production progress instead of copying it", () => {
    const text = continuationPrompt(rec({ productionId: "p1", lastCheckpoint: "shot 2" }));
    expect(text).toContain("read its current progress from the production file");
    expect(text).toContain("Ask for approval");
  });
});

describe("makeGoalTools over an injected store", () => {
  it("goal_set persists; goal_read returns the same state", async () => {
    const store = memStore();
    const tools = makeGoalTools(() => store);
    expect(tools.goal_set.requiresApproval).toBe(false);
    expect(tools.goal_read.requiresApproval).toBe(false);
    expect(tools.goal_update_status.requiresApproval).toBe(false);
    const set = await tools.goal_set.run({ goal: "Ship it", productionId: "p1" }, "/ws");
    expect(String(set)).toContain("Ship it");
    expect(await tools.goal_read.run({}, "/ws")).toBe(set);
    expect(store.saved).toHaveLength(1);
  });

  it("goal_update_status requires an existing goal and records the patch", async () => {
    const tools = makeGoalTools(() => memStore());
    expect(String(await tools.goal_update_status.run({ status: "done" }, "/ws"))).toContain("ERROR");
    const store = memStore();
    const tools2 = makeGoalTools(() => store);
    await tools2.goal_set.run({ goal: "G" }, "/ws");
    const out = await tools2.goal_update_status.run({ status: "blocked", lastCheckpoint: "need input" }, "/ws");
    expect(String(out)).toContain("status: blocked");
    expect(String(out)).toContain("need input");
  });

  it("invalid writes return ERROR text and never touch the store", async () => {
    const store = memStore();
    const tools = makeGoalTools(() => store);
    const out = await tools.goal_set.run({ goal: "  " }, "/ws");
    expect(String(out)).toContain("ERROR");
    expect(store.saved).toHaveLength(0);
  });

  it("a replaced objective starts active with no stale checkpoint/flags lost", async () => {
    const store = memStore(
      rec({ status: "blocked", lastCheckpoint: "old objective, waiting on user", productionId: "p1", autoContinue: true })
    );
    const tools = makeGoalTools(() => store);
    await tools.goal_set.run({ goal: "A brand new objective" }, "/ws");
    const saved = store.saved.at(-1)!;
    expect(saved.goal).toBe("A brand new objective");
    expect(saved.status).toBe("active");
    expect(saved.lastCheckpoint).toBeUndefined();
    // productionId and autoContinue carry over (they describe the session, not
    // the old objective).
    expect(saved.productionId).toBe("p1");
    expect(saved.autoContinue).toBe(true);
  });

  it("an explicit empty checkpoint clears it; absent leaves it", async () => {
    const parsed = parseGoalStatus("active", "");
    expect(parsed.ok && parsed.patch.clearCheckpoint).toBe(true);
    // absent checkpoint does not set a clear flag
    const absent = parseGoalStatus("active");
    expect(absent.ok && absent.patch.clearCheckpoint === undefined).toBe(true);
    const absentCheckpoint = parseGoalStatus("active", undefined);
    expect(absentCheckpoint.ok && absentCheckpoint.patch.lastCheckpoint === undefined).toBe(true);

    const store = memStore();
    const tools = makeGoalTools(() => store);
    await tools.goal_set.run({ goal: "G" }, "/ws");
    await tools.goal_update_status.run({ status: "active", lastCheckpoint: "midway" }, "/ws");
    expect(store.saved.at(-1)!.lastCheckpoint).toBe("midway");
    const out = await tools.goal_update_status.run({ status: "active", lastCheckpoint: "" }, "/ws");
    expect(store.saved.at(-1)!.lastCheckpoint).toBeUndefined();
    expect(String(out)).not.toContain("Checkpoint:");
  });
});

describe("workspaceGoalPersistence", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-goal-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("round-trips through .cascade/goal.json and is empty by default", async () => {
    const p = workspaceGoalPersistence(root);
    expect(await p.load()).toBeNull();
    await p.save(rec({ autoContinue: true }));
    const loaded = await p.load();
    expect(loaded?.goal).toBe("Ship the animatic");
    expect(loaded?.autoContinue).toBe(true);
    expect(fs.existsSync(path.join(root, ".cascade", "goal.json"))).toBe(true);
  });

  it("a corrupt store surfaces a clear error", async () => {
    fs.mkdirSync(path.join(root, ".cascade"), { recursive: true });
    fs.writeFileSync(path.join(root, ".cascade", "goal.json"), "{not json", "utf8");
    await expect(workspaceGoalPersistence(root).load()).rejects.toThrow("corrupt");
  });
});
