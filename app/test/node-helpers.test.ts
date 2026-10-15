/**
 * Node-view workflow helpers at the modal level:
 * - CTRL+Click a node routes it to Frame Output through the same connect
 *   path as dragging (canonical edge + legacy projection), replacing any
 *   existing Frame Output wire; CTRL+Click on Frame Output / on a text
 *   node does nothing.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { NodeGraphModal } from "../src/renderer/src/components/NodeGraphModal.js";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as Record<string, unknown>).ResizeObserver = ROStub;
(globalThis as Record<string, unknown>).matchMedia ??= (() => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
})) as never;

const gWin = globalThis as unknown as { cascade: unknown };
gWin.cascade = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === "videoEditModels") return async () => [];
    if (prop === "saveSelection") return async () => {};
    if (prop === "writeText") return async () => {};
    if (prop === "readText") return async () => "";
    return async () => null;
  },
});

function baseShot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return {
    id: "shot1",
    number: "0100",
    audio: "",
    visual: "",
    prompt: "A hero walks.",
    graphOutputSource: "videogen",
    graphStandalone: true,
    ...overrides,
  } as ProductionShot;
}

function baseProd(): Production {
  return {
    meta: { id: "p1", name: "P", folder: "/tmp/p1", createdAt: "", updatedAt: "", stepDone: 3, shotCount: 1 },
    currentStep: 3,
    scenes: [],
    styles: [],
    characters: [],
    products: [],
    references: [{ id: "r1", name: "Hero", artwork: "references/hero.png" }],
    assets: { referencesDir: "references" },
    openArt: { model: "auto", resolution: "1k", quality: "medium" },
  } as unknown as Production;
}

/** NodeGraphModal with every callback a no-op (set via extraProps). */
function renderModal(shot: ProductionShot, onGraphField: (patch: Partial<ProductionShot>) => void, onSaveLayout: (patch: unknown) => void = () => {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const prod = baseProd();
  act(() => {
    root.render(
      createElement(NodeGraphModal, {
        prod,
        shot,
        bust: 0,
        prompt: shot.prompt ?? "",
        references: prod.references ?? [],
        styles: [],
        styleValue: "",
        includeBrand: false,
        imageModels: [],
        videoModels: [],
        onClose: () => {},
        onPromptChange: () => {},
        onStyleChange: () => {},
        onToggleBrand: () => {},
        onStyleDetached: () => {},
        onSaveLayout,
        onGraphField,
        onPipeImageToVideo: () => {},
        onPipeEditToVideo: () => {},
        onPipeRefToVideo: () => {},
        onPipeImageToOutput: () => {},
        onPipeVideoToOutput: () => {},
        onPipeEditToOutput: () => {},
        onPipeRefToOutput: () => {},
        onUnpipeImageGen: () => {},
        onUnpipeImageToVideo: () => {},
        onUnpipeVideoGen: () => {},
        onUnpipeEditGen: () => {},
        onUnpipeOutput: () => {},
        onSelectGraphGen: () => {},
        onCycleGraphGen: () => {},
        onSaveGenerationAsReference: async () => null,
        onDropFile: async () => null,
        onPasteFiles: () => {},
        onRenameRef: () => {},
        onRunImageGen: async () => {},
        onRunVideoGen: async () => {},
        onRunEditGen: async () => {},
        onRunCameraGrid: async () => {},
        onImportCameraGridImage: async () => null,
        onExportCameraGrid: async () => null,
        onRunUpscale: async () => {},
        onRunTweenBlock: async () => {},
        onStitchTween: async () => {},
        onUnstitchTween: async () => {},
        onFetchVideo: async () => {},
      } as never)
    );
  });
  return { host, root };
}

function ctrlClick(host: HTMLElement, nodeId: string) {
  const el = host.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
  expect(el, `node ${nodeId} rendered`).toBeTruthy();
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
  });
}

describe("CTRL+Click routes to Frame Output", () => {
  it("wires the image node to output (replacing the unset source) in one graph write", async () => {
    const patches: Array<Partial<ProductionShot>> = [];
    const { host, root } = renderModal(baseShot({ graphOutputSource: undefined }), (p) => patches.push(p));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    ctrlClick(host, "imagegen");
    const graphPatches = patches.filter((p) => p.graph);
    expect(graphPatches.length, "a stored graph write").toBeGreaterThan(0);
    const finalGraph = graphPatches[graphPatches.length - 1]!.graph as { edges: { id: string; to: { node: string } }[] };
    expect(finalGraph.edges.some((e) => e.id === "e-img-out" && e.to.node === "output")).toBe(true);
    // Exactly one Frame Output wire (replace semantics): no duplicates.
    expect(finalGraph.edges.filter((e) => e.to.node === "output")).toHaveLength(1);
    act(() => { root.unmount(); });
    host.remove();
  });

  it("hovering a node dims nodes outside its chain; mouse-leave clears", async () => {
    const { host, root } = renderModal(baseShot(), () => {});
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const img = host.querySelector('.react-flow__node[data-id="imagegen"]');
    expect(img).toBeTruthy();
    act(() => { img!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true })); });
    const dimmed = host.querySelectorAll(".react-flow__node.prod-trace-dim");
    expect(dimmed.length).toBeGreaterThan(0);
    expect(img!.classList.contains("prod-trace-dim")).toBe(false);
    act(() => { img!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, cancelable: true })); });
    expect(host.querySelectorAll(".prod-trace-dim").length).toBe(0);
    act(() => { root.unmount(); });
    host.remove();
  });

  it("Tidy visibly moves the rendered nodes to the saved positions", async () => {
    const layoutPatches: Array<{ positions?: Record<string, { x: number; y: number }> }> = [];
    const { host, root } = renderModal(baseShot({ graphOutputSource: undefined }), () => {}, (p) => layoutPatches.push(p as never));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const before = host.querySelector('.react-flow__node[data-id="output"]') as HTMLElement | null;
    expect(before).toBeTruthy();
    const tidyBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Tidy");
    expect(tidyBtn, "Tidy button rendered").toBeTruthy();
    act(() => { tidyBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    const posPatch = layoutPatches.filter((p) => p.positions).pop();
    expect(posPatch?.positions?.output, "tidy saved an output position").toBeTruthy();
    // The canvas itself must move (not just the saved layout): the rendered
    // wrapper's transform must match the positions Tidy just saved.
    for (const id of ["imagegen", "output"]) {
      const el = host.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement | null;
      const want = posPatch!.positions![id];
      expect(el?.style.transform, `${id} moved to its tidied position`).toContain(`${want.x}px`);
      expect(el?.style.transform).toContain(`${want.y}px`);
    }
    act(() => { root.unmount(); });
    host.remove();
  });

  it("CTRL+Click on Frame Output itself and on a text node does nothing", async () => {
    const patches: Array<Partial<ProductionShot>> = [];
    const { host, root } = renderModal(baseShot(), (p) => patches.push(p));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    patches.length = 0;
    ctrlClick(host, "output");
    ctrlClick(host, "composer");
    expect(patches.find((p) => p.graph)).toBeUndefined();
    act(() => { root.unmount(); });
    host.remove();
  });
});
