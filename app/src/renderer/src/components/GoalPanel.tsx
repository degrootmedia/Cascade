import type { SessionGoal, SessionGoalPatch } from "../types.js";

const STATUS_LABEL: Record<SessionGoal["status"], string> = {
  active: "Active",
  paused: "Paused",
  done: "Done",
  blocked: "Blocked",
};

/** Compact view + controls for a chat's durable goal. The objective is set by
 *  the model (goal_set); here the user can pause/resume, mark done, clear, and
 *  opt into auto-continuation. Progress is never shown from this record — it
 *  lives in the production file. */
export function GoalPanel({ goal, onPatch }: { goal: SessionGoal; onPatch: (patch: SessionGoalPatch) => void }) {
  const active = goal.status === "active";
  return (
    <section className="goal-panel" aria-label="Session goal">
      <header className="goal-header">
        <span className="goal-title">Goal</span>
        <span className={`goal-status goal-${goal.status}`}>{STATUS_LABEL[goal.status]}</span>
      </header>
      <p className="goal-text">{goal.goal}</p>
      {goal.lastCheckpoint && <p className="goal-checkpoint">Checkpoint: {goal.lastCheckpoint}</p>}
      {goal.productionId && <p className="goal-production" title="Progress is read from the production file">Production: {goal.productionId}</p>}
      <div className="goal-actions">
        <button
          type="button"
          onClick={() => onPatch({ status: active ? "paused" : "active" })}
          title={active ? "Pause the goal" : "Resume the goal"}
        >
          {active ? "Pause" : "Resume"}
        </button>
        <button type="button" onClick={() => onPatch({ status: "done" })} disabled={goal.status === "done"} title="Mark the goal done">
          Done
        </button>
        <button type="button" onClick={() => onPatch({ clear: true })} title="Clear the goal">Clear</button>
        <label className="goal-auto" title="Resume this goal automatically after a restart (still asks for approvals)">
          <input
            type="checkbox"
            checked={goal.autoContinue === true}
            disabled={goal.status === "done" || goal.status === "blocked"}
            onChange={(e) => onPatch({ autoContinue: e.target.checked })}
          />
          Auto-continue
        </label>
      </div>
    </section>
  );
}
