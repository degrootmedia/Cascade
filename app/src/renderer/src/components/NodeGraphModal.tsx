/**
 * Storyboard node graph: a visual projection of one shot's stored graph.
 *
 * `shot.graph` (nodes + typed edges) is the wiring truth — edges render from
 * it and connections mutate it. Prompt text stays the generation input until
 * step 05, so connect/disconnect writes both projections from the same event
 * (LEGACY-PROJECTION); generation, history, and prompts-export are untouched.
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  ConnectionLineType,
  Handle,
  NodeResizer,
  Position,
  ReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeProps,
  type OnConnectEnd,
  type OnNodesChange,
  type FinalConnectionState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { TWEEN_KEY_IMGGEN, TWEEN_KEY_EDITGEN, TWEEN_KEY_EDITGEN_PREFIX, modelOnSurface, UPSCALE_UNAVAILABLE_HINT, VIDEO_EDIT_UNAVAILABLE_HINT, videoGenNodeId, videoPromptNodeId, parseVideoGenNode, parseVideoPromptNode, CAMERA_GRID_COLS, CAMERA_GRID_ROWS, CAMERA_GRID_SIZES, cameraGridSizeKey, resolveCameraGridPanels, resolvePanelLabels, gridRectFromPoints, touchedPanelIndices, unionGridRects, insetGridRect, normalizeCameraGridData, placeCameraGridRef, removeCameraGridRefAt, type CameraGridData, type CameraGridPanel, type CameraGridGenOptions, type CameraGridCutoutRequest, type CameraGridImportResult, type GraphSource, type UpscaleData, type ImageGenAspectRatio, type CliModelSchema, type GenParams, type Graph, type GraphEditNode, type GraphGenItem, type GraphVideoNode, type GraphLayout, type OpenArtModelChoice, type Production, type ProductionShot, type ProductionStyle, type TweenBlock, type VideoModelOptions } from "../../../shared/ipc.js";
import { ModelOptionsForm, pruneModelOptionValues, type ModelOptionValues } from "./ModelOptionsForm.js";
import { closestResolution } from "./resolution.js";
import { addRefTag, composePromptBoxes, parsePromptBoxes, refTagNames, removeRefTag, replaceRefTagAt } from "../../../shared/prompt-grammar.js";
import { TriplePrompt } from "./TriplePrompt.js";
import { TweenTimelineModal, deriveTweenBlocksClient, filterTweenModels } from "./TweenTimelineModal.js";
import { usePersistedCollapsed, usePersistedNumber } from "./production/persisted-state.js";
import { refThumbUrl } from "./production/thumb-url.js";
import { getMediaDefault, rememberMediaDefault } from "./production/media-defaults.js";
import { getPromptTemplate } from "./production/prompt-templates.js";
import { openSettings } from "./settings/open-settings.js";
import { OpenInSuiteButton } from "./common/OpenInSuiteButton.js";
import { openImageSuite } from "../features/suite/suite-handoff.js";
import { costAspect, isQuotableCostModel } from "./production/generation-cost.js";
import { GenerationCostSuffix } from "./production/generation-cost-label.js";
import { seedModelOptionValues } from "./production/model-param-defaults.js";
import { useImageContextMenu } from "./image-context-menu.js";
import { graphEdgesToFlow, promptSockets } from "./graphFlow.js";
import { materializeGraph, videoNodesFor } from "../../../shared/graph/materialize.js";
import { normalizeGraph } from "../../../shared/graph/normalize.js";
import { addGraphNode, applyCameraGridRefs, applyConnection, applyTweenKeys, canonicalNodeId, connectionToEdge, connectTweenKey, ensurePromptPipe, graphEdgesForDetach, nodeKindForId, removeGraphEdge, removeGraphNode, setStyleEdge, tweenKeyForSource, tweenKeyToNode, wireComposerRefs } from "../../../shared/graph/connect.js";
import { canConnect, portDecl, refOutputMedia, REF_SOCKET_RE, TWEEN_SOCKET_RE } from "../../../shared/graph/ports.js";
import { isBrandAttached, renderShotPrompt, stripSharedSections, styleEdgePresent } from "../../../shared/graph/render.js";
import { GenerationMenu, useGenerationMenu } from "./generation-menu.js";
import { EditIcon, EditVideoIcon, EyeIcon, EyeOffIcon, FilmStripIcon, InbetweenIcon, MagicIcon, MagnifyIcon, RegenerateIcon, XIcon } from "./icons.js";

function isTagReorder(a: string, b: string): boolean {
  const ra = refTagNames(a);
  const rb = refTagNames(b);
  if (ra.length !== rb.length || ra.length === 0) return false;
  const sa = [...ra].sort().join("|");
  const sb = [...rb].sort().join("|");
  if (sa !== sb) return false;
  return ra.join("|") !== rb.join("|");
}

/** cascade-media URL for any workspace-relative asset in the production. */
function graphMediaUrl(prodId: string, rel: string): string {
  return `cascade-media://${prodId}/${encodeURIComponent(rel)}`;
}

/** React Flow node ids for the per-edit-node pair. The suffix is the edit
 *  node's stable id ("edit0"), which is also the tween keyframe sentinel
 *  suffix (`editgen:edit0`). */
const EDITGEN_NODE_PREFIX = "editgen:";
const EDITPROMPT_NODE_PREFIX = "editprompt:";
function editGenNodeId(nodeId: string): string { return `${EDITGEN_NODE_PREFIX}${nodeId}`; }
function editPromptNodeId(nodeId: string): string { return `${EDITPROMPT_NODE_PREFIX}${nodeId}`; }
/** The edit node id a canvas editgen node refers to (legacy "editgen" = edit0). */
function parseEditGenNode(id: string): string | null {
  if (id === "editgen") return "edit0";
  return id.startsWith(EDITGEN_NODE_PREFIX) ? id.slice(EDITGEN_NODE_PREFIX.length) : null;
}
/** The next unused edit node id in a shot's list ("edit0", "edit1", …). */
function nextEditNodeId(nodes: GraphEditNode[]): string {
  let i = 0;
  while (nodes.some((n) => n.id === `edit${i}`)) i++;
  return `edit${i}`;
}

/** The next unused video node id in a shot's list ("vid0", "vid1", …). */
function nextVideoNodeId(nodes: GraphVideoNode[]): string {
  let i = 0;
  while (nodes.some((n) => n.id === `vid${i}`)) i++;
  return `vid${i}`;
}

/** Human ordinal for a video node ("vid0" → "#1") so multiple nodes on the
 *  canvas are distinguishable. Empty for an unexpected id. */
function videoNodeLabel(nodeId: string): string {
  const m = /^vid(\d+)$/.exec(nodeId);
  return m ? ` #${Number(m[1]) + 1}` : "";
}

/** The draft-applier registry key for a video node's prompt. The first node
 *  keeps the historical `"video"` key; additional nodes are namespaced. */
function videoApplierKey(nodeId: string): string {
  return nodeId === "vid0" ? "video" : `video:${nodeId}`;
}

/** The selected stored take's path for a generation node id, or null when the
 *  node holds no generation (nothing to save as a reference). */
function selectedGenerationRel(shot: ProductionShot, nodeId: string): string | null {
  if (nodeId === "imagegen") return shot.graphImageGens?.[shot.graphImageGenIndex ?? 0]?.path ?? null;
  const vidId = parseVideoGenNode(nodeId);
  if (vidId) {
    const node = (shot.graphVideoNodes ?? []).find((n) => n.id === vidId);
    return node?.gens?.[node.genIndex ?? 0]?.path ?? null;
  }
  if (nodeId === "editvideo") return shot.graphEditVideoGens?.[shot.graphEditVideoGenIndex ?? 0]?.path ?? null;
  const editId = parseEditGenNode(nodeId);
  if (editId) {
    const node = (shot.graphEditNodes ?? []).find((n) => n.id === editId);
    return node?.gens?.[node.genIndex ?? 0]?.path ?? null;
  }
  return null;
}

/** True for a prompt node id (composer / video / edit-video / an edit node). */
function isPromptNodeId(nodeId: string): boolean {
  return nodeId === "composer" || nodeId === "videoprompt" || nodeId.startsWith("videoprompt:") || nodeId === "editvideoprompt" || nodeId === "editprompt" || nodeId.startsWith(EDITPROMPT_NODE_PREFIX);
}

/** True for a prompt node's reference socket (a numbered slot or the open one). */
function isRefSocketHandle(handle: string | null | undefined): boolean {
  return handle === "in-ref-open" || /^in-ref-\d+$/.test(handle ?? "");
}

/** Human ordinal for an edit node ("edit0" → "#1") so multiple nodes on the
 *  canvas are distinguishable. Empty for an unexpected id. */
function editNodeLabel(nodeId: string): string {
  const m = /^edit(\d+)$/.exec(nodeId);
  return m ? `#${Number(m[1]) + 1}` : "";
}

/** True when `ancestorId` is reachable from `nodeId`'s source chain (a cycle
 *  would form if `nodeId` were fed by `ancestorId`). */
function editNodeDependsOnClient(shot: ProductionShot, nodeId: string, ancestorId: string): boolean {
  const nodes = shot.graphEditNodes ?? [];
  const seen = new Set<string>();
  let cur = nodes.find((n) => n.id === nodeId);
  while (cur && cur.source?.kind === "editgen" && !seen.has(cur.id)) {
    if (cur.source.nodeId === ancestorId) return true;
    seen.add(cur.id);
    const parentId = cur.source.nodeId;
    cur = nodes.find((n) => n.id === parentId);
  }
  return false;
}

/** The frame output and the reference nodes are manually resizable — their
 *  dimensions persist in `GraphLayout.sizes` so a resized node survives closing
 *  and reopening the graph. The generation nodes (image / edit-image / video /
 *  edit-video) size themselves from their content instead. */
const RESIZABLE_NODE_IDS = new Set(["output"]);
function isResizableNodeId(id: string): boolean {
  return RESIZABLE_NODE_IDS.has(id) || id.startsWith("ref:");
}

/** Saved-size style for a resizable node, falling back to `defaultWidth`. */
function sizeStyle(layout: GraphLayout | undefined, id: string, defaultWidth: number): { width: number; height?: number } {
  const saved = layout?.sizes?.[id];
  return saved ? { width: saved.width, height: saved.height } : { width: defaultWidth };
}

/** Reference-node size. A collapsed ref shows only the name + a small thumb, so
 *  it takes a fixed narrow width — its expanded width/height stay in
 *  `GraphLayout.sizes` and are restored on expand. */
const REF_DEFAULT_WIDTH = 236;
const REF_COLLAPSED_WIDTH = 170;
function refSizeStyle(layout: GraphLayout | undefined, id: string, collapsed: boolean): { width: number; height?: number } {
  if (collapsed) return { width: REF_COLLAPSED_WIDTH };
  const saved = layout?.sizes?.[id];
  return saved ? { width: saved.width, height: saved.height } : { width: REF_DEFAULT_WIDTH };
}

/** Fixed-width style for the content-sized generation nodes (height comes
 *  from the content — no saved size is applied). */
function fixedWidth(defaultWidth: number): { width: number } {
  return { width: defaultWidth };
}

/** Split a `cascade-media://` URL into the production id + workspace-relative
 *  path main needs to resolve the full-res file (e.g. "Edit externally").
 *  Returns null for inline data URLs and anything else. */
function parseGraphMediaUrl(url: string): { productionId: string; relPath: string } | null {
  if (!url.startsWith("cascade-media://")) return null;
  try {
    const u = new URL(url);
    const relPath = decodeURIComponent(u.pathname).replace(/^\/+/, "");
    return u.hostname && relPath ? { productionId: u.hostname, relPath } : null;
  } catch {
    return null;
  }
}

/** Thumbnail variant of a reference's artwork URL (one home:
 *  `production/thumb-url.ts`). Canvas reference nodes render the full-res
 *  `artwork` directly (the graph is a working surface, not a list). */
export { refThumbUrl };

/** Per-model/per-mode cache for video form options — the MCP form lookup is
 *  slow, and nodes re-render often, so fetch each combination once. */
const videoOptionsCache = new Map<string, VideoModelOptions | null>();

/** Per-model full option schema (the Advanced panel), fetched once. */
const modelSchemaCache = new Map<string, CliModelSchema | null>();

/** Minimal reference shape (structurally identical to PromptReference). */
export interface GraphRef {
  id: string;
  name: string;
  artwork: string;
  media?: "video" | "audio";
  /** Workspace-relative media path (video/audio refs), for cascade-media URLs. */
  mediaPath?: string;
}

/* ------------------------------------------------------------------ */
/* Node data shapes                                                    */
/* ------------------------------------------------------------------ */

interface RefData extends Record<string, unknown> {
  name: string;
  /** Full-resolution artwork (cascade-media URL or inline data URL) — the node
   *  tile, the zoom lightbox, and the context menu all use it. */
  artwork: string;
  /** Playable cascade-media URL for video references. */
  mediaUrl?: string;
  /** false = tag present in the prompt but no matching reference (dangling). */
  missing?: boolean;
  tagged: boolean;
  /** Wired into a generation input rather than a prompt reference socket —
   *  source frame/clip, tween keyframe, or the output feed. Such a node is in
   *  use even when no prompt cites it, so it renders opaque (not the idle
   *  "available" tint). */
  sourced?: boolean;
  /** Real reference id (absent for dangling tags) — for the rename box. */
  refId?: string;
  /** Collapsed to a name-only tile (the image is hidden). */
  collapsed?: boolean;
  /** Toggle the collapsed state (persisted in the graph layout). */
  onToggleCollapse?: (nodeId: string, collapsed: boolean) => void;
  /** Rename the underlying reference; main rewrites its `@[name]` tags across
   *  every prompt store atomically (same as the Design page). */
  onRename?: (refId: string, name: string) => void;
  /** Open the reference image/video in a lightbox (double-click). */
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string) => void;
}
type RefFlowNode = Node<RefData, "ref">;

/** A prompt node's live-draft handle. Graph-side prompt mutations (connect /
 *  disconnect / toggle a reference, style/brand paragraph ops) are applied to
 *  the node's LOCAL draft when it holds one, so a focused composer can never
 *  overwrite them on blur — and the emitted prompt (what gets saved and what
 *  generation resolves references from) always carries the change. */
export interface PromptDraftApplier {
  /** The node's current draft (== the synced value when not drafting). */
  get: () => string;
  /** Apply a text transform to the draft and emit the result upstream. */
  apply: (fn: (t: string) => string) => void;
}

interface ComposerData extends Record<string, unknown> {
  value: string;
  /** One dedicated input-socket id per connected reference, in prompt order. */
  refHandles: string[];
  /** Always-open reference socket so new nodes can always be attached. */
  openHandleId: string;
  /** Whether the brand section currently exists (drives the Brand box). */
  includeBrand: boolean;
  /** Magic Prompt state — drives the rainbow border + forces a full resync
   *  on toggle (content switches wholesale between original and magic). */
  magicActive?: boolean;
  onChange: (value: string) => void;
  registerApplier: (applier: PromptDraftApplier | undefined) => void;
}
type ComposerFlowNode = Node<ComposerData, "composer">;

interface StyleData extends Record<string, unknown> {
  styles: ProductionStyle[];
  value: string;
  onChange: (style: string) => void;
}
type StyleFlowNode = Node<StyleData, "style">;

interface BrandData extends Record<string, unknown> {
  // Freely pluggable source — no toggle; plugging adds Brand paragraph to the target prompt
}
type BrandFlowNode = Node<BrandData, "brand">;

interface OutputData extends Record<string, unknown> {
  shotNumber: string;
  /** What the output currently shows: the bound node's selected generation,
   *  or the shot's classic artwork when nothing is piped in. */
  previewUrl: string | null;
  previewKind: "image" | "video" | null;
  bound: boolean;
}
type OutputFlowNode = Node<OutputData, "frame">;

interface ImageGenData extends Record<string, unknown> {
  models: OpenArtModelChoice[];
  /** Defaults from the production's OpenArt config (top-of-page pickers). */
  defaultModel: string;
  defaultResolution: string;
  /** Production quality tier — image submits bill it (the provider reads it
   *  off the production), so the quote must price it too. */
  productionQuality?: string;
  /** This shot's saved advanced/variant params (schema-driven). */
  savedParams?: GenParams;
  /** Every stored generation (newest first) as media URLs + stored path. */
  items: { url: string; prompt: string; path: string }[];
  selected: number;
  /** True while this shot's image generation runs (lifted to the workspace so
   *  the "Generating…" label survives closing/reopening the graph). */
  busy: boolean;
  onGenerate: (model: string, resolution: string, params?: GenParams) => Promise<void>;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
  /** Right-click a take → delete it (blocked while it feeds a pipe/output). */
  onDeleteGen: (rel: string) => void;
  /** Right-click a take → copy it into the production as a new reference. */
  onSaveAsRef: (rel: string) => void;
  /** Right-click a take → seed it as the Image Suite's edit source. */
  onEditInSuite: (rel: string) => void;
  /** The model's full option schema (Advanced panel). */
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  /** Persists a per-shot advanced-params change onto the shot. */
  onSaveFields: (patch: Partial<ProductionShot>) => void;
  /** Open a generation in the lightbox (same zoom as reference nodes). */
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string) => void;
}
type ImageGenFlowNode = Node<ImageGenData, "imagegen">;

interface VideoGenData extends Record<string, unknown> {
  /** Stable id of the owning `GraphVideoNode` ("vid0", …). */
  nodeId: string;
  /** Human ordinal shown in the title ("#1"); empty for the first node. */
  label: string;
  models: OpenArtModelChoice[];
  /** This node's saved video-gen picks (win over the global media-default,
   *  which only seeds nodes that never picked). */
  savedModel?: string;
  savedResolution?: string;
  savedDurationSec?: number;
  /** This node's saved advanced/variant params (schema-driven). */
  savedParams?: GenParams;
  items: { url: string; prompt: string; path: string }[];
  selected: number;
  hasImageSource: boolean;
  /** Lifted in-flight flag (see ImageGenData.busy). */
  busy: boolean;
  /** A video job outlived its wait — show a pending badge + Fetch. */
  pending: boolean;
  /** Re-poll the orphaned video job and download the clip when ready. */
  onFetch: () => Promise<void>;
  onGenerate: (nodeId: string, model: string, resolution: string, durationSec: number, params?: GenParams) => Promise<void>;
  onSelect: (nodeId: string, index: number) => void;
  onCycle: (nodeId: string, dir: 1 | -1) => void;
  /** Right-click a take → delete it (blocked while it feeds a pipe/output). */
  onDeleteGen: (rel: string) => void;
  /** Right-click a take → copy it into the production as a new reference. */
  onSaveAsRef: (rel: string) => void;
  /** Right-click a take → seed it as the Image Suite's edit source. */
  onEditInSuite: (rel: string) => void;
  onModelOptions: (model: string, withImage: boolean) => Promise<VideoModelOptions | null>;
  /** The model's full option schema (for the Advanced panel). */
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  /** Persists a per-node model/resolution/length change onto the node. */
  onSaveFields: (nodeId: string, patch: Partial<GraphVideoNode>) => void;
  /** Open a generation in the lightbox (same zoom as reference nodes). */
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string) => void;
}
type VideoGenFlowNode = Node<VideoGenData, "videogen">;

interface TweenData extends Record<string, unknown> {
  /** Ordered keyframe source ids wired into the node's sockets (2–5): bare
   *  reference ids or the image/edit node sentinels. */
  refIds: string[];
  /** Keyframe display for socket labels (id/name/artwork). */
  keyframes: { id: string; name: string; artwork: string }[];
  blockCount: number;
  /** Blocks with a selected clip. */
  readyBlocks: number;
  stitched: boolean;
  reencoded: boolean;
  onOpenTimeline: () => void;
}
type TweenFlowNode = Node<TweenData, "tween">;

/** Edit-video node: a video-edit model + a mandatory source clip + optional
 *  image/video references. Self-contained (in-node source/reference pickers),
 *  so it needs no socket wiring. */
interface EditVideoData extends Record<string, unknown> {
  models: OpenArtModelChoice[];
  savedModel?: string;
  savedParams?: GenParams;
  savedPrompt?: string;
  /** Label of the clip wired into the source socket (null = not wired;
   *  generation then falls back to the shot's own video). */
  sourceLabel: string | null;
  items: { url: string; prompt: string; path: string }[];
  selected: number;
  busy: boolean;
  piped: boolean;
  /** A video-edit job outlived its wait — show a pending badge + Fetch. */
  pending: boolean;
  onFetch: () => Promise<void>;
  onGenerate: (model: string, prompt: string, params: GenParams) => Promise<void>;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
  /** Right-click a take → delete it (blocked while it feeds a pipe/output). */
  onDeleteGen: (rel: string) => void;
  /** Right-click a take → copy it into the production as a new reference. */
  onSaveAsRef: (rel: string) => void;
  /** Right-click a take → seed it as the Image Suite's edit source. */
  onEditInSuite: (rel: string) => void;
  onSave: (patch: Partial<ProductionShot>) => void;
  onPipeToOutput: () => void;
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  /** Open a generation in the lightbox (same zoom as reference nodes). */
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string) => void;
}
type EditVideoFlowNode = Node<EditVideoData, "editvideo">;

/** Keyframe display entries for the in-betweener node + timeline: a reference
 *  id shows the reference's artwork; a generation-node sentinel shows that
 *  node's selected output (the image node's selected frame, or the edit node's
 *  selected edit). A source with nothing resolvable yet contributes no entry
 *  (the socket stays blank, like a wired-but-artwork-less reference). */
function tweenKeyframesFor(shot: ProductionShot, prodId: string, ids: string[], byRefId: Map<string, GraphRef>): { id: string; name: string; artwork: string }[] {
  const entry = (id: string, name: string, artwork: string) => ({ id, name, artwork: refThumbUrl(artwork) });
  return ids.flatMap((id) => {
    if (id === TWEEN_KEY_IMGGEN) {
      const g = shot.graphImageGens?.[shot.graphImageGenIndex ?? 0];
      return g?.path ? [entry(id, "Image-gen frame", graphMediaUrl(prodId, g.path))] : [];
    }
    const editNodeId = id === TWEEN_KEY_EDITGEN ? "edit0" : id.startsWith(TWEEN_KEY_EDITGEN_PREFIX) ? id.slice(TWEEN_KEY_EDITGEN_PREFIX.length) : null;
    if (editNodeId) {
      const node = shot.graphEditNodes?.find((n) => n.id === editNodeId);
      const g = node?.gens?.[node.genIndex ?? 0];
      return g?.path ? [entry(id, "Edit frame", graphMediaUrl(prodId, g.path))] : [];
    }
    const r = byRefId.get(id);
    return r && r.artwork ? [entry(id, r.name, r.artwork)] : [];
  });
}


interface EditGenData extends Record<string, unknown> {
  nodeId: string;
  models: OpenArtModelChoice[];
  /** Default from the production's OpenArt config (matches the image node). */
  defaultResolution: string;
  /** This node's own saved model/resolution picks (win over the global
   *  media-default, which only seeds nodes that never picked). */
  savedModel?: string;
  savedResolution?: string;
  /** Production quality tier (see ImageGenData.productionQuality). */
  productionQuality?: string;
  /** This node's saved advanced/variant params (schema-driven). */
  savedParams?: GenParams;
  items: { url: string; prompt: string; path: string }[];
  selected: number;
    /** Where the source image comes from (drives the hint + the onGenerate path). */
    sourceHint: string;
    /** Production id (for the "Open in Suite" handoff). */
    productionId: string;
    /** This node's prompt, mirrored for the suite handoff. */
    prompt: string;
    /** Resolved edit source: a reference id or a production-relative frame path. */
    sourceRefId?: string;
    sourcePath?: string;
    /** Lifted in-flight flag (see ImageGenData.busy). */
    busy: boolean;
  onGenerate: (nodeId: string, model: string, resolution: string, params?: GenParams) => Promise<void>;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
  /** Right-click a take → delete it (blocked while it feeds a pipe/output). */
  onDeleteGen: (rel: string) => void;
  /** Right-click a take → copy it into the production as a new reference. */
  onSaveAsRef: (rel: string) => void;
  /** Right-click a take → seed it as the Image Suite's edit source. */
  onEditInSuite: (rel: string) => void;
  /** Persists a per-node model/resolution change onto this edit node. */
  onSave: (patch: Partial<GraphEditNode>) => void;
  /** The model's full option schema (Advanced panel). */
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  /** Open a generation in the lightbox (same zoom as reference nodes). */
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string) => void;
}
type EditGenFlowNode = Node<EditGenData, "editgen">;

interface VideoPromptData extends Record<string, unknown> {
  /** Stable id of the owning `GraphVideoNode`. */
  nodeId: string;
  /** The motion prompt for one video node (`GraphVideoNode.prompt`). */
  value: string;
  refHandles: string[];
  openHandleId: string;
  includeBrand: boolean;
  onChange: (nodeId: string, text: string) => void;
  registerApplier: (applier: PromptDraftApplier | undefined) => void;
}
type VideoPromptFlowNode = Node<VideoPromptData, "videoprompt">;

interface EditPromptData extends Record<string, unknown> {
  nodeId: string;
  /** The edit instructions for one edit node (`GraphEditNode.prompt`). */
  value: string;
  refHandles: string[];
  openHandleId: string;
  includeBrand: boolean;
  onChange: (nodeId: string, text: string) => void;
  registerApplier: (applier: PromptDraftApplier | undefined) => void;
}
type EditPromptFlowNode = Node<EditPromptData, "editprompt">;

interface EditVideoPromptData extends Record<string, unknown> {
  /** The edit instructions for the edit-video node (`shot.graphEditVideoPrompt`). */
  value: string;
  refHandles: string[];
  openHandleId: string;
  includeBrand: boolean;
  onChange: (text: string) => void;
  registerApplier: (applier: PromptDraftApplier | undefined) => void;
}
type EditVideoPromptFlowNode = Node<EditVideoPromptData, "editvideoprompt">;

/** Camera-grid generator node. A source image plus reference sockets feed a
 *  cols x rows sheet generation (4x4 / 3x3 / 2x2); the node marquees panels out
 *  into references. Geometry/labels/wiring come from the shot's
 *  `graphCameraGrid`. */
interface CameraGridNodeData extends Record<string, unknown> {
  /** cascade-media URL of the grid sheet (null before the first generation). */
  sheetUrl: string | null;
  /** Production-relative sheet path (the cutout request's source). */
  sheetPath?: string;
  cols: number;
  rows: number;
  /** Panel rects in normalized sheet coordinates, row-major. */
  panels: CameraGridPanel[];
  /** Per-panel labels (defaults "Angle N"), used to name exported references. */
  panelLabels: string[];
  /** Provenance + the Generate form's seed. */
  generation?: { provider: string; model: string; prompt: string };
  /** Image models offered for the sheet (the `image:generate` surface pool). */
  models: OpenArtModelChoice[];
  /** The node's saved picks, seeded into (and persisted from) the inline form. */
  savedModel?: string;
  savedResolution?: string;
  savedParams?: GenParams;
  defaultModel: string;
  defaultResolution: string;
  productionQuality?: string;
  /** Label of the wired source image (null = the shot's current frame). */
  sourceLabel: string | null;
  /** Label of the wired grid image (null = none; the sheet was generated). */
  gridSourceLabel: string | null;
  /** Wired reference ids, in socket order. */
  refIds: string[];
  /** Open the full-res panel editor popup (the node itself only shows a thumbnail). */
  onOpenEditor: () => void;
  /** Persist a patch onto `ProductionShot.graphCameraGrid`. */
  onSave: (patch: Partial<CameraGridData>) => void;
  /** Generate (or regenerate) the sheet with the node's picks. */
  onGenerate: (opts: CameraGridGenOptions) => Promise<void>;
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string) => void;
}
type CameraGridFlowNode = Node<CameraGridNodeData, "cameraGrid">;

/** Upscale generator node: one source image in, one upscaled image out. The
 *  source/socket wiring and the picks live on the shot's `graphUpscale`; the
 *  node submits through the shared upscale path (no prompt). */
interface UpscaleNodeData extends Record<string, unknown> {
  /** Upscale-capable models offered (the `image:upscale` capability list). */
  models: OpenArtModelChoice[];
  /** The node's saved picks, seeded into (and persisted from) the inline form. */
  savedModel?: string;
  savedResolution?: string;
  savedParams?: GenParams;
  defaultModel: string;
  defaultResolution: string;
  productionQuality?: string;
  /** Stored upscaled outputs (newest first) + the selected index. */
  items: { url: string; prompt: string; path: string }[];
  selected: number;
  /** Label of the wired source image (null = the shot's current frame). */
  sourceHint: string;
  /** Resolved source (a reference id or a production-relative frame path). */
  sourceRefId?: string;
  sourcePath?: string;
  /** Production id (for the "Open in Suite" handoff). */
  productionId: string;
  onGenerate: (model: string, resolution: string, params?: GenParams) => Promise<void>;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
  onDeleteGen: (rel: string) => void;
  onSaveAsRef: (rel: string) => void;
  onEditInSuite: (rel: string) => void;
  onSave: (patch: Partial<UpscaleData>) => void;
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string) => void;
}
type UpscaleFlowNode = Node<UpscaleNodeData, "upscale">;

type GraphNode = RefFlowNode | ComposerFlowNode | StyleFlowNode | BrandFlowNode | OutputFlowNode | ImageGenFlowNode | VideoGenFlowNode | TweenFlowNode | EditVideoFlowNode | EditGenFlowNode | VideoPromptFlowNode | EditPromptFlowNode | EditVideoPromptFlowNode | CameraGridFlowNode | UpscaleFlowNode;

/* ------------------------------------------------------------------ */
/* Custom node views                                                   */
/* ------------------------------------------------------------------ */

