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
import { materializeGraph } from "../src/shared/graph/materialize.js";
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
    if (prop === "refreshMedia") return async () => "refreshed";
    if (prop === "saveSelection") return async () => {};
    if (prop === "writeText") return async () => {};
    if (prop === "readText") return async () => "";
    return async () => null;
  },
});
if (typeof window !== "undefined") (window as unknown as { cascade: unknown }).cascade = gWin.cascade;

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
function renderModal(shot: ProductionShot, onGraphField: (patch: Partial<ProductionShot>) => void, onSaveLayout: (patch: unknown) => void = () => {}, opts: { brand?: unknown; onPasteFiles?: (files: File[]) => Promise<unknown[]>; initialLayout?: unknown; onDeleteGeneration?: (rel: string) => void } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const prod = { ...baseProd(), ...(opts.brand !== undefined ? { brand: opts.brand } : {}) } as Production;
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
        initialLayout: opts.initialLayout,
        onDeleteGeneration: opts.onDeleteGeneration ?? (() => {}),
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
        onPasteFiles: opts.onPasteFiles ?? (async () => []),
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

  it("hovering a node dims nodes outside its chain only while Alt is held", async () => {
    const { host, root } = renderModal(baseShot(), () => {});
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const img = host.querySelector('.react-flow__node[data-id="imagegen"]');
    expect(img).toBeTruthy();
    // Plain hover (no Alt): nothing dims.
    act(() => { img!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true })); });
    expect(host.querySelectorAll(".prod-trace-dim").length).toBe(0);
    // Pressing Alt while already hovering switches the trace on.
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true, cancelable: true })); });
    const dimmed = host.querySelectorAll(".react-flow__node.prod-trace-dim");
    expect(dimmed.length).toBeGreaterThan(0);
    expect(img!.classList.contains("prod-trace-dim")).toBe(false);
    // Releasing Alt clears the trace even though the hover continues.
    act(() => { document.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true, cancelable: true })); });
    expect(host.querySelectorAll(".prod-trace-dim").length).toBe(0);
    // Entering a node with Alt already held traces immediately; leaving clears.
    act(() => { img!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, cancelable: true, altKey: true })); });
    act(() => { img!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, altKey: true })); });
    expect(host.querySelectorAll(".react-flow__node.prod-trace-dim").length).toBeGreaterThan(0);
    act(() => { img!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, cancelable: true, altKey: true })); });
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

  it("a pasted reference lands selected (and nothing else does)", async () => {
    const hero = { id: "r1", name: "Hero", artwork: "references/hero.png" };
    const { host, root } = renderModal(baseShot({ graphOutputSource: undefined }), () => {}, () => {}, {
      onPasteFiles: async () => [hero],
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: { items: [{ kind: "file", type: "image/png", getAsFile: () => new File([], "x.png", { type: "image/png" }) }] },
    });
    await act(async () => { window.dispatchEvent(ev); await new Promise((r) => setTimeout(r, 0)); });
    const placed = host.querySelector('.react-flow__node[data-id="ref:r1"]');
    expect(placed, "pasted ref node on canvas").toBeTruthy();
    expect(placed!.classList.contains("selected")).toBe(true);
    expect(host.querySelectorAll(".react-flow__node.selected")).toHaveLength(1);
    act(() => { root.unmount(); });
    host.remove();
  });

  it("Brand node renders only when the brand identity is non-blank", async () => {
    const blank = renderModal(baseShot(), () => {});
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(blank.host.querySelector('.react-flow__node[data-id="brand"]')).toBeNull();
    act(() => { blank.root.unmount(); });
    blank.host.remove();

    const branded = renderModal(baseShot(), () => {}, () => {}, { brand: { colors: ["#ff0000"], font: "" } });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(branded.host.querySelector('.react-flow__node[data-id="brand"]')).toBeTruthy();
    act(() => { branded.root.unmount(); });
    branded.host.remove();
  });

  it("deleting a ref tag from the composer drops that ref's wire from the stored graph", async () => {
    const patches: Array<Partial<ProductionShot>> = [];
    const fields = {
      id: "shot1", number: "0100", audio: "", visual: "",
      prompt: "Walks @[Hero] onward.", graphStandalone: true,
    } as unknown as ProductionShot;
    const graph = materializeGraph(fields as never, [{ id: "r1", name: "Hero", artwork: "references/hero.png" }] as never);
    expect(graph.edges.some((e) => e.id === "e-ref:r1-composer-0")).toBe(true);
    const shot = baseShot({ prompt: "Walks @[Hero] onward.", graphOutputSource: undefined, graph });
    const { host, root } = renderModal(shot, (p) => patches.push(p));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    patches.length = 0;
    const ed = host.querySelector(".prod-graph-composer .prompt-content-editor") as HTMLElement | null;
    expect(ed, "composer editor rendered").toBeTruthy();
    const chip = ed!.querySelector(".prompt-tag-chip");
    expect(chip, "tag chip rendered").toBeTruthy();
    await act(async () => {
      ed!.focus();
      chip!.remove();
      ed!.dispatchEvent(new Event("input", { bubbles: true }));
      ed!.blur();
      await new Promise((r) => setTimeout(r, 0));
    });
    const graphPatch = patches.filter((p) => p.graph).pop();
    expect(graphPatch, "a stored graph write after tag deletion").toBeTruthy();
    const edges = (graphPatch!.graph as { edges: { id: string }[] }).edges;
    expect(edges.some((e) => e.id === "e-ref:r1-composer-0")).toBe(false);
    act(() => { root.unmount(); });
    host.remove();
  });

  it("right-click Delete on an image-gen take reaches onDeleteGeneration", async () => {
    const deleted: string[] = [];
    const shot = baseShot({
      graphOutputSource: undefined,
      graphImageGens: [
        { path: "out/gen-a.png", prompt: "A" },
        { path: "out/gen-b.png", prompt: "B" },
      ],
      graphImageGenIndex: 1,
    } as never);
    const { host, root } = renderModal(shot, () => {}, () => {}, { onDeleteGeneration: (rel) => deleted.push(rel) });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const preview = host.querySelector(".prod-graph-imagegen .prod-graph-gen-preview-wrap");
    expect(preview, "image-gen preview rendered").toBeTruthy();
    act(() => { preview!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    const del = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Delete generation"));
    expect(del, "Delete item in the context menu").toBeTruthy();
    act(() => { del!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    expect(deleted).toEqual(["out/gen-b.png"]);
    act(() => { root.unmount(); });
    host.remove();
  });

  it("a delete refusal is surfaced inside the modal as a hint", async () => {
    const shot = baseShot({
      graphOutputSource: undefined,
      graphImageGens: [{ path: "out/gen-b.png", prompt: "B" }],
      graphImageGenIndex: 0,
    } as never);
    const { host, root } = renderModal(shot, () => {}, () => {}, {
      onDeleteGeneration: async () => "That take is the storyboard's current frame - unplug it first.",
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const preview = host.querySelector(".prod-graph-imagegen .prod-graph-gen-preview-wrap");
    act(() => { preview!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    const del = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Delete generation"));
    await act(async () => {
      del!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector(".prod-graph-drop-hint")?.textContent).toContain("current frame");
    act(() => { root.unmount(); });
    host.remove();
  });

  it("right-click Refresh reports its outcome as a hint", async () => {
    const shot = baseShot({
      graphOutputSource: undefined,
      graphImageGens: [{ path: "out/gen-b.png", prompt: "B" }],
      graphImageGenIndex: 0,
    } as never);
    const { host, root } = renderModal(shot, () => {});
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const preview = host.querySelector(".prod-graph-imagegen .prod-graph-gen-preview-wrap");
    act(() => { preview!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    const btn = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Refresh image");
    expect(btn, "Refresh item in the context menu").toBeTruthy();
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector(".prod-graph-drop-hint")?.textContent).toContain("Refreshed gen-b.png");
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
