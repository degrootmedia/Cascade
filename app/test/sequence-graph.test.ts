/**
 * Shot Sequence canvas = the node graph, hosted on the sequence. The only
 * differences from any other canvas: it comes pre-populated with a
 * video-generation node and the member frames as image nodes, and its output
 * node's binding replaces the span in the animatic/export.
 */
import { describe, it, expect } from "vitest";
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { SequenceGraphModal, sequenceFrameRefs } from "../src/renderer/src/components/production/sequence-graph.js";
import type { Production, ShotSequence } from "../src/shared/ipc.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = ROStub;
(globalThis as any).requestAnimationFrame ??= (() => 0) as never;
(globalThis as any).cancelAnimationFrame ??= (() => {}) as never;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).IntersectionObserver = class { observe() {} disconnect() {} };
const gWin = (globalThis as any).window as Record<string, unknown>;
gWin.cascade = {
  boardThumbnail: async () => null,
  videoModelOptions: async () => null,
  modelOptions: async () => null,
};

const PROD = {
  meta: { id: "p1", name: "T" },
  currentStep: 3,
  openArt: { model: "auto", resolution: "1k" },
  styles: [],
  characters: [],
  products: [],
  references: [],
  referenceCategories: [],
  scenes: [{
    number: 1,
    title: "S",
    shots: [
      { id: "s1", number: "0100", audio: "", visual: "", artwork: "boards/0100/a.jpg" },
      { id: "s2", number: "0200", audio: "", visual: "", artwork: "boards/0200/b.jpg" },
    ],
  }],
} as never;

const VIDEO_MODEL = { id: "higgsfield-cli:seedance", displayName: "Seedance", description: "" } as never;

function seq(): ShotSequence {
  return {
    id: "sq1",
    name: "Sequence 01",
    shotIds: ["s1", "s2"],
    graph: {
      id: "sq1",
      number: "Sequence 01",
      audio: "",
      visual: "",
      prompt: "",
      graphVideoNodes: [{ id: "vid0", prompt: "@[Shot 0100] @[Shot 0200]" }],
    },
    enabled: true,
    accent: "blue",
  };
}

const generated: Array<Record<string, unknown>> = [];

function Harness({ initial }: { initial: ShotSequence }) {
  const [seqState, setSeqState] = useState(initial);
  return createElement(SequenceGraphModal, {
    prod: PROD,
    seq: seqState,
    imageModels: [],
    videoModels: [VIDEO_MODEL],
    busyNodeIds: [],
    onClose: () => {},
    // Mirror the workspace: an updater is evaluated against the freshest state
    // (so a burst of writes in one tick can't clobber each other).
    onGraphField: (patch: Record<string, unknown> | ((g: Record<string, unknown>) => Record<string, unknown>)) =>
      setSeqState((prev) => {
        const g = prev.graph ?? { id: prev.id, number: prev.name, audio: "", visual: "" };
        const p = typeof patch === "function" ? patch(g as never) : patch;
        return { ...prev, graph: { ...g, ...p, id: prev.id, number: prev.name } } as ShotSequence;
      }),
    onGenerate: (opts: Record<string, unknown>) => { generated.push(opts); },
    onDropFile: async () => null,
    onRenameRef: () => {},
  } as never);
}

function renderCanvas(s: ShotSequence = seq()): { host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(Harness, { initial: s })); });
  return { host };
}

function node(host: HTMLElement, id: string): HTMLElement | null {
  return host.querySelector(`[data-id="${id}"]`);
}

/** Drop a right-shelf tool tile onto the canvas. */
function dropTool(host: HTMLElement, kind: string): void {
  const canvas = host.querySelector(".prod-graph-canvas") as HTMLElement;
  const ev = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }) as MouseEvent & { dataTransfer: unknown };
  ev.dataTransfer = {
    types: ["application/x-cascade-tool"],
    getData: (t: string) => (t === "application/x-cascade-tool" ? kind : ""),
    files: [],
  };
  act(() => { canvas.dispatchEvent(ev); });
}