const RefNodeView = memo(function RefNodeView({ id, data, selected }: NodeProps<RefFlowNode>) {
  // Disk-backed artwork is a cascade-media URL: hand main the production id +
  // relative path so "Edit externally" resolves the full-res file. Legacy
  // inline artwork has no path and rides the dataUrl branch. Passing the
  // cascade-media URL as a dataUrl (as before) made main try to decode it as a
  // data URL and fail.
  const mediaRef = data.artwork ? parseGraphMediaUrl(data.artwork) : null;
  const extMenu = useImageContextMenu({
    src: data.artwork || undefined,
    productionId: mediaRef?.productionId,
    relPath: mediaRef?.relPath,
    dataUrl: mediaRef ? undefined : (data.artwork || undefined),
  });
  // The name is a local draft committed once (blur/Enter): main rewrites the
  // reference's `@[name]` tags across every prompt store in one atomic op, so a
  // half-typed intermediate would break the graph's tag matching.
  const [nameDraft, setNameDraft] = useState(data.name);
  useEffect(() => { setNameDraft(data.name); }, [data.name]);
  const commitRename = useCallback(() => {
    const next = nameDraft.trim();
    if (next && data.refId && data.onRename && next !== data.name) data.onRename(data.refId, next);
    else setNameDraft(data.name);
  }, [nameDraft, data.refId, data.onRename, data.name]);
  const renameable = !data.missing && !!data.refId && !!data.onRename;
  const collapsed = data.collapsed === true;
  // The reference node is placed/collapsed dynamically and its output handle
  // rides the right edge (which moves with the tile width). React Flow only
  // registers a node's handles once it has measured the node, and a
  // just-placed tile can be dragged from before that measurement lands — the
  // first connection then silently does nothing. Re-measure on mount and on
  // every geometry change, exactly like the generator/prompt nodes do.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, collapsed, updateNodeInternals]);
  const zoomable = !!(data.artwork || data.mediaUrl);
  const openZoom = useCallback(() => {
    if (data.media === "video" && data.mediaUrl) data.onZoom(data.name, data.mediaUrl, "video");
    else if (data.artwork) data.onZoom(data.name, data.artwork);
  }, [data]);
  const zoom = useCallback((e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    openZoom();
  }, [openZoom]);
  const mediaEl = (src: string) => data.artwork
    ? <img src={src} alt={data.name} draggable={false} loading="lazy" decoding="async" onContextMenu={extMenu.onContextMenu} />
    : data.media === "video" && data.mediaUrl
      ? <video className="prod-graph-ref-video" src={data.mediaUrl} muted loop playsInline preload="metadata" onMouseEnter={(e) => { try { e.currentTarget.play(); } catch {} }} onMouseLeave={(e) => { try { e.currentTarget.pause(); } catch {} }} draggable={false} />
      : data.media
        ? <div className="prod-graph-ref-blank" title={data.media === "audio" ? "Audio reference" : "Video reference"}>{data.media === "audio" ? "♪" : "▶"}</div>
        : <div className="prod-graph-ref-blank" title="Reference has no image">?</div>;
  const nameEl = renameable
    ? <input
        className="prod-graph-ref-name prod-ref-edit-name nodrag"
        value={nameDraft}
        title={`Rename @[${data.name}]`}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      />
    : <span className="prod-graph-ref-name" title={data.missing ? "No reference with this name exists (anymore)" : `Reference @[${data.name}]`}>@[{data.name}]</span>;
  const zoomTitle = zoomable ? "Double-click to view larger" : undefined;
  /** Full-res zoom affordance over the artwork (images and videos). */
  const zoomButton = zoomable && (
    <button
      className="prod-graph-ref-zoom prod-graph-gen-zoom nodrag"
      title="View larger"
      onClick={openZoom}
    >
      <MagnifyIcon size={9} />
    </button>
  );
  const eyeButton = (
    <button
      className="prod-graph-ref-eye nodrag"
      title={collapsed ? "Expand — show the image" : "Collapse — hide the image"}
      onClick={() => data.onToggleCollapse?.(id, !collapsed)}
    >
      {collapsed ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
    </button>
  );
  return (
    <>
      <NodeResizer isVisible={selected && !collapsed} minWidth={150} minHeight={120} lineClassName="prod-graph-resize-line" handleClassName="prod-graph-resize-handle" />
      <div className={"prod-graph-node prod-graph-ref" + (data.tagged || data.sourced ? "" : " avail") + (data.missing ? " missing" : "") + (collapsed ? " collapsed" : "")}>
        <Handle type="source" position={Position.Right} className="socket-ref" />
        {collapsed
          ? <div className="prod-graph-ref-collapsed">
              <div className="prod-graph-ref-collapsed-info">
                <div className="prod-graph-ref-head">{eyeButton}</div>
                {nameEl}
              </div>
              <div className="prod-graph-ref-thumb" onDoubleClick={zoom} title={zoomTitle}>
                {mediaEl(refThumbUrl(data.artwork))}
                {zoomButton}
              </div>
            </div>
          : <>
              <div className="prod-graph-ref-head">{eyeButton}</div>
              <div className="prod-graph-ref-media" onDoubleClick={zoom} title={zoomTitle}>
                {mediaEl(data.artwork)}
                {zoomButton}
              </div>
              {nameEl}
            </>}
      </div>
    </>
  );
});

const ComposerNodeView = memo(function ComposerNodeView({ id, data }: NodeProps<ComposerFlowNode>) {
  // All inputs live on the left edge: style at top, one socket per connected
  // reference (plus one always-open socket) in the middle, brand at the
  // bottom — each named + color-coded by the input it accepts. Occupied
  // sockets are not connectable: new links always land on the open socket.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    // Socket positions are percentage-offset styles — when the count changes
    // they move without the node resizing, so force a bounds re-measure.
    updateNodeInternals(id);
  }, [id, data.refHandles.length, updateNodeInternals]);
  // The prompt text is now a local draft while this node holds focus.
  // Updating the parent (`focusedPrompt` + side panel + prod) on every
  // keystroke re-renders the whole workspace, churns `buildDerived` with a
  // fresh `references` array, and `setNodes` remounts the composer — the
  // purple focus ring vanishes every other keystroke. Local draft + sync on
  // blur/close keeps the side panel stable and the caret put.
  const [localValue, setLocalValue] = useState(data.value);
  const emitted = useRef<Set<string>>(new Set([data.value]));
  const rootRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(localValue);
  const dataRef = useRef(data);
  const prevMagicRef = useRef(data.magicActive);
  useEffect(() => { draftRef.current = localValue; }, [localValue]);
  useEffect(() => { dataRef.current = data; }, [data]);
  const syncToParent = () => {
    const latest = draftRef.current;
    const cur = dataRef.current.value;
    if (latest !== cur) {
      emitted.current.add(latest);
      if (emitted.current.size > 100) emitted.current.clear();
      dataRef.current.onChange(latest);
    }
  };
  const handleBlur = () => {
    setTimeout(() => {
      if (!rootRef.current?.contains(document.activeElement)) syncToParent();
    }, 0);
  };
  // Magic toggle switches the whole content (original <-> magic). A focused
  // composer would otherwise keep its local content draft and silently undo
  // the toggle on blur — force a full resync so both views mirror each other.
  useEffect(() => {
    if (prevMagicRef.current !== data.magicActive) {
      prevMagicRef.current = data.magicActive;
      emitted.current.clear();
      emitted.current.add(data.value);
      setLocalValue(data.value);
      draftRef.current = data.value;
    }
  }, [data.magicActive, data.value]);
  useEffect(() => {
    if (emitted.current.has(data.value)) return;
    const active = document.activeElement as HTMLElement | null;
    const isFocused = !!rootRef.current && !!active && rootRef.current.contains(active);
    if (isFocused) {
      // While the composer is focused, keep the focused box authoritative
      // but still allow the other boxes (style/brand) to follow external
      // changes. This implements the “separate logical sections” rule:
      // style, content, brand are independent and only combined at
      // persistence / MCP submission.
      const incoming = parsePromptBoxes(data.value);
      const current = parsePromptBoxes(localValue);
      const contentEl = rootRef.current?.querySelector(".prompt-content-editor") as HTMLElement | null;
      const isContentFocused = !!contentEl && !!active && (contentEl === active || contentEl.contains(active));
      const activeIsStyle = !!active && active.tagName === "TEXTAREA" && (active as HTMLTextAreaElement).placeholder.includes("Visual style");
      const activeIsBrand = !!active && active.tagName === "TEXTAREA" && (active as HTMLTextAreaElement).placeholder.includes("Palette");
      let next: string | null = null;
      if (isContentFocused) {
        // Preserve local content (including tag positions), take incoming style/brand
        if (incoming.style !== current.style || incoming.brand !== current.brand) {
          const merged = { ...current, style: incoming.style, brand: incoming.brand };
          next = composePromptBoxes(merged);
        }
      } else if (activeIsStyle) {
        if (incoming.content !== current.content || incoming.brand !== current.brand) {
          const merged = { ...current, content: incoming.content, brand: incoming.brand };
          next = composePromptBoxes(merged);
        }
      } else if (activeIsBrand) {
        if (incoming.content !== current.content || incoming.style !== current.style) {
          const merged = { ...current, style: incoming.style, content: incoming.content };
          next = composePromptBoxes(merged);
        }
      } else {
        // Focus is inside the node but not in a specific box (e.g. header);
        // treat as not focused for prompt purposes and allow full sync.
        // Fall through to full sync below.
      }
      if (next !== null) {
        emitted.current.add(next);
        if (emitted.current.size > 100) emitted.current.clear();
        setLocalValue(next);
        draftRef.current = next;
        return;
      }
      return;
    }
    emitted.current.clear();
    emitted.current.add(data.value);
    setLocalValue(data.value);
    draftRef.current = data.value;
  }, [data.value]);
  // Flush any pending draft when the modal closes / node unmounts.
  useEffect(() => () => { syncToParent(); }, []);
  // Register the live-draft handle so graph-side prompt mutations (connect /
  // disconnect / toggle a reference, style/brand ops) land IN the draft —
  // a focused composer can never overwrite them on blur, and the emitted
  // prompt (saved + used to resolve references for generation) always
  // carries the change.
  useEffect(() => {
    const register = dataRef.current.registerApplier as ((a: PromptDraftApplier | undefined) => void) | undefined;
    if (!register) return;
    register({
      get: () => draftRef.current,
      apply: (fn) => {
        const next = fn(draftRef.current);
        if (next === draftRef.current) return;
        draftRef.current = next;
        setLocalValue(next);
        const s = emitted.current;
        if (s.size > 100) s.clear();
        s.add(next);
        dataRef.current.onChange(next);
      },
    });
    return () => register?.(undefined);
  }, []);
  const sockets = promptSockets(data.refHandles, data.openHandleId);
  return (
    <div ref={rootRef} className={"prod-graph-node prod-graph-composer" + (data.magicActive ? " magic-active" : "")}>
      {sockets.map((s) => (
        <Fragment key={s.id}>
          <Handle
            id={s.id}
            type="target"
            position={Position.Left}
            className={`socket-${s.kind}` + (s.open ? " open" : "")}
            style={{ top: `${s.top}%` }}
            title={s.open ? "Reference input — always open, drop a connection here" : `${s.label} input`}
          />
          <span className={`prod-graph-socket-label ${s.kind}`} style={{ top: `${s.top}%` }}>{s.label}</span>
        </Fragment>
      ))}
      <div className="prod-graph-node-title">Prompt{data.magicActive ? " ✨" : ""}</div>
      <TriplePrompt
        className="prod-graph-composer-text nodrag"
        sideRows={3}
        resizable
        deferExternalWhileFocused
        value={localValue}
        includeBrand={data.includeBrand}
        styleReadOnly
        brandReadOnly
        placeholder="Describe the frame — connect references, type @, or edit the boxes"
        onBlur={handleBlur}
        onChange={(v) => {
          setLocalValue(v);
          draftRef.current = v;
          const s = emitted.current;
          if (s.size > 100) s.clear();
          s.add(v);
          // Publish every edit to the parent immediately: the composer and the
          // classic side panel are two views of the SAME shot prompt (they share
          // `focusedPrompt`), so the side panel must never lag behind a
          // node-graph edit. The local draft still owns the DOM (the echoed
          // value is suppressed by `emitted`), so the caret stays put; the save
          // is coalesced by the prompt queue's latest-value guard.
          dataRef.current.onChange(v);
        }}
      />
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const StyleNodeView = memo(function StyleNodeView({ data }: NodeProps<StyleFlowNode>) {
  return (
    <div className="prod-graph-node prod-graph-style">
      <div className="prod-graph-node-title">Style</div>
      <select
        className="prod-openart-select nodrag"
        value={data.value}
        onChange={(e) => data.onChange(e.target.value)}
        title="Render style for this frame (from the styles created in Design, Step 2)"
      >
        <option value="">None</option>
        {data.styles.map((s) => (
          <option key={s.id} value={s.id}>{s.index}. {s.name || `Style ${s.index}`}</option>
        ))}
      </select>
      <Handle type="source" position={Position.Right} className="socket-style" />
    </div>
  );
});

const BrandNodeView = memo(function BrandNodeView({}: NodeProps<BrandFlowNode>) {
  return (
    <div className="prod-graph-node prod-graph-brand">
      <div className="prod-graph-node-title">Brand identity</div>
      <div className="hint" style={{ fontSize: "0.7rem", color: "var(--text-dim)" }}>Pluggable brand — connect to any prompt</div>
      <Handle type="source" position={Position.Right} className="socket-brand" />
    </div>
  );
});

const OutputNodeView = memo(function OutputNodeView({ data, selected }: NodeProps<OutputFlowNode>) {
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={240} minHeight={200} lineClassName="prod-graph-resize-line" handleClassName="prod-graph-resize-handle" />
      <div className="prod-graph-node prod-graph-output">
        <Handle id="in-out" type="target" position={Position.Left} title="Primary output — pipe a generation or reference in" />
        <div className="prod-graph-node-title">Frame output</div>
        {data.previewKind === "video" && data.previewUrl
          ? <video className="prod-graph-output-img nodrag" src={data.previewUrl} controls muted loop playsInline preload="metadata" />
          : data.previewUrl
            ? <img className="prod-graph-output-img" src={data.previewUrl} alt={`Shot ${data.shotNumber}`} draggable={false} />
            : <div className="prod-graph-output-blank">No output yet</div>}
        {!data.bound && <span className="prod-graph-output-hint">Pipe an image, video, or reference in to feed the output</span>}
      </div>
    </>
  );
});

const ImageGenNodeView = memo(function ImageGenNodeView({ id, data }: NodeProps<ImageGenFlowNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  // Content-sized: when the preview / strip / Advanced panel changes height,
  // the percentage-offset sockets move without a resize, so re-measure.
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, data.items.length, data.selected, updateNodeInternals]);
  const [model, setModel] = useState(() => {
    // The production's saved pick wins when it's real; the remembered last
    // choice fills the gap (legacy "auto" or a stale id falls through —
    // effModel below always lands on a listed model).
    const saved = data.defaultModel && data.defaultModel !== "auto" && data.models.some((m) => m.id === data.defaultModel)
      ? data.defaultModel
      : null;
    return saved ?? getMediaDefault("image")?.model ?? data.defaultModel;
  });
  const [resolution, setResolution] = useState(data.defaultResolution);
  const [params, setParams] = useState<GenParams>(data.savedParams ?? {});
  const [schema, setSchema] = useState<CliModelSchema | null>(null);
  const busy = data.busy === true;
  const genMenu = useGenerationMenu();
  // The selection is always explicit: when the saved default is legacy "auto"
  // (or gone from the list), the first listed model is the effective pick.
  const effModel = data.models.some((m) => m.id === model) ? model : (data.models[0]?.id ?? "");
  // Full option schema for the picked model (Advanced panel).
  useEffect(() => {
    let live = true;
    setSchema(null);
    setParams(data.savedParams ?? {});
    if (!effModel) return () => { live = false; };
    void data.onModelSchema(effModel).then((s) => {
      if (!live) return;
      setSchema(s);
      setParams((prev) => seedModelOptionValues(s, effModel, "image:generate", pruneModelOptionValues(s, prev)) as GenParams);
    }).catch(() => { if (live) setSchema(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effModel]);
  const saveParams = (next: ModelOptionValues) => {
    const p = next as GenParams;
    setParams(p);
    data.onSaveFields({ graphImageParams: p });
  };
  const run = async () => {
    await data.onGenerate(effModel, resolution, params);
  };
  // Live per-config quote (Higgsfield CLI only) for the node's Generate button.
  // Quality rides the production default (the submit bills it), so it prices here.
  const imageCostReq = isQuotableCostModel(effModel) ? {
    model: effModel, kind: "image" as const, resolution,
    aspectRatio: costAspect(params),
    ...(data.productionQuality ? { quality: data.productionQuality } : {}),
    ...(Object.keys(params).length ? { params: { ...params } } : {}),
  } : null;
  return (
      <div className="prod-graph-node prod-graph-gen prod-graph-imagegen">
      <Handle id="in-prompt" type="target" position={Position.Left} title="Prompt input" />
      <Handle type="source" position={Position.Right} title="Frame out — pipe into the video node or the output" />
      <div className="prod-graph-node-title">Image generation</div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={effModel} onChange={(e) => { setModel(e.target.value); rememberMediaDefault("image", { model: e.target.value }); }} title="Image model">
          {data.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>)}
        </select>
      </div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={resolution} onChange={(e) => { setResolution(e.target.value); rememberMediaDefault("image", { resolution: e.target.value }); }} title="Resolution">
          <option value="1k">1k</option>
          <option value="2k">2k</option>
          <option value="4k">4k</option>
        </select>
      </div>
      <div className="nodrag">
        <ModelOptionsForm
          schema={schema}
          value={params}
          onChange={saveParams}
          exclude={["resolution"]}
          compact
          persistKey="cascade.modelOptions.advanced.graphImage"
        />
      </div>
      {data.items[data.selected]
        ? <div
            className="prod-graph-gen-preview-wrap"
            title="Right-click for save, copy, edit, reference, or delete options"
            onContextMenu={(e) => genMenu.open(e, data.items[data.selected].path, { src: data.items[data.selected].url, media: "image" })}
          >
            <img className="prod-graph-gen-preview" src={data.items[data.selected].url} alt="Generated frame" draggable={false} />
            <button
              className="prod-graph-ref-zoom prod-graph-gen-zoom nodrag"
              title="View larger"
              onClick={() => data.onZoom("Image generation", data.items[data.selected].url, "image", data.items[data.selected].path)}
            >
              <MagnifyIcon size={9} />
            </button>
          </div>
        : <div className="prod-graph-gen-preview blank">No generations yet</div>}
      {data.items.length > 0 && (
        <div className="prod-graph-gen-strip nodrag">
          {[...data.items].map((it, i) => ({ it, i })).reverse().map(({ it, i }) => (
            <button
              key={i}
              className={i === data.selected ? "sel" : ""}
              title={`${it.prompt || `Generation ${i + 1}`} — right-click for options`}
              onClick={() => data.onSelect(i)}
              onContextMenu={(e) => genMenu.open(e, it.path, { src: it.url, media: "image" })}
            >
              <img src={it.url} alt="" draggable={false} />
            </button>
          ))}
        </div>
      )}
      {data.items.length > 1 && (
        <div className="prod-graph-gen-cycle">
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(1)} title="Older generation">‹</button>
          <span>{data.selected + 1} / {data.items.length}</span>
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(-1)} title="Newer generation">›</button>
        </div>
      )}
      <button className="prod-btn primary prod-graph-gen-go nodrag" disabled={busy} onClick={() => { void run(); }}>
        {busy ? "Generating…" : <>Generate<GenerationCostSuffix req={imageCostReq} /></>}
      </button>
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} onDelete={data.onDeleteGen} onEditInSuite={data.onEditInSuite} />
      </div>
  );
});

const VideoGenNodeView = memo(function VideoGenNodeView({ id, data }: NodeProps<VideoGenFlowNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  // Content-sized: when the preview / strip / Advanced panel changes height,
  // the percentage-offset sockets move without a resize, so re-measure.
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, data.items.length, data.selected, updateNodeInternals]);
  // Seeds from THIS shot's saved picks (per-shot persistence wins; the global
  // media-default only seeds shots that never picked, so a change here stays
  // on this shot).
  const remembered = getMediaDefault("video");
  const [model, setModel] = useState(data.savedModel ?? remembered?.model ?? data.models[0]?.id ?? "");
  const [resolution, setResolution] = useState(data.savedResolution ?? remembered?.resolution ?? "1080p");
  const [durationSec, setDurationSec] = useState(data.savedDurationSec ?? remembered?.durationSec ?? 5);
  const [params, setParams] = useState<GenParams>(data.savedParams ?? {});
  const busy = data.busy === true;
  const [fetching, setFetching] = useState(false);
  const genMenu = useGenerationMenu();
  const [opts, setOpts] = useState<VideoModelOptions | null>(null);
  const [schema, setSchema] = useState<CliModelSchema | null>(null);
  // Per-model resolution / length choices, fetched like the video panel. The
  // node ALWAYS animates a source frame (the piped frame or the shot's own),
  // so it always probes the image-to-video form — never text-to-video.
  useEffect(() => {
    let live = true;
    setOpts(null);
    setSchema(null);
    if (model) {
      void data.onModelOptions(model, true).then((o) => { if (live) setOpts(o); }).catch(() => {});
      void data.onModelSchema(model).then((s) => {
        if (!live) return;
        setSchema(s);
        setParams((prev) => seedModelOptionValues(s, model, "video:generate", pruneModelOptionValues(s, prev)) as GenParams);
      }).catch(() => { if (live) setSchema(null); });
    }
    return () => { live = false; };
  }, [model]);
  // Keep the current selection valid when the model's options arrive.
  const durations = opts?.durations?.length ? opts.durations : [5, 10, 15, 20];
  const resolutions = opts?.resolutions?.length ? opts.resolutions : ["480p", "720p", "1080p"];
  useEffect(() => {
    if (!opts) return;
    if (resolutions.length && !resolutions.includes(resolution)) setResolution(closestResolution(resolution, resolutions));
    if (durations.length && !durations.includes(durationSec)) setDurationSec(durations[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts]);
  const effModel = data.models.some((m) => m.id === model) ? model : (data.models[0]?.id ?? "");
  const saveParams = (next: ModelOptionValues) => {
    const p = next as GenParams;
    setParams(p);
    data.onSaveFields(data.nodeId, { params: p });
  };
  const run = async () => {
    await data.onGenerate(data.nodeId, effModel, resolution, durationSec, params);
  };
  const fetchPending = async () => {
    if (fetching) return;
    setFetching(true);
    try { await data.onFetch(); } finally { setFetching(false); }
  };
  // Live per-config quote (Higgsfield CLI only) for the node's Generate button.
  const videoCostReq = isQuotableCostModel(effModel) ? {
    model: effModel, kind: "video" as const, resolution, durationSec,
    aspectRatio: costAspect(params), ...(Object.keys(params).length ? { params: { ...params } } : {}),
  } : null;
  return (
      <div className="prod-graph-node prod-graph-gen prod-graph-videogen">
      <Handle id="in-prompt" type="target" position={Position.Left} className="socket-ref" style={{ top: "33%" }} title="Prompt input — from the video-prompt node" />
      <span className="prod-graph-socket-label ref" style={{ top: "33%" }}>Prompt</span>
      <Handle id="in-image" type="target" position={Position.Left} className="socket-ref" style={{ top: "67%" }} title="Source image — pipe the frame in" />
      <span className="prod-graph-socket-label ref" style={{ top: "67%" }}>Source</span>
      <Handle type="source" position={Position.Right} title="Clip out — pipe into the output" />
      <div className="prod-graph-node-title">Video generation{data.label}</div>
      <div className="prod-graph-gen-controls">
        <select
          className="prod-openart-select nodrag"
          value={data.models.some((m) => m.id === model) ? model : (data.models[0]?.id ?? "")}
          onChange={(e) => { setModel(e.target.value); data.onSaveFields(data.nodeId, { model: e.target.value }); }}
          title="Video model"
          disabled={data.models.length === 0}
        >
          {data.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>)}
        </select>
      </div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={resolution} onChange={(e) => { setResolution(e.target.value); data.onSaveFields(data.nodeId, { resolution: e.target.value }); }} title="Resolution">
          {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select className="prod-openart-select nodrag" value={String(durationSec)} onChange={(e) => { setDurationSec(Number(e.target.value)); data.onSaveFields(data.nodeId, { durationSec: Number(e.target.value) }); }} title="Clip length">
          {durations.map((d) => <option key={d} value={d}>{d}s</option>)}
        </select>
      </div>
      <div className="nodrag">
        <ModelOptionsForm
          schema={schema}
          value={params}
          onChange={saveParams}
          exclude={["resolution", "duration", "length", "seconds"]}
          compact
          persistKey="cascade.modelOptions.advanced.graphVideo"
        />
      </div>
      <span className="prod-graph-gen-hint">{data.hasImageSource ? "Source: piped frame" : "Source: shot frame"}</span>
      {data.items[data.selected]
        ? <div
            className="prod-graph-gen-preview-wrap"
            title="Right-click for save, copy, edit, reference, or delete options"
            onContextMenu={(e) => genMenu.open(e, data.items[data.selected].path, { src: data.items[data.selected].url, media: "video" })}
          >
            <video className="prod-graph-gen-preview nodrag" src={data.items[data.selected].url} controls muted loop playsInline preload="metadata" />
            <button
              className="prod-graph-ref-zoom prod-graph-gen-zoom nodrag"
              title="View larger"
              onClick={() => data.onZoom("Video generation", data.items[data.selected].url, "video", data.items[data.selected].path)}
            >
              <MagnifyIcon size={9} />
            </button>
          </div>
        : <div className="prod-graph-gen-preview blank">{data.pending ? "pending…" : "No generations yet"}</div>}
      {data.items.length > 0 && (
        <div className="prod-graph-gen-strip nodrag">
          {[...data.items].map((it, i) => ({ it, i })).reverse().map(({ it, i }) => (
            <button
              key={i}
              className={i === data.selected ? "sel" : ""}
              title={`${it.prompt || `Clip ${i + 1}`} — right-click for options`}
              onClick={() => data.onSelect(data.nodeId, i)}
              onContextMenu={(e) => genMenu.open(e, it.path, { src: it.url, media: "video" })}
            >
              <span>{i + 1}</span>
            </button>
          ))}
        </div>
      )}
      {data.items.length > 1 && (
        <div className="prod-graph-gen-cycle">
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(data.nodeId, 1)} title="Older clip">‹</button>
          <span>{data.selected + 1} / {data.items.length}</span>
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(data.nodeId, -1)} title="Newer clip">›</button>
        </div>
      )}
      {data.pending && (
        <button
          className="prod-btn prod-graph-gen-fetch nodrag"
          disabled={fetching || busy}
          onClick={() => { void fetchPending(); }}
          title="The video job outlived its wait (or its download failed) — recheck and download the clip when ready"
        >
          {fetching ? "Fetching…" : "⤓ Fetch"}
        </button>
      )}
      <button className="prod-btn primary prod-graph-gen-go nodrag" disabled={busy} onClick={() => { void run(); }}>
        {busy ? "Generating…" : <>Generate<GenerationCostSuffix req={videoCostReq} /></>}
      </button>
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} onDelete={data.onDeleteGen} onEditInSuite={data.onEditInSuite} />
      </div>
  );
});

/** In-betweener node: 5 fixed keyframe sockets (2 minimum to work) and the
 *  button that opens the timeline. The video model + resolution live in the
 *  timeline modal — this node only owns the keyframe wiring. */
const TWEEN_SOCKET_TOPS = [18, 34, 50, 66, 82];
const TweenNodeView = memo(function TweenNodeView({ data }: NodeProps<TweenFlowNode>) {
  const keyById = new Map(data.keyframes.map((k) => [k.id, k]));
  return (
    <div className="prod-graph-node prod-graph-gen prod-graph-tween">
      {TWEEN_SOCKET_TOPS.map((top, i) => {
        const id = `in-tween-${i}`;
        const wired = data.refIds[i] ? keyById.get(data.refIds[i]) : undefined;
        return (
          <Fragment key={id}>
            <Handle id={id} type="target" position={Position.Left} className="socket-ref" style={{ top: `${top}%` }} title={wired ? `Keyframe ${i + 1}: ${wired.name}` : `Keyframe ${i + 1} — pipe a reference or generated frame in`} />
            <span className="prod-graph-socket-label ref" style={{ top: `${top}%` }}>Keyframe {i + 1}</span>
          </Fragment>
        );
      })}
      <Handle type="source" position={Position.Right} title="Continuous shot out — pipe into the output" />
      <div className="prod-graph-node-title">In-betweener</div>
      <span className="prod-graph-gen-hint">
        {data.refIds.length < 2
          ? `Keyframes ${data.refIds.length}/5 — need at least 2`
          : data.blockCount === 0
            ? `Keyframes ${data.refIds.length}/5`
            : `Blocks ready ${data.readyBlocks}/${data.blockCount}${data.stitched ? (data.reencoded ? " · preview re-encoded" : " · stitched losslessly") : ""}`}
      </span>
      <button className="prod-btn primary prod-graph-gen-go nodrag" onClick={() => data.onOpenTimeline()}>
        Open timeline
      </button>
    </div>
  );
});

/** Edit-video node: a video-edit model edits the clip wired into its source
 *  socket, with optional image/video references wired into the reference
 *  socket (both accept image and video outputs from any node). */
const EditVideoNodeView = memo(function EditVideoNodeView({ id, data }: NodeProps<EditVideoFlowNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  // Content-sized: when the preview / Advanced panel changes height, the
  // percentage-offset sockets move without a resize, so re-measure.
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, data.items.length, data.selected, updateNodeInternals]);
  const [model, setModel] = useState(() => data.savedModel ?? data.models[0]?.id ?? "");
  const [params, setParams] = useState<GenParams>(data.savedParams ?? {});
  const [schema, setSchema] = useState<CliModelSchema | null>(null);
  const busy = data.busy === true;
  const [fetching, setFetching] = useState(false);
  const prompt = data.savedPrompt ?? "";
  const genMenu = useGenerationMenu();
  const effModel = data.models.some((m) => m.id === model) ? model : (data.models[0]?.id ?? "");
  useEffect(() => {
    let live = true;
    setSchema(null);
    if (!effModel) return () => { live = false; };
    void data.onModelSchema(effModel).then((s) => {
      if (!live) return;
      setSchema(s);
      setParams((prev) => seedModelOptionValues(s, effModel, "video:editnode", pruneModelOptionValues(s, prev)) as GenParams);
    }).catch(() => { if (live) setSchema(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effModel]);
  const save = (patch: Partial<ProductionShot>) => data.onSave(patch);
  const run = async () => {
    if (!prompt.trim()) return;
    await data.onGenerate(effModel, prompt.trim(), params);
  };
  const fetchPending = async () => {
    if (fetching) return;
    setFetching(true);
    try { await data.onFetch(); } finally { setFetching(false); }
  };
  // Live per-config quote (Higgsfield CLI only). No resolution/duration
  // controls here — the submit keeps the source's timing — so the quote is
  // for the model + advanced params (advisory).
  const editVideoCostReq = isQuotableCostModel(effModel) ? {
    model: effModel, kind: "video" as const,
    aspectRatio: costAspect(params), ...(Object.keys(params).length ? { params: { ...params } } : {}),
  } : null;
  return (
      <div className="prod-graph-node prod-graph-gen prod-graph-editvideo">
      <Handle id="in-prompt" type="target" position={Position.Left} className="socket-ref" style={{ top: "25%" }} title="Prompt input — from the edit-video prompt node" />
      <span className="prod-graph-socket-label ref" style={{ top: "25%" }}>Prompt</span>
      <Handle id="in-video" type="target" position={Position.Left} className="socket-ref" style={{ top: "72%" }} title="Source clip — wire a video node output or a video reference (mandatory)" />
      <span className="prod-graph-socket-label ref" style={{ top: "72%" }}>Source</span>
      <Handle type="source" position={Position.Right} title="Edited clip out — pipe into the output" />
      <div className="prod-graph-node-title"><EditVideoIcon size={13} className="prod-graph-title-icon" /> Edit video</div>
      <div className="prod-graph-gen-controls">
        <select
          className="prod-openart-select nodrag"
          value={data.models.some((m) => m.id === model) ? model : ""}
          onChange={(e) => { setModel(e.target.value); save({ graphEditVideoModel: e.target.value }); }}
          title="Video-edit model"
          disabled={data.models.length === 0}
        >
          {data.models.length === 0 && <option value="">No edit-video models</option>}
          {data.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>)}
        </select>
      </div>
      <span className="prod-graph-gen-hint">
        {data.sourceLabel ? `Source: ${data.sourceLabel}` : "Source: shot video (wire a clip to override)"}
      </span>
      <div className="nodrag">
        <ModelOptionsForm
          schema={schema}
          value={params}
          onChange={(next) => { const p = next as GenParams; setParams(p); save({ graphEditVideoParams: p }); }}
          exclude={["resolution", "duration", "length", "seconds"]}
          compact
          persistKey="cascade.modelOptions.advanced.graphEditVideo"
        />
      </div>
      {data.items[data.selected]
        ? <div
            className="prod-graph-gen-preview-wrap"
            title="Right-click for save, copy, edit, reference, or delete options"
            onContextMenu={(e) => genMenu.open(e, data.items[data.selected].path, { src: data.items[data.selected].url, media: "video" })}
          >
            <video className="prod-graph-gen-preview nodrag" src={data.items[data.selected].url} controls muted loop playsInline preload="metadata" />
            <button
              className="prod-graph-ref-zoom prod-graph-gen-zoom nodrag"
              title="View larger"
              onClick={() => data.onZoom("Edit video", data.items[data.selected].url, "video", data.items[data.selected].path)}
            >
              <MagnifyIcon size={9} />
            </button>
          </div>
        : <div className="prod-graph-gen-preview blank">{data.pending ? "pending…" : "No edits yet"}</div>}
      {data.items.length > 1 && (
        <div className="prod-graph-gen-cycle">
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(1)} title="Older edit">‹</button>
          <span>{data.selected + 1} / {data.items.length}</span>
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(-1)} title="Newer edit">›</button>
        </div>
      )}
      {data.pending && (
        <button
          className="prod-btn prod-graph-gen-fetch nodrag"
          disabled={fetching || busy}
          onClick={() => { void fetchPending(); }}
          title="The video-edit job outlived its wait (or its download failed) — recheck and download the clip when ready"
        >
          {fetching ? "Fetching…" : "⤓ Fetch"}
        </button>
      )}
      <div className="prod-graph-gen-controls">
        <button className="prod-btn primary prod-graph-gen-go nodrag" disabled={busy || !prompt.trim()} onClick={() => { void run(); }}>
          {busy ? "Editing…" : <>Edit video<GenerationCostSuffix req={editVideoCostReq} /></>}
        </button>
        {data.items[data.selected] && (
          <button className="prod-btn nodrag" disabled={data.piped} onClick={() => data.onPipeToOutput()} title="Feed the edited clip into the frame output">
            {data.piped ? "Piped" : "Pipe to output"}
          </button>
        )}
      </div>
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} onDelete={data.onDeleteGen} onEditInSuite={data.onEditInSuite} />
      </div>
  );
});

const EditGenNodeView = memo(function EditGenNodeView({ id, data }: NodeProps<EditGenFlowNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  // Content-sized: when the preview / strip / Advanced panel changes height,
  // the percentage-offset sockets move without a resize, so re-measure.
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, data.items.length, data.selected, updateNodeInternals]);
  // Seeds from THIS node's saved picks (per-node persistence wins; the global
  // media-default only seeds nodes that never picked, so a change here stays
  // on this node).
  const [model, setModel] = useState(() => data.savedModel ?? getMediaDefault("edit")?.model ?? data.models[0]?.id ?? "");
  const [resolution, setResolution] = useState(() => data.savedResolution ?? getMediaDefault("edit")?.resolution ?? data.defaultResolution);
  const [params, setParams] = useState<GenParams>(data.savedParams ?? {});
  const [schema, setSchema] = useState<CliModelSchema | null>(null);
  const busy = data.busy === true;
  const genMenu = useGenerationMenu();
  const effModel = data.models.some((m) => m.id === model) ? model : (data.models[0]?.id ?? "");
  useEffect(() => {
    let live = true;
    setSchema(null);
    setParams(data.savedParams ?? {});
    if (!effModel) return () => { live = false; };
    void data.onModelSchema(effModel).then((s) => {
      if (!live) return;
      setSchema(s);
      setParams((prev) => seedModelOptionValues(s, effModel, "image:edit", pruneModelOptionValues(s, prev)) as GenParams);
    }).catch(() => { if (live) setSchema(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effModel]);
  const saveParams = (next: ModelOptionValues) => {
    const p = next as GenParams;
    setParams(p);
    data.onSave({ params: p });
  };
  const run = async () => {
    await data.onGenerate(data.nodeId, effModel, resolution, params);
  };
  // Live per-config quote (Higgsfield CLI only) for the node's Generate button.
  // Quality rides the production default (the submit bills it), so it prices here.
  const editCostReq = isQuotableCostModel(effModel) ? {
    model: effModel, kind: "image" as const, resolution,
    aspectRatio: costAspect(params),
    ...(data.productionQuality ? { quality: data.productionQuality } : {}),
    ...(Object.keys(params).length ? { params: { ...params } } : {}),
  } : null;
  const sockets: { id: string; kind: "ref"; label: string; top: number }[] = [
    { id: "in-prompt", kind: "ref", label: "Prompt", top: 33 },
    { id: "in-image", kind: "ref", label: "Source", top: 67 },
  ];
  return (
      <div className="prod-graph-node prod-graph-gen prod-graph-editgen">
      {sockets.map((s) => (
        <Fragment key={s.id}>
          <Handle
            id={s.id}
            type="target"
            position={Position.Left}
            className={`socket-${s.kind}`}
            style={{ top: `${s.top}%` }}
            title={s.id === "in-prompt" ? "Prompt input — from the edit-prompt node" : "Source image — pipe a frame or reference in"}
          />
          <span className={`prod-graph-socket-label ${s.kind}`} style={{ top: `${s.top}%` }}>{s.label}</span>
        </Fragment>
      ))}
      <Handle type="source" position={Position.Right} title="Edit out — pipe into the output" />
      <div className="prod-graph-node-title">Edit image {editNodeLabel(data.nodeId)}</div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={effModel} onChange={(e) => { setModel(e.target.value); data.onSave({ model: e.target.value }); }} title="Image model that accepts a reference image">
          {data.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>)}
        </select>
      </div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={resolution} onChange={(e) => { setResolution(e.target.value); data.onSave({ resolution: e.target.value }); }} title="Resolution">
          <option value="1k">1k</option>
          <option value="2k">2k</option>
          <option value="4k">4k</option>
        </select>
      </div>
      <div className="nodrag">
        <ModelOptionsForm
          schema={schema}
          value={params}
          onChange={saveParams}
          exclude={["resolution"]}
          compact
          persistKey="cascade.modelOptions.advanced.graphEdit"
        />
      </div>
      <span className="prod-graph-gen-hint">Source: {data.sourceHint}</span>
      {data.items[data.selected]
        ? <div
            className="prod-graph-gen-preview-wrap"
            title="Right-click for save, copy, edit, reference, or delete options"
            onContextMenu={(e) => genMenu.open(e, data.items[data.selected].path, { src: data.items[data.selected].url, media: "image" })}
          >
            <img className="prod-graph-gen-preview" src={data.items[data.selected].url} alt="Edited frame" draggable={false} />
            <button
              className="prod-graph-ref-zoom prod-graph-gen-zoom nodrag"
              title="View larger"
              onClick={() => data.onZoom(`Edit image ${editNodeLabel(data.nodeId)}`, data.items[data.selected].url, "image", data.items[data.selected].path)}
            >
              <MagnifyIcon size={9} />
            </button>
          </div>
        : <div className="prod-graph-gen-preview blank">No edits yet</div>}
      {data.items.length > 0 && (
        <div className="prod-graph-gen-strip nodrag">
          {[...data.items].map((it, i) => ({ it, i })).reverse().map(({ it, i }) => (
            <button
              key={i}
              className={i === data.selected ? "sel" : ""}
              title={`${it.prompt || `Edit ${i + 1}`} — right-click for options`}
              onClick={() => data.onSelect(i)}
              onContextMenu={(e) => genMenu.open(e, it.path, { src: it.url, media: "image" })}
            >
              <img src={it.url} alt="" draggable={false} />
            </button>
          ))}
        </div>
      )}
      {data.items.length > 1 && (
        <div className="prod-graph-gen-cycle">
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(1)} title="Older edit">‹</button>
          <span>{data.selected + 1} / {data.items.length}</span>
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(-1)} title="Newer edit">›</button>
        </div>
      )}
      <button className="prod-btn primary prod-graph-gen-go nodrag" disabled={busy} onClick={() => { void run(); }}>
        {busy ? "Generating…" : <>Generate<GenerationCostSuffix req={editCostReq} /></>}
      </button>
      <OpenInSuiteButton
        productionId={data.productionId}
        className="prod-btn nodrag"
        title="Open this edit (prompt, model, source) in the Image Suite"
        seed={{
          mode: "edit",
          prompt: data.prompt,
          model: effModel,
          resolution,
          ...(data.sourceRefId ? { sourceRefId: data.sourceRefId } : {}),
          ...(!data.sourceRefId && data.sourcePath ? { sourcePath: data.sourcePath } : {}),
          ...(Object.keys(params).length ? { params } : {}),
        }}
      />
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} onDelete={data.onDeleteGen} onEditInSuite={data.onEditInSuite} />
      </div>
  );
});

/** External prompt nodes — exactly like the image-gen composer prompt node: left
 *  sockets for Style / Reference(s) / Brand, right source handle, TriplePrompt
 *  with local draft while focused. Each prompt's Style/Brand presence and @-tags
 *  drive its own edges, mirroring the composer. */
/** Shared body for the prompt nodes (video / edit-image / edit-video): Style +
 *  Reference(s) + Brand sockets on the left, a TriplePrompt body, a source
 *  handle on the right. The wrappers below supply the title/placeholder/class. */
/** The body PromptNodeView renders — shared by every prompt node kind. */
interface PromptBodyData {
  value: string;
  refHandles: string[];
  openHandleId: string;
  includeBrand: boolean;
  onChange: (text: string) => void;
  registerApplier: (applier: PromptDraftApplier | undefined) => void;
}

