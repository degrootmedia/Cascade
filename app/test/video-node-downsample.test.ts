/**
 * "Downsample reference video to 720p" checkbox (Item 3): rendered on the
 * video-generation and edit-video nodes, persisted as
 * `GraphVideoNode.downsampleVideoRefs`, and NEVER rendered on Genjutsu
 * nodes (their single source clip uploads as-is). Submit-time swapping is
 * covered main-side in video-retry.test.ts (proactive720pSwaps).
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { GraphVideoNode, Production, ProductionShot } from "../src/shared/ipc.js";
import { NodeGraphModal } from "../src/renderer/src/components/NodeGraphModal.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as Record<string, unknown>).ResizeObserver = ROStub;
(globalThis as Record<string, unknown>).requestAnimationFrame ??= (() => 0) as never;
(globalThis as Record<string, unknown>).cancelAnimationFrame ??= (() => {}) as never;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const gWin = (globalThis as Record<string, unknown>).window as Record<string, unknown>;
gWin.cascade = {
  boardThumbnail: async () => null,
  videoModelOptions: async () => ({ resolutions: ["720p", "1080p"], durations: [5, 10] }),
  modelOptions: async () => null,
  videoEditModels: async () => ["higgsfield-cli:seedance_2_0", "higgsfield-cli:hf_mult_motion_control"],
};

const VIDEO_MODELS = [
  { id: "higgsfield-cli:seedance_2_0", displayName: "Seedance 2.0", description: "", imageInput: true, videoInput: true, cost: null },
  { id: "higgsfield-cli:hf_mult_motion_control", displayName: "Genjutsu", description: "", imageInput: true, videoInput: true, cost: null },
];

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

function renderModal(shot: Partial<ProductionShot>, onGraphField: (patch: Record<string, unknown>) => void = () => {}) {
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
      videoModels: VIDEO_MODELS,
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
      onCycleGraphGen: () => {},
      onGraphField,
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

const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }); };

function downsampleCheckbox(scope: ParentNode): HTMLInputElement | null {
  const label = Array.from(scope.querySelectorAll("label")).find((l) => l.textContent?.includes("Downsample reference video to 720p"));
  return (label?.querySelector('input[type="checkbox"]') as HTMLInputElement | null) ?? null;
}

describe("Downsample reference video to 720p checkbox", () => {
  it("renders on video-generation and edit-video nodes, but not on Genjutsu nodes", async () => {
    const { host, root } = renderModal({
      graphVideoNodes: [
        { id: "vid0", prompt: "drift" },
        { id: "ev0", mode: "edit", prompt: "replace sky" },
        { id: "gm0", mode: "genjutsu-motion", prompt: "", model: "higgsfield-cli:hf_mult_motion_control" },
        { id: "gs0", mode: "genjutsu-swap", prompt: "", model: "higgsfield-cli:hf_mult_replace_object" },
      ] as GraphVideoNode[],
    });
    await settle();
    const videoGen = host.querySelector(".prod-graph-node.prod-graph-videogen")!;
    expect(downsampleCheckbox(videoGen), "checkbox on the video-generation node").toBeTruthy();
    expect(downsampleCheckbox(videoGen)!.checked).toBe(false);

    const editNodes = Array.from(host.querySelectorAll(".prod-graph-node.prod-graph-editvideo"));
    expect(editNodes.length).toBe(3);
    const withBox = editNodes.filter((n) => downsampleCheckbox(n));
    expect(withBox.length, "only the edit-video node carries the checkbox").toBe(1);
    for (const id of ["editvideo:gm0", "editvideo:gs0"]) {
      const node = host.querySelector(`[data-id="${id}"]`)!;
      expect(downsampleCheckbox(node), `no checkbox on ${id}`).toBeNull();
      expect(node.textContent).not.toContain("Downsample reference video to 720p");
    }
    await act(async () => { root.unmount(); }); document.body.removeChild(host);
  });

  it("ticking persists downsampleVideoRefs on the node; an existing flag renders checked", async () => {
    const patches: Record<string, unknown>[] = [];
    const { host, root } = renderModal({
      graphVideoNodes: [{ id: "vid0", prompt: "drift" }] as GraphVideoNode[],
    }, (patch: Record<string, unknown>) => { patches.push(patch); });
    await settle();
    const box = downsampleCheckbox(host.querySelector(".prod-graph-node.prod-graph-videogen")!)!;
    await act(async () => { box.click(); });
    const saved = patches.flatMap((p) => (p.graphVideoNodes as GraphVideoNode[] | undefined) ?? []);
    expect(saved.find((n) => n.id === "vid0")?.downsampleVideoRefs).toBe(true);
    await act(async () => { root.unmount(); }); document.body.removeChild(host);

    const second = renderModal({
      graphVideoNodes: [{ id: "vid0", prompt: "drift", downsampleVideoRefs: true }] as GraphVideoNode[],
    });
    await settle();
    expect(downsampleCheckbox(second.host.querySelector(".prod-graph-node.prod-graph-videogen")!)!.checked).toBe(true);
    await act(async () => { second.root.unmount(); }); document.body.removeChild(second.host);
  });
});
