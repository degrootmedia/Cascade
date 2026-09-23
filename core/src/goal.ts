/**
 * Durable session goal (master plan step 08).
 *
 * One objective per chat, persisted and resumable. Live runtime state — not a
 * permission gate (that is planmode.ts) and not a task list (step 02's todos
 * are the steps; the goal is the objective; both are linked by session id).
 *
 * The goal is a PROJECTION over production progress: when it references a
 * `productionId`, progress is read from the production file (the single
 * authority for shot status). The goal record must never store shot status.
 *
 * Persistence is injected through the GoalPersistence seam — the default backs
 * it with a workspace scratch file (`.cascade/goal.json`, the step-01
 * convention) so the standalone CLI works; the Electron host injects a
 * per-session store via extraTools.
 *
 * goal_read/goal_set/goal_update_status never require approval and are never
 * plan-gated: they touch only the goal record, never workspace files/shells.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { WorkspaceError } from "./workspace.js";
import type { AgentTool } from "./types.js";

export type GoalStatus = "active" | "paused" | "done" | "blocked";

export interface GoalRecord {
  /** The objective, in the user's/model's words. */
  goal: string;
  status: GoalStatus;
  updatedAt: string;
  /** Free-text checkpoint of where the work stood (never shot status). */
  lastCheckpoint?: string;
  /** The production this goal drives, when any — progress is read from it. */
  productionId?: string;
  /** Opt-in auto-continuation across restarts. Off unless explicitly set. */
  autoContinue?: boolean;
}

export const GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused", "done", "blocked"];

/** Objective text cap; oversized input is rejected, not truncated. */
export const MAX_GOAL_TEXT_CHARS = 1000;
/** Checkpoint text cap. */
export const MAX_GOAL_CHECKPOINT_CHARS = 1000;

function isStatus(s: unknown): s is GoalStatus {
  return typeof s === "string" && (GOAL_STATUSES as readonly string[]).includes(s);
}

export type ParseGoalText =
  | { ok: true; goal: string; productionId?: string }
  | { ok: false; error: string };

/** Pure validation for a goal_set payload. Never throws. */
export function parseGoalText(raw: unknown, productionIdRaw?: unknown): ParseGoalText {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "ERROR: goal_set expects a non-empty {goal}" };
  }
  if (raw.length > MAX_GOAL_TEXT_CHARS) {
    return { ok: false, error: `ERROR: goal text exceeds ${MAX_GOAL_TEXT_CHARS} chars` };
  }
  let productionId: string | undefined;
  if (productionIdRaw !== undefined && productionIdRaw !== null && String(productionIdRaw).length > 0) {
    productionId = String(productionIdRaw);
    if (productionId.length > 128) return { ok: false, error: "ERROR: productionId is too long" };
  }
  return { ok: true, goal: raw.trim(), ...(productionId ? { productionId } : {}) };
}

export interface GoalStatusPatch {
  status: GoalStatus;
  lastCheckpoint?: string;
  /** True when the caller explicitly passed an empty checkpoint, meaning clear it. */
  clearCheckpoint?: boolean;
}

export type ParseGoalStatus =
  | { ok: true; patch: GoalStatusPatch }
  | { ok: false; error: string };

/** Pure validation for a goal_update_status payload. Never throws. */
export function parseGoalStatus(raw: unknown, checkpointRaw?: unknown): ParseGoalStatus {
  if (!isStatus(raw)) {
    return { ok: false, error: `ERROR: invalid goal status ${JSON.stringify(raw)} — use one of: ${GOAL_STATUSES.join(", ")}` };
  }
  if (checkpointRaw !== undefined && checkpointRaw !== null) {
    const text = String(checkpointRaw);
    // An explicit empty checkpoint clears the stored one (distinct from
    // "absent", which leaves it untouched).
    if (text.length === 0) return { ok: true, patch: { status: raw, clearCheckpoint: true } };
    if (text.length > MAX_GOAL_CHECKPOINT_CHARS) {
      return { ok: false, error: `ERROR: checkpoint exceeds ${MAX_GOAL_CHECKPOINT_CHARS} chars` };
    }
    return { ok: true, patch: { status: raw, lastCheckpoint: text } };
  }
  return { ok: true, patch: { status: raw } };
}

/** Render the goal as the text the tools return. */
export function formatGoal(rec: GoalRecord | null): string {
  if (!rec) return "(no goal set)";
  const bits = [`status: ${rec.status}`];
  if (rec.productionId) bits.push(`production: ${rec.productionId}`);
  if (rec.autoContinue) bits.push("auto-continue: on");
  bits.push(`updated: ${rec.updatedAt}`);
  const lines = [`Goal: ${rec.goal}`, bits.join(" · ")];
  if (rec.lastCheckpoint) lines.push(`Checkpoint: ${rec.lastCheckpoint}`);
  return lines.join("\n");
}

/** Persistence seam the host injects. Load of a missing goal returns null. */
export interface GoalPersistence {
  load(): Promise<GoalRecord | null>;
  save(rec: GoalRecord): Promise<void>;
}

