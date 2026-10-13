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
import type { GraphLayout, GraphLayoutPatch } from "../ipc.js";

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
  if (patch.viewport !== undefined) next.viewport = { ...patch.viewport };
  return next;
}
