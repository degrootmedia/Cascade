/**
 * Durable, model-maintained task list types (master plan step 02).
 *
 * Live agent state — distinct from planmode.ts (the permission gate). A todo
 * may *reference* a shot id in its text but must never duplicate production
 * progress: the production file stays the single authority for shot status.
 *
 * Domain module of `shared/ipc.ts` (step 06 T1); the barrel re-exports it.
 */
export type TodoStatus = "todo" | "running" | "done" | "blocked";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  note?: string;
  updatedAt: string;
}

/** One chat's persisted task list (userData/session-tasks/<sessionId>.json). */
export interface SessionTasks {
  sessionId: string;
  updatedAt: string;
  items: TodoItem[];
}
