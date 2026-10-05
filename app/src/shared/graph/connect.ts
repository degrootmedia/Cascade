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
import type { Graph, GraphEdge, GraphNode, GraphNodeKind, GraphVideoNode } from "../ipc.js";
import { TWEEN_KEY_IMGGEN, TWEEN_KEY_EDITGEN_PREFIX, VIDEOGEN_NODE_PREFIX, VIDEOPROMPT_NODE_PREFIX, EDITVIDEO_NODE_PREFIX, EDITVIDEOPROMPT_NODE_PREFIX, videoGenNodeId, videoPromptNodeId, parseVideoGenNode, parseVideoPromptNode, editVideoGenNodeId, editVideoPromptNodeId, parseEditVideoGenNode, parseEditVideoPromptNode } from "../ipc.js";
import { REF_SOCKET_RE, FRAME_SOCKET_RE } from "./ports.js";

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
  "videogen", "videoprompt", "tween", "editvideo", "editvideoprompt", "cameraGrid", "upscale",
]);

/** Resolve a canvas node id to its graph kind (null = unknown). */
export function nodeKindForId(id: string): GraphNodeKind | null {
  if (STRUCTURAL_KINDS.has(id)) return id as GraphNodeKind;
  if (id.startsWith(VIDEOGEN_NODE_PREFIX)) return "videogen";
  if (id.startsWith(VIDEOPROMPT_NODE_PREFIX)) return "videoprompt";
  if (id.startsWith(EDITVIDEO_NODE_PREFIX)) return "editvideo";
  if (id.startsWith(EDITVIDEOPROMPT_NODE_PREFIX)) return "editvideoprompt";
  if (id === "editgen" || id.startsWith(EDITGEN_PREFIX)) return "editgen";
  if (id === "editprompt" || id.startsWith(EDITPROMPT_PREFIX)) return "editprompt";
  if (id.startsWith("ref:")) return "ref";
  return null;
}

/** The edge id for a per-video-node wire: the first node keeps the historical
 *  bare base id, additional nodes suffix the node id. Shared with the
 *  materializer so both emit identical edges. */
export function videoEdgeId(base: string, nodeId: string): string {
  return nodeId === "vid0" ? base : `${base}:${nodeId}`;
}

/** The edge id for a per-edit-video-node wire (ev0 keeps the bare base id). */
export function editVideoEdgeId(base: string, nodeId: string): string {
  return nodeId === "ev0" ? base : `${base}:${nodeId}`;
}

/** A video node's canvas generator id (generate vs edit mode). */
export function videoNodeCanvasId(node: Pick<GraphVideoNode, "id" | "mode">): string {
  return node.mode === "edit" ? editVideoGenNodeId(node.id) : videoGenNodeId(node.id);
}

/** A video node's canvas prompt-node id (generate vs edit mode). */
export function videoNodePromptCanvasId(node: Pick<GraphVideoNode, "id" | "mode">): string {
  return node.mode === "edit" ? editVideoPromptNodeId(node.id) : videoPromptNodeId(node.id);
}

/** The style/brand plug edge-id suffix for a video prompt node. */
function videoPromptSuffix(target: string): string {
  const id = parseVideoPromptNode(target);
  return !id || id === "vid0" ? "-vp" : `-vp:${id}`;
}

