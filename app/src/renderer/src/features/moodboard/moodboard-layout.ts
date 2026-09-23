/**
 * Reference Moodboard layout math — pure functions, no React, no Electron.
 *
 * The board's persisted `MoodboardLayout` is renderer-owned and can come from
 * an old or hand-edited file, so every read goes through
 * `normalizeMoodboardLayout`: persisted numbers are repaired (never trusted),
 * duplicate/orphan node entries are dropped, and the viewport is clamped.
 *
 * Coordinates are "world" px; the canvas applies `translate(x,y) scale(zoom)`
 * with origin 0 0, so a node's left/top are its world position.
 */
import type {
  CustomRef,
  MoodboardFrame,
  MoodboardLayout,
  MoodboardNodeLayout,
  MoodboardNote,
} from "../../../../shared/ipc.js";

export const MOODBOARD_VERSION = 1 as const;

/** Grid a dragged node snaps to (Shift = free placement). */
export const MB_GRID = 8;
export const MB_MIN_SIZE = 80;
export const MB_DEFAULT_W = 220;
export const MB_DEFAULT_H = 180;
/** Auto-layout shelf: columns before wrapping, gap between slots. */
export const MB_SHELF_COLS = 6;
export const MB_SHELF_GAP = 24;
export const MB_MIN_ZOOM = 0.1;
export const MB_MAX_ZOOM = 8;
export const MB_ROTATE_SNAP = 15;

/** Padding between a grouped frame's edge and its outer member nodes. */
export const MB_FRAME_PAD = 18;
/** Height of a frame's label/header bar. */
export const MB_FRAME_HEADER = 26;
export const MB_FRAME_MIN_W = 120;
export const MB_FRAME_MIN_H = 80;

/** The accent palette frames can be tinted with. `id` is what persists; `hex`
 *  is presentation only (so a palette tweak re-colors existing frames). */
export const MOODBOARD_FRAME_COLORS = [
  { id: "blue", label: "Blue", hex: "#4f8ef7" },
  { id: "violet", label: "Violet", hex: "#9a7bff" },
  { id: "pink", label: "Pink", hex: "#ef6ea8" },
  { id: "red", label: "Red", hex: "#e5534b" },
  { id: "orange", label: "Orange", hex: "#f0883e" },
  { id: "amber", label: "Amber", hex: "#e3b341" },
  { id: "green", label: "Green", hex: "#57ab5a" },
  { id: "teal", label: "Teal", hex: "#39c5bb" },
] as const;

export type MoodboardFrameColorId = (typeof MOODBOARD_FRAME_COLORS)[number]["id"];

export const MB_FRAME_DEFAULT_COLOR: MoodboardFrameColorId = "blue";

export function normalizeFrameColor(raw: unknown): MoodboardFrameColorId {
  return MOODBOARD_FRAME_COLORS.some((c) => c.id === raw) ? (raw as MoodboardFrameColorId) : MB_FRAME_DEFAULT_COLOR;
}

/** The hex for a persisted color key (unknown keys fall back to the default). */
export function frameColorHex(raw: unknown): string {
  const id = normalizeFrameColor(raw);
  return MOODBOARD_FRAME_COLORS.find((c) => c.id === id)!.hex;
}

export interface MoodboardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MoodboardViewport {
  x: number;
  y: number;
  zoom: number;
}

/** A ref's identity + sort fields the layout functions need. */
export interface MoodboardRefKey {
  id: string;
  name: string;
  categoryId?: string;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function snapToGrid(v: number, grid = MB_GRID): number {
  // `|| 0` normalizes the -0 that rounding a small negative produces.
  return Math.round(v / grid) * grid || 0;
}

/** Snap an angle to the nearest 15° (used while Shift is held). */
export function snapRotation(deg: number): number {
  return Math.round(deg / MB_ROTATE_SNAP) * MB_ROTATE_SNAP;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function sanitizeNote(raw: unknown): MoodboardNote | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.id !== "string" || !n.id) return null;
  return {
    id: n.id,
    x: num(n.x, 0),
    y: num(n.y, 0),
    w: clamp(num(n.w, 260), 120, 4000),
    h: clamp(num(n.h, 160), 80, 4000),
    text: typeof n.text === "string" ? n.text : "",
  };
}

