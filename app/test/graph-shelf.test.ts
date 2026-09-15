/**
 * The node graph's reference shelf + tool panel:
 * - Untagged references are NOT auto-populated as nodes; they live in a
 *   category-organized side panel and the user drags one onto the canvas.
 * - The video-generation and edit-image nodes are NOT auto-populated either;
 *   they live as tiles in the right panel, dragged out on demand. A tool that
 *   is in use (stored generations/pipes/prompt) is present even without a drag.
 */
import { describe, it, expect } from "vitest";
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { NodeGraphModal } from "../src/renderer/src/components/NodeGraphModal.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = ROStub;
(globalThis as any).window = (globalThis as any).window ?? {};
const gWin = (globalThis as any).window as Record<string, unknown>;
gWin.cascade = {
  boardThumbnail: async () => null,
  videoModelOptions: async () => null,
};

const P0 = "Style: S\n\nhello @[Hero]\n\nBrand identity: B";
const REFS = [
  { id: "r1", name: "Hero", artwork: "data:image/png;base64,AAAA" },
  { id: "r2", name: "Villain", artwork: "data:image/png;base64,BBBB" },
  { id: "r3", name: "Potion", artwork: "data:image/png;base64,CCCC" },
] as never;

let savedLayouts: Array<{ positions?: Record<string, { x: number; y: number }>; viewport?: { x: number; y: number; zoom: number } }> = [];
let lastEmittedPrompt: string | null = null;

function Harness({ initial, shotPatch, prodPatch, refs }: { initial?: string; shotPatch?: Record<string, unknown>; prodPatch?: Record<string, unknown>; refs?: typeof REFS }) {
  const [prompt, setPrompt] = useState(initial ?? P0);
  // Merge `onGraphField` patches back into the shot so graph mutations (adding
  // an edit node, piping) round-trip like the real workspace.
  const [shotState, setShotState] = useState<Record<string, unknown>>({});
  const shot = { id: "s1", number: 1, prompt, promptManual: true, includeBrandIdentity: true, artwork: "boards/0001.jpg", ...shotPatch, ...shotState };
  return createElement(NodeGraphModal, {
    prod: {
      meta: { id: "p1", name: "T" },
      currentStep: 3,
      openArt: { model: "auto", resolution: "1k" },
      styles: [],
      brand: { colors: [], font: "" },
      characters: [],
      products: [],
      references: [],
      referenceCategories: [],
      scenes: [{ id: "sc1", name: "S", shots: [{ id: "s1", number: 1, prompt, promptManual: true, includeBrandIdentity: true, artwork: "boards/0001.jpg" }] }],
      ...prodPatch,
    } as never,
    shot: shot as never,
    bust: 0,
    prompt,
    references: refs ?? REFS,
    styles: [],
    styleValue: "",
    includeBrand: true,
    onPromptChange: (v) => { lastEmittedPrompt = v; setPrompt(v); },
    onStyleChange: () => {},
    onToggleBrand: () => {},
    onDropFile: () => {},
    onStyleDetached: () => {},
    imageModels: [],
    videoModels: [],
    defaultImageModel: "auto",
    defaultImageResolution: "1k",
    onRunImageGen: async () => {},
    onRunVideoGen: async () => {},
    onRunEditGen: async () => {},
    onSelectGraphGen: () => {},
    onCycleGraphGen: () => {},
    onGraphField: (patch: Record<string, unknown>) => setShotState((prev) => ({ ...prev, ...patch })),
    onPipeImageToVideo: () => {},
    onPipeImageToOutput: () => {},
    onPipeVideoToOutput: () => {},
    onPipeEditToOutput: () => {},
    onPipeRefToOutput: () => {},
    onUnpipeImageGen: () => {},
    onUnpipeImageToVideo: () => {},
    onUnpipeVideoGen: () => {},
    onUnpipeEditGen: () => {},
    onUnpipeOutput: () => {},
    onSaveLayout: (l) => { savedLayouts.push(l); },
    onClose: () => {},
  });
}

function renderModal(opts: { initial?: string; shotPatch?: Record<string, unknown>; prodPatch?: Record<string, unknown>; refs?: typeof REFS } = {}): { root: any; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(Harness, opts)); });
  return { root, host };
}

/** The shelf starts collapsed; click its rail to load and render it. */
async function openShelf(host: HTMLDivElement): Promise<void> {
  const rail = host.querySelector(".prod-graph-shelf-rail") as HTMLButtonElement | null;
  if (!rail) return;
  await act(async () => { rail.click(); await new Promise((r) => setTimeout(r, 0)); });
}

