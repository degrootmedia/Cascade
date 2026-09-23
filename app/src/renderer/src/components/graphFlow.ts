/**
 * Stored-graph → ReactFlow adapter (master plan step 03 T5).
 *
 * `graphEdgesToFlow` renders `graph.edges` as the canvas Edge objects — the
 * same ids, handles, stroke colors, and deletable flags the legacy
 * flag/text derivation produced, so the picture is identical while the source
 * of truth changes. Visual styling derives from port semantics (source kind +
 * sink port), never from edge-id patterns or prompt text.
 *
 * `promptSockets` is the single prompt-socket builder (replacing the two
 * duplicated lists in the composer/prompt node views). Handle ids and order
 * come from the shared port table; geometry matches the legacy layout.
 */
import type { Edge } from "@xyflow/react";
import type { Graph } from "../../../shared/ipc.js";
import { nodeKindForId } from "../../../shared/graph/connect.js";
import { portDecl, TWEEN_SOCKET_RE } from "../../../shared/graph/ports.js";

export interface SocketColors {
  ref: string;
  style: string;
  brand: string;
}

const PROMPT_KINDS = new Set(["composer", "videoprompt", "editprompt", "editvideoprompt"]);

function isPromptKind(kind: string | null): boolean {
  return kind !== null && PROMPT_KINDS.has(kind);
}

/** Stroke color for one stored edge, by port semantics. */
export function edgeStroke(fromNode: string, toPort: string, colors: SocketColors): string | undefined {
  const fromKind = nodeKindForId(fromNode);
  if (fromKind === "style") return colors.style;
  if (fromKind === "brand") return colors.brand;
  if (fromKind === "ref") return colors.ref;
  if (toPort === "in-image" || toPort === "in-video" || TWEEN_SOCKET_RE.test(toPort)) return colors.ref;
  return undefined;
}

/** Only reference→prompt edges are keyboard-deletable; every other wire is fixed. */
export function edgeDeletable(fromNode: string, toNode: string): boolean {
  return nodeKindForId(fromNode) === "ref" && isPromptKind(nodeKindForId(toNode));
}

/** Render stored edges as ReactFlow edges (reconnectable is always false —
 *  disconnecting is drag-off via onConnectEnd, as before). */
export function graphEdgesToFlow(
  graph: Graph,
  opts: { selected: Set<string>; colors: SocketColors }
): Edge[] {
  return graph.edges.map((e) => {
    const stroke = edgeStroke(e.from.node, e.to.port, opts.colors);
    const edge: Edge = {
      id: e.id,
      source: e.from.node,
      target: e.to.node,
      targetHandle: e.to.port,
      reconnectable: false,
      selected: opts.selected.has(e.id),
    };
    if (!edgeDeletable(e.from.node, e.to.node)) edge.deletable = false;
    if (stroke) edge.style = { stroke };
    return edge;
  });
}

export interface PromptSocket {
  id: string;
  kind: "ref" | "style" | "brand";
  open: boolean;
  label: string;
  top: number;
}

/** Socket class from the port table: style-gated text → style, brand-gated
 *  text → brand, reference sockets → ref. */
function socketKind(portId: string): PromptSocket["kind"] {
  const decl = portDecl("composer", "in", portId);
  if (decl?.from?.includes("style")) return "style";
  if (decl?.from?.includes("brand")) return "brand";
  return "ref";
}

/**
 * The one prompt-socket list: style socket, one socket per connected
 * reference, the always-open append socket, brand socket. Geometry matches
 * the legacy builders exactly.
 */
export function promptSockets(refHandles: string[], openHandleId: string): PromptSocket[] {
  const n = refHandles.length + 1;
  const total = n + 2;
  return [
    { id: "in-style", kind: socketKind("in-style"), open: false, label: "Style", top: (1 / (total + 1)) * 100 },
    ...refHandles.map((id, i) => ({ id, kind: socketKind(id), open: false as const, label: "Reference", top: ((i + 2) / (total + 1)) * 100 })),
    { id: openHandleId, kind: socketKind("in-ref-open"), open: true as const, label: "Reference", top: ((n + 1) / (total + 1)) * 100 },
    { id: "in-brand", kind: socketKind("in-brand"), open: false, label: "Brand", top: (total / (total + 1)) * 100 },
  ];
}
