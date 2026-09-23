/**
 * Durable session-goal types (master plan step 08).
 *
 * Mirrors core's GoalRecord shape (the runtime owns validation); the app store
 * persists one per chat. A projection over production progress: `productionId`
 * links to the production whose file is the single authority for shot status —
 * the goal record must never store it.
 */
export type GoalStatus = "active" | "paused" | "done" | "blocked";

export interface SessionGoal {
  sessionId: string;
  goal: string;
  status: GoalStatus;
  updatedAt: string;
  /** Free-text where-the-work-stands note (never shot status). */
  lastCheckpoint?: string;
  /** The production this goal drives; progress is read from its file. */
  productionId?: string;
  /** Opt-in auto-continuation across restarts. Off unless explicitly set. */
  autoContinue?: boolean;
}

/** The fields the renderer may change directly (status / continuation / clear). */
export interface SessionGoalPatch {
  status?: GoalStatus;
  autoContinue?: boolean;
  /** Clear the goal entirely (the model re-sets it). */
  clear?: boolean;
}
