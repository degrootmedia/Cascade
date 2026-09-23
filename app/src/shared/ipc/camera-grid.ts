/**
 * Camera-grid node types + pure grid math (Spec 04).
 *
 * Domain module of `shared/ipc.ts`; the barrel re-exports everything, so
 * `../shared/ipc.js` import paths are unchanged.
 *
 * The grid math here is vendor-blind and side-effect-free: the renderer uses it
 * to derive panel rects, build a marquee, and decide which panels a selection
 * covers; main uses the same clamp to validate incoming crop rects. The actual
 * image cropping/decoding lives in `main/camera-grid.ts` (Electron nativeImage).
 */
import type { CameraGridData, CameraGridPanel, GenParams, GraphSource } from "./graph.js";
import type { CustomRef, Production } from "./production.js";
import { isProductionRelative } from "./suite.js";

/** Default grid geometry (the 16-panel 4x4 sheet). */
export const CAMERA_GRID_COLS = 4;
export const CAMERA_GRID_ROWS = 4;

/** One selectable grid geometry. `cols`/`rows` stay generic on the node (so an
 *  imported grid image can declare any size); these are the offered presets. */
export interface CameraGridSize {
  cols: number;
  rows: number;
  /** Dropdown / Settings label. */
  label: string;
}

/** The grid sizes the node and the export editor offer, largest first. */
export const CAMERA_GRID_SIZES: readonly CameraGridSize[] = [
  { cols: 4, rows: 4, label: "4×4 (16 shots)" },
  { cols: 3, rows: 3, label: "3×3 (9 shots)" },
  { cols: 2, rows: 2, label: "2×2 (4 shots)" },
];

/** The canonical `"CxR"` key for a grid geometry (the dropdown value). Pure. */
export function cameraGridSizeKey(cols: number, rows: number): string {
  const c = Math.max(1, Math.floor(cols) || 1);
  const r = Math.max(1, Math.floor(rows) || 1);
  return `${c}x${r}`;
}

/** The category exported panels land in (created on demand). */
export const CAMERA_GRID_CATEGORY_ID = "camera-grid";
export const CAMERA_GRID_CATEGORY_NAME = "Camera Grid";

/** The panel rects of a `cols x rows` grid, row-major, normalized to [0..1]. */
export function cameraGridPanels(cols: number, rows: number): CameraGridPanel[] {
  const c = Math.max(1, Math.floor(cols));
  const r = Math.max(1, Math.floor(rows));
  const out: CameraGridPanel[] = [];
  for (let row = 0; row < r; row++) {
    for (let col = 0; col < c; col++) {
      out.push({ x: col / c, y: row / r, w: 1 / c, h: 1 / r });
    }
  }
  return out;
}

/** A normalized rect from two drag points (any order), clamped to [0..1]. */
export function gridRectFromPoints(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): CameraGridPanel {
  return clampGridRect({
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  });
}

/** Clamp a rect to the unit square; never returns negative extents. */
export function clampGridRect(rect: CameraGridPanel): CameraGridPanel {
  const x = clamp01(rect.x);
  const y = clamp01(rect.y);
  const w = Math.max(0, Math.min(1 - x, rect.w));
  const h = Math.max(0, Math.min(1 - y, rect.h));
  return { x, y, w, h };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

export function rectArea(r: CameraGridPanel): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

/** Shrink a normalized rect proportionally by `inset` of its own size on each
 *  edge (0..0.45). Exported panels use this to crop the black gutters/borders
 *  between generated cells out of the crop. Pure. */
export function insetGridRect(rect: CameraGridPanel, inset: number): CameraGridPanel {
  const k = Number.isFinite(inset) ? Math.max(0, Math.min(0.45, inset)) : 0;
  const r = clampGridRect(rect);
  if (k === 0) return r;
  return clampGridRect({
    x: r.x + r.w * k,
    y: r.y + r.h * k,
    w: r.w * (1 - 2 * k),
    h: r.h * (1 - 2 * k),
  });
}

/** Overlap area of two normalized rects (0 when disjoint). */
export function intersectArea(a: CameraGridPanel, b: CameraGridPanel): number {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= x || bottom <= y) return 0;
  return (right - x) * (bottom - y);
}

/** Panel indices a marquee touches: every panel it overlaps by any amount.
 *  Empty when the marquee is degenerate. */
export function touchedPanelIndices(
  rect: CameraGridPanel,
  panels: CameraGridPanel[],
): number[] {
  const out: number[] = [];
  panels.forEach((panel, i) => {
    if (rectArea(panel) <= 0) return;
    if (intersectArea(rect, panel) > 0) out.push(i);
  });
  return out;
}

/** The smallest rect covering every given rect (their normalized union), or
 *  null when none. Pure. */
