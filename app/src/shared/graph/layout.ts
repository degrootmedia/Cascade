/**
 * Canvas-state merge (architecture hardening, phase 3).
 *
 * One shot's node-graph canvas state (`graphLayout`) merges from a partial
 * patch, PER KEY: positions, sizes, and collapsed tiles fold node-by-node
 * (two windows moving different nodes both survive, where a whole-object
 * replace would lose one), and deleted nodes are named explicitly in
 * `remove` (absence alone can't express a delete in a per-key merge — and a
 * stale snapshot missing a node must never delete a node it never knew
 * about). The viewport replaces outright (one pan/zoom wins), and an absent
 * section leaves the fresh document's section untouched.
 *
 * Pure and shared: the main-process command handler (`production:
 * updateGraphLayout`) and the renderer's optimistic apply both read it, so
 * the two can't disagree on what a patch means.
 */
import type { GraphFrame, GraphLayout, GraphLayoutPatch } from "../ipc.js";

/** Structural minimum the tidy layout needs (a full Graph satisfies it). */
export interface TidyGraphShape {
  nodes: { id: string }[];
  edges: { from: { node: string }; to: { node: string } }[];
}

export interface TidyNodeSize {
  width: number;
  height: number;
}

/**
 * Deterministic layered auto-layout ("Tidy"): nodes are layered by longest
 * path depth from the sources (left), Frame Output is raised to the
 * rightmost layer, and nodes stack vertically inside a layer with fixed
 * gaps so nothing overlaps. Same graph + sizes in → same positions out
 * (ids sort inside a layer), so running it twice is a no-op. Layout-only:
 * it computes positions and nothing else.
 */
export function tidyGraphLayout(
  graph: TidyGraphShape,
  sizes: Record<string, TidyNodeSize>,
  isOutput: (nodeId: string) => boolean = (id) => id === "output"
): Record<string, { x: number; y: number }> {
  const ids = graph.nodes.map((n) => n.id);
  const present = new Set(ids);
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of graph.edges) {
    if (present.has(e.from.node) && present.has(e.to.node)) incoming.get(e.to.node)!.push(e.from.node);
  }
  // Longest-path depth, cycle-safe (a node on a cycle resolves via its
  // non-cycle inputs; the in-progress guard contributes 0).
  const depth = new Map<string, number>();
  const inProgress = new Set<string>();
  const depthOf = (id: string): number => {
    const memo = depth.get(id);
    if (memo !== undefined) return memo;
    if (inProgress.has(id)) return -1;
    inProgress.add(id);
    const srcs = incoming.get(id) ?? [];
    const d = srcs.length === 0 ? 0 : 1 + Math.max(0, ...srcs.map((s) => depthOf(s)));
    inProgress.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of ids) depthOf(id);
  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  for (const id of ids) if (isOutput(id)) depth.set(id, maxDepth);

  const layers = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id) ?? 0;
    const list = layers.get(d) ?? [];
    list.push(id);
    layers.set(d, list);
  }
  const sizeOf = (id: string): TidyNodeSize => sizes[id] ?? { width: 300, height: 200 };
  const positions: Record<string, { x: number; y: number }> = {};
  let x = 40;
  for (const d of [...layers.keys()].sort((a, b) => a - b)) {
    const list = (layers.get(d) ?? []).slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let y = 40;
    let layerWidth = 0;
    for (const id of list) {
      const s = sizeOf(id);
      positions[id] = { x, y };
      y += s.height + 40;
      layerWidth = Math.max(layerWidth, s.width);
    }
    x += layerWidth + 90;
  }
  return positions;
}

export function mergeGraphLayoutPatch(fresh: GraphLayout | undefined, patch: GraphLayoutPatch): GraphLayout {
  const next: GraphLayout = { ...(fresh ?? {}) };
  const drop = new Set(Array.isArray(patch.remove) ? patch.remove : []);
  const fold = <V>(freshMap: Record<string, V> | undefined, incoming: Record<string, V> | undefined): Record<string, V> | undefined => {
    const out = { ...(freshMap ?? {}), ...(incoming ?? {}) };
    for (const id of drop) delete out[id];
    return Object.keys(out).length ? out : undefined;
  };
  if (patch.positions !== undefined) next.positions = fold(fresh?.positions, patch.positions);
  else if (drop.size && next.positions) {
    const rest = { ...next.positions };
    for (const id of drop) delete rest[id];
    next.positions = Object.keys(rest).length ? rest : undefined;
  }
  if (patch.sizes !== undefined) next.sizes = fold(fresh?.sizes, patch.sizes);
  else if (drop.size && next.sizes) {
    const rest = { ...next.sizes };
    for (const id of drop) delete rest[id];
    next.sizes = Object.keys(rest).length ? rest : undefined;
  }
  if (patch.collapsed !== undefined) next.collapsed = fold(fresh?.collapsed, patch.collapsed);
  else if (drop.size && next.collapsed) {
    const rest = { ...next.collapsed };
    for (const id of drop) delete rest[id];
    next.collapsed = Object.keys(rest).length ? rest : undefined;
  }
  if (patch.waypoints !== undefined) {
    // Per-edge fold like the other maps, except an explicit empty list
    // DELETES the entry (that is how an edge's waypoints are cleared —
    // edge deletion, Tidy — in a merge where absence means "untouched").
    const out: Record<string, { x: number; y: number; id?: string }[]> = { ...(fresh?.waypoints ?? {}) };
    for (const [edgeId, pts] of Object.entries(patch.waypoints)) {
      if (Array.isArray(pts) && pts.length) out[edgeId] = pts.map((p) => (p.id ? { id: p.id, x: p.x, y: p.y } : { x: p.x, y: p.y }));
      else delete out[edgeId];
    }
    next.waypoints = Object.keys(out).length ? out : undefined;
  }
  if (patch.frames !== undefined) {
    const out: Record<string, GraphFrame> = { ...(fresh?.frames ?? {}) };
    for (const [fid, f] of Object.entries(patch.frames)) {
      if (f) out[fid] = { ...f, members: [...f.members] };
      else delete out[fid];
    }
    next.frames = Object.keys(out).length ? out : undefined;
  }
  if (patch.wireStyle !== undefined) next.wireStyle = patch.wireStyle === "straight" ? "straight" : undefined;
  if (patch.viewport !== undefined) next.viewport = { ...patch.viewport };
  return next;
}
