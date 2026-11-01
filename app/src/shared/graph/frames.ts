/**
 * Frames / groups: layout-only organization of canvas nodes (Item 2).
 * A frame never changes the graph; its collapsed form is a view over the
 * same nodes and edges. Deactivation is the one behavioural flag: member
 * nodes are skipped at generation time (nothing is deleted).
 */
import type { GraphFrame, GraphLayout } from "../ipc/graph.js";
import { nodeKindForId } from "./connect.js";
import { portDecl } from "./ports.js";

export const FRAME_PALETTE = ["#4f8cff", "#34c38f", "#f1b44c", "#f46a6a", "#a770ef", "#50a5f1", "#9aa0a6"];
export const FRAME_TITLE_H = 30;
export const FRAME_PAD = 24;

const KIND_TITLE: Record<string, string> = {
  composer: "Prompt", style: "Style", brand: "Brand", imagegen: "Image Gen", videogen: "Video Gen", videoprompt: "Video Prompt",
  editgen: "Edit Image", editprompt: "Edit Prompt", editvideo: "Edit Video", editvideoprompt: "Edit Video Prompt",
  tween: "In-Betweener", cameraGrid: "Camera Grid", upscale: "Upscale", output: "Frame Output", ref: "Reference",
};

/** Human node title: "Edit Prompt #1" from `editprompt:edit0` (0-based ids shown 1-based). */
export function nodeTitle(nodeId: string): string {
  const kind = nodeKindForId(nodeId);
  const base = (kind && KIND_TITLE[kind]) || nodeId;
  const m = /(\d+)$/.exec(nodeId);
  if (kind === "ref" || !m || !nodeId.includes(":")) return nodeId === "editgen" || nodeId === "editprompt" ? `${base} #1` : base;
  return `${base} #${Number(m[1]) + 1}`;
}

/** Human port name: Source / Prompt / Ref / Style ... */
export function portTitle(nodeId: string, dir: "in" | "out", port: string): string {
  if (port === "in-image") return "Source";
  if (/^in-ref-/.test(port)) return "Ref";
  const tw = /^in-tween-(\d+)$/.exec(port);
  if (tw) return `Keyframe ${Number(tw[1]) + 1}`;
  const kind = nodeKindForId(nodeId);
  const decl = kind ? portDecl(kind, dir, port) : undefined;
  return decl?.label ?? (dir === "out" ? "Output" : port.replace(/^in-/, ""));
}

export function socketLabel(nodeId: string, dir: "in" | "out", port: string): string {
  return `${nodeTitle(nodeId)} ${portTitle(nodeId, dir, port)}`;
}

export interface Box { x: number; y: number; width: number; height: number }
export interface EdgeLite { id: string; source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }
export interface FrameSocket { edgeId: string; node: string; port: string; label: string }

/** Next default name: Frame 1, Frame 2, ... (first unused number). */
export function nextFrameName(frames: Record<string, GraphFrame> | undefined): string {
  const used = new Set(Object.values(frames ?? {}).map((f) => f.name));
  for (let i = 1; ; i++) if (!used.has(`Frame ${i}`)) return `Frame ${i}`;
}

/** Rectangle around member boxes with padding and room for the title bar. */
export function frameBoundsFor(boxes: Box[]): Box {
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return {
    x: minX - FRAME_PAD,
    y: minY - FRAME_PAD - FRAME_TITLE_H,
    width: maxX - minX + FRAME_PAD * 2,
    height: maxY - minY + FRAME_PAD * 2 + FRAME_TITLE_H,
  };
}

/** Build a frame; nodes already in another frame are moved out of it (no nesting). */
export function groupIntoFrame(
  frames: Record<string, GraphFrame> | undefined,
  members: string[],
  boxes: Box[],
  id: string,
  color = FRAME_PALETTE[0]
): Record<string, GraphFrame> {
  const set = new Set(members);
  const out: Record<string, GraphFrame> = {};
  for (const [fid, f] of Object.entries(frames ?? {})) {
    const rest = f.members.filter((m) => !set.has(m));
    if (rest.length) out[fid] = rest.length === f.members.length ? f : { ...f, members: rest };
  }
  out[id] = { id, name: nextFrameName(frames), color, members: [...members], ...frameBoundsFor(boxes) };
  return out;
}

export function frameOfNode(frames: Record<string, GraphFrame> | undefined, nodeId: string): GraphFrame | undefined {
  return Object.values(frames ?? {}).find((f) => f.members.includes(nodeId));
}