export function unionGridRects(rects: CameraGridPanel[]): CameraGridPanel | null {
  if (!rects.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return clampGridRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

/** The label for one panel: a stored label, else "Angle N" (1-based). */
export function panelLabelFor(labels: string[] | undefined, index: number): string {
  const label = labels?.[index];
  return typeof label === "string" && label.trim() ? label.trim() : `Angle ${index + 1}`;
}

/** A full label list for a grid, filling absent entries with "Angle N". */
export function resolvePanelLabels(
  count: number,
  labels?: string[],
): string[] {
  return Array.from({ length: count }, (_, i) => panelLabelFor(labels, i));
}

/** The panel rects stored on the node, or derived `cols x rows` cells when the
 *  stored list doesn't match the geometry. */
export function resolveCameraGridPanels(data: Pick<CameraGridData, "cols" | "rows" | "panels">): CameraGridPanel[] {
  const cols = Math.max(1, Math.floor(data.cols) || CAMERA_GRID_COLS);
  const rows = Math.max(1, Math.floor(data.rows) || CAMERA_GRID_ROWS);
  const expected = cols * rows;
  if (Array.isArray(data.panels) && data.panels.length === expected) {
    return data.panels.map(clampGridRect);
  }
  return cameraGridPanels(cols, rows);
}

/** Repair a source descriptor (`source` field) into a well-formed value, or
 *  undefined when malformed. Pure. */
export function normalizeGraphSource(raw: unknown): GraphSource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as { kind?: unknown; nodeId?: unknown; refId?: unknown };
  if (s.kind === "imagegen") return { kind: "imagegen" };
  if (s.kind === "editgen" && typeof s.nodeId === "string" && s.nodeId.trim()) {
    return { kind: "editgen", nodeId: s.nodeId };
  }
  if (s.kind === "ref" && typeof s.refId === "string" && s.refId.trim()) {
    return { kind: "ref", refId: s.refId };
  }
  return undefined;
}

/** Sanitize a raw `params` bag to string values (the form's GenParams shape). */
function normalizeGenParams(raw: unknown): GenParams | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: GenParams = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Repair a raw persisted `graphCameraGrid` value into a well-formed node
 *  state (defaults the geometry; keeps a valid sheet path, wiring, and the
 *  node's own generation picks). Pure. */
export function normalizeCameraGridData(raw: unknown): CameraGridData | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<CameraGridData>;
  const cols = Number.isFinite(r.cols) ? Math.max(1, Math.floor(r.cols as number)) : CAMERA_GRID_COLS;
  const rows = Number.isFinite(r.rows) ? Math.max(1, Math.floor(r.rows as number)) : CAMERA_GRID_ROWS;
  const data: CameraGridData = { cols, rows };
  if (typeof r.sheetPath === "string" && r.sheetPath.trim()) data.sheetPath = r.sheetPath;
  if (typeof r.sheetAt === "string" && r.sheetAt.trim()) data.sheetAt = r.sheetAt;
  if (Array.isArray(r.panels) && r.panels.length === cols * rows) {
    data.panels = r.panels.map((p) => clampGridRect(p as CameraGridPanel));
  }
  if (Array.isArray(r.panelLabels)) data.panelLabels = r.panelLabels.map((l) => String(l));
  const source = normalizeGraphSource(r.source);
  if (source) data.source = source;
  const gridSource = normalizeGraphSource(r.gridSource);
  if (gridSource) data.gridSource = gridSource;
  if (Array.isArray(r.refIds)) {
    const refIds = r.refIds.filter((id): id is string => typeof id === "string" && !!id.trim());
    if (refIds.length) data.refIds = refIds;
  }
  if (typeof r.model === "string" && r.model.trim()) data.model = r.model;
  if (typeof r.resolution === "string" && r.resolution.trim()) data.resolution = r.resolution;
  const params = normalizeGenParams(r.params);
  if (params) data.params = params;
  if (Number.isFinite(r.inset)) data.inset = Math.max(0, Math.min(0.45, r.inset as number));
  const g = r.generation;
  if (g && typeof g === "object" && typeof g.prompt === "string") {
    data.generation = { provider: String(g.provider ?? ""), model: String(g.model ?? ""), prompt: g.prompt };
  }
  return data;
}

/** The reference ids after wiring `refId` into the camera grid's reference
 *  sockets: replaces the reference occupying `slot`, else appends. A ref
 *  already wired moves rather than duplicating. Pure. */
export function placeCameraGridRef(ids: string[], refId: string, slot?: number): string[] {
  const out = ids.filter((id) => id !== refId);
  if (slot === undefined || slot < 0 || slot >= out.length) return [...out, refId];
  out[slot] = refId;
  return out;
}

/** The reference ids after removing the reference at `slot`. Pure. */
export function removeCameraGridRefAt(ids: string[], slot: number): string[] {
  if (slot < 0 || slot >= ids.length) return [...ids];
  return ids.filter((_, i) => i !== slot);
}

/** True when a path is production-relative (no `..`, not absolute) — the
 *  renderer-side pre-check before main re-validates via `assetPath`. */
export function isCameraGridSheetPath(rel: unknown): rel is string {
  return isProductionRelative(rel);
}

/** Options for one camera-grid sheet generation. The prompt comes from the
 *  user-editable `cameraGrid` template (Settings → Prompts), and the node's
 *  source image + wired references are read main-side from
 *  `ProductionShot.graphCameraGrid` — neither is passed here. */
export interface CameraGridGenOptions {
  model: string;
  resolution: string;
  params?: GenParams;
  /** The grid geometry to generate (defaults to the node's saved geometry). */
  cols?: number;
  rows?: number;
}

/** One cutout request: crop `rects` out of `sheetPath` into new references.
 *  `rects` and `labels` are aligned 1:1; the renderer decides per-panel vs
 *  single-image before calling. */
export interface CameraGridCutoutRequest {
  productionId: string;
  shotId: string;
  nodeId: string;
  sheetPath: string;
  rects: CameraGridPanel[];
  labels?: string[];
  single?: boolean;
  categoryId?: string;
}

/** The created references plus the saved production (so the renderer applies
 *  the sidebar/reference list in one shot). */
export interface CameraGridCutoutResult {
  refs: CustomRef[];
  production: Production;
}

/** The result of importing a wired image as the camera-grid sheet: the
 *  production-relative path of the copy main wrote into the references
 *  folder and the write timestamp (the merge's sheet-freshness marker). The
 *  renderer then sets `sheetPath` + `gridSource` + `sheetAt` itself, so all
 *  production state stays renderer-owned (main only writes the file). */
export interface CameraGridImportResult {
  sheetPath: string;
  sheetAt: string;
}
