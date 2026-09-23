/**
 * connectionToEdge + graph mutation tests (master plan step 03 T6): every
 * effective onConnect branch maps to the same edge the canvas derives, with
 * the same singleton replacements. No branch is deleted from the modal until
 * its test here proves the edge.
 */
import { describe, it, expect } from "vitest";
import {
  addGraphNode,
  applyCameraGridRefs,
  applyConnection,
  applyTweenKeys,
  canonicalNodeId,
  connectionToEdge,
  connectTweenKey,
  ensurePromptPipe,
  graphEdgesForDetach,
  nodeKindForId,
  removeGraphEdge,
  removeGraphNode,
  tweenKeyForSource,
  tweenKeyToNode,
  tweenKeysAfterConnect,
  type FlowConnection,
} from "../src/shared/graph/connect.js";
import { materializeGraph } from "../src/shared/graph/materialize.js";
import { normalizeGraph } from "../src/shared/graph/normalize.js";
import { TWEEN_KEY_IMGGEN } from "../src/shared/ipc.js";
import type { Graph, ProductionShot } from "../src/shared/ipc.js";

const REFS = [
  { id: "r1", name: "Gondola", artwork: "g.png" },
  { id: "r2", name: "Marco", media: "video" as const, artwork: "m.png" },
];

const shot = (over: Partial<ProductionShot> = {}): ProductionShot =>
  ({ id: "s1", number: "0100", audio: "", visual: "", ...over }) as ProductionShot;

/** Rich canvas: video pair, one edit node, one keyframe, imagegen output, tagged r1. */
function baseGraph(): Graph {
  const g = materializeGraph(
    shot({
      prompt: "Base @[Gondola]",
      graphVideoPrompt: "Drift",
      graphImageToVideo: true,
      graphEditNodes: [{ id: "edit0", prompt: "Fix", source: { kind: "imagegen" } }],
      graphTweenRefIds: [TWEEN_KEY_IMGGEN],
      graphOutputSource: "imagegen",
    }),
    REFS
  );
  expect(normalizeGraph(g).issues).toEqual([]);
  return g;
}

/** Base canvas plus the edit-video pair and a placed r2 (shelf drag). */
function videoEditGraph(): Graph {
  let g = materializeGraph(
    shot({
      prompt: "Base @[Gondola]",
      graphVideoPrompt: "Drift",
      graphImageToVideo: true,
      graphEditVideoPrompt: "Cut",
      graphOutputSource: "imagegen",
    }),
    REFS
  );
  g = addGraphNode(g, { id: "ref:r2", kind: "ref", pos: { x: 0, y: 0 }, data: { label: "Marco" } });
  expect(normalizeGraph(g).issues).toEqual([]);
  return g;
}

const conn = (source: string, target: string, targetHandle?: string): FlowConnection => ({ source, target, targetHandle });
const keysOf = (g: Graph): string[] => g.edges.map((e) => e.id);

function connect(g: Graph, c: FlowConnection): Graph {
  const op = connectionToEdge(c, g);
  expect(op, `${c.source}→${c.target}:${c.targetHandle}`).not.toBeNull();
  const next = applyConnection(g, op!);
  expect(normalizeGraph(next).issues).toEqual([]);
  return next;
}

describe("nodeKindForId / canonicalNodeId", () => {
  it("resolves structural, prefixed, and legacy bare ids", () => {
    expect(nodeKindForId("composer")).toBe("composer");
    expect(nodeKindForId("editgen:edit3")).toBe("editgen");
    expect(nodeKindForId("editprompt:edit0")).toBe("editprompt");
    expect(nodeKindForId("ref:r1")).toBe("ref");
    expect(nodeKindForId("editgen")).toBe("editgen");
    expect(nodeKindForId("nope")).toBeNull();
    expect(canonicalNodeId("editgen")).toBe("editgen:edit0");
    expect(canonicalNodeId("editprompt")).toBe("editprompt:edit0");
    expect(canonicalNodeId("ref:r1")).toBe("ref:r1");
  });
});

