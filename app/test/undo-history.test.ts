import { describe, it, expect } from "vitest";
import { createUndoHistory } from "../src/renderer/src/components/production/undo-history.js";

describe("createUndoHistory", () => {
  it("undoes and redoes in order", () => {
    const h = createUndoHistory<string>();
    h.push("a", { force: true });
    h.push("b", { force: true });
    expect(h.canUndo()).toBe(true);
    expect(h.undo("c")).toBe("b");
    expect(h.undo("b")).toBe("a");
    expect(h.undo("a")).toBeNull();
    expect(h.canRedo()).toBe(true);
    expect(h.redo("a")).toBe("b");
    expect(h.redo("b")).toBe("c");
    expect(h.redo("c")).toBeNull();
  });

  it("a new push clears the redo stack", () => {
    const h = createUndoHistory<string>();
    h.push("a", { force: true });
    h.undo("b");
    expect(h.canRedo()).toBe(true);
    h.push("x", { force: true });
    expect(h.canRedo()).toBe(false);
  });

  it("coalesces bursts into one step unless forced, and dedupes identical states", () => {
    const h = createUndoHistory<string>({ coalesceMs: 1000 });
    expect(h.push("a", { now: 0 })).toBe(true);
    expect(h.push("b", { now: 500 })).toBe(false);
    expect(h.push("c", { now: 600, force: true })).toBe(true);
    expect(h.size).toBe(2);
    // Same state as the top is never a new step.
    expect(h.push("c", { now: 5000 })).toBe(false);
    expect(h.undo("z")).toBe("c");
    expect(h.undo("c")).toBe("a");
  });

  it("is bounded by the limit", () => {
    const h = createUndoHistory<number>({ limit: 3 });
    for (let i = 0; i < 6; i++) h.push(i, { force: true });
    expect(h.size).toBe(3);
    expect(h.undo(99)).toBe(5);
  });
});
