/**
 * Graph connection ops (master plan step 03 T6): pure mapping from a canvas
 * connection to a stored edge, plus edge/node mutation helpers.
 *
 * `connectionToEdge` mirrors every effective `onConnect` branch in
 * NodeGraphModal (same edge ids as the materializer, same mutual-exclusion
 * replacements); `canConnect` (ports.ts) gates types while ReactFlow's
 * `isValidConnection` keeps the stateful rules (tween capacity, edit cycles,
 * artwork presence). Each op is unit-tested per branch — no branch is deleted
 * from the modal until its test proves the same edge.
 *
 * Legacy flag/text writes continue alongside (LEGACY-PROJECTION): generation
 * still consumes flags/text until steps 04–05 move it onto the graph. Both
 * projections derive from the same connection event, so they cannot diverge;
 * step 10 deletes the legacy side.
 */
import type { Graph, GraphEdge, GraphNode, GraphNodeKind } from "../ipc.js";
import { TWEEN_KEY_IMGGEN, TWEEN_KEY_EDITGEN_PREFIX } from "../ipc.js";

/** Structural canvas connection (ReactFlow Connection shape, no UI import). */
export interface FlowConnection {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

const EDITGEN_PREFIX = "editgen:";
const EDITPROMPT_PREFIX = "editprompt:";

const STRUCTURAL_KINDS = new Set([
  "composer", "style", "brand", "output", "imagegen",
  "videogen", "videoprompt", "tween", "editvideo", "editvideoprompt",
]);

/** Resolve a canvas node id to its graph kind (null = unknown). */
export function nodeKindForId(id: string): GraphNodeKind | null {
  if (STRUCTURAL_KINDS.has(id)) return id as GraphNodeKind;
  if (id === "editgen" || id.startsWith(EDITGEN_PREFIX)) return "editgen";
  if (id === "editprompt" || id.startsWith(EDITPROMPT_PREFIX)) return "editprompt";
  if (id.startsWith("ref:")) return "ref";
  return null;
}

/** Canonicalize legacy bare ids (`editgen`/`editprompt` = `edit0`). */
export function canonicalNodeId(id: string): string {
  if (id === "editgen") return "editgen:edit0";
  if (id === "editprompt") return "editprompt:edit0";
  return id;
}

function editPromptEditId(target: string): string {
  const c = canonicalNodeId(target);
  return c.startsWith(EDITPROMPT_PREFIX) ? c.slice(EDITPROMPT_PREFIX.length) : "edit0";
}

function refIdOf(nodeId: string): string | null {
  return nodeId.startsWith("ref:") ? nodeId.slice(4) : null;
}

function isPromptTarget(target: string): boolean {
  return target === "composer" || target === "videoprompt" || target === "editvideoprompt" || nodeKindForId(target) === "editprompt";
}

/** Map a connection source to its tween keyframe id (mirror of onConnect). */
export function tweenKeyForSource(source: string): string | null {
  const id = canonicalNodeId(source);
  if (id === "imagegen") return TWEEN_KEY_IMGGEN;
  if (id.startsWith(EDITGEN_PREFIX)) return `${TWEEN_KEY_EDITGEN_PREFIX}${id.slice(EDITGEN_PREFIX.length)}`;
  const rid = refIdOf(id);
  return rid ? rid : null;
}

/**
 * Map a tween keyframe id to its canvas node. Needs the live membership sets:
 * imagegen is always present; editgen needs its edit node; refs need a node
 * (tagged or placed). Shared by the materializer and live keyframe connects
 * so both resolve identically.
 */
export function tweenKeyToNode(
  keyId: string,
  editIds: Set<string>,
  refNodeIds: Set<string>
): string | null {
  if (keyId === TWEEN_KEY_IMGGEN) return "imagegen";
  const editId = keyId === "editgen" ? "edit0" : keyId.startsWith(TWEEN_KEY_EDITGEN_PREFIX) ? keyId.slice(TWEEN_KEY_EDITGEN_PREFIX.length) : null;
  if (editId) return editIds.has(editId) ? `editgen:${editId}` : null;
  return refNodeIds.has(`ref:${keyId}`) ? `ref:${keyId}` : null;
}

/** Mirror of the modal's wireTweenKeyframe splice: move-or-insert, capped at 5. */
export function tweenKeysAfterConnect(keys: string[], keyId: string, slot: number): string[] {
  const at = Math.max(0, Math.min(4, slot));
  const ids = keys.filter((id) => id !== keyId);
  ids.splice(Math.min(at, ids.length), 0, keyId);
  return ids.slice(0, 5);
}

/**
 * Connect a keyframe (the tween branch of onConnect): compute the new ordered
 * key list and rebuild every `e-tween-*` edge positionally. Returns the new
 * graph plus the key list the caller persists to `graphTweenRefIds`
 * (LEGACY-PROJECTION — generation still reads the flags).
 */
export function connectTweenKey(
  graph: Graph,
  keyId: string,
  slot: number,
  keys: string[],
  resolveNode: (keyId: string) => string | null
): { graph: Graph; keys: string[] } {
  const nextKeys = tweenKeysAfterConnect(keys, keyId, slot);
  return { graph: applyTweenKeys(graph, nextKeys, resolveNode), keys: nextKeys };
}

export interface ConnectionEdge {
  edge: GraphEdge;
  /** Existing edge ids this connection replaces (singleton sinks, sockets). */
  dropIds: string[];
}

function mkEdge(id: string, fromNode: string, fromPort: string, toNode: string, toPort: string): GraphEdge {
  return { id, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
}

/** Edges currently feeding a sink (for singleton replacement). */
function edgesInto(graph: Graph, toNode: string, toPort: string): GraphEdge[] {
  return graph.edges.filter((e) => e.to.node === toNode && e.to.port === toPort);
}

/** Count ref→prompt edges on a prompt node (append-slot index). */
function refEdgeCount(graph: Graph, targetNode: string): number {
  return graph.edges.filter((e) => e.to.node === targetNode && e.from.node.startsWith("ref:")).length;
}

/**
 * Map a canvas connection to its stored edge. Returns null when the
 * connection carries no wire (fixed prompt pipes, tween keyframes — routed
 * through connectTweenKey — unknown nodes/handles).
 */
export function connectionToEdge(conn: FlowConnection, graph: Graph): ConnectionEdge | null {
  const source = canonicalNodeId(conn.source);
  const target = canonicalNodeId(conn.target);
  const handle = conn.targetHandle ?? "";
  const srcKind = nodeKindForId(source);

  // Edit-video source socket.
  if (target === "editvideo" && handle === "in-video") {
    if (source === "videogen") {
      return { edge: mkEdge("e-vid-ev", "videogen", "out", "editvideo", "in-video"), dropIds: edgesInto(graph, "editvideo", "in-video").map((e) => e.id) };
    }
    const rid = refIdOf(source);
    if (rid) {
      return { edge: mkEdge("e-ref-ev", source, "out", "editvideo", "in-video"), dropIds: edgesInto(graph, "editvideo", "in-video").map((e) => e.id) };
    }
    return null;
  }

  // Generation pipes out of the image node.
  if (source === "imagegen") {
    if (target === "videogen" && handle === "in-image") {
      return { edge: mkEdge("e-img-vid", "imagegen", "out", "videogen", "in-image"), dropIds: edgesInto(graph, "videogen", "in-image").map((e) => e.id) };
    }
    if (target === "output") return { edge: mkEdge("e-img-out", "imagegen", "out", "output", "in-out"), dropIds: edgesInto(graph, "output", "in-out").map((e) => e.id) };
    if (srcKind === null) return null;
    if (nodeKindForId(target) === "editgen" && handle === "in-image") {
      return { edge: mkEdge(`e-img-edit:${target.slice(EDITGEN_PREFIX.length)}`, "imagegen", "out", target, "in-image"), dropIds: edgesInto(graph, target, "in-image").map((e) => e.id) };
    }
    const tweenSlot = /^in-tween-(\d+)$/.exec(handle);
    // Keyframe sockets route through connectTweenKey (positional edge ids
    // need the full ordered key list, not a single edge).
    if (target === "tween" && tweenSlot) return null;
    return null;
  }
  if (source === "videogen" && target === "output") {
    return { edge: mkEdge("e-vid-out", "videogen", "out", "output", "in-out"), dropIds: edgesInto(graph, "output", "in-out").map((e) => e.id) };
  }
  if (source === "tween" && target === "output") {
    return { edge: mkEdge("e-tween-out", "tween", "out", "output", "in-out"), dropIds: edgesInto(graph, "output", "in-out").map((e) => e.id) };
  }

  // Edit-node outputs.
  if (srcKind === "editgen") {
    if (target === "videogen" && handle === "in-image") {
      return { edge: mkEdge("e-edit-vid", source, "out", "videogen", "in-image"), dropIds: edgesInto(graph, "videogen", "in-image").map((e) => e.id) };
    }
    if (target === "output") {
      return { edge: mkEdge("e-edit-out", source, "out", "output", "in-out"), dropIds: edgesInto(graph, "output", "in-out").map((e) => e.id) };
    }
    if (nodeKindForId(target) === "editgen" && handle === "in-image") {
      return { edge: mkEdge(`e-edit-edit:${target.slice(EDITGEN_PREFIX.length)}`, source, "out", target, "in-image"), dropIds: edgesInto(graph, target, "in-image").map((e) => e.id) };
    }
    // Keyframe sockets route through connectTweenKey (see above).
    return null;
  }

  // Reference outputs.
  const rid = refIdOf(source);
  if (rid) {
    if (target === "output") {
      return { edge: mkEdge("e-ref-out", source, "out", "output", "in-out"), dropIds: edgesInto(graph, "output", "in-out").map((e) => e.id) };
    }
    const tweenSlot = /^in-tween-(\d+)$/.exec(handle);
    // Keyframe sockets route through connectTweenKey (see above).
    if (target === "tween" && tweenSlot) return null;
    if (target === "videogen" && handle === "in-image") {
      return { edge: mkEdge("e-ref-vid", source, "out", "videogen", "in-image"), dropIds: edgesInto(graph, "videogen", "in-image").map((e) => e.id) };
    }
    if (nodeKindForId(target) === "editgen" && handle === "in-image") {
      return { edge: mkEdge(`e-ref-edit:${target.slice(EDITGEN_PREFIX.length)}`, source, "out", target, "in-image"), dropIds: edgesInto(graph, target, "in-image").map((e) => e.id) };
    }
    if (isPromptTarget(target) && (handle === "in-ref-open" || /^in-ref-\d+$/.test(handle))) {
      const slot = /^in-ref-(\d+)$/.exec(handle);
      if (slot) {
        const idx = Number(slot[1]);
        const targetLabel = target === "composer" ? "composer" : target;
        const drop = graph.edges.find((e) => e.to.node === target && e.to.port === `in-ref-${idx}`);
        return { edge: mkEdge(`e-${source}-${targetLabel}-${idx}`, source, "out", target, `in-ref-${idx}`), dropIds: drop ? [drop.id] : [] };
      }
      const idx = refEdgeCount(graph, target);
      const targetLabel = target === "composer" ? "composer" : target;
      return { edge: mkEdge(`e-${source}-${targetLabel}-${idx}`, source, "out", target, `in-ref-${idx}`), dropIds: [] };
    }
    return null;
  }

  // Style / brand plugs (fixed socket ids per prompt node).
  if (source === "style" && isPromptTarget(target) && handle === "in-style") {
    const suffix = target === "composer" ? "" : target === "videoprompt" ? "-vp" : target === "editvideoprompt" ? "-evp" : `-ep:${editPromptEditId(target)}`;
    return { edge: mkEdge(`e-style${suffix}`, "style", "out", target, "in-style"), dropIds: edgesInto(graph, target, "in-style").map((e) => e.id) };
  }
  if (source === "brand" && isPromptTarget(target) && handle === "in-brand") {
    const suffix = target === "composer" ? "" : target === "videoprompt" ? "-vp" : target === "editvideoprompt" ? "-evp" : `-ep:${editPromptEditId(target)}`;
    return { edge: mkEdge(`e-brand${suffix}`, "brand", "out", target, "in-brand"), dropIds: edgesInto(graph, target, "in-brand").map((e) => e.id) };
  }

  // Fixed prompt pipes carry no stored wire (structural, always present).
  return null;
}

/** Insert an edge, first dropping replaced/conflicting edges. Idempotent by edge id. */
export function applyConnection(graph: Graph, op: ConnectionEdge): Graph {
  const dropped = new Set(op.dropIds);
  const edges = graph.edges.filter((e) => !dropped.has(e.id) && e.id !== op.edge.id);
  edges.push(op.edge);
  return { ...graph, edges };
}

/** A generator's fixed prompt pipe: the prompt node it reads from and the
 *  stable edge id (mirrors materializeGraph — the runtime add path must emit
 *  the same edge the materializer would). */
function promptPipeFor(genNode: string): { from: string; to: string; id: string } | null {
  if (genNode === "editgen" || genNode.startsWith(EDITGEN_PREFIX)) {
    const id = genNode === "editgen" ? "edit0" : genNode.slice(EDITGEN_PREFIX.length);
    return { from: `${EDITPROMPT_PREFIX}${id}`, to: `${EDITGEN_PREFIX}${id}`, id: `e-ep-edit:${id}` };
  }
  if (genNode === "imagegen") return { from: "composer", to: "imagegen", id: "e-cmp-img" };
  if (genNode === "videogen") return { from: "videoprompt", to: "videogen", id: "e-vp-vid" };
  if (genNode === "editvideo") return { from: "editvideoprompt", to: "editvideo", id: "e-evp-ev" };
  return null;
}

/**
 * Ensure a placed generator's fixed prompt pipe edge exists (structural, always
 * present for a placed pair). The materializer emits these for legacy shots;
 * this is the runtime mirror for tools dragged onto the canvas mid-session, so
 * a freshly added node's prompt is connected and its wire can't be re-created
 * by hand (fixed pipes carry no user-mappable connection). No-op when either
 * endpoint node is absent or the edge already exists.
 */
export function ensurePromptPipe(graph: Graph, genNode: string): Graph {
  const pipe = promptPipeFor(canonicalNodeId(genNode));
  if (!pipe) return graph;
  if (!graph.nodes.some((n) => n.id === pipe.from) || !graph.nodes.some((n) => n.id === pipe.to)) return graph;
  if (graph.edges.some((e) => e.id === pipe.id)) return graph;
  return { ...graph, edges: [...graph.edges, mkEdge(pipe.id, pipe.from, "out", pipe.to, "in-prompt")] };
}

/** A prompt consumer that style/brand nodes can plug into. */
export type PromptNodeTarget = "composer" | "videoprompt" | "editvideoprompt" | { editprompt: string };

/** Canonical prompt-node id for a target. */
export function promptNodeId(target: PromptNodeTarget): string {
  if (typeof target === "string") return target;
  return `editprompt:${target.editprompt}`;
}

/** Stable edge id for a style/brand plug (same scheme the materializer and
 *  connectionToEdge use), per prompt node. */
function plugEdgeId(source: "style" | "brand", target: PromptNodeTarget): string {
  const suffix =
    target === "composer" ? "" :
    target === "videoprompt" ? "-vp" :
    target === "editvideoprompt" ? "-evp" :
    `-ep:${target.editprompt}`;
  return `e-${source}${suffix}`;
}

/** Add or remove a style plug edge on one prompt node (idempotent). */
export function setStyleEdge(graph: Graph, target: PromptNodeTarget, attached: boolean): Graph {
  const node = promptNodeId(target);
  const edges = graph.edges.filter((e) => !(e.from.node === "style" && e.to.node === node && e.to.port === "in-style"));
  if (attached) edges.push({ id: plugEdgeId("style", target), from: { node: "style", port: "out" }, to: { node, port: "in-style" } });
  return { ...graph, edges };
}

/** Add or remove a brand plug edge on one prompt node (idempotent). */
export function setBrandEdge(graph: Graph, target: PromptNodeTarget, attached: boolean): Graph {
  const node = promptNodeId(target);
  const edges = graph.edges.filter((e) => !(e.from.node === "brand" && e.to.node === node && e.to.port === "in-brand"));
  if (attached) edges.push({ id: plugEdgeId("brand", target), from: { node: "brand", port: "out" }, to: { node, port: "in-brand" } });
  return { ...graph, edges };
}

/** Drop one edge by id (disconnect / Delete key). */
export function removeGraphEdge(graph: Graph, edgeId: string): Graph {
  return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) };
}