describe("tween key helpers mirror wireTweenKeyframe", () => {
  it("maps sources to key ids", () => {
    expect(tweenKeyForSource("imagegen")).toBe(TWEEN_KEY_IMGGEN);
    expect(tweenKeyForSource("editgen:edit2")).toBe("editgen:edit2");
    expect(tweenKeyForSource("editgen")).toBe("editgen:edit0");
    expect(tweenKeyForSource("ref:r1")).toBe("r1");
    expect(tweenKeyForSource("composer")).toBeNull();
  });

  it("move-or-inserts with slot clamp and a 5-key cap", () => {
    expect(tweenKeysAfterConnect(["a", "b"], "c", 1)).toEqual(["a", "c", "b"]);
    expect(tweenKeysAfterConnect(["a", "b"], "a", 1)).toEqual(["b", "a"]);
    expect(tweenKeysAfterConnect(["a"], "b", 9)).toEqual(["a", "b"]);
    expect(tweenKeysAfterConnect(["1", "2", "3", "4", "5"], "6", 4)).toHaveLength(5);
  });
});

describe("connectionToEdge: edit-video source", () => {
  it("videogen→editvideo:in-video yields e-vid-ev, replacing a ref source", () => {
    let g = connect(videoEditGraph(), conn("ref:r2", "editvideo", "in-video"));
    expect(keysOf(g)).toContain("e-ref-ev");
    g = connect(g, conn("videogen", "editvideo", "in-video"));
    expect(keysOf(g)).toContain("e-vid-ev");
    expect(keysOf(g)).not.toContain("e-ref-ev");
  });
});

describe("connectionToEdge: imagegen fan-out", () => {
  it("imagegen→videogen replaces an edit source (singleton sink)", () => {
    let g = connect(baseGraph(), conn("editgen:edit0", "videogen", "in-image"));
    expect(keysOf(g)).toContain("e-edit-vid");
    expect(keysOf(g)).not.toContain("e-img-vid");
    g = connect(g, conn("imagegen", "videogen", "in-image"));
    expect(keysOf(g)).toContain("e-img-vid");
    expect(keysOf(g)).not.toContain("e-edit-vid");
  });

  it("imagegen→output replaces the output feed", () => {
    const g = connect(baseGraph(), conn("videogen", "output", "in-out"));
    expect(keysOf(g)).toContain("e-vid-out");
    expect(keysOf(g)).not.toContain("e-img-out");
  });

  it("imagegen→edit source replaces that node's pipe", () => {
    const g = connect(baseGraph(), conn("imagegen", "editgen:edit0", "in-image"));
    expect(keysOf(g)).toContain("e-img-edit:edit0");
  });

  it("keyframe sockets route through connectTweenKey, not connectionToEdge", () => {
    const g = baseGraph();
    expect(connectionToEdge(conn("imagegen", "tween", "in-tween-1"), g)).toBeNull();
    expect(connectionToEdge(conn("ref:r1", "tween", "in-tween-0"), g)).toBeNull();
    expect(connectionToEdge(conn("editgen:edit0", "tween", "in-tween-0"), g)).toBeNull();
  });
});

describe("connectionToEdge: clips to output", () => {
  it("videogen→output and tween→output yield their feed edges", () => {
    expect(keysOf(connect(baseGraph(), conn("videogen", "output", "in-out")))).toContain("e-vid-out");
    expect(keysOf(connect(baseGraph(), conn("tween", "output", "in-out")))).toContain("e-tween-out");
  });
});

describe("connectionToEdge: edit outputs", () => {
  it("editgen→videogen / output", () => {
    expect(keysOf(connect(baseGraph(), conn("editgen:edit0", "videogen", "in-image")))).toContain("e-edit-vid");
    expect(keysOf(connect(baseGraph(), conn("editgen:edit0", "output", "in-out")))).toContain("e-edit-out");
  });
});