const PromptNodeView = memo(function PromptNodeView({ id, data, title, placeholder, containerClass }: { id: string; data: PromptBodyData; title: string; placeholder: string; containerClass: string }) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, data.refHandles.length, updateNodeInternals]);
  const [localValue, setLocalValue] = useState(data.value);
  const emitted = useRef<Set<string>>(new Set([data.value]));
  const rootRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(localValue);
  const dataRef = useRef(data);
  useEffect(() => { draftRef.current = localValue; }, [localValue]);
  useEffect(() => { dataRef.current = data; }, [data]);
  const syncToParent = () => {
    const latest = draftRef.current;
    const cur = dataRef.current.value;
    if (latest !== cur) {
      emitted.current.add(latest);
      if (emitted.current.size > 100) emitted.current.clear();
      dataRef.current.onChange(latest);
    }
  };
  const handleBlur = () => {
    setTimeout(() => { if (!rootRef.current?.contains(document.activeElement)) syncToParent(); }, 0);
  };
  useEffect(() => {
    if (emitted.current.has(data.value)) return;
    const active = document.activeElement as HTMLElement | null;
    const isFocused = !!rootRef.current && !!active && rootRef.current.contains(active);
    if (isFocused) {
      const incoming = parsePromptBoxes(data.value);
      const current = parsePromptBoxes(localValue);
      const contentEl = rootRef.current?.querySelector(".prompt-content-editor") as HTMLElement | null;
      const isContentFocused = !!contentEl && !!active && (contentEl === active || contentEl.contains(active));
      const activeIsStyle = !!active && active.tagName === "TEXTAREA" && (active as HTMLTextAreaElement).placeholder.includes("Visual style");
      const activeIsBrand = !!active && active.tagName === "TEXTAREA" && (active as HTMLTextAreaElement).placeholder.includes("Palette");
      let next: string | null = null;
      if (isContentFocused) {
        if (incoming.style !== current.style || incoming.brand !== current.brand) {
          const merged = { ...current, style: incoming.style, brand: incoming.brand };
          next = composePromptBoxes(merged);
        }
      } else if (activeIsStyle) {
        if (incoming.content !== current.content || incoming.brand !== current.brand) {
          const merged = { ...current, content: incoming.content, brand: incoming.brand };
          next = composePromptBoxes(merged);
        }
      } else if (activeIsBrand) {
        if (incoming.content !== current.content || incoming.style !== current.style) {
          const merged = { ...current, style: incoming.style, content: incoming.content };
          next = composePromptBoxes(merged);
        }
      } else if (!isContentFocused && !activeIsStyle && !activeIsBrand) {
        // Generic focus inside node (e.g. header) — preserve local draft
        return;
      }
      if (next !== null) {
        emitted.current.add(next);
        if (emitted.current.size > 100) emitted.current.clear();
        setLocalValue(next);
        draftRef.current = next;
        return;
      }
      return;
    }
    emitted.current.clear();
    emitted.current.add(data.value);
    setLocalValue(data.value);
    draftRef.current = data.value;
  }, [data.value]);
  useEffect(() => () => { syncToParent(); }, []);
  // Live-draft handle for the video-prompt node (see ComposerNodeView).
  useEffect(() => {
    const register = dataRef.current.registerApplier as ((a: PromptDraftApplier | undefined) => void) | undefined;
    if (!register) return;
    register({
      get: () => draftRef.current,
      apply: (fn) => {
        const next = fn(draftRef.current);
        if (next === draftRef.current) return;
        draftRef.current = next;
        setLocalValue(next);
        const s = emitted.current;
        if (s.size > 100) s.clear();
        s.add(next);
        dataRef.current.onChange(next);
      },
    });
    return () => register?.(undefined);
  }, []);
  const sockets = promptSockets(data.refHandles, data.openHandleId);
  return (
    <div ref={rootRef} className={"prod-graph-node prod-graph-composer " + containerClass}>
      {sockets.map((s) => (
        <Fragment key={s.id}>
          <Handle id={s.id} type="target" position={Position.Left} className={`socket-${s.kind}` + (s.open ? " open" : "")} style={{ top: `${s.top}%` }} title={s.open ? "Reference input — always open, drop a connection here" : `${s.label} input`} />
          <span className={`prod-graph-socket-label ${s.kind}`} style={{ top: `${s.top}%` }}>{s.label}</span>
        </Fragment>
      ))}
      <div className="prod-graph-node-title">{title}</div>
      <TriplePrompt
        className="prod-graph-composer-text nodrag"
        sideRows={3}
        resizable
        deferExternalWhileFocused
        value={localValue}
        includeBrand={data.includeBrand}
        styleReadOnly
        brandReadOnly
        placeholder={placeholder}
        onBlur={handleBlur}
        onChange={(v) => {
          const prev = localValue;
          setLocalValue(v);
          draftRef.current = v;
          const s = emitted.current;
          if (s.size > 100) s.clear();
          s.add(v);
          try {
            const pc = parsePromptBoxes(prev).content;
            const nc = parsePromptBoxes(v).content;
            if (isTagReorder(pc, nc)) dataRef.current.onChange(v);
          } catch {}
        }}
      />
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

/** Video-prompt node: the motion prompt for one video generation node. */
const VideoPromptNodeView = memo((props: NodeProps<VideoPromptFlowNode>) => {
  const { id, data } = props;
  const adapted: PromptBodyData = {
    value: data.value,
    refHandles: data.refHandles,
    openHandleId: data.openHandleId,
    includeBrand: data.includeBrand,
    registerApplier: data.registerApplier,
    onChange: (text: string) => data.onChange(data.nodeId, text),
  };
  return (
    <PromptNodeView
      id={id}
      data={adapted}
      title={`Video prompt${videoNodeLabel(data.nodeId)}`}
      placeholder="Motion prompt — connect references, type @, or edit the boxes"
      containerClass="prod-graph-videoprompt"
    />
  );
});

/** Edit-image prompt node: the edit instructions for one edit-image node. */
const EditPromptNodeView = memo((props: NodeProps<EditPromptFlowNode>) => {
  const { id, data } = props;
  const adapted: PromptBodyData = {
    value: data.value,
    refHandles: data.refHandles,
    openHandleId: data.openHandleId,
    includeBrand: data.includeBrand,
    registerApplier: data.registerApplier,
    onChange: (text: string) => data.onChange(data.nodeId, text),
  };
  return (
    <PromptNodeView
      id={id}
      data={adapted}
      title={`Edit prompt ${editNodeLabel(data.nodeId)}`}
      placeholder="Edit instructions — connect references, type @, or edit the boxes"
      containerClass="prod-graph-editprompt"
    />
  );
});

/** Edit-video prompt node: the edit instructions for the edit-video node. */
const EditVideoPromptNodeView = memo((props: NodeProps<EditVideoPromptFlowNode>) => (
  <PromptNodeView
    id={props.id}
    data={props.data}
    title="Edit video prompt"
    placeholder="Edit instructions — connect references, type @, or edit the boxes"
    containerClass="prod-graph-editvideoprompt"
  />
));

/* ------------------------------------------------------------------ */
/* Camera-grid node (Spec 04)                                          */
/* ------------------------------------------------------------------ */

/** Snap a normalized coordinate to the nearest panel boundary within `tol`. */
function snapTo(v: number, boundaries: number[], tol: number): number {
  let best = v;
  let bestD = tol;
  for (const b of boundaries) {
    const d = Math.abs(v - b);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** The camera-grid generator node: a source image + reference sockets feed a
 *  cols x rows sheet generation, then the user marquees panels out as standalone
 *  references. The marquee is node-local UI state (never persisted). */
const CameraGridNodeView = memo(function CameraGridNodeView({ id, data }: NodeProps<CameraGridFlowNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, data.panels, data.sheetUrl, data.refIds.length, updateNodeInternals]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Inline generation controls (like the image/edit nodes), seeded once from
  // the node's saved picks. Saves land on `ProductionShot.graphCameraGrid`.
  const [model, setModel] = useState(() => data.savedModel ?? getMediaDefault("image")?.model ?? data.defaultModel);
  const [resolution, setResolution] = useState(() => data.savedResolution ?? getMediaDefault("image")?.resolution ?? data.defaultResolution);
  const [params, setParams] = useState<GenParams>(data.savedParams ?? {});
  const [schema, setSchema] = useState<CliModelSchema | null>(null);
  const effModel = data.models.some((m) => m.id === model) ? model : (data.models[0]?.id ?? "");
  useEffect(() => {
    let live = true;
    setSchema(null);
    setParams(data.savedParams ?? {});
    if (!effModel) return () => { live = false; };
    void data.onModelSchema(effModel).then((s) => {
      if (!live) return;
      setSchema(s);
      setParams((prev) => seedModelOptionValues(s, effModel, "image:generate", pruneModelOptionValues(s, prev)) as GenParams);
    }).catch(() => { if (live) setSchema(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effModel]);
  const saveParams = (next: ModelOptionValues) => {
    const p = next as GenParams;
    setParams(p);
    data.onSave({ params: p });
  };
  // Source + reference sockets, evenly spaced down the left edge.
  const refHandles = data.refIds.map((_, i) => `in-ref-${i}`);
  const total = refHandles.length + 3;
  const topAt = (i: number) => ((i + 1) / (total + 1)) * 100;
  const sockets: { id: string; label: string; open?: boolean; top: number }[] = [
    { id: "in-image", label: "Source", top: topAt(0) },
    { id: "in-grid", label: "Grid image", top: topAt(1) },
    ...refHandles.map((h, i) => ({ id: h, label: `Ref ${i + 1}`, top: topAt(i + 2) })),
    { id: "in-ref-open", label: "Refs", open: true, top: topAt(refHandles.length + 2) },
  ];
  const generate = async () => {
    if (busy) return;
    const opts: CameraGridGenOptions = { model: effModel, resolution, cols: data.cols, rows: data.rows, ...(Object.keys(params).length ? { params } : {}) };
    // Persist the live picks, then generate with them.
    data.onSave({ model: effModel, resolution, cols: data.cols, rows: data.rows, ...(Object.keys(params).length ? { params } : {}) });
    setBusy(true);
    setErr(null);
    try {
      await data.onGenerate(opts);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };
  // Live per-config quote (Higgsfield CLI only) for the Generate button.
  // Quality rides the production default (the submit bills it), so it prices here.
  const costReq = isQuotableCostModel(effModel) ? {
    model: effModel, kind: "image" as const, resolution,
    aspectRatio: costAspect(params),
    ...(data.productionQuality ? { quality: data.productionQuality } : {}),
    ...(Object.keys(params).length ? { params: { ...params } } : {}),
  } : null;

  return (
    <div className="prod-graph-node prod-graph-gen prod-graph-camera">
      {sockets.map((s) => (
        <Fragment key={s.id}>
          <Handle
            id={s.id}
            type="target"
            position={Position.Left}
            className={"socket-ref" + (s.open ? " open" : "")}
            style={{ top: `${s.top}%` }}
            title={
              s.id === "in-image" ? "Source image — pipe a frame or reference in"
              : s.id === "in-grid" ? "Grid image — pipe in an already-made grid to cut panels out of (manual fallback)"
              : s.open ? "Reference input — always open, drop a connection here"
              : `${s.label} input`
            }
          />
          <span className="prod-graph-socket-label ref" style={{ top: `${s.top}%` }}>{s.label}</span>
        </Fragment>
      ))}
      <div className="prod-graph-node-title">{data.cols * data.rows}-angle camera grid</div>
      <div className="prod-graph-gen-controls">
        <select
          className="prod-openart-select nodrag"
          value={cameraGridSizeKey(data.cols, data.rows)}
          onChange={(e) => {
            const [c, r] = e.target.value.split("x").map(Number);
            if (c > 0 && r > 0) data.onSave({ cols: c, rows: r, panels: undefined, panelLabels: undefined });
          }}
          title="Grid size — the number of camera angles in the sheet"
        >
          {CAMERA_GRID_SIZES.map((s) => <option key={s.label} value={cameraGridSizeKey(s.cols, s.rows)}>{s.label}</option>)}
        </select>
      </div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={effModel} onChange={(e) => { setModel(e.target.value); data.onSave({ model: e.target.value }); rememberMediaDefault("image", { model: e.target.value }); }} title="Image model">
          {data.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>)}
        </select>
      </div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={resolution} onChange={(e) => { setResolution(e.target.value); data.onSave({ resolution: e.target.value }); rememberMediaDefault("image", { resolution: e.target.value }); }} title="Resolution">
          <option value="1k">1k</option>
          <option value="2k">2k</option>
          <option value="4k">4k</option>
        </select>
      </div>
      <div className="nodrag">
        <ModelOptionsForm
          schema={schema}
          value={params}
          onChange={saveParams}
          exclude={["resolution", "aspect_ratio"]}
          compact
          persistKey="cascade.modelOptions.advanced.cameraGrid"
        />
      </div>
      <span className="prod-graph-gen-hint">
        {data.sourceLabel ? `Source: ${data.sourceLabel}` : "Source: shot frame (wire a frame to override)"} · {data.refIds.length} ref{data.refIds.length === 1 ? "" : "s"}
        {data.gridSourceLabel ? ` · Grid: ${data.gridSourceLabel}` : ""}
      </span>
      <div className="prod-graph-camera-prompt-note">
        <span className="hint">Prompt: Settings → Advanced → Prompts</span>
        <button className="prod-btn nodrag" type="button" onClick={() => openSettings("prompts")} title="Edit the shared camera-grid prompt in Settings">
          Edit prompt…
        </button>
      </div>
      <div className="prod-graph-gen-controls">
        <button className="prod-btn primary" disabled={!effModel || busy} onClick={() => void generate()} title={`Generate or regenerate the ${data.cols}×${data.rows} sheet`}>
          {busy ? "Generating…" : <>{data.sheetUrl ? "Regenerate" : "Generate"}<GenerationCostSuffix req={costReq} /></>}
        </button>
      </div>
      {data.sheetUrl ? (
        <button
          className="prod-graph-camera-thumb nodrag"
          type="button"
          onClick={data.onOpenEditor}
          title="Open the full-res panel editor to select and export panels"
        >
          <img src={data.sheetUrl} alt="Camera grid sheet" draggable={false} />
          <span className="prod-graph-camera-thumb-overlay">Select &amp; export panels…</span>
        </button>
      ) : (
        <div className="prod-graph-camera-empty">No sheet yet — generate a {data.cols}×{data.rows} camera grid, then open it to export panels.</div>
      )}
      {err && <p className="error-text">{err}</p>}
    </div>
  );
});

const UpscaleNodeView = memo(function UpscaleNodeView({ id, data }: NodeProps<UpscaleFlowNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, data.items.length, data.selected, updateNodeInternals]);
  // Seeds from THIS node's saved picks (per-node persistence wins; the global
  // media-default only seeds nodes that never picked).
  const [model, setModel] = useState(() => data.savedModel ?? getMediaDefault("upscale")?.model ?? data.models[0]?.id ?? "");
  const [resolution, setResolution] = useState(() => data.savedResolution ?? getMediaDefault("upscale")?.resolution ?? data.defaultResolution);
  const [params, setParams] = useState<GenParams>(data.savedParams ?? {});
  const [schema, setSchema] = useState<CliModelSchema | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const genMenu = useGenerationMenu();
  const effModel = data.models.some((m) => m.id === model) ? model : (data.models[0]?.id ?? "");
  useEffect(() => {
    let live = true;
    setSchema(null);
    setParams(data.savedParams ?? {});
    if (!effModel) return () => { live = false; };
    void data.onModelSchema(effModel).then((s) => {
      if (!live) return;
      setSchema(s);
      setParams((prev) => seedModelOptionValues(s, effModel, "image:upscale", pruneModelOptionValues(s, prev)) as GenParams);
    }).catch(() => { if (live) setSchema(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effModel]);
  const saveParams = (next: ModelOptionValues) => {
    const p = next as GenParams;
    setParams(p);
    data.onSave({ params: p });
  };
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await data.onGenerate(effModel, resolution, params);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };
  const costReq = isQuotableCostModel(effModel) ? {
    model: effModel, kind: "image" as const, resolution,
    aspectRatio: costAspect(params),
    ...(data.productionQuality ? { quality: data.productionQuality } : {}),
    ...(Object.keys(params).length ? { params: { ...params } } : {}),
  } : null;
  return (
    <div className="prod-graph-node prod-graph-gen prod-graph-upscale">
      <Handle
        id="in-image"
        type="target"
        position={Position.Left}
        className="socket-ref"
        style={{ top: "50%" }}
        title="Source image — pipe a frame or reference in (falls back to the shot's frame)"
      />
      <span className="prod-graph-socket-label ref" style={{ top: "50%" }}>Source</span>
      <Handle type="source" position={Position.Right} title="Upscaled image — pipe into the output" />
      <div className="prod-graph-node-title">Upscale</div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={effModel} onChange={(e) => { setModel(e.target.value); data.onSave({ model: e.target.value }); rememberMediaDefault("upscale", { model: e.target.value }); }} title="Upscale-capable image model">
          {data.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>)}
        </select>
      </div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={resolution} onChange={(e) => { setResolution(e.target.value); data.onSave({ resolution: e.target.value }); rememberMediaDefault("upscale", { resolution: e.target.value }); }} title="Resolution">
          <option value="1k">1k</option>
          <option value="2k">2k</option>
          <option value="4k">4k</option>
        </select>
      </div>
      <div className="nodrag">
        <ModelOptionsForm
          schema={schema}
          value={params}
          onChange={saveParams}
          exclude={["resolution", "aspect_ratio"]}
          compact
          persistKey="cascade.modelOptions.advanced.graphUpscale"
        />
      </div>
      <span className="prod-graph-gen-hint">Source: {data.sourceHint}</span>
      {data.items[data.selected]
        ? <div
            className="prod-graph-gen-preview-wrap"
            title="Right-click for save, copy, edit, reference, or delete options"
            onContextMenu={(e) => genMenu.open(e, data.items[data.selected].path, { src: data.items[data.selected].url, media: "image" })}
          >
            <img className="prod-graph-gen-preview" src={data.items[data.selected].url} alt="Upscaled frame" draggable={false} />
            <button
              className="prod-graph-ref-zoom prod-graph-gen-zoom nodrag"
              title="View larger"
              onClick={() => data.onZoom("Upscale", data.items[data.selected].url, "image", data.items[data.selected].path)}
            >
              <MagnifyIcon size={9} />
            </button>
          </div>
        : <div className="prod-graph-gen-preview blank">No upscales yet</div>}
      {data.items.length > 0 && (
        <div className="prod-graph-gen-strip nodrag">
          {[...data.items].map((it, i) => ({ it, i })).reverse().map(({ it, i }) => (
            <button
              key={i}
              className={i === data.selected ? "sel" : ""}
              title={`Upscale ${i + 1} — right-click for options`}
              onClick={() => data.onSelect(i)}
              onContextMenu={(e) => genMenu.open(e, it.path, { src: it.url, media: "image" })}
            >
              <img src={it.url} alt="" draggable={false} />
            </button>
          ))}
        </div>
      )}
      {data.items.length > 1 && (
        <div className="prod-graph-gen-cycle">
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(1)} title="Older upscale">‹</button>
          <span>{data.selected + 1} / {data.items.length}</span>
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(-1)} title="Newer upscale">›</button>
        </div>
      )}
      <button className="prod-btn primary prod-graph-gen-go nodrag" disabled={busy || !effModel} onClick={() => { void run(); }}>
        {busy ? "Upscaling…" : <>Upscale<GenerationCostSuffix req={costReq} /></>}
      </button>
      <OpenInSuiteButton
        productionId={data.productionId}
        className="prod-btn nodrag"
        title="Open this upscale (model, source) in the Image Suite"
        seed={{
          mode: "upscale",
          model: effModel,
          resolution,
          ...(data.sourceRefId ? { sourceRefId: data.sourceRefId } : {}),
          ...(!data.sourceRefId && data.sourcePath ? { sourcePath: data.sourcePath } : {}),
          ...(Object.keys(params).length ? { params } : {}),
        }}
      />
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} onDelete={data.onDeleteGen} onEditInSuite={data.onEditInSuite} />
      {err && <p className="error-text">{err}</p>}
    </div>
  );
});

/** Full-res camera-grid panel editor popup. Marquee-select the sheet's cells,
 *  shrink the crop with a global inset slider (to cut the gutters/borders
 *  between cells), and export each pick as a reference. Rendered at the graph
 *  root so it isn't clipped/scaled by the canvas transform. */
function CameraGridEditor({ sheetUrl, sheetPath, cols, rows, panels, panelLabels, inset, onInsetChange, onSizeChange, onExport, onZoom, onClose }: {
  sheetUrl: string;
  sheetPath?: string;
  cols: number;
  rows: number;
  panels: CameraGridPanel[];
  panelLabels: string[];
  inset: number;
  onInsetChange: (v: number) => void;
  onSizeChange: (cols: number, rows: number) => void;
  onExport: (rects: CameraGridPanel[], labels: string[], single: boolean) => Promise<number>;
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string) => void;
  onClose: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; clientX: number; clientY: number; moved: boolean } | null>(null);
  const marqueeRef = useRef<CameraGridPanel | null>(null);
  const [marquee, setMarquee] = useState<CameraGridPanel | null>(null);
  const [selection, setSelection] = useState<Set<number>>(() => new Set());
  const [hover, setHover] = useState<number | null>(null);
  const [single, setSingle] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const selected = [...selection].sort((a, b) => a - b);

  // A size change re-divides the sheet, so the old panel selection is stale.
  useEffect(() => { setSelection(new Set()); setDone(null); }, [cols, rows]);

  const norm = (e: React.PointerEvent): { x: number; y: number } | null => {
    const el = stageRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const panelAt = (p: { x: number; y: number }): number =>
    panels.findIndex((panel) => p.x >= panel.x && p.x <= panel.x + panel.w && p.y >= panel.y && p.y <= panel.y + panel.h);
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = norm(e);
    if (!p) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: p.x, y: p.y, clientX: e.clientX, clientY: e.clientY, moved: false };
    marqueeRef.current = { x: p.x, y: p.y, w: 0, h: 0 };
    setDone(null);
    setMarquee({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMove = (e: React.PointerEvent) => {
    const p = norm(e);
    if (!p) return;
    if (!drag.current) {
      const idx = panelAt(p);
      setHover((h) => { const next = idx >= 0 ? idx : null; return h === next ? h : next; });
      return;
    }
    if (!drag.current.moved && Math.hypot(e.clientX - drag.current.clientX, e.clientY - drag.current.clientY) > 3) {
      drag.current.moved = true;
    }
    const a = drag.current;
    let x0 = Math.min(a.x, p.x), x1 = Math.max(a.x, p.x), y0 = Math.min(a.y, p.y), y1 = Math.max(a.y, p.y);
    const r = stageRef.current?.getBoundingClientRect();
    if (!e.altKey && r && r.width > 0 && r.height > 0) {
      const xb = Array.from({ length: cols + 1 }, (_, i) => i / cols);
      const yb = Array.from({ length: rows + 1 }, (_, i) => i / rows);
      x0 = snapTo(x0, xb, 6 / r.width);
      x1 = snapTo(x1, xb, 6 / r.width);
      y0 = snapTo(y0, yb, 6 / r.height);
      y1 = snapTo(y1, yb, 6 / r.height);
    }
    if (e.shiftKey) {
      const w = Math.max(x1 - x0, y1 - y0);
      if (a.x <= p.x) x1 = x0 + w; else x0 = x1 - w;
      if (a.y <= p.y) y1 = y0 + w; else y0 = y1 - w;
    }
    const rect = gridRectFromPoints(x0, y0, x1, y1);
    marqueeRef.current = rect;
    setMarquee(rect);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const r = stageRef.current?.getBoundingClientRect();
    if (d.moved) {
      // A drag selects every panel the box touches (Shift adds to the selection).
      const rect = marqueeRef.current ?? { x: d.x, y: d.y, w: 0, h: 0 };
      const wpx = r ? rect.w * r.width : rect.w * 300;
      const hpx = r ? rect.h * r.height : rect.h * 300;
      const hits = wpx < 3 && hpx < 3 ? [] : touchedPanelIndices(rect, panels);
      if (hits.length) setSelection((prev) => (e.shiftKey ? new Set([...prev, ...hits]) : new Set(hits)));
    } else {
      // A click toggles the panel under the cursor (Shift = add/remove).
      const idx = panelAt({ x: d.x, y: d.y });
      if (idx >= 0) {
        setSelection((prev) => {
          if (e.shiftKey) {
            const n = new Set(prev);
            if (n.has(idx)) n.delete(idx); else n.add(idx);
            return n;
          }
          return new Set([idx]);
        });
      }
    }
    marqueeRef.current = null;
    setMarquee(null);
  };
  const onLeave = () => { if (!drag.current) setHover(null); };
  const selectAll = () => { setDone(null); setSelection(new Set(panels.map((_, i) => i))); };
  const exportSel = async () => {
    if (!selected.length || exporting) return;
    const rects: CameraGridPanel[] = [];
    const labels: string[] = [];
    if (single) {
      const u = unionGridRects(selected.map((i) => panels[i]));
      if (u) { rects.push(insetGridRect(u, inset)); labels.push("Camera grid selection"); }
    } else {
      for (const i of selected) {
        rects.push(insetGridRect(panels[i], inset));
        labels.push(panelLabels[i] ?? `Angle ${i + 1}`);
      }
    }
    setExporting(true);
    setErr(null);
    setDone(null);
    try {
      const n = await onExport(rects, labels, single);
      setSelection(new Set());
      setDone(n ? `Exported ${n} reference${n === 1 ? "" : "s"} to the “Camera Grid” category.` : "No panels were exported — the crop rects were empty.");
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="prod-edit-overlay prod-video-overlay" onClick={onClose}>
      <div className="prod-edit-panel prod-camera-editor" onClick={(e) => e.stopPropagation()}>
        <div className="prod-edit-head">
          <span className="prod-edit-title">Camera grid — select &amp; export panels</span>
          <button className="prod-btn" onClick={onClose}>Close</button>
        </div>
        <div
          className="prod-graph-camera-stage prod-camera-editor-stage"
          ref={stageRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onLeave}
          onPointerCancel={onUp}
          onDoubleClick={() => sheetPath && onZoom("Camera grid", sheetUrl, "image", sheetPath)}
          title="Click a panel to select it; Shift-click to add or remove. Drag a box to select every panel it touches. Double-click to open full-res."
        >
          <img className="prod-graph-camera-sheet" src={sheetUrl} alt="Camera grid sheet" draggable={false} />
          {panels.map((p, i) => (
            <div
              key={i}
              className={"prod-graph-camera-panel" + (selection.has(i) ? " hi" : hover === i ? " hover" : "")}
              style={{ left: `${insetGridRect(p, inset).x * 100}%`, top: `${insetGridRect(p, inset).y * 100}%`, width: `${insetGridRect(p, inset).w * 100}%`, height: `${insetGridRect(p, inset).h * 100}%` }}
            />
          ))}
          {marquee && (
            <div
              className="prod-graph-camera-marquee"
              style={{ left: `${marquee.x * 100}%`, top: `${marquee.y * 100}%`, width: `${marquee.w * 100}%`, height: `${marquee.h * 100}%` }}
            />
          )}
        </div>
        <div className="prod-camera-editor-controls">
          <label className="prod-camera-editor-grid" title="The sheet's grid size — set it to match a grid image you imported or piped in">
            <span>Grid</span>
            <select
              className="prod-openart-select"
              value={cameraGridSizeKey(cols, rows)}
              onChange={(e) => {
                const [c, r] = e.target.value.split("x").map(Number);
                if (c > 0 && r > 0) onSizeChange(c, r);
              }}
            >
              {CAMERA_GRID_SIZES.map((s) => <option key={s.label} value={cameraGridSizeKey(s.cols, s.rows)}>{s.label}</option>)}
            </select>
          </label>
          <label className="prod-camera-editor-inset" title="Shrink every exported crop inward so the black gutters/borders between cells are removed">
            <span>Inset {Math.round(inset * 100)}%</span>
            <input
              type="range"
              min={0}
              max={0.25}
              step={0.01}
              value={inset}
              onChange={(e) => onInsetChange(Number(e.target.value))}
            />
          </label>
          <span className="prod-graph-camera-count">{selected.length} panel{selected.length === 1 ? "" : "s"} selected</span>
          <label className="prod-graph-camera-single" title="Export the bounding box of the selected panels as one image instead of one reference per panel">
            <input type="checkbox" checked={single} onChange={(e) => setSingle(e.target.checked)} /> Single image
          </label>
        </div>
        <div className="prod-graph-gen-controls">
          <button className="prod-btn" type="button" onClick={selectAll}>Select all</button>
          <button className="prod-btn primary" type="button" disabled={!selected.length || exporting} onClick={() => void exportSel()}>
            {exporting ? "Exporting…" : `Export ${selected.length || ""}`.trim()}
          </button>
          <button className="prod-btn" type="button" disabled={!selected.length} onClick={() => setSelection(new Set())}>Clear</button>
        </div>
        <p className="hint">Click a panel to select it, Shift-click to add or remove, or drag a box — every panel it touches is selected. The inset shrinks every crop so the lines between cells are removed.</p>
        {done && <p className="hint">{done}</p>}
        {err && <p className="error-text">{err}</p>}
      </div>
    </div>
  );
}

const nodeTypes = {
  ref: RefNodeView,
  composer: ComposerNodeView,
  style: StyleNodeView,
  brand: BrandNodeView,
  // NOT "output" — that's a built-in React Flow type whose default CSS paints
  // a white box behind the custom node.
  frame: OutputNodeView,
  imagegen: ImageGenNodeView,
  videogen: VideoGenNodeView,
  tween: TweenNodeView,
  editvideo: EditVideoNodeView,
  editgen: EditGenNodeView,
  videoprompt: VideoPromptNodeView,
  editprompt: EditPromptNodeView,
  editvideoprompt: EditVideoPromptNodeView,
  cameraGrid: CameraGridNodeView,
  upscale: UpscaleNodeView,
};

/** Exported for the renderer-component tests (the node graph uses it directly). */
export const graphNodeTypes = nodeTypes;

/* ------------------------------------------------------------------ */
/* Reference shelf                                                     */
/* ------------------------------------------------------------------ */

/** Shelf tiles rendered per group before their thumbnails may load — keeps
 *  the initial DOM small so large projects open fast. */
const SHELF_PAGE = 24;
/** Shelf width (px): the default list column, its drag bounds, and the width at
 *  which tiles switch from a one-column list to a wrapping grid (two 120px
 *  columns plus the list padding/gaps). */
export const SHELF_DEFAULT_WIDTH = 220;
export const SHELF_MIN_WIDTH = 180;
export const SHELF_MAX_WIDTH = 560;
export const SHELF_GRID_WIDTH = 300;
/** Groups bigger than this start collapsed (persisted choice still wins). */
const SHELF_AUTO_COLLAPSE_AT = 24;
/** Max simultaneous shelf thumbnail loads — each `?thumb=1` fetch is a main-
 *  process disk read + resize, so unbounded parallel loads stall the open. */
const MAX_CONCURRENT_SHELF_THUMBS = 4;

let shelfThumbActive = 0;
const shelfThumbWaiters: Array<() => void> = [];

/** Resolve with a slot release once fewer than MAX_CONCURRENT_SHELF_THUMBS
 *  shelf thumbnails are in flight. FIFO; the slot is held until the image
 *  settles (load/error/unmount), not just until its request starts. */
function acquireShelfThumbSlot(): Promise<() => void> {
  return new Promise<() => void>((resolve) => {
    const grant = () => {
      shelfThumbActive += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        shelfThumbActive -= 1;
        const next = shelfThumbWaiters.shift();
        if (next) next();
      });
    };
    if (shelfThumbActive < MAX_CONCURRENT_SHELF_THUMBS) grant();
    else shelfThumbWaiters.push(grant);
  });
}

/** Test seam — reset the thumbnail slot scheduler between cases. */
export function resetShelfThumbSchedulerForTests(): void {
  shelfThumbActive = 0;
  shelfThumbWaiters.length = 0;
}

/** Shelf thumbnail: disk-backed (`cascade-media://`) artwork loads only once
 *  the tile scrolls near the viewport and while a load slot is free — so
 *  opening the graph in a large project no longer fires N thumbnail encodes
 *  at once. Inline data URLs are already in memory and render immediately.
 *  The tile row itself always renders; only the `src` is gated, with a blank
 *  placeholder holding the layout until then. */
function ShelfThumb({ src, alt }: { src: string; alt: string }) {
  const direct = !src.startsWith("cascade-media://");
  const [armed, setArmed] = useState(direct);
  const boxRef = useRef<HTMLDivElement>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (direct) return;
    let live = true;
    let observer: IntersectionObserver | null = null;
    const start = () => {
      void acquireShelfThumbSlot().then((release) => {
        if (!live) { release(); return; }
        releaseRef.current = release;
        setArmed(true);
      });
    };
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") start();
    else {
      observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              observer?.disconnect();
              observer = null;
              start();
            }
          }
        },
        { rootMargin: "200px" },
      );
      observer.observe(el);
    }
    return () => {
      live = false;
      observer?.disconnect();
      releaseRef.current?.();
      releaseRef.current = null;
    };
  }, [direct, src]);
  const settle = () => {
    releaseRef.current?.();
    releaseRef.current = null;
  };
  return (
    <div ref={boxRef} className="prod-graph-shelf-thumb" aria-hidden="true">
      {armed
        ? <img src={refThumbUrl(src)} alt={alt} draggable={false} loading="lazy" decoding="async" onLoad={settle} onError={settle} />
        : <div className="prod-graph-shelf-blank">…</div>}
    </div>
  );
}

/** Case-insensitive shelf name filter shared by ShelfGroup and the shelf's
 *  no-match empty state, so both agree on what "matching" means. */
function qShelfMatch(refs: GraphRef[], query: string): GraphRef[] {
  const q = query.trim().toLowerCase();
  return q ? refs.filter((r) => r.name.toLowerCase().includes(q)) : refs;
}

/** One collapsible category in the side reference shelf. Collapsed state is
 *  persisted per production + category name (mirrors the references panel).
 *  Only the first SHELF_PAGE matching tiles render; the rest load behind a
 *  Show-more button so large groups don't mount hundreds of rows at once.
 *  A just-saved reference (`highlightId`) forces its group open and scrolls
 *  its tile into view, regardless of the persisted collapsed/page state. */
