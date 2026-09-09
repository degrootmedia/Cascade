/**
 * Shot-table drag & drop:
 * - `resolveShotDrop` maps a drop line (between shots, or a scene-trailing
 *   boundary line) to where the dragged shot lands. The scene's LAST shot
 *   can't reorder within its own scene (it's already last), so its trailing
 *   line carries it across the boundary into the next scene; the production's
 *   final shot has no later position at all (null = refused).
 * - The handle drag is pointer-driven: pointerdown + travel past a slop begins
 *   a drag, the drop line under the pointer is highlighted, and pointerup
 *   resolves the reorder via `reorderShot`. The wiring is pinned end to end.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ShotTable, resolveShotDrop } from "../src/renderer/src/components/ShotTable.js";
import type { Production, ProductionScene } from "../src/shared/ipc.js";

function scene(number: number, ids: string[]): ProductionScene {
  return {
    number,
    title: `Scene ${number}`,
    shots: ids.map((id) => ({ id, number: "", audio: "", visual: "" })),
  };
}

function makeProd(scenes: ProductionScene[]): Production {
  return {
    meta: { id: "p1", name: "T" },
    scenes,
  } as unknown as Production;
}

describe("resolveShotDrop", () => {
  const scenes = [scene(1, ["a", "b"]), scene(2, ["c", "d"])];

  it("moves a shot before another shot when dropped on its inter-row line", () => {
    expect(resolveShotDrop(scenes, { before: "c" }, "b")).toEqual({ beforeShotId: "c" });
    expect(resolveShotDrop(scenes, { before: "a" }, "b")).toEqual({ beforeShotId: "a" });
  });

  it("refuses a shot's own inter-row line", () => {
    expect(resolveShotDrop(scenes, { before: "b" }, "b")).toBeNull();
  });

  it("sends a non-last shot to the end of its own scene on the trailing line", () => {
    expect(resolveShotDrop(scenes, { endScene: 1 }, "a")).toEqual({ endSceneNumber: 1 });
  });

  it("carries the scene's last shot across the boundary on its trailing line", () => {
    expect(resolveShotDrop(scenes, { endScene: 1 }, "b")).toEqual({ beforeShotId: "c" });
  });

  it("moves the scene's last shot into an empty next scene", () => {
    const more = [scene(1, ["a"]), scene(2, [])];
    expect(resolveShotDrop(more, { endScene: 1 }, "a")).toEqual({ endSceneNumber: 2 });
  });

  it("is a no-op for the production's final shot over its own trailing line", () => {
    expect(resolveShotDrop(scenes, { endScene: 2 }, "d")).toBeNull();
    expect(resolveShotDrop(scenes, { endScene: 99 }, "d")).toBeNull();
  });
});

/** Pointer-driven handle drag wiring: down → travel → hit line → resolve. */
describe("ShotTable drag wiring", () => {
  const g = globalThis as Record<string, any>;
  let container: HTMLElement;
  let root: Root | null = null;
  let reorderCalls: unknown[][];
  let origElementFromPoint: ((x: number, y: number) => Element | null) | undefined;

  function firePointer(el: Element, type: string, x = 0, y = 0): Event {
    const ev = new g.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clientX", { value: x });
    Object.defineProperty(ev, "clientY", { value: y });
    Object.defineProperty(ev, "button", { value: 0 });
    Object.defineProperty(ev, "pointerId", { value: 1 });
    el.dispatchEvent(ev);
    return ev;
  }

  /** Make document hit-testing return `hit` (a drop line) or nothing. */
  function hitTest(hit: Element | null) {
    (container.ownerDocument as any).elementFromPoint = () => hit;
  }

  beforeEach(() => {
    reorderCalls = [];
    g.window.cascade = {
      reorderShot: (...args: unknown[]) => { reorderCalls.push(args); return Promise.resolve(null); },
      insertShot: () => Promise.resolve(null),
      addScene: () => Promise.resolve(null),
      updateShot: () => Promise.resolve(null),
      deleteShot: () => Promise.resolve(null),
    };
    container = g.document.createElement("div");
    g.document.body.appendChild(container);
    origElementFromPoint = container.ownerDocument.elementFromPoint;
    hitTest(null); // jsdom has no hit-testing — default to nothing under the pointer
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container.remove();
    const doc = container.ownerDocument as any;
    if (origElementFromPoint) doc.elementFromPoint = origElementFromPoint;
    else delete doc.elementFromPoint;
  });

  function renderTable(prod: Production) {
    root = createRoot(container);
    act(() => { root!.render(createElement(ShotTable, { prod, onMutation: () => {} })); });
  }

  function zoneEls(section: Element) {
    return section.querySelectorAll(".shot-drop-zone");
  }

  it("carries the scene's last shot across the boundary when dropped on its trailing line", () => {
    renderTable(makeProd([scene(1, ["a", "b"]), scene(2, ["c", "d"])]));
    const scene1 = container.querySelectorAll(".shot-scene")[0];
    const bHandle = scene1.querySelectorAll(".shot-drag-handle")[1];
    const table = container.querySelector(".shot-table")!;

    firePointer(bHandle, "pointerdown", 10, 10);
    expect(table.className).not.toContain("dragging");
    act(() => { firePointer(bHandle, "pointermove", 40, 40); }); // past the slop → drag begins
    expect(table.className).toContain("dragging");

    const zones = zoneEls(scene1);
    expect(zones.length).toBe(3); // before-a, before-b, trailing
    const trailing = zones[zones.length - 1];
    hitTest(trailing);
    act(() => { firePointer(bHandle, "pointermove", 60, 60); });
    expect(trailing.classList.contains("active")).toBe(true);

    act(() => { firePointer(bHandle, "pointerup", 60, 60); });
    expect(reorderCalls).toEqual([["p1", "b", "c", undefined]]);
    expect(table.className).not.toContain("dragging");
  });

  it("moves a shot up onto an inter-row line", () => {
    renderTable(makeProd([scene(1, ["a", "b"])]));
    const scene1 = container.querySelector(".shot-scene")!;
    const bHandle = scene1.querySelectorAll(".shot-drag-handle")[1];
    act(() => { firePointer(bHandle, "pointermove", 5, 5); firePointer(bHandle, "pointerdown", 0, 0); });
    act(() => { firePointer(bHandle, "pointermove", 40, 40); });
    const beforeA = zoneEls(scene1)[0]; // before-a
    hitTest(beforeA);
    act(() => { firePointer(bHandle, "pointermove", 60, 60); });
    expect(beforeA.classList.contains("active")).toBe(true);
    act(() => { firePointer(bHandle, "pointerup", 60, 60); });
    expect(reorderCalls).toEqual([["p1", "b", "a", undefined]]);
  });

  it("refuses the production-final shot's boundary line instead of accepting a no-op", () => {
    renderTable(makeProd([scene(1, ["a", "b"])]));
    const scene1 = container.querySelector(".shot-scene")!;
    const bHandle = scene1.querySelectorAll(".shot-drag-handle")[1];
    act(() => { firePointer(bHandle, "pointermove", 5, 5); firePointer(bHandle, "pointerdown", 0, 0); });
    act(() => { firePointer(bHandle, "pointermove", 40, 40); });
    const trailing = zoneEls(scene1)[zoneEls(scene1).length - 1]; // end-1
    hitTest(trailing);
    act(() => { firePointer(bHandle, "pointermove", 60, 60); });
    expect(trailing.classList.contains("active")).toBe(false); // not offered
    act(() => { firePointer(bHandle, "pointerup", 60, 60); });
    expect(reorderCalls).toEqual([]);
  });

  it("does nothing on a plain handle click (no travel)", () => {
    renderTable(makeProd([scene(1, ["a", "b"])]));
    const bHandle = container.querySelector(".shot-scene")!.querySelectorAll(".shot-drag-handle")[1];
    act(() => { firePointer(bHandle, "pointerdown", 10, 10); });
    act(() => { firePointer(bHandle, "pointerup", 11, 11); });
    expect(reorderCalls).toEqual([]);
    expect(container.querySelector(".shot-table")!.className).not.toContain("dragging");
  });

  it("cancels a drag released off any drop line", () => {
    renderTable(makeProd([scene(1, ["a", "b"])]));
    const bHandle = container.querySelector(".shot-scene")!.querySelectorAll(".shot-drag-handle")[1];
    act(() => { firePointer(bHandle, "pointermove", 5, 5); firePointer(bHandle, "pointerdown", 0, 0); });
    act(() => { firePointer(bHandle, "pointermove", 40, 40); });
    expect(container.querySelector(".shot-table")!.className).toContain("dragging");
    hitTest(null);
    act(() => { firePointer(bHandle, "pointerup", 40, 40); });
    expect(container.querySelector(".shot-table")!.className).not.toContain("dragging");
    expect(reorderCalls).toEqual([]);
  });
});