describe("connectTweenKey: keyframe sockets are positional", () => {
  const resolve = (g: Graph) => (key: string) =>
    tweenKeyToNode(key, new Set(["edit0"]), new Set(g.nodes.map((n) => n.id).filter((id) => id.startsWith("ref:"))));

  it("imagegen→slot appends at the clamped position and rebuilds all keyframe edges", () => {
    const g = baseGraph(); // keys: [imagegen]
    const { graph: next, keys } = connectTweenKey(g, "r1", 1, [TWEEN_KEY_IMGGEN], resolve(g));
    expect(keys).toEqual([TWEEN_KEY_IMGGEN, "r1"]);
    const e1 = next.edges.find((x) => x.id === "e-tween-1")!;
    expect(e1.from).toEqual({ node: "ref:r1", port: "out" });
    expect(e1.to).toEqual({ node: "tween", port: "in-tween-1" });
    expect(normalizeGraph(next).issues).toEqual([]);
  });

  it("re-plugging an existing key moves it (editgen sentinel)", () => {
    const g = baseGraph();
    const r1 = connectTweenKey(g, "r1", 1, [TWEEN_KEY_IMGGEN], resolve(g));
    const moved = connectTweenKey(r1.graph, "editgen:edit0", 0, r1.keys, resolve(g));
    expect(moved.keys).toEqual(["editgen:edit0", TWEEN_KEY_IMGGEN, "r1"]);
    expect(moved.graph.edges.find((x) => x.id === "e-tween-0")?.from.node).toBe("editgen:edit0");
    expect(normalizeGraph(moved.graph).issues).toEqual([]);
  });
});

describe("connectionToEdge: references", () => {
  it("ref→output / videogen / edit source", () => {
    expect(keysOf(connect(baseGraph(), conn("ref:r1", "output", "in-out")))).toContain("e-ref-out");
    expect(keysOf(connect(baseGraph(), conn("ref:r1", "videogen", "in-image")))).toContain("e-ref-vid");
    expect(keysOf(connect(baseGraph(), conn("ref:r1", "editgen:edit0", "in-image")))).toContain("e-ref-edit:edit0");
  });

  it("ref→open prompt socket appends; occupied slot replaces", () => {
    const placed = addGraphNode(baseGraph(), { id: "ref:r2", kind: "ref", pos: { x: 0, y: 0 }, data: { label: "Marco" } });
    const g = connect(placed, conn("ref:r2", "composer", "in-ref-open"));
    expect(keysOf(g)).toContain("e-ref:r2-composer-1");
    const g2 = connect(g, conn("ref:r2", "composer", "in-ref-0"));
    expect(keysOf(g2)).toContain("e-ref:r2-composer-0");
    expect(keysOf(g2)).not.toContain("e-ref:r1-composer-0");
  });

  it("ref→tween slot routes through connectTweenKey", () => {
    const g = baseGraph();
    expect(connectionToEdge(conn("ref:r1", "tween", "in-tween-0"), g)).toBeNull();
  });
});

describe("connectionToEdge: style / brand plugs", () => {
  it("style→composer / videoprompt / editprompt", () => {
    expect(keysOf(connect(baseGraph(), conn("style", "composer", "in-style")))).toContain("e-style");
    expect(keysOf(connect(baseGraph(), conn("style", "videoprompt", "in-style")))).toContain("e-style-vp");
    expect(keysOf(connect(baseGraph(), conn("style", "editprompt:edit0", "in-style")))).toContain("e-style-ep:edit0");
  });

  it("brand→composer / editprompt", () => {
    expect(keysOf(connect(baseGraph(), conn("brand", "composer", "in-brand")))).toContain("e-brand");
    expect(keysOf(connect(baseGraph(), conn("brand", "editprompt:edit0", "in-brand")))).toContain("e-brand-ep:edit0");
  });
});

