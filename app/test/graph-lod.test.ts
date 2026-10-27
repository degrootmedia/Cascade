/**
 * Node-graph media performance: node-contained media never needs high res
 * (the lightbox is the high-res surface), so previews/posters/tiles paint
 * FIXED thumbnail tiers — a node's `src` never changes across zoom, so
 * pan/zoom reloads nothing. Off-viewport nodes stay mounted below a node
 * limit (culling unmounts/remounts them at the viewport edge with zero
 * overscan, which read as "reload every image on pan"); above the limit
 * the canvas falls back to React Flow culling. While the viewport moves,
 * live videos stand down to posters and node shadows drop.
 *
 * The moodboard keeps its own regime (settled-zoom tiers via
 * `thumbTierFor`, one-screen cull margin) — these tests pin only the graph.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { THUMB_TIERS, thumbTierFor } from "../src/renderer/src/components/production/thumb-url.js";
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

  it("nodes stay mounted below the limit; interacting still rides context", () => {
    const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
    expect(modal).toContain("onlyRenderVisibleElements={nodes.length > GRAPH_CULL_NODE_LIMIT}");
    expect(modal).toContain("onMoveStart");
    expect(modal).toContain("GraphLodContext.Provider");
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

  it("node shadows drop while interacting", () => {
    const css = read("../src/renderer/src/styles.css");
    expect(css).toContain(".prod-graph-canvas.interacting");
  });

  it("history surfaces stay at the 256 tier (strip images, modal tiles)", () => {
    const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
    expect(modal).toContain("<img src={refThumbUrl(it.url)}");
    const history = read("../src/renderer/src/components/graph/history-modal.tsx");
    expect(history).toContain("<img src={refThumbUrl(it.url)}");
  });
});