/** Sockets a collapsed frame exposes: boundary-crossing edges, stable order. */
export function frameSockets(frame: GraphFrame, edges: EdgeLite[]): { inputs: FrameSocket[]; outputs: FrameSocket[] } {
  const inside = new Set(frame.members);
  const byOrder = (a: FrameSocket, b: FrameSocket) =>
    a.node < b.node ? -1 : a.node > b.node ? 1 : a.port < b.port ? -1 : a.port > b.port ? 1 : a.edgeId < b.edgeId ? -1 : 1;
  const inputs: FrameSocket[] = [];
  const outputs: FrameSocket[] = [];
  for (const e of edges) {
    const s = inside.has(e.source), t = inside.has(e.target);
    if (t && !s) inputs.push({ edgeId: e.id, node: e.target, port: e.targetHandle ?? "", label: socketLabel(e.target, "in", e.targetHandle ?? "") });
    if (s && !t) outputs.push({ edgeId: e.id, node: e.source, port: e.sourceHandle ?? "", label: socketLabel(e.source, "out", e.sourceHandle ?? "") });
  }
  return { inputs: inputs.sort(byOrder), outputs: outputs.sort(byOrder) };
}

/** Node ids hidden because their frame is collapsed. */
export function collapsedHiddenNodes(layout: GraphLayout | undefined): Set<string> {
  const out = new Set<string>();
  for (const f of Object.values(layout?.frames ?? {})) if (f.collapsed) for (const m of f.members) out.add(m);
  return out;
}

export function deactivatedNodes(layout: GraphLayout | undefined): Set<string> {
  const out = new Set<string>();
  for (const f of Object.values(layout?.frames ?? {})) if (f.deactivated) for (const m of f.members) out.add(m);
  return out;
}

/** Edges that touch a deactivated frame's members across its boundary. */
export function deactivatedEdgeIds(layout: GraphLayout | undefined, edges: EdgeLite[]): Set<string> {
  const out = new Set<string>();
  for (const f of Object.values(layout?.frames ?? {})) {
    if (!f.deactivated) continue;
    const { inputs, outputs } = frameSockets(f, edges);
    for (const s of [...inputs, ...outputs]) out.add(s.edgeId);
  }
  return out;
}

/** Generation channel -> canonical node ids it runs when the call names none. */
const CHANNEL_DEFAULT_NODE: Record<string, string> = {
  "production:generateFrameNode": "imagegen",
  "production:generateVideoNode": "videogen",
  "production:generateEditNode": "editgen",
  "production:generateEditVideoNode": "editvideo",
  "production:generateTweenBlock": "tween",
  "production:generateUpscaleNode": "upscale",
  "cameraGrid:generate": "cameraGrid",
};
export const GENERATION_CHANNELS = new Set(Object.keys(CHANNEL_DEFAULT_NODE));

/** True when this generation call targets a node in a deactivated frame. */
export function generationBlocked(layout: GraphLayout | undefined, channel: string, nodeId?: string): boolean {
  const base = CHANNEL_DEFAULT_NODE[channel];
  if (!base) return false;
  const off = deactivatedNodes(layout);
  if (!off.size) return false;
  const id = nodeId && nodeId.length ? nodeId : base;
  return off.has(id) || (!nodeId && [...off].some((n) => n === base || n.startsWith(`${base}:`)));
}

/** Translate a whole frame (collapsed-group drag): frame box and member positions. */
export function translateFrame(
  frame: GraphFrame,
  positions: Record<string, { x: number; y: number }>,
  dx: number,
  dy: number
): { frame: GraphFrame; positions: Record<string, { x: number; y: number }> } {
  const next: Record<string, { x: number; y: number }> = {};
  for (const m of frame.members) if (positions[m]) next[m] = { x: positions[m].x + dx, y: positions[m].y + dy };
  return { frame: { ...frame, x: frame.x + dx, y: frame.y + dy }, positions: next };
}

/** Membership after a node is dropped at `center`: joins the frame it lies in, leaves otherwise. */
export function settleMembership(
  frames: Record<string, GraphFrame>,
  nodeId: string,
  center: { x: number; y: number }
): Record<string, GraphFrame> {
  const target = Object.values(frames).find(
    (f) => !f.collapsed && center.x >= f.x && center.x <= f.x + f.width && center.y >= f.y && center.y <= f.y + f.height
  );
  const out: Record<string, GraphFrame> = {};
  for (const [id, f] of Object.entries(frames)) {
    const has = f.members.includes(nodeId);
    if (target?.id === id && !has) out[id] = { ...f, members: [...f.members, nodeId] };
    else if (has && target?.id !== id) out[id] = { ...f, members: f.members.filter((m) => m !== nodeId) };
    else out[id] = f;
  }
  return out;
}