describe("connectionToEdge: fixed pipes carry no wire", () => {
  it("prompt→generator pipes return null", () => {
    const g = baseGraph();
    expect(connectionToEdge(conn("composer", "imagegen", "in-prompt"), g)).toBeNull();
    expect(connectionToEdge(conn("videoprompt", "videogen", "in-prompt"), g)).toBeNull();
    expect(connectionToEdge(conn("editprompt:edit0", "editgen:edit0", "in-prompt"), g)).toBeNull();
  });
});

describe("ensurePromptPipe emits the runtime pair's fixed pipe", () => {
  /** A graph with a placed edit pair but no pipe (the addTool bug). */
  const bareEditPair = (): Graph => {
    let g = addGraphNode({ version: 1, nodes: [], edges: [] }, { id: "editprompt:edit2", kind: "editprompt", pos: { x: 0, y: 0 } });
    g = addGraphNode(g, { id: "editgen:edit2", kind: "editgen", pos: { x: 0, y: 0 } });
    return g;
  };

  it("adds the per-edit-node pipe with the materializer's edge id", () => {
    const g = ensurePromptPipe(bareEditPair(), "editgen:edit2");
    const e = g.edges.find((x) => x.id === "e-ep-edit:edit2");
    expect(e).toEqual({ id: "e-ep-edit:edit2", from: { node: "editprompt:edit2", port: "out" }, to: { node: "editgen:edit2", port: "in-prompt" } });
  });

  it("is idempotent and no-ops when an endpoint is missing", () => {
    const once = ensurePromptPipe(bareEditPair(), "editgen:edit2");
    expect(ensurePromptPipe(once, "editgen:edit2").edges.length).toBe(once.edges.length);
    const orphan = addGraphNode({ version: 1, nodes: [], edges: [] }, { id: "videogen", kind: "videogen", pos: { x: 0, y: 0 } });
    expect(ensurePromptPipe(orphan, "videogen").edges).toEqual([]);
  });

  it("covers the video and edit-video pairs too", () => {
    let g: Graph = { version: 1, nodes: [], edges: [] };
    for (const id of ["videogen", "videoprompt", "editvideo", "editvideoprompt"] as const) {
      g = addGraphNode(g, { id, kind: id, pos: { x: 0, y: 0 } });
    }
    g = ensurePromptPipe(ensurePromptPipe(g, "videogen"), "editvideo");
    expect(g.edges.map((e) => e.id).sort()).toEqual(["e-evp-ev", "e-vp-vid"]);
  });
});

describe("graph node/edge removal", () => {
  it("removeGraphEdge drops one wire; removeGraphNode drops node + incident wires", () => {
    const g = baseGraph();
    const e1 = removeGraphEdge(g, "e-img-out");
    expect(keysOf(e1)).not.toContain("e-img-out");
    expect(keysOf(e1)).toContain("e-cmp-img");
    const n1 = removeGraphNode(g, "imagegen");
    expect(n1.nodes.some((n) => n.id === "imagegen")).toBe(false);
    expect(n1.edges.some((e) => e.from.node === "imagegen" || e.to.node === "imagegen")).toBe(false);
  });

  it("addGraphNode is idempotent; applyTweenKeys rebuilds keyframe edges", () => {
    const g = baseGraph();
    const again = addGraphNode(g, { id: "tween", kind: "tween", pos: { x: 0, y: 0 } });
    expect(again.nodes.length).toBe(g.nodes.length);
    const rebuilt = applyTweenKeys(g, ["r1", TWEEN_KEY_IMGGEN], (k) => (k === TWEEN_KEY_IMGGEN ? "imagegen" : `ref:${k}`));
    expect(keysOf(rebuilt)).toContain("e-tween-0");
    expect(keysOf(rebuilt)).toContain("e-tween-1");
    expect(rebuilt.edges.find((e) => e.id === "e-tween-0")?.from.node).toBe("ref:r1");
  });
});

