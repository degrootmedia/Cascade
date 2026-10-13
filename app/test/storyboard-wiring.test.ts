/**
 * Two-view selection wiring: a storyboard selection (Make Primary by path,
 * or any selection write) must rewire the stored graph's Frame Output edge
 * to the owning node — and move that node's active take — so node view and
 * storyboard can never disagree about what feeds the output.
 */
import { describe, it, expect, vi } from "vitest";
import type { Graph, ProductionShot } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { selectBoardFrame, setShotSelectedOutput, syncShotGraphOutput } from "../src/main/pipeline.js";
import { boardFrameHistory } from "../src/shared/board-frames.js";
import { frameOrigin } from "../src/shared/generations.js";
import { resolveShotDisplay } from "../src/shared/selected-output.js";

const OUT_EDGES = (s: ProductionShot) => (s.graph?.edges ?? []).filter((e) => e.to.node === "output" && e.to.port === "in-out");

function wiredShot(): ProductionShot {
  const graph: Graph = {
    version: 1,
    migrated: true,
    nodes: [
      { id: "composer", kind: "composer", pos: { x: 0, y: 0 } },
      { id: "imagegen", kind: "imagegen", pos: { x: 1, y: 0 } },
      { id: "videogen", kind: "videogen", pos: { x: 2, y: 0 } },
      { id: "output", kind: "output", pos: { x: 3, y: 0 } },
    ],
    edges: [{ id: "e-vid-out", from: { node: "videogen", port: "out" }, to: { node: "output", port: "in-out" } }],
  };
  return {
    id: "s1",
    number: "0100",
    audio: "",
    visual: "",
    graph,
    graphOutputSource: "videogen",
    graphOutputVideoNodeId: "vid0",
    graphVideoNodes: [{ id: "vid0", prompt: "", gens: [{ path: "boards/0100/clip.mp4", prompt: "", model: "", at: "" }], genIndex: 0 }],
    graphImageGens: [
      { path: "boards/0100/new.jpg", prompt: "", model: "", at: "2026-01-02T00:00:00.000Z" },
      { path: "boards/0100/old.jpg", prompt: "", model: "", at: "2026-01-01T00:00:00.000Z" },
    ],
    graphImageGenIndex: 0,
    graphUpscale: { gens: [{ path: "boards/0100/up.jpg", prompt: "", model: "", at: "2026-01-03T00:00:00.000Z" }], genIndex: 0 },
  } as ProductionShot;
}

describe("storyboard Make Primary rewires the stored graph", () => {
  it("promoting an image-gen frame rewires output to the image node and activates the take", () => {
    const s = wiredShot();
    selectBoardFrame(s, "boards/0100/old.jpg");
    expect(s.graphImageGenIndex).toBe(1);
    expect(s.graphOutputSource).toBe("imagegen");
    expect(OUT_EDGES(s).map((e) => e.from.node)).toEqual(["imagegen"]);
    expect(resolveShotDisplay(s).path).toBe("boards/0100/old.jpg");
  });

  it("selecting the video take again wires the video node back", () => {
    const s = wiredShot();
    selectBoardFrame(s, "boards/0100/old.jpg");
    setShotSelectedOutput(s, { kind: "videogen", nodeId: "vid0" });
    expect(OUT_EDGES(s).map((e) => e.from.node)).toEqual(["videogen"]);
  });

  it("unpipe removes the output wire", () => {
    const s = wiredShot();
    setShotSelectedOutput(s, { kind: "unpipe" });
    expect(OUT_EDGES(s)).toEqual([]);
  });

  it("syncing a settled selection is a fixed point", () => {
    const s = wiredShot();
    selectBoardFrame(s, "boards/0100/old.jpg");
    const settled = JSON.stringify(s.graph);
    syncShotGraphOutput(s);
    selectBoardFrame(s, "boards/0100/old.jpg");
    expect(JSON.stringify(s.graph)).toBe(settled);
  });
});

describe("history and origin", () => {
  it("history includes upscale generations", () => {
    expect(boardFrameHistory(wiredShot())).toContain("boards/0100/up.jpg");
  });

  it("origin codes name the owning node type", () => {
    const s = wiredShot();
    expect(frameOrigin(s, "boards/0100/old.jpg")).toEqual({ code: "IMG", label: "Image gen node" });
    expect(frameOrigin(s, "boards/0100/up.jpg")?.code).toBe("UPSCALE");
    expect(frameOrigin(s, "boards/0100/clip.mp4")?.code).toBe("VIDEO");
    expect(frameOrigin(s, "boards/0100/legacy.jpg")).toBeNull();
  });
});
