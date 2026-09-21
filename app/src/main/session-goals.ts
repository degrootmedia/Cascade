/**
 * Session goals — the durable per-chat objective (master plan step 08).
 * One JSON document per chat at `userData/session-goals/<sessionId>.json`,
 * written atomically via createStore (same pattern as sessions.ts).
 *
 * A PROJECTION over production progress: `productionId` links to the
 * production whose file is the single authority for shot status — nothing here
 * stores shot status. Distinct from step 02's todo list (todos are steps; the
 * goal is the objective; both link by session id).
 *
 * Validation reuses core's parse helpers so the CLI default and the session
 * store enforce the same caps; invalid input returns a clear ERROR string.
 */
import { createStore } from "./store.js";
import { formatGoal, parseGoalStatus, parseGoalText, type AgentTool, type GoalRecord } from "@core";
import type { SessionGoal, SessionGoalPatch } from "../shared/ipc.js";

const store = createStore<SessionGoal>({
  dirName: "session-goals",
  idOf: (d) => d.sessionId,
  sortKey: (d) => d.updatedAt,
});

/** Guard a session id before it becomes a filename (real ids are store-generated). */
export function validGoalSessionId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function checkSessionId(sessionId: string): void {
  if (!validGoalSessionId(sessionId)) throw new Error(`Invalid session id for goal: ${sessionId}`);
}

/** An unset goal (the renderer hides its panel when `goal` is empty). */
function emptyGoal(sessionId: string): SessionGoal {
  return { sessionId, goal: "", status: "active", updatedAt: new Date(0).toISOString() };
}

/** Load a chat's goal; a chat with none reads as an empty goal (not an error). */
export function loadSessionGoal(sessionId: string): SessionGoal {
  checkSessionId(sessionId);
  return store.load(sessionId) ?? emptyGoal(sessionId);
}

/** Model-facing goal_set: validate, merge (status/flag preserved unless done), persist. */
export function setSessionGoalFromModel(sessionId: string, goalRaw: unknown, productionIdRaw?: unknown): SessionGoal {
  checkSessionId(sessionId);
  const parsed = parseGoalText(goalRaw, productionIdRaw);
  if (!parsed.ok) throw new Error(parsed.error.replace(/^ERROR: /, ""));
  const prev = store.load(sessionId);
  const doc: SessionGoal = {
    sessionId,
    goal: parsed.goal,
    // A replaced objective always starts fresh: never inherit a prior status
    // (a "blocked" goal would otherwise refuse to continue) or its checkpoint
    // (which describes the old objective).
    status: "active",
    updatedAt: new Date().toISOString(),
    ...(parsed.productionId ? { productionId: parsed.productionId } : prev?.productionId ? { productionId: prev.productionId } : {}),
    ...(prev?.autoContinue ? { autoContinue: true } : {}),
  };
  store.save(doc);
  return doc;
}

/** Model-facing goal_update_status: requires an existing goal. */
export function updateSessionGoalStatus(sessionId: string, statusRaw: unknown, checkpointRaw?: unknown): SessionGoal {
  checkSessionId(sessionId);
  const parsed = parseGoalStatus(statusRaw, checkpointRaw);
  if (!parsed.ok) throw new Error(parsed.error.replace(/^ERROR: /, ""));
  const prev = store.load(sessionId);
  if (!prev || !prev.goal) throw new Error("no goal is set — call goal_set first");
  const doc: SessionGoal = {
    ...prev,
    status: parsed.patch.status,
    updatedAt: new Date().toISOString(),
  };
  if (parsed.patch.clearCheckpoint) delete doc.lastCheckpoint;
  else if (parsed.patch.lastCheckpoint !== undefined) doc.lastCheckpoint = parsed.patch.lastCheckpoint;
  store.save(doc);
  return doc;
}

/** Renderer-facing patch: pause/resume/mark done, toggle continuation, clear. */
export function patchSessionGoal(sessionId: string, patch: SessionGoalPatch): SessionGoal {
  checkSessionId(sessionId);
  if (patch.clear) {
    const doc = emptyGoal(sessionId);
    store.save(doc);
    return doc;
  }
  const prev = store.load(sessionId) ?? emptyGoal(sessionId);
  const doc: SessionGoal = {
    ...prev,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.autoContinue !== undefined ? (patch.autoContinue ? { autoContinue: true } : { autoContinue: false }) : {}),
    updatedAt: new Date().toISOString(),
  };
  store.save(doc);
  return doc;
}

/** A goal record without the session id, for core's formatter. */
function asRecord(doc: SessionGoal): GoalRecord {
  const { sessionId: _s, ...rec } = doc;
  void _s;
  return rec;
}

/**
 * Build the session-scoped goal tools for one chat. The host passes these as
 * extraTools so they shadow core's workspace-backed defaults. getSessionId is
 * read live; emit fires after the write persists (never before), fire-and-
 * forget so a turn never blocks on the renderer.
 */
export function makeSessionGoalTools(
  getSessionId: () => string,
  emit: (goal: SessionGoal) => void
): Record<string, AgentTool> {
  const goalRead: AgentTool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "goal_read",
        description: "Read this chat's durable goal (objective, status, checkpoint, linked production). Survives restarts.",
        parameters: { type: "object", properties: {} },
      },
    },
    run: async () => {
      try {
        return formatGoal(asRecord(loadSessionGoal(getSessionId())));
      } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
  const goalSet: AgentTool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "goal_set",
        description:
          "Set (or replace) this chat's objective. Optional productionId links it to a production; progress is read from the production file, never copied here. Safe: no approval needed, usable in plan mode.",
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
    run: async (args) => {
      try {
        const doc = setSessionGoalFromModel(getSessionId(), args.goal, args.productionId);
        emit(doc);
        return formatGoal(asRecord(doc));
      } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
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
    run: async (args) => {
      try {
        const doc = updateSessionGoalStatus(getSessionId(), args.status, args.lastCheckpoint);
        emit(doc);
        return formatGoal(asRecord(doc));
      } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
  return { goal_read: goalRead, goal_set: goalSet, goal_update_status: goalUpdateStatus };
}