/** Repair a persisted (or absent) layout. Never throws, never trusts numbers. */
export function normalizeMoodboardLayout(raw: unknown): MoodboardLayout {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawNodes = Array.isArray(r.nodes) ? r.nodes : [];
  const seen = new Set<string>();
  const nodes: MoodboardNodeLayout[] = [];
  for (const entry of rawNodes) {
    if (!entry || typeof entry !== "object") continue;
    const n = entry as Record<string, unknown>;
    const refId = typeof n.refId === "string" ? n.refId : "";
    if (!refId || seen.has(refId)) continue;
    seen.add(refId);
    const node: MoodboardNodeLayout = {
      refId,
      x: num(n.x, 0),
      y: num(n.y, 0),
      w: clamp(num(n.w, MB_DEFAULT_W), MB_MIN_SIZE, 4000),
      h: clamp(num(n.h, MB_DEFAULT_H), MB_MIN_SIZE, 4000),
      z: num(n.z, nodes.length),
    };
    if (n.hidden === true) node.hidden = true;
    if (typeof n.rotation === "number" && Number.isFinite(n.rotation) && n.rotation % 360 !== 0) {
      node.rotation = n.rotation % 360;
    }
    nodes.push(node);
  }
  const rawVp = r.viewport && typeof r.viewport === "object" ? (r.viewport as Record<string, unknown>) : {};
  const viewport: MoodboardViewport = {
    x: num(rawVp.x, 0),
    y: num(rawVp.y, 0),
    zoom: clamp(num(rawVp.zoom, 1), MB_MIN_ZOOM, MB_MAX_ZOOM),
  };
  const notes = (Array.isArray(r.notes) ? r.notes : [])
    .map(sanitizeNote)
    .filter((n): n is MoodboardNote => n !== null);
  const frameIds = new Set<string>();
  const claimed = new Set<string>();
  const frames: MoodboardFrame[] = [];
  for (const entry of Array.isArray(r.frames) ? r.frames : []) {
    if (!entry || typeof entry !== "object") continue;
    const f = entry as Record<string, unknown>;
    const id = typeof f.id === "string" ? f.id : "";
    if (!id || frameIds.has(id)) continue;
    const refIds: string[] = [];
    const inFrame = new Set<string>();
    for (const v of Array.isArray(f.refIds) ? f.refIds : []) {
      if (typeof v !== "string" || !seen.has(v) || claimed.has(v) || inFrame.has(v)) continue;
      inFrame.add(v);
      refIds.push(v);
    }
    if (!refIds.length) continue;
    frameIds.add(id);
    for (const v of refIds) claimed.add(v);
    frames.push({
      id,
      x: num(f.x, 0),
      y: num(f.y, 0),
      w: clamp(num(f.w, MB_FRAME_MIN_W), MB_FRAME_MIN_W, 8000),
      h: clamp(num(f.h, MB_FRAME_MIN_H), MB_FRAME_MIN_H, 8000),
      label: typeof f.label === "string" ? f.label : "",
      color: normalizeFrameColor(f.color),
      refIds,
    });
  }
  const background = r.background === "mid" || r.background === "grid" ? r.background : r.background === "dark" ? "dark" : undefined;
  return {
    version: MOODBOARD_VERSION,
    nodes,
    viewport,
    ...(background ? { background } : {}),
    ...(notes.length ? { notes } : {}),
    ...(frames.length ? { frames } : {}),
  };
}

/** Replace a layout's frames, dropping the key entirely when none remain (so a
 *  frame-less board round-trips as if frames never existed). */
function withFrames(layout: MoodboardLayout, frames: MoodboardFrame[]): MoodboardLayout {
  const next = { ...layout };
  if (frames.length) next.frames = frames;
  else delete next.frames;
  return next;
}

