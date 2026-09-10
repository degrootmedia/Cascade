/**
 * Node-graph reference thumbnails: the canvas ref nodes, the side shelf, and
 * the tween keyframe tiles display a small compressed JPEG (`?thumb=1` over
 * the cascade-media protocol) instead of the full-resolution file — while the
 * zoom lightbox keeps the full-res `artwork` URL. Legacy inline data-URL
 * artwork (already in-memory) passes through unchanged. Disk-backed shelf
 * tiles load lazily (near the viewport, max 4 in flight), so their `src` is
 * gated until the tile scrolls into view.
 */
import { describe, it, expect } from "vitest";
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { NodeGraphModal, refThumbUrl } from "../src/renderer/src/components/NodeGraphModal.js";

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
  { id: "r1", name: "Hero", artwork: "cascade-media://p1/references/hero.png" },
  { id: "r2", name: "Villain", artwork: "cascade-media://p1/references/villain.png" },
  { id: "r3", name: "Potion", artwork: "data:image/png;base64,LEGACY" },
] as never;

function Harness({ initial }: { initial?: string }) {
  const [prompt, setPrompt] = useState(initial ?? P0);
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
    } as never,
    shot: { id: "s1", number: 1, prompt, promptManual: true, includeBrandIdentity: true, artwork: "boards/0001.jpg" } as never,
    bust: 0,
    prompt,
    references: REFS,
    styles: [],
    styleValue: "",
    includeBrand: true,
    onPromptChange: (v) => setPrompt(v),
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
  });
}

function renderModal(opts: { initial?: string } = {}): { root: any; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(Harness, opts)); });
  return { root, host };
}

describe("refThumbUrl", () => {
  it("adds ?thumb=1 to cascade-media URLs and leaves data URLs untouched", () => {
    expect(refThumbUrl("cascade-media://p1/references/hero.png")).toBe("cascade-media://p1/references/hero.png?thumb=1");
    expect(refThumbUrl("data:image/png;base64,LEGACY")).toBe("data:image/png;base64,LEGACY");
    expect(refThumbUrl("")).toBe("");
  });
});

describe("node-graph reference thumbnails", () => {
  it("canvas ref nodes and shelf tiles load the compressed thumb, zoom shows full-res", async () => {
    const { root, host } = renderModal();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // Tagged @[Hero] renders a canvas node; its tile uses the thumb URL.
    const nodeImg = host.querySelector(".prod-graph-node.prod-graph-ref img") as HTMLImageElement;
    expect(nodeImg).toBeTruthy();
    expect(nodeImg.getAttribute("src")).toBe("cascade-media://p1/references/hero.png?thumb=1");

    // The shelf lists every reference; disk refs thumb, legacy data URLs pass.
    // (No IntersectionObserver in this environment, so every tile counts as
    // visible and disk thumbs arm on mount.)
    const shelfImgs = [...host.querySelectorAll(".prod-graph-shelf-item img")].map((el) => el.getAttribute("src"));
    expect(shelfImgs).toContain("cascade-media://p1/references/hero.png?thumb=1");
    expect(shelfImgs).toContain("cascade-media://p1/references/villain.png?thumb=1");
    expect(shelfImgs).toContain("data:image/png;base64,LEGACY");

    // Zoom opens the lightbox with the FULL-res URL (no thumb query).
    const zoom = host.querySelector(".prod-graph-ref-zoom") as HTMLButtonElement;
    expect(zoom).toBeTruthy();
    await act(async () => { zoom.click(); await new Promise((r) => setTimeout(r, 0)); });
    const lightboxImg = host.querySelector(".prod-graph-lightbox img") as HTMLImageElement;
    expect(lightboxImg).toBeTruthy();
    expect(lightboxImg.getAttribute("src")).toBe("cascade-media://p1/references/hero.png");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("defers disk-backed shelf thumbs until their tile scrolls into view", async () => {
    // A controllable IntersectionObserver: tiles arm only when the test
    // reports them intersecting.
    const RealIO = (globalThis as any).IntersectionObserver;
    const fires: Array<(visible: boolean) => void> = [];
    (globalThis as any).IntersectionObserver = class {
      cb: (entries: Array<{ isIntersecting: boolean }>) => void;
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) { this.cb = cb; }
      observe() { fires.push((v: boolean) => this.cb([{ isIntersecting: v }])); }
      unobserve() {}
      disconnect() {}
    };
    try {
      const { root, host } = renderModal();
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

      // Nothing scrolled into view: disk tiles show placeholders, while the
      // in-memory data URL renders immediately.
      let shelfImgs = [...host.querySelectorAll(".prod-graph-shelf-item img")].map((el) => el.getAttribute("src"));
      expect(shelfImgs).toEqual(["data:image/png;base64,LEGACY"]);
      expect(fires.length).toBe(2);

      // Scrolling the tiles into view arms their thumbs (slots are free).
      await act(async () => {
        for (const fire of fires) fire(true);
        await new Promise((r) => setTimeout(r, 0));
      });
      shelfImgs = [...host.querySelectorAll(".prod-graph-shelf-item img")].map((el) => el.getAttribute("src"));
      expect(shelfImgs).toContain("cascade-media://p1/references/hero.png?thumb=1");
      expect(shelfImgs).toContain("cascade-media://p1/references/villain.png?thumb=1");
      expect(shelfImgs).toContain("data:image/png;base64,LEGACY");

      await act(async () => { root.unmount(); });
      document.body.removeChild(host);
    } finally {
      (globalThis as any).IntersectionObserver = RealIO;
    }
  });

  it("a dragged shelf ref gets a thumb-bearing canvas node with full-res zoom", async () => {
    const { root, host } = renderModal();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // Drag the untagged @[Villain] onto the canvas.
    const canvas = host.querySelector(".prod-graph-canvas") as HTMLElement;
    const ev = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: DataTransfer };
    ev.dataTransfer = {
      types: ["application/x-cascade-ref"],
      getData: (t: string) => t === "application/x-cascade-ref" ? "r2" : "",
      files: [],
    } as unknown as DataTransfer;
    await act(async () => { canvas.dispatchEvent(ev); await new Promise((r) => setTimeout(r, 0)); });

    const placed = host.querySelector('.prod-graph-node.prod-graph-ref img[src="cascade-media://p1/references/villain.png?thumb=1"]') as HTMLImageElement;
    expect(placed).toBeTruthy();

    const zoom = [...host.querySelectorAll(".prod-graph-ref-zoom")].at(-1) as HTMLButtonElement;
    await act(async () => { zoom.click(); await new Promise((r) => setTimeout(r, 0)); });
    const lightboxImg = host.querySelector(".prod-graph-lightbox img") as HTMLImageElement;
    expect(lightboxImg.getAttribute("src")).toBe("cascade-media://p1/references/villain.png");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});