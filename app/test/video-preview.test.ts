/**
 * Poster-first node video previews (perf phase 1): the live-video LRU cap
 * that bounds how many real <video> decoders the node graph can hold, and
 * source guards that the graph's video surfaces stay poster-first (a raw
 * mounted <video preload="metadata"> per node was the measured stall when
 * opening take-rich shots).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MAX_LIVE_NODE_VIDEOS,
  activateLiveVideo,
  deactivateLiveVideo,
  isLiveVideo,
  liveVideoIdsForTests,
  resetLiveVideosForTests,
} from "../src/renderer/src/components/graph/video-preview.js";

beforeEach(() => resetLiveVideosForTests());

describe("live video registry", () => {
  it("caps simultaneously live videos, evicting the oldest activation", () => {
    for (let i = 0; i < MAX_LIVE_NODE_VIDEOS + 2; i++) activateLiveVideo(`n${i}`);
    expect(liveVideoIdsForTests()).toHaveLength(MAX_LIVE_NODE_VIDEOS);
    expect(isLiveVideo("n0")).toBe(false);
    expect(isLiveVideo("n1")).toBe(false);
    expect(isLiveVideo(`n${MAX_LIVE_NODE_VIDEOS + 1}`)).toBe(true);
  });

  it("re-activating an id refreshes its recency instead of duplicating it", () => {
    activateLiveVideo("a");
    activateLiveVideo("b");
    activateLiveVideo("a");
    expect(liveVideoIdsForTests()).toEqual(["b", "a"]);
  });

  it("deactivating frees the slot; unknown ids are a no-op", () => {
    activateLiveVideo("a");
    deactivateLiveVideo("a");
    deactivateLiveVideo("never-live");
    expect(liveVideoIdsForTests()).toEqual([]);
  });
});

describe("node graph stays poster-first (source guards)", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

  it("generation/output/ref nodes render VideoPreview, not raw mounted videos", () => {
    const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
    expect(modal).not.toContain('<video className="prod-graph-gen-preview');
    expect(modal).not.toContain('<video className="prod-graph-output-img');
    expect(modal.match(/<VideoPreview /g)?.length).toBeGreaterThanOrEqual(3);
    const refNode = read("../src/renderer/src/components/graph/ref-node.tsx");
    expect(refNode).not.toContain('<video className="prod-graph-ref-video"');
    expect(refNode).toContain("<VideoPreview ");
  });

  it("native full screen on generation videos is redirected to the shared lightbox", () => {
    const preview = read("../src/renderer/src/components/graph/video-preview.tsx");
    expect(preview).toContain("fullscreenchange");
    expect(preview).toContain("exitFullscreen");
    const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
    expect(modal.match(/controls onExpand=\{\(\) => data\.onZoom\(/g)?.length).toBe(2);
  });

  it("the canvas culls off-viewport nodes only above the node limit", () => {
    const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
    expect(modal).toContain("onlyRenderVisibleElements={nodes.length > GRAPH_CULL_NODE_LIMIT}");
  });
});
