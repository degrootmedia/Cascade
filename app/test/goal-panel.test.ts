/**
 * GoalPanel — renders the durable objective with status/continuation controls;
 * patches flow to the parent (which persists via IPC). No progress is shown
 * from this record (that lives in the production file).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { GoalPanel } from "../src/renderer/src/components/GoalPanel.js";
import type { SessionGoal, SessionGoalPatch } from "../src/shared/ipc.js";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

function render(goal: SessionGoal, onPatch: (p: SessionGoalPatch) => void = () => {}): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(GoalPanel, { goal, onPatch }));
  });
}

const goal = (over: Partial<SessionGoal> = {}): SessionGoal => ({
  sessionId: "s1",
  goal: "Ship the animatic",
  status: "active",
  updatedAt: "2026-09-20T00:00:00.000Z",
  ...over,
});

describe("GoalPanel", () => {
  it("renders the objective and pauses an active goal", () => {
    const patches: SessionGoalPatch[] = [];
    render(goal(), (p) => patches.push(p));
    expect(container.querySelector(".goal-text")?.textContent).toContain("Ship the animatic");
    act(() => {
      (container.querySelector(".goal-actions button") as HTMLButtonElement).click();
    });
    expect(patches).toEqual([{ status: "paused" }]);
  });

  it("shows Resume for a paused goal and toggles auto-continue", () => {
    const patches: SessionGoalPatch[] = [];
    render(goal({ status: "paused", autoContinue: true, lastCheckpoint: "step 2" }), (p) => patches.push(p));
    expect(container.querySelector(".goal-checkpoint")?.textContent).toContain("step 2");
    expect((container.querySelector(".goal-actions button") as HTMLButtonElement).textContent).toBe("Resume");
    const auto = container.querySelector(".goal-auto input") as HTMLInputElement;
    expect(auto.checked).toBe(true);
    act(() => {
      auto.click();
    });
    expect(patches).toEqual([{ autoContinue: false }]);
  });

  it("clears and marks done", () => {
    const patches: SessionGoalPatch[] = [];
    render(goal(), (p) => patches.push(p));
    const buttons = container.querySelectorAll(".goal-actions button");
    act(() => {
      (buttons[2] as HTMLButtonElement).click(); // Clear
    });
    expect(patches).toEqual([{ clear: true }]);
  });
});