function dropOnCanvas(host: HTMLDivElement, type: string, data: string): void {
  const canvas = host.querySelector(".prod-graph-canvas") as HTMLElement;
  const ev = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: DataTransfer };
  ev.dataTransfer = {
    types: [type],
    getData: (t: string) => t === type ? data : "",
    files: [],
  } as unknown as DataTransfer;
  canvas.dispatchEvent(ev);
}

const refNodeCount = (host: HTMLDivElement) => host.querySelectorAll(".prod-graph-node.prod-graph-ref").length;
const toolNodeCount = (host: HTMLDivElement) => host.querySelectorAll(".prod-graph-node.prod-graph-videogen, .prod-graph-node.prod-graph-videoprompt, .prod-graph-node.prod-graph-editgen, .prod-graph-node.prod-graph-editprompt").length;

/** Click a node to select it (pointer events, like a real user). */
function selectNode(host: HTMLDivElement, nodeSelector: string): void {
  const wrapper = (host.querySelector(nodeSelector) as HTMLElement).closest(".react-flow__node") as HTMLElement;
  const PE = (globalThis as any).window.PointerEvent;
  const ME = (globalThis as any).window.MouseEvent;
  const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true, clientX: 120, clientY: 140 };
  wrapper.dispatchEvent(new PE("pointerdown", opts));
  wrapper.dispatchEvent(new PE("pointerup", opts));
  wrapper.dispatchEvent(new ME("click", { bubbles: true, button: 0, clientX: 120, clientY: 140 }));
}