function ShelfGroup({ prodId, group, query, onCanvasRefIds, highlightId, onDismissHighlight, onZoom }: {
  prodId: string;
  group: { title: string; refs: GraphRef[] };
  query: string;
  onCanvasRefIds: ReadonlySet<string>;
  /** Reference id to reveal + pulse (a just-saved reference), or null. */
  highlightId?: string | null;
  /** Clear the reveal highlight once the user has seen/acted on it. */
  onDismissHighlight?: () => void;
  /** Open a tile's full-res media in the lightbox. */
  onZoom: (ref: GraphRef) => void;
}) {
  const [collapsed, setCollapsed] = usePersistedCollapsed(
    `cascade.prod.${prodId}.graph.shelf.${group.title}`,
    group.refs.length > SHELF_AUTO_COLLAPSE_AT,
  );
  const [shown, setShown] = useState(SHELF_PAGE);
  // Mount this group's tiles only once it nears the shelf viewport. A project
  // with many small categories (each under the auto-collapse/window size) would
  // otherwise mount every tile at once — the group count, not just the per-
  // group size, has to be bounded. Headers always render so the list is
  // navigable; the tile bodies fill in on scroll.
  const rootRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (revealed) return;
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setRevealed(true); return; }
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setRevealed(true); io.disconnect(); } },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [revealed]);
  const matching = qShelfMatch(group.refs, query);
  const q = query.trim().toLowerCase();
  useEffect(() => { setShown(SHELF_PAGE); }, [q, group.refs]);
  // Scroll the freshly-saved tile into view once (keyed on the highlight id, so
  // re-renders don't keep yanking the shelf back). Declared before the early
  // return so hook order stays stable.
  const highlightEl = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (highlightId && highlightEl.current && typeof highlightEl.current.scrollIntoView === "function") {
      highlightEl.current.scrollIntoView({ block: "nearest" });
    }
  }, [highlightId]);
  if (q && matching.length === 0) return null;
  // A just-saved reference must be visible even if its group was collapsed or
  // its tile sits past the page window — force it open and extend the window.
  const highlightIndex = highlightId ? matching.findIndex((r) => r.id === highlightId) : -1;
  const hasHighlight = highlightIndex >= 0;
  const open = hasHighlight || !collapsed;
  const showTiles = hasHighlight || revealed;
  const visible = matching.slice(0, hasHighlight ? Math.max(shown, highlightIndex + 1) : shown);
  return (
    <div ref={rootRef} className="prod-graph-shelf-group">
      <button
        className="prod-graph-shelf-group-head"
        aria-expanded={open}
        title={collapsed ? `Show ${group.title}` : `Hide ${group.title}`}
        onClick={() => { onDismissHighlight?.(); setCollapsed(open); }}
      >
        <svg className={"prod-graph-shelf-caret" + (open ? "" : " collapsed")} viewBox="0 0 16 16" width="9" height="9" aria-hidden="true"><path d="M5 3l6 5-6 5V3z" fill="currentColor" /></svg>
        <span className="prod-graph-shelf-group-name">{group.title}</span>
        <span className="prod-graph-shelf-count">{q ? `${matching.length}/${group.refs.length}` : group.refs.length}</span>
      </button>
      {open && showTiles && (
        <div className="prod-graph-shelf-tiles">
          {visible.map((r) => {
            const onCanvas = onCanvasRefIds.has(r.id);
            const highlighted = r.id === highlightId;
            return (
              <div
                key={r.id}
                ref={highlighted ? highlightEl : undefined}
                className={"prod-graph-shelf-item" + (onCanvas ? " on-canvas" : "") + (highlighted ? " highlight" : "")}
                draggable={!onCanvas}
                title={onCanvas ? "Already on the canvas" : `Drag onto the canvas to add @[${r.name}]`}
                onMouseEnter={highlighted ? onDismissHighlight : undefined}
                onDragStart={(e) => {
                  if (highlighted) onDismissHighlight?.();
                  e.dataTransfer.setData("application/x-cascade-ref", r.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                {r.artwork
                  ? <ShelfThumb src={r.artwork} alt={r.name} />
                  : <div className="prod-graph-shelf-blank">{r.media === "video" ? "▶" : r.media === "audio" ? "♪" : "?"}</div>}
                <span className="prod-graph-shelf-name" title={`Reference @[${r.name}]`}>@[{r.name}]</span>
                {onCanvas && <span className="prod-graph-shelf-check">on canvas</span>}
                {(r.artwork || (r.media === "video" && r.mediaPath)) && (
                  <button
                    type="button"
                    className="prod-graph-shelf-zoom nodrag"
                    title="View full resolution"
                    draggable={false}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (highlighted) onDismissHighlight?.(); onZoom(r); }}
                  >
                    <MagnifyIcon size={11} />
                  </button>
                )}
              </div>
            );
          })}
          {matching.length > visible.length && (
            <button
              className="prod-graph-shelf-more nodrag"
              onClick={() => setShown((n) => n + SHELF_PAGE)}
            >
              Show more ({matching.length - visible.length} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

const REF_X = 0;
const REF_W = 236;
const REF_STEP = 128;
/** Untagged refs live in the leftmost column; tagged refs get their own
 *  column one step right, closer to the prompt node. */
const TAGGED_X = REF_W + 56;
const COMPOSER_X = 620;
const IMGGEN_X = 1080;
const EDITGEN_X = 1320;
const VIDGEN_X = 1520;
const OUTPUT_X = 1960;
const STYLE_STEP = 96;
/** Top of the reference band: the style node sits above it, brand below. */
const REF_COL_TOP = 20 + STYLE_STEP;
/** Node ids that always exist regardless of prompt/reference content. The video
 *  and edit tool nodes (videogen/videoprompt/editgen/editprompt) are optional —
 *  dragged out from the right panel on demand. */
const STRUCTURAL_IDS = ["composer", "style", "brand", "output", "imagegen"];
/** Edge strokes match the input-socket colors (see styles.css). */
const SOCKET_COLORS = { ref: "var(--graph-socket-ref)", style: "var(--graph-socket-style)", brand: "var(--graph-socket-brand)" } as const;

/** Column layout, mirroring the prompt node's input order: style node at the
 *  top of the left column, reference nodes in the middle (untagged placed refs
 *  in the left column, tagged refs one column closer to the prompt), brand at
 *  the bottom. User-dragged positions override these defaults. */
function defaultPosition(id: string, availIds: string[], taggedIds: string[]): { x: number; y: number } {
  const band = Math.max(availIds.length, taggedIds.length) * REF_STEP;
  const midY = Math.max(20, REF_COL_TOP + band / 2);
  if (id === "style") return { x: REF_X, y: 20 };
  if (id === "brand") return { x: REF_X, y: REF_COL_TOP + band + 16 };
  if (id === "composer") return { x: COMPOSER_X, y: Math.max(20, midY - 140) };
  if (id === "imagegen") return { x: IMGGEN_X, y: Math.max(20, midY - 170) };
  // Edit node pairs stack downward; each node's gen sits above its prompt.
  const em = /^edit(gen|prompt):edit(\d+)$/.exec(id);
  if (em) {
    const i = Number(em[2]);
    const isPrompt = em[1] === "prompt";
    return { x: EDITGEN_X, y: Math.max(20, midY - 170 + i * 240 + (isPrompt ? 120 : 0)) };
  }
  if (id === "editprompt") return { x: EDITGEN_X, y: Math.max(20, midY + 140) };
  if (id === "editgen") return { x: EDITGEN_X, y: Math.max(20, midY - 170) };
  if (id === "videoprompt") return { x: VIDGEN_X, y: Math.max(20, midY + 140) };
  if (id === "videogen") return { x: VIDGEN_X, y: Math.max(20, midY - 190) };
  // Additional video nodes stack below the first so they don't overlap.
  const vidNodeId = parseVideoGenNode(id) ?? parseVideoPromptNode(id);
  if (vidNodeId) {
    const n = Number(vidNodeId.replace(/^vid/, "")) || 0;
    const isPrompt = id.startsWith("videoprompt");
    return { x: VIDGEN_X, y: Math.max(20, (isPrompt ? midY + 140 : midY - 190) + n * 170) };
  }
  if (id === "tween") return { x: VIDGEN_X, y: Math.max(20, midY + 180) };
  if (id === "editvideo") return { x: VIDGEN_X + 360, y: Math.max(20, midY - 190) };
  if (id === "cameraGrid") return { x: VIDGEN_X + 360, y: Math.max(20, midY + 220) };
  if (id === "upscale") return { x: VIDGEN_X + 720, y: Math.max(20, midY - 190) };
  if (id === "output") return { x: OUTPUT_X, y: Math.max(20, midY - 150) };
  const availIdx = availIds.indexOf(id);
  if (availIdx >= 0) return { x: REF_X, y: REF_COL_TOP + availIdx * REF_STEP };
  const taggedIdx = taggedIds.indexOf(id);
  if (taggedIdx >= 0) return { x: TAGGED_X, y: REF_COL_TOP + taggedIdx * REF_STEP };
  return { x: REF_X, y: 20 };
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

export function NodeGraphModal({ prod, shot, bust, prompt, references, styles, styleValue, includeBrand, magicActive = false, magicBusy = false, onToggleMagic, onRegenMagic, onRegenMagicShot, imageModels, videoModels, endFrameModelIds = null, upscaleUnavailable = false, videoEditUnavailable = false, defaultImageModel, defaultImageResolution, initialLayout, onPromptChange, onStyleChange, onToggleBrand, onDropFile, onPasteFiles, onStyleDetached, onRunImageGen, onRunVideoGen, onRunEditGen, onRunEditVideo = async () => {}, onRunCameraGrid = async () => {}, onImportCameraGridImage = async () => null, onExportCameraGrid = async () => null, onRunUpscale = async () => {}, onRunTweenBlock = async () => {}, onStitchTween = async () => {}, onUnstitchTween = async () => {}, onFetchVideo = async () => {}, imageGenBusy = false, videoBusyNodeIds = [], editVideoBusy = false, editBusyNodeIds = [], busyTweenBlock = null, tweenStitching = false, onSelectGraphGen, onCycleGraphGen, onDeleteGeneration = () => {}, onSaveAsReference = () => {}, onSaveGenerationAsReference = async () => null, onEditNodePrompt = () => {}, onRenameRef, onGraphField, onPipeImageToVideo, onPipeEditToVideo = () => {}, onPipeRefToVideo = () => {}, onPipeImageToOutput, onPipeVideoToOutput, onPipeTweenToOutput = () => {}, onPipeEditVideoToOutput = () => {}, onPipeUpscaleToOutput = () => {}, onPipeEditToOutput, onPipeRefToOutput, onTweenRefs = () => {}, onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeTweenGen = () => {}, onUnpipeEditGen, onUnpipeOutput, onSaveLayout, onClose, readOnly = false, onDetach }: {
  prod: Production;
  shot: ProductionShot;
  /** Renderer content key — bumped when frames regenerate so the output thumbnail refetches. */
  bust: number;
  prompt: string;
  references: GraphRef[];
  styles: ProductionStyle[];
  styleValue: string;
  includeBrand: boolean;
  /** Magic Prompt state — mirrors the storyboard toggle; the composer shows
   *  the rainbow border while active. */
  magicActive?: boolean;
  magicBusy?: boolean;
  onToggleMagic?: () => void;
  /** Regenerate Magic Prompts for ALL shots. */
  onRegenMagic?: () => void;
  /** Regenerate only THIS shot's Magic content prompt. */
  onRegenMagicShot?: () => void;
  /** Previously saved canvas state for this shot (positions + viewport). */
  initialLayout?: GraphLayout;
  onPromptChange: (value: string) => void;
  onStyleChange: (style: string) => void;
  onToggleBrand: (include: boolean) => void;
  /** A media file dropped onto the canvas — becomes a reference in the parent.
   *  Resolves to the created reference so the graph can place its node. (Paste
   *  prefers onPasteFiles; this is its fallback.) */
  onDropFile: (file: File) => Promise<GraphRef | null> | void;
  /** A batch of pasted files. The parent names them (auto-numbered, Ref-001…)
   *  so clipboard pastes never collide, and resolves to the created refs so the
   *  graph places a node for each. Falls back to onDropFile when absent. */
  onPasteFiles?: (files: File[]) => Promise<GraphRef[]> | void;
  /** The style link was detached: the parent clears the shot's style flag so
   *  the storyboard dropdown shows None. */
  onStyleDetached: () => void;
  /** Image/video-capable OpenArt models for the generation nodes. */
  imageModels: OpenArtModelChoice[];
  videoModels: OpenArtModelChoice[];
  /** Ids of the video models that accept a dedicated end-frame slot (live
   *  probe ∪ the user's manual allowlist) — the tween node/modal offer ONLY
   *  these. Null means the probe is still pending, so the full video list
   *  shows until it resolves. */
  endFrameModelIds?: string[] | null;
  /** The active provider has no upscale path (OpenArt MCP) — the upscale node
   *  can't be added and its palette entry is disabled with an explanatory hint. */
  upscaleUnavailable?: boolean;
  /** Active provider has no video-edit path (OpenArt MCP/CLI) — the
   *  edit-video node is disabled, like the upscale node under OpenArt MCP. */
  videoEditUnavailable?: boolean;
  /** Defaults from the production's OpenArt config for the image node. */
  defaultImageModel: string;
  defaultImageResolution: string;
  /** Run the image generation node (prompt = the composer's text). */
  onRunImageGen: (model: string, resolution: string, params?: GenParams) => Promise<void>;
  /** Run the video generation node (prompt = the video-prompt node). */
  onRunVideoGen: (nodeId: string, model: string, resolution: string, durationSec: number, params?: GenParams) => Promise<void>;
  /** Run an edit-image node (prompt = that node's edit-prompt node). */
  onRunEditGen: (nodeId: string, model: string, resolution: string, params?: GenParams) => Promise<void>;
  /** Run the edit-video node (source/refs come from its wired sockets). */
  onRunEditVideo?: (model: string, prompt: string, params?: GenParams) => Promise<void>;
  /** Generate (or regenerate) the camera-grid sheet in place. */
  onRunCameraGrid?: (opts: CameraGridGenOptions) => Promise<void>;
  /** Import a wired image as the camera-grid sheet to cut up (the manual
   *  fallback). Main writes the copy and returns its references-relative path. */
  onImportCameraGridImage?: (source: GraphSource) => Promise<CameraGridImportResult | null>;
  /** Upscale the upscale node's source image (source/wiring come from the node). */
  onRunUpscale?: (model: string, resolution: string, params?: GenParams) => Promise<void>;
  /** Crop marqueed camera-grid panels into references; resolves to the created
   *  refs so the graph can place them as nodes. */
  onExportCameraGrid?: (req: CameraGridCutoutRequest) => Promise<GraphRef[] | null>;
  /** Generate one in-betweener action block's clip (prompt = the block's;
   *  durationSec = the block's displayed length, so the submit never races a
   *  pending retime save). */
  onRunTweenBlock?: (blockId: string, durationSec: number, model: string, params?: GenParams) => Promise<void>;
  /** Stitch every action block's selected clip into the continuous shot. */
  onStitchTween?: () => Promise<void>;
  /** Undo a stitch — back to the individual block clips (toggle on Stitch). */
  onUnstitchTween?: () => Promise<void>;
  /** Recheck a shot's pending video job (any flow) and download/apply the clip. */
  onFetchVideo?: () => Promise<void>;
  /** Lifted in-flight flags so "Generating…" survives the modal unmounting
   *  (the workspace owns them per shot). */
  imageGenBusy?: boolean;
  /** Video node ids currently generating for this shot (per-node busy). */
  videoBusyNodeIds?: string[];
  /** The edit-video node is generating for this shot (workspace-owned). */
  editVideoBusy?: boolean;
  /** Edit node ids currently generating for this shot (per-node busy). */
  editBusyNodeIds?: string[];
  /** The in-betweener block currently generating (workspace-owned). */
  busyTweenBlock?: string | null;
  /** True while a stitch/unstitch runs (workspace-owned). */
  tweenStitching?: boolean;
  /** Select a generation node's stored output by index (edit kind names its node). */
  onSelectGraphGen: (kind: "image" | "video" | "edit" | "editvideo" | "upscale", index: number, nodeId?: string) => void;
  /** Cycle a generation node's stored outputs (edit kind names its node). */
  onCycleGraphGen: (kind: "image" | "video" | "edit" | "editvideo" | "upscale", dir: 1 | -1, nodeId?: string) => void;
  /** Permanently delete a stored take (right-click). The workspace confirms
   *  and blocks takes that still feed a pipe/output. */
  onDeleteGeneration?: (rel: string) => void;
  /** Copy a stored take into the production as a new reference (right-click). */
  onSaveAsReference?: (rel: string) => void;
  /** Copy a stored take into the production as a new reference and resolve the
   *  created reference, so dragging a generation output onto a prompt's
   *  reference socket can wire the new node in place. */
  onSaveGenerationAsReference?: (rel: string) => Promise<GraphRef | null>;
  /** Update one edit node's prompt text. */
  onEditNodePrompt?: (nodeId: string, text: string) => void;
  /** Rename a reference from its canvas node (main rewrites its `@[name]` tags
   *  across every prompt store atomically, like the Design page). */
  onRenameRef?: (refId: string, name: string) => void;
  /** Merge shot-level graph fields (video prompt text, cycle index, pipes). */
  onGraphField: (patch: Partial<ProductionShot>) => void;
  /** Pipe the image node's output into a video node's image input. */
  onPipeImageToVideo: (nodeId: string) => void;
  /** Pipe an edit-image node's output into a video node's image input
   *  (replacing whatever else feeds it). */
  onPipeEditToVideo?: (nodeId: string, sourceNodeId: string) => void;
  /** Pipe a reference image into a video node's image input. */
  onPipeRefToVideo?: (nodeId: string, refId: string) => void;
  /** Pipe the image node's output into the output (and apply its selection). */
  onPipeImageToOutput: () => void;
  /** Pipe a video node's output into the output (and apply its selection). */
  onPipeVideoToOutput: (nodeId: string) => void;
  /** Pipe the in-betweener's stitched clip into the output (and apply it). */
  onPipeTweenToOutput?: () => void;
  /** Pipe the edit-video node's selected clip into the output (and apply it). */
  onPipeEditVideoToOutput?: () => void;
  /** Pipe the upscale node's selected output into the output node. */
  onPipeUpscaleToOutput?: () => void;
  /** Pipe an edit-image node's output into the output (and apply its selection). */
  onPipeEditToOutput: (nodeId: string) => void;
  /** Pipe a reference node's output into the output (applies its media to the shot). */
  onPipeRefToOutput: (refId: string) => void;
  /** Replace the in-betweener's ordered keyframe ref ids. */
  onTweenRefs?: (refIds: string[]) => void;
  /** Unbind the image node's output entirely (video feed + any output feed). */
  onUnpipeImageGen: () => void;
  /** Unbind the image node from a video node's image input only. */
  onUnpipeImageToVideo: (nodeId: string) => void;
  /** Unbind the video node's output. */
  onUnpipeVideoGen: () => void;
  /** Unbind the in-betweener node's output. */
  onUnpipeTweenGen?: () => void;
  /** Unbind an edit-image node's output. */
  onUnpipeEditGen: (nodeId: string) => void;
  /** Unbind whatever feeds the output. */
  onUnpipeOutput: () => void;
  /** Persist part of the canvas state (positions and/or viewport). */
  onSaveLayout: (layout: GraphLayout) => void;
  onClose: () => void;
  /** The graph is being edited in the detached canvas window — show a banner
   *  and block canvas interaction here to prevent concurrent lost updates. */
  readOnly?: boolean;
  /** "Pop out" the graph into the detached canvas window (absent in the
   *  detached window itself, which cannot detach again). */
  onDetach?: () => void;
}) {
  const saveLayoutRef = useRef(onSaveLayout);
  saveLayoutRef.current = onSaveLayout;
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [shelfQuery, setShelfQuery] = useState("");
  // The reference shelf starts collapsed so opening the graph doesn't mount (and
  // thumbnail-encode) every reference in the production. Toggling it open loads
  // the shelf on demand.
  const [shelfOpen, setShelfOpen] = useState(false);
  // Shelf width is per-production UI state (localStorage, like the group
  // collapsed flags); past SHELF_GRID_WIDTH the tiles wrap into a grid.
  const [shelfWidth, setShelfWidth] = usePersistedNumber(
    `cascade.prod.${prod.meta.id}.graph.shelfWidth`,
    SHELF_DEFAULT_WIDTH,
    { min: SHELF_MIN_WIDTH, max: SHELF_MAX_WIDTH },
  );
  /** A just-saved reference tile to pulse + scroll into view, until the user
   *  hovers it or acts elsewhere. */
  const [highlightRefId, setHighlightRefId] = useState<string | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ name: string; artwork: string; kind?: "image" | "video"; rel?: string } | null>(null);
  /** Right-click menu for the enlarged generation in the lightbox. */
  const lightboxMenu = useGenerationMenu();
  /** In-betweener timeline window (stacked above the graph). */
  const [tweenOpen, setTweenOpen] = useState(false);
  /** Full-res camera-grid panel editor popup (stacked above the graph). */
  const [cameraGridEditorOpen, setCameraGridEditorOpen] = useState(false);
  /** In-flight tween state is workspace-owned (see props) so the timeline's
   *  "Generating…"/"Stitching…" labels survive closing and reopening. */
  const busyBlock = busyTweenBlock ?? null;
  const stitching = tweenStitching === true;
  const hintTimer = useRef<number | null>(null);
  /** React Flow instance (captured on init) — used to map drop coordinates. */
  const flowRef = useRef<{ screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number } } | null>(null);
  /** Ref ids deleted this session (keyboard/trash). Keeps a deleted tagged node
   *  from being re-added by the reconcile effect while the parent's async prompt
   *  save is still in flight; re-dragging from the shelf clears the entry. */
  const removedRefIdsRef = useRef<Set<string>>(new Set());
  /** Reference nodes collapsed to a name + thumb tile (persisted in the layout). */
  const collapsedRef = useRef<Record<string, boolean>>({ ...(initialLayout?.collapsed ?? {}) });
  /** Expanded size stashed while a ref node is collapsed, so expanding restores
   *  the user's width/height instead of the collapsed tile's size. */
  const refExpandedSize = useRef<Record<string, { width: number; height?: number }>>({});
  /** Paste stagger — each pasted reference lands offset from the last so a
   *  multi-image paste doesn't stack every node on the same point. */
  const pasteCountRef = useRef(0);

  const showHint = useCallback((message: string) => {
    setDropHint(message);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setDropHint(null), 4000);
  }, []);

  /** Open the reference shelf, clear any filter, and pulse/scroll the given
   *  reference tile — used when a take is saved as a reference. The highlight
   *  stays until the user hovers the tile or acts elsewhere (see
   *  `dismissHighlight`), so the saved reference never disappears before the
   *  user finds it. */
  const revealShelfRef = useCallback((refId: string) => {
    setShelfQuery("");
    setShelfOpen(true);
    setHighlightRefId(refId);
  }, []);

  const dismissHighlight = useCallback(() => setHighlightRefId(null), []);

  /** Drag the shelf's right edge to resize it (pointer capture so the drag
   *  survives leaving the thin handle). Width persists per production. */
  const shelfResize = useRef<{ startX: number; startW: number } | null>(null);
  const onShelfResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    shelfResize.current = { startX: e.clientX, startW: shelfWidth };
  };
  const onShelfResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = shelfResize.current;
    if (r) setShelfWidth(r.startW + (e.clientX - r.startX));
  };
  const onShelfResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!shelfResize.current) return;
    shelfResize.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // Escape closes the lightbox first, then the graph. When a stacked dialog
  // (video generation, tween timeline) is open above the graph, it owns Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (lightbox) { setLightbox(null); return; }
      if (document.querySelector(".prod-video-overlay")) return;
      if (document.querySelector(".prod-tween-overlay")) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, lightbox]);

  // Output thumbnail: fetched lazily, refetched when the frame changes.
  useEffect(() => {
    let live = true;
    setThumbnail(null);
    if (shot.artwork) {
      window.cascade.boardThumbnail(prod.meta.id, shot.id).then((d) => { if (live) setThumbnail(d ?? null); }).catch(() => {});
    }
    return () => { live = false; };
  }, [prod.meta.id, shot.id, shot.artwork, bust]);

  // Displayed prompt texts render shared sections AND reference tags from the
  // stored graph (step 05): the stored fields hold content only. Tag edits and
  // drafts flow through these values; saves strip shared sections back to
  // content-only.
  const editVideoPromptValue = renderShotPrompt(prod, shot, "editvideoprompt");
  const videoNodes = useMemo<GraphVideoNode[]>(() => {
    const list = videoNodesFor(shot);
    if (list.length) return list;
    // A saved layout position alone implies a placed (empty) node, mirroring
    // the materializer's layout-derived presence.
    const p = initialLayout?.positions ?? {};
    if (p.videogen || p.videoprompt) return [{ id: "vid0", prompt: "" }];
    return list;
  }, [shot, initialLayout]);
  /** Per-video-node RENDERED motion prompt keyed by node id (shared sections +
   *  reference tags; the stored node prompt holds content only). Empty node
   *  prompts fall back to the video-motion template. */
  const videoPromptValues = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of videoNodes) {
      m.set(n.id, renderShotPrompt(prod, { ...shot, graphVideoPrompt: (n.prompt ?? "").trim() ? n.prompt : getPromptTemplate("videoMotion") }, { videoprompt: n.id }));
    }
    return m;
  }, [videoNodes, prod, shot]);
  /** The first video node's rendered prompt (back-compat convenience). */
  const videoPromptValue = videoPromptValues.get("vid0") ?? renderShotPrompt(prod, { ...shot, graphVideoPrompt: getPromptTemplate("videoMotion") }, "videoprompt");
  const editNodes = useMemo(() => shot.graphEditNodes ?? [], [shot.graphEditNodes]);
  /** Per-edit-node RENDERED prompt text keyed by node id (shared sections +
   *  reference tags from the plugged references; the stored node prompt holds
   *  content only). */
  const editPromptValues = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of editNodes) {
      m.set(n.id, renderShotPrompt(prod, shot, { editprompt: n.id }));
    }
    return m;
  }, [editNodes, prod, shot]);
  /** Every tag cited across all edit prompts (feeds the union ref set). */
  const taggedEditNames = useMemo(
    () => [...new Set(editNodes.flatMap((n) => refTagNames(n.prompt ?? "")))],
    [editNodes],
  );
  /** Tagged refs (name + match) for one edit node, in prompt order. */
  const taggedEditByNode = useMemo(() => {
    const m = new Map<string, { name: string; ref: GraphRef | null }[]>();
    for (const n of editNodes) {
      const names = refTagNames(n.prompt ?? "");
      m.set(n.id, names.map((name) => ({ name, ref: references.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null })));
    }
    return m;
  }, [editNodes, references]);

  const taggedNames = useMemo(
    () => refTagNames(prompt),
    [prompt],
  );
  /** Tagged refs (name + match) for one video node, in its prompt order. */
  const taggedVideoByNode = useMemo(() => {
    const m = new Map<string, { name: string; ref: GraphRef | null }[]>();
    for (const n of videoNodes) {
      const names = refTagNames(videoPromptValues.get(n.id) ?? n.prompt ?? "");
      m.set(n.id, names.map((name) => ({ name, ref: references.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null })));
    }
    return m;
  }, [videoNodes, videoPromptValues, references]);
  /** Union of tag names across every video node's prompt (feeds the union ref
   *  set + reference-node presence). */
  const taggedVideoNames = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of videoNodes) for (const name of refTagNames(videoPromptValues.get(n.id) ?? n.prompt ?? "")) {
      const lc = name.toLowerCase();
      if (!seen.has(lc)) { seen.add(lc); out.push(name); }
    }
    return out;
  }, [videoNodes, videoPromptValues]);

  // Tagged refs in prompt order; dangling tags (no matching ref) render as
  // "missing" so the user can see and clean them up. Image prompt drives the
  // original `tagged` list; video has its own per-prompt list, edit nodes map
  // per node id (see taggedEditByNode).
  const tagged = useMemo(
    () => taggedNames.map((name) => ({
      name,
      ref: references.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null,
    })),
    [taggedNames, references],
  );
  const taggedVideo = useMemo(
    () => taggedVideoNames.map((name) => ({
      name,
      ref: references.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null,
    })),
    [taggedVideoNames, references],
  );
  const taggedEditVideoNames = useMemo(() => refTagNames(editVideoPromptValue), [editVideoPromptValue]);
  const taggedEditVideo = useMemo(
    () => taggedEditVideoNames.map((name) => ({
      name,
      ref: references.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null,
    })),
    [taggedEditVideoNames, references],
  );

  // Union of all tags across the prompts — every reference that appears
  // in ANY prompt gets a node (tagged); untagged references are NOT
  // auto-populated. They live in the side shelf until the user drags one onto
  // the canvas (see `placedRefIds` below), keeping the tray complete while each
  // prompt node's sockets are driven by its own tag list. Edit-video tags are
  // included (the stored graph cannot hold their edges otherwise — previously
  // those edges pointed at a ghost node).
  const unionTagged = useMemo(() => {
    const seen = new Set<string>();
    const out: { name: string; ref: GraphRef | null }[] = [];
    for (const name of [...taggedNames, ...taggedVideoNames, ...taggedEditNames, ...taggedEditVideoNames]) {
      const lc = name.toLowerCase();
      if (seen.has(lc)) continue;
      seen.add(lc);
      out.push({ name, ref: references.find((r) => r.name.toLowerCase() === lc) ?? null });
    }
    return out;
  }, [taggedNames, taggedVideoNames, taggedEditNames, taggedEditVideoNames, references]);

  const unionKey = useMemo(() => new Set(unionTagged.map((t) => (t.ref?.id ? t.ref.id : `missing:${t.name.toLowerCase()}`))), [unionTagged]);

  // Reference nodes are NOT auto-populated for every reference. Tagged refs
  // (present in some prompt) always get nodes so their edges show; every other
  // reference lives in the side shelf and the user drags one onto the canvas
  // to place it. A placed ref keeps its node (and saved position) until it's
  // removed, even while untagged.
  const taggedRefIds = useMemo(() => {
    const out = new Set<string>();
    for (const t of unionTagged) if (t.ref?.id) out.add(t.ref.id);
    return out;
  }, [unionTagged]);
  const [placedRefIds, setPlacedRefIds] = useState<Set<string>>(() => {
    const out = new Set<string>();
    for (const id of Object.keys(initialLayout?.positions ?? {})) {
      const m = /^ref:(.+)$/.exec(id);
      if (m) out.add(m[1]);
    }
    return out;
  });
  // Untagged refs currently on the canvas (placed but not tagged in any prompt)
  // — they get nodes like available refs did, but only because they're placed.
  const available = useMemo(
    () => references.filter((r) => placedRefIds.has(r.id) && !taggedRefIds.has(r.id)),
    [references, placedRefIds, taggedRefIds],
  );
  // Shelf items already on the canvas (tagged or placed) are marked + not draggable.
  const onCanvasRefIds = useMemo(() => {
    const out = new Set(placedRefIds);
    for (const t of unionTagged) if (t.ref?.id) out.add(t.ref.id);
    return out;
  }, [placedRefIds, unionTagged]);

  // The video-generation and in-betweener nodes are NOT auto-populated either —
  // they live as tiles in the right panel and the user drags one out on demand.
  // Edit-image nodes exist exactly when the shot's `graphEditNodes` list has
  // entries (classic edits append to it; the panel drags out new ones).
  /** Whether one video node holds data (clips, prompt, source, refs, or the
   *  output feed) — such a node can't be removed without clearing it. */
  const videoNodeInUse = (n: GraphVideoNode): boolean =>
    !!((n.gens?.length ?? 0) > 0 || (n.prompt ?? "").trim() || n.source || (n.refIds?.length ?? 0) > 0 || shot.graphOutputSource === "videogen");
  const videoGenActive = videoNodes.some(videoNodeInUse);
  /** The in-betweener is in use while it holds keyframes, blocks, a stitch,
   *  or the output feed — like the video/edit tools, it can't be removed then. */
  const tweenActive = !!((shot.graphTweenRefIds?.length ?? 0) > 0 || (shot.graphTweenBlocks?.length ?? 0) > 0 || shot.graphTweenOutput || shot.graphOutputSource === "tween");
  /** The edit-video node is in use while it holds clips, a source, params, or
   *  the output feed — like the other tools, it can't be removed then. */
  const editVideoActive = !!((shot.graphEditVideoGens?.length ?? 0) > 0 || (shot.graphEditVideoPrompt ?? "").trim() || shot.graphEditVideoSourceRefId || shot.graphVideoToEditVideo || shot.graphEditVideoParams || shot.graphOutputSource === "editvideo");
  /** The camera-grid node is in use while it holds a generated sheet — like the
   *  other tools, it can't be removed then. Wiring/picks alone don't block
   *  removal (removing clears them). */
  const cameraGridActive = !!shot.graphCameraGrid?.sheetPath;
  /** The upscale node is in use while it holds outputs or feeds the output —
   *  like the other tools, it can't be removed then. Wiring/picks alone don't
   *  block removal (removing clears them). */
  const upscaleActive = !!((shot.graphUpscale?.gens?.length ?? 0) > 0 || shot.graphOutputSource === "upscale");
  const [placedTools, setPlacedTools] = useState<Set<string>>(() => {
    const out = new Set<string>();
    const p = initialLayout?.positions ?? {};
    if (p.videogen || p.videoprompt) { out.add("videogen"); out.add("videoprompt"); }
    if (p.tween) { out.add("tween"); }
    if (p.editvideo || p.editvideoprompt) { out.add("editvideo"); out.add("editvideoprompt"); }
    if (p.cameraGrid) { out.add("cameraGrid"); }
    if (p.upscale) { out.add("upscale"); }
    return out;
  });
  const hasVideoTool = videoNodes.length > 0;
  const hasEditTool = editNodes.length > 0;
  const hasTweenTool = tweenActive || placedTools.has("tween");
  const hasEditVideoTool = editVideoActive || placedTools.has("editvideo");
  const hasCameraGridTool = cameraGridActive || placedTools.has("cameraGrid");
  const hasUpscaleTool = upscaleActive || placedTools.has("upscale");
  // Which models actually accept a video input (the edit-video capability
  // probe). Empty for providers without a video-edit path.
  const [videoEditModelIds, setVideoEditModelIds] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    const api = (window as unknown as { cascade?: { videoEditModels?: () => Promise<string[]> } }).cascade;
    if (!api || typeof api.videoEditModels !== "function") { setVideoEditModelIds([]); return () => { live = false; }; }
    void api.videoEditModels().then((ids) => { if (live) setVideoEditModelIds(ids ?? []); }).catch(() => { if (live) setVideoEditModelIds([]); });
    return () => { live = false; };
  }, []);
  // Which image models upscale (the capability probe ∪ `image:upscale` surface
  // assignments). Empty for providers with no upscale path. Refreshed when the
  // Model Customizer changes provider/surfaces.
  const [upscaleModelIds, setUpscaleModelIds] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    const api = (window as unknown as { cascade?: { imageUpscaleModels?: () => Promise<string[]> } }).cascade;
    if (!api || typeof api.imageUpscaleModels !== "function") { setUpscaleModelIds([]); return () => { live = false; }; }
    const load = () => {
      void api.imageUpscaleModels!().then((ids) => { if (live) setUpscaleModelIds(ids ?? []); }).catch(() => { if (live) setUpscaleModelIds([]); });
    };
    load();
    window.addEventListener("cascade:media-provider-changed", load);
    return () => { live = false; window.removeEventListener("cascade:media-provider-changed", load); };
  }, []);

  // The side shelf shows every reference organized by category (characters,
  // products, custom categories) — reusing the same deduped flat list the tags
  // resolve against, just grouped for browsing.
  const shelfGroups = useMemo(() => {
    const catOf = new Map<string, string>();
    for (const c of prod.characters ?? []) if (c.id) catOf.set(c.id, "Characters");
    for (const p of prod.products ?? []) if (p.id) catOf.set(p.id, "Products");
    const catName = new Map<string, string>();
    for (const c of prod.referenceCategories ?? []) catName.set(c.id, c.name);
    for (const r of prod.references ?? []) if (r.id) catOf.set(r.id, catName.get(r.categoryId ?? "") ?? "References");
    const byTitle = new Map<string, GraphRef[]>();
    const titles: string[] = [];
    const groupFor = (title: string): GraphRef[] => {
      let refs = byTitle.get(title);
      if (!refs) { refs = []; byTitle.set(title, refs); titles.push(title); }
      return refs;
    };
    for (const r of references) groupFor(catOf.get(r.id) ?? "References").push(r);
    const rank = (t: string) => t === "Characters" ? 0 : t === "Products" ? 1 : t === "References" ? 2 : 3;
    titles.sort((a, b) => rank(a) - rank(b));
    return titles.map((title) => ({ title, refs: byTitle.get(title)! }));
  }, [references, prod]);

  const availIds = useMemo(() => available.map((r) => `ref:${r.id}`), [available]);
  const taggedIds = useMemo(() => unionTagged.map((t, i) => `ref:${t.ref?.id ?? "missing-" + i}`), [unionTagged]);

  // Node callbacks change identity every parent render; routing them through
  // a ref keeps node data (and node object identities) stable across renders,
  // which keeps React Flow's selection bookkeeping from fighting re-renders.
  const cb = useRef({ graph: shot.graph, prodId: prod.meta.id, shotId: shot.id, onPromptChange, onStyleChange, onToggleBrand, prompt, videoPromptValue, videoNodes, videoPromptValues, taggedVideoByNode, editPromptValues, editNodes, setLightbox, styles, styleValue, initialLayout, onStyleDetached, onRunImageGen, onRunVideoGen, onRunEditGen, onRunEditVideo, onRunCameraGrid, onImportCameraGridImage, onExportCameraGrid, onEditNodePrompt, onRenameRef, onRunTweenBlock, onStitchTween, onFetchVideo, onSelectGraphGen, onCycleGraphGen, onDeleteGeneration, onSaveAsReference, onSaveGenerationAsReference, onGraphField, onPipeImageToVideo, onPipeEditToVideo, onPipeRefToVideo, onPipeImageToOutput, onPipeVideoToOutput, onPipeTweenToOutput, onPipeEditVideoToOutput, onPipeUpscaleToOutput, onPipeEditToOutput, onPipeRefToOutput, onTweenRefs, onOpenTweenTimeline: () => setTweenOpen(true), onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeTweenGen, onUnpipeEditGen, onUnpipeOutput, references, graphStyleConnected: shot.graphStyleConnected, graphVideoStyleConnected: shot.graphVideoStyleConnected, graphVideoNodes: shot.graphVideoNodes, graphOutputVideoNodeId: shot.graphOutputVideoNodeId, graphEditNodes: shot.graphEditNodes, graphOutputSource: shot.graphOutputSource, graphOutputRefId: shot.graphOutputRefId, graphOutputEditNodeId: shot.graphOutputEditNodeId, graphEditToVideo: shot.graphEditToVideo, graphVideoSourceRefId: shot.graphVideoSourceRefId, graphVideoSourceEditNodeId: shot.graphVideoSourceEditNodeId, graphTweenRefIds: shot.graphTweenRefIds, graphEditVideoSourceRefId: shot.graphEditVideoSourceRefId, graphVideoToEditVideo: shot.graphVideoToEditVideo, graphEditVideoPrompt: shot.graphEditVideoPrompt, graphCameraGrid: shot.graphCameraGrid, graphUpscale: shot.graphUpscale, onRunUpscale });
  cb.current = { graph: shot.graph, prodId: prod.meta.id, shotId: shot.id, onPromptChange, onStyleChange, onToggleBrand, prompt, videoPromptValue, videoNodes, videoPromptValues, taggedVideoByNode, editPromptValues, editNodes, setLightbox, styles, styleValue, initialLayout, onStyleDetached, onRunImageGen, onRunVideoGen, onRunEditGen, onRunEditVideo, onRunCameraGrid, onImportCameraGridImage, onExportCameraGrid, onEditNodePrompt, onRenameRef, onRunTweenBlock, onStitchTween, onFetchVideo, onSelectGraphGen, onCycleGraphGen, onDeleteGeneration, onSaveAsReference, onSaveGenerationAsReference, onGraphField, onPipeImageToVideo, onPipeEditToVideo, onPipeRefToVideo, onPipeImageToOutput, onPipeVideoToOutput, onPipeTweenToOutput, onPipeEditVideoToOutput, onPipeUpscaleToOutput, onPipeEditToOutput, onPipeRefToOutput, onTweenRefs, onOpenTweenTimeline: () => setTweenOpen(true), onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeTweenGen, onUnpipeEditGen, onUnpipeOutput, references, graphStyleConnected: shot.graphStyleConnected, graphVideoStyleConnected: shot.graphVideoStyleConnected, graphVideoNodes: shot.graphVideoNodes, graphOutputVideoNodeId: shot.graphOutputVideoNodeId, graphEditNodes: shot.graphEditNodes, graphOutputSource: shot.graphOutputSource, graphOutputRefId: shot.graphOutputRefId, graphOutputEditNodeId: shot.graphOutputEditNodeId, graphEditToVideo: shot.graphEditToVideo, graphVideoSourceRefId: shot.graphVideoSourceRefId, graphVideoSourceEditNodeId: shot.graphVideoSourceEditNodeId, graphTweenRefIds: shot.graphTweenRefIds, graphEditVideoSourceRefId: shot.graphEditVideoSourceRefId, graphVideoToEditVideo: shot.graphVideoToEditVideo, graphEditVideoPrompt: shot.graphEditVideoPrompt, graphCameraGrid: shot.graphCameraGrid, graphUpscale: shot.graphUpscale, onRunUpscale };
  // Live-draft handles registered by the three prompt nodes (see
  // PromptDraftApplier). Prompt mutations below prefer them over cb.current's
  // prop values, which lag the node's local draft while it is focused.
  const appliers = useRef<Record<string, PromptDraftApplier | undefined>>({});
  /** Replace one video node immutably in the shot's `graphVideoNodes` list. */
  const patchVideoNode = (nodeId: string, patch: Partial<GraphVideoNode>): void => {
    cb.current.onGraphField({ graphVideoNodes: (cb.current.graphVideoNodes ?? []).map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) });
  };
  /** Apply a prompt transform to the live draft when one exists; returns true
   *  when handled (the applier emitted upstream itself). */
  const applyDraftEdit = (kind: string, fn: (t: string) => string): boolean => {
    const a = appliers.current[kind];
    if (!a) return false;
    a.apply(fn);
    return true;
  };
  const stable = useRef({
    onPromptChange: (value: string) => cb.current.onPromptChange(value),
    onStyleChange: (style: string) => {
      // Selection persists; every plugged box re-renders from the library on
      // next read. No draft rewrite: blur-sync stores stripped content, so a
      // stale Style paragraph can never resurrect.
      cb.current.onStyleChange(style);
    },
    onToggleBrand: (include: boolean) => cb.current.onToggleBrand(include),
    registerApplier: (kind: string, applier: PromptDraftApplier | undefined) => {
      if (applier) appliers.current[kind] = applier;
      else delete appliers.current[kind];
    },
    /** Rename a reference from its canvas node (Design-page semantics). */
    onRenameRef: (refId: string, name: string) => cb.current.onRenameRef?.(refId, name),
    /** Collapse/expand a reference node. Collapsing narrows the tile to a fixed
     *  compact width (its expanded width/height are stashed and kept in
     *  `GraphLayout.sizes`), then persists the collapsed set. */
    onToggleRefCollapsed: (nodeId: string, collapsed: boolean) => {
      collapsedRef.current = { ...collapsedRef.current, [nodeId]: collapsed };
      const next = nodesRef.current.map((n): GraphNode => {
        if (n.id !== nodeId) return n;
        const ref = n as RefFlowNode;
        const style = (ref.style ?? {}) as { width?: number; height?: number };
        if (collapsed) {
          const liveWidth = ref.width ?? ref.measured?.width ?? style.width ?? REF_DEFAULT_WIDTH;
          const liveHeight = ref.height ?? ref.measured?.height ?? style.height;
          refExpandedSize.current[nodeId] = { width: liveWidth, height: typeof liveHeight === "number" ? liveHeight : undefined };
          return { ...ref, width: undefined, height: undefined, style: { width: REF_COLLAPSED_WIDTH }, data: { ...ref.data, collapsed: true } };
        }
        const prev = refExpandedSize.current[nodeId];
        const saved = cb.current.initialLayout?.sizes?.[nodeId];
        const width = prev?.width ?? saved?.width ?? REF_DEFAULT_WIDTH;
        const height = prev?.height ?? saved?.height;
        return { ...ref, width, height, style: height ? { width, height } : { width }, data: { ...ref.data, collapsed: false } };
      });
      nodesRef.current = next;
      setNodes(next);
      saveLayoutRef.current({ collapsed: { ...collapsedRef.current } });
    },
    onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string) => cb.current.setLightbox({ name, artwork, kind, rel }),
    onRunImageGen: (model: string, resolution: string, params?: GenParams) => cb.current.onRunImageGen(model, resolution, params),
    onRunVideoGen: (nodeId: string, model: string, resolution: string, durationSec: number, params?: GenParams) => cb.current.onRunVideoGen(nodeId, model, resolution, durationSec, params),
    onRunEditGen: (nodeId: string, model: string, resolution: string, params?: GenParams) => cb.current.onRunEditGen(nodeId, model, resolution, params),
    onRunEditVideo: (model: string, prompt: string, params?: GenParams) => cb.current.onRunEditVideo?.(model, prompt, params) ?? Promise.resolve(),
    onFetchVideo: () => cb.current.onFetchVideo?.() ?? Promise.resolve(),
    onRunCameraGrid: (opts: CameraGridGenOptions) => cb.current.onRunCameraGrid?.(opts) ?? Promise.resolve(),
    /** Import a wired image as the camera-grid sheet, then bind it to the node
     *  (sheetPath + gridSource) so the editor can cut it up. */
    onImportCameraGridImage: async (source: GraphSource): Promise<CameraGridImportResult | null> => {
      const res = await cb.current.onImportCameraGridImage?.(source);
      if (res?.sheetPath) {
        const cur = normalizeCameraGridData(cb.current.graphCameraGrid) ?? { cols: CAMERA_GRID_COLS, rows: CAMERA_GRID_ROWS };
        cb.current.onGraphField({ graphCameraGrid: { ...cur, sheetPath: res.sheetPath, sheetAt: res.sheetAt, gridSource: source } });
      }
      return res;
    },
    /** Open the full-res camera-grid panel editor popup. */
    onOpenCameraGridEditor: () => setCameraGridEditorOpen(true),
    /** Persist a patch onto the shot's camera-grid node state. */
    onCameraGridSave: (patch: Partial<CameraGridData>) => {
      const cur = normalizeCameraGridData(cb.current.graphCameraGrid) ?? { cols: CAMERA_GRID_COLS, rows: CAMERA_GRID_ROWS };
      cb.current.onGraphField({ graphCameraGrid: { ...cur, ...patch } });
    },
    onRunUpscale: (model: string, resolution: string, params?: GenParams) => cb.current.onRunUpscale?.(model, resolution, params) ?? Promise.resolve(),
    /** Persist a patch onto the shot's upscale node state. */
    onUpscaleSave: (patch: Partial<UpscaleData>) => {
      cb.current.onGraphField({ graphUpscale: { ...(cb.current.graphUpscale ?? {}), ...patch } });
    },
    /** Export marqueed panels, then place the created refs as canvas nodes. */
    /** Export marqueed panels, place the created refs as canvas nodes, and
     *  reveal the first in the shelf. Returns the created refs (empty when the
     *  export produced none). */
    onExportCameraGridPanels: async (sheetPath: string, rects: CameraGridPanel[], labels: string[], single: boolean): Promise<GraphRef[]> => {
      const refs = await cb.current.onExportCameraGrid?.({
        productionId: cb.current.prodId,
        shotId: cb.current.shotId,
        nodeId: "cameraGrid",
        sheetPath,
        rects,
        labels,
        single,
      });
      if (!refs?.length) return [];
      placeExportedRefs(refs);
      revealShelfRef(refs[0].id);
      return refs;
    },
    onOpenTweenTimeline: () => cb.current.onOpenTweenTimeline(),
    onSelectImageGen: (index: number) => cb.current.onSelectGraphGen("image", index),
    onSelectVideoGen: (nodeId: string, index: number) => cb.current.onSelectGraphGen("video", index, nodeId),
    onSelectEditGen: (nodeId: string, index: number) => cb.current.onSelectGraphGen("edit", index, nodeId),
    onSelectEditVideoGen: (index: number) => cb.current.onSelectGraphGen("editvideo", index),
    onSelectUpscaleGen: (index: number) => cb.current.onSelectGraphGen("upscale", index),
    onCycleImageGen: (dir: 1 | -1) => cb.current.onCycleGraphGen("image", dir),
    onCycleVideoGen: (nodeId: string, dir: 1 | -1) => cb.current.onCycleGraphGen("video", dir, nodeId),
    onCycleEditGen: (nodeId: string, dir: 1 | -1) => cb.current.onCycleGraphGen("edit", dir, nodeId),
    onCycleEditVideoGen: (dir: 1 | -1) => cb.current.onCycleGraphGen("editvideo", dir),
    onCycleUpscaleGen: (dir: 1 | -1) => cb.current.onCycleGraphGen("upscale", dir),
    onDeleteGen: (rel: string) => cb.current.onDeleteGeneration(rel),
    /** Seed a take as the Image Suite's edit source (the "Before edit" frame). */
    onEditInSuite: (rel: string) => openImageSuite(cb.current.prodId, { mode: "edit", sourcePath: rel }),
    /** Save a take as a reference: prefer the resolver that hands back the
     *  created ref so the shelf can open, then pulse its tile; fall back to the
     *  fire-and-forget save when no resolver is wired. */
    onSaveAsRef: (rel: string) => {
      void (async () => {
        const saved = await cb.current.onSaveGenerationAsReference(rel);
        if (saved) revealShelfRef(saved.id);
        else cb.current.onSaveAsReference(rel);
      })();
    },
    /** Open a shelf tile's full-res media in the lightbox (the tile itself
     *  shows the compressed `?thumb=1` image). */
    onShelfRefZoom: (ref: GraphRef) => {
      const isVideo = ref.media === "video" && !!ref.mediaPath;
      const url = isVideo ? graphMediaUrl(prod.meta.id, ref.mediaPath!) : ref.artwork;
      if (url) cb.current.setLightbox({ name: ref.name, artwork: url, kind: isVideo ? "video" : "image", rel: ref.mediaPath });
    },
    onModelOptions: (model: string, withImage: boolean) => {
      const key = `${model}|${withImage ? 1 : 0}`;
      const cached = videoOptionsCache.get(key);
      if (cached !== undefined) return Promise.resolve(cached);
      return window.cascade.videoModelOptions(model, withImage).then((o) => {
        videoOptionsCache.set(key, o);
        return o;
      }).catch(() => null);
    },
    /** The model's full option schema for the Advanced panel. Degrades to
     *  null when the provider has no schema or the IPC isn't present (tests). */
    onModelSchema: (model: string) => {
      const cached = modelSchemaCache.get(model);
      if (cached !== undefined) return Promise.resolve(cached);
      const api = (window as unknown as { cascade?: { modelOptions?: (m: string) => Promise<CliModelSchema | null> } }).cascade;
      if (!api || typeof api.modelOptions !== "function") return Promise.resolve(null);
      return api.modelOptions(model).then((s) => {
        modelSchemaCache.set(model, s);
        return s;
      }).catch(() => null);
    },
    onVideoPromptChange: (nodeId: string, text: string) => patchVideoNode(nodeId, { prompt: stripSharedSections(text) }),
    onEditVideoPromptChange: (text: string) => cb.current.onGraphField({ graphEditVideoPrompt: stripSharedSections(text) }),
    /** Per-node video-gen selections (model/resolution/length) → the node. */
    onSaveVideoFields: (nodeId: string, patch: Partial<GraphVideoNode>) => patchVideoNode(nodeId, patch),
    /** Per-shot image-gen params → the shot (image node advanced panel). */
    onSaveImageFields: (patch: Partial<ProductionShot>) => cb.current.onGraphField(patch),
    /** Per-shot edit-video selections → the shot. */
    onSaveEditVideoFields: (patch: Partial<ProductionShot>) => cb.current.onGraphField(patch),
    /** Per-node edit-gen selections → the named edit node in the list. */
    onEditNodeSave: (nodeId: string, patch: Partial<GraphEditNode>) =>
      cb.current.onGraphField({ graphEditNodes: (cb.current.graphEditNodes ?? []).map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) }),
    onEditPromptChange: (nodeId: string, text: string) => cb.current.onEditNodePrompt(nodeId, stripSharedSections(text)),
    onPipeImageToVideo: (nodeId: string) => cb.current.onPipeImageToVideo(nodeId),
    onPipeEditToVideo: (nodeId: string, sourceNodeId: string) => cb.current.onPipeEditToVideo?.(nodeId, sourceNodeId),
    onPipeRefToVideo: (nodeId: string, refId: string) => cb.current.onPipeRefToVideo?.(nodeId, refId),
    onPipeImageToOutput: () => cb.current.onPipeImageToOutput(),
    onPipeVideoToOutput: (nodeId: string) => cb.current.onPipeVideoToOutput(nodeId),
    onPipeTweenToOutput: () => cb.current.onPipeTweenToOutput(),
    onPipeEditVideoToOutput: () => cb.current.onPipeEditVideoToOutput?.(),
    onPipeEditToOutput: (nodeId: string) => cb.current.onPipeEditToOutput(nodeId),
    onPipeRefToOutput: (refId: string) => cb.current.onPipeRefToOutput(refId),
    onTweenRefs: (refIds: string[]) => cb.current.onTweenRefs(refIds),
    onUnpipeImageGen: () => cb.current.onUnpipeImageGen(),
    onUnpipeImageToVideo: (nodeId: string) => cb.current.onUnpipeImageToVideo(nodeId),
    onUnpipeVideoGen: () => cb.current.onUnpipeVideoGen(),
    onUnpipeTweenGen: () => cb.current.onUnpipeTweenGen(),
    onUnpipeEditGen: (nodeId: string) => cb.current.onUnpipeEditGen(nodeId),
    onUnpipeOutput: () => cb.current.onUnpipeOutput(),
  }).current;

  /** Place a reference dragged from the side shelf onto the canvas: creates an
   *  untagged ref node at the drop position and persists it in the layout. */
  const addPlacedRef = useCallback((ref: GraphRef, pos: { x: number; y: number }) => {
    const id = `ref:${ref.id}`;
    if (nodesRef.current.some((n) => n.id === id)) {
      showHint(`@[${ref.name}] is already on the canvas.`);
      return;
    }
    removedRefIdsRef.current.delete(ref.id);
    const collapsed = collapsedRef.current[id] === true;
    const node: RefFlowNode = {
      id,
      type: "ref",
      position: pos,
      style: refSizeStyle(cb.current.initialLayout, id, collapsed),
      data: {
        name: ref.name,
        artwork: ref.artwork,
        media: ref.media,
        mediaUrl: ref.media === "video" && ref.mediaPath ? graphMediaUrl(prod.meta.id, ref.mediaPath) : undefined,
        tagged: false,
        refId: ref.id,
        collapsed,
        onToggleCollapse: stable.onToggleRefCollapsed,
        onRename: stable.onRenameRef,
        onZoom: stable.onZoom,
      },
      deletable: true,
    };
    const next = [...nodesRef.current, node];
    nodesRef.current = next;
    setNodes(next);
    setPlacedRefIds((prev) => { const n = new Set(prev); n.add(ref.id); return n; });
    saveLayoutRef.current({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
    // Stored graph mirrors the placement (see header note).
    const gcur = cb.current.graph;
    if (gcur) saveGraph(addGraphNode(gcur, { id, kind: "ref", pos: { ...pos }, data: { label: ref.name } }));
    showHint(`@[${ref.name}] added to the canvas — connect it to a prompt, the edit source, or the output.`);
  }, [showHint, stable, prod.meta.id]);

  /** Place camera-grid exports as reference nodes near the grid node, so the
   *  new refs are immediately usable on the canvas. */
  function placeExportedRefs(refs: GraphRef[]) {
    const base = nodesRef.current.find((n) => n.id === "cameraGrid")?.position ?? { x: 0, y: 0 };
    refs.forEach((ref, i) => addPlacedRef(ref, { x: base.x - 300, y: base.y + i * 150 }));
  }

  /** Build the in-betweener node (single node — its prompts live in the
   *  timeline modal). Shared by buildDerived and addTool. */
  const tweenNode = useCallback((pos: { x: number; y: number }): TweenFlowNode => {
    const refIds = (shot.graphTweenRefIds ?? []).slice(0, 5);
    const byId = new Map(references.map((r) => [r.id, r]));
    const displayBlocks = deriveTweenBlocksClient(refIds, shot.graphTweenBlocks ?? []);
    const ready = displayBlocks.filter((b) => b.gens?.[b.genIndex ?? 0]?.path).length;
    return {
      id: "tween",
      type: "tween",
      position: pos,
      data: {
        refIds,
        keyframes: tweenKeyframesFor(shot, prod.meta.id, refIds, byId),
        blockCount: displayBlocks.length,
        readyBlocks: ready,
        stitched: !!shot.graphTweenOutput,
        reencoded: shot.graphTweenReencoded === true,
        onOpenTimeline: stable.onOpenTweenTimeline,
      },
      deletable: true,
    };
  }, [shot.graphTweenRefIds, shot.graphTweenBlocks, shot.graphTweenOutput, shot.graphTweenReencoded, shot.graphImageGens, shot.graphImageGenIndex, shot.graphEditNodes, references, stable]);

  /** The 16-panel camera-grid generator node. Shared by buildDerived/addTool. */
  const cameraGridNode = useCallback((pos: { x: number; y: number }): CameraGridFlowNode => {
    const grid = normalizeCameraGridData(shot.graphCameraGrid);
    const cols = grid?.cols ?? CAMERA_GRID_COLS;
    const rows = grid?.rows ?? CAMERA_GRID_ROWS;
    const panels = resolveCameraGridPanels({ cols, rows, panels: grid?.panels });
    const panelLabels = resolvePanelLabels(cols * rows, grid?.panelLabels);
    const src = grid?.source;
    const sourceLabel = src
      ? src.kind === "imagegen" ? "Image node frame"
      : src.kind === "editgen" ? `Edit node ${editNodeLabel(src.nodeId)}`
      : references.find((r) => r.id === src.refId)?.name ?? "Reference"
      : null;
    const gridSrc = grid?.gridSource;
    const gridSourceLabel = gridSrc
      ? gridSrc.kind === "imagegen" ? "Image node frame"
      : gridSrc.kind === "editgen" ? `Edit node ${editNodeLabel(gridSrc.nodeId)}`
      : references.find((r) => r.id === gridSrc.refId)?.name ?? "Reference"
      : null;
    return {
      id: "cameraGrid",
      type: "cameraGrid",
      position: pos,
      style: fixedWidth(320),
      data: {
        sheetUrl: grid?.sheetPath ? graphMediaUrl(prod.meta.id, grid.sheetPath) : null,
        sheetPath: grid?.sheetPath,
        cols,
        rows,
        panels,
        panelLabels,
        generation: grid?.generation,
        models: imageModels.filter((m) => modelOnSurface(m, "image:generate")),
        savedModel: grid?.model,
        savedResolution: grid?.resolution,
        savedParams: grid?.params,
        defaultModel: defaultImageModel,
        defaultResolution: defaultImageResolution,
        productionQuality: prod.openArt?.quality,
        sourceLabel,
        gridSourceLabel,
        refIds: grid?.refIds ?? [],
        onOpenEditor: stable.onOpenCameraGridEditor,
        onSave: stable.onCameraGridSave,
        onGenerate: stable.onRunCameraGrid,
        onModelSchema: stable.onModelSchema,
        onZoom: stable.onZoom,
      },
      deletable: true,
    };
  }, [shot.graphCameraGrid, prod, references, imageModels, defaultImageModel, defaultImageResolution, stable]);

  /** The upscale generator node (one per shot). Shared by buildDerived/addTool. */
  const upscaleNode = useCallback((pos: { x: number; y: number }): UpscaleFlowNode => {
    const node = shot.graphUpscale;
    const src = node?.source;
    const sourceHint = src?.kind === "imagegen"
      ? "piped frame"
      : src?.kind === "editgen"
        ? `edit ${src.nodeId}`
        : src?.kind === "ref"
          ? (references.find((r) => r.id === src.refId)?.name ?? "reference")
          : "shot frame";
    let sourceRefId: string | undefined;
    let sourcePath: string | undefined;
    if (src?.kind === "ref") {
      sourceRefId = src.refId;
    } else if (src?.kind === "imagegen") {
      sourcePath = (shot.graphImageGens ?? [])[shot.graphImageGenIndex ?? 0]?.path ?? shot.artwork;
    } else if (src?.kind === "editgen") {
      const other = (shot.graphEditNodes ?? []).find((n) => n.id === src.nodeId);
      sourcePath = (other?.gens ?? [])[other?.genIndex ?? 0]?.path;
    } else {
      sourcePath = shot.artwork;
    }
    const allowed = new Set(upscaleModelIds ?? []);
    return {
      id: "upscale",
      type: "upscale",
      position: pos,
      style: fixedWidth(300),
      data: {
        models: imageModels.filter((m) => allowed.has(m.id)),
        savedModel: node?.model,
        savedResolution: node?.resolution,
        savedParams: node?.params,
        defaultModel: defaultImageModel,
        defaultResolution: defaultImageResolution,
        productionQuality: prod.openArt?.quality,
        items: (node?.gens ?? []).map((g) => ({ url: graphMediaUrl(prod.meta.id, g.path), prompt: g.prompt, path: g.path })),
        selected: node?.genIndex ?? 0,
        sourceHint,
        ...(sourceRefId ? { sourceRefId } : {}),
        ...(!sourceRefId && sourcePath ? { sourcePath } : {}),
        productionId: prod.meta.id,
        onGenerate: stable.onRunUpscale,
        onSelect: stable.onSelectUpscaleGen,
        onCycle: stable.onCycleUpscaleGen,
        onDeleteGen: stable.onDeleteGen,
        onSaveAsRef: stable.onSaveAsRef,
        onEditInSuite: stable.onEditInSuite,
        onSave: stable.onUpscaleSave,
        onModelSchema: stable.onModelSchema,
        onZoom: stable.onZoom,
      },
      deletable: true,
    };
  }, [shot.graphUpscale, shot.graphImageGens, shot.graphImageGenIndex, shot.graphEditNodes, shot.artwork, references, imageModels, upscaleModelIds, defaultImageModel, defaultImageResolution, prod.openArt?.quality, prod.meta.id, stable]);

  /** The edit-video node: a video-edit model + a mandatory source clip +
   *  optional references. Only models that declare a video input are offered. */
  const editVideoNode = useCallback((pos: { x: number; y: number }): EditVideoFlowNode => {
    const editModels = videoModels.filter(
      (m) => modelOnSurface(m, "video:editnode") && (videoEditModelIds ?? []).includes(m.id)
    );
    const sourceRef = shot.graphEditVideoSourceRefId
      ? references.find((r) => r.id === shot.graphEditVideoSourceRefId)
      : undefined;
    const sourceLabel = shot.graphVideoToEditVideo
      ? "Video node clip"
      : sourceRef
        ? `Reference: ${sourceRef.name}`
        : null;
    return {
      id: "editvideo",
      type: "editvideo",
      position: pos,
      style: fixedWidth(320),
      data: {
        models: editModels,
        savedModel: shot.graphEditVideoModel,
        savedParams: shot.graphEditVideoParams,
        savedPrompt: shot.graphEditVideoPrompt,
        sourceLabel,
        items: (shot.graphEditVideoGens ?? []).map((g) => ({ url: graphMediaUrl(prod.meta.id, g.path), prompt: g.prompt, path: g.path })),
        selected: shot.graphEditVideoGenIndex ?? 0,
        busy: editVideoBusy === true,
        piped: shot.graphOutputSource === "editvideo",
        pending: shot.pendingVideoGen?.target?.kind === "editVideoNode",
        onFetch: stable.onFetchVideo,
        onGenerate: stable.onRunEditVideo,
        onSelect: stable.onSelectEditVideoGen,
        onCycle: stable.onCycleEditVideoGen,
        onDeleteGen: stable.onDeleteGen,
        onSaveAsRef: stable.onSaveAsRef,
        onEditInSuite: stable.onEditInSuite,
        onSave: stable.onSaveEditVideoFields,
        onPipeToOutput: stable.onPipeEditVideoToOutput,
        onModelSchema: stable.onModelSchema,
        onZoom: stable.onZoom,
      },
      deletable: true,
    };
  }, [videoModels, videoEditModelIds, shot.graphEditVideoSourceRefId, shot.graphVideoToEditVideo, shot.graphEditVideoModel, shot.graphEditVideoParams, shot.graphEditVideoPrompt, shot.graphEditVideoGens, shot.graphEditVideoGenIndex, shot.graphOutputSource, shot.pendingVideoGen, references, prod.meta.id, editVideoBusy, stable]);

  /** The edit-video tool: the gen node + its prompt node (mirrors the video
   *  node pair). Shared by buildDerived and addTool. */
  const editVideoPair = useCallback((genPos: { x: number; y: number }, promptPos: { x: number; y: number }): GraphNode[] => {
    return [
      editVideoNode(genPos),
      {
        id: "editvideoprompt",
        type: "editvideoprompt",
        position: promptPos,
        data: {
          value: editVideoPromptValue,
          refHandles: taggedEditVideo.map((_, i) => `in-ref-${i}`),
          openHandleId: "in-ref-open",
          includeBrand: isBrandAttached(shot, "editvideoprompt", editVideoPromptValue),
          onChange: stable.onEditVideoPromptChange,
          registerApplier: (a) => stable.registerApplier("editvideo", a),
        },
        deletable: true,
      },
    ];
  }, [editVideoNode, editVideoPromptValue, taggedEditVideo, stable]);

  /** Build one video node's generator. Node ids carry its stable id. */
  const videoGenNodeFor = useCallback((node: GraphVideoNode, genPos: { x: number; y: number }): VideoGenFlowNode => {
    const pendingTarget = shot.pendingVideoGen?.target;
    return {
      id: videoGenNodeId(node.id),
      type: "videogen",
      position: genPos,
      style: fixedWidth(300),
      data: {
        nodeId: node.id,
        models: videoModels.filter((m) => modelOnSurface(m, "video:generate")),
        savedModel: node.model,
        savedResolution: node.resolution,
        savedDurationSec: node.durationSec,
        savedParams: node.params,
        items: (node.gens ?? []).map((g) => ({ url: graphMediaUrl(prod.meta.id, g.path), prompt: g.prompt, path: g.path })),
        selected: node.genIndex ?? 0,
        hasImageSource: !!node.source,
        busy: videoBusyNodeIds.includes(node.id),
        pending: pendingTarget?.kind === "videoNode" && (pendingTarget.nodeId ?? "vid0") === node.id,
        onFetch: stable.onFetchVideo,
        onGenerate: stable.onRunVideoGen,
        onSelect: stable.onSelectVideoGen,
        onCycle: stable.onCycleVideoGen,
        onDeleteGen: stable.onDeleteGen,
        onSaveAsRef: stable.onSaveAsRef,
        onEditInSuite: stable.onEditInSuite,
        onModelOptions: stable.onModelOptions,
        onModelSchema: stable.onModelSchema,
        onSaveFields: stable.onSaveVideoFields,
        onZoom: stable.onZoom,
        label: videoNodeLabel(node.id),
      },
      deletable: true,
    };
  }, [videoModels, videoBusyNodeIds, shot.pendingVideoGen, taggedVideoByNode, stable, prod.meta.id]);

  /** Build one video node's prompt node. */
  const videoPromptNodeFor = useCallback((node: GraphVideoNode, promptPos: { x: number; y: number }): GraphNode => {
    const value = videoPromptValues.get(node.id) ?? node.prompt ?? "";
    const tagged = taggedVideoByNode.get(node.id) ?? [];
    return {
      id: videoPromptNodeId(node.id),
      type: "videoprompt",
      position: promptPos,
      data: { nodeId: node.id, value, refHandles: tagged.map((_, i) => `in-ref-${i}`), openHandleId: "in-ref-open", includeBrand: isBrandAttached(shot, { videoprompt: node.id }, value), onChange: stable.onVideoPromptChange, registerApplier: (a) => stable.registerApplier(videoApplierKey(node.id), a) },
      deletable: true,
    };
  }, [videoPromptValues, taggedVideoByNode, shot, stable]);

  /** Build the video node pair (videogen+videoprompt) at the given positions. */
  const videoPair = useCallback((node: GraphVideoNode, genPos: { x: number; y: number }, promptPos: { x: number; y: number }): GraphNode[] => [
    videoGenNodeFor(node, genPos),
    videoPromptNodeFor(node, promptPos),
  ], [videoGenNodeFor, videoPromptNodeFor]);

  /** Build one edit node's gen+prompt pair. `editNode` supplies its prompt and
   *  generation history; node ids carry its stable id (`editgen:edit0`). */
  const editPair = useCallback((editNode: GraphEditNode, genPos: { x: number; y: number }, promptPos: { x: number; y: number }): GraphNode[] => {
    const tagged = taggedEditByNode.get(editNode.id) ?? [];
    // Mirror the style node's live text here too (not just in editPromptValues)
    // so the rendered Style box, the edges, and generation all see one prompt.
    const promptValue = editPromptValues.get(editNode.id) ?? (editNode.prompt ?? "");
    const src = editNode.source;
    const sourceHint = src?.kind === "imagegen"
      ? "piped frame"
      : src?.kind === "editgen"
        ? `edit ${src.nodeId}`
        : src?.kind === "ref"
          ? (references.find((r) => r.id === src.refId)?.name ?? "reference")
          : "shot frame";
    // Resolve the same source the submit path uses, so "Open in Suite" can
    // hand it over as a reference id or a production-relative frame path.
    let sourceRefId: string | undefined;
    let sourcePath: string | undefined;
    if (src?.kind === "ref") {
      sourceRefId = src.refId;
    } else if (src?.kind === "imagegen") {
      sourcePath = (shot.graphImageGens ?? [])[shot.graphImageGenIndex ?? 0]?.path ?? shot.artwork;
    } else if (src?.kind === "editgen") {
      const other = (shot.graphEditNodes ?? []).find((n) => n.id === src.nodeId);
      sourcePath = (other?.gens ?? [])[other?.genIndex ?? 0]?.path;
    } else {
      sourcePath = shot.artwork;
    }
    return [
      {
        id: editGenNodeId(editNode.id),
        type: "editgen",
        position: genPos,
        style: fixedWidth(300),
        data: {
          nodeId: editNode.id,
          models: imageModels.filter((m) => modelOnSurface(m, "image:edit")),
          defaultResolution: prod.openArt?.resolution ?? "1k",
          savedModel: editNode.model,
          savedResolution: editNode.resolution,
          savedParams: editNode.params,
          productionQuality: prod.openArt?.quality,
          items: (editNode.gens ?? []).map((g) => ({ url: graphMediaUrl(prod.meta.id, g.path), prompt: g.prompt, path: g.path })),
          selected: editNode.genIndex ?? 0,
          sourceHint,
          productionId: prod.meta.id,
          prompt: promptValue,
          ...(sourceRefId ? { sourceRefId } : {}),
          ...(!sourceRefId && sourcePath ? { sourcePath } : {}),
          busy: editBusyNodeIds.includes(editNode.id),
          onGenerate: stable.onRunEditGen,
          onSelect: (index: number) => stable.onSelectEditGen(editNode.id, index),
          onCycle: (dir: 1 | -1) => stable.onCycleEditGen(editNode.id, dir),
          onDeleteGen: stable.onDeleteGen,
          onSaveAsRef: stable.onSaveAsRef,
          onEditInSuite: stable.onEditInSuite,
          onSave: (patch) => stable.onEditNodeSave(editNode.id, patch),
          onModelSchema: stable.onModelSchema,
          onZoom: stable.onZoom,
        },
        deletable: true,
      },
      {
        id: editPromptNodeId(editNode.id),
        type: "editprompt",
        position: promptPos,
        data: { nodeId: editNode.id, value: promptValue, refHandles: tagged.map((_, i) => `in-ref-${i}`), openHandleId: "in-ref-open", includeBrand: isBrandAttached(shot, { editprompt: editNode.id }, promptValue), onChange: stable.onEditPromptChange, registerApplier: (a) => stable.registerApplier(`edit:${editNode.id}`, a) },
        deletable: true,
      },
    ];
  }, [imageModels, prod.openArt?.resolution, prod.openArt?.quality, prod.meta.id, references, taggedEditByNode, editPromptValues, editBusyNodeIds, stable]);

  /** Place a tool dragged from the right panel at the drop point. Video lands
   *  as a gen+prompt pair, the in-betweener as a single node, and edit appends
   *  a new edit node to the shot's list. */
  const addTool = useCallback((kind: "video" | "edit" | "tween" | "editvideo" | "cameraGrid" | "upscale", pos: { x: number; y: number }) => {
    const genPos = { x: pos.x, y: pos.y };
    const promptPos = { x: pos.x - 400, y: pos.y };
    if (kind === "upscale") {
      if (upscaleUnavailable) { showHint(UPSCALE_UNAVAILABLE_HINT); return; }
      if (hasUpscaleTool) { showHint("The upscale node is already on the canvas."); return; }
      const node = upscaleNode(genPos);
      const next = [...nodesRef.current, node];
      nodesRef.current = next;
      setNodes(next);
      setPlacedTools((prev) => { const n = new Set(prev); n.add("upscale"); return n; });
      saveLayoutRef.current({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
      const gcur = cb.current.graph;
      if (gcur) saveGraph(addGraphNode(gcur, { id: "upscale", kind: "upscale", pos: { ...genPos } }));
      showHint("Upscale node added — wire a source image in (or use the shot's frame), pick an upscale model, then upscale.");
      return;
    }
    if (kind === "cameraGrid") {
      if (hasCameraGridTool) { showHint("The camera grid node is already on the canvas."); return; }
      const node = cameraGridNode(genPos);
      const next = [...nodesRef.current, node];
      nodesRef.current = next;
      setNodes(next);
      setPlacedTools((prev) => { const n = new Set(prev); n.add("cameraGrid"); return n; });
      saveLayoutRef.current({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
      const gcur = cb.current.graph;
      if (gcur) saveGraph(addGraphNode(gcur, { id: "cameraGrid", kind: "cameraGrid", pos: { ...genPos } }));
      showHint("Camera grid added — wire a source frame in (and optional references), then generate a 4×4 sheet and marquee panels to export them as references.");
      return;
    }
    if (kind === "edit") {
      const nodeId = nextEditNodeId(editNodes);
      const pair = editPair({ id: nodeId, prompt: "" }, genPos, promptPos);
      const next = [...nodesRef.current, ...pair];
      nodesRef.current = next;
      setNodes(next);
      cb.current.onGraphField({ graphEditNodes: [...editNodes, { id: nodeId, prompt: "" }] });
      saveLayoutRef.current({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
      // Stored graph mirrors the placement (see header note).
      const gcur = cb.current.graph;
      if (gcur) {
        let g = addGraphNode(gcur, { id: editGenNodeId(nodeId), kind: "editgen", pos: { ...genPos } });
        g = addGraphNode(g, { id: editPromptNodeId(nodeId), kind: "editprompt", pos: { ...promptPos } });
        saveGraph(ensurePromptPipe(g, editGenNodeId(nodeId)));
      }
      showHint("Edit-image node added — connect a source and an edit prompt, then edit.");
      return;
    }
    if (kind === "editvideo") {
      if (videoEditUnavailable) { showHint(VIDEO_EDIT_UNAVAILABLE_HINT); return; }
      if (hasEditVideoTool) { showHint("The edit-video node is already on the canvas."); return; }
      const pair = editVideoPair(genPos, promptPos);
      const next = [...nodesRef.current, ...pair];
      nodesRef.current = next;
      setNodes(next);
      setPlacedTools((prev) => { const n = new Set(prev); n.add("editvideo"); n.add("editvideoprompt"); return n; });
      saveLayoutRef.current({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
      const gcur = cb.current.graph;
      if (gcur) {
        let g = addGraphNode(gcur, { id: "editvideo", kind: "editvideo", pos: { ...genPos } });
        g = addGraphNode(g, { id: "editvideoprompt", kind: "editvideoprompt", pos: { ...promptPos } });
        saveGraph(ensurePromptPipe(g, "editvideo"));
      }
      showHint("Edit-video node added — wire a source clip and write the edit in its prompt node.");
      return;
    }
    if (kind === "video") {
      // Video nodes are a list: dragging always appends a new one (like edit).
      const nodeId = nextVideoNodeId(videoNodes);
      const node: GraphVideoNode = { id: nodeId, prompt: "" };
      const pair = videoPair(node, genPos, promptPos);
      const next = [...nodesRef.current, ...pair];
      nodesRef.current = next;
      setNodes(next);
      cb.current.onGraphField({ graphVideoNodes: [...(cb.current.graphVideoNodes ?? []), node] });
      saveLayoutRef.current({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
      const gcur = cb.current.graph;
      if (gcur) {
        let g = addGraphNode(gcur, { id: videoGenNodeId(nodeId), kind: "videogen", pos: { ...genPos } });
        g = addGraphNode(g, { id: videoPromptNodeId(nodeId), kind: "videoprompt", pos: { ...promptPos } });
        saveGraph(ensurePromptPipe(g, videoGenNodeId(nodeId)));
      }
      showHint("Video generation node added — connect a frame or reference in, then generate.");
      return;
    }
    if (kind === "tween") {
      if (hasTweenTool) { showHint("The in-betweener node is already on the canvas."); return; }
      const pair: GraphNode[] = [tweenNode(genPos)];
      const next = [...nodesRef.current, ...pair];
      nodesRef.current = next;
      setNodes(next);
      setPlacedTools((prev) => { const n = new Set(prev); for (const node of pair) n.add(node.id); return n; });
      saveLayoutRef.current({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
      const gcur = cb.current.graph;
      if (gcur) {
        let g = gcur;
        for (const node of pair) {
          const nodeKind = nodeKindForId(node.id);
          if (nodeKind) g = addGraphNode(g, { id: node.id, kind: nodeKind, pos: { x: node.position.x, y: node.position.y } });
        }
        saveGraph(g);
      }
      showHint("In-betweener added — pipe 2–5 keyframes (references or generated frames) into its sockets, then open the timeline.");
    }
  }, [editNodes, videoNodes, hasTweenTool, hasEditVideoTool, hasCameraGridTool, hasUpscaleTool, upscaleUnavailable, videoEditUnavailable, showHint, editPair, videoPair, tweenNode, editVideoPair, cameraGridNode, upscaleNode]);

  /** Remove the placed video/tween/edit-video tool from the canvas (returns it
   *  to the right panel). Tools that are in use (generations/pipes/prompt) stay. */
  const removeTool = useCallback((kind: "video" | "tween" | "editvideo" | "cameraGrid" | "upscale") => {
    const ids = kind === "video" ? (cb.current.videoNodes ?? []).flatMap((n) => [videoGenNodeId(n.id), videoPromptNodeId(n.id)])
      : kind === "editvideo" ? ["editvideo", "editvideoprompt"]
      : [kind];
    if (kind === "video" ? videoGenActive : kind === "tween" ? tweenActive : kind === "cameraGrid" ? cameraGridActive : kind === "upscale" ? upscaleActive : editVideoActive) return;
    setPlacedTools((prev) => { const n = new Set(prev); for (const id of ids) n.delete(id); return n; });
    const next = nodesRef.current.filter((n) => !ids.includes(n.id));
    nodesRef.current = next;
    setNodes(next);
    saveLayoutRef.current({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
    // Stored graph mirrors the removal (see header note).
    const gcur = cb.current.graph;
    if (gcur) {
      let g = gcur;
      for (const id of ids) g = removeGraphNode(g, id);
      saveGraph(g);
    }
    // Removing the video tool drops every video node and the output feed when
    // it pointed at one.
    if (kind === "video") cb.current.onGraphField({ graphVideoNodes: [], ...(cb.current.graphOutputSource === "videogen" ? { graphOutputSource: undefined, graphOutputVideoNodeId: undefined, videoPath: undefined } : {}) });
    // Removing the camera-grid node drops its wiring/picks too (it holds no
    // sheet here — that would have blocked the removal).
    if (kind === "cameraGrid") cb.current.onGraphField({ graphCameraGrid: undefined });
    // Removing the upscale node drops its wiring/picks/output too (it holds no
    // generations here — those would have blocked the removal).
    if (kind === "upscale") cb.current.onGraphField({ graphUpscale: undefined, ...(cb.current.graphOutputSource === "upscale" ? { graphOutputSource: undefined, artwork: undefined } : {}) });
  }, [videoGenActive, tweenActive, editVideoActive, cameraGridActive, upscaleActive]);

  // Wiring truth: the stored graph. Pre-migration shots have no graph until
  // the ensure effect persists one — materialize in memory so the first paint
  // already matches, with no flash of an empty canvas.
  const fallbackGraph = useMemo(() => {
    if (shot.graph) return null;
    return normalizeGraph(materializeGraph(shot, references)).graph;
  }, [shot, references]);
  const wiringGraph = shot.graph ?? fallbackGraph;
  // A reference is "sourced" when it feeds a generation input rather than a
  // prompt reference socket: a source frame/clip, a tween keyframe, or the
  // output feed. Those nodes render opaque even without a prompt citation.
  const sourcedRefIds = useMemo(() => {
    const ids = new Set<string>();
    if (!wiringGraph) return ids;
    for (const e of wiringGraph.edges) {
      const m = /^ref:(.+)$/.exec(e.from.node);
      // Prompt reference sockets are tag-cited (the ref node shows as tagged);
      // the camera grid's reference sockets are inputs, so count them as sourced.
      if (!m || (REF_SOCKET_RE.test(e.to.port) && e.to.node !== "cameraGrid") || e.to.port === "in-style" || e.to.port === "in-brand") continue;
      ids.add(m[1]);
    }
    return ids;
  }, [wiringGraph]);

  const buildDerived = useCallback((): GraphNode[] => {
    const ORIGIN = { x: 0, y: 0 };
    const build = <T extends GraphNode>(node: T): T => ({ ...node, position: defaultPosition(node.id, availIds, taggedIds) });
    const visibleTagged = unionTagged.filter((t) => !(t.ref?.id && removedRefIdsRef.current.has(t.ref.id)));
    return [
      ...visibleTagged.map((t, i) => {
        const nodeId = `ref:${t.ref?.id ?? "missing-" + i}`;
        const collapsed = collapsedRef.current[nodeId] === true;
        return build({
          id: nodeId,
          type: "ref" as const,
          position: ORIGIN,
          style: refSizeStyle(initialLayout, nodeId, collapsed),
          data: {
            name: t.name,
            artwork: t.ref?.artwork ?? "",
            media: t.ref?.media,
            mediaUrl: t.ref?.media === "video" && t.ref?.mediaPath ? graphMediaUrl(prod.meta.id, t.ref.mediaPath) : undefined,
            missing: !t.ref,
            tagged: true,
            refId: t.ref?.id,
            collapsed,
            onToggleCollapse: stable.onToggleRefCollapsed,
            onRename: t.ref?.id ? stable.onRenameRef : undefined,
            onZoom: stable.onZoom,
          },
          deletable: true,
        });
      }),
      ...available.filter((r) => !removedRefIdsRef.current.has(r.id)).map((r) => {
        const nodeId = `ref:${r.id}`;
        const collapsed = collapsedRef.current[nodeId] === true;
        return build({
          // Same id scheme as tagged refs, so toggling a tag never moves the
          // node — only its edge and column default change.
          id: nodeId,
          type: "ref" as const,
          position: ORIGIN,
          style: refSizeStyle(initialLayout, nodeId, collapsed),
          data: { name: r.name, artwork: r.artwork, media: r.media, mediaUrl: r.media === "video" && r.mediaPath ? graphMediaUrl(prod.meta.id, r.mediaPath) : undefined, tagged: false, sourced: sourcedRefIds.has(r.id), refId: r.id, collapsed, onToggleCollapse: stable.onToggleRefCollapsed, onRename: stable.onRenameRef, onZoom: stable.onZoom },
          deletable: true,
        });
      }),
      build({
        id: "style",
        type: "style" as const,
        position: ORIGIN,
        data: { styles, value: styleValue, onChange: stable.onStyleChange },
        deletable: false,
      }),
      build({
        id: "brand",
        type: "brand" as const,
        position: ORIGIN,
        data: {},
        deletable: false,
      }),
      build({
        id: "composer",
        type: "composer" as const,
        position: ORIGIN,
        data: { value: prompt, refHandles: tagged.map((_, i) => `in-ref-${i}`), openHandleId: "in-ref-open", includeBrand: isBrandAttached(shot, "composer", prompt), magicActive, onChange: stable.onPromptChange, registerApplier: (a) => stable.registerApplier("composer", a) },
        deletable: false,
      }),
      build({
        id: "output",
        type: "frame" as const,
        position: ORIGIN,
        // Resizable: the saved size restores the user's last expansion, else
        // the default width (the CSS min keeps the blank state legible).
        style: sizeStyle(initialLayout, "output", 300),
        data: (() => {
          // The output mirrors ONLY its pipe: the bound node's selected
          // generation, or the piped reference's own media. Nothing is piped
          // in yet → blank + hint.
          if (shot.graphOutputSource === "videogen") {
            const outNode = videoNodes.find((n) => n.id === shot.graphOutputVideoNodeId) ?? videoNodes[0];
            const sel = outNode?.gens?.[outNode.genIndex ?? 0];
            if (sel) return { shotNumber: shot.number, previewUrl: graphMediaUrl(prod.meta.id, sel.path), previewKind: "video" as const, bound: true };
          }
          if (shot.graphOutputSource === "imagegen") {
            const sel = shot.graphImageGens?.[shot.graphImageGenIndex ?? 0];
            if (sel) return { shotNumber: shot.number, previewUrl: graphMediaUrl(prod.meta.id, sel.path), previewKind: "image" as const, bound: true };
          }
          if (shot.graphOutputSource === "editgen") {
            const node = editNodes.find((n) => n.id === shot.graphOutputEditNodeId) ?? editNodes[0];
            const sel = node?.gens?.[node.genIndex ?? 0];
            if (sel) return { shotNumber: shot.number, previewUrl: graphMediaUrl(prod.meta.id, sel.path), previewKind: "image" as const, bound: true };
          }
          if (shot.graphOutputSource === "tween") {
            // The tween feed shows the stitched continuous clip; before the
            // first stitch the frame stays blank like any empty pipe.
            if (shot.graphTweenOutput) return { shotNumber: shot.number, previewUrl: graphMediaUrl(prod.meta.id, shot.graphTweenOutput), previewKind: "video" as const, bound: true };
          }
          if (shot.graphOutputSource === "editvideo") {
            const sel = shot.graphEditVideoGens?.[shot.graphEditVideoGenIndex ?? 0];
            if (sel) return { shotNumber: shot.number, previewUrl: graphMediaUrl(prod.meta.id, sel.path), previewKind: "video" as const, bound: true };
          }
          if (shot.graphOutputSource === "upscale") {
            const up = shot.graphUpscale;
            const sel = up?.gens?.[up.genIndex ?? 0];
            if (sel) return { shotNumber: shot.number, previewUrl: graphMediaUrl(prod.meta.id, sel.path), previewKind: "image" as const, bound: true };
          }
          if (shot.graphOutputSource === "ref" && shot.graphOutputRefId) {
            const ref = references.find((r) => r.id === shot.graphOutputRefId);
            if (ref?.media === "video" && ref.mediaPath) return { shotNumber: shot.number, previewUrl: graphMediaUrl(prod.meta.id, ref.mediaPath), previewKind: "video" as const, bound: true };
            if (ref?.artwork) return { shotNumber: shot.number, previewUrl: ref.artwork, previewKind: "image" as const, bound: true };
          }
          return { shotNumber: shot.number, previewUrl: null, previewKind: null, bound: false };
        })(),
        deletable: false,
      }),
      build({
        id: "imagegen",
        type: "imagegen" as const,
        position: ORIGIN,
        style: fixedWidth(300),
        data: {
          models: imageModels.filter((m) => modelOnSurface(m, "image:generate")),
          defaultModel: prod.openArt?.model ?? "auto",
          defaultResolution: prod.openArt?.resolution ?? "1k",
          productionQuality: prod.openArt?.quality,
          savedParams: shot.graphImageParams,
          items: (shot.graphImageGens ?? []).map((g) => ({ url: graphMediaUrl(prod.meta.id, g.path), prompt: g.prompt, path: g.path })),
          selected: shot.graphImageGenIndex ?? 0,
          busy: imageGenBusy === true,
          onGenerate: stable.onRunImageGen,
          onSelect: stable.onSelectImageGen,
          onCycle: stable.onCycleImageGen,
          onDeleteGen: stable.onDeleteGen,
          onSaveAsRef: stable.onSaveAsRef,
          onEditInSuite: stable.onEditInSuite,
          onModelSchema: stable.onModelSchema,
          onSaveFields: stable.onSaveImageFields,
          onZoom: stable.onZoom,
        },
        deletable: false,
      }),
      ...videoNodes.flatMap((n) => videoPair(n, ORIGIN, ORIGIN).map((node) => build(node))),
      ...editNodes.flatMap((n) => editPair(n, ORIGIN, ORIGIN).map((node) => build(node))),
      ...(hasTweenTool ? [build(tweenNode(ORIGIN))] : []),
      ...(hasEditVideoTool ? editVideoPair(ORIGIN, ORIGIN).map((n) => build(n)) : []),
      ...(hasCameraGridTool ? [build(cameraGridNode(ORIGIN))] : []),
      ...(hasUpscaleTool ? [build(upscaleNode(ORIGIN))] : []),
    ];
  }, [unionTagged, tagged, taggedVideo, available, availIds, taggedIds, sourcedRefIds, stable, styles, styleValue, includeBrand, magicActive, prompt, videoPromptValue, videoPromptValues, videoNodes, taggedVideoByNode, thumbnail, editNodes, editPromptValues, taggedEditByNode, shot.number, shot.artworkHistory, prod.meta.id, prod.openArt?.model, prod.openArt?.resolution, prod.openArt?.quality, shot.graphImageGens, shot.graphImageGenIndex, shot.graphImageParams, shot.graphVideoNodes, shot.pendingVideoGen, shot.graphTweenRefIds, shot.graphTweenBlocks, shot.graphTweenModel, shot.graphTweenResolution, shot.graphTweenOutput, shot.graphTweenReencoded, shot.graphOutputSource, shot.graphOutputRefId, shot.graphOutputEditNodeId, shot.graphUpscale, imageModels, videoModels, references, hasVideoTool, hasTweenTool, hasEditVideoTool, hasCameraGridTool, hasUpscaleTool, videoPair, editPair, tweenNode, editVideoNode, editVideoPair, cameraGridNode, upscaleNode, taggedEditVideo, editVideoPromptValue, imageGenBusy, videoBusyNodeIds, editVideoBusy, editBusyNodeIds, initialLayout, initialLayout?.sizes?.output?.width, initialLayout?.sizes?.output?.height]);

  // Persistent node state (the canonical React Flow controlled pattern): all
  // changes flow through applyNodeChanges so selection lives in ONE place.
  // Derived definitions are reconciled in — surviving nodes keep their
  // dragged position, selection flags, and measured size.
  const [nodes, setNodes] = useState<GraphNode[]>(() => {
    const first = buildDerived();
    const saved = initialLayout?.positions;
    const savedSizes = initialLayout?.sizes;
    return first.map((d) => {
      const size = savedSizes?.[d.id];
      // Ref nodes carry their size from buildDerived (collapse-aware); only the
      // frame output takes the generic saved-size override here.
      const isRef = d.id.startsWith("ref:");
      return {
        ...d,
        position: saved?.[d.id] ?? d.position,
        ...(isResizableNodeId(d.id) && !isRef && size ? { style: { ...((d as { style?: Record<string, unknown> }).style as Record<string, unknown>), width: size.width, height: size.height } } : {}),
      };
    });
  });
  const nodesRef = useRef(nodes);
  // Perf 2.1: coalesce drag-tick position changes to one apply per frame.
  // Pointer moves fire far faster than React can commit O(nodes) arrays, so
  // pure dragging ticks accumulate here and flush on rAF; everything else
  // (dragStop, select, remove, resize) flushes pending work synchronously
  // first and takes the full path below.
  const pendingPosChanges = useRef<Parameters<typeof applyNodeChanges<GraphNode>>[0]>([]);
  const posRaf = useRef<number | null>(null);
  const flushPosChanges = useCallback(() => {
    posRaf.current = null;
    const pending = pendingPosChanges.current;
    if (pending.length === 0) return;
    pendingPosChanges.current = [];
    const next = applyNodeChanges(pending, nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
  }, []);
  useEffect(() => () => {
    if (posRaf.current !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(posRaf.current);
    posRaf.current = null;
    pendingPosChanges.current = [];
  }, []);
  useEffect(() => {
    const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
    const derived = buildDerived();
    let changed = false;
    const next = derived.map((d) => {
      const old = byId.get(d.id);
      if (!old) { changed = true; return d; }
      // Keep the old node object when its visible data hasn't changed — this
      // preserves React state and DOM focus inside the nodes (the prompt's
      // contenteditable would lose focus every other keystroke when the parent
      // re-renders with a fresh `references` array identity).
      const a = d.data as Record<string, unknown>;
      const b = old.data as Record<string, unknown>;
      // Perf 2.2: element-wise identity for per-node lists. Length-only checks
      // missed in-place edits (same count, changed item) AND rebuilt data on
      // every pass; when nothing genuinely differs the OLD node (and its data
      // reference) is reused verbatim so React Flow skips the re-render.
      const sameGenItems = (x: unknown, y: unknown): boolean => {
        const ax = x as { url: string; prompt: string; path: string }[];
        const by = y as { url: string; prompt: string; path: string }[];
        if (!Array.isArray(ax) || !Array.isArray(by) || ax.length !== by.length) return false;
        return ax.every((it, i) => it.url === by[i]?.url && it.prompt === by[i]?.prompt && it.path === by[i]?.path);
      };
      const sameKeyframes = (x: unknown, y: unknown): boolean => {
        const ax = x as { id: string; name: string; artwork: string }[];
        const by = y as { id: string; name: string; artwork: string }[];
        if (!Array.isArray(ax) || !Array.isArray(by) || ax.length !== by.length) return false;
        return ax.every((k, i) => k.id === by[i]?.id && k.name === by[i]?.name && k.artwork === by[i]?.artwork);
      };
      let equal = true;
      if (d.type !== old.type) equal = false;
      else if (d.type === "composer") equal = (a.value as string) === (b.value as string) && (a.includeBrand as boolean) === (b.includeBrand as boolean) && (a.magicActive as boolean) === (b.magicActive as boolean) && (a.refHandles as string[]).length === (b.refHandles as string[]).length && (a.refHandles as string[]).every((v, i) => v === (b.refHandles as string[])[i]) && (a.openHandleId as string) === (b.openHandleId as string);
      else if (d.type === "videogen") equal = (a.hasImageSource as boolean) === (b.hasImageSource as boolean) && (a.selected as number) === (b.selected as number) && sameGenItems(a.items, b.items) && (a.busy as boolean) === (b.busy as boolean);
      else if (d.type === "tween") equal = (a.refIds as string[]).length === (b.refIds as string[]).length && (a.refIds as string[]).every((v, i) => v === (b.refIds as string[])[i]) && sameKeyframes(a.keyframes, b.keyframes) && (a.blockCount as number) === (b.blockCount as number) && (a.readyBlocks as number) === (b.readyBlocks as number) && (a.stitched as boolean) === (b.stitched as boolean) && (a.reencoded as boolean) === (b.reencoded as boolean);
      else if (d.type === "editgen") equal = (a.sourceHint as string) === (b.sourceHint as string) && (a.prompt as string) === (b.prompt as string) && (a.sourceRefId as string | undefined) === (b.sourceRefId as string | undefined) && (a.sourcePath as string | undefined) === (b.sourcePath as string | undefined) && (a.selected as number) === (b.selected as number) && sameGenItems(a.items, b.items) && (a.busy as boolean) === (b.busy as boolean);
      else if (d.type === "videoprompt") equal = (a.value as string) === (b.value as string) && (a.includeBrand as boolean) === (b.includeBrand as boolean) && (a.refHandles as string[]).length === (b.refHandles as string[]).length && (a.refHandles as string[]).every((v, i) => v === (b.refHandles as string[])[i]) && (a.openHandleId as string) === (b.openHandleId as string);
      else if (d.type === "editprompt") equal = (a.value as string) === (b.value as string) && (a.includeBrand as boolean) === (b.includeBrand as boolean) && (a.refHandles as string[]).length === (b.refHandles as string[]).length && (a.refHandles as string[]).every((v, i) => v === (b.refHandles as string[])[i]) && (a.openHandleId as string) === (b.openHandleId as string);
      else if (d.type === "editvideoprompt") equal = (a.value as string) === (b.value as string) && (a.includeBrand as boolean) === (b.includeBrand as boolean) && (a.refHandles as string[]).length === (b.refHandles as string[]).length && (a.refHandles as string[]).every((v, i) => v === (b.refHandles as string[])[i]) && (a.openHandleId as string) === (b.openHandleId as string);
      else if (d.type === "style") equal = (a.value as string) === (b.value as string);
      else if (d.type === "brand") equal = (a.include as boolean) === (b.include as boolean);
      else if (d.type === "ref") equal = (a.name as string) === (b.name as string) && (a.artwork as string) === (b.artwork as string) && (a.tagged as boolean) === (b.tagged as boolean) && (a.sourced as boolean) === (b.sourced as boolean) && (a.missing as boolean) === (b.missing as boolean) && (a.collapsed as boolean) === (b.collapsed as boolean);
      else if (d.type === "frame") equal = (a.previewUrl as string) === (b.previewUrl as string) && (a.previewKind as string) === (b.previewKind as string) && (a.bound as boolean) === (b.bound as boolean);
      else if (d.type === "imagegen") equal = (a.selected as number) === (b.selected as number) && sameGenItems(a.items, b.items) && (a.busy as boolean) === (b.busy as boolean);
      else if (d.type === "editvideo") equal = (a.selected as number) === (b.selected as number) && sameGenItems(a.items, b.items) && (a.busy as boolean) === (b.busy as boolean) && (a.piped as boolean) === (b.piped as boolean) && (a.sourceLabel as string | null) === (b.sourceLabel as string | null);
      else if (d.type === "cameraGrid") equal = (a.sheetUrl as string | null) === (b.sheetUrl as string | null) && (a.sheetPath as string | undefined) === (b.sheetPath as string | undefined) && (a.cols as number) === (b.cols as number) && (a.rows as number) === (b.rows as number) && (a.savedModel as string | undefined) === (b.savedModel as string | undefined) && (a.savedResolution as string | undefined) === (b.savedResolution as string | undefined) && JSON.stringify(a.savedParams ?? {}) === JSON.stringify(b.savedParams ?? {}) && (a.sourceLabel as string | null) === (b.sourceLabel as string | null) && (a.gridSourceLabel as string | null) === (b.gridSourceLabel as string | null) && JSON.stringify(a.refIds) === JSON.stringify(b.refIds) && (a.models as unknown[]).length === (b.models as unknown[]).length;
      else if (d.type === "upscale") equal = (a.savedModel as string | undefined) === (b.savedModel as string | undefined) && (a.savedResolution as string | undefined) === (b.savedResolution as string | undefined) && JSON.stringify(a.savedParams ?? {}) === JSON.stringify(b.savedParams ?? {}) && (a.sourceHint as string) === (b.sourceHint as string) && (a.sourceRefId as string | undefined) === (b.sourceRefId as string | undefined) && (a.sourcePath as string | undefined) === (b.sourcePath as string | undefined) && (a.selected as number) === (b.selected as number) && sameGenItems(a.items, b.items) && (a.models as unknown[]).length === (b.models as unknown[]).length;
      if (equal) return old;
      changed = true;
      // A rebuilt node keeps its canvas geometry: position, selection, and —
      // for the resizable frame output — the user's live size. Without this a
      // fresh preview (new generation piped in) would snap the node back to
      // its default width.
      {
        const keep = old as unknown as Record<string, unknown>;
        const merged: Record<string, unknown> = {
          ...(d as unknown as Record<string, unknown>),
          position: old.position,
          selected: old.selected,
          measured: old.measured,
        };
        if (typeof keep.width === "number") merged.width = keep.width;
        if (typeof keep.height === "number") merged.height = keep.height;
        if (keep.style !== undefined) merged.style = keep.style;
        return merged as GraphNode;
      }
    });
    if (!changed && next.length === nodesRef.current.length && next.every((n, i) => n === nodesRef.current[i])) return;
    nodesRef.current = next;
    setNodes(next);
  }, [buildDerived]);

  // Perf 2.3: stable references signature — the parent passes a fresh array
  // identity on unrelated re-renders, which used to rebuild every edge. The
  // edges memo depends on this value-string (compared by value) instead of
  // raw identity; the body still reads the live array, so content changes
  // always recompute while identity-only churn is ignored.
  const referencesSig = useMemo(
    () => references.map((r) => `${r.id}|${r.artwork ?? ""}|${r.media ?? ""}|${r.mediaPath ?? ""}`).sort().join("\n"),
    [references],
  );
  const edges = useMemo<Edge[]>(() => {
    if (!wiringGraph) return [];
    return graphEdgesToFlow(wiringGraph, { selected: selectedEdges, colors: SOCKET_COLORS });
  }, [wiringGraph, selectedEdges]);

  // Ensure every opened shot owns a stored graph: legacy shots materialize on
  // first open (load migration skips v2 files), and drift from manual prompt
  // edits heals here — connect-time writes keep the graph live mid-session.
  // Persist-if-different so a settled shot saves nothing. Also heals the
  // style mirror: an active sidepanel selection always opens wired.
  const ensuredGraphFor = useRef<string | null>(null);
  useEffect(() => {
    const key = `${prod.meta.id}:${shot.id}`;
    if (ensuredGraphFor.current === key) return;
    ensuredGraphFor.current = key;
    let fresh = normalizeGraph(materializeGraph(shot, references)).graph;
    if (styleValue && !styleEdgePresent(fresh, "composer")) {
      fresh = normalizeGraph(setStyleEdge(fresh, "composer", true)).graph;
    }
    fresh.migrated = true;
    if (JSON.stringify(shot.graph) !== JSON.stringify(fresh)) {
      onGraphField({ graph: fresh });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prod.meta.id, shot.id]);

  // Magic Prompt citations live in the effective prompt text (`magicPrompts`),
  // not in the stored graph's edges — so the canvas showed tagged ref nodes
  // with no wires. Rebuild the composer's ref-socket wires (and add the ref
  // nodes) from the tag order whenever Magic is active; `wireComposerRefs` is
  // idempotent so a settled graph saves nothing. Gated on a non-empty prompt
  // so a not-yet-fetched focused prompt can't strip the existing wires.
  const magicRefIds = useMemo(
    () => tagged.flatMap((t) => (t.ref?.id ? [t.ref.id] : [])),
    [tagged]
  );
  useEffect(() => {
    if (!magicActive || !prompt.trim()) return;
    const g = cb.current.graph;
    if (!g) return;
    const next = wireComposerRefs(g, magicRefIds);
    if (JSON.stringify(next) !== JSON.stringify(g)) cb.current.onGraphField({ graph: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [magicActive, prompt, shot.graph, magicRefIds]);

  const onNodesChange = useCallback<OnNodesChange<GraphNode>>((changes) => {
    // Canonical controlled flow: apply every change (position, select,
    // dimension) to the persistent node state in one pass so React Flow's
    // internal selection bookkeeping and our state never diverge.
    // Perf 2.1: pure drag ticks (position + dragging) coalesce to one apply
    // per animation frame — O(changed) commits instead of O(nodes) per
    // pointermove. Anything else flushes pending ticks first.
    const onlyDragTick = changes.length > 0 && changes.every((c) => c.type === "position" && (c as { dragging?: boolean }).dragging === true);
    if (onlyDragTick) {
      pendingPosChanges.current.push(...changes);
      if (posRaf.current === null) {
        if (typeof requestAnimationFrame === "function") posRaf.current = requestAnimationFrame(flushPosChanges);
        else flushPosChanges();
      }
      return;
    }
    if (pendingPosChanges.current.length > 0) {
      if (posRaf.current !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(posRaf.current);
      posRaf.current = null;
      const pending = pendingPosChanges.current;
      pendingPosChanges.current = [];
      nodesRef.current = applyNodeChanges(pending, nodesRef.current);
    }
    const dragStop = changes.some((c) => c.type === "position" && c.dragging !== true);
    let removed = changes.filter((c): c is { type: "remove"; id: string } => c.type === "remove");
    // Stored-graph removals thread through one local (see header note) so a
    // multi-delete can't resurrect an earlier removal; saved once below.
    let gg: Graph | null = null;
    const gcur = (): Graph | null => gg ?? cb.current.graph ?? null;

    // Video/tween tool nodes delete as a PAIR (gen + prompt) and return to the
    // right panel — unless in use (stored generations, pipes, prompt text), in
    // which case the delete is blocked: the pair owns that data. Edit nodes own
    // a per-node pair; deleting either removes the node and cleans its pipes.
    const blockedToolIds = new Set<string>();
    const removedVidIds = new Set<string>();
    const vidInUse = (n: GraphVideoNode): boolean =>
      !!((n.gens?.length ?? 0) > 0 || (n.prompt ?? "").trim() || n.source || (n.refIds?.length ?? 0) > 0 || cb.current.graphOutputSource === "videogen");
    for (const c of removed) {
      const vidId = parseVideoGenNode(c.id) ?? parseVideoPromptNode(c.id);
      if (vidId) {
        const node = (cb.current.videoNodes ?? []).find((n) => n.id === vidId);
        if (node && vidInUse(node)) blockedToolIds.add(c.id);
        else removedVidIds.add(vidId);
      }
      else if (c.id === "tween") { if (tweenActive) blockedToolIds.add(c.id); }
      else if (c.id === "cameraGrid") { if (cameraGridActive) blockedToolIds.add(c.id); }
      else if (c.id === "upscale") { if (upscaleActive) blockedToolIds.add(c.id); }
    }
    if (blockedToolIds.size > 0) {
      showHint(blockedToolIds.has("cameraGrid")
        ? "The camera grid holds a generated sheet — remove the node from the right panel after clearing it."
        : blockedToolIds.has("upscale")
          ? "The upscale node holds generated outputs — remove the node from the right panel after clearing them."
          : "This node is in use (clips or pipes) — clear its generations or pipes before removing it.");
      removed = removed.filter((c) => !blockedToolIds.has(c.id));
      changes = changes.filter((c) => c.type !== "remove" || !blockedToolIds.has(c.id));
    }
    // Deleting the camera-grid node removes the tool (and its wiring) entirely.
    const cameraGridRemoved = removed.some((c) => c.id === "cameraGrid");
    const upscaleRemoved = removed.some((c) => c.id === "upscale");
    const toolKindRemoved = new Set<"tween">();
    const toolNodeIds = new Set<string>();
    for (const c of removed) {
      if (c.id === "tween") toolKindRemoved.add("tween");
    }
    if (toolKindRemoved.has("tween")) { toolNodeIds.add("tween"); }
    if (cameraGridRemoved) toolNodeIds.add("cameraGrid");
    if (upscaleRemoved) toolNodeIds.add("upscale");
    for (const vidId of removedVidIds) {
      toolNodeIds.add(videoGenNodeId(vidId));
      toolNodeIds.add(videoPromptNodeId(vidId));
    }

    // Edit nodes removed (either node of the pair): drop the node from the
    // shot's list and its pair from the canvas.
    const removedEditIds = new Set<string>();
    for (const c of removed) {
      const editId = parseEditGenNode(c.id)
        ?? (c.id === "editprompt" ? "edit0" : c.id.startsWith(EDITPROMPT_NODE_PREFIX) ? c.id.slice(EDITPROMPT_NODE_PREFIX.length) : null);
      if (editId) removedEditIds.add(editId);
    }
    for (const editId of removedEditIds) {
      toolNodeIds.add(editGenNodeId(editId));
      toolNodeIds.add(editPromptNodeId(editId));
    }
    // Stored graph mirrors the canvas removals (nodes + incident wires).
    if (toolNodeIds.size > 0 || removedEditIds.size > 0) {
      const cur = gcur();
      if (cur) {
        let g = cur;
        for (const id of toolNodeIds) g = removeGraphNode(g, id);
        for (const editId of removedEditIds) {
          g = removeGraphNode(g, editGenNodeId(editId));
          g = removeGraphNode(g, editPromptNodeId(editId));
        }
        gg = g;
      }
    }

    const next = applyNodeChanges(changes, nodesRef.current);
    const final = toolNodeIds.size > 0 ? next.filter((n) => !toolNodeIds.has(n.id)) : next;
    if (toolKindRemoved.has("tween")) {
      setPlacedTools((prev) => { const n = new Set(prev); n.delete("tween"); return n; });
    }
    if (cameraGridRemoved) {
      setPlacedTools((prev) => { const n = new Set(prev); n.delete("cameraGrid"); return n; });
      // Drop the node's wiring/picks so it doesn't resurrect on the next build.
      cb.current.onGraphField({ graphCameraGrid: undefined });
    }
    if (upscaleRemoved) {
      setPlacedTools((prev) => { const n = new Set(prev); n.delete("upscale"); return n; });
      // Drop the node's wiring/picks and the output feed so it doesn't
      // resurrect on the next build.
      cb.current.onGraphField({ graphUpscale: undefined, ...(cb.current.graphOutputSource === "upscale" ? { graphOutputSource: undefined, artwork: undefined } : {}) });
    }
    if (removedEditIds.size > 0) {
      // Drop the node, clear every pipe that pointed at it (output, video
      // source, tween keyframes) and any other node whose source was it.
      const kept = (cb.current.graphEditNodes ?? [])
        .filter((n) => !removedEditIds.has(n.id))
        .map((n) => (n.source?.kind === "editgen" && removedEditIds.has(n.source.nodeId) ? { ...n, source: undefined } : n));
      const patch: Partial<ProductionShot> = { graphEditNodes: kept };
      if (cb.current.graphOutputSource === "editgen" && removedEditIds.has(cb.current.graphOutputEditNodeId ?? "")) {
        patch.graphOutputSource = undefined;
        patch.graphOutputEditNodeId = undefined;
        patch.artwork = undefined;
      }
      if (cb.current.graphEditToVideo && removedEditIds.has(cb.current.graphVideoSourceEditNodeId ?? "")) {
        patch.graphEditToVideo = undefined;
        patch.graphVideoSourceEditNodeId = undefined;
      }
      const tween = (cb.current.graphTweenRefIds ?? []).filter((id) => {
        const eid = id === TWEEN_KEY_EDITGEN ? "edit0" : id.startsWith(TWEEN_KEY_EDITGEN_PREFIX) ? id.slice(TWEEN_KEY_EDITGEN_PREFIX.length) : null;
        return !(eid && removedEditIds.has(eid));
      });
      if (tween.length !== (cb.current.graphTweenRefIds ?? []).length) patch.graphTweenRefIds = tween;
      cb.current.onGraphField(patch);
    }
    if (removedVidIds.size > 0) {
      // Drop the removed video nodes; clear the output feed if it pointed at
      // one, and the edit-video source feed when no video node remains.
      const kept = (cb.current.graphVideoNodes ?? []).filter((n) => !removedVidIds.has(n.id));
      const patch: Partial<ProductionShot> = { graphVideoNodes: kept };
      if (cb.current.graphOutputSource === "videogen" && removedVidIds.has(cb.current.graphOutputVideoNodeId ?? "")) {
        patch.graphOutputSource = undefined;
        patch.graphOutputVideoNodeId = undefined;
        patch.videoPath = undefined;
      }
      if (kept.length === 0 && cb.current.graphVideoToEditVideo) patch.graphVideoToEditVideo = undefined;
      cb.current.onGraphField(patch);
    }
    // Ref node deletion (select + Delete/Backspace): strip the reference from
    // every prompt + pipe and drop its position so it returns to the shelf.
    for (const c of removed) {
      const m = /^ref:(.+)$/.exec(c.id);
      if (!m) continue;
      const cur = gcur();
      if (cur) gg = removeGraphNode(cur, c.id);
      const refId = m[1];
      removedRefIdsRef.current.add(refId);
      setPlacedRefIds((prev) => { const n = new Set(prev); n.delete(refId); return n; });
      const entry = cb.current.references.find((r) => r.id === refId);
      if (entry) {
        const strip = (cur: string) => removeRefTag(cur, entry.name);
        const freshComposer = appliers.current["composer"]?.get() ?? cb.current.prompt;
        if (refTagNames(freshComposer).some((n) => n.toLowerCase() === entry.name.toLowerCase())) {
          if (!applyDraftEdit("composer", strip)) cb.current.onPromptChange(strip(cb.current.prompt));
        }
        const vidNodesNext = (cb.current.graphVideoNodes ?? []).map((n) => {
          const key = videoApplierKey(n.id);
          const fresh = appliers.current[key]?.get() ?? cb.current.videoPromptValues?.get(n.id) ?? n.prompt ?? "";
          const needsStrip = refTagNames(fresh).some((nm) => nm.toLowerCase() === entry.name.toLowerCase());
          if (needsStrip) applyDraftEdit(key, strip);
          const source = n.source?.kind === "ref" && n.source.refId === refId ? undefined : n.source;
          const refIds = n.refIds?.includes(refId) ? n.refIds.filter((id) => id !== refId) : n.refIds;
          const prompt = needsStrip ? strip(fresh) : n.prompt;
          return prompt !== n.prompt || source !== n.source || refIds !== n.refIds ? { ...n, prompt, source, refIds } : n;
        });
        if (vidNodesNext.some((n, i) => n !== (cb.current.graphVideoNodes ?? [])[i])) {
          cb.current.onGraphField({ graphVideoNodes: vidNodesNext });
        }
        const editNodesNext = (cb.current.graphEditNodes ?? []).map((n) => {
          const fresh = appliers.current[`edit:${n.id}`]?.get() ?? n.prompt ?? "";
          const needsStrip = refTagNames(fresh).some((nm) => nm.toLowerCase() === entry.name.toLowerCase());
          if (needsStrip) applyDraftEdit(`edit:${n.id}`, strip);
          const p = needsStrip ? strip(fresh) : n.prompt;
          const source = n.source?.kind === "ref" && n.source.refId === refId ? undefined : n.source;
          return p !== n.prompt || source !== n.source ? { ...n, prompt: p, source } : n;
        });
        if (editNodesNext.some((n, i) => n !== (cb.current.graphEditNodes ?? [])[i])) {
          cb.current.onGraphField({ graphEditNodes: editNodesNext });
        }
        if (cb.current.graphOutputSource === "ref" && cb.current.graphOutputRefId === refId) cb.current.onUnpipeOutput();
        if (cb.current.graphVideoSourceRefId === refId) cb.current.onGraphField({ graphVideoSourceRefId: undefined });
        if (cb.current.graphEditVideoSourceRefId === refId) cb.current.onGraphField({ graphEditVideoSourceRefId: undefined });
        if ((cb.current.graphTweenRefIds ?? []).includes(refId)) {
          cb.current.onTweenRefs((cb.current.graphTweenRefIds ?? []).filter((id) => id !== refId));
        }
        // The camera grid may source this ref, use it as the grid image, or
        // have it wired as a reference; dropping it renumbers the remaining
        // reference sockets.
        const gridSrc = cb.current.graphCameraGrid?.source;
        const gridImageSrc = cb.current.graphCameraGrid?.gridSource;
        const gridRefIds = cb.current.graphCameraGrid?.refIds ?? [];
        if ((gridSrc?.kind === "ref" && gridSrc.refId === refId)
          || (gridImageSrc?.kind === "ref" && gridImageSrc.refId === refId)
          || gridRefIds.includes(refId)) {
          const refIds = gridRefIds.filter((id) => id !== refId);
          stable.onCameraGridSave({
            ...(gridSrc?.kind === "ref" && gridSrc.refId === refId ? { source: undefined } : {}),
            ...(gridImageSrc?.kind === "ref" && gridImageSrc.refId === refId ? { gridSource: undefined } : {}),
            ...(gridRefIds.includes(refId) ? { refIds: refIds.length ? refIds : undefined } : {}),
          });
          if (gridRefIds.includes(refId)) {
            const base = gcur();
            if (base) gg = applyCameraGridRefs(base, refIds);
          }
        }
      }
    }
    nodesRef.current = final;
    setNodes(final);
    if (gg) saveGraph(gg);
    // A resize reports as a `dimensions` change (committed when the drag
    // ends) — persist the frame output's size alongside positions so an
    // enlarged frame survives closing and reopening the graph.
    const resized = changes.some((c) => c.type === "dimensions" || (c as { type: string }).type === "resize");
    if (dragStop || removed.length > 0 || toolNodeIds.size > 0 || resized) {
      // One save per drag gesture. The state only ever contains live nodes,
      // so no pruning is needed for deleted references.
      const sizes: Record<string, { width: number; height: number }> = {};
      const savedSizes = cb.current.initialLayout?.sizes ?? {};
      for (const n of final) {
        if (!isResizableNodeId(n.id)) continue;
        const w = (n as { width?: number }).width
          ?? (n as { measured?: { width?: number } }).measured?.width
          ?? (n as { style?: { width?: number } }).style?.width;
        // A collapsed ref shows only its name — don't overwrite its expanded
        // saved size with the collapsed content height.
        if (n.id.startsWith("ref:") && collapsedRef.current[n.id]) {
          const saved = savedSizes[n.id];
          if (saved) sizes[n.id] = saved;
          continue;
        }
        const h = (n as { height?: number }).height
          ?? (n as { measured?: { height?: number } }).measured?.height
          ?? (n as { style?: { height?: number } }).style?.height;
        if (typeof w === "number" && typeof h === "number") sizes[n.id] = { width: Math.round(w), height: Math.round(h) };
      }
      saveLayoutRef.current({
        positions: Object.fromEntries(final.map((n) => [n.id, n.position])),
        ...(Object.keys(sizes).length > 0 ? { sizes } : {}),
      });
    }
  }, [videoGenActive, tweenActive, cameraGridActive, showHint, flushPosChanges]);

  // ---- Stored-graph writes (step 03) ----
  // Every canvas mutation updates shot.graph (the wiring truth) alongside the
  // legacy flag/text writes below, which continue as the generation projection
  // (LEGACY-PROJECTION — generation still consumes flags/text until steps
  // 04–05; step 10 deletes them). Both derive from the same event.
  const saveGraph = (g: Graph): void => { cb.current.onGraphField({ graph: g }); };
  const tweenResolveFor = (g: Graph) => (keyId: string): string | null => {
    const editIds = new Set((cb.current.graphEditNodes ?? []).map((n) => n.id));
    const refNodes = new Set(g.nodes.map((n) => n.id).filter((id) => id.startsWith("ref:")));
    return tweenKeyToNode(keyId, editIds, refNodes);
  };
  const detachCtxFor = (g: Graph): { tweenKeys: string[]; editIds: Set<string>; refNodeIds: Set<string> } => ({
    tweenKeys: cb.current.graphTweenRefIds ?? [],
    editIds: new Set((cb.current.graphEditNodes ?? []).map((n) => n.id)),
    refNodeIds: new Set(g.nodes.map((n) => n.id).filter((id) => id.startsWith("ref:"))),
  });

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    // Stored-graph removal first (see header note): tween keyframes rebuild
    // positionally from the same filtered list the legacy branch persists;
    // every other wire drops by edge id. Threaded across multi-removes.
    let gg: Graph | null = null;
    const gcur = (): Graph | null => gg ?? cb.current.graph ?? null;
    for (const c of changes) {
      if (c.type === "remove") {
        const cur = gcur();
        if (cur) {
          const tm0 = /^e-tween-(\d+)$/.exec(c.id);
          if (tm0) {
            const idx = Number(tm0[1]);
            const keys = cb.current.graphTweenRefIds ?? [];
            if (idx >= 0 && idx < keys.length) {
              const next = keys.filter((_, i) => i !== idx);
              gg = applyTweenKeys(cur, next, tweenResolveFor(cur));
            }
          } else {
            gg = removeGraphEdge(cur, c.id);
          }
        }
        // Tween keyframe edges (`e-tween-<idx>`, source `ref:<id>`): select +
        // Delete drops that keyframe from the wiring.
        const tm = /^e-tween-(\d+)$/.exec(c.id);
        if (tm) {
          const idx = Number(tm[1]);
          const ids = cb.current.graphTweenRefIds ?? [];
          if (idx >= 0 && idx < ids.length) {
            cb.current.onTweenRefs(ids.filter((_, i) => i !== idx));
          }
          setSelectedEdges(new Set());
          continue;
        }
        // Edit-video source wire: select + Delete unbinds it.
        if (c.id === "e-vid-ev") { cb.current.onGraphField({ graphVideoToEditVideo: undefined }); setSelectedEdges(new Set()); continue; }
        if (c.id === "e-ref-ev") { cb.current.onGraphField({ graphEditVideoSourceRefId: undefined }); setSelectedEdges(new Set()); continue; }
        // Composer brand plug: select + Delete drops it and disables the side
        // panel's shot-level brand toggle mirror.
        if (c.id === "e-brand") { cb.current.onToggleBrand(false); setSelectedEdges(new Set()); continue; }
        // Composer style plug: select + Delete drops it and mirrors to None
        // so the sidepanel dropdown reflects the unwired state.
        if (c.id === "e-style") { cb.current.onGraphField({ graphStyleConnected: false, styleNone: true }); setSelectedEdges(new Set()); continue; }
        // Reference edges are deletable via keyboard (select+Delete) —
        // ids are `e-<refId>-<target>-<idx>` for the prompt nodes.
        const m = /^e-(.+)-(composer|videoprompt(?::[^:]+)?|editvideoprompt|editprompt(?::[^:]+)?)-(\d+)$/.exec(c.id);
        if (m) {
          const [, , targetKind, idxStr] = m;
          const idx = Number(idxStr);
          const vpId = parseVideoPromptNode(targetKind);
          if (targetKind === "composer") {
            const entry = tagged[idx];
            if (entry) { if (!applyDraftEdit("composer", (t) => removeRefTag(t, entry.name))) onPromptChange(removeRefTag(prompt, entry.name)); }
          } else if (vpId) {
            const key = videoApplierKey(vpId);
            const curVal = cb.current.videoPromptValues?.get(vpId) ?? "";
            const fresh = appliers.current[key]?.get() ?? curVal;
            const name = refTagNames(fresh)[idx] ?? (cb.current.taggedVideoByNode?.get(vpId) ?? [])[idx]?.name;
            if (name) {
              if (!applyDraftEdit(key, (t) => removeRefTag(t, name))) patchVideoNode(vpId, { prompt: stripSharedSections(removeRefTag(curVal, name)) });
            }
          } else if (targetKind === "editvideoprompt") {
            const fresh = appliers.current["editvideo"]?.get() ?? cb.current.graphEditVideoPrompt ?? "";
            const name = refTagNames(fresh)[idx] ?? taggedEditVideo[idx]?.name;
            if (name) {
              if (!applyDraftEdit("editvideo", (t) => removeRefTag(t, name))) cb.current.onGraphField({ graphEditVideoPrompt: removeRefTag(cb.current.graphEditVideoPrompt ?? "", name) });
            }
          } else {
            const nodeId = targetKind === "editprompt" ? "edit0" : targetKind.slice(EDITPROMPT_NODE_PREFIX.length);
            const fresh = appliers.current[`edit:${nodeId}`]?.get() ?? cb.current.editPromptValues.get(nodeId) ?? "";
            const name = refTagNames(fresh)[idx] ?? (taggedEditByNode.get(nodeId) ?? [])[idx]?.name;
            if (name) {
              if (!applyDraftEdit(`edit:${nodeId}`, (t) => removeRefTag(t, name))) cb.current.onEditNodePrompt(nodeId, removeRefTag(cb.current.editPromptValues.get(nodeId) ?? "", name));
            }
          }
          setSelectedEdges(new Set());
          continue;
        }
        // Legacy `e-ref:<id>` (composer) fallback for older edges.
        const m2 = /^e-ref:(.+)$/.exec(c.id);
        if (m2) {
          const idx = tagged.findIndex((t, i) => (t.ref?.id ?? "missing-" + i) === m2[1]);
          if (idx >= 0) { if (!applyDraftEdit("composer", (t) => removeRefTag(t, tagged[idx].name))) onPromptChange(removeRefTag(prompt, tagged[idx].name)); }
          setSelectedEdges(new Set());
          continue;
        }
      } else if (c.type === "select") {
        setSelectedEdges((prev) => {
          const next = new Set(prev);
          if (c.selected) next.add(c.id);
          else next.delete(c.id);
          return next;
        });
      }
    }
    if (gg) saveGraph(gg);
  }, [tagged, taggedVideo, taggedEditVideo, taggedEditByNode, prompt, onPromptChange]);

  /**
   * Complete a generation-output → prompt-reference-socket connection: save
   * the take as a reference (main copies the file), place its ref node beside
   * the prompt, then wire the edge and tag the prompt at the target socket.
   * Reads everything mutable through refs so it stays correct across the await.
   */
  const attachGenerationAsReference = async (target: string, handle: string, rel: string) => {
    const saved = await cb.current.onSaveGenerationAsReference(rel);
    if (!saved) return;
    const refNodeId = `ref:${saved.id}`;
    // Stored wire first (mirrors a shelf-ref connect): ref → prompt ref socket.
    {
      const cur = cb.current.graph ?? normalizeGraph(materializeGraph(shot, cb.current.references)).graph;
      const op = connectionToEdge({ source: refNodeId, target, targetHandle: handle }, cur);
      if (op) saveGraph(applyConnection(cur, op));
    }
    // Place the new ref node beside its prompt node and persist the position.
    const anchor = nodesRef.current.find((n) => n.id === target)?.position;
    const posMap = Object.fromEntries(nodesRef.current.map((n) => [n.id, n.position]));
    posMap[refNodeId] = anchor ? { x: anchor.x - 260, y: anchor.y + 48 } : { x: 40, y: 40 };
    saveLayoutRef.current({ positions: posMap });
    // Tag the reference into the prompt at the socket — the wire's substance.
    const slot = /^in-ref-(\d+)$/.exec(handle);
    const place = (t: string) => (slot ? replaceRefTagAt(t, Number(slot[1]), saved.name) : addRefTag(t, saved.name));
    const vpId = parseVideoPromptNode(target);
    if (target === "composer") {
      if (!applyDraftEdit("composer", place)) cb.current.onPromptChange(place(cb.current.prompt));
    } else if (vpId) {
      const key = videoApplierKey(vpId);
      const curVal = cb.current.videoPromptValues?.get(vpId) ?? "";
      if (!applyDraftEdit(key, place)) patchVideoNode(vpId, { prompt: stripSharedSections(place(curVal)) });
    } else if (target === "editvideoprompt") {
      if (!applyDraftEdit("editvideo", place)) cb.current.onGraphField({ graphEditVideoPrompt: place(cb.current.graphEditVideoPrompt ?? "") });
    } else {
      const editId = target === "editprompt" ? "edit0" : target.slice(EDITPROMPT_NODE_PREFIX.length);
      const cur = cb.current.editPromptValues.get(editId) ?? "";
      if (!applyDraftEdit(`edit:${editId}`, place)) cb.current.onEditNodePrompt(editId, place(cur));
    }
    showHint(`Saved the take as @[${saved.name}] and wired it into the prompt.`);
  };

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return;
    // Dragging a generation node's output onto a prompt's reference socket:
    // copy the selected take into the production as a new reference, then wire
    // it in. Main does the file copy asynchronously, so the rest of the
    // connection is completed in a promise (the wire + tag land once it lands).
    const genRel = selectedGenerationRel(shot, canonicalNodeId(conn.source));
    if (genRel && isPromptNodeId(canonicalNodeId(conn.target)) && isRefSocketHandle(conn.targetHandle)) {
      void attachGenerationAsReference(canonicalNodeId(conn.target), conn.targetHandle ?? "", genRel);
      return;
    }
    // Stored-graph write first (see header note): the port table gates types
    // (ReactFlow's isValidConnection already enforced the stateful rules) and
    // the connection maps to one stored edge; tween keyframes rebuild
    // positionally. Legacy bodies below persist the same wire to flags/text
    // (LEGACY-PROJECTION for generation — step 10 deletes them).
    {
      // The ensure effect guarantees a stored graph; fall back to a
      // materialized one so a connect can never be lost (it persists).
      const cur = cb.current.graph ?? normalizeGraph(materializeGraph(shot, cb.current.references)).graph;
      const source = canonicalNodeId(conn.source);
      const target = canonicalNodeId(conn.target);
      const slot = TWEEN_SOCKET_RE.exec(conn.targetHandle ?? "");
      if (target === "tween" && slot) {
        const keyId = tweenKeyForSource(source);
        if (keyId) {
          const { graph: next, keys } = connectTweenKey(cur, keyId, Number(slot[1]), cb.current.graphTweenRefIds ?? [], tweenResolveFor(cur));
          void keys; // legacy wireTweenKeyframe below persists the same list
          saveGraph(next);
        }
      } else {
        const fromKind = nodeKindForId(source);
        const toKind = nodeKindForId(target);
        const handle = conn.targetHandle ?? "";
        let gated = false;
        if (fromKind && toKind) {
          const fromMedia = fromKind === "ref"
            ? refOutputMedia(cb.current.references.find((r) => r.id === source.slice(4)))
            : portDecl(fromKind, "out", "out")?.media;
          gated = !!fromMedia && canConnect({ kind: fromKind, port: "out", media: fromMedia }, { kind: toKind, port: handle });
        }
        if (gated) {
          const op = connectionToEdge({ source, target, targetHandle: conn.targetHandle }, cur);
          if (op) saveGraph(applyConnection(cur, op));
        }
      }
    }
    /** Wire `sourceKeyId` into the tween keyframe socket `in-tween-<slot>`
     *  (replacing its old socket when already wired). */
    const wireTweenKeyframe = (sourceKeyId: string): boolean => {
      if (conn.target !== "tween") return false;
      const slot = /^in-tween-(\d+)$/.exec(conn.targetHandle ?? "")?.[1];
      if (slot === undefined) return false;
      const at = Math.max(0, Math.min(4, Number(slot)));
      const ids = (cb.current.graphTweenRefIds ?? []).filter((id) => id !== sourceKeyId);
      ids.splice(Math.min(at, ids.length), 0, sourceKeyId);
      cb.current.onTweenRefs(ids.slice(0, 5));
      return true;
    };
    /** Replace one edit node immutably in the shot's list. */
    const patchEditNode = (nodeId: string, patch: Partial<GraphEditNode>) => {
      cb.current.onGraphField({ graphEditNodes: (cb.current.graphEditNodes ?? []).map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) });
    };
    const srcEditId = parseEditGenNode(conn.source);
    const tgtEditId = parseEditGenNode(conn.target);
    // Edit-video node: `in-video` = the source clip (video node / video ref).
    // References ride the edit-video prompt node's sockets, like the video node.
    if (conn.target === "editvideo") {
      if (conn.targetHandle === "in-video") {
        if (parseVideoGenNode(conn.source)) { cb.current.onGraphField({ graphVideoToEditVideo: true, graphEditVideoSourceRefId: undefined }); return; }
        const rid = /^ref:(.+)$/.exec(conn.source)?.[1];
        const ref = rid ? references.find((r) => r.id === rid) : undefined;
        if (ref && ref.media === "video") { cb.current.onGraphField({ graphEditVideoSourceRefId: rid, graphVideoToEditVideo: undefined }); return; }
      }
      return;
    }
    // Camera-grid node: the source socket takes one image (image node / edit
    // node / reference); the grid-image socket takes an already-made sheet to
    // cut up (manual fallback); the reference sockets take references
    // positionally. (The stored in-image/in-grid edge is written by the gating
    // block above; the positional reference edges are rebuilt from refIds.)
    if (conn.target === "cameraGrid") {
      const handle = conn.targetHandle ?? "";
      if (handle === "in-image" || handle === "in-grid") {
        const src = canonicalNodeId(conn.source);
        let source: GraphSource | undefined;
        if (src === "imagegen") source = { kind: "imagegen" };
        else {
          const editSrc = parseEditGenNode(src);
          if (editSrc) source = { kind: "editgen", nodeId: editSrc };
          else {
            const rid = /^ref:(.+)$/.exec(src)?.[1];
            if (rid) source = { kind: "ref", refId: rid };
          }
        }
        if (!source) return;
        if (handle === "in-image") { stable.onCameraGridSave({ source }); return; }
        // Grid-image socket: main copies the wired image into the references
        // folder and the node binds it as the sheet (sheetPath + gridSource).
        void stable.onImportCameraGridImage(source);
        return;
      }
      const slot = REF_SOCKET_RE.exec(handle);
      const rid = /^ref:(.+)$/.exec(canonicalNodeId(conn.source))?.[1];
      if (rid && (handle === "in-ref-open" || slot)) {
        const cur = normalizeCameraGridData(cb.current.graphCameraGrid);
        const refIds = placeCameraGridRef(cur?.refIds ?? [], rid, slot ? Number(slot[1]) : undefined);
        stable.onCameraGridSave({ refIds });
        const g = cb.current.graph ?? normalizeGraph(materializeGraph(shot, cb.current.references)).graph;
        saveGraph(applyCameraGridRefs(g, refIds));
        return;
      }
      return;
    }
    if (conn.target === "upscale") {
      if (conn.targetHandle !== "in-image") return;
      const src = canonicalNodeId(conn.source);
      if (src === "imagegen") { stable.onUpscaleSave({ source: { kind: "imagegen" } }); return; }
      const editSrc = parseEditGenNode(src);
      if (editSrc) { stable.onUpscaleSave({ source: { kind: "editgen", nodeId: editSrc } }); return; }
      const rid = /^ref:(.+)$/.exec(src)?.[1];
      if (rid) { stable.onUpscaleSave({ source: { kind: "ref", refId: rid } }); return; }
      return;
    }
    // Generation pipes: the image node's output feeds the video/edit image
    // inputs and/or the output (both can coexist); the video/edit nodes feed
    // the output; a reference can feed the output or an edit node's source.
    if (conn.source === "upscale") { if (conn.target === "output") { cb.current.onPipeUpscaleToOutput?.(); return; } }
    if (conn.source === "imagegen") {
      const tgtVid = parseVideoGenNode(conn.target);
      if (tgtVid) { patchVideoNode(tgtVid, { source: { kind: "imagegen" } }); return; }
      if (conn.target === "output") { cb.current.onPipeImageToOutput(); return; }
      if (tgtEditId && conn.targetHandle === "in-image") { patchEditNode(tgtEditId, { source: { kind: "imagegen" } }); return; }
      if (wireTweenKeyframe(TWEEN_KEY_IMGGEN)) return;
    }
    {
      const srcVid = parseVideoGenNode(conn.source);
      if (srcVid) { if (conn.target === "output") { cb.current.onPipeVideoToOutput(srcVid); return; } }
    }
    if (conn.source === "tween") { if (conn.target === "output") { cb.current.onPipeTweenToOutput(); return; } }
    if (srcEditId) {
      // An edit node's output can feed the video source, the output, another
      // edit node's source, or a tween keyframe.
      const tgtVid = parseVideoGenNode(conn.target);
      if (tgtVid && conn.targetHandle === "in-image") { cb.current.onPipeEditToVideo(tgtVid, srcEditId); return; }
      if (conn.target === "output") { cb.current.onPipeEditToOutput(srcEditId); return; }
      if (tgtEditId && conn.targetHandle === "in-image" && tgtEditId !== srcEditId) {
        if (!editNodeDependsOnClient(shot, srcEditId, tgtEditId)) patchEditNode(tgtEditId, { source: { kind: "editgen", nodeId: srcEditId } });
        return;
      }
      if (wireTweenKeyframe(`${TWEEN_KEY_EDITGEN_PREFIX}${srcEditId}`)) return;
    }
    const refId = /^ref:(.+)$/.exec(conn.source)?.[1];
    if (refId) {
      if (conn.target === "output") { cb.current.onPipeRefToOutput(refId); return; }
      // In-betweener keyframe sockets: `in-tween-<slot>` sets that position in
      // the ordered keyframe list (moving the ref when already wired).
      if (wireTweenKeyframe(refId)) return;
      // The video node's source input takes a reference's image as the frame
      // the clip animates from.
      const tgtVid = parseVideoGenNode(conn.target);
      if (tgtVid && conn.targetHandle === "in-image") {
        cb.current.onPipeRefToVideo(tgtVid, refId);
        return;
      }
      if (tgtEditId && conn.targetHandle === "in-image") {
        patchEditNode(tgtEditId, { source: { kind: "ref", refId } });
        return;
      }
    }
    // Prompt nodes: style / brand / reference inputs — exactly like composer.
    const isComposer = conn.target === "composer";
    const tgtVideoPromptId = parseVideoPromptNode(conn.target);
    const isVideo = tgtVideoPromptId !== null;
    const isEditVideoPrompt = conn.target === "editvideoprompt";
    const editPromptId = conn.target === "editprompt" ? "edit0" : conn.target.startsWith(EDITPROMPT_NODE_PREFIX) ? conn.target.slice(EDITPROMPT_NODE_PREFIX.length) : null;
    if (isComposer || isVideo || isEditVideoPrompt || editPromptId) {
      const editCur = editPromptId ? (cb.current.editPromptValues.get(editPromptId) ?? "") : "";
      const applyEdit = (fn: (t: string) => string) => {
        if (!editPromptId) return;
        if (!applyDraftEdit(`edit:${editPromptId}`, fn)) cb.current.onEditNodePrompt(editPromptId, fn(editCur));
      };
      const applyVideo = (fn: (t: string) => string) => {
        if (!tgtVideoPromptId) return;
        const key = videoApplierKey(tgtVideoPromptId);
        const curValue = cb.current.videoPromptValues?.get(tgtVideoPromptId) ?? "";
        if (!applyDraftEdit(key, fn)) patchVideoNode(tgtVideoPromptId, { prompt: stripSharedSections(fn(curValue)) });
      };
      const applyEditVideo = (fn: (t: string) => string) => {
        if (!applyDraftEdit("editvideo", fn)) cb.current.onGraphField({ graphEditVideoPrompt: fn(cb.current.graphEditVideoPrompt ?? "") });
      };
      if (conn.source === "style") {
        // The edge (written above) is the plug; no paragraph is pasted. The
        // legacy flag still mirrors it for graph-less rebuilds (projection).
        // The sidepanel selection mirrors the wire: plugging the composer wire
        // re-activates a style (clears None so the dropdown shows the style).
        if (isComposer) cb.current.onGraphField({ graphStyleConnected: true, styleNone: false });
        else if (isVideo) patchVideoNode(tgtVideoPromptId!, { styleConnected: true });
        else if (!isEditVideoPrompt) patchEditNode(editPromptId!, { styleConnected: true });
        return;
      }
      if (conn.source === "brand") {
        // The edge (written above) is the plug; the clause renders from the
        // brand set — nothing is stored in the prompt. The composer plug also
        // owns the shot-level `includeBrandIdentity` mirror the storyboard side
        // panel's brand toggle reads, so connecting it enables that toggle
        // (otherwise the plug looks like it did nothing).
        if (isComposer) cb.current.onToggleBrand(true);
        return;
      }
      const m = /^ref:(.+)$/.exec(conn.source);
      if (!m) return;
      const ref = references.find((r) => r.id === m[1]);
      if (!ref) return;
      // Dropping onto an occupied reference socket replaces that slot's tag;
      // the always-open socket appends.
      const slot = /^in-ref-(\d+)$/.exec(conn.targetHandle ?? "");
      const place = (t: string) => (slot ? replaceRefTagAt(t, Number(slot[1]), ref.name) : addRefTag(t, ref.name));
      if (isComposer) {
        if (!applyDraftEdit("composer", place)) onPromptChange(place(prompt));
      }
      else if (isVideo) applyVideo(place);
      else if (isEditVideoPrompt) applyEditVideo(place);
      else applyEdit(place);
      return;
    }
  }, [references, prompt, onPromptChange, shot]);

  /** Reference→open-input, style→style, brand→brand, imagegen→video/edit/output
   *  (all at once allowed), videogen/tween→output, ref→output
   *  (image/video refs only), ref→edit-node source (image refs only),
   *  ref→tween keyframe sockets (image refs only, 5 max), plus fixed
   *  prompt pipes — everything else is rejected. Prompt nodes (composer,
   *  videoprompt, editprompt) each accept Style / Reference / Brand exactly alike. */
  const isValidConnection = useCallback((c: Connection | Edge) => {
    const source = c.source ?? "";
    // A generation node's output may be dropped onto any prompt reference
    // socket: the selected take is saved as a reference, then wired in.
    if (source && selectedGenerationRel(shot, canonicalNodeId(source))
      && isPromptNodeId(canonicalNodeId(c.target ?? "")) && isRefSocketHandle(c.targetHandle)) return true;
    /** Shared tween keyframe-socket rule: a valid socket index (0–4) and room
     *  on the timeline (a source already wired may re-plug its own socket). */
    const tweenSlotOk = (keyId: string): boolean => {
      const m = /^in-tween-(\d+)$/.exec(c.targetHandle ?? "");
      if (!m || Number(m[1]) > 4) return false;
      const ids = shot.graphTweenRefIds ?? [];
      return ids.includes(keyId) || ids.length < 5;
    };
    const sourceVid = parseVideoGenNode(source);
    const targetVid = parseVideoGenNode(c.target ?? "");
    const sourceVideoPrompt = parseVideoPromptNode(source);
    const targetVideoPrompt = parseVideoPromptNode(c.target ?? "");
    if (sourceVideoPrompt) return targetVid === sourceVideoPrompt && c.targetHandle === "in-prompt";
    if (source === "editvideoprompt") return c.target === "editvideo" && c.targetHandle === "in-prompt";
    if (source === "composer") return c.target === "imagegen" && c.targetHandle === "in-prompt";
    const srcEditId = parseEditGenNode(source);
    const tgtEditId = parseEditGenNode(c.target ?? "");
    // Edit-video node: the source socket takes a video node clip or a video
    // reference. References ride the edit-video prompt node's sockets.
    if (c.target === "editvideo") {
      if (c.targetHandle === "in-video") {
        if (sourceVid) return true;
        const rid = /^ref:(.+)$/.exec(source)?.[1];
        const ref = rid ? references.find((r) => r.id === rid) : undefined;
        return !!ref && ref.media === "video";
      }
      return false;
    }
    // Camera-grid node: one image source (image node / edit node / reference)
    // plus positional reference sockets (image references only).
    if (c.target === "cameraGrid") {
      const handle = c.targetHandle ?? "";
      const refOf = (): GraphRef | undefined => {
        const rid = /^ref:(.+)$/.exec(source)?.[1];
        return rid ? references.find((r) => r.id === rid) : undefined;
      };
      if (handle === "in-image" || handle === "in-grid") {
        if (source === "imagegen" || srcEditId) return true;
        const ref = refOf();
        return !!ref && !!ref.artwork && !ref.media;
      }
      if (handle === "in-ref-open" || /^in-ref-\d+$/.test(handle)) {
        const ref = refOf();
        return !!ref && !!ref.artwork && !ref.media;
      }
      return false;
    }
    // Upscale node: one image source (image node / edit node / image reference).
    if (c.target === "upscale") {
      if (c.targetHandle !== "in-image") return false;
      if (source === "imagegen" || srcEditId) return true;
      const rid = /^ref:(.+)$/.exec(source)?.[1];
      const ref = rid ? references.find((r) => r.id === rid) : undefined;
      return !!ref && !!ref.artwork && !ref.media;
    }
    const editPromptId = source === "editprompt" ? "edit0" : source.startsWith(EDITPROMPT_NODE_PREFIX) ? source.slice(EDITPROMPT_NODE_PREFIX.length) : null;
    const targetEditPrompt = c.target === "editprompt" || (c.target ?? "").startsWith(EDITPROMPT_NODE_PREFIX);
    if (editPromptId) return parseEditGenNode(c.target ?? "") === editPromptId && c.targetHandle === "in-prompt";
    if (source === "imagegen") {
      if (targetVid) return c.targetHandle === "in-image";
      if (tgtEditId) return c.targetHandle === "in-image";
      if (c.target === "output") return c.targetHandle === "in-out";
      if (c.target === "tween") return tweenSlotOk(TWEEN_KEY_IMGGEN);
      return false;
    }
    if (sourceVid) return c.target === "output" && c.targetHandle === "in-out";
    if (source === "tween") return c.target === "output" && c.targetHandle === "in-out";
    if (source === "upscale") return c.target === "output" && c.targetHandle === "in-out";
    if (srcEditId) {
      // An edit node's image output feeds every image input: the video node's
      // source, the output, another edit node's source (cycle-checked), and the
      // in-betweener keyframes.
      if (targetVid) return c.targetHandle === "in-image";
      if (c.target === "output") return c.targetHandle === "in-out";
      if (tgtEditId && c.targetHandle === "in-image") return tgtEditId !== srcEditId && !editNodeDependsOnClient(shot, srcEditId, tgtEditId);
      if (c.target === "tween") return tweenSlotOk(`${TWEEN_KEY_EDITGEN_PREFIX}${srcEditId}`);
      return false;
    }
    const refId = /^ref:(.+)$/.exec(source)?.[1];
    if (refId) {
      const ref = references.find((r) => r.id === refId);
      if (c.target === "output") return c.targetHandle === "in-out" && !!ref && ref.media !== "audio";
      if (targetVid) return c.targetHandle === "in-image" && !!ref && !!ref.artwork && ref.media !== "audio";
      if (tgtEditId) return c.targetHandle === "in-image" && !!ref && !!ref.artwork && ref.media !== "audio";
      if (c.target === "tween") {
        // Image refs only; a 5th socket rejects newcomers (replacing the
        // ref in its own socket is always allowed).
        const m = /^in-tween-(\d+)$/.exec(c.targetHandle ?? "");
        if (!m || Number(m[1]) > 4) return false;
        if (!ref || !ref.artwork || ref.media === "audio") return false;
        const ids = shot.graphTweenRefIds ?? [];
        return ids.includes(refId) || ids.length < 5;
      }
      if (c.target === "composer" || targetVideoPrompt || c.target === "editvideoprompt" || targetEditPrompt) {
        // The open socket appends; dropping onto an occupied reference socket
        // replaces the reference in that slot (same type — an image/any ref).
        return (c.targetHandle === "in-ref-open" || /^in-ref-\d+$/.test(c.targetHandle ?? "")) && !!ref;
      }
      return false;
    }
    if (c.target === "composer" || targetVideoPrompt || c.target === "editvideoprompt" || targetEditPrompt) {
      if (source === "style") return c.targetHandle === "in-style";
      if (source === "brand") return c.targetHandle === "in-brand";
      return false;
    }
    return false;
  }, [references, shot.graphTweenRefIds, shot]);

  const onConnectEnd = useCallback<OnConnectEnd>((_event, state) => {
    // Blender-style disconnect: grab a link at either end and release it into
    // empty space. Releasing on/near any socket snaps back instead.
    if (state.isValid || state.toHandle) return;
    const from = state.fromHandle;
    if (!from) return;
    // Stored-graph removal first (see header note): mirrors the legacy strip
    // below handle-for-handle. Null = no mapped wire; the legacy path still runs.
    {
      const cur = cb.current.graph;
      if (cur) {
        const next = graphEdgesForDetach(
          cur,
          { type: String(from.type ?? ""), nodeId: String(from.nodeId ?? ""), handleId: String((from as { id?: unknown }).id ?? "") },
          detachCtxFor(cur)
        );
        if (next) saveGraph(next);
      }
    }
    const detachPrompt = (nodeId: string, handleId: string): boolean => {
      const vpId = parseVideoPromptNode(nodeId);
      if (nodeId === "composer") {
        if (handleId === "in-style") {
          // The edge is the plug and the sidepanel mirrors it: detaching the
          // composer wire selects None so the dropdown reflects the unwired state.
          cb.current.onGraphField({ graphStyleConnected: false, styleNone: true });
          return true;
        }
        if (handleId === "in-brand") { cb.current.onToggleBrand(false); return true; }
        const m = /^in-ref-(\d+)$/.exec(handleId);
        if (m) { const t = tagged[Number(m[1])]; if (t && !applyDraftEdit("composer", (cur) => removeRefTag(cur, t.name))) cb.current.onPromptChange(removeRefTag(cb.current.prompt, t.name)); return true; }
      } else if (vpId) {
        const key = videoApplierKey(vpId);
        const curVal = cb.current.videoPromptValues?.get(vpId) ?? "";
        const applyVideo = (fn: (t: string) => string) => { if (!applyDraftEdit(key, fn)) patchVideoNode(vpId, { prompt: stripSharedSections(fn(curVal)) }); };
        if (handleId === "in-style") { patchVideoNode(vpId, { styleConnected: false }); return true; }
        if (handleId === "in-brand") return true;
        const m = /^in-ref-(\d+)$/.exec(handleId);
        if (m) {
          const idx = Number(m[1]);
          const fresh = appliers.current[key]?.get() ?? curVal;
          const freshName = refTagNames(fresh)[idx];
          const t = freshName ?? (cb.current.taggedVideoByNode?.get(vpId) ?? [])[idx]?.name;
          if (t) applyVideo((cur) => removeRefTag(cur, t));
          return true;
        }
      } else if (nodeId === "editprompt" || nodeId.startsWith(EDITPROMPT_NODE_PREFIX)) {
        const editId = nodeId === "editprompt" ? "edit0" : nodeId.slice(EDITPROMPT_NODE_PREFIX.length);
        const pv = cb.current.editPromptValues.get(editId) ?? "";
        const freshEdit = appliers.current[`edit:${editId}`]?.get() ?? pv;
        const patchNode = (patch: Partial<GraphEditNode>) => cb.current.onGraphField({ graphEditNodes: (cb.current.graphEditNodes ?? []).map((n) => (n.id === editId ? { ...n, ...patch } : n)) });
        const applyEdit = (fn: (t: string) => string) => { if (!applyDraftEdit(`edit:${editId}`, fn)) cb.current.onEditNodePrompt(editId, fn(freshEdit)); };
        if (handleId === "in-style") { patchNode({ styleConnected: false }); return true; }
        if (handleId === "in-brand") return true;
        const m = /^in-ref-(\d+)$/.exec(handleId);
        if (m) {
          const idx = Number(m[1]);
          const freshName = refTagNames(freshEdit)[idx];
          const t = freshName ?? (taggedEditByNode.get(editId) ?? [])[idx]?.name;
          if (t) applyEdit((cur) => removeRefTag(cur, t));
          return true;
        }
      }
      return false;
    };
    if (from.type === "target" && (from.nodeId === "composer" || parseVideoPromptNode(from.nodeId ?? "") !== null || from.nodeId === "editprompt" || (from.nodeId ?? "").startsWith(EDITPROMPT_NODE_PREFIX))) {
      if (detachPrompt(from.nodeId ?? "", from.id ?? "")) return;
    }
    {
      const tgtVid = parseVideoGenNode(from.nodeId ?? "");
      if (from.type === "target" && tgtVid && from.id === "in-image") {
        cb.current.onUnpipeImageToVideo(tgtVid);
        return;
      }
    }
    if (from.type === "target") {
      const editId = parseEditGenNode(from.nodeId ?? "");
      if (editId && from.id === "in-image") {
        cb.current.onGraphField({ graphEditNodes: (cb.current.graphEditNodes ?? []).map((n) => (n.id === editId ? { ...n, source: undefined } : n)) });
        return;
      }
    }
    if (from.type === "target" && from.nodeId === "cameraGrid") {
      if (from.id === "in-image") { stable.onCameraGridSave({ source: undefined }); return; }
      // Unplugging the grid image leaves the last sheet in place (still cuttable).
      if (from.id === "in-grid") { stable.onCameraGridSave({ gridSource: undefined }); return; }
      const m = /^in-ref-(\d+)$/.exec(from.id ?? "");
      if (m) {
        const cur = normalizeCameraGridData(cb.current.graphCameraGrid);
        const refIds = removeCameraGridRefAt(cur?.refIds ?? [], Number(m[1]));
        stable.onCameraGridSave({ refIds: refIds.length ? refIds : undefined });
        const g = cb.current.graph ?? normalizeGraph(materializeGraph(shot, cb.current.references)).graph;
        saveGraph(applyCameraGridRefs(g, refIds));
        return;
      }
      return;
    }
    if (from.type === "target" && from.nodeId === "upscale") {
      if (from.id === "in-image") stable.onUpscaleSave({ source: undefined });
      return;
    }
    if (from.type === "target" && from.nodeId === "tween") {
      // Dragging a keyframe link off its socket removes that keyframe.
      const m = /^in-tween-(\d+)$/.exec(from.id ?? "");
      if (m) {
        const idx = Number(m[1]);
        const ids = cb.current.graphTweenRefIds ?? [];
        if (idx >= 0 && idx < ids.length) cb.current.onTweenRefs(ids.filter((_, i) => i !== idx));
      }
      return;
    }
    if (from.type === "target" && from.nodeId === "output" && from.id === "in-out") {
      cb.current.onUnpipeOutput();
      return;
    }
    if (from.type === "source" && from.nodeId === "imagegen") {
      if (cb.current.graphCameraGrid?.source?.kind === "imagegen") stable.onCameraGridSave({ source: undefined });
      if (cb.current.graphUpscale?.source?.kind === "imagegen") stable.onUpscaleSave({ source: undefined });
      cb.current.onUnpipeImageGen();
      return;
    }
    if (from.type === "source" && from.nodeId === "upscale") {
      if (cb.current.graphOutputSource === "upscale") cb.current.onUnpipeOutput();
      return;
    }
    if (from.type === "source" && parseVideoGenNode(from.nodeId ?? "") !== null) {
      cb.current.onUnpipeVideoGen();
      return;
    }
    if (from.type === "source" && from.nodeId === "tween") {
      cb.current.onUnpipeTweenGen();
      return;
    }
    if (from.type === "source") {
      const editSrcId = parseEditGenNode(from.nodeId ?? "");
      if (editSrcId) {
        const gs = cb.current.graphCameraGrid?.source;
        if (gs?.kind === "editgen" && gs.nodeId === editSrcId) stable.onCameraGridSave({ source: undefined });
        const us = cb.current.graphUpscale?.source;
        if (us?.kind === "editgen" && us.nodeId === editSrcId) stable.onUpscaleSave({ source: undefined });
        cb.current.onUnpipeEditGen(editSrcId);
        return;
      }
    }
    if (from.type === "source") {
      if (from.nodeId === "style") {
        // The style edge(s) were removed above; clear the legacy plug flags
        // only. The shot's style selection (which style / None) is independent
        // of the connection and must survive a disconnect.
        const editNodesNext = (cb.current.graphEditNodes ?? []).map((n) => (n.styleConnected ? { ...n, styleConnected: false } : n));
        cb.current.onGraphField({
          graphStyleConnected: false,
          graphVideoStyleConnected: false,
          ...(editNodesNext.some((n, i) => n !== (cb.current.graphEditNodes ?? [])[i]) ? { graphEditNodes: editNodesNext } : {}),
        });
        return;
      }
      if (from.nodeId === "brand") {
        // The brand edge(s) were removed above; the clause renders from the
        // set. Clear the composer's shot-level toggle mirror too.
        cb.current.onToggleBrand(false);
        return;
      }
      const m = /^ref:(.+)$/.exec(from.nodeId ?? "");
      if (!m) return;
      const refId = m[1];
      // Remove this ref from any prompt where it is tagged (fresh draft text
      // wins over the saved prop so a focused prompt can't resurrect the tag
      // on blur).
      const findName = (list: { name: string; ref: GraphRef | null }[]) =>
        list.find((t) => (t.ref?.id ?? `missing:${t.name.toLowerCase()}`) === refId || t.ref?.id === refId)?.name;
      const composerName = findName(tagged);
      if (composerName) {
        if (!applyDraftEdit("composer", (t) => removeRefTag(t, composerName))) {
          if (refTagNames(cb.current.prompt).some((n) => n.toLowerCase() === composerName.toLowerCase())) cb.current.onPromptChange(removeRefTag(cb.current.prompt, composerName));
        }
      }
      // Every video node: strip the ref from its prompt (draft-aware) and drop
      // it as a source/reference.
      const vidNext = (cb.current.graphVideoNodes ?? []).map((n) => {
        const key = videoApplierKey(n.id);
        const fresh = appliers.current[key]?.get() ?? cb.current.videoPromptValues?.get(n.id) ?? n.prompt ?? "";
        const name = findName(cb.current.taggedVideoByNode?.get(n.id) ?? []);
        const needsStrip = !!name && refTagNames(fresh).some((nm) => nm.toLowerCase() === name.toLowerCase());
        if (needsStrip && name) applyDraftEdit(key, (t) => removeRefTag(t, name));
        const source = n.source?.kind === "ref" && n.source.refId === refId ? undefined : n.source;
        const refIds = n.refIds?.includes(refId) ? n.refIds.filter((id) => id !== refId) : n.refIds;
        const prompt = needsStrip && name ? removeRefTag(fresh, name) : n.prompt;
        return prompt !== n.prompt || source !== n.source || refIds !== n.refIds ? { ...n, prompt, source, refIds } : n;
      });
      if (vidNext.some((n, i) => n !== (cb.current.graphVideoNodes ?? [])[i])) cb.current.onGraphField({ graphVideoNodes: vidNext });
      // Edit nodes: strip the ref from every node prompt (draft-aware) and
      // clear its source. The batch carries the same stripped text the draft
      // already saved so the two writes can't fight.
      const refName = cb.current.references.find((r) => r.id === refId)?.name
        ?? unionTagged.find((t) => (t.ref?.id ?? `missing:${t.name.toLowerCase()}`) === refId || t.ref?.id === refId)?.name;
      if (refName) {
        const editNext = (cb.current.graphEditNodes ?? []).map((n) => {
          const fresh = appliers.current[`edit:${n.id}`]?.get() ?? n.prompt ?? "";
          const needsStrip = refTagNames(fresh).some((nm) => nm.toLowerCase() === refName.toLowerCase());
          const nextPrompt = needsStrip ? removeRefTag(fresh, refName) : null;
          if (needsStrip) applyDraftEdit(`edit:${n.id}`, (t) => removeRefTag(t, refName));
          const source = n.source?.kind === "ref" && n.source.refId === refId ? undefined : n.source;
          if (nextPrompt === null && source === n.source) return n;
          return { ...n, ...(nextPrompt !== null ? { prompt: nextPrompt } : {}), source };
        });
        if (editNext.some((n, i) => n !== (cb.current.graphEditNodes ?? [])[i])) cb.current.onGraphField({ graphEditNodes: editNext });
      } else {
        const editNodesNext = (cb.current.graphEditNodes ?? []).map((n) => {
          const source = n.source?.kind === "ref" && n.source.refId === refId ? undefined : n.source;
          return source !== n.source ? { ...n, source } : n;
        });
        if (editNodesNext.some((n, i) => n !== (cb.current.graphEditNodes ?? [])[i])) cb.current.onGraphField({ graphEditNodes: editNodesNext });
      }
      // Also check union dangling tag by name
      const unionEntry = unionTagged.find((t) => (t.ref?.id ?? `missing:${t.name.toLowerCase()}`) === refId || t.ref?.id === refId);
      if (unionEntry) {
        // Ensure removal even if not in per-prompt list due to timing
        const freshComposer = appliers.current["composer"]?.get() ?? cb.current.prompt;
        if (refTagNames(freshComposer).some((n) => n.toLowerCase() === unionEntry.name.toLowerCase())) { if (!applyDraftEdit("composer", (t) => removeRefTag(t, unionEntry.name))) cb.current.onPromptChange(removeRefTag(cb.current.prompt, unionEntry.name)); }
        const unionVidNext = (cb.current.graphVideoNodes ?? []).map((n) => {
          const key = videoApplierKey(n.id);
          const fresh = appliers.current[key]?.get() ?? cb.current.videoPromptValues?.get(n.id) ?? n.prompt ?? "";
          if (!refTagNames(fresh).some((nm) => nm.toLowerCase() === unionEntry.name.toLowerCase())) return n;
          applyDraftEdit(key, (t) => removeRefTag(t, unionEntry.name));
          return { ...n, prompt: removeRefTag(fresh, unionEntry.name) };
        });
        if (unionVidNext.some((n, i) => n !== (cb.current.graphVideoNodes ?? [])[i])) cb.current.onGraphField({ graphVideoNodes: unionVidNext });
        const freshEditVideo = appliers.current["editvideo"]?.get() ?? cb.current.graphEditVideoPrompt ?? "";
        if (refTagNames(freshEditVideo).some((n) => n.toLowerCase() === unionEntry.name.toLowerCase())) { if (!applyDraftEdit("editvideo", (t) => removeRefTag(t, unionEntry.name))) cb.current.onGraphField({ graphEditVideoPrompt: removeRefTag(cb.current.graphEditVideoPrompt ?? "", unionEntry.name) }); }
        const editUnionNext = (cb.current.graphEditNodes ?? []).map((n) => {
          const fresh = appliers.current[`edit:${n.id}`]?.get() ?? n.prompt ?? "";
          if (!refTagNames(fresh).some((nm) => nm.toLowerCase() === unionEntry.name.toLowerCase())) return n;
          applyDraftEdit(`edit:${n.id}`, (t) => removeRefTag(t, unionEntry.name));
          return { ...n, prompt: removeRefTag(fresh, unionEntry.name) };
        });
        if (editUnionNext.some((n, i) => n !== (cb.current.graphEditNodes ?? [])[i])) cb.current.onGraphField({ graphEditNodes: editUnionNext });
      }
      if (cb.current.graphOutputSource === "ref" && cb.current.graphOutputRefId === refId) cb.current.onUnpipeOutput();
      if (cb.current.graphVideoSourceRefId === refId) cb.current.onGraphField({ graphVideoSourceRefId: undefined });
      if (cb.current.graphEditVideoSourceRefId === refId) cb.current.onGraphField({ graphEditVideoSourceRefId: undefined });
      // A keyframe removed from the canvas leaves the tween wiring too.
      if ((cb.current.graphTweenRefIds ?? []).includes(refId)) {
        cb.current.onTweenRefs((cb.current.graphTweenRefIds ?? []).filter((id) => id !== refId));
      }
      // The camera grid may have this ref as its source image, its grid image,
      // or a wired reference — drop any. Removing a reference socket renumbers
      // the remaining ones, so rebuild the positional edges too.
      const gridSrc = cb.current.graphCameraGrid?.source;
      const gridImageSrc = cb.current.graphCameraGrid?.gridSource;
      const gridRefIds = cb.current.graphCameraGrid?.refIds ?? [];
      if ((gridSrc?.kind === "ref" && gridSrc.refId === refId)
        || (gridImageSrc?.kind === "ref" && gridImageSrc.refId === refId)
        || gridRefIds.includes(refId)) {
        const refIds = gridRefIds.filter((id) => id !== refId);
        stable.onCameraGridSave({
          ...(gridSrc?.kind === "ref" && gridSrc.refId === refId ? { source: undefined } : {}),
          ...(gridImageSrc?.kind === "ref" && gridImageSrc.refId === refId ? { gridSource: undefined } : {}),
          ...(gridRefIds.includes(refId) ? { refIds: refIds.length ? refIds : undefined } : {}),
        });
        if (gridRefIds.includes(refId)) {
          const g = cb.current.graph ?? normalizeGraph(materializeGraph(shot, cb.current.references)).graph;
          saveGraph(applyCameraGridRefs(g, refIds));
        }
      }
    }
  }, [tagged, taggedVideo, taggedEditByNode, unionTagged]);

  useEffect(() => () => { if (hintTimer.current !== null) window.clearTimeout(hintTimer.current); }, []);

  /** Where a pasted reference lands: the viewport center in flow coordinates,
   *  staggered so multi-image pastes don't stack. Falls back to the reference
   *  column when the flow transform isn't measurable yet. */
  const pastePosition = useCallback(() => {
    const p = flowRef.current?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const base = {
      x: Number.isFinite(p?.x) ? (p?.x ?? REF_X) : REF_X,
      y: Number.isFinite(p?.y) ? (p?.y ?? REF_COL_TOP) : REF_COL_TOP,
    };
    const n = pasteCountRef.current++;
    return { x: base.x + (n % 5) * 32, y: base.y + (n % 5) * 32 };
  }, []);

  // Ctrl+V with an image creates a reference AND places its node on the
  // canvas — same as dropping the file, but at the viewport center. Pasted
  // files are auto-numbered (Ref-001…) by the parent so a batch never collides
  // on a generic clipboard file name. Text pastes are untouched.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file" && (item.type.startsWith("image/") || item.type.startsWith("video/") || item.type.startsWith("audio/"))) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      void (async () => {
        if (onPasteFiles) {
          const refs = await onPasteFiles(files);
          for (const ref of refs ?? []) addPlacedRef(ref, pastePosition());
          return;
        }
        for (const file of files) {
          const ref = await onDropFile(file);
          if (ref) addPlacedRef(ref, pastePosition());
        }
      })();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onDropFile, onPasteFiles, addPlacedRef, pastePosition]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Map the drop point into flow coordinates; fall back to the origin when
    // the transform isn't measurable (pre-init, jsdom) or yields non-finite.
    const p = flowRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const pos = { x: Number.isFinite(p?.x) ? (p?.x ?? 0) : 0, y: Number.isFinite(p?.y) ? (p?.y ?? 0) : 0 };
    // Right-panel tool drag: place a video/edit/tween node at the drop point.
    const toolKind = e.dataTransfer.getData("application/x-cascade-tool");
    if (toolKind === "video" || toolKind === "edit" || toolKind === "tween" || toolKind === "editvideo" || toolKind === "cameraGrid" || toolKind === "upscale") {
      addTool(toolKind, pos);
      return;
    }
    // Shelf drag: place a reference node at the drop point.
    const refId = e.dataTransfer.getData("application/x-cascade-ref");
    if (refId) {
      const ref = references.find((r) => r.id === refId);
      if (ref) addPlacedRef(ref, pos);
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    void (async () => {
      // Stagger multi-file drops like pastes so every node stays visible.
      let n = 0;
      for (const file of files) {
        if (!file.type.startsWith("image/") && !file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
          showHint(`${file.name}: only image, video, and audio files become references.`);
          continue;
        }
        const ref = await onDropFile(file);
        if (ref) addPlacedRef(ref, { x: pos.x + (n % 5) * 32, y: pos.y + (n % 5) * 32 });
        n += 1;
      }
    })();
  }, [onDropFile, showHint, references, addPlacedRef, addTool]);

  return (
    <div className="prod-edit-overlay prod-graph-overlay" onClick={onClose}>
      <div className={"prod-graph-panel" + (magicActive ? " magic-active" : "") + (readOnly ? " prod-graph-readonly" : "")} onClick={(e) => e.stopPropagation()}>
        <div className="prod-graph-head">
          <span className="prod-graph-title">Shot {shot.number} — node graph</span>
          <span className="prod-graph-hint">Connections are stored wiring · drag references from the left shelf or tool nodes from the right panel onto the canvas · left-drag moves nodes · right-drag pans · drag a connection off a socket to detach it</span>
          {onToggleMagic && (
            <button
              className={"prod-btn prod-magic-btn" + (magicActive ? " active" : "")}
              disabled={magicBusy}
              onClick={onToggleMagic}
              title={magicActive ? "Disable Magic Prompt — restore original prompt" : "Enable Magic Prompt — show AI-generated content prompt"}
            >
              {magicBusy ? "…" : magicActive ? <><MagicIcon size={13} /> Magic On</> : <><MagicIcon size={13} /> Magic</>}
            </button>
          )}
          {magicActive && onRegenMagic && (
            <button
              className="prod-btn prod-magic-refresh"
              disabled={magicBusy}
              onClick={onRegenMagic}
              title="Regenerate Magic Prompts for ALL shots"
            >
              <RegenerateIcon size={13} />
            </button>
          )}
          {magicActive && onRegenMagicShot && (
            <button
              className="prod-btn prod-magic-refresh"
              disabled={magicBusy}
              onClick={onRegenMagicShot}
              title="Regenerate this shot's Magic Prompt only (other shots are untouched)"
            >
              {magicBusy ? "…" : <><RegenerateIcon size={13} /> This shot</>}
            </button>
          )}
          {readOnly && (
            <span className="prod-graph-readonly-note" title="The node graph is open in the detached canvas window">Editing in separate window</span>
          )}
          {onDetach && !readOnly && (
            <button className="prod-btn" onClick={onDetach} title="Open the node graph in a separate window you can move to another monitor">
              Pop out
            </button>
          )}
          <button className="prod-btn" onClick={onClose}>Close</button>
        </div>
        <div className="prod-graph-body">
          <div
            className={"prod-graph-shelf" + (shelfOpen ? "" : " collapsed")}
            style={shelfOpen ? { width: shelfWidth } : undefined}
          >
            {shelfOpen ? (
              <>
                <div className="prod-graph-shelf-head">
                  <div className="prod-graph-shelf-head-row">
                    <button
                      type="button"
                      className="prod-graph-shelf-toggle nodrag"
                      aria-expanded={true}
                      title="Collapse the reference shelf"
                      onClick={() => { setShelfOpen(false); dismissHighlight(); }}
                    >
                      <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M10 3L5 8l5 5V3z" fill="currentColor" /></svg>
                    </button>
                    <span className="prod-graph-shelf-title">References</span>
                  </div>
                  <span className="prod-graph-shelf-hint">Drag onto the canvas to add · drag the edge to resize</span>
                  {references.length > 0 && (
                    <input
                      className="prod-graph-shelf-search nodrag"
                      type="text"
                      value={shelfQuery}
                      onChange={(e) => { setShelfQuery(e.target.value); dismissHighlight(); }}
                      placeholder="Filter references…"
                      aria-label="Filter references"
                    />
                  )}
                </div>
                <div className={"prod-graph-shelf-list" + (shelfWidth >= SHELF_GRID_WIDTH ? " grid" : "")}>
                  {shelfGroups.map((group) => (
                    <ShelfGroup
                      key={group.title}
                      prodId={prod.meta.id}
                      group={group}
                      query={shelfQuery}
                      onCanvasRefIds={onCanvasRefIds}
                      highlightId={highlightRefId}
                      onDismissHighlight={dismissHighlight}
                      onZoom={stable.onShelfRefZoom}
                    />
                  ))}
                  {references.length === 0 && <div className="prod-graph-shelf-empty">No references yet — drop image, video, or audio files onto the canvas to create them.</div>}
                  {references.length > 0 && shelfGroups.every((g) => qShelfMatch(g.refs, shelfQuery).length === 0) && (
                    <div className="prod-graph-shelf-empty">No references match “{shelfQuery.trim()}”.</div>
                  )}
                </div>
                <div
                  className="prod-graph-shelf-resize nodrag"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize the reference shelf"
                  title="Drag to resize"
                  onPointerDown={onShelfResizeDown}
                  onPointerMove={onShelfResizeMove}
                  onPointerUp={onShelfResizeUp}
                  onPointerCancel={onShelfResizeUp}
                />
              </>
            ) : (
              <button
                type="button"
                className="prod-graph-shelf-rail nodrag"
                aria-expanded={false}
                title="Show the reference shelf"
                onClick={() => setShelfOpen(true)}
              >
                <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M6 3l5 5-5 5V3z" fill="currentColor" /></svg>
                <span className="prod-graph-shelf-rail-label">References</span>
                {references.length > 0 && <span className="prod-graph-shelf-rail-count">{references.length}</span>}
              </button>
            )}
          </div>
          <div className="prod-graph-canvas" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }} onDrop={onDrop}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={(inst) => { flowRef.current = inst; }}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              isValidConnection={isValidConnection}
              onMoveEnd={(_event, viewport) => onSaveLayout({ viewport })}
              fitView={!initialLayout?.viewport}
              defaultViewport={initialLayout?.viewport ?? { x: 0, y: 0, zoom: 1 }}
              fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
              minZoom={0.2}
              connectionRadius={30}
              nodesConnectable
              connectionLineType={ConnectionLineType.Bezier}
              autoPanOnSelection={false}
              elevateEdgesOnSelect
              nodesDraggable
              panOnDrag={[1, 2]}
              selectionOnDrag
              deleteKeyCode={["Backspace", "Delete"]}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={22} />
            </ReactFlow>
          {dropHint && <div className="prod-graph-drop-hint">{dropHint}</div>}
          {lightbox && (
            <div
              className="prod-ref-lightbox prod-graph-lightbox"
              onClick={() => setLightbox(null)}
              onContextMenu={(e) => { if (lightbox.rel) lightboxMenu.open(e, lightbox.rel, { src: lightbox.artwork, media: lightbox.kind }); }}
            >
              <figure className="prod-ref-lightbox-card">
                {lightbox.kind === "video" ? (
                  <video className="prod-ref-lightbox-video" src={lightbox.artwork} controls autoPlay playsInline />
                ) : (
                  <img src={lightbox.artwork} alt={lightbox.name} />
                )}
                <figcaption>{lightbox.name} — click anywhere to close{lightbox.rel ? " — right-click for options" : ""}</figcaption>
              </figure>
            </div>
          )}
          <GenerationMenu menu={lightboxMenu.menu} onClose={lightboxMenu.close} onSaveAsReference={stable.onSaveAsRef} onEditInSuite={stable.onEditInSuite} />
          </div>
          <div className="prod-graph-tools">
            <div className="prod-graph-tools-head">
              <span className="prod-graph-tools-title">Nodes</span>
              <span className="prod-graph-tools-hint">Drag onto the canvas to add</span>
            </div>
            <div className="prod-graph-tools-list">
              <div
                className={"prod-graph-tools-item" + (hasVideoTool ? " on-canvas" : "")}
                draggable
                title="Drag onto the canvas to add another video generation node"
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-cascade-tool", "video");
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                <FilmStripIcon size={14} className="prod-graph-tools-icon" />
                <span className="prod-graph-tools-label">Video generation</span>
                {hasVideoTool && <span className="prod-graph-shelf-count">{videoNodes.length}</span>}
                {hasVideoTool && (
                  <button
                    className="prod-graph-tools-remove"
                    disabled={videoGenActive}
                    title={videoGenActive ? "In use — clear clips or pipes first" : "Remove all video nodes"}
                    onClick={() => removeTool("video")}
                  ><XIcon size={9} /></button>
                )}
              </div>
              <div
                className="prod-graph-tools-item"
                draggable
                title="Drag onto the canvas to add another edit-image node"
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-cascade-tool", "edit");
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                <EditIcon size={14} className="prod-graph-tools-icon" />
                <span className="prod-graph-tools-label">Edit image</span>
                {hasEditTool && <span className="prod-graph-shelf-count">{editNodes.length}</span>}
              </div>
              <div
                className={"prod-graph-tools-item" + (hasEditVideoTool ? " on-canvas" : "") + (videoEditUnavailable ? " disabled" : "")}
                draggable={!hasEditVideoTool && !videoEditUnavailable}
                aria-disabled={videoEditUnavailable}
                title={videoEditUnavailable ? VIDEO_EDIT_UNAVAILABLE_HINT : hasEditVideoTool ? "Already on the canvas" : "Drag onto the canvas to add the edit-video node"}
                onDragStart={(e) => {
                  if (videoEditUnavailable) { e.preventDefault(); return; }
                  e.dataTransfer.setData("application/x-cascade-tool", "editvideo");
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                <EditVideoIcon size={14} className="prod-graph-tools-icon" />
                <span className="prod-graph-tools-label">Edit video</span>
                {hasEditVideoTool && (
                  <button
                    className="prod-graph-tools-remove"
                    disabled={editVideoActive}
                    title={editVideoActive ? "In use — has clips or is piped" : "Remove from the canvas"}
                    onClick={() => removeTool("editvideo")}
                  ><XIcon size={9} /></button>
                )}
              </div>
              <div
                className={"prod-graph-tools-item" + (hasTweenTool ? " on-canvas" : "")}
                draggable={!hasTweenTool}
                title={hasTweenTool ? "Already on the canvas" : "Drag onto the canvas to add the in-betweener node"}
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-cascade-tool", "tween");
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                <InbetweenIcon size={14} className="prod-graph-tools-icon" />
                <span className="prod-graph-tools-label">In-betweener</span>
                {hasTweenTool && (
                  <button
                    className="prod-graph-tools-remove"
                    disabled={tweenActive}
                    title={tweenActive ? "In use — has keyframes or pipes" : "Remove from the canvas"}
                    onClick={() => removeTool("tween")}
                  ><XIcon size={9} /></button>
                )}
              </div>
              <div
                className={"prod-graph-tools-item" + (hasCameraGridTool ? " on-canvas" : "")}
                draggable={!hasCameraGridTool}
                title={hasCameraGridTool ? "Already on the canvas" : "Drag onto the canvas to add the 16-angle camera grid node"}
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-cascade-tool", "cameraGrid");
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" className="prod-graph-tools-icon" aria-hidden="true"><path fill="currentColor" d="M1 1h6v6H1V1zm8 0h6v6H9V1zM1 9h6v6H1V9zm8 0h6v6H9V9z" /></svg>
                <span className="prod-graph-tools-label">Camera grid</span>
                {hasCameraGridTool && (
                  <button
                    className="prod-graph-tools-remove"
                    disabled={cameraGridActive}
                    title={cameraGridActive ? "In use — has a generated sheet" : "Remove from the canvas"}
                    onClick={() => removeTool("cameraGrid")}
                  ><XIcon size={9} /></button>
                )}
              </div>
              <div
                className={"prod-graph-tools-item" + (hasUpscaleTool ? " on-canvas" : "") + (upscaleUnavailable ? " disabled" : "")}
                draggable={!hasUpscaleTool && !upscaleUnavailable}
                aria-disabled={upscaleUnavailable}
                title={upscaleUnavailable ? UPSCALE_UNAVAILABLE_HINT : hasUpscaleTool ? "Already on the canvas" : "Drag onto the canvas to add the upscale node"}
                onDragStart={(e) => {
                  if (upscaleUnavailable) { e.preventDefault(); return; }
                  e.dataTransfer.setData("application/x-cascade-tool", "upscale");
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" className="prod-graph-tools-icon" aria-hidden="true"><path fill="currentColor" d="M8 1l4 4h-3v5H7V5H4l4-4zm-5 12h10v2H3v-2z" /></svg>
                <span className="prod-graph-tools-label">Upscale</span>
                {hasUpscaleTool && (
                  <button
                    className="prod-graph-tools-remove"
                    disabled={upscaleActive}
                    title={upscaleActive ? "In use — has generated outputs" : "Remove from the canvas"}
                    onClick={() => removeTool("upscale")}
                  ><XIcon size={9} /></button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {tweenOpen && (
        <TweenTimelineModal
          prodId={prod.meta.id}
          shotNumber={shot.number}
          refIds={shot.graphTweenRefIds ?? []}
          blocks={shot.graphTweenBlocks ?? []}
          keyframes={tweenKeyframesFor(shot, prod.meta.id, shot.graphTweenRefIds ?? [], new Map(references.map((r) => [r.id, r])))}
          model={shot.graphTweenModel ?? getMediaDefault("tween")?.model ?? "auto"}
          resolution={shot.graphTweenResolution ?? getMediaDefault("tween")?.resolution ?? "1080p"}
          videoModels={filterTweenModels(videoModels, endFrameModelIds)}
          onModelOptions={stable.onModelOptions}
          onModelChange={(m) => { onGraphField({ graphTweenModel: m }); rememberMediaDefault("tween", { model: m }); }}
          onResolutionChange={(r) => { onGraphField({ graphTweenResolution: r }); rememberMediaDefault("tween", { resolution: r }); }}
          params={shot.graphTweenParams ?? {}}
          onParamsChange={(p) => onGraphField({ graphTweenParams: p })}
          onModelSchema={stable.onModelSchema}
          onBlocksChange={(b: TweenBlock[]) => onGraphField({ graphTweenBlocks: b })}
          onDeleteGen={onDeleteGeneration}
          onSaveAsRef={stable.onSaveAsRef}
          onRunBlock={(blockId: string, durationSec: number, model: string, params?: GenParams) => onRunTweenBlock(blockId, durationSec, model, params)}
          busyBlock={busyBlock}
          pendingBlockId={shot.pendingVideoGen?.target?.kind === "tween" ? shot.pendingVideoGen.target.blockId : null}
          onFetchBlock={() => onFetchVideo()}
          onStitch={() => onStitchTween()}
          onUnstitch={() => onUnstitchTween()}
          stitching={stitching}
          stitched={!!shot.graphTweenOutput}
          reencoded={shot.graphTweenReencoded === true}
          stitchUrl={shot.graphTweenOutput ? graphMediaUrl(prod.meta.id, shot.graphTweenOutput) : null}
          onPipeToOutput={onPipeTweenToOutput}
          piped={shot.graphOutputSource === "tween"}
          onClose={() => setTweenOpen(false)}
        />
      )}
      {cameraGridEditorOpen && (() => {
        const grid = normalizeCameraGridData(shot.graphCameraGrid);
        if (!grid?.sheetPath) return null;
        const sheetPath = grid.sheetPath;
        return (
          <CameraGridEditor
            sheetUrl={graphMediaUrl(prod.meta.id, sheetPath)}
            sheetPath={sheetPath}
            cols={grid.cols}
            rows={grid.rows}
            panels={resolveCameraGridPanels(grid)}
            panelLabels={resolvePanelLabels(grid.cols * grid.rows, grid.panelLabels)}
            inset={grid.inset ?? 0}
            onInsetChange={(v) => stable.onCameraGridSave({ inset: v })}
            onSizeChange={(c, r) => stable.onCameraGridSave({ cols: c, rows: r, panels: undefined, panelLabels: undefined })}
            onExport={async (rects, labels, single) => (await stable.onExportCameraGridPanels(sheetPath, rects, labels, single)).length}
            onZoom={stable.onZoom}
            onClose={() => setCameraGridEditorOpen(false)}
          />
        );
      })()}
    </div>
  );
}
