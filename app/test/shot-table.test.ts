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
    expect(reorderCalls).toEqual([["p1", "b", "c", undefined, 0]]);
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
    expect(reorderCalls).toEqual([["p1", "b", "a", undefined, 0]]);
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

/**
 * Draft resync (Issue 1): the audio/visual cells keep local drafts that commit
 * on blur. An incoming save from elsewhere (AI refine, undo, a board-card
 * edit) must resync into unfocused cells so a later blur can never write a
 * stale draft back over the newer value; a focused cell defers and wins at blur.
 */
describe("ShotTable draft resync", () => {
  const g = globalThis as Record<string, any>;
  let container: HTMLElement;
  let root: Root | null = null;
  let updateCalls: unknown[][];

  function prodWith(audio: string, visual = "v-old"): Production {
    return {
      meta: { id: "p1", name: "T" },
      scenes: [{ number: 1, title: "Scene 1", shots: [{ id: "a", number: "0100", audio, visual }] }],
    } as unknown as Production;
  }

  function renderProd(prod: Production) {
    act(() => { root!.render(createElement(ShotTable, { prod, onMutation: () => {} })); });
  }

  function audioCell(): HTMLTextAreaElement {
    return container.querySelector(".shot-cell.audio") as HTMLTextAreaElement;
  }

  function visualCell(): HTMLTextAreaElement {
    return container.querySelector(".shot-cell.visual") as HTMLTextAreaElement;
  }

  /** Drive a controlled textarea the way the other renderer tests do. */
  function typeInto(el: HTMLTextAreaElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set
      ?? Object.getOwnPropertyDescriptor(g.window.HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
      setter!.call(el, text);
      el.dispatchEvent(new g.Event("input", { bubbles: true }));
    });
  }

  function keyEnter(el: HTMLTextAreaElement, isComposing: boolean) {
    const ev = new g.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(ev, "isComposing", { value: isComposing });
    act(() => { el.dispatchEvent(ev); });
    return ev;
  }

  beforeEach(() => {
    updateCalls = [];
    g.window.cascade = {
      reorderShot: () => Promise.resolve(null),
      insertShot: () => Promise.resolve(null),
      addScene: () => Promise.resolve(null),
      updateShot: (...args: unknown[]) => { updateCalls.push(args); return Promise.resolve(null); },
      deleteShot: () => Promise.resolve(null),
      setShotNumber: () => Promise.resolve(null),
    };
    container = g.document.createElement("div");
    g.document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container.remove();
  });

  it("adopts an incoming save while unfocused and commits nothing", () => {
    renderProd(prodWith("old"));
    expect(audioCell().value).toBe("old");
    renderProd(prodWith("NEW-FROM-AI"));
    expect(audioCell().value).toBe("NEW-FROM-AI");
    expect(updateCalls).toEqual([]);
  });

  it("keeps the focused draft through an incoming save; the draft wins at blur", () => {
    renderProd(prodWith("old"));
    const cell = audioCell();
    act(() => { cell.focus(); });
    typeInto(cell, "draft");
    expect(cell.value).toBe("draft");
    // Same tree, newer props, cell still focused: the draft must survive.
    renderProd(prodWith("NEW-FROM-AI"));
    expect(cell.value).toBe("draft");
    act(() => { cell.blur(); });
    expect(updateCalls).toEqual([["p1", "a", { audio: "draft", visual: "v-old" }]]);
  });

  // Reported bug: edit Visual, click DIRECTLY into Audio (no neutral click
  // between), edit there — both edits must survive. The first commit's
  // snapshot only lands after the switch (async IPC), so it is applied
  // mid-sequence the way ProductionWorkspace would apply it.
  it("direct Visual -> Audio switch commits Visual first and keeps both edits", () => {
    renderProd(prodWith("a-old", "v-old"));
    const visual = visualCell();
    act(() => { visual.focus(); });
    typeInto(visual, "v-new");
    // Direct switch: one click, but the browser dispatches focusout and
    // focusin as separate events and React flushes between them — model
    // that with separate acts (a single act batches the two together).
    const audio = audioCell();
    act(() => { visual.blur(); });
    act(() => { audio.focus(); });
    // The panel being left commits immediately on the switch...
    expect(updateCalls).toEqual([["p1", "a", { audio: "a-old", visual: "v-new" }]]);
    // ...and its text is not wiped by the focus gap between the two cells.
    expect(visualCell().value).toBe("v-new");
    typeInto(audio, "a-new");
    // The first commit's snapshot lands while Audio is being edited.
    renderProd(prodWith("a-old", "v-new"));
    expect(audioCell().value).toBe("a-new");
    expect(visualCell().value).toBe("v-new");
    act(() => { audio.blur(); });
    // The Audio commit carries the committed Visual, never the stale one.
    expect(updateCalls).toEqual([
      ["p1", "a", { audio: "a-old", visual: "v-new" }],
      ["p1", "a", { audio: "a-new", visual: "v-new" }],
    ]);
  });

  it("direct Audio -> Visual switch commits Audio first and keeps both edits", () => {
    renderProd(prodWith("a-old", "v-old"));
    const audio = audioCell();
    act(() => { audio.focus(); });
    typeInto(audio, "a-new");
    const visual = visualCell();
    act(() => { audio.blur(); });
    act(() => { visual.focus(); });
    expect(updateCalls).toEqual([["p1", "a", { audio: "a-new", visual: "v-old" }]]);
    expect(audioCell().value).toBe("a-new");
    typeInto(visual, "v-new");
    renderProd(prodWith("a-new", "v-old"));
    expect(visualCell().value).toBe("v-new");
    expect(audioCell().value).toBe("a-new");
    act(() => { visual.blur(); });
    expect(updateCalls).toEqual([
      ["p1", "a", { audio: "a-new", visual: "v-old" }],
      ["p1", "a", { audio: "a-new", visual: "v-new" }],
    ]);
  });

  it("ignores Enter while an IME composition is active", () => {
    renderProd(prodWith("old"));
    const cell = audioCell();
    act(() => { cell.focus(); });
    typeInto(cell, "draft");
    const composing = keyEnter(cell, true);
    expect(updateCalls).toEqual([]);
    expect(composing.defaultPrevented).toBe(false);
    expect(g.document.activeElement).toBe(cell);
    keyEnter(cell, false);
    expect(updateCalls).toEqual([["p1", "a", { audio: "draft", visual: "v-old" }]]);
  });
});