/** Press a delete key (keydown → settle → keyup, mirroring real key events). */
async function pressDeleteKey(host: HTMLDivElement, key = "Backspace"): Promise<void> {
  const wrapper = host.querySelector(".react-flow__node") as HTMLElement;
  const KE = (globalThis as any).window.KeyboardEvent;
  await act(async () => {
    wrapper.dispatchEvent(new KE("keydown", { key, code: key, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
  await act(async () => {
    wrapper.dispatchEvent(new KE("keyup", { key, code: key, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("node-graph reference shelf", () => {
  it("only auto-populates tagged references; others live in categorized groups", async () => {
    savedLayouts = [];
    const { root, host } = renderModal({
      prodPatch: {
        characters: [{ id: "r1", name: "Hero", imagePath: "references/hero.png" }],
        products: [{ id: "r3", name: "Potion", imagePath: "references/potion.png" }],
        references: [{ id: "r2", name: "Villain", imagePath: "references/villain.png" }],
      },
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await openShelf(host);

    // Only @[Hero] (tagged) gets a node.
    expect(refNodeCount(host)).toBe(1);
    // The shelf lists every reference, grouped by category.
    const titles = [...host.querySelectorAll(".prod-graph-shelf-group-name")].map((el) => el.textContent);
    expect(titles).toEqual(["Characters", "Products", "References"]);
    expect(host.querySelectorAll(".prod-graph-shelf-item").length).toBe(3);
    expect(host.querySelectorAll(".prod-graph-shelf-item.on-canvas").length).toBe(1);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("category groups collapse and expand", async () => {
    const { root, host } = renderModal({
      prodPatch: {
        characters: [{ id: "r1", name: "Hero", imagePath: "references/hero.png" }],
        references: [
          { id: "r2", name: "Villain", imagePath: "references/villain.png" },
          { id: "r3", name: "Potion", imagePath: "references/potion.png" },
        ],
      },
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await openShelf(host);

    const heads = host.querySelectorAll(".prod-graph-shelf-group-head");
    expect(heads.length).toBe(2);
    // Both groups start expanded.
    expect(host.querySelectorAll(".prod-graph-shelf-item").length).toBe(3);
    expect((heads[0] as HTMLButtonElement).getAttribute("aria-expanded")).toBe("true");

    // Collapse the Characters group — its items disappear, the count stays.
    await act(async () => { (heads[0] as HTMLButtonElement).click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelectorAll(".prod-graph-shelf-item").length).toBe(2);
    expect((heads[0] as HTMLButtonElement).getAttribute("aria-expanded")).toBe("false");
    const count = host.querySelector(".prod-graph-shelf-count");
    expect(count?.textContent).toBe("1");

    // Expand it again.
    await act(async () => { (heads[0] as HTMLButtonElement).click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelectorAll(".prod-graph-shelf-item").length).toBe(3);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("dragging a shelf reference onto the canvas places a node and persists it", async () => {
    savedLayouts = [];
    const { root, host } = renderModal();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await openShelf(host);

    expect(refNodeCount(host)).toBe(1);
    await act(async () => {
      dropOnCanvas(host, "application/x-cascade-ref", "r2");
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(refNodeCount(host)).toBe(2);
    expect(host.querySelectorAll(".prod-graph-shelf-item.on-canvas").length).toBe(2);
    expect(Object.keys(savedLayouts[savedLayouts.length - 1].positions ?? {})).toContain("ref:r2");

    const removeBtn = host.querySelector('.prod-graph-ref-btn[title="Remove this reference from the canvas"]') as HTMLButtonElement;
    expect(removeBtn).toBeTruthy();
    await act(async () => { removeBtn.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(refNodeCount(host)).toBe(1);
    expect(host.querySelectorAll(".prod-graph-shelf-item.on-canvas").length).toBe(1);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});

describe("node-graph shelf at scale", () => {
  const MANY = Array.from({ length: 30 }, (_, i) => ({
    id: `m${i}`,
    name: `Prop${i}`,
    artwork: "data:image/png;base64,AAAA",
  })) as never;
  const manyProdPatch = {
    referenceCategories: [{ id: "c1", name: "Props" }],
    references: (MANY as Array<{ id: string; name: string }>).map((r, i) => ({
      id: r.id,
      name: r.name,
      categoryId: "c1",
      imagePath: `references/prop${i}.png`,
    })),
  };

  it("auto-collapses a large group and windows its tiles behind Show more", async () => {
    const { root, host } = renderModal({ prodPatch: manyProdPatch, refs: MANY });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await openShelf(host);

    const heads = host.querySelectorAll(".prod-graph-shelf-group-head");
    expect(heads.length).toBe(1);
    // 30 refs > the auto-collapse threshold: starts collapsed, nothing mounted.
    expect((heads[0] as HTMLButtonElement).getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelectorAll(".prod-graph-shelf-item").length).toBe(0);

    // Expand: first page of tiles + a Show-more button for the rest.
    await act(async () => { (heads[0] as HTMLButtonElement).click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelectorAll(".prod-graph-shelf-item").length).toBe(24);
    const more = host.querySelector(".prod-graph-shelf-more") as HTMLButtonElement;
    expect(more).toBeTruthy();
    expect(more.textContent).toContain("6 remaining");

    // Show more mounts the rest and the button goes away.
    await act(async () => { more.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelectorAll(".prod-graph-shelf-item").length).toBe(30);
    expect(host.querySelector(".prod-graph-shelf-more")).toBeNull();

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("filters shelf tiles by name", async () => {
    const { root, host } = renderModal();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await openShelf(host);
    expect(host.querySelectorAll(".prod-graph-shelf-item").length).toBe(3);

    const search = host.querySelector(".prod-graph-shelf-search") as HTMLInputElement;
    expect(search).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "vill");
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelectorAll(".prod-graph-shelf-item").length).toBe(1);
    expect(host.querySelector(".prod-graph-shelf-name")?.textContent).toBe("@[Villain]");

    // Clearing the filter restores every tile.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "");
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelectorAll(".prod-graph-shelf-item").length).toBe(3);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});

describe("node-graph tool panel", () => {
  it("does not auto-populate the video/edit/tween/edit-video nodes when unused", async () => {
    savedLayouts = [];
    const { root, host } = renderModal();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(toolNodeCount(host)).toBe(0);
    const tiles = host.querySelectorAll(".prod-graph-tools-item");
    expect(tiles.length).toBe(4);
    expect(host.querySelectorAll(".prod-graph-tools-item.on-canvas").length).toBe(0);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("keeps the video/edit nodes present when they are in use", async () => {
    const { root, host } = renderModal({
      shotPatch: {
        graphVideoGens: [{ path: "videos/clip1.mp4", prompt: "motion", model: "auto", at: "2026-01-01T00:00:00.000Z" }],
        graphEditNodes: [{ id: "edit0", prompt: "edit", genIndex: 0, gens: [{ path: "boards/edit1.jpg", prompt: "edit", model: "auto", at: "2026-01-01T00:00:00.000Z" }] }],
      },
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(host.querySelector(".prod-graph-node.prod-graph-videogen")).toBeTruthy();
    expect(host.querySelector(".prod-graph-node.prod-graph-videoprompt")).toBeTruthy();
    expect(host.querySelector(".prod-graph-node.prod-graph-editgen")).toBeTruthy();
    expect(host.querySelector(".prod-graph-node.prod-graph-editprompt")).toBeTruthy();
    // Only the video tile reports "on canvas" — edit nodes count as a list, the
    // tile always adds another.
    expect(host.querySelectorAll(".prod-graph-tools-item.on-canvas").length).toBe(1);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("dragging a tool tile places the node pair; removing returns it to the panel", async () => {
    savedLayouts = [];
    const { root, host } = renderModal();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    await act(async () => {
      dropOnCanvas(host, "application/x-cascade-tool", "video");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector(".prod-graph-node.prod-graph-videogen")).toBeTruthy();
    expect(host.querySelector(".prod-graph-node.prod-graph-videoprompt")).toBeTruthy();
    const pos = savedLayouts[savedLayouts.length - 1].positions ?? {};
    expect(Object.keys(pos)).toContain("videogen");
    expect(Object.keys(pos)).toContain("videoprompt");
    // The prompt node sits to the LEFT of the gen node, horizontally aligned.
    expect(pos.videoprompt.x).toBeLessThan(pos.videogen.x);
    expect(pos.videoprompt.y).toBe(pos.videogen.y);
    expect(host.querySelectorAll(".prod-graph-tools-item.on-canvas").length).toBe(1);

    // Unused → removable; returns the pair to the panel.
    const removeBtn = host.querySelector(".prod-graph-tools-remove:not(:disabled)") as HTMLButtonElement;
    expect(removeBtn).toBeTruthy();
    await act(async () => { removeBtn.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(toolNodeCount(host)).toBe(0);
    expect(host.querySelectorAll(".prod-graph-tools-item.on-canvas").length).toBe(0);

    // The edit tile works the same way.
    await act(async () => {
      dropOnCanvas(host, "application/x-cascade-tool", "edit");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector(".prod-graph-node.prod-graph-editgen")).toBeTruthy();
    expect(host.querySelector(".prod-graph-node.prod-graph-editprompt")).toBeTruthy();

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});

describe("node-graph delete key", () => {
  it("removes a placed tool pair and returns it to the panel", async () => {
    savedLayouts = [];
    const { root, host } = renderModal();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => {
      dropOnCanvas(host, "application/x-cascade-tool", "video");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector(".prod-graph-node.prod-graph-videogen")).toBeTruthy();

    selectNode(host, ".prod-graph-node.prod-graph-videogen");
    await pressDeleteKey(host);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // Both nodes of the pair are gone; the tile is draggable again.
    expect(toolNodeCount(host)).toBe(0);
    expect(host.querySelectorAll(".prod-graph-tools-item.on-canvas").length).toBe(0);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("is blocked while a tool is in use", async () => {
    const { root, host } = renderModal({
      shotPatch: {
        graphVideoGens: [{ path: "videos/clip1.mp4", prompt: "motion", model: "auto", at: "2026-01-01T00:00:00.000Z" }],
      },
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelector(".prod-graph-node.prod-graph-videogen")).toBeTruthy();

    selectNode(host, ".prod-graph-node.prod-graph-videogen");
    await pressDeleteKey(host);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // In use → stays on the canvas, and the user gets an explanation.
    expect(host.querySelector(".prod-graph-node.prod-graph-videogen")).toBeTruthy();
    expect(host.querySelector(".prod-graph-drop-hint")?.textContent).toContain("in use");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("removes a tagged reference, untags the prompt, and returns it to the shelf", async () => {
    lastEmittedPrompt = null;
    const { root, host } = renderModal();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await openShelf(host);
    expect(refNodeCount(host)).toBe(1);

    selectNode(host, ".prod-graph-node.prod-graph-ref");
    await pressDeleteKey(host, "Delete");
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(refNodeCount(host)).toBe(0);
    // The tag was stripped from the emitted prompt.
    expect(lastEmittedPrompt).toBeTruthy();
    expect(lastEmittedPrompt).not.toContain("@[Hero]");
    // The shelf item is draggable again.
    expect(host.querySelectorAll(".prod-graph-shelf-item.on-canvas").length).toBe(0);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("deletes one of several on-canvas references and keeps the rest", async () => {
    lastEmittedPrompt = null;
    const { root, host } = renderModal({ initial: "Style: S\n\nhello @[Hero] @[Villain]\n\nBrand identity: B" });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await openShelf(host);
    expect(refNodeCount(host)).toBe(2);

    // Selecting one of the two tagged refs and deleting it removes just that
    // node and returns it to the shelf; the other stays tagged on the canvas.
    // (React Flow's built-in multi-select — Ctrl/Cmd+click or Shift box-select —
    //  feeds the same handler one remove change per selected node.)
    selectNode(host, ".prod-graph-node.prod-graph-ref");
    await pressDeleteKey(host);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(refNodeCount(host)).toBe(1);
    expect(lastEmittedPrompt).not.toContain("@[Hero]");
    expect(lastEmittedPrompt).toContain("@[Villain]");
    expect(host.querySelectorAll(".prod-graph-shelf-item.on-canvas").length).toBe(1);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});