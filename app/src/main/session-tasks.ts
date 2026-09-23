/**
 * Session task lists — the durable, model-maintained todo list (master plan
 * step 02). One JSON document per chat at
 * `userData/session-tasks/<sessionId>.json`, written atomically via
 * createStore (temp + rename, same pattern as sessions.ts).
 *
 * Todos are live agent state, not a permission gate (see core planmode.ts) and
 * not production progress: a todo may *reference* a shot id in its text but
 * must never duplicate shot status — the production file stays the single
 * authority for that. Validation reuses core's parseTodoList so the CLI
 * default (workspace `.cascade/tasks.json`) and the session store enforce the
 * same caps; invalid input comes back as a clear ERROR string, never a crash.
 */
import { createStore } from "./store.js";
import { formatTodoList, parseTodoList, type AgentTool } from "@core";
import type { SessionTasks, TodoItem } from "../shared/ipc.js";

const store = createStore<SessionTasks>({
  dirName: "session-tasks",
  idOf: (d) => d.sessionId,
  sortKey: (d) => d.updatedAt,
});

/** Guard a session id before it becomes a filename. Real ids are
 *  store-generated (`<base36>-<random>`) so this only rejects corrupt callers. */
export function validSessionId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function checkSessionId(sessionId: string): void {
  if (!validSessionId(sessionId)) throw new Error(`Invalid session id for task list: ${sessionId}`);
}

/** Load a chat's tasks; a chat with no list yet reads as empty (not an error). */
export function loadSessionTasks(sessionId: string): SessionTasks {
  checkSessionId(sessionId);
  return (
    store.load(sessionId) ?? {
      sessionId,
      updatedAt: new Date(0).toISOString(),
      items: [],
    }
  );
}

/**
 * Replace a chat's task list after core validation (status enum, item-count
 * and text/note caps). Throws a clear Error on invalid input — tool callers
 * catch it into an ERROR result string.
 */
export function saveSessionTasks(sessionId: string, rawItems: unknown): SessionTasks {
  checkSessionId(sessionId);
  const parsed = parseTodoList(rawItems);
  if (!parsed.ok) throw new Error(parsed.error.replace(/^ERROR: /, ""));
  const doc: SessionTasks = {
    sessionId,
    updatedAt: new Date().toISOString(),
    items: parsed.items,
  };
  store.save(doc);
  return doc;
}

/**
 * Build the session-scoped todo_read/todo_write tools for one chat. The host
 * passes these as extraTools so they shadow core's workspace-backed defaults
 * (Agent merges {...TOOLS, ...extraTools}). getSessionId is read live so the
 * tools follow the entry even if its session object is replaced. emit fires
 * after the write is persisted — never before, and fire-and-forget so the
 * agent turn never blocks on renderer acknowledgement.
 */
export function makeSessionTodoTools(
  getSessionId: () => string,
  emit: (tasks: SessionTasks) => void
): Record<string, AgentTool> {
  const todoRead: AgentTool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "todo_read",
        description:
          "Read this chat's durable task list. It survives restarts — consult it to report what is left.",
        parameters: { type: "object", properties: {} },
      },
    },
    run: async () => {
      try {
        return formatTodoList(loadSessionTasks(getSessionId()).items);
      } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
  const todoWrite: AgentTool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "todo_write",
        description:
          "Replace this chat's durable task list (full replace — send the complete list each time). Items: {id? (omit for new items), text, status: todo|running|done|blocked, note?}. Max 50 items. Safe: no approval needed, usable in plan mode.",
        parameters: {
          type: "object",
          properties: {
            items: {
              type: "array",
              description: "The complete new task list",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  text: { type: "string" },
                  status: { type: "string" },
                  note: { type: "string" },
                },
                required: ["text", "status"],
              },
            },
          },
          required: ["items"],
        },
      },
    },
    run: async (args) => {
      try {
        const doc = saveSessionTasks(getSessionId(), args.items);
        emit(doc); // persisted first, then the panel updates live
        return formatTodoList(doc.items);
      } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
  return { todo_read: todoRead, todo_write: todoWrite };
}

export type { TodoItem };