describe("graphEdgesForDetach mirrors onConnectEnd strips", () => {
  const ctx = { tweenKeys: [TWEEN_KEY_IMGGEN, "r1"], editIds: new Set(["edit0"]), refNodeIds: new Set(["ref:r1"]) };
  const detach = (type: string, nodeId: string, handleId: string) => ({ type, nodeId, handleId });

  it("prompt sockets drop their wire", () => {
    const g = baseGraph();
    // e-style absent here (no style plug) → null, no useless save.
    expect(graphEdgesForDetach(g, detach("target", "composer", "in-style"), ctx)).toBeNull();
    const styled = applyConnection(g, connectionToEdge(conn("style", "composer", "in-style"), g)!);
    expect(graphEdgesForDetach(styled, detach("target", "composer", "in-style"), ctx)?.edges.map((e) => e.id)).not.toContain("e-style");
    expect(graphEdgesForDetach(g, detach("target", "composer", "in-ref-0"), ctx)?.edges.map((e) => e.id)).not.toContain("e-ref:r1-composer-0");
  });

  it("generator inputs drop their feed", () => {
    const g = baseGraph(); // e-img-vid present
    expect(graphEdgesForDetach(g, detach("target", "videogen", "in-image"), ctx)?.edges.map((e) => e.id)).not.toContain("e-img-vid");
    expect(graphEdgesForDetach(g, detach("target", "output", "in-out"), ctx)?.edges.map((e) => e.id)).not.toContain("e-img-out");
    expect(graphEdgesForDetach(g, detach("target", "editgen:edit0", "in-image"), ctx)?.edges.map((e) => e.id)).not.toContain("e-img-edit:edit0");
  });

  it("tween socket rebuilds positionally", () => {
    const g = baseGraph(); // keys [imagegen]
    const next = graphEdgesForDetach(g, detach("target", "tween", "in-tween-0"), { ...ctx, tweenKeys: [TWEEN_KEY_IMGGEN] });
    expect(next?.edges.map((e) => e.id)).not.toContain("e-tween-0");
    expect(graphEdgesForDetach(g, detach("target", "tween", "in-tween-9"), ctx)).toBeNull();
  });

  it("source drags unbind outputs (videogen gap mirrored)", () => {
    const g = applyConnection(baseGraph(), connectionToEdge(conn("videogen", "output", "in-out"), baseGraph())!);
    const ungen = graphEdgesForDetach(g, detach("source", "imagegen", ""), ctx)!;
    expect(ungen.edges.some((e) => e.from.node === "imagegen")).toBe(false);
    expect(ungen.edges.some((e) => e.id === "e-cmp-img")).toBe(true);
    const unvid = graphEdgesForDetach(g, detach("source", "videogen", ""), ctx)!;
    expect(keysOf(unvid)).not.toContain("e-vid-out");
    // edit-video feed survives the drag-off exactly as the legacy unpipe does.
    const withEv = applyConnection(g, { edge: { id: "e-vid-ev", from: { node: "videogen", port: "out" }, to: { node: "editvideo", port: "in-video" } }, dropIds: [] });
    expect(keysOf(graphEdgesForDetach(withEv, detach("source", "videogen", ""), ctx)!)).toContain("e-vid-ev");
    expect(graphEdgesForDetach(g, detach("source", "style", ""), ctx)).toBeNull();
    expect(graphEdgesForDetach(g, detach("source", "ref:r9", ""), ctx)).toBeNull();
  });

  it("unknown handles map to nothing", () => {
    const g = baseGraph();
    expect(graphEdgesForDetach(g, detach("target", "composer", "nope"), ctx)).toBeNull();
    expect(graphEdgesForDetach(g, detach("target", "editvideo", "in-video"), ctx)).toBeNull();
    expect(graphEdgesForDetach(g, { type: "other", nodeId: "x", handleId: "y" }, ctx)).toBeNull();
  });
});

