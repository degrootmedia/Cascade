/**
 * Node-graph media policy: node-contained media never needs high res (the
 * lightbox is the high-res surface and always gets the original URL), so
 * every preview/poster/tile paints a FIXED thumbnail tier (`?thumb=`, see
 * thumb-url.ts). A node's `src` therefore never changes across pan/zoom —
 * gestures reload nothing. (The moodboard keeps its own settled-zoom
 * tiering: its nodes are free-sized working surfaces, unlike these small
 * fixed preview boxes.)
 *
 * This module also carries the interaction flag: while the viewport moves,
 * live videos stand down to posters, so no decoder competes with the
 * gesture. It reaches node views through context — never through node
 * `data`, which would churn the reconciliation equality rules in
 * shared/graph/reconcile.ts. (Nodes carry no drop shadow at all — a
 * per-node shadow re-rasters every pan/zoom frame; see `.prod-graph-node`
 * in styles.css.)
 */
import { createContext, useContext, useMemo, useState, type MutableRefObject, type ReactNode } from "react";

/** Fixed tier for generator previews and video posters (300/320px-wide
 *  nodes, 120px-tall preview). Covers zoom 1 at most DPRs; zoomed right in
 *  it reads mildly soft — the lightbox is for judging pixels. */
export const GRAPH_PREVIEW_EDGE = 512;

/** Fixed tier for resizable tiles (reference, frame output, camera-grid
 *  sheet thumbnails), which users can enlarge to inspect in place. */
export const GRAPH_TILE_EDGE = 1024;

/** Nodes stay mounted below this count: culling (React Flow's
 *  `onlyRenderVisibleElements`) unmounts off-viewport nodes with ZERO
 *  overscan, so each node remounts + re-decodes the frame it enters view —
 *  at per-shot graph scale that churn costs more than the retained DOM.
 *  Above the limit the canvas falls back to culling. */
export const GRAPH_CULL_NODE_LIMIT = 150;

export interface GraphLod {
  /** The viewport is currently panning/zooming. */
  interacting: boolean;
}

export const GraphLodContext = createContext<GraphLod>({ interacting: false });

export function useGraphLod(): GraphLod {
  return useContext(GraphLodContext);
}

/** Imperative door into the provider's interaction flag. The canvas host
 *  calls this from React Flow's move callbacks; the state lives in the
 *  leaf provider below, NOT in the host component — d3-zoom fires a full
 *  start/end cycle per wheel burst, and flipping host-level React state on
 *  `start` re-rendered the entire modal between the first wheel notch and
 *  the first painted scale change (the "zoom skips its first increments"
 *  feel). Only context consumers (live video previews) re-render now. */
export interface GraphLodHandle {
  setInteracting: (interacting: boolean) => void;
}

/** Leaf owner of the viewport-moving flag. `handleRef` is assigned during
 *  render (the codebase's callback-ref pattern) so the host's stable move
 *  callbacks can flip the flag without prop drilling state upward. */
export function GraphLodProvider({
  handleRef,
  children,
}: {
  handleRef: MutableRefObject<GraphLodHandle | null>;
  children: ReactNode;
}) {
  const [interacting, setInteracting] = useState(false);
  handleRef.current = { setInteracting };
  const value = useMemo<GraphLod>(() => ({ interacting }), [interacting]);
  return <GraphLodContext.Provider value={value}>{children}</GraphLodContext.Provider>;
}
