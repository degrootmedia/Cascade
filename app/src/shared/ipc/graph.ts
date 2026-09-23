/**
 * Shot-graph types and tween-keyframe helpers (master plan step 03–05).
 *
 * Domain module of `shared/ipc.ts` (step 06 T1); the barrel re-exports
 * everything here, so `../shared/ipc.js` import paths are unchanged.
 *
 * Nodes and edges are the wiring truth; prompt text and the legacy `graph*`
 * flags are only read to materialize the graph once, then never for wiring.
 */

/** A per-node/per-block model-option bag. Values are CLI-ready strings keyed
 *  by canonical flag (e.g. `{ variant: "sunburst", aspect_ratio: "16:9" }`). */
export type GenParams = Record<string, string>;

/** Step 3 node graph: saved canvas state for one shot's graph, so it reopens
 *  the way the user left it. */
export interface GraphLayout {
  /** Node positions keyed by graph node id (ref/composer/style/brand/output). */
  positions?: Record<string, { x: number; y: number }>;
  /** Node sizes keyed by graph node id (the frame output + reference nodes —
   *  the generation nodes size themselves from their content). */
  sizes?: Record<string, { width: number; height: number }>;
  /** Reference nodes collapsed to a name-only tile, keyed by graph node id. */
  collapsed?: Record<string, boolean>;
  /** Canvas pan/zoom as last left by the user. */
  viewport?: { x: number; y: number; zoom: number };
}

export type GraphNodeKind =
  | "composer"
  | "style"
  | "brand"
  | "imagegen"
  | "videogen"
  | "editgen"
  | "editvideo"
  | "tween"
  | "ref"
  | "output"
  | "videoprompt"
  | "editprompt"
  | "editvideoprompt"
  | "cameraGrid"
  | "upscale";

/** Media flowing over a connection. Declared on the port — never inferred
 *  from a node label or prompt text. */
export type GraphMedia = "image" | "video" | "audio" | "text" | "number";

export interface GraphPort {
  id: string;
  label: string;
  media: GraphMedia;
}

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  pos: { x: number; y: number };
  /** Per-kind payload the graph owns. Step 03 owns topology + positions only,
   *  so this stays minimal (a ref node's display label); prompts, gens, and
   *  params remain on the shot until steps 04–05 move them — no shadow copies. */
  data?: { label?: string };
}