describe("camera-grid wiring", () => {
  const detach = (type: string, nodeId: string, handleId: string) => ({ type, nodeId, handleId });
  const camCtx = { tweenKeys: [], editIds: new Set<string>(), refNodeIds: new Set(["ref:r1", "ref:r2"]) };

  /** A graph with the camera-grid node, an edit node, and a placed r1. */
  const withGrid = (): Graph => {
    let g = materializeGraph(shot({}), REFS);
    g = addGraphNode(g, { id: "cameraGrid", kind: "cameraGrid", pos: { x: 0, y: 0 } });
    g = addGraphNode(g, { id: "editgen:edit0", kind: "editgen", pos: { x: 0, y: 0 } });
    g = addGraphNode(g, { id: "ref:r1", kind: "ref", pos: { x: 0, y: 0 }, data: { label: "Gondola" } });
    return g;
  };

  it("imagegen / editgen / ref feed the source socket", () => {
    expect(keysOf(connect(withGrid(), conn("imagegen", "cameraGrid", "in-image")))).toContain("e-img-camgrid");
    expect(keysOf(connect(withGrid(), conn("editgen:edit0", "cameraGrid", "in-image")))).toContain("e-edit-camgrid");
    expect(keysOf(connect(withGrid(), conn("ref:r1", "cameraGrid", "in-image")))).toContain("e-ref-camgrid");
  });

  it("the source socket is a singleton (new feed replaces the old)", () => {
    const g = connect(withGrid(), conn("ref:r1", "cameraGrid", "in-image"));
    const next = connect(g, conn("imagegen", "cameraGrid", "in-image"));
    expect(keysOf(next)).toContain("e-img-camgrid");
    expect(keysOf(next)).not.toContain("e-ref-camgrid");
  });

  it("imagegen / editgen / ref feed the grid-image socket, independent of the source", () => {
    expect(keysOf(connect(withGrid(), conn("imagegen", "cameraGrid", "in-grid")))).toContain("e-img-camgrid-grid");
    expect(keysOf(connect(withGrid(), conn("editgen:edit0", "cameraGrid", "in-grid")))).toContain("e-edit-camgrid-grid");
    expect(keysOf(connect(withGrid(), conn("ref:r1", "cameraGrid", "in-grid")))).toContain("e-ref-camgrid-grid");
    // Both sockets coexist: wiring the grid image leaves the source wire alone.
    const both = connect(connect(withGrid(), conn("ref:r1", "cameraGrid", "in-image")), conn("imagegen", "cameraGrid", "in-grid"));
    expect(keysOf(both)).toContain("e-ref-camgrid");
    expect(keysOf(both)).toContain("e-img-camgrid-grid");
  });

  it("dragging the grid-image wire off drops only that socket", () => {
    const g = connect(withGrid(), conn("ref:r1", "cameraGrid", "in-grid"));
    const next = graphEdgesForDetach(g, { type: "target", nodeId: "cameraGrid", handleId: "in-grid" }, camCtx);
    expect(next).not.toBeNull();
    expect(keysOf(next!)).not.toContain("e-ref-camgrid-grid");
  });

  it("reference sockets route through applyCameraGridRefs, not connectionToEdge", () => {
    const g = withGrid();
    expect(connectionToEdge(conn("ref:r1", "cameraGrid", "in-ref-open"), g)).toBeNull();
    expect(connectionToEdge(conn("ref:r1", "cameraGrid", "in-ref-0"), g)).toBeNull();
  });

  it("applyCameraGridRefs emits positional edges only for placed refs", () => {
    const g = withGrid();
    const next = applyCameraGridRefs(g, ["r1", "r2"]);
    expect(keysOf(next)).toContain("e-ref:r1-cameraGrid-0");
    expect(next.edges.some((e) => e.to.node === "cameraGrid" && e.to.port === "in-ref-1")).toBe(false);
    const withR2 = addGraphNode(next, { id: "ref:r2", kind: "ref", pos: { x: 0, y: 0 }, data: { label: "Marco" } });
    const rebuilt = applyCameraGridRefs(withR2, ["r1", "r2"]);
    expect(rebuilt.edges.find((e) => e.id === "e-ref:r2-cameraGrid-1")?.to.port).toBe("in-ref-1");
    expect(rebuilt.edges.find((e) => e.id === "e-ref:r1-cameraGrid-0")?.to.node).toBe("cameraGrid");
    expect(normalizeGraph(rebuilt).issues).toEqual([]);
  });

  it("source detach drops the feed; ref sockets are rebuilt by the caller", () => {
    const g = connect(withGrid(), conn("imagegen", "cameraGrid", "in-image"));
    expect(graphEdgesForDetach(g, detach("target", "cameraGrid", "in-image"), camCtx)?.edges.map((e) => e.id)).not.toContain("e-img-camgrid");
    expect(graphEdgesForDetach(g, detach("target", "cameraGrid", "in-ref-0"), camCtx)).toBeNull();
    // A source drag-off removes every camera-grid edge from that node.
    const dropped = graphEdgesForDetach(g, detach("source", "imagegen", ""), camCtx)!;
    expect(dropped.edges.some((e) => e.to.node === "cameraGrid")).toBe(false);
  });
});