describe("sequence canvas (the node graph, hosted on the sequence)", () => {
  it("comes pre-populated: the member frames as image nodes and a video node citing them", () => {
    const { host } = renderCanvas();
    // Member frames render exactly like reference nodes, named per shot.
    const names = Array.from(host.querySelectorAll(".prod-graph-ref-name")).map((n) => n.textContent ?? "");
    expect(names).toContain("Shot 0100");
    expect(names).toContain("Shot 0200");
    // The pre-loaded video generation node + its prompt node cite the frames.
    expect(node(host, "videogen")).toBeTruthy();
    expect(node(host, "videogen")!.textContent).toContain("Video generation");
    const promptNode = node(host, "videoprompt")!;
    expect(promptNode.textContent).toContain("@[Shot 0100]");
    expect(promptNode.textContent).toContain("@[Shot 0200]");
    // The frame output node is present (unbound → it says so).
    expect(node(host, "output")).toBeTruthy();
    expect(host.textContent).toContain("Frame output");
    expect(host.textContent).toContain("No output yet");
  });

  it("has no image-gen node and only the video tools in the shelf", () => {
    const { host } = renderCanvas();
    // Image generation (and the composer prompt node that feeds it) is absent.
    expect(node(host, "imagegen")).toBeNull();
    expect(node(host, "composer")).toBeNull();
    expect(host.querySelector(".prod-graph-imagegen")).toBeNull();
    // The right shelf keeps only video generation + video editing.
    const labels = Array.from(host.querySelectorAll(".prod-graph-tools-item .prod-graph-tools-label")).map((l) => l.textContent);
    expect(labels).toEqual(["Video generation", "Edit video"]);
    // Video generation is usable (its tile is draggable and the node generates).
    const vidTile = host.querySelectorAll(".prod-graph-tools-item")[0] as HTMLElement;
    expect(vidTile.getAttribute("draggable")).toBe("true");
    const vidBtn = node(host, "videogen")!.querySelector(".prod-graph-gen-go") as HTMLButtonElement;
    expect(vidBtn.disabled).toBe(false);
  });

  it("submits the video with the member frames as its inputs (tags stripped from the vendor prompt)", () => {
    generated.length = 0;
    const { host } = renderCanvas();
    const vidBtn = node(host, "videogen")!.querySelector(".prod-graph-gen-go") as HTMLButtonElement;
    act(() => { vidBtn.click(); });
    expect(generated).toHaveLength(1);
    const opts = generated[0];
    expect(opts.nodeId).toBe("vid0");
    expect(opts.refIds).toEqual(["s1", "s2"]);
    // The frame citations are host inputs, not references — the vendor prompt
    // must not carry the dotted tags.
    expect(String(opts.prompt)).not.toContain("@[Shot");
  });

  it("builds locked member-frame references from the shots", () => {
    const refs = sequenceFrameRefs(PROD as unknown as Production, seq());
    expect(refs.map((r) => [r.id, r.name, r.locked])).toEqual([
      ["seqframe:s1", "Shot 0100", true],
      ["seqframe:s2", "Shot 0200", true],
    ]);
    expect(refs[0].artwork).toContain("cascade-media://");
  });

  it("keeps a second video node on the canvas (write-order regression)", () => {
    const { host } = renderCanvas();
    // Adding a node writes the list AND its layout in the same tick; the
    // layout write must not clobber the list with a stale copy.
    dropTool(host, "video");
    expect(host.querySelectorAll(".prod-graph-node.prod-graph-videogen").length).toBe(2);
    expect(node(host, "videogen")).toBeTruthy();
    expect(node(host, "videogen:vid1")).toBeTruthy();
    expect(node(host, "videoprompt:vid1")).toBeTruthy();
  });

  it("adds a second edit-video node and keeps both (multi-instance)", () => {
    const { host } = renderCanvas();
    // Edit-video nodes ride the video-node list (mode "edit"), so dragging the
    // tile twice gives ev0 + ev1 — exactly like the video tile.
    dropTool(host, "editvideo");
    dropTool(host, "editvideo");
    expect(host.querySelectorAll(".prod-graph-node.prod-graph-editvideo").length).toBe(2);
    expect(node(host, "editvideo")).toBeTruthy();
    expect(node(host, "editvideo:ev1")).toBeTruthy();
    expect(node(host, "editvideoprompt:ev1")).toBeTruthy();
  });
});