/** The style/brand plug edge-id suffix for an edit-video prompt node. */
function editVideoPromptSuffix(target: string): string {
  const id = parseEditVideoPromptNode(target);
  return !id || id === "ev0" ? "-evp" : `-evp:${id}`;
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
  const kind = nodeKindForId(target);
  return kind === "composer" || kind === "videoprompt" || kind === "editvideoprompt" || kind === "editprompt";
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

/** Count ref→prompt edges on a prompt node (append-slot index). Only the
 *  positional reference sockets (`in-ref-N`) count — a sequence prompt node
 *  also carries structural member-frame edges (`in-frame-N`) from
 *  `ref:seqframe:*` nodes to the same target, which must not inflate the
 *  append index (they once pushed the first drop onto `in-ref-2`, a socket
 *  that never exists, so the wire vanished while the tag still added its
 *  socket). */
function refEdgeCount(graph: Graph, targetNode: string): number {
  return graph.edges.filter((e) => e.to.node === targetNode && REF_SOCKET_RE.test(e.to.port)).length;
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

  // Edit-video source socket (per edit-video node).
  const evId = parseEditVideoGenNode(target);
  if (evId && handle === "in-video") {
    const drop = edgesInto(graph, target, "in-video").map((e) => e.id);
    const srcVidId = parseVideoGenNode(source);
    const srcEvId = parseEditVideoGenNode(source);
    if (srcVidId || srcEvId) {
      return { edge: mkEdge(editVideoEdgeId("e-vid-ev", evId), source, "out", target, "in-video"), dropIds: drop };
    }
    const rid = refIdOf(source);
    if (rid) {
      return { edge: mkEdge(editVideoEdgeId("e-ref-ev", evId), source, "out", target, "in-video"), dropIds: drop };
    }
    return null;
  }

  // Camera-grid source socket (a single image input, like the video node's
  // frame feed), grid-image socket (a manually supplied sheet to cut up), and
  // style socket (prepends the shot's effective style to the generated prompt).
  // Reference sockets are positional and rebuilt from the node's ordered
  // `refIds` via `applyCameraGridRefs`, so they carry no single edge here
  // (mirroring tween keyframes).
  if (target === "cameraGrid" && handle === "in-style") {
    if (source === "style") {
      return { edge: mkEdge("e-style-camgrid", "style", "out", "cameraGrid", "in-style"), dropIds: edgesInto(graph, "cameraGrid", "in-style").map((e) => e.id) };
    }
    return null;
  }
  if (target === "cameraGrid" && (handle === "in-image" || handle === "in-grid")) {
    const suffix = handle === "in-grid" ? "-grid" : "";
    if (source === "imagegen") {
      return { edge: mkEdge(`e-img-camgrid${suffix}`, "imagegen", "out", "cameraGrid", handle), dropIds: edgesInto(graph, "cameraGrid", handle).map((e) => e.id) };
    }
    if (srcKind === "editgen") {
      return { edge: mkEdge(`e-edit-camgrid${suffix}`, source, "out", "cameraGrid", handle), dropIds: edgesInto(graph, "cameraGrid", handle).map((e) => e.id) };
    }
    if (srcKind === "ref") {
      return { edge: mkEdge(`e-ref-camgrid${suffix}`, source, "out", "cameraGrid", handle), dropIds: edgesInto(graph, "cameraGrid", handle).map((e) => e.id) };
    }
    return null;
  }
  if (target === "cameraGrid" && REF_SOCKET_RE.test(handle)) return null;

  // Upscale node source socket (a single image input, like the camera grid's).
  if (target === "upscale" && handle === "in-image") {
    if (source === "imagegen") {
      return { edge: mkEdge("e-img-upscale", "imagegen", "out", "upscale", "in-image"), dropIds: edgesInto(graph, "upscale", "in-image").map((e) => e.id) };
    }
    if (srcKind === "editgen") {
      return { edge: mkEdge("e-edit-upscale", source, "out", "upscale", "in-image"), dropIds: edgesInto(graph, "upscale", "in-image").map((e) => e.id) };
    }
    if (srcKind === "ref") {
      return { edge: mkEdge("e-ref-upscale", source, "out", "upscale", "in-image"), dropIds: edgesInto(graph, "upscale", "in-image").map((e) => e.id) };
    }
    return null;
  }

  // Generation pipes out of the image node.
  if (source === "imagegen") {
    const vidId = parseVideoGenNode(target);
    if (vidId && handle === "in-image") {
      return { edge: mkEdge(videoEdgeId("e-img-vid", vidId), "imagegen", "out", target, "in-image"), dropIds: edgesInto(graph, target, "in-image").map((e) => e.id) };
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
    // Generation outputs can wire directly into a video prompt's reference
    // sockets (no saved reference): the take resolves at submit time from the
    // video node's gen-ref sentinels. Same positional scheme as ref→prompt.
    if (parseVideoPromptNode(target) && (handle === "in-ref-open" || /^in-ref-\d+$/.test(handle))) {
      const slot = /^in-ref-(\d+)$/.exec(handle);
      if (slot) {
        const idx = Number(slot[1]);
        const drop = graph.edges.find((e) => e.to.node === target && e.to.port === `in-ref-${idx}`);
        return { edge: mkEdge(`e-${source}-${target}-${idx}`, source, "out", target, `in-ref-${idx}`), dropIds: drop ? [drop.id] : [] };
      }
      const idx = refEdgeCount(graph, target);
      return { edge: mkEdge(`e-${source}-${target}-${idx}`, source, "out", target, `in-ref-${idx}`), dropIds: [] };
    }
    return null;
  }
  const srcVidId = parseVideoGenNode(source);
  if (srcVidId && target === "output") {
    return { edge: mkEdge(videoEdgeId("e-vid-out", srcVidId), source, "out", "output", "in-out"), dropIds: edgesInto(graph, "output", "in-out").map((e) => e.id) };
  }
  const srcEvId = parseEditVideoGenNode(source);
  if (srcEvId && target === "output") {
    return { edge: mkEdge(editVideoEdgeId("e-editvideo-out", srcEvId), source, "out", "output", "in-out"), dropIds: edgesInto(graph, "output", "in-out").map((e) => e.id) };
  }
  if (source === "tween" && target === "output") {
    return { edge: mkEdge("e-tween-out", "tween", "out", "output", "in-out"), dropIds: edgesInto(graph, "output", "in-out").map((e) => e.id) };
  }
  if (source === "upscale" && target === "output") {
    return { edge: mkEdge("e-upscale-out", "upscale", "out", "output", "in-out"), dropIds: edgesInto(graph, "output", "in-out").map((e) => e.id) };
  }

  // Edit-node outputs.
  if (srcKind === "editgen") {
    const vidId = parseVideoGenNode(target);
    if (vidId && handle === "in-image") {
      return { edge: mkEdge(videoEdgeId("e-edit-vid", vidId), source, "out", target, "in-image"), dropIds: edgesInto(graph, target, "in-image").map((e) => e.id) };
    }
    if (target === "output") {
      return { edge: mkEdge("e-edit-out", source, "out", "output", "in-out"), dropIds: edgesInto(graph, "output", "in-out").map((e) => e.id) };
    }
    if (nodeKindForId(target) === "editgen" && handle === "in-image") {
      return { edge: mkEdge(`e-edit-edit:${target.slice(EDITGEN_PREFIX.length)}`, source, "out", target, "in-image"), dropIds: edgesInto(graph, target, "in-image").map((e) => e.id) };
    }
    // Generation outputs can wire directly into a video prompt's reference
    // sockets (no saved reference): the take resolves at submit time from the
    // video node's gen-ref sentinels. Same positional scheme as ref→prompt.
    if (parseVideoPromptNode(target) && (handle === "in-ref-open" || /^in-ref-\d+$/.test(handle))) {
      const slot = /^in-ref-(\d+)$/.exec(handle);
      if (slot) {
        const idx = Number(slot[1]);
        const drop = graph.edges.find((e) => e.to.node === target && e.to.port === `in-ref-${idx}`);
        return { edge: mkEdge(`e-${source}-${target}-${idx}`, source, "out", target, `in-ref-${idx}`), dropIds: drop ? [drop.id] : [] };
      }
      const idx = refEdgeCount(graph, target);
      return { edge: mkEdge(`e-${source}-${target}-${idx}`, source, "out", target, `in-ref-${idx}`), dropIds: [] };
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
    const vidId = parseVideoGenNode(target);
    if (vidId && handle === "in-image") {
      return { edge: mkEdge(videoEdgeId("e-ref-vid", vidId), source, "out", target, "in-image"), dropIds: edgesInto(graph, target, "in-image").map((e) => e.id) };
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
    const suffix = target === "composer" ? "" : nodeKindForId(target) === "videoprompt" ? videoPromptSuffix(target) : nodeKindForId(target) === "editvideoprompt" ? editVideoPromptSuffix(target) : `-ep:${editPromptEditId(target)}`;
    return { edge: mkEdge(`e-style${suffix}`, "style", "out", target, "in-style"), dropIds: edgesInto(graph, target, "in-style").map((e) => e.id) };
  }
  if (source === "brand" && isPromptTarget(target) && handle === "in-brand") {
    const suffix = target === "composer" ? "" : nodeKindForId(target) === "videoprompt" ? videoPromptSuffix(target) : nodeKindForId(target) === "editvideoprompt" ? editVideoPromptSuffix(target) : `-ep:${editPromptEditId(target)}`;
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
  const vidId = parseVideoGenNode(genNode);
  if (vidId) return { from: videoPromptNodeId(vidId), to: videoGenNodeId(vidId), id: videoEdgeId("e-vp-vid", vidId) };
  const evId = parseEditVideoGenNode(genNode);
  if (evId) return { from: editVideoPromptNodeId(evId), to: editVideoGenNodeId(evId), id: editVideoEdgeId("e-evp-ev", evId) };
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
export type PromptNodeTarget = "composer" | "videoprompt" | "editvideoprompt" | { editprompt: string } | { videoprompt: string } | { editvideoprompt: string };

/** Canonical prompt-node id for a target. */
export function promptNodeId(target: PromptNodeTarget): string {
  if (typeof target === "string") return target;
  if ("videoprompt" in target) return videoPromptNodeId(target.videoprompt);
  if ("editvideoprompt" in target) return editVideoPromptNodeId(target.editvideoprompt);
  return `editprompt:${target.editprompt}`;
}

/** Stable edge id for a style/brand plug (same scheme the materializer and
 *  connectionToEdge use), per prompt node. */
function plugEdgeId(source: "style" | "brand", target: PromptNodeTarget): string {
  const suffix =
    target === "composer" ? "" :
    target === "videoprompt" ? "-vp" :
    target === "editvideoprompt" ? "-evp" :
    "editprompt" in target ? `-ep:${target.editprompt}` :
    "editvideoprompt" in target ? (target.editvideoprompt === "ev0" ? "-evp" : `-evp:${target.editvideoprompt}`) :
    target.videoprompt === "vid0" ? "-vp" : `-vp:${target.videoprompt}`;
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
 * Mirror of onConnectEnd's legacy strips: map a detached input (target)
 * handle to graph edge removals. Only input-socket drags detach — output
 * (source) drags map to nothing so the wire snaps back. Target drags drop
 * the wire on that socket; tween keyframes rebuild positionally. Returns
 * null when the handle maps to no wire (caller still runs the legacy path).
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

  if (from.type !== "target") return null;

  const kind = nodeKindForId(canonicalNodeId(from.nodeId));
  if (kind === "composer" || kind === "videoprompt" || kind === "editprompt" || kind === "editvideoprompt") {
    const node = canonicalNodeId(from.nodeId);
    if (from.handleId === "in-style" || from.handleId === "in-brand" || /^in-ref-\d+$/.test(from.handleId)) {
      return dropInto(node, from.handleId);
    }
    return null;
  }
  if (kind === "videogen" && from.handleId === "in-image") {
    return dropInto(canonicalNodeId(from.nodeId), "in-image");
  }
  if (kind === "editvideo" && from.handleId === "in-video") {
    return dropInto(from.nodeId, "in-video");
  }
  if (from.nodeId === "cameraGrid") {
    if (from.handleId === "in-style" || from.handleId === "in-image" || from.handleId === "in-grid") return dropInto("cameraGrid", from.handleId);
    // Reference sockets are positional and rebuilt from the node's refIds by
    // the caller (applyCameraGridRefs), not dropped edge-by-edge.
    return null;
  }
  if (from.nodeId === "upscale" && from.handleId === "in-image") {
    return dropInto("upscale", "in-image");
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

/** Rebuild the camera-grid node's reference-socket edges from its ordered ref
 *  ids (positions are slots). Only refs with nodes on the canvas get an edge. */
export function applyCameraGridRefs(graph: Graph, refIds: string[]): Graph {
  const kept = graph.edges.filter((e) => !(e.to.node === "cameraGrid" && REF_SOCKET_RE.test(e.to.port)));
  const fresh: GraphEdge[] = [];
  refIds.forEach((refId, i) => {
    const nodeId = `ref:${refId}`;
    if (graph.nodes.some((n) => n.id === nodeId)) {
      fresh.push(mkEdge(`e-${nodeId}-cameraGrid-${i}`, nodeId, "out", "cameraGrid", `in-ref-${i}`));
    }
  });
  return { ...graph, edges: [...kept, ...fresh] };
}

/**
 * Magic Prompt is tag-authoritative: its `@[name]` citations live in the
 * effective prompt text (`magicPrompts`), not in the stored graph's ref edges,
 * so the canvas shows the tagged ref nodes but no wires. Rebuild the
 * composer's reference-socket edges from the ordered tagged reference ids —
 * adding a ref node for each id — so the graph follows the tags. Positional
 * (socket index = tag order), mirroring `materializeGraph`; a removed tag
 * unwires. Only ref→composer edges are touched.
 */
export function wireComposerRefs(graph: Graph, refIds: string[]): Graph {
  const nodes = [...graph.nodes];
  const have = new Set(nodes.map((n) => n.id));
  for (const id of refIds) {
    const nodeId = `ref:${id}`;
    if (!have.has(nodeId)) { have.add(nodeId); nodes.push({ id: nodeId, kind: "ref", pos: { x: 0, y: 0 } }); }
  }
  const kept = graph.edges.filter(
    (e) => !(e.to.node === "composer" && e.from.node.startsWith("ref:") && /^in-ref-\d+$/.test(e.to.port))
  );
  const fresh: GraphEdge[] = [];
  refIds.forEach((id, i) => {
    const nodeId = `ref:${id}`;
    if (have.has(nodeId)) fresh.push(mkEdge(`e-${nodeId}-composer-${i}`, nodeId, "out", "composer", `in-ref-${i}`));
  });
  return { ...graph, nodes, edges: [...kept, ...fresh] };
}

/**
 * Rebuild a sequence prompt node's member-frame edges from its timeline
 * segments (one structural socket per segment, `in-frame-<i>`), adding each
 * member's locked frame node so the wire resolves. Mirrors `materializeGraph`.
 */
export function applySequenceFrames(graph: Graph, segments: { shotId: string }[]): Graph {
  const promptId = videoPromptNodeId("vid0");
  const kept = graph.edges.filter((e) => !(e.to.node === promptId && FRAME_SOCKET_RE.test(e.to.port)));
  const nodes = [...graph.nodes];
  const have = new Set(nodes.map((n) => n.id));
  const fresh: GraphEdge[] = [];
  (segments ?? []).forEach((seg, i) => {
    if (!seg?.shotId) return;
    const nodeId = `ref:seqframe:${seg.shotId}`;
    if (!have.has(nodeId)) { have.add(nodeId); nodes.push({ id: nodeId, kind: "ref", pos: { x: 0, y: 0 } }); }
    fresh.push(mkEdge(`e-seqframe-${i}`, nodeId, "out", promptId, `in-frame-${i}`));
  });
  return { ...graph, nodes, edges: [...kept, ...fresh] };
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