/** Canvas handle a drag-off disconnect starts from (onConnectEnd fromHandle). */
export interface DetachHandle {
  type: string;
  nodeId: string;
  handleId: string;
}

/**
 * Mirror of onConnectEnd's legacy strips: map a detached handle to graph edge
 * removals. Source drags unbind that node's outputs exactly as the legacy
 * unpipes do (including the videogen→output-only gap); target drags drop the
 * wire on that socket; tween keyframes rebuild positionally. Returns null
 * when the handle maps to no wire (caller still runs the legacy path).
 */
export function graphEdgesForDetach(
  graph: Graph,
  from: DetachHandle,
  ctx: { tweenKeys: string[]; editIds: Set<string>; refNodeIds: Set<string> }
): Graph | null {
  const dropInto = (node: string, port: string): Graph | null => {
    const hit = graph.edges.some((e) => e.to.node === node && e.to.port === port);
    return hit ? { ...graph, edges: graph.edges.filter((e) => !(e.to.node === node && e.to.port === port)) } : null;
  };
  const dropFrom = (node: string): Graph | null => {
    const hit = graph.edges.some((e) => e.from.node === node);
    return hit ? { ...graph, edges: graph.edges.filter((e) => e.from.node !== node) } : null;
  };

  if (from.type === "target") {
    const kind = nodeKindForId(canonicalNodeId(from.nodeId));
    if (kind === "composer" || kind === "videoprompt" || kind === "editprompt" || kind === "editvideoprompt") {
      const node = canonicalNodeId(from.nodeId);
      if (from.handleId === "in-style" || from.handleId === "in-brand" || /^in-ref-\d+$/.test(from.handleId)) {
        return dropInto(node, from.handleId);
      }
      return null;
    }
    if (from.nodeId === "videogen" && from.handleId === "in-image") {
      return dropInto("videogen", "in-image");
    }
    if (kind === "editgen" && from.handleId === "in-image") {
      return dropInto(canonicalNodeId(from.nodeId), "in-image");
    }
    if (from.nodeId === "tween") {
      const m = /^in-tween-(\d+)$/.exec(from.handleId);
      if (!m) return null;
      const idx = Number(m[1]);
      if (idx < 0 || idx >= ctx.tweenKeys.length) return null;
      const next = ctx.tweenKeys.filter((_, i) => i !== idx);
      return applyTweenKeys(graph, next, (k) => tweenKeyToNode(k, ctx.editIds, ctx.refNodeIds));
    }
    if (from.nodeId === "output" && from.handleId === "in-out") {
      return dropInto("output", "in-out");
    }
    // No legacy branch for editvideo:in-video drag-off — nothing maps.
    return null;
  }

  if (from.type === "source") {
    const node = canonicalNodeId(from.nodeId);
    if (node === "imagegen") return dropFrom("imagegen");
    // Legacy gap mirrored: dragging the video source off clears the video
    // output feed only (onUnpipeVideoGen), not the edit-video feed.
    if (node === "videogen") {
      const hit = graph.edges.some((e) => e.from.node === "videogen" && e.to.node === "output");
      return hit ? { ...graph, edges: graph.edges.filter((e) => !(e.from.node === "videogen" && e.to.node === "output")) } : null;
    }
    if (node === "tween") {
      const hit = graph.edges.some((e) => e.from.node === "tween" && e.to.node === "output");
      return hit ? { ...graph, edges: graph.edges.filter((e) => !(e.from.node === "tween" && e.to.node === "output")) } : null;
    }
    if (nodeKindForId(node) === "editgen") return dropFrom(node);
    if (node === "style" || node === "brand") return dropFrom(node);
    if (node.startsWith("ref:")) return dropFrom(node);
    return null;
  }
  return null;
}

/** Rebuild the tween keyframe edges from an ordered key list (positions are ids). */
export function applyTweenKeys(
  graph: Graph,
  keys: string[],
  resolveNode: (keyId: string) => string | null
): Graph {
  const kept = graph.edges.filter((e) => e.to.node !== "tween");
  const fresh: GraphEdge[] = [];
  keys.forEach((keyId, i) => {
    const nodeId = resolveNode(keyId);
    if (nodeId) fresh.push(mkEdge(`e-tween-${i}`, nodeId, "out", "tween", `in-tween-${i}`));
  });
  return { ...graph, edges: [...kept, ...fresh] };
}

/** Add a node (no-op when the id already exists). */
export function addGraphNode(graph: Graph, node: GraphNode): Graph {
  if (graph.nodes.some((n) => n.id === node.id)) return graph;
  return { ...graph, nodes: [...graph.nodes, node] };
}

/** Remove a node and every incident edge (node Delete). */
export function removeGraphNode(graph: Graph, nodeId: string): Graph {
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => n.id !== nodeId),
    edges: graph.edges.filter((e) => e.from.node !== nodeId && e.to.node !== nodeId),
  };
}
