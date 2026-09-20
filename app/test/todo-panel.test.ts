/**
 * TodoPanel — the read-only task-list section renders every status distinctly
 * and only exists when there is something to show (App hides it on empty).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { TodoPanel } from "../src/renderer/src/components/TodoPanel.js";
import type { SessionTasks } from "../src/shared/ipc.js";

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

function render(tasks: SessionTasks): string {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(TodoPanel, { tasks }));
  });
  return container.innerHTML;
}

const tasks = (items: SessionTasks["items"]): SessionTasks => ({
  sessionId: "s1",
  updatedAt: "2026-09-20T00:00:00.000Z",
  items,
});

describe("TodoPanel", () => {
  it("renders each status with its text and note", () => {
    const html = render(
      tasks([
        { id: "a", text: "research", status: "done", updatedAt: "t" },
        { id: "b", text: "implement", status: "running", note: "step 1", updatedAt: "t" },
        { id: "c", text: "blocked thing", status: "blocked", updatedAt: "t" },
        { id: "d", text: "later", status: "todo", updatedAt: "t" },
      ])
    );
    expect(html).toContain("research");
    expect(html).toContain("implement");
    expect(html).toContain("step 1");
    expect(html).toContain("2 open · 4 total");
    expect(container.querySelectorAll(".todo-item").length).toBe(4);
    expect(container.querySelector(".todo-done .todo-text")?.textContent).toBe("research");
  });
});
