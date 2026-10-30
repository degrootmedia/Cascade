/**
 * Genjutsu nodes (Motion Transfer / Object Swap) are edit-family entries in
 * the shot's `graphVideoNodes` list (`mode: "genjutsu-motion"` /
 * `"genjutsu-swap"`, ids `gm0…` / `gs0…`) riding the edit-video machinery.
 * These tests pin: the shared mode/model helpers, materialization to the
 * editvideo canvas family, take ownership through generations.ts, and the
 * renderer's per-variant behavior (locked model pair, optional prompt,
 * >=1 image reference gate, no duration control, palette gray-out).
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { GraphGenItem, Production, ProductionShot } from "../src/shared/ipc.js";
import {
  GENJUTSU_UNAVAILABLE_HINT,
  defaultGenjutsuModelId,
  genjutsuModeForModelId,
  genjutsuNodes,
  isGenjutsuModelId,
  isVideoEditFamilyMode,
  nextGenjutsuNodeId,
  providerSupportsGenjutsu,
  videoEditFamilyNodes,
} from "../src/shared/ipc.js";
import { materializeGraph } from "../src/shared/graph/materialize.js";
import { findGeneration, frameOrigin, generationInUse, removeGeneration } from "../src/shared/generations.js";
import { NodeGraphModal } from "../src/renderer/src/components/NodeGraphModal.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = ROStub;
(globalThis as any).requestAnimationFrame ??= (() => 0) as never;
(globalThis as any).cancelAnimationFrame ??= (() => {}) as never;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const gWin = (globalThis as any).window as Record<string, unknown>;
gWin.cascade = {
  boardThumbnail: async () => null,
  videoModelOptions: async () => ({ resolutions: ["720p", "1080p"], durations: [5, 10] }),
  modelOptions: async () => null,
  videoEditModels: async () => [
    "higgsfield-cli:hf_mult_motion_control",
    "higgsfield-cli:hf_mult_motion_control_flash",
    "higgsfield-cli:hf_mult_replace_object",
    "higgsfield-cli:hf_mult_replace_object_flash",
    "higgsfield-cli:seedance_2_0",
  ],
};

const MOTION = "higgsfield-cli:hf_mult_motion_control";
const MOTION_LITE = "higgsfield-cli:hf_mult_motion_control_flash";
const SWAP = "higgsfield-cli:hf_mult_replace_object";
const DECOY = "higgsfield-cli:seedance_2_0";
const VIDEO_MODELS = [
  { id: DECOY, displayName: "Seedance 2.0", description: "", imageInput: true, videoInput: true, cost: null },
  { id: MOTION_LITE, displayName: "Genjutsu Lite", description: "", imageInput: true, videoInput: true, cost: null },
  { id: MOTION, displayName: "Genjutsu", description: "", imageInput: true, videoInput: true, cost: null },
  { id: SWAP, displayName: "Genjutsu", description: "", imageInput: true, videoInput: true, cost: null },
];
const IMAGE_REF = { id: "r1", name: "Hero", artwork: "hero.png" };

const gen = (rel: string): GraphGenItem => ({ path: rel, prompt: "", model: MOTION, at: "" });

describe("Genjutsu shared helpers", () => {
  it("classifies modes into the edit family", () => {
    expect(isVideoEditFamilyMode("edit")).toBe(true);
    expect(isVideoEditFamilyMode("genjutsu-motion")).toBe(true);
    expect(isVideoEditFamilyMode("genjutsu-swap")).toBe(true);
    expect(isVideoEditFamilyMode("generate")).toBe(false);
    expect(isVideoEditFamilyMode(undefined)).toBe(false);
  });

  it("allocates gm/gs ids without colliding", () => {
    const nodes = [{ id: "gm0" }, { id: "ev0" }, { id: "gs0" }, { id: "gs1" }];
    expect(nextGenjutsuNodeId(nodes, "genjutsu-motion")).toBe("gm1");
    expect(nextGenjutsuNodeId(nodes, "genjutsu-swap")).toBe("gs2");
    expect(nextGenjutsuNodeId([], "genjutsu-motion")).toBe("gm0");
  });

  it("maps model ids to their feature (namespaced or raw)", () => {
    expect(genjutsuModeForModelId(MOTION)).toBe("genjutsu-motion");
    expect(genjutsuModeForModelId("hf_mult_replace_object_flash")).toBe("genjutsu-swap");
    expect(genjutsuModeForModelId(DECOY)).toBeNull();
    expect(genjutsuModeForModelId("auto")).toBeNull();
    expect(isGenjutsuModelId(SWAP)).toBe(true);
    expect(defaultGenjutsuModelId("genjutsu-motion")).toBe(MOTION);
    expect(defaultGenjutsuModelId("genjutsu-swap")).toBe(SWAP);
  });

  it("is a Higgsfield-CLI-only capability (grayed out on both OpenArt transports)", () => {
    expect(providerSupportsGenjutsu("higgsfield-cli")).toBe(true);
    expect(providerSupportsGenjutsu("openart")).toBe(false);
    expect(providerSupportsGenjutsu("openart-cli")).toBe(false);
  });

  it("selects family/per-feature entries from a video node list", () => {
    const nodes = [
      { id: "vid0", prompt: "" },
      { id: "ev0", mode: "edit" as const, prompt: "" },
      { id: "gm0", mode: "genjutsu-motion" as const, prompt: "" },
      { id: "gs0", mode: "genjutsu-swap" as const, prompt: "" },
    ];
    expect(videoEditFamilyNodes(nodes).map((n) => n.id)).toEqual(["ev0", "gm0", "gs0"]);
    expect(genjutsuNodes(nodes).map((n) => n.id)).toEqual(["gm0", "gs0"]);
    expect(genjutsuNodes(nodes, "genjutsu-swap").map((n) => n.id)).toEqual(["gs0"]);
  });
});

describe("Genjutsu materialization + take ownership", () => {
  const shot = {
    id: "s1",
    number: "0100",
    audio: "",
    visual: "",
    graphVideoNodes: [
      { id: "vid0", prompt: "Drift", source: { kind: "imagegen" } },
      { id: "gm0", mode: "genjutsu-motion", prompt: "", source: { kind: "video", nodeId: "vid0" }, refIds: ["r1"], gens: [gen("a.mp4"), gen("b.mp4")], genIndex: 1 },
      { id: "gs0", mode: "genjutsu-swap", prompt: "the jacket", gens: [gen("c.mp4")], genIndex: 0 },
    ],
    graphOutputSource: "videogen",
    graphOutputVideoNodeId: "gs0",
  } as unknown as ProductionShot;

  it("materializes Genjutsu entries as editvideo canvas pairs with source/output wires", () => {
    const g = materializeGraph(shot, [IMAGE_REF] as never);
    const byId = new Map(g.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("editvideo:gm0")).toBe("editvideo");
    expect(byId.get("editvideoprompt:gm0")).toBe("editvideoprompt");
    expect(byId.get("editvideo:gs0")).toBe("editvideo");
    const hasEdge = (from: string, to: string, port: string) =>
      g.edges.some((e) => e.from.node === from && e.to.node === to && e.to.port === port);
    // Prompt pipe, wired source clip, and the output feed.
    expect(hasEdge("editvideoprompt:gm0", "editvideo:gm0", "in-prompt")).toBe(true);
    expect(hasEdge("videogen", "editvideo:gm0", "in-video")).toBe(true);
    expect(hasEdge("editvideo:gs0", "output", "in-out")).toBe(true);
  });

  it("owns Genjutsu takes like other video-node takes", () => {
    const found = findGeneration(shot, "b.mp4");
    expect(found).toEqual({ kind: "video", rel: "b.mp4", index: 1, nodeId: "gm0" });
    // The selected gs0 take feeds the output — deletion is blocked.
    const out = findGeneration(shot, "c.mp4")!;
    expect(generationInUse(shot, out)).toBeTruthy();
    expect(frameOrigin(shot, "b.mp4")?.label).toBe("Genjutsu Motion Transfer node");
    const stale = findGeneration(shot, "a.mp4")!;
    expect(removeGeneration(shot, stale)).toBe(true);
    expect(shot.graphVideoNodes?.find((n) => n.id === "gm0")?.gens?.map((g) => g.path)).toEqual(["b.mp4"]);
  });
});

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

function renderModal(
  shot: Partial<ProductionShot>,
  extra?: {
    genjutsuUnavailable?: boolean;
    references?: unknown[];
    onRunEditVideo?: (...args: unknown[]) => Promise<void>;
    onCycleGraphGen?: (kind: string, dir: 1 | -1, nodeId?: string) => void;
  }
) {
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
      references: extra?.references ?? [],
      styles: [],
      styleValue: "",
      includeBrand: false,
      imageModels: [],
      videoModels: VIDEO_MODELS,
      genjutsuUnavailable: extra?.genjutsuUnavailable ?? false,
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
      onCycleGraphGen: extra?.onCycleGraphGen ?? (() => {}),
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

const settle = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); });
};

describe("Genjutsu nodes in the node graph", () => {
  it("renders a variant-titled pair per Genjutsu entry", async () => {
    const { host, root } = renderModal({
      graphVideoNodes: [
        { id: "gm0", mode: "genjutsu-motion", prompt: "", model: MOTION },
        { id: "gs0", mode: "genjutsu-swap", prompt: "", model: SWAP },
      ],
    });
    await settle();
    expect(host.querySelector('[data-id="editvideo:gm0"]')).toBeTruthy();
    expect(host.querySelector('[data-id="editvideoprompt:gm0"]')).toBeTruthy();
    expect(host.querySelector('[data-id="editvideo:gs0"]')).toBeTruthy();
    const titles = Array.from(host.querySelectorAll(".prod-graph-editvideo .prod-graph-node-title")).map((t) => t.textContent);
    expect(titles.some((t) => t?.includes("Genjutsu Motion Transfer"))).toBe(true);
    expect(titles.some((t) => t?.includes("Genjutsu Object Swap"))).toBe(true);
    act(() => { root.unmount(); });
  });

  it("offers only the feature's model pair (standard first), no duration control", async () => {
    const { host, root } = renderModal({
      graphVideoNodes: [{ id: "gm0", mode: "genjutsu-motion", prompt: "", model: MOTION }],
    });
    await settle();
    const node = host.querySelector(".prod-graph-node.prod-graph-editvideo")!;
    const selects = Array.from(node.querySelectorAll("select")) as HTMLSelectElement[];
    expect(selects).toHaveLength(2); // model + resolution — Genjutsu keeps source timing
    const modelSelect = selects[0];
    expect(Array.from(modelSelect.options).map((o) => o.value)).toEqual([MOTION, MOTION_LITE]);
    expect(modelSelect.value).toBe(MOTION);
    act(() => { root.unmount(); });
  });

  it("keeps Generate disabled until an image reference is attached, prompt stays optional", async () => {
    const runs: unknown[][] = [];
    const noRef = renderModal(
      { graphVideoNodes: [{ id: "gm0", mode: "genjutsu-motion", prompt: "", model: MOTION }] },
      { onRunEditVideo: async (...args: unknown[]) => { runs.push(args); } }
    );
    await settle();
    const nodeA = noRef.host.querySelector(".prod-graph-node.prod-graph-editvideo")!;
    const goA = Array.from(nodeA.querySelectorAll("button")).find((b) => b.textContent?.includes("Transfer motion")) as HTMLButtonElement;
    expect(goA).toBeTruthy();
    expect(goA.disabled).toBe(true);
    expect(nodeA.textContent).toContain("at least 1 image reference");
    act(() => { noRef.root.unmount(); });

    const withRef = renderModal(
      { graphVideoNodes: [{ id: "gm0", mode: "genjutsu-motion", prompt: "", model: MOTION, refIds: ["r1"] }] },
      { references: [IMAGE_REF], onRunEditVideo: async (...args: unknown[]) => { runs.push(args); } }
    );
    await settle();
    const nodeB = withRef.host.querySelector(".prod-graph-node.prod-graph-editvideo")!;
    const goB = Array.from(nodeB.querySelectorAll("button")).find((b) => b.textContent?.includes("Transfer motion")) as HTMLButtonElement;
    expect(goB.disabled).toBe(false);
    expect(nodeB.textContent).toContain("References: 1 image");
    await act(async () => { goB.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(runs).toHaveLength(1);
    expect(runs[0][0]).toBe("gm0");
    expect(runs[0][1]).toBe(MOTION);
    expect(runs[0][3]).toBe(0); // durationSec — source timing kept
    expect(runs[0][4]).toBe(""); // empty prompt submits (Genjutsu prompts are optional)
    act(() => { withRef.root.unmount(); });
  });

  it("cycles a Genjutsu node's takes via its node id", async () => {
    const calls: unknown[][] = [];
    const { host, root } = renderModal(
      { graphVideoNodes: [{ id: "gm0", mode: "genjutsu-motion", prompt: "", model: MOTION, gens: [gen("a.mp4"), gen("b.mp4")], genIndex: 0 }] },
      { onCycleGraphGen: (kind, dir, nodeId) => calls.push([kind, dir, nodeId]) }
    );
    await settle();
    const cycle = host.querySelector(".prod-graph-editvideo .prod-graph-gen-cycle button") as HTMLButtonElement;
    expect(cycle).toBeTruthy();
    act(() => { cycle.click(); });
    expect(calls).toContainEqual(["video", 1, "gm0"]);
    act(() => { root.unmount(); });
  });

  it("shows no pipe-to-output button on Genjutsu nodes (Edit video keeps it)", async () => {
    const genjutsu = renderModal({
      graphVideoNodes: [{ id: "gm0", mode: "genjutsu-motion", prompt: "", model: MOTION, gens: [gen("a.mp4")], genIndex: 0 }],
    });
    await settle();
    const gmNode = genjutsu.host.querySelector(".prod-graph-node.prod-graph-editvideo")!;
    const gmButtons = Array.from(gmNode.querySelectorAll("button")).map((b) => b.textContent);
    expect(gmButtons.some((t) => t?.includes("Pipe to output") || t === "Piped")).toBe(false);
    act(() => { genjutsu.root.unmount(); });

    const edit = renderModal({
      graphVideoNodes: [{ id: "ev0", mode: "edit", prompt: "make it night", model: DECOY, gens: [gen("a.mp4")], genIndex: 0 }],
    });
    await settle();
    const evNode = edit.host.querySelector(".prod-graph-node.prod-graph-editvideo")!;
    const evButtons = Array.from(evNode.querySelectorAll("button")).map((b) => b.textContent);
    expect(evButtons.some((t) => t?.includes("Pipe to output"))).toBe(true);
    act(() => { edit.root.unmount(); });
  });

  it("grays out both palette tiles when Genjutsu is unavailable (OpenArt active)", async () => {
    const off = renderModal({}, { genjutsuUnavailable: true });
    await settle();
    const tiles = Array.from(off.host.querySelectorAll(".prod-graph-tools-item"));
    for (const label of ["Genjutsu Motion Transfer", "Genjutsu Object Swap"]) {
      const tile = tiles.find((t) => t.textContent?.includes(label));
      expect(tile, label).toBeTruthy();
      expect(tile!.classList.contains("disabled")).toBe(true);
      expect(tile!.getAttribute("draggable")).toBe("false");
      expect(tile!.getAttribute("title")).toContain(GENJUTSU_UNAVAILABLE_HINT);
    }
    act(() => { off.root.unmount(); });

    const on = renderModal({}, { genjutsuUnavailable: false });
    await settle();
    const onTiles = Array.from(on.host.querySelectorAll(".prod-graph-tools-item"));
    const motion = onTiles.find((t) => t.textContent?.includes("Genjutsu Motion Transfer"));
    expect(motion!.classList.contains("disabled")).toBe(false);
    expect(motion!.getAttribute("draggable")).toBe("true");
    act(() => { on.root.unmount(); });
  });
});