/** Workspace scratch file backing (`.cascade/goal.json`, step-01 convention). */
export function workspaceGoalPersistence(workspaceRoot: string): GoalPersistence {
  const file = (): string => {
    if (!workspaceRoot) throw new WorkspaceError("cannot load a goal outside the workspace");
    return path.join(path.resolve(workspaceRoot), ".cascade", "goal.json");
  };
  return {
    async load(): Promise<GoalRecord | null> {
      const f = file();
      let raw: string;
      try {
        raw = fs.readFileSync(f, "utf8");
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw e;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new WorkspaceError("goal store is corrupt (invalid JSON): .cascade/goal.json");
      }
      const rec = parsed as Partial<GoalRecord>;
      if (typeof rec?.goal !== "string" || !isStatus(rec.status)) {
        throw new WorkspaceError("goal store is corrupt (missing goal/status)");
      }
      return {
        goal: rec.goal,
        status: rec.status,
        updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : new Date().toISOString(),
        ...(rec.lastCheckpoint ? { lastCheckpoint: rec.lastCheckpoint } : {}),
        ...(rec.productionId ? { productionId: rec.productionId } : {}),
        ...(rec.autoContinue ? { autoContinue: true } : {}),
      };
    },
    async save(rec: GoalRecord): Promise<void> {
      const f = file();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const payload = JSON.stringify({ version: 1, ...rec }, null, 2);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, f);
    },
  };
}

// ---- continuation gate (step 08 T3) ---------------------------------------

export interface ContinuationPlan {
  /** Whether the agent should be prompted to continue. */
  continue: boolean;
  /** Why not, when `continue` is false. */
  reason: string;
}

/**
 * Pure gate: auto-continuation runs only when the user opted in AND the goal
 * is active. Off by default (autoContinue absent/false → never continue).
 * Done/blocked/paused stop it. Continuing goes through the normal agent turn,
 * so the approval gate still governs every mutating action.
 */
export function planContinuation(rec: GoalRecord | null, autoContinue: boolean): ContinuationPlan {
  if (!autoContinue || rec?.autoContinue !== true) return { continue: false, reason: "auto-continuation is off" };
  if (!rec || !rec.goal.trim()) return { continue: false, reason: "no goal" };
  if (rec.status === "done") return { continue: false, reason: "goal is done" };
  if (rec.status === "blocked") return { continue: false, reason: "goal is blocked" };
  if (rec.status === "paused") return { continue: false, reason: "goal is paused" };
  return { continue: true, reason: "active goal" };
}

/** The instruction text for the continuation turn (a normal agent turn). */
export function continuationPrompt(rec: GoalRecord): string {
  const prod = rec.productionId ? ` The work targets production ${rec.productionId}; read its current progress from the production file before acting.` : "";
  const cp = rec.lastCheckpoint ? ` Last checkpoint: ${rec.lastCheckpoint}` : "";
  return (
    `Continue the active goal: ${rec.goal}.${prod}${cp} ` +
    `Check the current state first, then take the next concrete step. ` +
    `Ask for approval whenever a step needs it, and mark the goal done or blocked when it is.`
  );
}

/**
 * Build the goal tools over an injected persistence. resolvePersistence maps
 * the tool's workspaceRoot to a store, so one factory serves the CLI default
 * and host overrides alike.
 */
export function makeGoalTools(
  resolvePersistence: (workspaceRoot: string) => GoalPersistence
): Record<string, AgentTool> {
  const goalRead: AgentTool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "goal_read",
        description: "Read this session's durable goal (objective, status, checkpoint, linked production). Survives restarts.",
        parameters: { type: "object", properties: {} },
      },
    },
    async run(_args, root) {
      return formatGoal(await resolvePersistence(root).load());
    },
  };
  const goalSet: AgentTool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "goal_set",
        description:
          "Set (or replace) this session's objective. Optional productionId links it to a production; progress is always read from the production file, never copied here. Safe: no approval needed, usable in plan mode.",
        parameters: {
          type: "object",
          properties: {
            goal: { type: "string", description: "The objective, in one clear sentence" },
            productionId: { type: "string", description: "Optional production id this goal drives" },
          },
          required: ["goal"],
        },
      },
    },
    async run(args, root) {
      const parsed = parseGoalText(args.goal, args.productionId);
      if (!parsed.ok) return parsed.error;
      const store = resolvePersistence(root);
      const prev = await store.load();
      const rec: GoalRecord = {
        goal: parsed.goal,
        // A replaced objective always starts fresh: never inherit a prior
        // status (a "blocked" goal would otherwise refuse to continue) or its
        // checkpoint (which describes the old objective).
        status: "active",
        updatedAt: new Date().toISOString(),
        ...(parsed.productionId ? { productionId: parsed.productionId } : prev?.productionId ? { productionId: prev.productionId } : {}),
        ...(prev?.autoContinue ? { autoContinue: true } : {}),
      };
      await store.save(rec);
      return formatGoal(rec);
    },
  };
  const goalUpdateStatus: AgentTool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "goal_update_status",
        description:
          "Update the goal's status (status → active|paused|done|blocked) and optionally a short checkpoint of where the work stands. Safe: no approval needed, usable in plan mode.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string", description: "one of: active, paused, done, blocked" },
            lastCheckpoint: { type: "string", description: "Optional where-the-work-stands note" },
          },
          required: ["status"],
        },
      },
    },
    async run(args, root) {
      const parsed = parseGoalStatus(args.status, args.lastCheckpoint);
      if (!parsed.ok) return parsed.error;
      const store = resolvePersistence(root);
      const prev = await store.load();
      if (!prev) return "ERROR: no goal is set — call goal_set first";
      const rec: GoalRecord = {
        ...prev,
        status: parsed.patch.status,
        updatedAt: new Date().toISOString(),
      };
      if (parsed.patch.clearCheckpoint) delete rec.lastCheckpoint;
      else if (parsed.patch.lastCheckpoint !== undefined) rec.lastCheckpoint = parsed.patch.lastCheckpoint;
      await store.save(rec);
      return formatGoal(rec);
    },
  };
  return { goal_read: goalRead, goal_set: goalSet, goal_update_status: goalUpdateStatus };
}
