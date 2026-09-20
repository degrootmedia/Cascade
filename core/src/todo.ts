/**
 * Durable, model-maintained todo list (master plan step 02).
 *
 * The list is live agent state, not a permission gate (that is planmode.ts):
 * the model rewrites it as work progresses and the user watches. Persistence
 * is injected through the TodoPersistence seam — the default backs it with a
 * workspace scratch file (`.cascade/tasks.json`, the step-01 convention) so
 * the standalone CLI works; the Electron host injects a per-session store and
 * overrides these same tool names via extraTools.
 *
 * todo_read/todo_write never require approval and are never plan-gated: they
 * touch only the task list, never workspace files or shells.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { WorkspaceError } from "./workspace.js";
import type { AgentTool } from "./types.js";

export type TodoStatus = "todo" | "running" | "done" | "blocked";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  note?: string;
  updatedAt: string;
}

export const TODO_STATUSES: readonly TodoStatus[] = ["todo", "running", "done", "blocked"];

/** The model may hold at most this many items; more is rejected, not truncated. */
export const MAX_TODO_ITEMS = 50;
/** Per-item text/note length caps; oversized input is rejected, not truncated. */
export const MAX_TODO_TEXT_CHARS = 500;
export const MAX_TODO_NOTE_CHARS = 500;

/** Client-supplied ids are opaque tokens, never paths. */
const TODO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isStatus(s: unknown): s is TodoStatus {
  return typeof s === "string" && (TODO_STATUSES as readonly string[]).includes(s);
}

function newTodoId(index: number): string {
  return `t-${Date.now().toString(36)}-${index}-${randomBytes(2).toString("hex")}`;
}

export type ParseTodoList =
  | { ok: true; items: TodoItem[] }
  | { ok: false; error: string };

/**
 * Pure validation for a todo_write payload. Stamps updatedAt server-side and
 * generates ids for items that omit them. Never throws — failures come back
 * as { ok: false } so the tool result is a clear ERROR, not a crash.
 */
export function parseTodoList(raw: unknown, now: string = new Date().toISOString()): ParseTodoList {
  if (!Array.isArray(raw)) return { ok: false, error: "ERROR: todo_write expects {items: [...]}" };
  if (raw.length > MAX_TODO_ITEMS) {
    return { ok: false, error: `ERROR: too many todo items (${raw.length} > ${MAX_TODO_ITEMS}); split the work or mark some done` };
  }
  const seen = new Set<string>();
  const items: TodoItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Record<string, unknown> | null;
    if (!r || typeof r !== "object") {
      return { ok: false, error: `ERROR: todo item ${i} must be an object {text, status}` };
    }
    let id = typeof r.id === "string" && r.id.length > 0 ? r.id : newTodoId(i);
    if (!TODO_ID_RE.test(id)) {
      return { ok: false, error: `ERROR: todo item ${i} has an invalid id (1..64 chars of A-Z a-z 0-9 _ -)` };
    }
    if (seen.has(id)) return { ok: false, error: `ERROR: duplicate todo id "${id}"` };
    seen.add(id);
    if (typeof r.text !== "string" || r.text.trim().length === 0) {
      return { ok: false, error: `ERROR: todo item ${i} ("${id}") needs non-empty text` };
    }
    if (r.text.length > MAX_TODO_TEXT_CHARS) {
      return { ok: false, error: `ERROR: todo item ${i} ("${id}") text exceeds ${MAX_TODO_TEXT_CHARS} chars` };
    }
    if (!isStatus(r.status)) {
      return {
        ok: false,
        error: `ERROR: todo item ${i} ("${id}") has invalid status ${JSON.stringify(r.status)} — use one of: ${TODO_STATUSES.join(", ")}`,
      };
    }
    let note: string | undefined;
    if (r.note !== undefined && r.note !== null && String(r.note).length > 0) {
      note = String(r.note);
      if (note.length > MAX_TODO_NOTE_CHARS) {
        return { ok: false, error: `ERROR: todo item ${i} ("${id}") note exceeds ${MAX_TODO_NOTE_CHARS} chars` };
      }
    }
    items.push(note === undefined ? { id, text: r.text, status: r.status, updatedAt: now } : { id, text: r.text, status: r.status, note, updatedAt: now });
  }
  return { ok: true, items };
}

const STATUS_GLYPH: Record<TodoStatus, string> = {
  todo: "[ ]",
  running: "[~]",
  done: "[x]",
  blocked: "[!]",
};

/** Render the list as the text both tools return, so the model always sees current state. */
export function formatTodoList(items: TodoItem[]): string {
  if (items.length === 0) return "(no todos — the list is empty)";
  const lines = items.map((t) =>
    `${STATUS_GLYPH[t.status]} ${t.id} ${t.text}${t.note ? ` — ${t.note}` : ""}`
  );
  return `Todos (${items.length}):\n${lines.join("\n")}`;
}

/** Persistence seam the host injects. Load of a missing list returns []. */
export interface TodoPersistence {
  load(): Promise<TodoItem[]>;
  save(items: TodoItem[]): Promise<void>;
}

/** Workspace scratch file backing (`.cascade/tasks.json`, step-01 convention). */
export function workspaceTodoPersistence(workspaceRoot: string): TodoPersistence {
  const file = (): string => {
    if (!workspaceRoot) throw new WorkspaceError("cannot load todos outside the workspace");
    return path.join(path.resolve(workspaceRoot), ".cascade", "tasks.json");
  };
  return {
    async load(): Promise<TodoItem[]> {
      const f = file();
      let raw: string;
      try {
        raw = fs.readFileSync(f, "utf8");
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
        throw e;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new WorkspaceError(`todo store is corrupt (invalid JSON): .cascade/tasks.json`);
      }
      const items = (parsed as { items?: unknown }).items ?? [];
      const checked = parseTodoList(items);
      if (!checked.ok) throw new WorkspaceError(`todo store is corrupt (${checked.error})`);
      return checked.items;
    },
    async save(items: TodoItem[]): Promise<void> {
      const f = file();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items }, null, 2);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, f);
    },
  };
}

/**
 * Build the todo_read/todo_write tool specs over an injected persistence.
 * resolvePersistence maps the tool's workspaceRoot to a store, so one factory
 * serves the CLI default (workspace file) and host overrides alike.
 */
export function makeTodoTools(
  resolvePersistence: (workspaceRoot: string) => TodoPersistence
): Record<string, AgentTool> {
  const todoRead: AgentTool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "todo_read",
        description:
          "Read the durable task list for this session. It survives restarts — consult it to report what is left.",
        parameters: { type: "object", properties: {} },
      },
    },
    async run(_args, root) {
      const items = await resolvePersistence(root).load();
      return formatTodoList(items);
    },
  };
  const todoWrite: AgentTool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "todo_write",
        description:
          "Replace the durable task list (full replace — send the complete list each time). Items: {id? (omit for new items), text, status: todo|running|done|blocked, note?}. Max 50 items. Safe: no approval needed, usable in plan mode.",
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
    async run(args, root) {
      const parsed = parseTodoList(args.items);
      if (!parsed.ok) return parsed.error;
      await resolvePersistence(root).save(parsed.items);
      return formatTodoList(parsed.items);
    },
  };
  return { todo_read: todoRead, todo_write: todoWrite };
}