describe("upscale node wiring", () => {
  const detach = (type: string, nodeId: string, handleId: string) => ({ type, nodeId, handleId });
  const ctx = { tweenKeys: [], editIds: new Set<string>(), refNodeIds: new Set(["ref:r1"]) };

  /** A graph with the upscale node, an edit node, and a placed r1. */
  const withUpscale = (): Graph => {
    let g = materializeGraph(shot({}), REFS);
    g = addGraphNode(g, { id: "upscale", kind: "upscale", pos: { x: 0, y: 0 } });
    g = addGraphNode(g, { id: "editgen:edit0", kind: "editgen", pos: { x: 0, y: 0 } });
    g = addGraphNode(g, { id: "ref:r1", kind: "ref", pos: { x: 0, y: 0 }, data: { label: "Gondola" } });
    return g;
  };

  it("imagegen / editgen / ref feed the source socket; the output feeds the output node", () => {
    expect(keysOf(connect(withUpscale(), conn("imagegen", "upscale", "in-image")))).toContain("e-img-upscale");
    expect(keysOf(connect(withUpscale(), conn("editgen:edit0", "upscale", "in-image")))).toContain("e-edit-upscale");
    expect(keysOf(connect(withUpscale(), conn("ref:r1", "upscale", "in-image")))).toContain("e-ref-upscale");
    const out = connect(withUpscale(), conn("upscale", "output", "in-out"));
    expect(keysOf(out)).toContain("e-upscale-out");
  });

  it("the source socket is a singleton (new feed replaces the old)", () => {
    const g = connect(withUpscale(), conn("ref:r1", "upscale", "in-image"));
    const next = connect(g, conn("imagegen", "upscale", "in-image"));
    expect(keysOf(next)).toContain("e-img-upscale");
    expect(keysOf(next)).not.toContain("e-ref-upscale");
  });

  it("detach drops the source feed and the output feed", () => {
    const g = connect(withUpscale(), conn("imagegen", "upscale", "in-image"));
    expect(graphEdgesForDetach(g, detach("target", "upscale", "in-image"), ctx)?.edges.map((e) => e.id)).not.toContain("e-img-upscale");
    const withOut = connect(g, conn("upscale", "output", "in-out"));
    const dropped = graphEdgesForDetach(withOut, detach("source", "upscale", ""), ctx)!;
    expect(dropped.edges.some((e) => e.to.node === "output")).toBe(false);
  });
});
