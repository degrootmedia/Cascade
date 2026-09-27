/**
 * Edit-video nodes are multi-instance entries in the shot's `graphVideoNodes`
 * list (`mode: "edit"`, ids `ev0`, `ev1`, …) rather than flat singleton fields.
 * These tests pin the renderer's per-node routing: an edit node's take history
 * is owned by its list entry, and select/cycle address it by node id.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { GraphGenItem, Production, ProductionShot } from "../src/shared/ipc.js";
import { NodeGraphModal } from "../src/renderer/src/components/NodeGraphModal.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = ROStub;
(globalThis as any).requestAnimationFrame ??= (() => 0) as never;
(globalThis as any).cancelAnimationFrame ??= (() => {}) as never;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const gWin = (globalThis as any).window as Record<string, unknown>;
gWin.cascade = {
  boardThumbnail: async () => null,
  videoModelOptions: async () => null,
  modelOptions: async () => null,
  videoEditModels: async () => [],
};

const gen = (rel: string): GraphGenItem => ({ path: rel, prompt: "p", model: "m", at: "" });

function makeProd(shot: Partial<ProductionShot>): Production {
  return {
    meta: { id: "p1", name: "T" },
    currentStep: 3,
    openArt: { model: "auto", resolution: "1k" },
    styles: [],
    characters: [],
    products: [],
    references: [],
    scenes: [{ number: 1, title: "S", shots: [{ id: "s1", number: "0100", audio: "", visual: "", ...shot }] }],
  } as unknown as Production;
}

function renderModal(shot: Partial<ProductionShot>, onCycleGraphGen: (kind: string, dir: 1 | -1, nodeId?: string) => void) {
  const prod = makeProd(shot);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(NodeGraphModal, {
      prod,
      shot: prod.scenes[0].shots[0],
      bust: 0,
      prompt: "",
      references: [],
      styles: [],
      styleValue: "",
      includeBrand: false,
      imageModels: [],
      videoModels: [],
      defaultImageModel: "auto",
      defaultImageResolution: "1k",
      onPromptChange: () => {},
      onStyleChange: () => {},
      onToggleBrand: () => {},
      onDropFile: () => {},
      onStyleDetached: () => {},
      onRunImageGen: async () => {},
      onRunVideoGen: async () => {},
      onRunEditGen: async () => {},
      onRunEditVideo: async () => {},
      onSelectGraphGen: () => {},
      onCycleGraphGen,
      onGraphField: () => {},
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
      onSaveLayout: () => {},
      onClose: () => {},
    } as never));
  });
  return { host, root };
}

describe("edit-video node (multi-instance graphVideoNodes)", () => {
  it("renders one pair per edit-mode entry (ev0 + ev1)", () => {
    const { host, root } = renderModal({
      graphVideoNodes: [
        { id: "ev0", mode: "edit", prompt: "grade" },
        { id: "ev1", mode: "edit", prompt: "crop" },
      ],
    }, () => {});
    expect(host.querySelectorAll(".prod-graph-node.prod-graph-editvideo").length).toBe(2);
    expect(host.querySelector('[data-id="editvideo"]')).toBeTruthy();
    expect(host.querySelector('[data-id="editvideo:ev1"]')).toBeTruthy();
    expect(host.querySelector('[data-id="editvideoprompt:ev1"]')).toBeTruthy();
    act(() => { root.unmount(); });
  });

  it("cycles an edit node's takes via its node id", () => {
    const calls: unknown[][] = [];
    const { host, root } = renderModal({
      graphVideoNodes: [
        { id: "ev0", mode: "edit", prompt: "grade", gens: [gen("a.mp4"), gen("b.mp4")], genIndex: 0 },
      ],
    }, (kind, dir, nodeId) => calls.push([kind, dir, nodeId]));
    const cycle = host.querySelector(".prod-graph-editvideo .prod-graph-gen-cycle button") as HTMLButtonElement;
    expect(cycle).toBeTruthy();
    act(() => { cycle.click(); });
    expect(calls).toContainEqual(["video", 1, "ev0"]);
    act(() => { root.unmount(); });
  });

  it("shows the take history stored on the edit node", () => {
    const { host, root } = renderModal({
      graphVideoNodes: [
        { id: "ev0", mode: "edit", prompt: "grade", gens: [gen("a.mp4"), gen("b.mp4")], genIndex: 1 },
      ],
    }, () => {});
    // 2 takes selected at index 1 → "2 / 2".
    expect(host.querySelector(".prod-graph-editvideo .prod-graph-gen-cycle")?.textContent).toContain("2 / 2");
    act(() => { root.unmount(); });
  });
});