/** A frame's rectangle in world px. */
export function frameBounds(f: MoodboardFrame): MoodboardRect {
  return { x: f.x, y: f.y, w: f.w, h: f.h };
}

/** The frame (if any) whose `refIds` include the given reference. */
export function frameContainingRef(layout: MoodboardLayout, refId: string): MoodboardFrame | null {
  return (layout.frames ?? []).find((f) => f.refIds.includes(refId)) ?? null;
}

/** Every frame that contains any of the given reference ids. */
export function framesForRefs(layout: MoodboardLayout, refIds: Iterable<string>): MoodboardFrame[] {
  const set = new Set(refIds);
  return (layout.frames ?? []).filter((f) => f.refIds.some((r) => set.has(r)));
}

/** The innermost frame whose rectangle contains a world point (smallest area
 *  wins, ties broken by later creation order). Used to drop a node into a frame. */
export function frameAtPoint(layout: MoodboardLayout, x: number, y: number): MoodboardFrame | null {
  let best: MoodboardFrame | null = null;
  for (const f of layout.frames ?? []) {
    if (x < f.x || x > f.x + f.w || y < f.y || y > f.y + f.h) continue;
    if (!best || f.w * f.h < best.w * best.h) best = f;
  }
  return best;
}

/**
 * Re-home references after a drag. Alt-drag (`remove`) takes them out of every
 * frame; otherwise a ref whose center now lands in a frame joins that frame
 * (re-parenting out of any other), while a ref dropped outside keeps whatever
 * frame it already belonged to. Empty frames are dropped.
 */
export function settleFrameMembership(
  layout: MoodboardLayout,
  refIds: string[],
  remove: boolean,
): MoodboardLayout {
  const frames = layout.frames ?? [];
  if (!frames.length || !refIds.length) return layout;
  const nodeById = new Map(layout.nodes.map((n) => [n.refId, n]));
  const moving = new Set<string>();
  for (const id of refIds) {
    // A hidden member is never part of a visible drag, so a group move must not
    // drop it from its frame; an explicit remove (alt-drag) still applies.
    if (!remove && nodeById.get(id)?.hidden) continue;
    moving.add(id);
  }
  const targets = new Map<string, string[]>();
  if (!remove) {
    for (const id of moving) {
      const n = nodeById.get(id);
      if (!n) continue;
      const target = frameAtPoint(layout, n.x + n.w / 2, n.y + n.h / 2);
      if (!target) continue;
      const arr = targets.get(target.id);
      if (arr) arr.push(id);
      else targets.set(target.id, [id]);
    }
  }
  const next = frames
    .map((f) => {
      const kept = f.refIds.filter((r) => !moving.has(r));
      const add = targets.get(f.id);
      if (!add) return kept.length === f.refIds.length ? f : { ...f, refIds: kept };
      return { ...f, refIds: [...kept, ...add] };
    })
    .filter((f) => f.refIds.length > 0);
  const changed = next.length !== frames.length || next.some((f, i) => f !== frames[i]);
  return changed ? withFrames(layout, next) : layout;
}

/**
 * Group the given references into a new frame sized to their bounding box (plus
 * a header bar), removing them from any existing frame. Requires a caller-made
 * `id` (the module stays random-free so it is trivial to test). Returns the
 * layout unchanged when none of the ids name a visible node.
 */
export function groupNodes(
  layout: MoodboardLayout,
  ids: string[],
  opts: { id: string; color?: string; label?: string },
): MoodboardLayout {
  const wanted = new Set(ids);
  const members = layout.nodes.filter((n) => wanted.has(n.refId) && !n.hidden);
  if (!members.length) return layout;
  const b = contentBounds(members)!;
  const frame: MoodboardFrame = {
    id: opts.id,
    x: b.x - MB_FRAME_PAD,
    y: b.y - MB_FRAME_PAD - MB_FRAME_HEADER,
    w: b.w + MB_FRAME_PAD * 2,
    h: b.h + MB_FRAME_PAD * 2 + MB_FRAME_HEADER,
    label: opts.label ?? "",
    color: normalizeFrameColor(opts.color),
    refIds: members.map((n) => n.refId),
  };
  const memberSet = new Set(frame.refIds);
  // Re-grouping pulls members out of any frame that already held them.
  const frames = (layout.frames ?? [])
    .map((f) => (f.refIds.some((r) => memberSet.has(r)) ? { ...f, refIds: f.refIds.filter((r) => !memberSet.has(r)) } : f))
    .filter((f) => f.refIds.length > 0);
  frames.push(frame);
  return withFrames(layout, frames);
}