/**
 * Scene rename (header pencil -> inline title input). The commit must follow
 * the Bug #18 panel-commit fix: the input's own blur commits, so clicking
 * DIRECTLY into another panel/cell (no neutral click between) still saves,
 * and an incoming snapshot resyncs via the lastSaved mirror instead of
 * wiping a diverged draft in the focus gap.
 */
describe("ShotTable scene rename", () => {
  const g = globalThis as Record<string, any>;
  let container: HTMLElement;
  let root: Root | null = null;
  let renameCalls: unknown[][];

  function prodWithScenes(scenes: ProductionScene[]): Production {
    return { meta: { id: "p1", name: "T" }, scenes } as unknown as Production;
  }

  function twoScenes(t1 = "Opening", t2 = "Chase"): Production {
    return prodWithScenes([
      { number: 1, title: t1, shots: [{ id: "a", number: "0100", audio: "a-old", visual: "v-old" }] },
      { number: 2, title: t2, shots: [{ id: "b", number: "0200", audio: "", visual: "" }] },
    ]);
  }

  function renderProd(prod: Production) {
    act(() => { root!.render(createElement(ShotTable, { prod, onMutation: () => {} })); });
  }

  function sceneHead(idx: number): Element {
    return container.querySelectorAll(".shot-scene")[idx];
  }

  function titleInput(idx: number): HTMLInputElement | null {
    return sceneHead(idx).querySelector(".shot-scene-title-input") as HTMLInputElement | null;
  }

  function openRename(idx: number): HTMLInputElement {
    const btn = sceneHead(idx).querySelector(".shot-scene-rename") as HTMLButtonElement;
    expect(btn, "rename button").toBeTruthy();
    act(() => { btn.click(); });
    const input = titleInput(idx);
    expect(input, "title input").toBeTruthy();
    return input!;
  }

  function typeTitle(el: HTMLInputElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(g.window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter!.call(el, text);
      el.dispatchEvent(new g.Event("input", { bubbles: true }));
    });
  }

  function keyOn(el: HTMLElement, key: string, isComposing = false) {
    const ev = new g.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    Object.defineProperty(ev, "isComposing", { value: isComposing });
    act(() => { el.dispatchEvent(ev); });
    return ev;
  }

  beforeEach(() => {
    renameCalls = [];
    g.window.cascade = {
      reorderShot: () => Promise.resolve(null),
      insertShot: () => Promise.resolve(null),
      addScene: () => Promise.resolve(null),
      updateShot: () => Promise.resolve(null),
      deleteShot: () => Promise.resolve(null),
      setShotNumber: () => Promise.resolve(null),
      renameScene: (...args: unknown[]) => { renameCalls.push(args); return Promise.resolve(null); },
    };
    container = g.document.createElement("div");
    g.document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container.remove();
  });

  it("opens an inline input prefilled with the current title", () => {
    renderProd(twoScenes());
    const input = openRename(0);
    expect(input.value).toBe("Opening");
    expect(g.document.activeElement).toBe(input);
  });

  // The acceptance-critical path: edit the title, click DIRECTLY into a shot
  // cell (another panel) - the rename must commit on that switch.
  it("commits on a direct switch into a shot cell (Bug #18 panel-commit)", () => {
    renderProd(twoScenes());
    const input = openRename(0);
    typeTitle(input, "Rooftop chase");
    const audio = container.querySelector(".shot-cell.audio") as HTMLTextAreaElement;
    act(() => { input.blur(); });
    act(() => { audio.focus(); });
    expect(renameCalls).toEqual([["p1", 1, "Rooftop chase"]]);
    expect(titleInput(0)).toBeNull();
    // The commit's snapshot lands: the header shows the new title.
    renderProd(twoScenes("Rooftop chase"));
    expect(sceneHead(0).textContent).toContain("Scene 1 — Rooftop chase");
    // The audio cell the user switched into is untouched by the rename.
    expect((container.querySelector(".shot-cell.audio") as HTMLTextAreaElement).value).toBe("a-old");
  });

  it("addresses the scene by its ordinal (renaming scene 2)", () => {
    renderProd(twoScenes());
    const input = openRename(1);
    typeTitle(input, "Alley");
    act(() => { input.blur(); });
    expect(renameCalls).toEqual([["p1", 2, "Alley"]]);
  });

  it("commits exactly once on Enter", () => {
    renderProd(twoScenes());
    const input = openRename(0);
    typeTitle(input, "New opening");
    keyOn(input, "Enter");
    expect(renameCalls).toEqual([["p1", 1, "New opening"]]);
    expect(titleInput(0)).toBeNull();
  });

  it("ignores Enter while an IME composition is active", () => {
    renderProd(twoScenes());
    const input = openRename(0);
    typeTitle(input, "New opening");
    keyOn(input, "Enter", true);
    expect(renameCalls).toEqual([]);
    expect(titleInput(0)).toBeTruthy();
  });

  it("cancels on Escape without committing", () => {
    renderProd(twoScenes());
    const input = openRename(0);
    typeTitle(input, "Discard me");
    keyOn(input, "Escape");
    expect(renameCalls).toEqual([]);
    expect(titleInput(0)).toBeNull();
    expect(sceneHead(0).textContent).toContain("Scene 1 — Opening");
  });

  it("reverts a blank title on blur without committing", () => {
    renderProd(twoScenes());
    const input = openRename(0);
    typeTitle(input, "   ");
    act(() => { input.blur(); });
    expect(renameCalls).toEqual([]);
    expect(sceneHead(0).textContent).toContain("Scene 1 — Opening");
  });

  it("commits nothing when the trimmed title is unchanged", () => {
    renderProd(twoScenes());
    const input = openRename(0);
    typeTitle(input, "  Opening  ");
    act(() => { input.blur(); });
    expect(renameCalls).toEqual([]);
  });

  it("keeps a diverged draft through an incoming snapshot; the draft wins at blur", () => {
    renderProd(twoScenes());
    const input = openRename(0);
    typeTitle(input, "My draft");
    // An unrelated save lands mid-edit with a different stored title: the
    // draft must survive (lastSaved-mirror resync, never a focus-gated reset).
    renderProd(twoScenes("Renamed elsewhere"));
    expect(titleInput(0)!.value).toBe("My draft");
    act(() => { titleInput(0)!.blur(); });
    expect(renameCalls).toEqual([["p1", 1, "My draft"]]);
  });

  it("adopts an incoming title while not editing", () => {
    renderProd(twoScenes());
    renderProd(twoScenes("Fresh title"));
    expect(sceneHead(0).textContent).toContain("Scene 1 — Fresh title");
    const input = openRename(0);
    expect(input.value).toBe("Fresh title");
  });
});