export interface GraphEdge {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export interface Graph {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Set by the one-time flag→graph migration (step 03). */
  migrated?: boolean;
}

/** What feeds a generation node's source input. `imagegen` = the image node's
 *  selected frame, `editgen` = an edit node's selected edit, `ref` = a
 *  reference's artwork. */
export type GraphSource =
  | { kind: "imagegen" }
  | { kind: "editgen"; nodeId: string }
  | { kind: "ref"; refId: string };

/** One panel rect on a camera-grid sheet, in normalized [0..1] sheet
 *  coordinates (row-major). Stored generically for any cols x rows grid. */
export interface CameraGridPanel {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The camera-grid node's state (one per shot). It generates a cols x rows
 *  sheet of camera angles (4x4 / 3x3 / 2x2) from a source image (+ optional
 *  references), then lets the user marquee panels out into standalone
 *  references. Its wiring (source image + reference sockets) lives here rather
 *  than in `GraphNode.data`, which owns topology + positions only. */
export interface CameraGridData {
  /** Production-relative path of the grid sheet image. Absent before the
   *  first generation (the node shows a broken-media state + Regenerate CTA). */
  sheetPath?: string;
  /** ISO timestamp of the last sheet write — a generation (main-side) or a
   *  grid-image import (renderer-side). The save merge uses it to decide which
   *  side's `sheetPath` is newer, so a generation landing concurrently can
   *  never revert a just-imported grid image (and vice versa). */
  sheetAt?: string;
  /** Grid geometry (4x4 / 3x3 / 2x2; also settable to match an imported
   *  grid image). The prompt and the export editor's division follow it. */
  cols: number;
  rows: number;
  /** Panel rects in normalized sheet coordinates, row-major. Optional: when
   *  absent the renderer derives them as cols x rows cells. */
  panels?: CameraGridPanel[];
  /** Labels shown on hover / used to name exported references (e.g. "Front").
   *  Absent entries fall back to "Angle N". */
  panelLabels?: string[];
  /** What feeds the source-image socket (`in-image`). Absent = the shot's
   *  current frame, or text-only when neither exists. */
  source?: GraphSource;
  /** What feeds the grid-image socket (`in-grid`): an already-made grid image
   *  to cut panels out of instead of generating one (the manual fallback when
   *  the auto download fails). When set, `sheetPath` points at a copy of that
   *  image written into the references folder. */
  gridSource?: GraphSource;
  /** Reference ids wired into the reference sockets, in socket order. */
  refIds?: string[];
  /** The node's own model pick (per-node; wins over the media default). */
  model?: string;
  /** The node's own resolution tier. */
  resolution?: string;
  /** Schema-driven advanced params (keyed by canonical flag). Optional. */
  params?: GenParams;
  /** Proportion (0..0.45) each exported panel is shrunk by on every edge, so
   *  the gutters/borders between generated cells are cropped out. */
  inset?: number;
  /** The prompt/model used, for provenance and the regenerate form's seed. */
  generation?: { provider: string; model: string; prompt: string };
}

/** The node-graph upscale node's state (one per shot). A generator with a
 *  source-image input and an image output: it upscales whatever image feeds
 *  its `in-image` socket (falling back to the shot's current frame) through an
 *  upscale-capable model. Its wiring and picks live here rather than in
 *  `GraphNode.data`, which owns topology + positions only. */
export interface UpscaleData {
  /** What feeds the source-image socket (`in-image`). Absent = the shot's
   *  current frame. */
  source?: GraphSource;
  /** The node's own model pick (an upscale-capable id; wins over the media
   *  default). */
  model?: string;
  /** The node's own resolution tier. */
  resolution?: string;
  /** Schema-driven advanced params (keyed by canonical flag). Optional. */
  params?: GenParams;
  /** Stored upscaled outputs (newest first) + the selected index. */
  gens?: GraphGenItem[];
  genIndex?: number;
  /** The provider/model used, for provenance. */
  generation?: { provider: string; model: string };
}

/** One node-graph edit-image node. A shot may hold several and daisy-chain
 *  them (an edit node's output feeds another's source). The list is the source
 *  of truth; the legacy flat `graphEdit*` fields migrate into `edit0`. */
export interface GraphEditNode {
  /** Stable identity within the shot: "edit0", "edit1", …. */
  id: string;
  /** The node's own edit instructions (its `editprompt` node's text). */
  prompt: string;
  /** Stored edits (newest first) + the selected index. */
  gens?: GraphGenItem[];
  genIndex?: number;
  /** What feeds this node's source input. Absent = the shot's current frame. */
  source?: GraphSource;
  /** Whether the style node is plugged into this node's prompt node. */
  styleConnected?: boolean;
  /** The node's own model/resolution picks (per-node, win over the global
   *  media-default; unset falls back to it). */
  model?: string;
  resolution?: string;
  /** Schema-driven advanced/variant params for this edit node (keyed by
   *  canonical flag). Optional/additive. */
  params?: GenParams;
}

/** In-betweener keyframe source sentinels that read a generation node's output
 *  instead of a production reference's artwork. They are stored in
 *  `graphTweenRefIds` (and `TweenBlock.startRefId`/`endRefId`) alongside bare
 *  reference ids — a reference id (base36 timestamp + random suffix, see
 *  `store.newId`) can never equal these node ids, so the two are
 *  unambiguous. The image node is structural and always present; each edit
 *  node is addressed as `editgen:<nodeId>` (the bare `"editgen"` is the legacy
 *  single-node form migrated to `editgen:edit0`). */
export const TWEEN_KEY_IMGGEN = "imagegen";
export const TWEEN_KEY_EDITGEN = "editgen";
export const TWEEN_KEY_EDITGEN_PREFIX = "editgen:";

/** The in-betweener keyframe source id for an edit node. */
export function editNodeKeyframe(nodeId: string): string {
  return `${TWEEN_KEY_EDITGEN_PREFIX}${nodeId}`;
}

/** The edit node id a keyframe source refers to, or null. Handles the legacy
 *  bare `"editgen"` as `"edit0"` so pre-migration wiring keeps resolving. */
export function parseEditNodeKeyframe(id: string): string | null {
  if (id === TWEEN_KEY_EDITGEN) return "edit0";
  return id.startsWith(TWEEN_KEY_EDITGEN_PREFIX) ? id.slice(TWEEN_KEY_EDITGEN_PREFIX.length) : null;
}

/** True when an in-betweener keyframe source id refers to a generation node's
 *  output rather than a production reference. */
export function isTweenGenKeyframe(id: string): boolean {
  return id === TWEEN_KEY_IMGGEN || id === TWEEN_KEY_EDITGEN || id.startsWith(TWEEN_KEY_EDITGEN_PREFIX);
}

/** One stored output of a node-graph generation node. */
export interface GraphGenItem {
  /** Workspace-relative path (boards JPEG for frames, videos file for clips). */
  path: string;
  /** The prompt used for this generation. */
  prompt: string;
  /** The model id used ("auto" when Cascade picked). */
  model: string;
  /** ISO timestamp. */
  at: string;
}

/** One action block on the in-betweener timeline: a start keyframe, an end
 *  keyframe, and the action prompt describing the motion between them. Each
 *  block generates its own clip (start→end interpolation); the selected clips
 *  stitch into the shot's continuous output. History lives on the block so the
 *  per-block dropdown (Keyframes + previous generations) is independent. */
export interface TweenBlock {
  /** Stable identity ("tw0", "tw1", … in keyframe order). */
  id: string;
  /** Keyframe source id of the start keyframe (reference id or a
   *  `TWEEN_KEY_IMGGEN` / `TWEEN_KEY_EDITGEN` sentinel). */
  startRefId: string;
  /** Keyframe source id of the end keyframe (reference id or a
   *  `TWEEN_KEY_IMGGEN` / `TWEEN_KEY_EDITGEN` sentinel). */
  endRefId: string;
  /** Action prompt describing the motion from start to end. */
  prompt: string;
  /** Timeline position of the block start in seconds (1s grid). */
  startSec: number;
  /** Block length in seconds (1–15, 1s grid). */
  durationSec: number;
  /** Generated clips for this block (newest first). */
  gens?: GraphGenItem[];
  /** Selected generation index (0 = newest). Absent = show keyframes. */
  genIndex?: number;
}

/** An OpenArt async image job that outlived the generating call — the wait
 *  timed out or the finished image couldn't be downloaded, but the job keeps
 *  rendering server-side. Kept on the shot so the finished frame can be
 *  reclaimed (recheck + download) instead of paying for a second generation. */
export interface PendingImageGen {
  /** The async job id to re-poll (`openart_creation_get`/`wait`). */
  historyId?: string;
  /** Direct result URL to re-download when the submission returned one
   *  (no historyId) and the first download failed. */
  url?: string;
  /** The prompt this job was submitted with. */
  prompt: string;
  /** The model id used ("auto" when Cascade picked). */
  model: string;
  /** The resolution the job was submitted at — kept so a reclaimed frame can be
   *  billed to the ledger exactly as the original generation would have been. */
  resolution?: string;
  /** The aspect ratio the job was submitted at (same purpose as resolution). */
  aspectRatio?: string;
  /** The quality tier the job was submitted at (same purpose as resolution). */
  quality?: string;
  /** Schema-driven options the job was submitted with (same purpose as
   *  resolution) — lets a reclaimed frame bill exactly like the original. */
  params?: Record<string, string | number | boolean | string[]>;
  /** ISO timestamp of when the job was orphaned. */
  at: string;
}