/** Drop every frame that contains one of the given references (their nodes stay). */
export function ungroupFrames(layout: MoodboardLayout, refIds: Iterable<string>): MoodboardLayout {
  const set = new Set(refIds);
  const frames = layout.frames ?? [];
  if (!frames.length) return layout;
  const next = frames.filter((f) => !f.refIds.some((r) => set.has(r)));
  if (next.length === frames.length) return layout;
  return withFrames(layout, next);
}

/** Remove one frame by id (its nodes stay on the board). */
export function removeFrame(layout: MoodboardLayout, frameId: string): MoodboardLayout {
  const frames = layout.frames ?? [];
  if (!frames.some((f) => f.id === frameId)) return layout;
  return withFrames(layout, frames.filter((f) => f.id !== frameId));
}

/** Rename a frame's label. */
export function setFrameLabel(layout: MoodboardLayout, frameId: string, label: string): MoodboardLayout {
  const frames = layout.frames ?? [];
  if (!frames.some((f) => f.id === frameId)) return layout;
  return withFrames(layout, frames.map((f) => (f.id === frameId ? { ...f, label } : f)));
}

/** Recolor a frame with a palette key. */
export function setFrameColor(layout: MoodboardLayout, frameId: string, color: string): MoodboardLayout {
  const frames = layout.frames ?? [];
  if (!frames.some((f) => f.id === frameId)) return layout;
  const safe = normalizeFrameColor(color);
  return withFrames(layout, frames.map((f) => (f.id === frameId ? { ...f, color: safe } : f)));
}

/** Resize a frame (members are untouched). */
export function resizeFrame(layout: MoodboardLayout, frameId: string, w: number, h: number): MoodboardLayout {
  const frames = layout.frames ?? [];
  if (!frames.some((f) => f.id === frameId)) return layout;
  return withFrames(
    layout,
    frames.map((f) => (f.id === frameId ? { ...f, w: Math.max(MB_FRAME_MIN_W, w), h: Math.max(MB_FRAME_MIN_H, h) } : f)),
  );
}

