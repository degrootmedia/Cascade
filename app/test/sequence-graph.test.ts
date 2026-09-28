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
      graphVideoNodes: [{ id: "vid0", prompt: "" }],
      graphSequence: { segments: [
        { shotId: "s1", durationSec: 3, prompt: "" },
        { shotId: "s2", durationSec: 3, prompt: "" },
      ] },
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
  it("comes pre-populated: the member frames, a Sequence generator, and a timeline", () => {
    const { host } = renderCanvas();
    // Member frames render exactly like reference nodes, named per shot.
    const names = Array.from(host.querySelectorAll(".prod-graph-ref-name")).map((n) => n.textContent ?? "");
    expect(names).toContain("Shot 0100");
    expect(names).toContain("Shot 0200");
    // The generator reads "Sequence"; its prompt node is the timed timeline.
    expect(node(host, "videogen")).toBeTruthy();
    expect(node(host, "videogen")!.textContent).toContain("Sequence");
    const promptNode = node(host, "videoprompt")!;
    expect(promptNode.textContent).toContain("Sequence prompt");
    expect(promptNode.textContent).toContain("Visuals");
    // No brand node or socket on a sequence canvas.
    expect(node(host, "brand")).toBeNull();
    expect(promptNode.textContent).not.toContain("Brand identity");
    // One interactive row per member shot (frame piped in, seconds dial, prompt).
    const rows = promptNode.querySelectorAll(".prod-graph-seq-seg");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Shot 0100");
    expect(rows[1].textContent).toContain("Shot 0200");
    // The member-frame sockets live on the node's left edge (one "Shot" socket
    // per segment), not inset into the rows.
    const shotSockets = Array.from(promptNode.querySelectorAll(".prod-graph-socket-label")).filter((el) => el.textContent === "Shot");
    expect(shotSockets).toHaveLength(2);
    // The frame output node is present (unbound → it says so).
    expect(node(host, "output")).toBeTruthy();
    expect(host.textContent).toContain("Frame output");
    expect(host.textContent).toContain("No output yet");
  });

  it("edits a shot's duration and updates the Sequence Total", () => {
    const { host } = renderCanvas();
    expect(node(host, "videoprompt")!.querySelector(".prod-graph-seq-total")!.textContent).toContain("Sequence Total: 6 Seconds");
    const input = node(host, "videoprompt")!.querySelectorAll(".prod-graph-seq-seg")[0].querySelector("input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    act(() => { setter.call(input, "5"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    const promptNode = node(host, "videoprompt")!;
    expect((promptNode.querySelectorAll(".prod-graph-seq-seg")[0].querySelector("input") as HTMLInputElement).value).toBe("5");
    expect(promptNode.querySelector(".prod-graph-seq-total")!.textContent).toContain("Sequence Total: 8 Seconds");
  });

  it("reverts an edited segment's prompt back to the frame prompt", () => {
    const s = seq();
    s.graph!.graphSequence!.segments![0].prompt = "custom push-in";
    const { host } = renderCanvas(s);
    const row = node(host, "videoprompt")!.querySelectorAll(".prod-graph-seq-seg")[0];
    // The override shows a Revert button; the frame-prompt row shows "frame prompt".
    const revert = row.querySelector(".prod-graph-seq-seg-revert") as HTMLButtonElement;
    expect(revert).toBeTruthy();
    act(() => { revert.click(); });
    const row2 = node(host, "videoprompt")!.querySelectorAll(".prod-graph-seq-seg")[0];
    expect(row2.querySelector(".prod-graph-seq-seg-revert")).toBeNull();
    expect(row2.querySelector(".prod-graph-seq-seg-auto")).toBeTruthy();
  });

  it("drops image generation, hides the node palette, and keeps the reference shelf", () => {
    const { host } = renderCanvas();
    // Image generation (and the composer prompt node that feeds it) is absent.
    expect(node(host, "imagegen")).toBeNull();
    expect(node(host, "composer")).toBeNull();
    expect(host.querySelector(".prod-graph-imagegen")).toBeNull();
    // The right-hand node palette is hidden; the left reference shelf remains.
    expect((host.querySelector(".prod-graph-tools") as HTMLElement).classList.contains("hidden")).toBe(true);
    expect(host.querySelector(".prod-graph-shelf")).toBeTruthy();
    // Video generation is usable (its node generates).
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
    // Each segment is a "Hard Cut to Shot N… Framing Reference <<<image_K>>>"
    // line (K = the frame's submitted position; no style/visual refs here, so
    // it equals the shot order), and the clip length is the timeline total.
    expect(String(opts.prompt)).toContain("Hard Cut to Shot 1. 3 Seconds. Framing Reference <<<image_1>>>");
    expect(String(opts.prompt)).toContain("Hard Cut to Shot 2. 3 Seconds. Framing Reference <<<image_2>>>");
    expect(opts.durationSec).toBe(6);
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
