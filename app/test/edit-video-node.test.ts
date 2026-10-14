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

function renderModal(shot: Partial<ProductionShot>, onCycleGraphGen: (kind: string, dir: 1 | -1, nodeId?: string) => void, extra?: { videoModels?: unknown[]; onGraphField?: (patch: Record<string, unknown>) => void; onRunEditVideo?: (...args: unknown[]) => Promise<void> }) {
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
      videoModels: extra?.videoModels ?? [],
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
      onRunEditVideo: extra?.onRunEditVideo ?? (async () => {}),
      onSelectGraphGen: () => {},
      onCycleGraphGen,
      onGraphField: extra?.onGraphField ?? (() => {}),
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
    // 2 takes selected at index 1 -> "2 / 2".
    expect(host.querySelector(".prod-graph-editvideo .prod-graph-gen-cycle")?.textContent).toContain("2 / 2");
    act(() => { root.unmount(); });
  });

  it("offers the model's resolution and duration choices and submits them", async () => {
    const cascade = gWin.cascade as Record<string, unknown>;
    const prevEdit = cascade.videoEditModels;
    const prevOpts = cascade.videoModelOptions;
    cascade.videoEditModels = async () => ["hf:genjutsu_multi"];
    cascade.videoModelOptions = async () => ({ resolutions: ["720p", "1080p"], durations: [5, 10] });
    const graphPatches: Array<Record<string, unknown>> = [];
    const runs: unknown[][] = [];
    try {
      const { host, root } = renderModal(
        { graphVideoNodes: [{ id: "ev0", mode: "edit", prompt: "grade it" }] },
        () => {},
        {
          videoModels: [{ id: "hf:genjutsu_multi", displayName: "Genjutsu", description: "", imageInput: true, videoInput: true, cost: null }],
          onGraphField: (patch) => { graphPatches.push(patch); },
          onRunEditVideo: async (...args: unknown[]) => { runs.push(args); },
        }
      );
      // Model-id probe + per-model options resolve asynchronously.
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); });

      const node = host.querySelector(".prod-graph-node.prod-graph-editvideo")!;
      expect(node).toBeTruthy();
      const selects = Array.from(node.querySelectorAll("select"));
      const resSelect = selects.find((s) => Array.from(s.options).some((o) => o.value === "1080p")) as HTMLSelectElement | undefined;
      const durSelect = selects.find((s) => Array.from(s.options).some((o) => o.textContent === "10s")) as HTMLSelectElement | undefined;
      expect(resSelect, "resolution select").toBeTruthy();
      expect(durSelect, "duration select").toBeTruthy();
      // Both default to Auto (source timing / provider default), not a forced pick.
      expect(resSelect!.value).toBe("");
      expect(durSelect!.value).toBe("0");

      const setSelect = async (sel: HTMLSelectElement, value: string) => {
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
          setter?.call(sel, value);
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 0));
        });
      };
      await setSelect(resSelect!, "1080p");
      await setSelect(durSelect!, "10");
      const savedNodes = graphPatches.flatMap((p) => (p.graphVideoNodes as Array<Record<string, unknown>> | undefined) ?? []);
      expect(savedNodes.some((n) => n.resolution === "1080p")).toBe(true);
      expect(savedNodes.some((n) => n.durationSec === 10)).toBe(true);

      const go = Array.from(node.querySelectorAll("button")).find((b) => b.textContent?.includes("Edit video")) as HTMLButtonElement;
      expect(go.disabled).toBe(false);
      await act(async () => { go.click(); await new Promise((r) => setTimeout(r, 0)); });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toContain("1080p");
      expect(runs[0]).toContain(10);
      act(() => { root.unmount(); });
    } finally {
      cascade.videoEditModels = prevEdit;
      cascade.videoModelOptions = prevOpts;
    }
  });
});
