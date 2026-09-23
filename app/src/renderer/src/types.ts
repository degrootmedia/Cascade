import type { CascadeApi, ChatAttachment, DisplayItem, SessionGoal, SessionGoalPatch, SessionTasks, TodoItem, TodoStatus } from "../../shared/ipc.js";

declare global {
  interface Window {
    cascade: CascadeApi;
  }
}

export type { ChatAttachment, DisplayItem, SessionGoal, SessionGoalPatch, SessionTasks, TodoItem, TodoStatus } from "../../shared/ipc.js";