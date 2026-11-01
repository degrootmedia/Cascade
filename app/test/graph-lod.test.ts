/**
 * Node-graph media performance: node-contained media never needs high res
 * (the lightbox is the high-res surface), so previews/posters/tiles paint
 * FIXED thumbnail tiers — a node's `src` never changes across zoom, so
 * pan/zoom reloads nothing. Off-viewport nodes stay mounted below a node
 * limit (culling unmounts/remounts them at the viewport edge with zero
 * overscan, which read as "reload every image on pan"); above the limit
 * the canvas falls back to React Flow culling. While the viewport moves,
 * live videos stand down to posters. Nodes carry no drop shadow (a
 * per-node shadow re-rasters on every pan/zoom frame).
 *
 * The moodboard keeps its own regime (settled-zoom tiers via
 * `thumbTierFor`, one-screen cull margin) — these tests pin only the graph.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { THUMB_TIERS, thumbTierFor, settledThumbTierFor } from "../src/renderer/src/components/production/thumb-url.js";
import { GRAPH_PREVIEW_EDGE, GRAPH_TILE_EDGE, GRAPH_CULL_NODE_LIMIT } from "../src/renderer/src/components/graph/lod.js";

describe("shared tier math (moodboard settled LOD)", () => {
  it("picks the smallest tier covering the on-screen long edge", () => {
    expect(THUMB_TIERS).toEqual([256, 512, 1024]);
    expect(thumbTierFor(320, 120, 1, 1)).toBe(512);
    expect(thumbTierFor(320, 120, 1, 2)).toBe(1024);
    expect(thumbTierFor(320, 120, 0.2, 1)).toBe(256);
    expect(thumbTierFor(320, 120, 4, 1)).toBe(0);
  });
});

describe("settled tier hysteresis (moodboard swap-wave guard)", () => {
  // Box long edge 1000 at dpr 1: zoom == needed/1000, so cases read as px.
  const settled = (prev: number | undefined, needed: number) =>
    settledThumbTierFor(prev, 1000, 10, needed / 1000, 1);

  it("with no previous tier it is the covering tier (thumbTierFor)", () => {
    expect(settled(undefined, 200)).toBe(256);
    expect(settled(undefined, 500)).toBe(512);
    expect(settled(undefined, 1500)).toBe(0);
  });

  it("upgrades immediately when the painted size outgrows the current tier", () => {
    expect(settled(256, 300)).toBe(512);
    expect(settled(512, 900)).toBe(1024);
    expect(settled(1024, 1500)).toBe(0);
  });

  it("holds the higher tier near a boundary instead of swapping src", () => {
    // 500px paints fine from the already-decoded 1024 bitmap; swapping to
    // 512 costs a fetch+decode for zero visual change.
    expect(settled(1024, 500)).toBe(1024);
    expect(settled(512, 250)).toBe(512);
  });

  it("downgrades once the painted size is well inside the lower tier", () => {
    expect(settled(1024, 380)).toBe(512);
    expect(settled(512, 180)).toBe(256);
    // From full-res (0) it can settle back to a tier.
    expect(settled(0, 700)).toBe(1024);
  });

  it("does not flap when zoom oscillates across a tier boundary", () => {
    let tier: number | undefined;
    for (const needed of [500, 540, 500, 540, 500]) tier = settled(tier, needed);
    // First paint picks 512; 540 upgrades to 1024 once; after that the
    // boundary oscillation must not swap again.
    expect(tier).toBe(1024);
    expect(settled(tier, 500)).toBe(1024);
    expect(settled(tier, 540)).toBe(1024);
  });

  it("is stable: feeding its own answer back returns the same tier", () => {
    for (const needed of [120, 250, 380, 500, 700, 900, 1500]) {
      const once = settled(1024, needed);
      expect(settled(once, needed)).toBe(once);
    }
  });
});

describe("graph fixed-tier policy", () => {
  it("generator previews/posters are the 512 tier; resizable tiles are 1024", () => {
    expect(GRAPH_PREVIEW_EDGE).toBe(512);
    expect(GRAPH_TILE_EDGE).toBe(1024);
    expect(THUMB_TIERS).toContain(GRAPH_PREVIEW_EDGE);
    expect(THUMB_TIERS).toContain(GRAPH_TILE_EDGE);
  });

  it("viewport culling only engages above the node limit", () => {
    expect(GRAPH_CULL_NODE_LIMIT).toBe(150);
  });
});

describe("graph fixed-tier wiring (source guards)", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

  it("expanded graph previews render fixed-tier srcs, not bare full-res urls", () => {
    const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
    expect(modal).not.toContain('<img className="prod-graph-gen-preview" src={data.items[data.selected].url}');
    expect(modal).not.toContain('<img className="prod-graph-output-img" src={data.previewUrl}');
    expect(modal).not.toContain("<img src={data.sheetUrl}");
    expect(modal).not.toContain('<img className="prod-graph-seq-seg-thumb" src={seg.artwork}');
    expect(modal).toContain("GRAPH_PREVIEW_EDGE");
    expect(modal).toContain("GRAPH_TILE_EDGE");
    const refNode = read("../src/renderer/src/components/graph/ref-node.tsx");
    expect(refNode).not.toContain("{mediaEl(data.artwork)}");
    expect(refNode).toContain("GRAPH_TILE_EDGE");
  });

  it("no settled-zoom tier swapping remains in the graph (srcs never change on zoom)", () => {
    const lod = read("../src/renderer/src/components/graph/lod.tsx");
    expect(lod).not.toContain("settledZoom");
    expect(lod).not.toContain("UNDERSHOOT");
    const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
    expect(modal).not.toContain("useLodSrc");
    const refNode = read("../src/renderer/src/components/graph/ref-node.tsx");
    expect(refNode).not.toContain("useLodSrc");
  });

  it("full-res paths stay full-res: lightbox zoom args and the camera-grid editor", () => {
    const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
    expect(modal).toContain('data.onZoom("Image generation", data.items[data.selected].url');
    expect(modal).toContain('<img className="prod-graph-camera-sheet" src={sheetUrl}');
  });

  it("nodes stay mounted below the limit; interacting rides a leaf-owned context", () => {
    const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
    expect(modal).toContain("onlyRenderVisibleElements={nodes.length > GRAPH_CULL_NODE_LIMIT}");
    expect(modal).toContain("onMoveStart");
    // The interacting flag's state lives in the leaf GraphLodProvider:
    // modal-level state re-rendered the whole modal per wheel burst,
    // eating the first zoom increments.
    expect(modal).toContain("<GraphLodProvider handleRef={lodHandleRef}>");
    expect(modal).not.toContain("useGraphLodState");
    expect(modal).not.toContain("GraphLodContext.Provider");
    // No canvas class juggling either: nodes are shadowless outright, so
    // move start/end only flips the leaf context, nothing DOM-styled.
    expect(modal).not.toContain('classList.add("interacting")');
    expect(modal).toContain('className="prod-graph-canvas"');
  });

  it("viewport-only saves are debounced in the modal and echo-skipped in the workspace", () => {
    const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
    expect(modal).toContain("VIEWPORT_SAVE_DEBOUNCE_MS");
    expect(modal).toContain("flushPendingViewport");
    const workspace = read("../src/renderer/src/components/ProductionWorkspace.tsx");
    expect(workspace).toContain("sameSnapshotExceptRev(next, merged)");
  });

  it("moodboard tiers settle through hysteresis, not raw boundary crossings", () => {
    const mood = read("../src/renderer/src/features/moodboard/MoodboardCanvas.tsx");
    expect(mood).toContain("settledThumbTierFor");
    expect(mood).toContain("SETTLED_ZOOM_MS");
    expect(mood).not.toContain("thumbTierFor(n.w");
  });

  it("preview images lazy-load and async-decode so a keep-mounted open prioritizes the viewport", () => {
    const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
    const lazyCount = modal.match(/loading="lazy" decoding="async"/g)?.length ?? 0;
    // gen-strip + seq thumbs (pre-existing) + output/image/edit/upscale/camera previews.
    expect(lazyCount).toBeGreaterThanOrEqual(7);
  });

  it("video previews stand down while the viewport moves and poster at the fixed tier", () => {
    const vp = read("../src/renderer/src/components/graph/video-preview.tsx");
    expect(vp).toContain("posterEdge");
    expect(vp).not.toContain("usePosterSrc");
    expect(vp).toContain("interacting");
    expect(vp).toContain("deactivateLiveVideo(instanceId)");
  });

  it("nodes carry no drop shadow (re-rastered per pan/zoom frame otherwise)", () => {
    const css = read("../src/renderer/src/styles.css");
    // The first `.prod-graph-node {…}` rule in file order is the base node
    // rule (the selected-state ring is a separate, longer selector).
    const base = css.match(/\.prod-graph-node \{([^}]*)\}/);
    expect(base).not.toBeNull();
    expect(base![1]).not.toContain("box-shadow");
    expect(css).not.toContain(".prod-graph-canvas.interacting");
  });

  it("history surfaces stay at the 256 tier (strip images, modal tiles)", () => {
    const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
    expect(modal).toContain("<img src={refThumbUrl(it.url)}");
    const history = read("../src/renderer/src/components/graph/history-modal.tsx");
    expect(history).toContain("<img src={refThumbUrl(it.url)}");
  });
});