/** Translate a frame and every member node by the same delta. */
export function translateFrame(layout: MoodboardLayout, frameId: string, dx: number, dy: number): MoodboardLayout {
  const frame = (layout.frames ?? []).find((f) => f.id === frameId);
  if (!frame) return layout;
  const members = new Set(frame.refIds);
  return {
    ...layout,
    frames: (layout.frames ?? []).map((f) => (f.id === frameId ? { ...f, x: f.x + dx, y: f.y + dy } : f)),
    nodes: layout.nodes.map((n) => (members.has(n.refId) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
  };
}

export function nodeBounds(n: MoodboardNodeLayout): MoodboardRect {
  return { x: n.x, y: n.y, w: n.w, h: n.h };
}

export function rectsIntersect(a: MoodboardRect, b: MoodboardRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Axis-aligned bounding box of every node (rotation ignored — nodes rotate
 *  about their center, so the AABB is a close enough cull/hit approximation). */
export function contentBounds(nodes: MoodboardNodeLayout[]): MoodboardRect | null {
  if (!nodes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Topmost node containing a world point (highest z wins). */
export function topmostNodeAt(nodes: MoodboardNodeLayout[], wx: number, wy: number): MoodboardNodeLayout | null {
  let hit: MoodboardNodeLayout | null = null;
  for (const n of nodes) {
    if (wx < n.x || wx > n.x + n.w || wy < n.y || wy > n.y + n.h) continue;
    if (!hit || n.z >= hit.z) hit = n;
  }
  return hit;
}

export function nodesInRect(nodes: MoodboardNodeLayout[], rect: MoodboardRect): MoodboardNodeLayout[] {
  return nodes.filter((n) => rectsIntersect(nodeBounds(n), rect));
}

export function nextZ(nodes: MoodboardNodeLayout[]): number {
  let max = 0;
  for (const n of nodes) if (Number.isFinite(n.z) && n.z > max) max = n.z;
  return max + 1;
}

/** Deterministic shelf packing: category then name, `MB_SHELF_COLS` columns. */
export function autoLayoutNodes(refs: MoodboardRefKey[], startY = 0): MoodboardNodeLayout[] {
  const sorted = [...refs].sort(
    (a, b) => (a.categoryId ?? "").localeCompare(b.categoryId ?? "") || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  return sorted.map((r, i) => ({
    refId: r.id,
    x: (i % MB_SHELF_COLS) * (MB_DEFAULT_W + MB_SHELF_GAP),
    y: startY + Math.floor(i / MB_SHELF_COLS) * (MB_DEFAULT_H + MB_SHELF_GAP),
    w: MB_DEFAULT_W,
    h: MB_DEFAULT_H,
    z: i,
  }));
}

/** Where the next batch of auto-placed nodes goes: below everything, aligned
 *  with the left edge of the current content. */
export function nextFreeSpot(nodes: MoodboardNodeLayout[]): { x: number; y: number } {
  if (!nodes.length) return { x: 0, y: 0 };
  const minX = Math.min(...nodes.map((n) => n.x));
  const maxBottom = Math.max(...nodes.map((n) => n.y + n.h));
  return { x: minX, y: maxBottom + MB_SHELF_GAP };
}

/**
 * Make the layout describe exactly the given refs: surviving nodes keep their
 * placement (and object identity, so callers can cheaply detect a no-op), new
 * refs are auto-placed below the content, and nodes whose ref is gone are
 * pruned. `layout` must already be normalized (see `normalizeMoodboardLayout`).
 */
export function reconcileMoodboard(layout: MoodboardLayout, refs: MoodboardRefKey[]): MoodboardLayout {
  const ids = new Set(refs.map((r) => r.id));
  const nodes = layout.nodes.filter((n) => ids.has(n.refId));
  const have = new Set(nodes.map((n) => n.refId));
  const missing = refs.filter((r) => !have.has(r.id));
  const nodesChanged = missing.length > 0 || nodes.length !== layout.nodes.length;
  if (missing.length) {
    const spot = nextFreeSpot(nodes);
    let z = nextZ(nodes);
    for (const n of autoLayoutNodes(missing, spot.y)) {
      nodes.push({ ...n, x: n.x + spot.x, z: z++ });
    }
  }
  // Frames: drop members whose ref is gone, and drop frames left empty. A ref
  // belongs to at most one frame (first frame wins on a hand-edited collision).
  const nodeIds = new Set(nodes.map((n) => n.refId));
  const claimed = new Set<string>();
  const rawFrames = layout.frames ?? [];
  const frames: MoodboardFrame[] = [];
  for (const f of rawFrames) {
    const members = f.refIds.filter((r) => nodeIds.has(r) && !claimed.has(r));
    for (const r of members) claimed.add(r);
    if (members.length) frames.push(members.length === f.refIds.length ? f : { ...f, refIds: members });
  }
  const framesChanged = frames.length !== rawFrames.length || frames.some((f, i) => f !== rawFrames[i]);
  if (!nodesChanged && !framesChanged) return layout;
  return withFrames({ ...layout, nodes }, frames);
}

export function screenToWorld(vp: MoodboardViewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - vp.x) / vp.zoom, y: (sy - vp.y) / vp.zoom };
}

export function worldToScreen(vp: MoodboardViewport, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * vp.zoom + vp.x, y: wy * vp.zoom + vp.y };
}

/** Zoom by `factor` anchored at a screen point, so the world point under the
 *  cursor stays put. */
export function zoomAt(vp: MoodboardViewport, sx: number, sy: number, factor: number): MoodboardViewport {
  const zoom = clamp(vp.zoom * factor, MB_MIN_ZOOM, MB_MAX_ZOOM);
  if (zoom === vp.zoom) return vp;
  const world = screenToWorld(vp, sx, sy);
  return { zoom, x: sx - world.x * zoom, y: sy - world.y * zoom };
}

/** Center `bounds` in a viewport-sized box. Null/empty content → identity. */
export function fitViewport(
  bounds: MoodboardRect | null,
  viewW: number,
  viewH: number,
  padding = 48,
): MoodboardViewport {
  if (!bounds || bounds.w <= 0 || bounds.h <= 0 || viewW <= 0 || viewH <= 0) {
    return { x: 0, y: 0, zoom: 1 };
  }
  const zoom = clamp(
    Math.min((viewW - padding * 2) / bounds.w, (viewH - padding * 2) / bounds.h),
    MB_MIN_ZOOM,
    MB_MAX_ZOOM,
  );
  return {
    zoom,
    x: (viewW - bounds.w * zoom) / 2 - bounds.x * zoom,
    y: (viewH - bounds.h * zoom) / 2 - bounds.y * zoom,
  };
}

export interface MoodboardGuide {
  axis: "x" | "y";
  world: number;
}

/** Edge/center alignment for a dragged rect: returns the adjusted top-left and
 *  the guide lines to draw. On each axis the smallest offset within
 *  `threshold` wins; no candidate → the raw position (grid-snapped by caller). */
export function snapMove(
  rect: MoodboardRect,
  others: MoodboardRect[],
  threshold = 6,
): { x: number; y: number; guides: MoodboardGuide[] } {
  const xs = [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
  const ys = [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
  let bestX: { delta: number; world: number } | null = null;
  let bestY: { delta: number; world: number } | null = null;
  for (const o of others) {
    const ox = [o.x, o.x + o.w / 2, o.x + o.w];
    const oy = [o.y, o.y + o.h / 2, o.y + o.h];
    for (const a of xs) {
      for (const b of ox) {
        const delta = b - a;
        if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, world: b };
      }
    }
    for (const a of ys) {
      for (const b of oy) {
        const delta = b - a;
        if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, world: b };
      }
    }
  }
  const guides: MoodboardGuide[] = [];
  if (bestX) guides.push({ axis: "x", world: bestX.world });
  if (bestY) guides.push({ axis: "y", world: bestY.world });
  return { x: rect.x + (bestX?.delta ?? 0), y: rect.y + (bestY?.delta ?? 0), guides };
}

/** Viewport-culling: nodes whose AABB intersects the visible world rect,
 *  expanded by one screen so panning reveals no pop-in. */
export function visibleNodes(
  nodes: MoodboardNodeLayout[],
  vp: MoodboardViewport,
  viewW: number,
  viewH: number,
): MoodboardNodeLayout[] {
  const tl = screenToWorld(vp, 0, 0);
  const br = screenToWorld(vp, viewW, viewH);
  const margin = Math.max(viewW, viewH) / Math.max(vp.zoom, MB_MIN_ZOOM);
  const rect: MoodboardRect = { x: tl.x - margin, y: tl.y - margin, w: br.x - tl.x + margin * 2, h: br.y - tl.y + margin * 2 };
  return nodes.filter((n) => rectsIntersect(nodeBounds(n), rect));
}

/** The refs a layout describes, in board (z) order. Used to drive auto-add. */
export function refKeys(refs: CustomRef[]): MoodboardRefKey[] {
  return refs.map((r) => ({ id: r.id, name: r.name, categoryId: r.categoryId }));
}

/**
 * The references the off-board shelf offers: those not currently visible on the
 * board — either no layout node at all or one the user removed from the canvas
 * (`hidden`). Order follows the production's reference array.
 */
export function offBoardRefs(layout: MoodboardLayout, refs: CustomRef[]): CustomRef[] {
  const onBoard = new Set(layout.nodes.filter((n) => !n.hidden).map((n) => n.refId));
  return refs.filter((r) => !onBoard.has(r.id));
}
