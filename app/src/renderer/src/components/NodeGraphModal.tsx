/**
 * Storyboard node graph: a visual projection of one shot's stored graph.
 *
 * `shot.graph` (nodes + typed edges) is the wiring truth — edges render from
 * it and connections mutate it. Prompt text stays the generation input until
 * step 05, so connect/disconnect writes both projections from the same event
 * (LEGACY-PROJECTION); generation, history, and prompts-export are untouched.
 */
import { Fragment, memo, useCallback, useContext, createContext, useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
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
import { TWEEN_KEY_IMGGEN, TWEEN_KEY_EDITGEN, TWEEN_KEY_EDITGEN_PREFIX, isVideoGenRef, modelOnSurface, UPSCALE_UNAVAILABLE_HINT, 
VIDEO_EDIT_UNAVAILABLE_HINT, GENJUTSU_UNAVAILABLE_HINT, defaultGenjutsuModelId, genjutsuJobTypesForMode, genjutsuModeForModelId, genjutsuNodes, isGenjutsuMode, isVideoEditFamilyMode, nextGenjutsuNodeId, rawMediaModelId, videoGenNodeId, videoPromptNodeId, parseVideoGenNode, parseVideoPromptNode, nextVideoNodeId, 
editVideoGenNodeId, editVideoPromptNodeId, parseEditVideoGenNode, parseEditVideoPromptNode, nextEditVideoNodeId, 
CAMERA_GRID_COLS, CAMERA_GRID_ROWS, CAMERA_GRID_SIZES, cameraGridSizeKey, resolveCameraGridPanels, resolvePanelLabels, 
gridRectFromPoints, touchedPanelIndices, unionGridRects, insetGridRect, normalizeCameraGridData, placeCameraGridRef, 
removeCameraGridRefAt, type CameraGridData, type CameraGridPanel, type CameraGridGenOptions, type 
CameraGridCutoutRequest, type CameraGridImportResult, type GraphSource, type UpscaleData, type ImageGenAspectRatio, 
type CliModelSchema, type GenParams, type GenjutsuMode, type Graph, type GraphEditNode, type GraphGenItem, type GraphVideoNode, type GraphVideoNodeMode, type 
  GraphLayout, GraphLayoutPatch, type OpenArtModelChoice, type Production, type ProductionShot, type ProductionStyle, type TweenBlock, 
type VideoModelOptions } from "../../../shared/ipc.js";
import { normalizeSequenceSegments, sequenceTotalDuration, DRAFT_RESOLUTION, isDraftOnlyModel, type SequenceSegment } from "../../../shared/ipc.js";
import { ModelOptionsForm, pruneModelOptionValues, type ModelOptionValues } from "./ModelOptionsForm.js";
import { closestResolution, resolutionsForSchema } from "./resolution.js";
import { resolutionsAllowedByRules } from "../../../shared/cel-lite.js";
/** Image resolution choices: the model schema's own list when it declares one, else the stock ladder. */
function imageResOptions(schema: CliModelSchema | null): string[] {
  const v = schema?.fields.find((f) => f.name === "resolution")?.values;
  return v && v.length ? v : ["1k", "2k", "4k"];
}
import { enforceSourceTag, composePromptBoxes, parsePromptBoxes, refTagNames, removeRefTag, stripBrandParagraph, syncRefTags } from "../../../shared/prompt-grammar.js";
import { resolveRefByTagName } from "../../../shared/ref-names.js";
import { referenceUsage } from "../../../shared/reference-usage.js";
import { TriplePrompt, type PromptContentHandle } from "./TriplePrompt.js";
import { TweenTimelineModal, deriveTweenBlocksClient, filterTweenModels } from "./TweenTimelineModal.js";
import { usePersistedCollapsed, usePersistedNumber } from "./production/persisted-state.js";
import { refThumbUrl } from "./production/thumb-url.js";
import { mediaRev, bumpMediaRev } from "./production/media-rev.js";
import { RefNodeView, refSizeStyle, REF_COLLAPSED_WIDTH, REF_DEFAULT_WIDTH, type GraphRef, type RefData, type RefFlowNode } from "./graph/ref-node.js";
import { refDragIds } from "./production/references.js";
import { VideoPreview } from "./graph/video-preview.js";
import { GraphLodProvider, GRAPH_CULL_NODE_LIMIT, GRAPH_PREVIEW_EDGE, GRAPH_TILE_EDGE, type GraphLodHandle } from "./graph/lod.js";
import { RefShelf } from "./graph/ref-shelf.js";
import { getMediaDefault, rememberMediaDefault } from "./production/media-defaults.js";
import { DurationField, clampDurationSec, snapDurationSec } from "./production/duration-field.js";
import { getPromptTemplate } from "./production/prompt-templates.js";
import { openSettings } from "./settings/open-settings.js";
import { OpenInSuiteButton } from "./common/OpenInSuiteButton.js";
import { MediaLightbox } from "./common/MediaLightbox.js";
import { stepLightbox, type ZoomNav } from "./graph/lightbox-nav.js";
import { openImageSuite } from "../features/suite/suite-handoff.js";
import { genQueue, genKeys, genButtonLabel, useGenStatus } from "./production/gen-queue.js";
import { costAspect, isQuotableCostModel } from "./production/generation-cost.js";
import { GenerationCostSuffix } from "./production/generation-cost-label.js";
import { seedModelOptionValues } from "./production/model-param-defaults.js";
import { useImageContextMenu } from "./image-context-menu.js";
import { graphEdgesToFlow, promptSockets, type PromptSocket } from "./graphFlow.js";
import { WaypointContext, WaypointEdge, type WaypointHandlers } from "./graph/WaypointEdge.js";
import { storedOrMaterializedGraph, videoNodesFor } from "../../../shared/graph/materialize.js";
import { normalizeGraph } from "../../../shared/graph/normalize.js";
import { addGraphNode, applyCameraGridRefs, applyConnection, applyTweenKeys, canonicalNodeId, connectionToEdge, connectTweenKey, ensurePromptPipe, graphEdgesForDetach, nodeKindForId, promptRefWires, promptWiresAfterConnect, reconcilePromptRefEdges, removeGraphEdge, removeGraphNode, setStyleEdge, syncOutputEdge, tweenKeyForSource, tweenKeyToNode, wireComposerRefs, withPromptRefWires } from "../../../shared/graph/connect.js";
import { pickGraphShotPatch } from "../../../shared/graph/shot-patch.js";
import { tidyGraphLayout } from "../../../shared/graph/layout.js";
import { createUndoHistory } from "./production/undo-history.js";
import { canConnect, nodeOutputs, portDecl, refOutputMedia, REF_SOCKET_RE, TWEEN_SOCKET_RE } from "../../../shared/graph/ports.js";
import { traceChain } from "../../../shared/graph/trace.js";
import { nodeDataEqual } from "../../../shared/graph/reconcile.js";
import { resolveSelectedOutput, resolveShotDisplay } from "../../../shared/selected-output.js";
import { isBrandAttached, renderShotPrompt, stripSharedSections, styleEdgePresent } from "../../../shared/graph/render.js";
import { brandClauseText } from "../../../shared/look.js";
import { GenerationMenu, useGenerationMenu } from "./generation-menu.js";
import { confirmDestructive } from "./ConfirmDialog.js";
import { GraphHistoryModal, type GraphHistoryItem, type GraphHistoryTarget } from "./graph/history-modal.js";
import { EditIcon, EditVideoIcon, EyeIcon, EyeOffIcon, FilmStripIcon, GenjutsuMotionIcon, GenjutsuSwapIcon, InbetweenIcon, MagicIcon, MagnifyIcon, RegenerateIcon } from "./icons.js";

/** True when two prompt texts cite different reference tags (added,
 *  removed, or reordered) — the edits whose wires must follow at once. */
function refTagSequenceChanged(a: string, b: string): boolean {
  const ra = refTagNames(a).map((n) => n.toLowerCase());
  const rb = refTagNames(b).map((n) => n.toLowerCase());
  return ra.length !== rb.length || ra.some((n, i) => n !== rb[i]);
}

/** cascade-media URL for any workspace-relative asset in the production.
 *  Revision-aware (like `cascadeMedia`): a bumped revision changes the URL so a
 *  generated take whose file was edited outside Cascade re-fetches its pixels. */
function graphMediaUrl(prodId: string, rel: string): string {
  const base = `cascade-media://${prodId}/${encodeURIComponent(rel)}`;
  const rev = mediaRev(prodId, rel);
  return rev ? `${base}?v=${rev}` : base;
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
/** The edit node id EITHER member of an edit-node pair refers to ("edit0").
 *  Shared by deletion and the removal confirm so the pair is judged as one. */
function editNodeIdForCanvas(id: string): string | null {
  return parseEditGenNode(id)
    ?? (id === "editprompt" ? "edit0" : id.startsWith(EDITPROMPT_NODE_PREFIX) ? id.slice(EDITPROMPT_NODE_PREFIX.length) : null);
}
/** The next unused edit node id in a shot's list ("edit0", "edit1", …). */
function nextEditNodeId(nodes: GraphEditNode[]): string {
  let i = 0;
  while (nodes.some((n) => n.id === `edit${i}`)) i++;
  return `edit${i}`;
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

/** Human ordinal for an edit-family node ("ev0"/"gm0"/"gs0" → " #1"). */
function editVideoNodeLabel(nodeId: string): string {
  const m = /^(?:ev|gm|gs)(\d+)$/.exec(nodeId);
  return m ? ` #${Number(m[1]) + 1}` : "";
}

/** The draft-applier registry key for an edit-video node's prompt. The first
 *  node keeps the historical `"editvideo"` key; additional nodes are namespaced. */
/** Display copy for one edit-family variant (Edit video / the two Genjutsu
 *  nodes share the view; only the words, icon, and model pool differ). */
interface EditFamilyVariant {
  /** The Genjutsu feature, or null for the generic edit-video node. */
  genjutsu: GenjutsuMode | null;
  title: string;
  promptTitle: string;
  placeholder: string;
  goLabel: string;
  busyLabel: string;
  emptyText: string;
}

function editFamilyVariant(mode: GraphVideoNodeMode | undefined): EditFamilyVariant {
  if (mode === "genjutsu-motion") {
    return {
      genjutsu: mode,
      title: "Genjutsu Motion Transfer",
      promptTitle: "Motion Transfer prompt",
      placeholder: "Optional — describe the new character or scene, connect references, or type @",
      goLabel: "Transfer motion",
      busyLabel: "Transferring…",
      emptyText: "No transfers yet",
    };
  }
  if (mode === "genjutsu-swap") {
    return {
      genjutsu: mode,
      title: "Genjutsu Object Swap",
      promptTitle: "Object Swap prompt",
      placeholder: "Optional — name what to swap (e.g. \"the red jacket\"), connect references, or type @",
      goLabel: "Swap object",
      busyLabel: "Swapping…",
      emptyText: "No swaps yet",
    };
  }
  return {
    genjutsu: null,
    title: "Edit video",
    promptTitle: "Edit video prompt",
    placeholder: "Edit instructions — connect references, type @, or edit the boxes",
    goLabel: "Edit video",
    busyLabel: "Editing…",
    emptyText: "No edits yet",
  };
}

function editVideoApplierKey(nodeId: string): string {
  return nodeId === "ev0" ? "editvideo" : `editvideo:${nodeId}`;
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
  const evId = parseEditVideoGenNode(nodeId);
  if (evId) {
    const node = (shot.graphVideoNodes ?? []).find((n) => n.id === evId);
    return node?.gens?.[node.genIndex ?? 0]?.path ?? null;
  }
  const editId = parseEditGenNode(nodeId);
  if (editId) {
    const node = (shot.graphEditNodes ?? []).find((n) => n.id === editId);
    return node?.gens?.[node.genIndex ?? 0]?.path ?? null;
  }
  return null;
}

/** Reference name for a generation node wired into a reference socket
 *  ("Edit Image #2", "Image"). */
export function generationNodeRefName(nodeId: string): string {
  const editId = parseEditGenNode(nodeId);
  if (editId) {
    const m = /^edit(\d+)$/.exec(editId);
    return m ? `Edit Image #${Number(m[1]) + 1}` : "Edit Image";
  }
  return "Image";
}

/** True for a prompt node id (composer / video / edit-video / an edit node). */
function isPromptNodeId(nodeId: string): boolean {
  return nodeId === "composer" || nodeId === "videoprompt" || nodeId.startsWith("videoprompt:") || nodeId === "editvideoprompt" || nodeId.startsWith("editvideoprompt:") || nodeId === "editprompt" || nodeId.startsWith(EDITPROMPT_NODE_PREFIX);
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

/** Fixed-width style for the content-sized generation nodes (height comes
 *  from the content - no saved size is applied). */
function fixedWidth(defaultWidth: number): { width: number } {
  return { width: defaultWidth };
}

/** Thumbnail variant of a reference's artwork URL (one home:
 *  `production/thumb-url.ts`). Canvas reference nodes render the full-res
 *  `artwork` directly (the graph is a working surface, not a list). */
export { refThumbUrl };
/** The reference tile (node + data + saved-size math) lives in
 *  `graph/ref-node.tsx` so the shot-sequence canvas renders the same node;
 *  re-exported here for the workspace's `GraphRef` imports. */
export type { GraphRef };

/** Per-model/per-mode cache for video form options — the MCP form lookup is
 *  slow, and nodes re-render often, so fetch each combination once. */
const videoOptionsCache = new Map<string, VideoModelOptions | null>();

/** Per-model full option schema (the Advanced panel), fetched once. */
const modelSchemaCache = new Map<string, CliModelSchema | null>();

/* ------------------------------------------------------------------ */
/* Node data shapes                                                    */
/* ------------------------------------------------------------------ */

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
  /** This shot's own saved model/resolution picks — win over the production
   *  defaults so the node remembers its choice across visits. */
  savedModel?: string;
  savedResolution?: string;
  /** Production quality tier — image submits bill it (the provider reads it
   *  off the production), so the quote must price it too. */
  productionQuality?: string;
  /** This shot's saved advanced/variant params (schema-driven). */
  savedParams?: GenParams;
  /** Every stored generation (newest first) as media URLs + stored path. */
  items: { url: string; prompt: string; path: string }[];
  selected: number;
  /** True while this shot's image generation runs (lifted to the workspace so
   *  the "Generating." label survives closing/reopening the graph). */
  busy: boolean;
  /** Generation-queue key for this node's "Generating (N queued)" button. */
  genKey: string;
  onGenerate: (model: string, resolution: string, params?: GenParams) => Promise<void>;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
  /** Right-click a take → delete it (blocked while it feeds a pipe/output). */
  onDeleteGen: (rel: string) => void;
  /** Right-click a take -> re-fetch it from disk (external-edit fallback). */
  onRefreshGen: (rel: string) => void;
  /** Right-click a take → copy it into the production as a new reference. */
  onSaveAsRef: (rel: string) => void;
  /** Right-click a take → seed it as the Image Suite's edit source. */
  onEditInSuite: (rel: string) => void;
  /** The model's full option schema (Advanced panel). */
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  /** Persists a per-shot advanced-params change onto the shot. */
  onSaveFields: (patch: Partial<ProductionShot>) => void;
  /** Open a generation in the lightbox (same zoom as reference nodes). */
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string, nav?: ZoomNav) => void;
}
type ImageGenFlowNode = Node<ImageGenData, "imagegen">;

interface VideoGenData extends Record<string, unknown> {
  /** Stable id of the owning `GraphVideoNode` ("vid0", …). */
  nodeId: string;
  /** Human ordinal shown in the title ("#1"); empty for the first node. */
  label: string;
  /** Optional title override (a shot sequence's generator reads "Sequence"). */
  title?: string;
  /** Whether the active vendor supports the Seedance draft → 1080p finalize.
   *  Only the Higgsfield CLI does; the node also needs the Seedance 2.5 model. */
  draftUpgradeAvailable?: boolean;
  /** A sequence's timeline total in seconds: seeds (and re-seeds) the clip
   *  length selection so the chosen length can cover every shot. */
  sequenceTotal?: number;
  models: OpenArtModelChoice[];
  /** This node's saved video-gen picks (win over the global media-default,
   *  which only seeds nodes that never picked). */
  savedModel?: string;
  savedResolution?: string;
  savedDurationSec?: number;
  /** This node's saved advanced/variant params (schema-driven). */
  savedParams?: GenParams;
  /** This node's saved "Downsample reference video to 720p" tick. */
  savedDownsampleVideoRefs?: boolean;
  /** Offer the 720p-downsample checkbox (false on the sequence canvas,
   *  whose submits ride separate handlers). */
  showDownsampleVideoRefs?: boolean;
  /** Stored clips (newest first). `draftJobId` marks a Seedance 2.5 480p draft
   *  that can be finalized at 1080p. */
  items: { url: string; prompt: string; path: string; draftJobId?: string; select?: boolean }[];
  /** Tag/untag a take as an assembly select. */
  onToggleSelect?: (rel: string, selected: boolean) => void;
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
  /** Finalize a Seedance 2.5 draft take (480p) at 1080p. */
  onUpgradeDraft: (nodeId: string, rel: string) => Promise<void>;
  /** Right-click a take → delete it (blocked while it feeds a pipe/output). */
  onDeleteGen: (rel: string) => void;
  /** Right-click a take -> re-fetch it from disk (external-edit fallback). */
  onRefreshGen: (rel: string) => void;
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
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string, nav?: ZoomNav) => void;
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
  /** The owning node's mode (absent/"edit" = Edit video; the two Genjutsu
   *  modes variant-title the view and lock its model pool). */
  mode?: GraphVideoNodeMode;
  /** Image references currently feeding this node (Genjutsu needs >= 1). */
  imageRefCount?: number;
  /** Stable id of the owning `GraphVideoNode` ("ev0", …). */
  nodeId: string;
  /** Human ordinal shown in the title ("#1"); empty for the first node. */
  label: string;
  models: OpenArtModelChoice[];
  savedModel?: string;
  savedParams?: GenParams;
  savedPrompt?: string;
  /** This node's saved resolution pick ("" / absent = Auto: the model's default). */
  savedResolution?: string;
  /** This node's saved clip-length pick in seconds (0 / absent = Auto: keep the source timing). */
  savedDurationSec?: number;
  /** This node's saved "Downsample reference video to 720p" tick (never
   *  offered on Genjutsu variants). */
  savedDownsampleVideoRefs?: boolean;
  /** Offer the 720p-downsample checkbox (false on the sequence canvas,
   *  whose submits ride separate handlers). */
  showDownsampleVideoRefs?: boolean;
  /** Label of the clip wired into the source socket (null = not wired;
   *  generation then falls back to the shot's own video). */
  sourceLabel: string | null;
  items: { url: string; prompt: string; path: string; select?: boolean }[];
  onToggleSelect?: (rel: string, selected: boolean) => void;
  selected: number;
  busy: boolean;
  piped: boolean;
  /** A video-edit job outlived its wait — show a pending badge + Fetch. */
  pending: boolean;
  onFetch: () => Promise<void>;
  onGenerate: (nodeId: string, model: string, resolution: string, durationSec: number, prompt: string, params: GenParams) => Promise<void>;
  onSelect: (nodeId: string, index: number) => void;
  onCycle: (nodeId: string, dir: 1 | -1) => void;
  /** Right-click a take → delete it (blocked while it feeds a pipe/output). */
  onDeleteGen: (rel: string) => void;
  /** Right-click a take -> re-fetch it from disk (external-edit fallback). */
  onRefreshGen: (rel: string) => void;
  /** Right-click a take → copy it into the production as a new reference. */
  onSaveAsRef: (rel: string) => void;
  /** Right-click a take → seed it as the Image Suite's edit source. */
  onEditInSuite: (rel: string) => void;
  onSave: (nodeId: string, patch: Partial<GraphVideoNode>) => void;
  onPipeToOutput: (nodeId: string) => void;
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  /** Per-model resolution / clip-length ladders (same probe the video node uses). */
  onModelOptions: (model: string, withImage: boolean) => Promise<VideoModelOptions | null>;
  /** Open a generation in the lightbox (same zoom as reference nodes). */
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string, nav?: ZoomNav) => void;
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
    /** Generation-queue key for this node's "Generating (N queued)" button. */
    genKey: string;
  onGenerate: (nodeId: string, model: string, resolution: string, params?: GenParams) => Promise<void>;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
  /** Right-click a take → delete it (blocked while it feeds a pipe/output). */
  onDeleteGen: (rel: string) => void;
  /** Right-click a take -> re-fetch it from disk (external-edit fallback). */
  onRefreshGen: (rel: string) => void;
  /** Right-click a take → copy it into the production as a new reference. */
  onSaveAsRef: (rel: string) => void;
  /** Right-click a take → seed it as the Image Suite's edit source. */
  onEditInSuite: (rel: string) => void;
  /** Persists a per-node model/resolution change onto this edit node. */
  onSave: (patch: Partial<GraphEditNode>) => void;
  /** The model's full option schema (Advanced panel). */
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  /** Open a generation in the lightbox (same zoom as reference nodes). */
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string, nav?: ZoomNav) => void;
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

/** One timeline row on a sequence prompt node (an interactive member segment). */
export interface SequenceSegmentView {
  shotId: string;
  /** Seconds this shot plays (editable). */
  durationSec: number;
  /** The user's override (empty = follow the frame prompt). */
  prompt: string;
  /** The member's display label (its reference name, "Shot NNNN"). */
  label: string;
  /** The member frame's artwork (cascade-media URL). */
  artwork: string;
  /** The frame's effective prompt (Magic when on, else storyboard), fetched
   *  by the host; shown when there is no override and restored by Revert. */
  framePrompt: string;
}

/** Sequence prompt node: Style + a "Visuals" body (the node's own text with
 *  reference sockets) + one interactive row per member shot (frame thumb, a
 *  seconds-range dial whose end is editable, the per-shot prompt, and Revert).
 *  The visuals text lives on the video node's `prompt`; the timeline lives on
 *  `ProductionShot.graphSequence`. */
interface SequencePromptData extends Record<string, unknown> {
  nodeId: string;
  value: string;
  refHandles: string[];
  openHandleId: string;
  includeBrand: boolean;
  segments: SequenceSegmentView[];
  /** One locked member-frame input socket per segment (`in-frame-<i>`), shown
   *  on the node's left edge beside the Style/Reference sockets. */
  frames: { id: string; label: string }[];
  onChange: (nodeId: string, text: string) => void;
  onSegmentPrompt: (shotId: string, text: string) => void;
  onSegmentDuration: (shotId: string, durationSec: number) => void;
  /** Clear the segment's override so it follows the frame prompt again. */
  onRevert: (shotId: string) => void;
  registerApplier: (applier: PromptDraftApplier | undefined) => void;
}
type SequencePromptFlowNode = Node<SequencePromptData, "sequenceprompt">;

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
  /** The owning node's mode (variant title/placeholder for Genjutsu). */
  mode?: GraphVideoNodeMode;
  /** Stable id of the owning `GraphVideoNode`. */
  nodeId: string;
  /** The edit instructions for one edit-video node (`GraphVideoNode.prompt`). */
  value: string;
  refHandles: string[];
  openHandleId: string;
  includeBrand: boolean;
  onChange: (nodeId: string, text: string) => void;
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
  /** Generation-queue key for this node's "Generating (N queued)" button. */
  genKey: string;
  /** A generation is running for this node in another window (ledger busy). */
  busy?: boolean;
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string, nav?: ZoomNav) => void;
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
  /** Generation-queue key for this node's "Generating (N queued)" button. */
  genKey: string;
  /** A generation is running for this node in another window (ledger busy). */
  busy?: boolean;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
  onDeleteGen: (rel: string) => void;
  /** Right-click a take -> re-fetch it from disk (external-edit fallback). */
  onRefreshGen: (rel: string) => void;
  onSaveAsRef: (rel: string) => void;
  onEditInSuite: (rel: string) => void;
  onSave: (patch: Partial<UpscaleData>) => void;
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string, nav?: ZoomNav) => void;
}
type UpscaleFlowNode = Node<UpscaleNodeData, "upscale">;

type GraphNode = RefFlowNode | ComposerFlowNode | StyleFlowNode | BrandFlowNode | OutputFlowNode | ImageGenFlowNode | VideoGenFlowNode | TweenFlowNode | EditVideoFlowNode | EditGenFlowNode | VideoPromptFlowNode | SequencePromptFlowNode | EditPromptFlowNode | EditVideoPromptFlowNode | CameraGridFlowNode | UpscaleFlowNode;

/** True while focus is inside an editable (a prompt box, a chip within one, or
 *  any input/textarea/select) — Escape must not close the canvas out from
 *  under the user while typing. Mirrors the workspace's `isPromptTextarea`
 *  guard (kept local: this file must not import the workspace). */
function isEditingTarget(el: unknown): boolean {
  const node = el as HTMLElement | null;
  if (!node || typeof node.tagName !== "string") return false;
  const tag = node.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return typeof node.closest === "function"
    && !!node.closest(".prompt-content-editor, .prod-ref-prompt-editor, .prod-graph-composer");
}

/* ------------------------------------------------------------------ */
/* Custom node views                                                   */
/* ------------------------------------------------------------------ */

/** Shared contract for the node-graph prompt editors (the composer and every
 *  prompt node). The local-draft plumbing below is identical for all of them. */
interface PromptNodeData {
  value: string;
  refHandles: string[];
  openHandleId: string;
  includeBrand: boolean;
  magicActive?: boolean;
  onChange: (text: string) => void;
  registerApplier: (applier: PromptDraftApplier | undefined) => void;
}

/** Shared local-draft state for a node-graph prompt editor. Keeping the prompt
 *  as a local draft while the node holds focus avoids re-rendering the whole
 *  workspace (and remounting the node) on every keystroke — which dropped the
 *  caret/focus. `emitted` suppresses the parent's echo; external changes to the
 *  UNFOCUSED boxes still fold in; the draft flushes on blur / unmount. When
 *  `publishEveryEdit` is false (every node today), only reference-tag
 *  edits (add, remove, reorder) publish live — plain prose commits when
 *  the user clicks off. */
function usePromptNodeDraft(data: PromptNodeData, publishEveryEdit: boolean) {
  const [localValue, setLocalValue] = useState(data.value);
  const emitted = useRef<Set<string>>(new Set([data.value]));
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<PromptContentHandle | null>(null);
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
    setTimeout(() => { if (!rootRef.current?.contains(document.activeElement)) syncToParent(); }, 0);
  };
  // Magic toggle switches the whole content (original <-> magic). A focused
  // composer would otherwise keep its local content draft and silently undo
  // the toggle on blur — force a full resync so both views mirror each other.
  // (Only the composer passes magicActive.)
  useEffect(() => {
    if (data.magicActive === undefined) return;
    if (prevMagicRef.current !== data.magicActive) {
      prevMagicRef.current = data.magicActive;
      emitted.current.clear();
      emitted.current.add(data.value);
      setLocalValue(data.value);
      draftRef.current = data.value;
    }
  }, [data.magicActive, data.value]);
  // External value changes merge into the UNFOCUSED boxes while the node holds
  // focus (changing the style dropdown must update Style without resetting the
  // Content caret, and vice-versa). The focused box stays authoritative.
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
          next = composePromptBoxes({ ...current, style: incoming.style, brand: incoming.brand });
        }
      } else if (activeIsStyle) {
        if (incoming.content !== current.content || incoming.brand !== current.brand) {
          next = composePromptBoxes({ ...current, content: incoming.content, brand: incoming.brand });
        }
      } else if (activeIsBrand) {
        if (incoming.content !== current.content || incoming.style !== current.style) {
          next = composePromptBoxes({ ...current, style: incoming.style, content: incoming.content });
        }
      } else {
        // Focus is inside the node but not in a specific box (e.g. header):
        // keep the local draft authoritative.
        return;
      }
      if (next !== null) {
        emitted.current.add(next);
        if (emitted.current.size > 100) emitted.current.clear();
        setLocalValue(next);
        draftRef.current = next;
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
        const before = draftRef.current;
        const next = fn(before);
        if (next === before) return;
        draftRef.current = next;
        setLocalValue(next);
        const s = emitted.current;
        if (s.size > 100) s.clear();
        s.add(next);
        dataRef.current.onChange(next);
        // A reference socket connect/disconnect is a TAG-only edit. When it
        // ADDS a tag, land the caret right after the new block and focus the
        // box so the user can keep typing immediately.
        const priorNames = new Set(refTagNames(before).map((n) => n.toLowerCase()));
        const added = refTagNames(next).find((n) => !priorNames.has(n.toLowerCase()));
        if (added) contentRef.current?.focusAfterTag(added);
      },
    });
    return () => register?.(undefined);
  }, []);
  const commit = (v: string) => {
    const prev = draftRef.current;
    setLocalValue(v);
    draftRef.current = v;
    const s = emitted.current;
    if (s.size > 100) s.clear();
    s.add(v);
    if (publishEveryEdit) { dataRef.current.onChange(v); return; }
    try {
      const pc = parsePromptBoxes(prev).content;
      const nc = parsePromptBoxes(v).content;
      // Tag edits publish live so the wires follow the tags immediately
      // (typed @[name] wires in, deleted tag unwires, chip drag
      // reorders) instead of disagreeing until blur.
      if (refTagSequenceChanged(pc, nc)) dataRef.current.onChange(v);
    } catch { /* ignore */ }
  };
  return { localValue, rootRef, contentRef, handleBlur, commit };
}

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
  // The prompt is a local draft while this node holds focus (see
  // usePromptNodeDraft). The composer also commits on blur/close instead of
  // publishing every keystroke: a per-keystroke publish fired a save, a
  // `getBoardPrompt` refetch, and a whole-workspace re-render on every
  // character — which is what made the caret jump to the end while typing. The
  // side panel catches up the moment the user clicks off the node.
  const { localValue, rootRef, contentRef, handleBlur, commit } = usePromptNodeDraft(data, false);
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
        contentRef={contentRef}
        value={localValue}
        includeBrand={data.includeBrand}
        styleReadOnly
        brandReadOnly
        placeholder="Describe the frame — connect references, type @, or edit the boxes"
        onBlur={handleBlur}
        onChange={commit}
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

const OutputNodeView = memo(function OutputNodeView({ id, data, selected }: NodeProps<OutputFlowNode>) {
  // Fixed tile tier (graph/lod.tsx); the lightbox keeps data.previewUrl full-res.
  const previewSrc = refThumbUrl(data.previewUrl ?? "", GRAPH_TILE_EDGE);
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={240} minHeight={200} lineClassName="prod-graph-resize-line" handleClassName="prod-graph-resize-handle" />
      <div className="prod-graph-node prod-graph-output">
        <Handle id="in-out" type="target" position={Position.Left} title="Primary output — pipe a generation or reference in" />
        <div className="prod-graph-node-title">Frame output</div>
        {data.previewKind === "video" && data.previewUrl
          ? <VideoPreview instanceId={`out:${id}`} className="prod-graph-output-img nodrag" url={data.previewUrl} controls posterEdge={GRAPH_TILE_EDGE} />
          : data.previewUrl
            ? <img className="prod-graph-output-img" src={previewSrc} alt={`Shot ${data.shotNumber}`} draggable={false} loading="lazy" decoding="async" />
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
    // This shot's own pick wins; else the production master (when it names a
    // real model); else the remembered last choice. "auto"/a stale id falls
    // through — effModel below always lands on a listed model.
    const own = data.savedModel && (data.models.length === 0 || data.models.some((m) => m.id === data.savedModel)) ? data.savedModel : null;
    const master = data.defaultModel && data.defaultModel !== "auto" && (data.models.length === 0 || data.models.some((m) => m.id === data.defaultModel))
      ? data.defaultModel
      : null;
    return own ?? master ?? getMediaDefault("image")?.model ?? data.defaultModel;
  });
  const [resolution, setResolution] = useState(() => data.savedResolution ?? data.defaultResolution);
  const [params, setParams] = useState<GenParams>(data.savedParams ?? {});
  const [schema, setSchema] = useState<CliModelSchema | null>(null);
  const gen = useGenStatus(data.genKey);
  const busy = data.busy === true || gen.running;
  const genMenu = useGenerationMenu();
  // Fixed preview tier (graph/lod.tsx); zoom/menu keep the full-res url.
  const previewSrc = refThumbUrl(data.items[data.selected]?.url ?? "", GRAPH_PREVIEW_EDGE);
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
  const effResolution = closestResolution(resolution, imageResOptions(schema));
  const run = async () => {
    await data.onGenerate(effModel, effResolution, params);
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
        <select className="prod-openart-select nodrag" value={effModel} onChange={(e) => { setModel(e.target.value); data.onSaveFields({ graphImageModel: e.target.value }); rememberMediaDefault("image", { model: e.target.value }); }} title="Image model">
          {data.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>)}
        </select>
      </div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={effResolution} onChange={(e) => { setResolution(e.target.value); data.onSaveFields({ graphImageResolution: e.target.value }); rememberMediaDefault("image", { resolution: e.target.value }); }} title="Resolution">
          {imageResOptions(schema).map((r) => <option key={r} value={r}>{r}</option>)}
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
            <img className="prod-graph-gen-preview" src={previewSrc} alt="Generated frame" draggable={false} loading="lazy" decoding="async" />
            <button
              className="prod-graph-ref-zoom prod-graph-gen-zoom nodrag"
              title="View larger"
              onClick={() => data.onZoom("Image generation", data.items[data.selected].url, "image", data.items[data.selected].path, { items: data.items, index: data.selected })}
            >
              <MagnifyIcon size={9} />
            </button>
          </div>
        : <div className="prod-graph-gen-preview blank">No generations yet</div>}
      <GenHistoryStrip
        items={data.items}
        selected={data.selected}
        media="image"
        onSelect={data.onSelect}
        onContextMenu={(e, it) => genMenu.open(e, it.path, { src: it.url, media: "image" })}
        history={{ kind: "image", title: "Image generation" }}
      />
      {data.items.length > 1 && (
        <div className="prod-graph-gen-cycle">
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(1)} title="Older generation">‹</button>
          <span>{data.selected + 1} / {data.items.length}</span>
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(-1)} title="Newer generation">›</button>
        </div>
      )}
      <button
        className="prod-btn primary prod-graph-gen-go nodrag"
        title={busy ? "Generating… click to queue another" : "Generate this frame"}
        onClick={() => { void run(); }}
      >
        {busy ? genButtonLabel({ running: true, pending: gen.pending }, "Generate") : <>Generate<GenerationCostSuffix req={imageCostReq} /></>}
      </button>
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} onDelete={data.onDeleteGen} onRefresh={data.onRefreshGen} onEditInSuite={data.onEditInSuite} />
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
  const [durationSec, setDurationSec] = useState(data.sequenceTotal ?? data.savedDurationSec ?? remembered?.durationSec ?? 5);
  const [params, setParams] = useState<GenParams>(data.savedParams ?? {});
  const [downsampleVideoRefs, setDownsampleVideoRefs] = useState(data.savedDownsampleVideoRefs ?? false);
  const busy = data.busy === true;
  const [fetching, setFetching] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
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
  // A separate cheap "draft" MODEL (e.g. OpenArt's "Seedance 2.5 Draft") only
  // outputs 480p — it is not the Higgfield upgradeable Seedance 2.5, so its
  // resolution ladder collapses to 480p.
  const draftModel = isDraftOnlyModel({ id: model, displayName: data.models.find((m) => m.id === model)?.displayName });
  const baseResolutions = draftModel ? [DRAFT_RESOLUTION] : (opts?.resolutions?.length ? opts.resolutions : ["480p", "720p", "1080p"]);
  // Narrow by the model's own CEL rules given the current params (e.g. Seedance
  // mode "fast" only allows 480p/720p).
  const resolutions = useMemo(() => {
    const rules = ((schema?.raw as { rules?: { cel?: unknown }[] } | null)?.rules ?? [])
      .filter((r): r is { cel: string } => typeof r?.cel === "string");
    if (!rules.length) return baseResolutions;
    const modeDef = schema?.fields.find((f) => f.name === "mode")?.default;
    return resolutionsAllowedByRules(rules, { mode: modeDef, ...params }, baseResolutions);
  }, [schema, params, baseResolutions.join("|")]);
  useEffect(() => {
    if (resolutions.length && !resolutions.includes(resolution)) setResolution(closestResolution(resolution, resolutions));
  }, [resolutions.join("|")]);
  useEffect(() => {
    if (!opts) return;
    if (resolutions.length && !resolutions.includes(resolution)) setResolution(closestResolution(resolution, resolutions));
    const snapped = snapDurationSec(durationSec, opts);
    if (snapped !== durationSec) setDurationSec(snapped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts]);
  // A sequence's timeline total seeds the clip length (and re-seeds it when the
  // user edits the shot durations); snap to a model-supported length when the
  // exact total isn't offered.
  useEffect(() => {
    const total = data.sequenceTotal;
    if (!total || total <= 0) return;
    const list = opts?.durations?.length ? opts.durations : null;
    // Unknown model options: keep the total as-is. Known: snap to a supported
    // length (the smallest that covers the total, else the largest).
    setDurationSec(list ? (list.includes(total) ? total : (list.find((d) => d >= total) ?? list[list.length - 1] ?? total)) : clampDurationSec(total, opts));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.sequenceTotal, opts]);
  const effModel = data.models.some((m) => m.id === model) ? model : (data.models[0]?.id ?? "");
  // A cheap draft-only model (a separate 480p catalogue entry) pins 480p.
  // No draft toggle on this node: submissions are always full generations
  // (existing draft takes can still be finalized from their history entry).
  const effectiveResolution = draftModel ? DRAFT_RESOLUTION : resolution;
  // Strip any stale persisted draft flag (the toggle is gone) so it can
  // never reach a submission or a cost quote again.
  const cleanParams = (p: GenParams): GenParams => {
    if (!("draft" in p) && !("draft_job_id" in p) && !("draftJobId" in p)) return p;
    const next = { ...p };
    delete next.draft;
    delete next.draft_job_id;
    delete next.draftJobId;
    return next;
  };
  const saveParams = (next: ModelOptionValues) => {
    const p = cleanParams(next as GenParams);
    setParams(p);
    data.onSaveFields(data.nodeId, { params: p });
  };
  const run = async () => {
    await data.onGenerate(data.nodeId, effModel, effectiveResolution, durationSec, cleanParams(params));
  };
  const fetchPending = async () => {
    if (fetching) return;
    setFetching(true);
    try { await data.onFetch(); } finally { setFetching(false); }
  };
  const selectedItem = data.items[data.selected];
  const canUpgrade = !!selectedItem?.draftJobId;
  const upgradeDraft = async () => {
    if (!selectedItem?.draftJobId || upgrading) return;
    setUpgrading(true);
    try { await data.onUpgradeDraft(data.nodeId, selectedItem.path); } finally { setUpgrading(false); }
  };
  // Live per-config quote (Higgsfield CLI only) for the node's Generate button.
  const videoCostReq = isQuotableCostModel(effModel) ? {
    model: effModel, kind: "video" as const, resolution: effectiveResolution, durationSec,
    aspectRatio: costAspect(params), ...(Object.keys(cleanParams(params)).length ? { params: { ...cleanParams(params) } } : {}),
  } : null;
  return (
      <div className="prod-graph-node prod-graph-gen prod-graph-videogen">
      <Handle id="in-prompt" type="target" position={Position.Left} className="socket-ref" style={{ top: "33%" }} title="Prompt input — from the video-prompt node" />
      <span className="prod-graph-socket-label ref" style={{ top: "33%" }}>Prompt</span>
      <Handle id="in-image" type="target" position={Position.Left} className="socket-ref" style={{ top: "67%" }} title="Source image — pipe the frame in" />
      <span className="prod-graph-socket-label ref" style={{ top: "67%" }}>Source</span>
      <Handle type="source" position={Position.Right} title="Clip out — pipe into the output" />
      <div className="prod-graph-node-title">{data.title ?? "Video generation"}{data.label}</div>
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
        <select className="prod-openart-select nodrag" value={effectiveResolution} onChange={(e) => { setResolution(e.target.value); data.onSaveFields(data.nodeId, { resolution: e.target.value }); }} title={draftModel ? "This model outputs 480p only" : "Resolution"} disabled={draftModel}>
          {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <DurationField className="prod-openart-select nodrag" opts={opts} value={durationSec} title="Clip length" onChange={(n) => { setDurationSec(n); data.onSaveFields(data.nodeId, { durationSec: n }); }} />
      </div>
      {data.showDownsampleVideoRefs && (
        <label className="prod-graph-downsample nodrag" title="Shrink oversize (over 720p) reference videos to their 720p copies before uploading (created on first use)">
          <input type="checkbox" checked={downsampleVideoRefs} onChange={(e) => { setDownsampleVideoRefs(e.target.checked); data.onSaveFields(data.nodeId, { downsampleVideoRefs: e.target.checked }); }} /> Downsample reference video to 720p
        </label>
      )}
      <div className="nodrag">
        <ModelOptionsForm
          schema={schema}
          value={params}
          onChange={saveParams}
          exclude={["resolution", "duration", "length", "seconds", "draft", "draft_job_id"]}
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
            <VideoPreview instanceId={`vid:${id}`} className="prod-graph-gen-preview nodrag" url={data.items[data.selected].url} controls onExpand={() => data.onZoom("Video generation", data.items[data.selected].url, "video", data.items[data.selected].path)} />
            <button
              className="prod-graph-ref-zoom prod-graph-gen-zoom nodrag"
              title="View larger"
              onClick={() => data.onZoom("Video generation", data.items[data.selected].url, "video", data.items[data.selected].path)}
            >
              <MagnifyIcon size={9} />
            </button>
          </div>
        : <div className="prod-graph-gen-preview blank">{data.pending ? "pending…" : "No generations yet"}</div>}
      <GenHistoryStrip
        items={data.items}
        selected={data.selected}
        media="video"
        onSelect={(i) => data.onSelect(data.nodeId, i)}
        onContextMenu={(e, it) => genMenu.open(e, it.path, { src: it.url, media: "video" })}
        history={{ kind: "video", nodeId: data.nodeId, title: `Video generation${data.label}` }}
      />
      {data.items.length > 1 && (
        <div className="prod-graph-gen-cycle">
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(data.nodeId, 1)} title="Older clip">‹</button>
          <span>{data.selected + 1} / {data.items.length}</span>
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(data.nodeId, -1)} title="Newer clip">›</button>
        </div>
      )}
      {canUpgrade && (
        <button
          className="prod-btn prod-graph-gen-upgrade nodrag"
          disabled={upgrading || busy}
          onClick={() => { void upgradeDraft(); }}
          title="This take is a Seedance 2.5 480p draft — finalize it at 1080p (the vendor reuses the draft job; available within its upgrade window)."
        >
          {upgrading ? "Upgrading…" : "↑ Finalize 1080p"}
        </button>
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
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} selectTag={data.onToggleSelect ? { selected: !!data.items.find((x) => x.path === genMenu.menu?.rel)?.select, onToggle: data.onToggleSelect } : undefined} onDelete={data.onDeleteGen} onRefresh={data.onRefreshGen} onEditInSuite={data.onEditInSuite} />
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
  const [resolution, setResolution] = useState(data.savedResolution ?? "");
  const [durationSec, setDurationSec] = useState(data.savedDurationSec ?? 0);
  const [params, setParams] = useState<GenParams>(data.savedParams ?? {});
  const [downsampleVideoRefs, setDownsampleVideoRefs] = useState(data.savedDownsampleVideoRefs ?? false);
  const [schema, setSchema] = useState<CliModelSchema | null>(null);
  const [opts, setOpts] = useState<VideoModelOptions | null>(null);
  const busy = data.busy === true;
  const [fetching, setFetching] = useState(false);
  const prompt = data.savedPrompt ?? "";
  const variant = editFamilyVariant(data.mode);
  const genjutsu = variant.genjutsu !== null;
  const imageRefCount = data.imageRefCount ?? 0;
  // Genjutsu runs on references alone (prompt optional) but cannot run
  // without at least one image reference; Edit video needs instructions.
  const canRun = genjutsu ? imageRefCount >= 1 && data.models.length > 0 : !!prompt.trim();
  const genMenu = useGenerationMenu();
  const effModel = data.models.some((m) => m.id === model) ? model : (data.models[0]?.id ?? "");
  useEffect(() => {
    let live = true;
    setSchema(null);
    setOpts(null);
    if (!effModel) return () => { live = false; };
    void data.onModelOptions(effModel, true).then((o) => { if (live) setOpts(o); }).catch(() => {});
    void data.onModelSchema(effModel).then((s) => {
      if (!live) return;
      setSchema(s);
      setParams((prev) => seedModelOptionValues(s, effModel, "video:editnode", pruneModelOptionValues(s, prev)) as GenParams);
    }).catch(() => { if (live) setSchema(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effModel]);
  // The model's own resolution / length ladders, probed like the video node.
  // Both selects lead with Auto: no resolution pick submits the model's
  // default, and no length pick (0) keeps the source clip's timing — the
  // historical edit behaviour, now an explicit choice instead of the only one.
  const resolutions = resolutionsForSchema(schema, params, opts?.resolutions?.length ? opts.resolutions : ["480p", "720p", "1080p"]);
  const effResolution = resolutions.includes(resolution) ? resolution : "";
  const save = (patch: Partial<GraphVideoNode>) => data.onSave(data.nodeId, patch);
  const run = async () => {
    if (!genjutsu && !prompt.trim()) return;
    if (genjutsu && imageRefCount < 1) return;
    await data.onGenerate(data.nodeId, effModel, effResolution, genjutsu ? 0 : durationSec, prompt.trim(), params);
  };
  const fetchPending = async () => {
    if (fetching) return;
    setFetching(true);
    try { await data.onFetch(); } finally { setFetching(false); }
  };
  // Live per-config quote (Higgsfield CLI only) for the node's Edit button,
  // including the resolution/length picks when they are pinned.
  const editVideoCostReq = isQuotableCostModel(effModel) ? {
    model: effModel, kind: "video" as const,
    ...(effResolution ? { resolution: effResolution } : {}),
    ...(durationSec > 0 ? { durationSec } : {}),
    aspectRatio: costAspect(params), ...(Object.keys(params).length ? { params: { ...params } } : {}),
  } : null;
  return (
      <div className="prod-graph-node prod-graph-gen prod-graph-editvideo">
      <Handle id="in-prompt" type="target" position={Position.Left} className="socket-ref" style={{ top: "25%" }} title="Prompt input — from the edit-video prompt node" />
      <span className="prod-graph-socket-label ref" style={{ top: "25%" }}>Prompt</span>
      <Handle id="in-video" type="target" position={Position.Left} className="socket-ref" style={{ top: "72%" }} title="Source clip — wire a video node output or a video reference (mandatory)" />
      <span className="prod-graph-socket-label ref" style={{ top: "72%" }}>Source</span>
      <Handle type="source" position={Position.Right} title="Edited clip out — pipe into the output" />
      <div className="prod-graph-node-title">{variant.genjutsu === "genjutsu-motion" ? <GenjutsuMotionIcon size={13} className="prod-graph-title-icon" /> : variant.genjutsu === "genjutsu-swap" ? <GenjutsuSwapIcon size={13} className="prod-graph-title-icon" /> : <EditVideoIcon size={13} className="prod-graph-title-icon" />} {variant.title}{data.label}</div>
      <div className="prod-graph-gen-controls">
        <select
          className="prod-openart-select nodrag"
          value={data.models.some((m) => m.id === model) ? model : ""}
          onChange={(e) => { setModel(e.target.value); save({ model: e.target.value }); }}
          title={genjutsu ? "Genjutsu model (Lite is the cheaper, faster tier)" : "Video-edit model"}
          disabled={data.models.length === 0}
        >
          {data.models.length === 0 && <option value="">{genjutsu ? "No Genjutsu models" : "No edit-video models"}</option>}
          {data.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>)}
        </select>
      </div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={effResolution} onChange={(e) => { setResolution(e.target.value); save({ resolution: e.target.value }); }} title="Resolution (Auto = the model's default)">
          <option value="">Auto</option>
          {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {!genjutsu && <DurationField className="prod-openart-select nodrag" opts={opts} value={durationSec} auto title="Clip length (Auto = keep the source clip's timing)" onChange={(n) => { setDurationSec(n); save({ durationSec: n }); }} />}
      </div>
      {!genjutsu && data.showDownsampleVideoRefs && (
        <label className="prod-graph-downsample nodrag" title="Shrink oversize (over 720p) reference videos to their 720p copies before uploading (created on first use)">
          <input type="checkbox" checked={downsampleVideoRefs} onChange={(e) => { setDownsampleVideoRefs(e.target.checked); save({ downsampleVideoRefs: e.target.checked }); }} /> Downsample reference video to 720p
        </label>
      )}
      <span className="prod-graph-gen-hint">
        {data.sourceLabel ? `Source: ${data.sourceLabel}` : "Source: shot video (wire a clip to override)"}
      </span>
      {genjutsu && (
        <span className="prod-graph-gen-hint">
          {imageRefCount >= 1
            ? `References: ${imageRefCount} image${imageRefCount === 1 ? "" : "s"}`
            : "Add at least 1 image reference (wire or @-cite) — Genjutsu requires one"}
        </span>
      )}
      <div className="nodrag">
        <ModelOptionsForm
          schema={schema}
          value={params}
          onChange={(next) => { const p = next as GenParams; setParams(p); save({ params: p }); }}
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
            <VideoPreview instanceId={`ev:${id}`} className="prod-graph-gen-preview nodrag" url={data.items[data.selected].url} controls onExpand={() => data.onZoom(variant.title, data.items[data.selected].url, "video", data.items[data.selected].path)} />
            <button
              className="prod-graph-ref-zoom prod-graph-gen-zoom nodrag"
              title="View larger"
              onClick={() => data.onZoom(variant.title, data.items[data.selected].url, "video", data.items[data.selected].path)}
            >
              <MagnifyIcon size={9} />
            </button>
          </div>
        : <div className="prod-graph-gen-preview blank">{data.pending ? "pending…" : variant.emptyText}</div>}
      <GenHistoryStrip
        items={data.items}
        selected={data.selected}
        media="video"
        onSelect={(i) => data.onSelect(data.nodeId, i)}
        onContextMenu={(e, it) => genMenu.open(e, it.path, { src: it.url, media: "video" })}
        history={{ kind: "editvideo", nodeId: data.nodeId, title: `${variant.title}${data.label}` }}
      />
      {data.items.length > 1 && (
        <div className="prod-graph-gen-cycle">
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(data.nodeId, 1)} title="Older edit">‹</button>
          <span>{data.selected + 1} / {data.items.length}</span>
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(data.nodeId, -1)} title="Newer edit">›</button>
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
        <button className="prod-btn primary prod-graph-gen-go nodrag" disabled={busy || !canRun} title={genjutsu && imageRefCount < 1 ? "Wire or @-cite at least one image reference first" : undefined} onClick={() => { void run(); }}>
          {busy ? variant.busyLabel : <>{variant.goLabel}<GenerationCostSuffix req={editVideoCostReq} /></>}
        </button>
        {!genjutsu && data.items[data.selected] && (
          <button className="prod-btn nodrag" disabled={data.piped} onClick={() => data.onPipeToOutput(data.nodeId)} title="Feed the edited clip into the frame output">
            {data.piped ? "Piped" : "Pipe to output"}
          </button>
        )}
      </div>
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} selectTag={data.onToggleSelect ? { selected: !!data.items.find((x) => x.path === genMenu.menu?.rel)?.select, onToggle: data.onToggleSelect } : undefined} onDelete={data.onDeleteGen} onRefresh={data.onRefreshGen} onEditInSuite={data.onEditInSuite} />
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
  const gen = useGenStatus(data.genKey);
  const busy = data.busy === true || gen.running;
  const genMenu = useGenerationMenu();
  // Fixed preview tier (graph/lod.tsx); zoom/menu keep the full-res url.
  const previewSrc = refThumbUrl(data.items[data.selected]?.url ?? "", GRAPH_PREVIEW_EDGE);
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
          {imageResOptions(schema).map((r) => <option key={r} value={r}>{r}</option>)}
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
            <img className="prod-graph-gen-preview" src={previewSrc} alt="Edited frame" draggable={false} loading="lazy" decoding="async" />
            <button
              className="prod-graph-ref-zoom prod-graph-gen-zoom nodrag"
              title="View larger"
              onClick={() => data.onZoom(`Edit image ${editNodeLabel(data.nodeId)}`, data.items[data.selected].url, "image", data.items[data.selected].path, { items: data.items, index: data.selected })}
            >
              <MagnifyIcon size={9} />
            </button>
          </div>
        : <div className="prod-graph-gen-preview blank">No edits yet</div>}
      <GenHistoryStrip
        items={data.items}
        selected={data.selected}
        media="image"
        onSelect={data.onSelect}
        onContextMenu={(e, it) => genMenu.open(e, it.path, { src: it.url, media: "image" })}
        history={{ kind: "edit", nodeId: data.nodeId, title: "Edit" }}
      />
      {data.items.length > 1 && (
        <div className="prod-graph-gen-cycle">
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(1)} title="Older edit">‹</button>
          <span>{data.selected + 1} / {data.items.length}</span>
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(-1)} title="Newer edit">›</button>
        </div>
      )}
      <button
        className="prod-btn primary prod-graph-gen-go nodrag"
        title={busy ? "Generating… click to queue another" : "Run this edit"}
        onClick={() => { void run(); }}
      >
        {busy ? genButtonLabel({ running: true, pending: gen.pending }, "Generate") : <>Generate<GenerationCostSuffix req={editCostReq} /></>}
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
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} onDelete={data.onDeleteGen} onRefresh={data.onRefreshGen} onEditInSuite={data.onEditInSuite} />
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
type PromptBodyData = PromptNodeData;

const PromptNodeView = memo(function PromptNodeView({ id, data, title, placeholder, containerClass, contentLabel, afterContent, sockets: socketsProp }: { id: string; data: PromptBodyData; title: string; placeholder: string; containerClass: string; contentLabel?: string; afterContent?: ReactNode; sockets?: PromptSocket[] }) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, data.refHandles.length, updateNodeInternals]);
  // Plain prose stays local until blur; only tag reorders publish live (see
  // usePromptNodeDraft).
  const { localValue, rootRef, contentRef, handleBlur, commit } = usePromptNodeDraft(data, false);
  const sockets = socketsProp ?? promptSockets(data.refHandles, data.openHandleId);
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
        contentRef={contentRef}
        value={localValue}
        includeBrand={data.includeBrand}
        styleReadOnly
        brandReadOnly
        contentLabel={contentLabel}
        placeholder={placeholder}
        afterContent={afterContent}
        onBlur={handleBlur}
        onChange={commit}
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

/** The per-shot prompt box under a sequence segment. An empty override is
 *  meaningful ("use the frame prompt"), so the box commits each change and
 *  keeps a local draft while focused — that way the frame prompt arriving
 *  asynchronously can't yank the caret, and the box can be emptied mid-edit
 *  before it snaps back to the frame prompt on blur. */
export const SegmentPromptBox = memo(function SegmentPromptBox({ shotId, value, fallback, onChange }: { shotId: string; value: string; fallback: string; onChange: (shotId: string, text: string) => void }) {
  const external = value || fallback;
  const [draft, setDraft] = useState(external);
  const emitted = useRef<Set<string>>(new Set([external]));
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    if (emitted.current.has(external)) return;
    emitted.current.clear();
    emitted.current.add(external);
    setDraft(external);
  }, [external]);
  return (
    <textarea
      className="prod-graph-seq-seg-prompt nodrag"
      rows={2}
      value={draft}
      placeholder="Frame prompt — edit here, or Revert to the storyboard prompt"
      onFocus={() => { focused.current = true; }}
      onBlur={() => {
        focused.current = false;
        if (draft === external) return;
        if (draft === "") {
          // Empty override means "use the frame prompt": show the fallback
          // text. The per-keystroke onChange("") already cleared the stored
          // override; teaching `emitted` the fallback keeps that echo from
          // rebuilding the box under the next focus.
          const s = emitted.current;
          if (s.size > 100) s.clear();
          s.add(fallback);
          setDraft(fallback);
          return;
        }
        // Commit (never revert): the parent echo can lag behind blur across an
        // async save/rebase, and reverting to the stale `external` here — then
        // early-returning on the real echo because `emitted` holds it — would
        // discard the edit permanently.
        onChange(shotId, draft);
      }}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        const s = emitted.current;
        if (s.size > 100) s.clear();
        s.add(v);
        onChange(shotId, v);
      }}
    />
  );
});

/** The interactive timeline rows under a sequence prompt node's Visuals body:
 *  one row per member shot — a seconds-range dial (the end is editable; the
 *  next shot starts where it ends), the per-shot prompt (seeded from the frame
 *  prompt), and a Revert back to it. The member frame is piped into the node's
 *  left-edge `in-frame-<i>` socket (see the socket list), not into the row. */
const SequenceSegmentList = memo(function SequenceSegmentList({ data }: { data: SequencePromptData }) {
  const total = data.segments.reduce((n, s) => n + (Number.isFinite(s.durationSec) ? Math.max(0, Math.round(s.durationSec)) : 0), 0);
  return (
    <div className="prod-graph-seq-segs">
      {data.segments.map((seg, i) => (
        <div className="prod-graph-seq-seg" key={seg.shotId || i}>
          <div className="prod-graph-seq-seg-head">
            {seg.artwork
              ? <img className="prod-graph-seq-seg-thumb" src={refThumbUrl(seg.artwork)} alt="" draggable={false} loading="lazy" decoding="async" />
              : <span className="prod-graph-seq-seg-thumb blank" />}
            <span className="prod-graph-seq-seg-name">{seg.label}</span>
            <div className="prod-graph-seq-seg-range nodrag" title="How many seconds this shot plays">
              <input
                type="number"
                min={1}
                step={1}
                value={seg.durationSec}
                onChange={(e) => data.onSegmentDuration(seg.shotId, Number(e.target.value))}
                onFocus={(e) => e.currentTarget.select()}
              />
              <span className="prod-graph-seq-seg-unit">Seconds</span>
            </div>
          </div>
          <SegmentPromptBox
            shotId={seg.shotId}
            value={seg.prompt}
            fallback={seg.framePrompt}
            onChange={data.onSegmentPrompt}
          />
          {seg.prompt
            ? <button className="prod-graph-seq-seg-revert nodrag" onClick={() => data.onRevert(seg.shotId)} title="Revert to the frame's storyboard prompt">Revert</button>
            : <span className="prod-graph-seq-seg-auto">frame prompt</span>}
        </div>
      ))}
      <div className="prod-graph-seq-total">Sequence Total: {total} Seconds</div>
    </div>
  );
});

/** Sequence prompt node (a shot sequence's canvas only): the video node's prompt
 *  node rendered as the timed multi-shot composer — Style, a "Visuals" body with
 *  reference sockets, and one timeline row per member shot. */
const SequencePromptNodeView = memo((props: NodeProps<SequencePromptFlowNode>) => {
  const { id, data } = props;
  const adapted: PromptBodyData = {
    value: data.value,
    refHandles: data.refHandles,
    openHandleId: data.openHandleId,
    includeBrand: false,
    registerApplier: data.registerApplier,
    onChange: (text: string) => data.onChange(data.nodeId, text),
  };
  // Left-edge sockets: Style, each connected reference, the open reference
  // socket, then one locked member-frame socket per segment (`in-frame-<i>`).
  // No brand socket.
  const entries: { id: string; kind: "style" | "ref"; open: boolean; label: string }[] = [
    { id: "in-style", kind: "style", open: false, label: "Style" },
    ...data.refHandles.map((h) => ({ id: h, kind: "ref" as const, open: false, label: "Reference" })),
    { id: data.openHandleId, kind: "ref" as const, open: true, label: "Reference" },
    ...data.frames.map((f) => ({ id: f.id, kind: "ref" as const, open: false, label: f.label })),
  ];
  const total = entries.length;
  const sockets: PromptSocket[] = entries.map((e, i) => ({ ...e, top: ((i + 1) / (total + 1)) * 100 }));
  return (
    <PromptNodeView
      id={id}
      data={adapted}
      title="Sequence prompt"
      placeholder="Visuals — attach references and describe the look across the whole sequence"
      containerClass="prod-graph-videoprompt prod-graph-sequenceprompt"
      contentLabel="Visuals"
      afterContent={<SequenceSegmentList data={data} />}
      sockets={sockets}
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

/** Edit-video prompt node: the edit instructions for one edit-video node. */
const EditVideoPromptNodeView = memo((props: NodeProps<EditVideoPromptFlowNode>) => {
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
      title={`${editFamilyVariant(data.mode).promptTitle}${editVideoNodeLabel(data.nodeId)}`}
      placeholder={editFamilyVariant(data.mode).placeholder}
      containerClass="prod-graph-editvideoprompt"
    />
  );
});

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
  // Fixed tile tier for the node thumbnail (the panel editor stays full-res).
  const sheetSrc = refThumbUrl(data.sheetUrl ?? "", GRAPH_TILE_EDGE);
  const gen = useGenStatus(data.genKey);
  const busy = gen.running || data.busy === true;
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
  // Style + source + reference sockets, evenly spaced down the left edge; the
  // grid-image socket is pinned to the bottom and carries its own (orange) hue.
  const refHandles = data.refIds.map((_, i) => `in-ref-${i}`);
  const total = refHandles.length + 4;
  const topAt = (i: number) => ((i + 1) / (total + 1)) * 100;
  const sockets: { id: string; kind: "ref" | "style" | "grid"; label: string; open?: boolean; top: number }[] = [
    { id: "in-style", kind: "style", label: "Style", top: topAt(0) },
    { id: "in-image", kind: "ref", label: "Source", top: topAt(1) },
    ...refHandles.map((h, i) => ({ id: h, kind: "ref" as const, label: `Ref ${i + 1}`, top: topAt(i + 2) })),
    { id: "in-ref-open", kind: "ref", label: "Refs", open: true, top: topAt(refHandles.length + 2) },
    { id: "in-grid", kind: "grid", label: "Grid image", top: topAt(refHandles.length + 3) },
  ];
  const effResolution = closestResolution(resolution, imageResOptions(schema));
  const generate = () => {
    const resolution = effResolution;
    const opts: CameraGridGenOptions = { model: effModel, resolution, cols: data.cols, rows: data.rows, ...(Object.keys(params).length ? { params } : {}) };
    // Persist the live picks, then generate with them.
    data.onSave({ model: effModel, resolution, cols: data.cols, rows: data.rows, ...(Object.keys(params).length ? { params } : {}) });
    setErr(null);
    void data.onGenerate(opts);
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
            className={`socket-${s.kind}` + (s.open ? " open" : "")}
            style={{ top: `${s.top}%` }}
            title={
              s.id === "in-style" ? "Style input — prepends the shot's style to the prompt"
              : s.id === "in-image" ? "Source image — pipe a frame or reference in"
              : s.id === "in-grid" ? "Grid image — pipe in an already-made grid to cut panels out of (manual fallback)"
              : s.open ? "Reference input — always open, drop a connection here"
              : `${s.label} input`
            }
          />
          <span className={`prod-graph-socket-label ${s.kind}`} style={{ top: `${s.top}%` }}>{s.label}</span>
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
        <select className="prod-openart-select nodrag" value={effResolution} onChange={(e) => { setResolution(e.target.value); data.onSave({ resolution: e.target.value }); rememberMediaDefault("image", { resolution: e.target.value }); }} title="Resolution">
          {imageResOptions(schema).map((r) => <option key={r} value={r}>{r}</option>)}
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
        <button
          className="prod-btn primary"
          disabled={!effModel}
          onClick={generate}
          title={busy ? "Generating… click to queue another" : `Generate or regenerate the ${data.cols}×${data.rows} sheet`}
        >
          {busy ? genButtonLabel({ running: true, pending: gen.pending }, "Generate") : <>{data.sheetUrl ? "Regenerate" : "Generate"}<GenerationCostSuffix req={costReq} /></>}
        </button>
      </div>
      {data.sheetUrl ? (
        <button
          className="prod-graph-camera-thumb nodrag"
          type="button"
          onClick={data.onOpenEditor}
          title="Open the full-res panel editor to select and export panels"
        >
          <img src={sheetSrc} alt="Camera grid sheet" draggable={false} loading="lazy" decoding="async" />
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
  const gen = useGenStatus(data.genKey);
  const busy = gen.running || data.busy === true;
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
  // Fixed preview tier (graph/lod.tsx); zoom/menu keep the full-res url.
  const previewSrc = refThumbUrl(data.items[data.selected]?.url ?? "", GRAPH_PREVIEW_EDGE);
  const saveParams = (next: ModelOptionValues) => {
    const p = next as GenParams;
    setParams(p);
    data.onSave({ params: p });
  };
  const run = () => {
    setErr(null);
    void data.onGenerate(effModel, resolution, params);
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
          {imageResOptions(schema).map((r) => <option key={r} value={r}>{r}</option>)}
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
            <img className="prod-graph-gen-preview" src={previewSrc} alt="Upscaled frame" draggable={false} loading="lazy" decoding="async" />
            <button
              className="prod-graph-ref-zoom prod-graph-gen-zoom nodrag"
              title="View larger"
              onClick={() => data.onZoom("Upscale", data.items[data.selected].url, "image", data.items[data.selected].path)}
            >
              <MagnifyIcon size={9} />
            </button>
          </div>
        : <div className="prod-graph-gen-preview blank">No upscales yet</div>}
      <GenHistoryStrip
        items={data.items}
        selected={data.selected}
        media="image"
        onSelect={data.onSelect}
        onContextMenu={(e, it) => genMenu.open(e, it.path, { src: it.url, media: "image" })}
        history={{ kind: "upscale", title: "Upscale" }}
      />
      {data.items.length > 1 && (
        <div className="prod-graph-gen-cycle">
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(1)} title="Older upscale">‹</button>
          <span>{data.selected + 1} / {data.items.length}</span>
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(-1)} title="Newer upscale">›</button>
        </div>
      )}
      <button
        className="prod-btn primary prod-graph-gen-go nodrag"
        disabled={!effModel}
        title={busy ? "Upscaling… click to queue another" : "Upscale this image"}
        onClick={run}
      >
        {busy ? genButtonLabel({ running: true, pending: gen.pending }, "Upscale") : <>Upscale<GenerationCostSuffix req={costReq} /></>}
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
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} onDelete={data.onDeleteGen} onRefresh={data.onRefreshGen} onEditInSuite={data.onEditInSuite} />
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
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string, nav?: ZoomNav) => void;
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

/* ------------------------------------------------------------------ */
/* Take history — newest-few strip + a full-history modal.              */
/* ------------------------------------------------------------------ */

/** How many of a node's stored takes the inline strip shows before the History
 *  button takes over; the full list (bounded by `GRAPH_HISTORY_CAP`) lives in
 *  the history modal. */
const HISTORY_STRIP_LIMIT = 6;
/** Trailing debounce for viewport-only layout saves (see onCanvasMoveEnd). */
const VIEWPORT_SAVE_DEBOUNCE_MS = 400;

/** Opens a node's full take history (provided once around the canvas). */
const NodeHistoryContext = createContext<((target: GraphHistoryTarget) => void) | null>(null);

/** The take strip shared by every generator node: a History button first when
 *  more are stored, then the newest `HISTORY_STRIP_LIMIT` takes. The button
 *  leads because it stands for the takes older than the ones shown — the
 *  strip reads in generation order, oldest to newest. */
export function GenHistoryStrip({ items, selected, media, onSelect, onContextMenu, history }: {
  items: { url: string; prompt: string; path: string }[];
  selected: number;
  media: "image" | "video";
  onSelect: (index: number) => void;
  onContextMenu: (e: ReactMouseEvent, it: { url: string; prompt: string; path: string }) => void;
  history: GraphHistoryTarget;
}) {
  const openHistory = useContext(NodeHistoryContext);
  if (items.length === 0) return null;
  // items are newest-first; show the newest few, oldest-first (newest right).
  const shown = items.map((it, i) => ({ it, i })).slice(0, HISTORY_STRIP_LIMIT).reverse();
  return (
    <div className="prod-graph-gen-strip nodrag">
      {items.length > HISTORY_STRIP_LIMIT && (
        <button
          className="prod-graph-gen-history nodrag"
          title={`Show every stored take (${items.length})`}
          onClick={() => openHistory?.(history)}
        >
          ⋯ {items.length}
        </button>
      )}
      {shown.map(({ it, i }) => (
        <button
          key={i}
          className={i === selected ? "sel" : ""}
          title={`${it.prompt || `${media === "image" ? "Generation" : "Clip"} ${i + 1}`} — right-click for options`}
          onClick={() => onSelect(i)}
          onContextMenu={(e) => onContextMenu(e, it)}
        >
          {media === "image" ? <img src={refThumbUrl(it.url)} alt="" draggable={false} loading="lazy" decoding="async" /> : <span>{i + 1}</span>}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Node deletion — a × affordance + a confirm that names what is lost.  */
/* ------------------------------------------------------------------ */

/** A short description of what a removable tool node holds, for the delete
 *  confirm. Empty = unused (delete without asking). */
function toolNodeDeleteSummary(id: string, shot: ProductionShot): string {
  const vidId = parseVideoGenNode(id) ?? parseVideoPromptNode(id);
  const evId = parseEditVideoGenNode(id) ?? parseEditVideoPromptNode(id);
  const vidNode = (evId || vidId) ? videoNodesFor(shot).find((n) => n.id === (evId ?? vidId)) : undefined;
  if (vidNode) {
    const bits: string[] = [];
    const g = vidNode.gens?.length ?? 0;
    if (g > 0) bits.push(`${g} clip${g === 1 ? "" : "s"}`);
    if ((vidNode.prompt ?? "").trim()) bits.push("a motion prompt");
    if (vidNode.source) bits.push("a wired source");
    const r = vidNode.refIds?.length ?? 0;
    if (r > 0) bits.push(`${r} reference${r === 1 ? "" : "s"}`);
    return bits.join(" + ");
  }
  const editId = editNodeIdForCanvas(id);
  if (editId) {
    const node = (shot.graphEditNodes ?? []).find((n) => n.id === editId);
    if (!node) return "";
    const bits: string[] = [];
    const g = node.gens?.length ?? 0;
    if (g > 0) bits.push(`${g} edit${g === 1 ? "" : "s"}`);
    if ((node.prompt ?? "").trim()) bits.push("an edit prompt");
    if (node.source) bits.push("a wired source");
    return bits.join(" + ");
  }
  if (id === "tween") {
    const bits: string[] = [];
    const keys = shot.graphTweenRefIds?.length ?? 0;
    const blocks = shot.graphTweenBlocks?.length ?? 0;
    if (keys > 0) bits.push(`${keys} keyframe${keys === 1 ? "" : "s"}`);
    if (blocks > 0) bits.push(`${blocks} action block${blocks === 1 ? "" : "s"}`);
    if (shot.graphTweenOutput) bits.push("a stitched clip");
    return bits.join(" + ");
  }
  if (id === "cameraGrid") return shot.graphCameraGrid?.sheetPath ? "a generated sheet" : "";
  if (id === "upscale") {
    const n = shot.graphUpscale?.gens?.length ?? 0;
    return n > 0 ? `${n} output${n === 1 ? "" : "s"}` : "";
  }
  return "";
}

/** Whether a removed node currently feeds the frame/video output. */
function nodeFeedsOutput(id: string, shot: ProductionShot): boolean {
  const src = shot.graphOutputSource;
  if (src === "tween") return id === "tween";
  if (src === "upscale") return id === "upscale";
  if (src === "editgen") return editNodeIdForCanvas(id) === (shot.graphOutputEditNodeId ?? "");
  if (src === "videogen") {
    const idOf = parseVideoGenNode(id) ?? parseVideoPromptNode(id) ?? parseEditVideoGenNode(id) ?? parseEditVideoPromptNode(id);
    return !!idOf && idOf === (shot.graphOutputVideoNodeId ?? "vid0");
  }
  return false;
}

/** The confirmation text for deleting one or more removable nodes. Empty when
 *  none holds anything (the caller deletes silently). A data-holding node is
 *  never silently refused — deleting it is allowed after this confirm. */
export function toolDeleteWarning(ids: string[], shot: ProductionShot): string {
  const summaries = ids.map((id) => toolNodeDeleteSummary(id, shot)).filter(Boolean);
  if (!summaries.length) return "";
  const what = summaries.length === 1 ? `this node holds ${summaries[0]}` : `these nodes hold ${summaries.join("; ")}`;
  const feeds = ids.some((id) => nodeFeedsOutput(id, shot));
  return `Delete ${what}?${feeds ? " It feeds the output, which will be cleared." : ""} This can't be undone.`;
}

/** Resolve a history target to the node's stored takes (newest first), the
 *  selected index, and the media kind. Reads live shot state so the modal
 *  tracks a selection change. */
function historyViewFor(shot: ProductionShot, prodId: string, target: GraphHistoryTarget): { items: GraphHistoryItem[]; selected: number; media: "image" | "video" } {
  const toItems = (gens?: { path: string; prompt: string; draftJobId?: string }[]): GraphHistoryItem[] =>
    (gens ?? []).map((g) => ({
      url: graphMediaUrl(prodId, g.path),
      prompt: g.prompt,
      path: g.path,
      ...(g.draftJobId ? { draftJobId: g.draftJobId } : {}),
    }));
  if (target.kind === "image") return { items: toItems(shot.graphImageGens), selected: shot.graphImageGenIndex ?? 0, media: "image" };
  if (target.kind === "upscale") return { items: toItems(shot.graphUpscale?.gens), selected: shot.graphUpscale?.genIndex ?? 0, media: "image" };
  if (target.kind === "edit") {
    const node = (shot.graphEditNodes ?? []).find((n) => n.id === (target.nodeId ?? "edit0"));
    return { items: toItems(node?.gens), selected: node?.genIndex ?? 0, media: "image" };
  }
  const node = videoNodesFor(shot).find((n) => n.id === (target.nodeId ?? "vid0"));
  return { items: toItems(node?.gens), selected: node?.genIndex ?? 0, media: "video" };
}

/** Lets a module-scope node view request its own deletion WITHOUT threading a
 *  callback through every node's `data`. A visible × must work even when the
 *  focus/selection state would otherwise swallow a Delete keypress (the reason
 *  deletion felt "finicky"). Provided once around the canvas; null outside a
 *  host (the component tests render `graphNodeTypes` bare), where no button
 *  shows and the node is deleted by the ordinary key path. */
const NodeDeleteContext = createContext<((id: string) => void) | null>(null);

/** The × in a node's top-right corner (absolutely positioned inside the React
 *  Flow node wrapper, so it travels with the node). */
function NodeDeleteButton({ id }: { id: string }) {
  const del = useContext(NodeDeleteContext);
  if (!del) return null;
  return (
    <button
      type="button"
      className="prod-graph-node-del nodrag nopan"
      title="Delete this node — you'll be asked before any outputs are discarded"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); del(id); }}
    >
      ×
    </button>
  );
}

/** Wrap a node view so it carries the shared delete affordance. Wrapping the
 *  type (rather than editing each view) keeps the affordance in one place. */
function withNodeDelete<P extends { id: string }>(Base: ComponentType<P>): ComponentType<P> {
  function DeletableNode(props: P) {
    return (
      <>
        <Base {...props} />
        <NodeDeleteButton id={props.id} />
      </>
    );
  }
  DeletableNode.displayName = `withNodeDelete(${Base.displayName ?? Base.name ?? "Node"})`;
  return DeletableNode;
}

const edgeTypes = { waypoint: WaypointEdge };

const nodeTypes = {
  ref: RefNodeView,
  composer: ComposerNodeView,
  style: StyleNodeView,
  brand: BrandNodeView,
  // NOT "output" — that's a built-in React Flow type whose default CSS paints
  // a white box behind the custom node.
  frame: OutputNodeView,
  imagegen: ImageGenNodeView,
  videogen: withNodeDelete(VideoGenNodeView),
  tween: withNodeDelete(TweenNodeView),
  editvideo: withNodeDelete(EditVideoNodeView),
  editgen: withNodeDelete(EditGenNodeView),
  videoprompt: withNodeDelete(VideoPromptNodeView),
  sequenceprompt: SequencePromptNodeView,
  editprompt: withNodeDelete(EditPromptNodeView),
  editvideoprompt: withNodeDelete(EditVideoPromptNodeView),
  cameraGrid: withNodeDelete(CameraGridNodeView),
  upscale: withNodeDelete(UpscaleNodeView),
};

/** Exported for the renderer-component tests (the node graph uses it directly). */
export const graphNodeTypes = nodeTypes;

/* ------------------------------------------------------------------ */
/* Reference shelf lives in `graph/ref-shelf.tsx` (shared with the shot
   sequence canvas — one shelf, two hosts).                              */
/* ------------------------------------------------------------------ */

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

export function NodeGraphModal({ prod, shot, bust, prompt, references, styles, styleValue, includeBrand, magicActive = false, magicBusy = false, onToggleMagic, onRegenMagicShot, imageModels, videoModels, endFrameModelIds = null, upscaleUnavailable = false, videoEditUnavailable = false, genjutsuUnavailable = false, draftUpgradeAvailable = false, hiddenTools, hidePalette = false, subjectLabel, defaultImageModel, defaultImageResolution, initialLayout, onPromptChange, onStyleChange, onToggleBrand, onDropFile, onPasteFiles, onStyleDetached, onRunImageGen, onRunVideoGen, onUpgradeDraft = async () => {}, onRunEditGen, onRunEditVideo = async () => {}, onRunCameraGrid = async () => {}, onImportCameraGridImage = async () => null, onExportCameraGrid = async () => null, onRunUpscale = async () => {}, onRunTweenBlock = async () => {}, onStitchTween = async () => {}, onUnstitchTween = async () => {}, onFetchVideo = async () => {}, imageGenBusy = false, cameraGridBusy = false, upscaleBusy = false, videoBusyNodeIds = [], editVideoBusyNodeIds = [], editBusyNodeIds = [], busyTweenBlock = null, tweenStitching = false, onSelectGraphGen, onCycleGraphGen, onDeleteGeneration = () => {}, onSaveAsReference = () => {},
  onSaveGenerationAsReference = async () => undefined, onVideoStillSaved, onEditNodePrompt = () => {}, onSequenceSegments, onRevertFramePrompt, sequenceFramePrompts, onRenameRef, onWaveformColorRef, onGraphField, onPipeImageToVideo, onPipeEditToVideo = () => {}, onPipeRefToVideo = () => {}, onPipeImageToOutput, onPipeVideoToOutput, onPipeTweenToOutput = () => {}, onPipeUpscaleToOutput = () => {}, onPipeEditToOutput, onPipeRefToOutput, onTweenRefs = () => {}, onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeTweenGen = () => {}, onUnpipeEditGen, onUnpipeOutput, onSaveLayout, onClose, readOnly = false, onDetach }: {
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
  /** A batch of pasted files. The parent prompts for each (defaults auto-numbered, Ref_001…)
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
  /** Active provider is not the Higgsfield CLI — the Genjutsu nodes are
   *  disabled in the palette (grayed out, like edit-video under OpenArt). */
  genjutsuUnavailable?: boolean;
  /** Active vendor supports the Seedance 2.5 draft → 1080p finalize (Higgsfield
   *  CLI only). Gates the video node's Draft toggle. */
  draftUpgradeAvailable?: boolean;
  /** Node kinds / palette tools this host does not have at all (a shot
   *  sequence canvas hides the image-generation node and the shot-only
   *  generators): they are hidden rather than disabled — no tile, no node,
   *  and stripped from a stored graph. Hiding "imagegen" also hides the
   *  composer prompt node that feeds it. */
  hiddenTools?: readonly ("imagegen" | "edit" | "tween" | "editvideo" | "genjutsu-motion" | "genjutsu-swap" | "cameraGrid" | "upscale" | "brand")[];
  /** Hide the right-hand node palette (a single-node canvas, e.g. a shot
   *  sequence, has nothing to drag in). */
  hidePalette?: boolean;
  /** The canvas header's subject label — defaults to `Shot <number>` (a shot
   *  sequence canvas passes its name). */
  subjectLabel?: string;
  /** Defaults from the production's OpenArt config for the image node. */
  defaultImageModel: string;
  defaultImageResolution: string;
  /** Run the image generation node (prompt = the composer's text). */
  onRunImageGen: (model: string, resolution: string, params?: GenParams) => Promise<void>;
  /** Run the video generation node (prompt = the video-prompt node). */
  onRunVideoGen: (nodeId: string, model: string, resolution: string, durationSec: number, params?: GenParams) => Promise<void>;
  /** Finalize a Seedance 2.5 draft take (480p) at 1080p, replacing it in place. */
  onUpgradeDraft?: (nodeId: string, rel: string) => Promise<void>;
  /** Run an edit-image node (prompt = that node's edit-prompt node). */
  onRunEditGen: (nodeId: string, model: string, resolution: string, params?: GenParams) => Promise<void>;
  /** Run one edit-video node (source/refs come from its wired sockets). */
  onRunEditVideo?: (nodeId: string, model: string, resolution: string, durationSec: number, prompt: string, params?: GenParams) => Promise<void>;
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
  /** A camera-grid generation is running for this shot (ledger-sourced, so it
   *  also lights in the window that did not start it). */
  cameraGridBusy?: boolean;
  /** An upscale generation is running for this shot (ledger-sourced). */
  upscaleBusy?: boolean;
  /** Video node ids currently generating for this shot (per-node busy). */
  videoBusyNodeIds?: string[];
  /** Edit-video node ids currently generating for this shot (per-node busy). */
  editVideoBusyNodeIds?: string[];
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
  onDeleteGeneration?: (rel: string) => Promise<string | void> | string | void;
  /** Copy a stored take into the production as a new reference (right-click). */
  onSaveAsReference?: (rel: string) => void;
  /** Copy a stored take into the production as a new reference and resolve the
   *  created reference, so dragging a generation output onto a prompt's
   *  reference socket can wire the new node in place. */
  /** Resolves the created ref; `null` = handled but nothing saved (popup
   *  cancelled or an error the caller already surfaced); `undefined` = not
   *  wired, fall back to `onSaveAsReference`. */
  onSaveGenerationAsReference?: (rel: string, name?: string) => Promise<GraphRef | null | undefined>;
  /** A video lightbox's saved still comes back here (the workspace applies it). */
  onVideoStillSaved?: (next: Production) => void;
  /** Update one edit node's prompt text. */
  onEditNodePrompt?: (nodeId: string, text: string) => void;
  /** Replace a sequence canvas's timeline segments (prompt/end edits). */
  onSequenceSegments?: (segments: SequenceSegment[]) => void;
  /** Drop a segment's prompt override so it follows its frame prompt again. */
  onRevertFramePrompt?: (shotId: string) => void;
  /** The effective storyboard prompt per member shot (Magic when on, else the
   *  frame prompt), for a sequence prompt node's per-shot panels. */
  sequenceFramePrompts?: Record<string, string>;
  /** Rename a reference from its canvas node (main rewrites its `@[name]` tags
   *  across every prompt store atomically, like the Design page). */
  onRenameRef?: (refId: string, name: string) => void;
  /** Persist an audio reference's waveform color (right-click swatch menu). */
  onWaveformColorRef?: (refId: string, colorId: string) => void;
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
  onSaveLayout: (layout: GraphLayoutPatch) => void;
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

  // ---- Node-view undo/redo -------------------------------------------------
  // Every graph/layout mutation funnels through graphField / saveLayout /
  // saveGraph below, which capture a pre-mutation snapshot (the shot's
  // graph-owned fields via the patch allowlist + the canvas layout). Undo
  // restores the snapshot through the same narrow commands. Generation
  // results (gens, jobs) are main-owned and never enter a snapshot, so undo
  // can never un-record a finished generation.
  type GraphHistorySnapshot = { fields: Partial<ProductionShot>; layout: GraphLayout | undefined };
  const historyRef = useRef(createUndoHistory<GraphHistorySnapshot>({ limit: 50, coalesceMs: 1200 }));
  const restoringRef = useRef(false);
  const shotNowRef = useRef(shot);
  shotNowRef.current = shot;
  const [, setHistoryTick] = useState(0);
  const snapshotNow = useCallback((): GraphHistorySnapshot => ({
    fields: pickGraphShotPatch(shotNowRef.current as unknown as Record<string, unknown>) as Partial<ProductionShot>,
    layout: cb.current.initialLayout ? (JSON.parse(JSON.stringify(cb.current.initialLayout)) as GraphLayout) : undefined,
  }), []);
  const captureHistory = useCallback((force = false) => {
    if (restoringRef.current || readOnly) return;
    if (historyRef.current.push(snapshotNow(), { force })) setHistoryTick((n) => n + 1);
  }, [readOnly, snapshotNow]);
  const graphField = useCallback((patch: Partial<ProductionShot>): void => {
    captureHistory();
    // Write the patch through to the callback ref's mirrored fields NOW:
    // handlers chain read-modify-write saves within one gesture (place a
    // ref, then connect it; strip a sentinel, then add another), and the
    // prop snapshot in cb.current only catches up on re-render — reading
    // it stale silently lost the earlier write (a graph node, a wire, a
    // video refIds list), which surfaced as connections and tags
    // desyncing. The next render reassigns cb.current from props, which
    // by then carry this same optimistic patch.
    const mirror = cb.current as unknown as Record<string, unknown>;
    for (const k of Object.keys(patch)) if (k in mirror) mirror[k] = (patch as Record<string, unknown>)[k];
    cb.current.onGraphField(patch);
  }, [captureHistory]);
  const saveLayout = useCallback((patch: GraphLayoutPatch): void => {
    // Pan/zoom alone is not an undoable edit.
    if (!("viewport" in patch && Object.keys(patch).length === 1)) captureHistory();
    saveLayoutRef.current(patch);
  }, [captureHistory]);
  /** Apply layout positions to the LIVE canvas. The reconcile effect
   *  deliberately keeps a mounted node's current position (so unrelated
   *  rebuilds never snap a node mid-drag), which means a saved layout
   *  change only becomes visible when the live node state is moved
   *  explicitly — Tidy and undo/redo restores do that here. */
  const applyLivePositions = useCallback((positions: Record<string, { x: number; y: number }> | undefined) => {
    if (!positions || !Object.keys(positions).length) return;
    const next = nodesRef.current.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n));
    nodesRef.current = next;
    setNodes(next);
  }, []);
  const restoreHistory = useCallback((entry: GraphHistorySnapshot) => {
    restoringRef.current = true;
    try {
      cb.current.onGraphField(entry.fields);
      const cur = cb.current.initialLayout;
      const snap = entry.layout;
      const idsOf = (l: GraphLayout | undefined) => new Set([
        ...Object.keys(l?.positions ?? {}),
        ...Object.keys(l?.sizes ?? {}),
        ...Object.keys(l?.collapsed ?? {}),
      ]);
      const curIds = idsOf(cur);
      const snapIds = idsOf(snap);
      const remove = [...curIds].filter((id) => !snapIds.has(id));
      saveLayoutRef.current({
        positions: snap?.positions ?? {},
        sizes: snap?.sizes ?? {},
        collapsed: snap?.collapsed ?? {},
        waypoints: snap?.waypoints ?? {},
        remove,
      });
      // The saved layout alone doesn't move mounted nodes (the reconcile
      // effect preserves live positions) - apply the restored ones.
      applyLivePositions(snap?.positions);
    } finally {
      restoringRef.current = false;
    }
  }, [applyLivePositions]);
  const doUndo = useCallback(() => {
    const target = historyRef.current.undo(snapshotNow());
    if (target) restoreHistory(target);
    setHistoryTick((n) => n + 1);
  }, [restoreHistory, snapshotNow]);
  /** Edge waypoint edits (click-to-add, drag, double-click delete). Each
   *  gesture is one forced history step; the layout save itself is the
   *  narrow updateGraphLayout command, so bends persist and classic view
   *  never sees them. */
  const [selectedWaypoint, setSelectedWaypoint] = useState<{ edgeId: string; index: number } | null>(null);
  const waypointHandlers = useMemo<WaypointHandlers>(() => ({
    add: (edgeId, pos, index) => {
      if (readOnly) return;
      captureHistory(true);
      const cur = cb.current.initialLayout?.waypoints?.[edgeId] ?? [];
      saveLayout({ waypoints: { [edgeId]: [...cur.slice(0, index), pos, ...cur.slice(index)] } });
      setSelectedWaypoint((sel) => (sel && sel.edgeId === edgeId && index <= sel.index ? { edgeId, index: sel.index + 1 } : sel));
    },
    move: (edgeId, index, pos) => {
      if (readOnly) return;
      captureHistory(true);
      const cur = cb.current.initialLayout?.waypoints?.[edgeId] ?? [];
      saveLayout({ waypoints: { [edgeId]: cur.map((p, i) => (i === index ? pos : p)) } });
    },
    remove: (edgeId, index) => {
      if (readOnly) return;
      captureHistory(true);
      const cur = cb.current.initialLayout?.waypoints?.[edgeId] ?? [];
      saveLayout({ waypoints: { [edgeId]: cur.filter((_, i) => i !== index) } });
      setSelectedWaypoint((sel) => {
        if (!sel || sel.edgeId !== edgeId) return sel;
        if (sel.index === index) return null;
        return sel.index > index ? { edgeId, index: sel.index - 1 } : sel;
      });
    },
    select: (edgeId, index) => {
      setSelectedWaypoint({ edgeId, index });
      // Exchange selections: with React Flow's node/edge selection empty,
      // its deleteKeyCode handler is a no-op when Delete removes the
      // waypoint - one keypress can never do both.
      setSelectedEdges(new Set());
      if (nodesRef.current.some((n) => n.selected)) {
        const next = nodesRef.current.map((n) => (n.selected ? { ...n, selected: false } : n));
        nodesRef.current = next;
        setNodes(next);
      }
    },
    selected: selectedWaypoint,
  }), [captureHistory, readOnly, saveLayout, selectedWaypoint]);

  /** Tidy: arrange every node into a deterministic left-to-right flow and
   *  clear all edge waypoints (stale bends are meaningless once nodes move).
   *  One history step (the forced capture above the layout save). */
  const tidyLayout = useCallback(() => {
    if (readOnly) return;
    const inst = flowRef.current;
    if (!inst) return;
    captureHistory(true);
    const flowNodes = inst.getNodes();
    const sizes: Record<string, { width: number; height: number }> = {};
    for (const n of flowNodes) {
      sizes[n.id] = { width: n.measured?.width ?? 300, height: n.measured?.height ?? 200 };
    }
    const mini = {
      nodes: flowNodes.map((n) => ({ id: n.id })),
      edges: inst.getEdges().map((e) => ({ from: { node: e.source }, to: { node: e.target } })),
    };
    const positions = tidyGraphLayout(mini, sizes, (id) => id === "output");
    const clearWaypoints = Object.fromEntries(
      inst.getEdges().map((e) => [e.id, [] as { x: number; y: number }[]])
    );
    saveLayoutRef.current({
      positions,
      ...(Object.keys(clearWaypoints).length ? { waypoints: clearWaypoints } : {}),
    });
    setSelectedWaypoint(null);
    applyLivePositions(positions);
  }, [captureHistory, readOnly, applyLivePositions]);

  const doRedo = useCallback(() => {
    const target = historyRef.current.redo(snapshotNow());
    if (target) restoreHistory(target);
    setHistoryTick((n) => n + 1);
  }, [restoreHistory, snapshotNow]);
  /** Node kinds / palette tools this host does not have at all (a shot sequence
   *  canvas hides the image-generation node and the shot-only generators):
   *  they are not rendered, not draggable, and stripped from a stored graph.
   *  Hiding "imagegen" also hides the composer prompt node that feeds it. */
  const hiddenToolsSet = useMemo(
    () => new Set(hiddenTools ?? []),
    [hiddenTools]
  );
  /** Whether a graph node kind belongs to a tool this host doesn't have. */
  const nodeKindHidden = useCallback((kind: string): boolean => {
    if (kind === "imagegen" || kind === "composer") return hiddenToolsSet.has("imagegen");
    if (kind === "editgen" || kind === "editprompt") return hiddenToolsSet.has("edit");
    if (kind === "editvideo" || kind === "editvideoprompt") return hiddenToolsSet.has("editvideo");
    if (kind === "tween" || kind === "cameraGrid" || kind === "upscale") return hiddenToolsSet.has(kind);
    if (kind === "brand") return hiddenToolsSet.has("brand");
    return false;
  }, [hiddenToolsSet]);
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  /** A just-saved reference tile to pulse + scroll into view, until the user
   *  hovers it or acts elsewhere. */
  const [highlightRefId, setHighlightRefId] = useState<string | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ name: string; artwork: string; kind?: "image" | "video"; rel?: string; nav?: ZoomNav } | null>(null);

  /** Right-click menu for the enlarged generation in the lightbox. */
  const lightboxMenu = useGenerationMenu();
  /** In-betweener timeline window (stacked above the graph). */
  const [tweenOpen, setTweenOpen] = useState(false);
  /** Full-res camera-grid panel editor popup (stacked above the graph). */
  const [cameraGridEditorOpen, setCameraGridEditorOpen] = useState(false);
  /** The node whose full take history is open (the strip shows only the newest
   *  few; the modal lists every stored take). */
  const [historyTarget, setHistoryTarget] = useState<GraphHistoryTarget | null>(null);
  /** Bumped by the take-menu "Refresh" to rebuild node URLs after a media
   *  revision bump (so an externally edited take re-fetches its pixels). */
  const [mediaRevTick, setMediaRevTick] = useState(0);
  /** In-flight tween state is workspace-owned (see props) so the timeline's
   *  "Generating…"/"Stitching…" labels survive closing and reopening. */
  const busyBlock = busyTweenBlock ?? null;
  const stitching = tweenStitching === true;
  const hintTimer = useRef<number | null>(null);
  /** Viewport-moving flag for node media (graph/lod.tsx): live videos stand
   *  down to posters while the view moves. The flag's React state lives in
   *  the leaf GraphLodProvider — flipping modal-level state here re-rendered
   *  this whole component on every d3-zoom start/end cycle (one per wheel
   *  burst), eating the first zoom increments. */
  const lodHandleRef = useRef<GraphLodHandle | null>(null);
  // Viewport-only layout saves are trailing-debounced: d3-zoom ends a
  // wheel burst after 150ms idle, so saving on every onMoveEnd fired a
  // workspace setProd + IPC + snapshot round-trip between bursts, right
  // where the next notch lands. The viewport is read only at mount
  // (defaultViewport), so persisting it a beat late is invisible; the
  // unmount flush keeps a fast close (or shot switch) from losing it.
  const pendingViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const viewportSaveTimerRef = useRef<number | null>(null);
  const flushPendingViewport = useCallback(() => {
    if (viewportSaveTimerRef.current !== null) {
      window.clearTimeout(viewportSaveTimerRef.current);
      viewportSaveTimerRef.current = null;
    }
    const viewport = pendingViewportRef.current;
    pendingViewportRef.current = null;
    if (viewport) saveLayoutRef.current({ viewport });
  }, []);
  useEffect(() => () => flushPendingViewport(), [flushPendingViewport]);
  const onCanvasMoveStart = useCallback(() => {
    lodHandleRef.current?.setInteracting(true);
  }, []);
  const onCanvasMoveEnd = useCallback((_event: unknown, viewport: { x: number; y: number; zoom: number }) => {
    lodHandleRef.current?.setInteracting(false);
    pendingViewportRef.current = viewport;
    if (viewportSaveTimerRef.current !== null) window.clearTimeout(viewportSaveTimerRef.current);
    viewportSaveTimerRef.current = window.setTimeout(flushPendingViewport, VIEWPORT_SAVE_DEBOUNCE_MS);
  }, [flushPendingViewport]);
  /** React Flow instance (captured on init) — used to map drop coordinates. */
  const flowRef = useRef<{
  screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number };
  getNodes: () => { id: string; measured?: { width?: number; height?: number } }[];
  getEdges: () => { id: string; source: string; target: string }[];
} | null>(null);
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
  /** Media refreshes currently running (per rel), so a second Refresh click
   *  while one is in flight says so instead of queueing a duplicate encode. */
  const refreshingRelsRef = useRef<Set<string>>(new Set());

  const showHint = useCallback((message: string) => {
    setDropHint(message);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setDropHint(null), 4000);
  }, []);

  /** Reveal a just-saved reference in the shelf (the shelf opens itself and
   *  clears its filter when the highlight lands) — used when a take is saved
   *  as a reference. The highlight stays until the user hovers the tile or
   *  acts elsewhere (see `dismissHighlight`), so the saved reference never
   *  disappears before the user finds it. */
  const revealShelfRef = useCallback((refId: string) => {
    setHighlightRefId(refId);
  }, []);

  const dismissHighlight = useCallback(() => setHighlightRefId(null), []);

  // Escape closes the lightbox first, then the graph. When a stacked dialog
  // (video generation, tween timeline) is open above the graph, it owns Escape.
  // While the user is typing in a prompt box, Escape only yields focus (which
  // commits the node's draft) instead of closing the whole canvas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (lightbox) { setLightbox(null); return; }
      if (document.querySelector(".prod-video-overlay")) return;
      if (document.querySelector(".prod-tween-overlay")) return;
      if (isEditingTarget(e.target)) {
        const ae = document.activeElement as HTMLElement | null;
        if (ae && typeof ae.blur === "function") ae.blur();
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, lightbox]);

  useEffect(() => {
    const onUndoKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.isComposing || isEditingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if ((key === "z" && e.shiftKey) || key === "y") { e.preventDefault(); doRedo(); }
    };
    document.addEventListener("keydown", onUndoKey);
    return () => document.removeEventListener("keydown", onUndoKey);
  }, [doUndo, doRedo]);

  // Delete removes a selected waypoint (layout-only, so React Flow's
  // deleteKeyCode cannot see it). Selecting a waypoint cleared the flow
  // selection, so the two delete paths never collide; keypresses inside
  // prompt editables are ignored so text editing stays text editing.
  useEffect(() => {
    const onWaypointDeleteKey = (e: KeyboardEvent) => {
      if (readOnly) return;
      if ((e.key !== "Delete" && e.key !== "Backspace") || e.isComposing || isEditingTarget(e.target)) return;
      const sel = selectedWaypoint;
      if (!sel) return;
      const pts = cb.current.initialLayout?.waypoints?.[sel.edgeId];
      if (!pts || pts[sel.index] === undefined) { setSelectedWaypoint(null); return; }
      e.preventDefault();
      waypointHandlers.remove(sel.edgeId, sel.index);
      setSelectedWaypoint(null);
    };
    document.addEventListener("keydown", onWaypointDeleteKey);
    return () => document.removeEventListener("keydown", onWaypointDeleteKey);
  }, [readOnly, selectedWaypoint, waypointHandlers]);

  // Output thumbnail: fetched lazily, refetched when the frame changes. The
  // thumbnail resolves through the shared display (the pipe when bound), so
  // the guard keys on the resolved path, not the retired mirror.
  useEffect(() => {
    let live = true;
    setThumbnail(null);
    if (resolveShotDisplay(shot).path) {
      window.cascade.boardThumbnail(prod.meta.id, shot.id).then((d) => { if (live) setThumbnail(d ?? null); }).catch(() => {});
    }
    return () => { live = false; };
  }, [prod.meta.id, shot.id, shot.graphOutputSource, shot.graphImageGens, shot.graphImageGenIndex, shot.graphEditNodes, shot.graphVideoNodes, shot.graphUpscale, shot.graphTweenOutput, shot.artwork, shot.videoPath, bust]);

  // Displayed prompt texts render shared sections AND reference tags from the
  // stored graph (step 05): the stored fields hold content only. Tag edits and
  // drafts flow through these values; saves strip shared sections back to
  // content-only.
  /** Every video node (generate + edit mode) — the full list the canvas draws. */
  const allVideoNodes = useMemo<GraphVideoNode[]>(() => shot.graphVideoNodes ?? [], [shot.graphVideoNodes]);
  /** Edit-family video nodes (Edit video + both Genjutsu features). */
  const editFamilyNodes = useMemo(() => allVideoNodes.filter((n) => isVideoEditFamilyMode(n.mode)), [allVideoNodes]);
  /** Edit-mode video nodes only (palette count for the Edit video tile). */
  const editVidNodes = useMemo(() => allVideoNodes.filter((n) => n.mode === "edit"), [allVideoNodes]);
  const genjutsuMotionNodes = useMemo(() => genjutsuNodes(allVideoNodes, "genjutsu-motion"), [allVideoNodes]);
  const genjutsuSwapNodes = useMemo(() => genjutsuNodes(allVideoNodes, "genjutsu-swap"), [allVideoNodes]);
  /** Generate-mode video nodes (the `videogen` pairs). */
  const videoNodes = useMemo<GraphVideoNode[]>(() => {
    const list = videoNodesFor(shot).filter((n) => !isVideoEditFamilyMode(n.mode));
    if (list.length) return list;
    // An explicit (possibly empty) node list is authoritative membership:
    // a deleted video node stays deleted instead of resurrecting off a
    // surviving layout position. Only pre-migration shots (no list yet)
    // fall back to layout-derived presence, mirroring the materializer.
    if (Array.isArray(shot.graphVideoNodes)) return list;
    // A saved layout position alone implies a placed (empty) node, mirroring
    // the materializer's layout-derived presence.
    const p = initialLayout?.positions ?? {};
    if (p.videogen || p.videoprompt) return [{ id: "vid0", prompt: "" }];
    return list;
  }, [shot, initialLayout]);
  /** Per-video-node RENDERED prompt keyed by node id (shared sections +
   *  reference tags; the stored node prompt holds content only). Generate nodes
   *  fall back to the video-motion template; edit nodes are user-authored. */
  const videoPromptValues = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of allVideoNodes) {
      m.set(n.id, isVideoEditFamilyMode(n.mode)
        ? renderShotPrompt(prod, shot, { editvideoprompt: n.id })
        : shot.graphSequence
          ? stripBrandParagraph(renderShotPrompt(prod, shot, { videoprompt: n.id }))
          : renderShotPrompt(prod, { ...shot, graphVideoPrompt: (n.prompt ?? "").trim() ? n.prompt : getPromptTemplate("videoMotion") }, { videoprompt: n.id }));
    }
    return m;
  }, [allVideoNodes, prod, shot]);
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
  /** Every tag cited across all edit prompts (feeds the union ref set).
   *  Read from the RENDERED prompt values like the video prompts — the
   *  raw stored text misses tags the graph wires cite, which hid their
   *  sockets and ref nodes. */
  const taggedEditNames = useMemo(
    () => [...new Set(editNodes.flatMap((n) => refTagNames(editPromptValues.get(n.id) ?? n.prompt ?? "")))],
    [editNodes, editPromptValues],
  );
  /** Tagged refs (name + match) for one edit node, in prompt order. */
  const taggedEditByNode = useMemo(() => {
    const m = new Map<string, { name: string; ref: GraphRef | null }[]>();
    for (const n of editNodes) {
      const names = refTagNames(editPromptValues.get(n.id) ?? n.prompt ?? "");
      m.set(n.id, names.map((name) => ({ name, ref: resolveRefByTagName(references, name) ?? null })));
    }
    return m;
  }, [editNodes, editPromptValues, references]);

  const taggedNames = useMemo(
    () => refTagNames(prompt),
    [prompt],
  );
  /** Tagged refs (name + match) for one video node (either mode), in prompt order. */
  const taggedVideoByNode = useMemo(() => {
    const m = new Map<string, { name: string; ref: GraphRef | null }[]>();
    for (const n of allVideoNodes) {
      const names = refTagNames(videoPromptValues.get(n.id) ?? n.prompt ?? "");
      m.set(n.id, names.map((name) => ({ name, ref: resolveRefByTagName(references, name) ?? null })));
    }
    return m;
  }, [allVideoNodes, videoPromptValues, references]);
  /** Union of tag names across every video node's prompt (feeds the union ref
   *  set + reference-node presence). Includes edit-video prompts. */
  const taggedVideoNames = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of allVideoNodes) for (const name of refTagNames(videoPromptValues.get(n.id) ?? n.prompt ?? "")) {
      const lc = name.toLowerCase();
      if (!seen.has(lc)) { seen.add(lc); out.push(name); }
    }
    return out;
  }, [allVideoNodes, videoPromptValues]);

  // Tagged refs in prompt order; dangling tags (no matching ref) render as
  // "missing" so the user can see and clean them up. Image prompt drives the
  // original `tagged` list; video has its own per-prompt list, edit nodes map
  // per node id (see taggedEditByNode).
  const tagged = useMemo(
    () => taggedNames.map((name) => ({
      name,
      ref: resolveRefByTagName(references, name) ?? null,
    })),
    [taggedNames, references],
  );
  const taggedVideo = useMemo(
    () => taggedVideoNames.map((name) => ({
      name,
      ref: resolveRefByTagName(references, name) ?? null,
    })),
    [taggedVideoNames, references],
  );
  // Union of all tags across the prompts — every reference that appears
  // in ANY prompt gets a node (tagged); untagged references are NOT
  // auto-populated. They live in the side shelf until the user drags one onto
  // the canvas (see `placedRefIds` below), keeping the tray complete while each
  // prompt node's sockets are driven by its own tag list. Edit-video tags ride
  // the video-node union (both modes).
  const unionTagged = useMemo(() => {
    const seen = new Set<string>();
    const out: { name: string; ref: GraphRef | null }[] = [];
    for (const name of [...taggedNames, ...taggedVideoNames, ...taggedEditNames]) {
      const ref = resolveRefByTagName(references, name) ?? null;
      // A canonical name and one of its aliases are the same union entry.
      const lc = ref ? `id:${ref.id}` : name.toLowerCase();
      if (seen.has(lc)) continue;
      seen.add(lc);
      out.push({ name: ref ? ref.name : name, ref });
    }
    return out;
  }, [taggedNames, taggedVideoNames, taggedEditNames, references]);

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
  // Production-wide in-use verdicts for the shelf's node-icon badge (a ref
  // may be in use by another shot even when it isn't on this canvas).
  const refUsage = useMemo(() => referenceUsage(prod), [prod]);
  // Shelf items already on the canvas (tagged or placed) are marked + not draggable.
  const onCanvasRefIds = useMemo(() => {
    const out = new Set(placedRefIds);
    for (const t of unionTagged) if (t.ref?.id) out.add(t.ref.id);
    return out;
  }, [placedRefIds, unionTagged]);
  // A shot sequence's member frames are host-supplied locked inputs (one per
  // timeline segment). Place them so they render as canvas nodes; the sequence
  // prompt node's structural `in-frame-<i>` edges wire to them.
  useEffect(() => {
    const segs = shot.graphSequence?.segments;
    if (!segs?.length) return;
    setPlacedRefIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const s of segs) {
        const id = `seqframe:${s.shotId}`;
        if (!next.has(id)) { next.add(id); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [shot.graphSequence]);

  // The video-generation and in-betweener nodes are NOT auto-populated either —
  // they live as tiles in the right panel and the user drags one out on demand.
  // Edit-image nodes exist exactly when the shot's `graphEditNodes` list has
  // entries (classic edits append to it; the panel drags out new ones).
  /** Whether one video node holds data (clips, prompt, source, refs) — such a
   *  node can't be removed without clearing it. The output feed is judged
   *  separately against which node actually owns it. */
  const videoNodeInUse = (n: GraphVideoNode): boolean =>
    !!((n.gens?.length ?? 0) > 0 || (n.prompt ?? "").trim() || n.source || (n.refIds?.length ?? 0) > 0);
  /** The node the videogen output pipe names (its mode decides which tool owns
   *  the feed). */
  const videoOutputNode = shot.graphOutputSource === "videogen"
    ? (allVideoNodes.find((n) => n.id === (shot.graphOutputVideoNodeId ?? "vid0")) ?? videoNodes[0])
    : undefined;
  const videoGenActive = videoNodes.some(videoNodeInUse) || (!!videoOutputNode && !isVideoEditFamilyMode(videoOutputNode.mode));
  /** The in-betweener is in use while it holds keyframes, blocks, a stitch,
   *  or the output feed — like the video/edit tools, it can't be removed then. */
  const tweenActive = !!((shot.graphTweenRefIds?.length ?? 0) > 0 || (shot.graphTweenBlocks?.length ?? 0) > 0 || shot.graphTweenOutput || shot.graphOutputSource === "tween");
  /** The edit-video tool is in use while any edit-mode node holds clips, a
   *  prompt, a source, refs, or owns the output feed — like the other tools,
   *  it can't be removed then. */
  const editVideoActive = editFamilyNodes.some(videoNodeInUse)
    || (!!videoOutputNode && isVideoEditFamilyMode(videoOutputNode.mode))
    || shot.graphOutputSource === "editvideo";
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
  const hasEditVideoTool = editVidNodes.length > 0 || placedTools.has("editvideo");
  const hasGenjutsuMotionTool = genjutsuMotionNodes.length > 0;
  const hasGenjutsuSwapTool = genjutsuSwapNodes.length > 0;
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

  // (The side shelf's category grouping lives in `graph/ref-shelf.tsx`, shared
  // with the shot sequence canvas.)
  const availIds = useMemo(() => available.map((r) => `ref:${r.id}`), [available]);
  const taggedIds = useMemo(() => unionTagged.map((t, i) => `ref:${t.ref?.id ?? "missing-" + i}`), [unionTagged]);

  // Node callbacks change identity every parent render; routing them through
  // a ref keeps node data (and node object identities) stable across renders,
  // which keeps React Flow's selection bookkeeping from fighting re-renders.
  const cb = useRef({ graph: shot.graph, prodId: prod.meta.id, shotId: shot.id, onPromptChange, onStyleChange, onToggleBrand, prompt, videoPromptValue, videoNodes, videoPromptValues, taggedVideoByNode, editPromptValues, editNodes, setLightbox, styles, styleValue, initialLayout, onStyleDetached, onRunImageGen, onRunVideoGen, onUpgradeDraft, onRunEditGen, onRunEditVideo, onRunCameraGrid, onImportCameraGridImage, onExportCameraGrid, onEditNodePrompt, onRenameRef, onRunTweenBlock, onStitchTween, onFetchVideo, onSelectGraphGen, onCycleGraphGen, onDeleteGeneration, onSaveAsReference, onSaveGenerationAsReference, onGraphField, onPipeImageToVideo, onPipeEditToVideo, onPipeRefToVideo, onPipeImageToOutput, onPipeVideoToOutput, onPipeTweenToOutput, onPipeUpscaleToOutput, onPipeEditToOutput, onPipeRefToOutput, onTweenRefs, onOpenTweenTimeline: () => setTweenOpen(true), onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeTweenGen, onUnpipeEditGen, onUnpipeOutput, references, graphStyleConnected: shot.graphStyleConnected, graphVideoStyleConnected: shot.graphVideoStyleConnected, graphVideoNodes: shot.graphVideoNodes, graphOutputVideoNodeId: shot.graphOutputVideoNodeId, graphEditNodes: shot.graphEditNodes, graphOutputSource: shot.graphOutputSource, graphOutputRefId: shot.graphOutputRefId, graphOutputEditNodeId: shot.graphOutputEditNodeId, graphEditToVideo: shot.graphEditToVideo, graphVideoSourceRefId: shot.graphVideoSourceRefId, graphVideoSourceEditNodeId: shot.graphVideoSourceEditNodeId, graphTweenRefIds: shot.graphTweenRefIds, allVideoNodes, editVidNodes, graphCameraGrid: shot.graphCameraGrid, graphUpscale: shot.graphUpscale, onRunUpscale, graphSequence: shot.graphSequence, onSequenceSegments, onRevertFramePrompt, sequenceFramePrompts });
  cb.current = { graph: shot.graph, prodId: prod.meta.id, shotId: shot.id, onPromptChange, onStyleChange, onToggleBrand, prompt, videoPromptValue, videoNodes, videoPromptValues, taggedVideoByNode, editPromptValues, editNodes, setLightbox, styles, styleValue, initialLayout, onStyleDetached, onRunImageGen, onRunVideoGen, onUpgradeDraft, onRunEditGen, onRunEditVideo, onRunCameraGrid, onImportCameraGridImage, onExportCameraGrid, onEditNodePrompt, onRenameRef, onRunTweenBlock, onStitchTween, onFetchVideo, onSelectGraphGen, onCycleGraphGen, onDeleteGeneration, onSaveAsReference, onSaveGenerationAsReference, onGraphField, onPipeImageToVideo, onPipeEditToVideo, onPipeRefToVideo, onPipeImageToOutput, onPipeVideoToOutput, onPipeTweenToOutput, onPipeUpscaleToOutput, onPipeEditToOutput, onPipeRefToOutput, onTweenRefs, onOpenTweenTimeline: () => setTweenOpen(true), onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeTweenGen, onUnpipeEditGen, onUnpipeOutput, references, graphStyleConnected: shot.graphStyleConnected, graphVideoStyleConnected: shot.graphVideoStyleConnected, graphVideoNodes: shot.graphVideoNodes, graphOutputVideoNodeId: shot.graphOutputVideoNodeId, graphEditNodes: shot.graphEditNodes, graphOutputSource: shot.graphOutputSource, graphOutputRefId: shot.graphOutputRefId, graphOutputEditNodeId: shot.graphOutputEditNodeId, graphEditToVideo: shot.graphEditToVideo, graphVideoSourceRefId: shot.graphVideoSourceRefId, graphVideoSourceEditNodeId: shot.graphVideoSourceEditNodeId, graphTweenRefIds: shot.graphTweenRefIds, allVideoNodes, editVidNodes, graphCameraGrid: shot.graphCameraGrid, graphUpscale: shot.graphUpscale, onRunUpscale, graphSequence: shot.graphSequence, onSequenceSegments, onRevertFramePrompt, sequenceFramePrompts };
  // The prompt-commit wrappers below are created once (stable), so they
  // read the live Magic flag through a ref, not the first render's prop.
  const magicActiveRef = useRef(magicActive);
  magicActiveRef.current = magicActive;
  // Same live-ref pattern for the waveform-color callback (stable wrappers
  // below are created once and must see the current prop).
  const waveformColorFnRef = useRef(onWaveformColorRef);
  waveformColorFnRef.current = onWaveformColorRef;
  // Live-draft handles registered by the three prompt nodes (see
  // PromptDraftApplier). Prompt mutations below prefer them over cb.current's
  // prop values, which lag the node's local draft while it is focused.
  const appliers = useRef<Record<string, PromptDraftApplier | undefined>>({});
  /** Replace one video node immutably in the shot's `graphVideoNodes` list. */
  const patchVideoNode = (nodeId: string, patch: Partial<GraphVideoNode>): void => {
    graphField({ graphVideoNodes: (cb.current.graphVideoNodes ?? []).map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) });
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
    onPromptChange: (value: string) => {
      cb.current.prompt = value;
      cb.current.onPromptChange(value);
      // Magic commits skip the tag->wire reconcile: the magic effect
      // rebuilds the composer's wires from the generated text itself.
      if (!magicActiveRef.current) reconcileTagsToEdges("composer", value);
    },
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
    /** Persist an audio reference's waveform color from its canvas node. */
    onWaveformColorRef: (refId: string, colorId: string) => waveformColorFnRef.current?.(refId, colorId),
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
      saveLayout({ collapsed: { ...collapsedRef.current } });
    },
    onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string, nav?: ZoomNav) => cb.current.setLightbox({ name, artwork, kind, rel, nav }),
    // Generation nodes queue through the shared per-target queue so extra
    // clicks wait their turn and the button can show "Generating (N queued)".
    onRunImageGen: (model: string, resolution: string, params?: GenParams) => {
      genQueue.enqueue(genKeys.image(cb.current.shotId), () => cb.current.onRunImageGen(model, resolution, params));
      return Promise.resolve();
    },
    onRunVideoGen: (nodeId: string, model: string, resolution: string, durationSec: number, params?: GenParams) => cb.current.onRunVideoGen(nodeId, model, resolution, durationSec, params),
    onUpgradeDraft: (nodeId: string, rel: string) => cb.current.onUpgradeDraft?.(nodeId, rel) ?? Promise.resolve(),
    onRunEditGen: (nodeId: string, model: string, resolution: string, params?: GenParams) => {
      genQueue.enqueue(genKeys.edit(cb.current.shotId, nodeId), () => cb.current.onRunEditGen(nodeId, model, resolution, params));
      return Promise.resolve();
    },
    onRunEditVideo: (nodeId: string, model: string, resolution: string, durationSec: number, prompt: string, params?: GenParams) => cb.current.onRunEditVideo?.(nodeId, model, resolution, durationSec, prompt, params) ?? Promise.resolve(),
    onFetchVideo: () => cb.current.onFetchVideo?.() ?? Promise.resolve(),
    /** Re-derive a board take's JPEG preview from its original, then bump its
     *  media revision and re-render so the node shows the fresh pixels. */
    onRefreshGen: async (rel: string) => {
      const prodId = cb.current.prodId;
      const name = rel.split("/").pop() ?? rel;
      if (refreshingRelsRef.current.has(rel)) { showHint(`Already refreshing ${name}...`); return; }
      refreshingRelsRef.current.add(rel);
      showHint(`Refreshing ${name}...`);
      try {
        const status = await window.cascade.refreshMedia(prodId, rel);
        bumpMediaRev(prodId, rel);
        setMediaRevTick((t) => t + 1);
        showHint(
          status === "refreshed" ? `Refreshed ${name}.`
          : status === "up-to-date" ? `${name} is already up to date.`
          : status === "no-original" ? `${name} has no archived original - showing the file as-is.`
          : `${name} is missing on disk.`
        );
      } catch (e) {
        showHint(`Refresh failed for ${name}: ${String(e).replace(/^Error:\s*/, "")}`);
      } finally {
        refreshingRelsRef.current.delete(rel);
      }
    },
    onRunCameraGrid: (opts: CameraGridGenOptions) => {
      genQueue.enqueue(genKeys.cameraGrid(cb.current.shotId), () => cb.current.onRunCameraGrid?.(opts) ?? Promise.resolve());
      return Promise.resolve();
    },
    /** Import a wired image as the camera-grid sheet, then bind it to the node
     *  (sheetPath + gridSource) so the editor can cut it up. */
    onImportCameraGridImage: async (source: GraphSource): Promise<CameraGridImportResult | null> => {
      const res = await cb.current.onImportCameraGridImage?.(source);
      if (res?.sheetPath) {
        const cur = normalizeCameraGridData(cb.current.graphCameraGrid) ?? { cols: CAMERA_GRID_COLS, rows: CAMERA_GRID_ROWS };
        graphField({ graphCameraGrid: { ...cur, sheetPath: res.sheetPath, sheetAt: res.sheetAt, gridSource: source } });
      }
      return res;
    },
    /** Open the full-res camera-grid panel editor popup. */
    onOpenCameraGridEditor: () => setCameraGridEditorOpen(true),
    /** Persist a patch onto the shot's camera-grid node state. */
    onCameraGridSave: (patch: Partial<CameraGridData>) => {
      const cur = normalizeCameraGridData(cb.current.graphCameraGrid) ?? { cols: CAMERA_GRID_COLS, rows: CAMERA_GRID_ROWS };
      graphField({ graphCameraGrid: { ...cur, ...patch } });
    },
    onRunUpscale: (model: string, resolution: string, params?: GenParams) => {
      genQueue.enqueue(genKeys.upscale(cb.current.shotId), () => cb.current.onRunUpscale?.(model, resolution, params) ?? Promise.resolve());
      return Promise.resolve();
    },
    /** Persist a patch onto the shot's upscale node state. */
    onUpscaleSave: (patch: Partial<UpscaleData>) => {
      graphField({ graphUpscale: { ...(cb.current.graphUpscale ?? {}), ...patch } });
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
    onSelectEditVideoGen: (nodeId: string, index: number) => cb.current.onSelectGraphGen("video", index, nodeId),
    onSelectUpscaleGen: (index: number) => cb.current.onSelectGraphGen("upscale", index),
    onCycleImageGen: (dir: 1 | -1) => cb.current.onCycleGraphGen("image", dir),
    onCycleVideoGen: (nodeId: string, dir: 1 | -1) => cb.current.onCycleGraphGen("video", dir, nodeId),
    onCycleEditGen: (nodeId: string, dir: 1 | -1) => cb.current.onCycleGraphGen("edit", dir, nodeId),
    onCycleEditVideoGen: (nodeId: string, dir: 1 | -1) => cb.current.onCycleGraphGen("video", dir, nodeId),
    onCycleUpscaleGen: (dir: 1 | -1) => cb.current.onCycleGraphGen("upscale", dir),
    onToggleSelect: (rel: string, selected: boolean) => { void window.cascade.setGenerationSelect(cb.current.prodId, cb.current.shotId, rel, selected); },
    onDeleteGen: async (rel: string) => {
      // A refusal (in use / not a generation) comes back as a message: the
      // workspace error banner sits under this modal, so surface it here.
      const msg = await cb.current.onDeleteGeneration(rel);
      if (typeof msg === "string" && msg) showHint(msg);
    },
    /** Seed a take as the Image Suite's edit source (the "Before edit" frame). */
    onEditInSuite: (rel: string) => openImageSuite(cb.current.prodId, { mode: "edit", sourcePath: rel }),
    /** Save a take as a reference: prefer the resolver that hands back the
     *  created ref so the shelf can open, then pulse its tile; fall back to the
     *  fire-and-forget save when no resolver is wired. */
    onSaveAsRef: (rel: string) => {
      void (async () => {
        const saved = await cb.current.onSaveGenerationAsReference(rel);
        if (saved) revealShelfRef(saved.id);
        // Only an unwired resolver (undefined) falls back — a null means the
        // save popup was cancelled (or already errored), so saving again
        // here would undo the cancel.
        else if (saved === undefined) cb.current.onSaveAsReference(rel);
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
    onVideoPromptChange: (nodeId: string, text: string) => {
      cb.current.videoPromptValues?.set(nodeId, text);
      patchVideoNode(nodeId, { prompt: stripSharedSections(text) });
      reconcileTagsToEdges(videoPromptNodeId(nodeId), text);
    },
    /** Per-node edit-video prompt — the node (a prompt node per edit node). */
    onEditVideoPromptChange: (nodeId: string, text: string) => {
      cb.current.videoPromptValues?.set(nodeId, text);
      patchVideoNode(nodeId, { prompt: stripSharedSections(text) });
      reconcileTagsToEdges(editVideoPromptNodeId(nodeId), text);
    },
    /** Per-node video-gen selections (model/resolution/length) → the node. */
    onSaveVideoFields: (nodeId: string, patch: Partial<GraphVideoNode>) => patchVideoNode(nodeId, patch),
    /** Per-shot image-gen params → the shot (image node advanced panel). */
    onSaveImageFields: (patch: Partial<ProductionShot>) => graphField(patch),
    /** Per-node edit-video selections (model/params) — the node. */
    onSaveEditVideoFields: (nodeId: string, patch: Partial<GraphVideoNode>) => patchVideoNode(nodeId, patch),
    /** Per-node edit-gen selections → the named edit node in the list. */
    onEditNodeSave: (nodeId: string, patch: Partial<GraphEditNode>) =>
      graphField({ graphEditNodes: (cb.current.graphEditNodes ?? []).map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) }),
    onEditPromptChange: (nodeId: string, text: string) => {
      cb.current.editPromptValues.set(nodeId, text);
      cb.current.onEditNodePrompt(nodeId, stripSharedSections(text));
      reconcileTagsToEdges(editPromptNodeId(nodeId), text);
    },
    onPipeImageToVideo: (nodeId: string) => cb.current.onPipeImageToVideo(nodeId),
    onPipeEditToVideo: (nodeId: string, sourceNodeId: string) => cb.current.onPipeEditToVideo?.(nodeId, sourceNodeId),
    onPipeRefToVideo: (nodeId: string, refId: string) => cb.current.onPipeRefToVideo?.(nodeId, refId),
    onPipeImageToOutput: () => cb.current.onPipeImageToOutput(),
    onPipeVideoToOutput: (nodeId: string) => cb.current.onPipeVideoToOutput(nodeId),
    onPipeTweenToOutput: () => cb.current.onPipeTweenToOutput(),
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
        mediaUrl: ref.media && ref.mediaPath ? graphMediaUrl(prod.meta.id, ref.mediaPath) : undefined,
        mediaPath: ref.mediaPath,
        waveformColor: ref.waveformColor,
        tagged: false,
        refId: ref.id,
        collapsed,
        onToggleCollapse: stable.onToggleRefCollapsed,
        onRename: stable.onRenameRef,
        onWaveformColor: stable.onWaveformColorRef,
        onZoom: stable.onZoom,
      },
      deletable: true,
      // The just-placed ref is what the user is reaching for next: select it
      // (elevateNodesOnSelect also raises it above overlapping nodes) and
      // make it the flow's single selection.
      selected: true,
    };
    const next = [...nodesRef.current.map((n) => (n.selected ? { ...n, selected: false } : n)), node];
    nodesRef.current = next;
    setNodes(next);
    setPlacedRefIds((prev) => { const n = new Set(prev); n.add(ref.id); return n; });
    saveLayout({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
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
      : src.kind === "ref" ? references.find((r) => r.id === src.refId)?.name ?? "Reference"
      : null
      : null;
    const gridSrc = grid?.gridSource;
    const gridSourceLabel = gridSrc
      ? gridSrc.kind === "imagegen" ? "Image node frame"
      : gridSrc.kind === "editgen" ? `Edit node ${editNodeLabel(gridSrc.nodeId)}`
      : gridSrc.kind === "ref" ? references.find((r) => r.id === gridSrc.refId)?.name ?? "Reference"
      : null
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
        genKey: genKeys.cameraGrid(shot.id),
        busy: cameraGridBusy,
        onModelSchema: stable.onModelSchema,
        onZoom: stable.onZoom,
      },
      deletable: true,
    };
  }, [shot.graphCameraGrid, shot.id, prod, references, imageModels, defaultImageModel, defaultImageResolution, stable, cameraGridBusy]);

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
      sourcePath = (shot.graphImageGens ?? [])[shot.graphImageGenIndex ?? 0]?.path ?? resolveShotDisplay(shot).stillPath;
    } else if (src?.kind === "editgen") {
      const other = (shot.graphEditNodes ?? []).find((n) => n.id === src.nodeId);
      sourcePath = (other?.gens ?? [])[other?.genIndex ?? 0]?.path;
    } else {
      const display = resolveShotDisplay(shot);
      sourcePath = display.media === "still" ? display.path : display.stillPath;
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
        genKey: genKeys.upscale(shot.id),
        busy: upscaleBusy,
        onSelect: stable.onSelectUpscaleGen,
        onCycle: stable.onCycleUpscaleGen,
        onDeleteGen: stable.onDeleteGen,
        onRefreshGen: stable.onRefreshGen,
        onSaveAsRef: stable.onSaveAsRef,
        onEditInSuite: stable.onEditInSuite,
        onSave: stable.onUpscaleSave,
        onModelSchema: stable.onModelSchema,
        onZoom: stable.onZoom,
      },
      deletable: true,
    };
  }, [shot.graphUpscale, shot.id, shot.graphImageGens, shot.graphImageGenIndex, shot.graphEditNodes, shot.artwork, references, imageModels, upscaleModelIds, defaultImageModel, defaultImageResolution, prod.openArt?.quality, prod.meta.id, stable, upscaleBusy]);

  /** One edit-video node: a video-edit model + a mandatory source clip +
   *  optional references. Only models that declare a video input are offered. */
  const editVideoNodeFor = useCallback((node: GraphVideoNode, pos: { x: number; y: number }): EditVideoFlowNode => {
    // Genjutsu nodes offer ONLY their feature's pair (standard first) and
    // ignore Model Customizer surface assignments — they must work out of
    // the box; hidden models stay excluded by the probe. Edit-video nodes
    // keep the video:editnode surface pool.
    const genjutsu = isGenjutsuMode(node.mode) ? node.mode : null;
    const editModels = genjutsu
      ? videoModels
          .filter((m) => genjutsuModeForModelId(m.id) === genjutsu && (videoEditModelIds ?? []).includes(m.id))
          .sort((a, b) => genjutsuJobTypesForMode(genjutsu).indexOf(rawMediaModelId(a.id)) - genjutsuJobTypesForMode(genjutsu).indexOf(rawMediaModelId(b.id)))
      : videoModels.filter(
          (m) => modelOnSurface(m, "video:editnode") && (videoEditModelIds ?? []).includes(m.id)
        );
    // Image references feeding this node (wired/@-cited refs + direct
    // generation wires) — Genjutsu cannot submit without at least one.
    const imageRefIds = new Set<string>();
    for (const t of taggedVideoByNode.get(node.id) ?? []) if (t.ref && !t.ref.media) imageRefIds.add(t.ref.id);
    for (const rid of node.refIds ?? []) {
      if (isVideoGenRef(rid)) { imageRefIds.add(rid); continue; }
      const r = references.find((x) => x.id === rid);
      if (r && !r.media) imageRefIds.add(r.id);
    }
    const src = node.source;
    const sourceRef = src?.kind === "ref" ? references.find((r) => r.id === src.refId) : undefined;
    const sourceLabel = src?.kind === "video"
      ? "Video node clip"
      : sourceRef
        ? `Reference: ${sourceRef.name}`
        : null;
    const pendingTarget = shot.pendingVideoGen?.target;
    return {
      id: editVideoGenNodeId(node.id),
      type: "editvideo",
      position: pos,
      style: fixedWidth(320),
      data: {
        nodeId: node.id,
        mode: node.mode,
        imageRefCount: imageRefIds.size,
        label: editVideoNodeLabel(node.id),
        models: editModels,
        savedModel: node.model,
        savedParams: node.params,
        savedPrompt: node.prompt,
        savedResolution: node.resolution,
        savedDurationSec: node.durationSec,
        savedDownsampleVideoRefs: node.downsampleVideoRefs,
        showDownsampleVideoRefs: !shot.graphSequence,
        sourceLabel,
        items: (node.gens ?? []).map((g) => ({ url: graphMediaUrl(prod.meta.id, g.path), prompt: g.prompt, path: g.path, select: !!g.select })),
        selected: node.genIndex ?? 0,
        busy: editVideoBusyNodeIds.includes(node.id),
        piped: shot.graphOutputSource === "videogen" && (shot.graphOutputVideoNodeId ?? "vid0") === node.id,
        pending: pendingTarget?.kind === "videoNode" && (pendingTarget.nodeId ?? "vid0") === node.id,
        onFetch: stable.onFetchVideo,
        onGenerate: stable.onRunEditVideo,
        onToggleSelect: stable.onToggleSelect,
        onSelect: stable.onSelectEditVideoGen,
        onCycle: stable.onCycleEditVideoGen,
        onDeleteGen: stable.onDeleteGen,
        onRefreshGen: stable.onRefreshGen,
        onSaveAsRef: stable.onSaveAsRef,
        onEditInSuite: stable.onEditInSuite,
        onSave: stable.onSaveEditVideoFields,
        onPipeToOutput: stable.onPipeVideoToOutput,
        onModelSchema: stable.onModelSchema,
        onModelOptions: stable.onModelOptions,
        onZoom: stable.onZoom,
      },
      deletable: true,
    };
  }, [videoModels, videoEditModelIds, taggedVideoByNode, shot.graphOutputSource, shot.graphOutputVideoNodeId, shot.pendingVideoGen, shot.graphSequence, references, prod.meta.id, editVideoBusyNodeIds, stable]);

  /** One edit-video node's prompt node. */
  const editVideoPromptNodeFor = useCallback((node: GraphVideoNode, promptPos: { x: number; y: number }): GraphNode => {
    const value = videoPromptValues.get(node.id) ?? node.prompt ?? "";
    const tagged = taggedVideoByNode.get(node.id) ?? [];
    const wireCount = shot.graph
      ? promptRefWires(shot.graph, editVideoPromptNodeId(node.id)).length
      : tagged.length + (node.refIds ?? []).filter((id) => isVideoGenRef(id)).length;
    return {
      id: editVideoPromptNodeId(node.id),
      type: "editvideoprompt",
      position: promptPos,
      data: { nodeId: node.id, mode: node.mode, value, refHandles: Array.from({ length: wireCount }, (_, i) => `in-ref-${i}`), openHandleId: "in-ref-open", includeBrand: isBrandAttached(shot, { editvideoprompt: node.id }, value), onChange: stable.onEditVideoPromptChange, registerApplier: (a) => stable.registerApplier(editVideoApplierKey(node.id), a) },
      deletable: true,
    };
  }, [videoPromptValues, taggedVideoByNode, shot, stable]);

  /** One edit-video node's pair (mirrors the video node pair). */
  const editVideoPairFor = useCallback((node: GraphVideoNode, genPos: { x: number; y: number }, promptPos: { x: number; y: number }): GraphNode[] => [
    editVideoNodeFor(node, genPos),
    editVideoPromptNodeFor(node, promptPos),
  ], [editVideoNodeFor, editVideoPromptNodeFor]);

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
        savedDownsampleVideoRefs: node.downsampleVideoRefs,
        showDownsampleVideoRefs: !shot.graphSequence,
        items: (node.gens ?? []).map((g) => ({ url: graphMediaUrl(prod.meta.id, g.path), prompt: g.prompt, path: g.path, select: !!g.select, ...(g.draftJobId ? { draftJobId: g.draftJobId } : {}) })),
        selected: node.genIndex ?? 0,
        hasImageSource: !!node.source,
        busy: videoBusyNodeIds.includes(node.id),
        pending: pendingTarget?.kind === "videoNode" && (pendingTarget.nodeId ?? "vid0") === node.id,
        onFetch: stable.onFetchVideo,
        onGenerate: stable.onRunVideoGen,
        onSelect: stable.onSelectVideoGen,
        onCycle: stable.onCycleVideoGen,
        onUpgradeDraft: stable.onUpgradeDraft,
        onToggleSelect: stable.onToggleSelect,
        onDeleteGen: stable.onDeleteGen,
        onRefreshGen: stable.onRefreshGen,
        onSaveAsRef: stable.onSaveAsRef,
        onEditInSuite: stable.onEditInSuite,
        onModelOptions: stable.onModelOptions,
        onModelSchema: stable.onModelSchema,
        onSaveFields: stable.onSaveVideoFields,
        onZoom: stable.onZoom,
        label: videoNodeLabel(node.id),
        // The Higgsfield draft → 1080p upgrade is offered only off the sequence
        // canvas (whose submit is a separate handler) and only on a provider
        // that supports it (the node also requires the Seedance 2.5 model).
        draftUpgradeAvailable: draftUpgradeAvailable && !shot.graphSequence,
        ...(shot.graphSequence ? { title: "Sequence", sequenceTotal: sequenceTotalDuration(shot.graphSequence.segments) } : {}),
      },
      deletable: true,
    };
  }, [videoModels, videoBusyNodeIds, shot.pendingVideoGen, shot.graphSequence, taggedVideoByNode, stable, prod.meta.id, draftUpgradeAvailable]);

  /** Build one video node's prompt node. On a shot sequence's canvas the
   *  generate node's prompt node renders as the timed multi-shot Sequence
   *  prompt (Style + Visuals + one row per member shot). */
  const videoPromptNodeFor = useCallback((node: GraphVideoNode, promptPos: { x: number; y: number }): GraphNode => {
    const value = videoPromptValues.get(node.id) ?? node.prompt ?? "";
    const tagged = taggedVideoByNode.get(node.id) ?? [];
    // Sockets mirror the stored wires (tag wires + direct generation
    // wires in one positional list), so a wire always lands on a socket
    // that exists; before a graph exists the materialized picture
    // equals tags + gen sentinels.
    const wireCount = shot.graph
      ? promptRefWires(shot.graph, videoPromptNodeId(node.id)).length
      : tagged.length + (node.refIds ?? []).filter((id) => isVideoGenRef(id)).length;
    const refHandles = Array.from({ length: wireCount }, (_, i) => `in-ref-${i}`);
    const base = {
      id: videoPromptNodeId(node.id),
      position: promptPos,
      data: { nodeId: node.id, value, refHandles, openHandleId: "in-ref-open", includeBrand: isBrandAttached(shot, { videoprompt: node.id }, value), onChange: stable.onVideoPromptChange, registerApplier: (a: PromptDraftApplier | undefined) => stable.registerApplier(videoApplierKey(node.id), a) },
      deletable: true,
    };
    if (shot.graphSequence && !isVideoEditFamilyMode(node.mode) && node.id === "vid0") {
      const segments = normalizeSequenceSegments(shot.graphSequence.segments).map((s) => {
        const ref = references.find((r) => r.id === `seqframe:${s.shotId}`);
        return {
          shotId: s.shotId,
          durationSec: s.durationSec,
          prompt: s.prompt,
          label: ref?.name ?? "Shot",
          artwork: ref?.artwork ?? "",
          framePrompt: sequenceFramePrompts?.[s.shotId] ?? "",
        };
      });
      return {
        ...base,
        type: "sequenceprompt",
        data: {
          ...base.data,
          includeBrand: false,
          frames: segments.map((_, i) => ({ id: `in-frame-${i}`, label: "Shot" })),
          segments,
          onSegmentPrompt: (shotId: string, text: string) => {
            const segs = normalizeSequenceSegments(cb.current.graphSequence?.segments);
            cb.current.onSequenceSegments?.(segs.map((s) => (s.shotId === shotId ? { ...s, prompt: text } : s)));
          },
          onSegmentDuration: (shotId: string, durationSec: number) => {
            const segs = normalizeSequenceSegments(cb.current.graphSequence?.segments);
            cb.current.onSequenceSegments?.(segs.map((s) => (s.shotId === shotId ? { ...s, durationSec: Math.max(1, Math.round(durationSec) || 1) } : s)));
          },
          onRevert: (shotId: string) => cb.current.onRevertFramePrompt?.(shotId),
        },
      };
    }
    return { ...base, type: "videoprompt" };
  }, [videoPromptValues, taggedVideoByNode, shot, references, sequenceFramePrompts, stable]);

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
      sourcePath = (shot.graphImageGens ?? [])[shot.graphImageGenIndex ?? 0]?.path ?? resolveShotDisplay(shot).stillPath;
    } else if (src?.kind === "editgen") {
      const other = (shot.graphEditNodes ?? []).find((n) => n.id === src.nodeId);
      sourcePath = (other?.gens ?? [])[other?.genIndex ?? 0]?.path;
    } else {
      const display = resolveShotDisplay(shot);
      sourcePath = display.media === "still" ? display.path : display.stillPath;
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
          genKey: genKeys.edit(shot.id, editNode.id),
          onGenerate: stable.onRunEditGen,
          onSelect: (index: number) => stable.onSelectEditGen(editNode.id, index),
          onCycle: (dir: 1 | -1) => stable.onCycleEditGen(editNode.id, dir),
          onDeleteGen: stable.onDeleteGen,
        onRefreshGen: stable.onRefreshGen,
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
        data: { nodeId: editNode.id, value: promptValue, refHandles: Array.from({ length: shot.graph ? promptRefWires(shot.graph, editPromptNodeId(editNode.id)).length : tagged.length }, (_, i) => `in-ref-${i}`), openHandleId: "in-ref-open", includeBrand: isBrandAttached(shot, { editprompt: editNode.id }, promptValue), onChange: stable.onEditPromptChange, registerApplier: (a) => stable.registerApplier(`edit:${editNode.id}`, a) },
        deletable: true,
      },
    ];
  }, [shot.id, imageModels, prod.openArt?.resolution, prod.openArt?.quality, prod.meta.id, references, taggedEditByNode, editPromptValues, editBusyNodeIds, shot.graph, stable]);

  /** Place a tool dragged from the right panel at the drop point. Video lands
   *  as a gen+prompt pair, the in-betweener as a single node, and edit appends
   *  a new edit node to the shot's list. */
  const addTool = useCallback((kind: "video" | "edit" | "tween" | "editvideo" | "genjutsu-motion" | "genjutsu-swap" | "cameraGrid" | "upscale", pos: { x: number; y: number }) => {
    // A tool this host doesn't have refuses the drop; a provider gate explains.
    if (kind !== "video" && hiddenToolsSet.has(kind)) return;
    if (kind === "upscale" && upscaleUnavailable) { showHint(UPSCALE_UNAVAILABLE_HINT); return; }
    if (kind === "editvideo" && videoEditUnavailable) { showHint(VIDEO_EDIT_UNAVAILABLE_HINT); return; }
    if ((kind === "genjutsu-motion" || kind === "genjutsu-swap") && genjutsuUnavailable) { showHint(GENJUTSU_UNAVAILABLE_HINT); return; }
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
      saveLayout({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
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
      saveLayout({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
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
      graphField({ graphEditNodes: [...editNodes, { id: nodeId, prompt: "" }] });
      saveLayout({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
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
    if (kind === "editvideo" || kind === "genjutsu-motion" || kind === "genjutsu-swap") {
      const mode: "edit" | GenjutsuMode = kind === "editvideo" ? "edit" : kind;
      if (mode === "edit" ? videoEditUnavailable : genjutsuUnavailable) {
        showHint(mode === "edit" ? VIDEO_EDIT_UNAVAILABLE_HINT : GENJUTSU_UNAVAILABLE_HINT);
        return;
      }
      // Edit-family nodes are a list: dragging always appends a new one.
      // Genjutsu nodes start on their feature's standard model.
      const nodeId = mode === "edit" ? nextEditVideoNodeId(allVideoNodes) : nextGenjutsuNodeId(allVideoNodes, mode);
      const node: GraphVideoNode = { id: nodeId, mode, prompt: "", ...(mode !== "edit" ? { model: defaultGenjutsuModelId(mode) } : {}) };
      const pair = editVideoPairFor(node, genPos, promptPos);
      const next = [...nodesRef.current, ...pair];
      nodesRef.current = next;
      setNodes(next);
      graphField({ graphVideoNodes: [...(cb.current.graphVideoNodes ?? []), node] });
      saveLayout({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
      const gcur = cb.current.graph;
      if (gcur) {
        let g = addGraphNode(gcur, { id: editVideoGenNodeId(nodeId), kind: "editvideo", pos: { ...genPos } });
        g = addGraphNode(g, { id: editVideoPromptNodeId(nodeId), kind: "editvideoprompt", pos: { ...promptPos } });
        saveGraph(ensurePromptPipe(g, editVideoGenNodeId(nodeId)));
      }
      showHint(mode === "edit"
        ? "Edit-video node added — wire a source clip and write the edit in its prompt node."
        : mode === "genjutsu-motion"
          ? "Genjutsu Motion Transfer added — the source clip supplies the motion (wire one in, or the shot's clip is used). Add at least one image reference for the new character or scene, then transfer."
          : "Genjutsu Object Swap added — add at least one image reference of the replacement, name what to swap in the prompt (optional), then swap.");
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
      graphField({ graphVideoNodes: [...(cb.current.graphVideoNodes ?? []), node] });
      saveLayout({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
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
      saveLayout({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
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
  }, [editNodes, videoNodes, allVideoNodes, hasTweenTool, hasCameraGridTool, hasUpscaleTool, upscaleUnavailable, videoEditUnavailable, genjutsuUnavailable, showHint, editPair, videoPair, tweenNode, editVideoPairFor, cameraGridNode, upscaleNode]);

  // Wiring truth: the stored graph. The open-time normalized graph below is the
  // ONE derivation the canvas ever reads when the stored graph is absent (a
  // shot created mid-session, before the ensure effect persists it): connect/
  // detach handlers read the same object instead of re-materializing, so the
  // stored graph is the sole read path after that one normalization. Main's
  // load guarantee (`ensureShotGraphs`) means loaded projects never take this
  // branch at all.
  const fallbackGraph = useMemo(
    () => storedOrMaterializedGraph(shot, references),
    [shot, references]
  );
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

  // A sourced reference must have a canvas node or React Flow silently drops
  // its wires. Tagged refs always render, but a ref wired without a tag (the
  // output feed after a board drop, a generation source) may have no saved
  // layout position either, so neither node source above would place it —
  // the classic symptom is a video ref piped into Frame Output whose
  // connection line vanishes while the shot keeps playing the clip. Place
  // every sourced ref the wiring names. Deleting a ref node removes its
  // graph node + wires and marks removedRefIdsRef, so this never resurrects
  // a ref the user took off the canvas.
  useEffect(() => {
    if (!sourcedRefIds.size) return;
    const known = new Set(references.map((r) => r.id));
    const wired = [...sourcedRefIds].filter((id) => known.has(id) && !removedRefIdsRef.current.has(id));
    if (!wired.length) return;
    setPlacedRefIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of wired) if (!next.has(id)) { next.add(id); changed = true; }
      return changed ? next : prev;
    });
  }, [sourcedRefIds, references]);

  /** The Brand node is omitted while the brand identity is blank (no valid
   *  colors and no font): it contributes no clause, so the node is pure
   *  clutter. This is a RENDER filter only - never routed through
   *  nodeKindHidden, whose ensure effect would strip the brand node/edges
   *  from the stored graph for good. Add a color/font in Design and the
   *  node and its wires reappear, the stored graph untouched. */
  const brandEmpty = brandClauseText(prod.brand).trim() === "";
  const buildDerived = useCallback((): GraphNode[] => {
    const ORIGIN = { x: 0, y: 0 };
    const build = <T extends GraphNode>(node: T): T => ({ ...node, position: defaultPosition(node.id, availIds, taggedIds) });
    const visibleTagged = unionTagged.filter((t) => !(t.ref?.id && removedRefIdsRef.current.has(t.ref.id)));
    return [
      ...visibleTagged.map((t, i) => {
        const nodeId = `ref:${t.ref?.id ?? "missing-" + i}`;
        const collapsed = collapsedRef.current[nodeId] === true;
        // A locked ref is a host-supplied input (e.g. a sequence's member
        // frame): plain name, no rename, not deletable.
        const locked = t.ref?.locked === true;
        return build({
          id: nodeId,
          type: "ref" as const,
          position: ORIGIN,
          style: refSizeStyle(initialLayout, nodeId, collapsed),
          data: {
            name: t.name,
            artwork: t.ref?.artwork ?? "",
            media: t.ref?.media,
            mediaUrl: t.ref?.media && t.ref?.mediaPath ? graphMediaUrl(prod.meta.id, t.ref.mediaPath) : undefined,
            mediaPath: t.ref?.mediaPath,
            waveformColor: t.ref?.waveformColor,
            missing: !t.ref,
            tagged: true,
            refId: t.ref?.id,
            plainName: locked,
            collapsed,
            onToggleCollapse: stable.onToggleRefCollapsed,
            onRename: t.ref?.id && !locked ? stable.onRenameRef : undefined,
            onWaveformColor: t.ref?.id && !locked ? stable.onWaveformColorRef : undefined,
            onZoom: stable.onZoom,
          },
          deletable: !locked,
        });
      }),
      ...available.filter((r) => !removedRefIdsRef.current.has(r.id)).map((r) => {
        const nodeId = `ref:${r.id}`;
        const collapsed = collapsedRef.current[nodeId] === true;
        const locked = r.locked === true;
        return build({
          // Same id scheme as tagged refs, so toggling a tag never moves the
          // node — only its edge and column default change.
          id: nodeId,
          type: "ref" as const,
          position: ORIGIN,
          style: refSizeStyle(initialLayout, nodeId, collapsed),
          data: { name: r.name, artwork: r.artwork, media: r.media, mediaUrl: r.media && r.mediaPath ? graphMediaUrl(prod.meta.id, r.mediaPath) : undefined, mediaPath: r.mediaPath, waveformColor: r.waveformColor, tagged: false, sourced: sourcedRefIds.has(r.id), refId: r.id, plainName: locked, collapsed, onToggleCollapse: stable.onToggleRefCollapsed, onRename: locked ? undefined : stable.onRenameRef, onWaveformColor: locked ? undefined : stable.onWaveformColorRef, onZoom: stable.onZoom },
          deletable: !locked,
        });
      }),
      build({
        id: "style",
        type: "style" as const,
        position: ORIGIN,
        data: { styles, value: styleValue, onChange: stable.onStyleChange },
        deletable: false,
      }),
      ...(nodeKindHidden("brand") || brandEmpty ? [] : [build({
        id: "brand",
        type: "brand" as const,
        position: ORIGIN,
        data: {},
        deletable: false,
      })]),
      ...(hiddenToolsSet.has("imagegen") ? [] : [build({
        id: "composer",
        type: "composer" as const,
        position: ORIGIN,
        data: { value: prompt, refHandles: promptRefWires(wiringGraph, "composer").map((_, i) => `in-ref-${i}`), openHandleId: "in-ref-open", includeBrand: isBrandAttached(shot, "composer", prompt), magicActive, onChange: stable.onPromptChange, registerApplier: (a) => stable.registerApplier("composer", a) },
        deletable: false,
      })]),
      build({
        id: "output",
        type: "frame" as const,
        position: ORIGIN,
        // Resizable: the saved size restores the user's last expansion, else
        // the default width (the CSS min keeps the blank state legible).
        style: sizeStyle(initialLayout, "output", 300),
        data: (() => {
          // The output mirrors ONLY its pipe: the shared resolver names the
          // bound node's selected take (or the piped reference's own media).
          // Nothing is piped in yet → blank + hint.
          const out = resolveSelectedOutput(shot);
          if (out.source === "ref" && shot.graphOutputRefId) {
            const ref = references.find((r) => r.id === shot.graphOutputRefId);
            if (ref?.media === "video" && ref.mediaPath) return { shotNumber: shot.number, previewUrl: graphMediaUrl(prod.meta.id, ref.mediaPath), previewKind: "video" as const, bound: true };
            if (ref?.artwork) return { shotNumber: shot.number, previewUrl: ref.artwork, previewKind: "image" as const, bound: true };
          } else if (out.path) {
            return { shotNumber: shot.number, previewUrl: graphMediaUrl(prod.meta.id, out.path), previewKind: out.media === "clip" ? "video" as const : "image" as const, bound: true };
          }
          return { shotNumber: shot.number, previewUrl: null, previewKind: null, bound: false };
        })(),
        deletable: false,
      }),
      ...(hiddenToolsSet.has("imagegen") ? [] : [build({
        id: "imagegen",
        type: "imagegen" as const,
        position: ORIGIN,
        style: fixedWidth(300),
        data: {
          models: imageModels.filter((m) => modelOnSurface(m, "image:generate")),
          defaultModel: prod.openArt?.model ?? "auto",
          defaultResolution: prod.openArt?.resolution ?? "1k",
          savedModel: shot.graphImageModel,
          savedResolution: shot.graphImageResolution,
          productionQuality: prod.openArt?.quality,
          savedParams: shot.graphImageParams,
          items: (shot.graphImageGens ?? []).map((g) => ({ url: graphMediaUrl(prod.meta.id, g.path), prompt: g.prompt, path: g.path })),
          selected: shot.graphImageGenIndex ?? 0,
          busy: imageGenBusy === true,
          genKey: genKeys.image(shot.id),
          onGenerate: stable.onRunImageGen,
          onSelect: stable.onSelectImageGen,
          onCycle: stable.onCycleImageGen,
          onDeleteGen: stable.onDeleteGen,
        onRefreshGen: stable.onRefreshGen,
          onSaveAsRef: stable.onSaveAsRef,
          onEditInSuite: stable.onEditInSuite,
          onModelSchema: stable.onModelSchema,
          onSaveFields: stable.onSaveImageFields,
          onZoom: stable.onZoom,
        },
        deletable: false,
      })]),
      ...videoNodes.flatMap((n) => videoPair(n, ORIGIN, ORIGIN).map((node) => build(node))),
      ...(nodeKindHidden("editvideo") ? [] : editFamilyNodes.flatMap((n) => editVideoPairFor(n, ORIGIN, ORIGIN).map((node) => build(node)))),
      ...(nodeKindHidden("edit") ? [] : editNodes.flatMap((n) => editPair(n, ORIGIN, ORIGIN).map((node) => build(node)))),
      ...(hasTweenTool && !nodeKindHidden("tween") ? [build(tweenNode(ORIGIN))] : []),
      ...(hasCameraGridTool && !nodeKindHidden("cameraGrid") ? [build(cameraGridNode(ORIGIN))] : []),
      ...(hasUpscaleTool && !nodeKindHidden("upscale") ? [build(upscaleNode(ORIGIN))] : []),
    ];
  }, [unionTagged, tagged, taggedVideo, available, availIds, taggedIds, sourcedRefIds, stable, styles, styleValue, includeBrand, magicActive, prompt, videoPromptValue, videoPromptValues, videoNodes, taggedVideoByNode, thumbnail, editNodes, editPromptValues, taggedEditByNode, shot.number, shot.artworkHistory, prod.meta.id, prod.openArt?.model, prod.openArt?.resolution, prod.openArt?.quality, shot.graphImageGens, shot.graphImageGenIndex, shot.graphImageParams, shot.graphVideoNodes, shot.pendingVideoGen, shot.graphTweenRefIds, shot.graphTweenBlocks, shot.graphTweenModel, shot.graphTweenResolution, shot.graphTweenOutput, shot.graphTweenReencoded, shot.graphOutputSource, shot.graphOutputRefId, shot.graphOutputEditNodeId, shot.graphUpscale, imageModels, videoModels, references, hasVideoTool, hasTweenTool, hasEditVideoTool, hasCameraGridTool, hasUpscaleTool, videoPair, editPair, tweenNode, editVideoPairFor, cameraGridNode, upscaleNode, allVideoNodes, editFamilyNodes, imageGenBusy, videoBusyNodeIds, editVideoBusyNodeIds, editBusyNodeIds, initialLayout, initialLayout?.sizes?.output?.width, initialLayout?.sizes?.output?.height, mediaRevTick, brandEmpty, wiringGraph]);

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
      // The per-type rules live in `shared/graph/reconcile.ts` — one
      // registration per canvas type, enforced by the completeness test
      // (a new node type must ship its equality rule or the test fails).
      let equal = d.type === old.type && nodeDataEqual(d.type, a, b);
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
    const g = brandEmpty ? { ...wiringGraph, edges: wiringGraph.edges.filter((e) => e.from.node !== "brand") } : wiringGraph;
    return graphEdgesToFlow(g, {
      selected: selectedEdges,
      colors: SOCKET_COLORS,
      waypoints: initialLayout?.waypoints,
      refMediaByNode: Object.fromEntries(references.map((r) => [`ref:${r.id}`, refOutputMedia(r)])),
    });
  }, [wiringGraph, selectedEdges, initialLayout?.waypoints, referencesSig, brandEmpty]);

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
    let fresh = storedOrMaterializedGraph(shot, references);
    if (styleValue && !styleEdgePresent(fresh, "composer")) {
      fresh = normalizeGraph(setStyleEdge(fresh, "composer", true)).graph;
    }
    // Heal a lost output wire: the flat pipe fields still name a piped
    // reference (so the shot keeps showing its media) but an older or raced
    // save dropped e-ref-out from the stored graph. syncOutputEdge restores
    // the wire (and the ref's graph node) and is identity when already wired.
    if (shot.graphOutputSource === "ref" && shot.graphOutputRefId && fresh.nodes.some((n) => n.id === "output")) {
      fresh = syncOutputEdge(fresh, `ref:${shot.graphOutputRefId}`, "e-ref-out");
    }
    // Heal reference wires from the stored prompt texts: tags typed
    // outside the graph (side panel) or left drifted by older saves
    // rewire here, and wires whose tags were deleted elsewhere drop.
    // Settled prompts reconcile to themselves, so this saves nothing.
    {
      const byName = new Map(references.map((r) => [(r.name ?? "").toLowerCase(), r.id]));
      const heal = (target: string, text: string | undefined): void => {
        if (!text?.trim()) return;
        const ids = refTagNames(text).flatMap((n) => {
          const id = byName.get(n.toLowerCase());
          return id ? [id] : [];
        });
        fresh = reconcilePromptRefEdges(fresh, target, ids);
      };
      if (!magicActive) heal("composer", shot.prompt);
      for (const n of videoNodesFor(shot)) heal(isVideoEditFamilyMode(n.mode) ? editVideoPromptNodeId(n.id) : videoPromptNodeId(n.id), n.prompt);
      for (const n of shot.graphEditNodes ?? []) heal(editPromptNodeId(n.id), n.prompt);
    }
    // Strip nodes this host doesn't have (a sequence canvas hides the image
    // generation pair and the shot-only generators) so a stored graph never
    // carries them; their edges go with them.
    if (hiddenToolsSet.size) {
      const hiddenIds = new Set(fresh.nodes.filter((n) => nodeKindHidden(n.kind)).map((n) => n.id));
      if (hiddenIds.size) {
        fresh.nodes = fresh.nodes.filter((n) => !hiddenIds.has(n.id));
        fresh.edges = fresh.edges.filter((e) => !hiddenIds.has(e.from.node) && !hiddenIds.has(e.to.node));
      }
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
    if (JSON.stringify(next) !== JSON.stringify(g)) graphField({ graph: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [magicActive, prompt, shot.graph, magicRefIds]);

  const onNodesChange = useCallback<OnNodesChange<GraphNode>>(async (changes) => {
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

    // Video/edit/tween/camera-grid/upscale nodes delete as a PAIR (gen +
    // prompt where they have one) and return to the right panel. A node that
    // still holds data (stored generations, pipes, prompt text) is deletable
    // too — but asks first, naming exactly what will be discarded, instead of
    // silently refusing. Edit nodes own a per-node pair; deleting either
    // removes the node and cleans its pipes.
    const removedVidIds = new Set<string>();
    const removedVidEditIds = new Set<string>();
    if (removed.length > 0) {
      const risky = removed.filter((c) => toolNodeDeleteSummary(c.id, shot) !== "");
      if (risky.length > 0 && !(await confirmDestructive({ title: "Delete these nodes?", body: toolDeleteWarning(risky.map((c) => c.id), shot), confirmLabel: "Delete" }))) {
        const keep = new Set(risky.map((c) => c.id));
        removed = removed.filter((c) => !keep.has(c.id));
        changes = changes.filter((c) => c.type !== "remove" || !keep.has(c.id));
      }
    }
    for (const c of removed) {
      const evId = parseEditVideoGenNode(c.id) ?? parseEditVideoPromptNode(c.id);
      const vidId = parseVideoGenNode(c.id) ?? parseVideoPromptNode(c.id);
      if (evId) removedVidEditIds.add(evId);
      else if (vidId) removedVidIds.add(vidId);
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
    for (const evId of removedVidEditIds) {
      toolNodeIds.add(editVideoGenNodeId(evId));
      toolNodeIds.add(editVideoPromptNodeId(evId));
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
      graphField({ graphCameraGrid: undefined });
    }
    if (upscaleRemoved) {
      setPlacedTools((prev) => { const n = new Set(prev); n.delete("upscale"); return n; });
      // Drop the node's wiring/picks and the output feed so it doesn't
      // resurrect on the next build.
      graphField({ graphUpscale: undefined, ...(cb.current.graphOutputSource === "upscale" ? { graphOutputSource: undefined } : {}) });
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
      graphField(patch);
    }
    if (removedVidIds.size > 0 || removedVidEditIds.size > 0) {
      // Drop the removed video nodes (generate and/or edit); clear the output
      // feed if it pointed at one, and prune any node whose source cited it.
      const gone = new Set([...removedVidIds, ...removedVidEditIds]);
      const kept = (cb.current.graphVideoNodes ?? [])
        .filter((n) => !gone.has(n.id))
        .map((n) => (n.source?.kind === "video" && gone.has(n.source.nodeId) ? { ...n, source: undefined } : n));
      const patch: Partial<ProductionShot> = { graphVideoNodes: kept };
      if (cb.current.graphOutputSource === "videogen" && gone.has(cb.current.graphOutputVideoNodeId ?? "")) {
        patch.graphOutputSource = undefined;
        patch.graphOutputVideoNodeId = undefined;
      }
      graphField(patch);
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
          const key = isVideoEditFamilyMode(n.mode) ? editVideoApplierKey(n.id) : videoApplierKey(n.id);
          const fresh = appliers.current[key]?.get() ?? cb.current.videoPromptValues?.get(n.id) ?? n.prompt ?? "";
          const needsStrip = refTagNames(fresh).some((nm) => nm.toLowerCase() === entry.name.toLowerCase());
          if (needsStrip) applyDraftEdit(key, strip);
          const source = n.source?.kind === "ref" && n.source.refId === refId ? undefined : n.source;
          const refIds = n.refIds?.includes(refId) ? n.refIds.filter((id) => id !== refId) : n.refIds;
          const prompt = needsStrip ? strip(fresh) : n.prompt;
          return prompt !== n.prompt || source !== n.source || refIds !== n.refIds ? { ...n, prompt, source, refIds } : n;
        });
        if (vidNodesNext.some((n, i) => n !== (cb.current.graphVideoNodes ?? [])[i])) {
          graphField({ graphVideoNodes: vidNodesNext });
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
          graphField({ graphEditNodes: editNodesNext });
        }
        if (cb.current.graphOutputSource === "ref" && cb.current.graphOutputRefId === refId) cb.current.onUnpipeOutput();
        if (cb.current.graphVideoSourceRefId === refId) graphField({ graphVideoSourceRefId: undefined });
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
      // so no pruning is needed for deleted references. Deleted nodes are
      // named explicitly (`remove`) — a per-key merge can't express a delete
      // by absence, and a stale snapshot must never drop a live node.
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
      saveLayout({
        positions: Object.fromEntries(final.map((n) => [n.id, n.position])),
        ...(Object.keys(sizes).length > 0 ? { sizes } : {}),
        ...(removed.length > 0 ? { remove: [...new Set([...removed.map((c) => c.id), ...toolNodeIds])] } : {}),
      });
    }
  }, [shot, videoGenActive, tweenActive, cameraGridActive, showHint, flushPosChanges]);

  // An explicit delete (the node ×, or any programmatic removal) funnels through
  // the SAME engine as the Delete key, so the "does it hold data?" confirm lives
  // in exactly one place. A ref indirection avoids a circular dependency on the
  // useCallback above.
  const nodesChangeRef = useRef<OnNodesChange<GraphNode>>(() => {});
  nodesChangeRef.current = onNodesChange;
  const requestDeleteNode = useCallback((id: string) => {
    nodesChangeRef.current([{ type: "remove", id }]);
  }, []);

  // ---- Stored-graph writes (step 03) ----
  // Every canvas mutation updates shot.graph (the wiring truth) alongside the
  // legacy flag/text writes below, which continue as the generation projection
  // (LEGACY-PROJECTION — generation still consumes flags/text until steps
  // 04–05; step 10 deletes them). Both derive from the same event.
  const saveGraph = (g: Graph): void => {
    const prev = cb.current.graph;
    graphField({ graph: g });
    // Deleting an edge (or a node, which deletes its edges) deletes its
    // waypoints with it — they are layout data keyed by edge id.
    if (prev) {
      const nextIds = new Set(g.edges.map((e) => e.id));
      const gone = prev.edges.filter((e) => !nextIds.has(e.id) && (cb.current.initialLayout?.waypoints?.[e.id]?.length ?? 0) > 0);
      if (gone.length) {
        saveLayoutRef.current({ waypoints: Object.fromEntries(gone.map((e) => [e.id, [] as { x: number; y: number }[]])) });
      }
    }
  };
  /**
   * Keep a prompt node's reference wires in sync with its committed text:
   * the text's ordered @[name] tags become the ordered ref wires (a
   * deleted tag drops its wire, a typed tag grows one, a chip drag
   * reorders them — the converse of wire edits rewriting tags). Wired
   * into the four prompt commit wrappers with the committed text; a text
   * already in sync saves nothing (identity result).
   */
  const reconcileTagsToEdges = (target: string, text: string): void => {
    const g = cb.current.graph;
    if (!g) return;
    const byName = new Map(cb.current.references.map((r) => [(r.name ?? "").toLowerCase(), r.id]));
    const tagRefIds = refTagNames(text).flatMap((n) => {
      const id = byName.get(n.toLowerCase());
      return id ? [id] : [];
    });
    const next = reconcilePromptRefEdges(g, target, tagRefIds);
    if (next !== g) saveGraph(next);
  };
  /**
   * The ONE path for prompt reference-wire mutations (connect, swap onto
   * an occupied socket, detach, edge Delete — from references and from
   * generation nodes alike): the caller states the prompt node's new
   * ordered wire sources, and the graph edges, the prompt's @[name]
   * tags, and (for video prompts) the direct-generation `refIds`
   * sentinels are all rebuilt from that single list, so a connection and
   * its tag can never diverge or reorder independently.
   */
  const applyPromptWireChange = (targetRaw: string, nextSources: readonly string[]): void => {
    const target = canonicalNodeId(targetRaw);
    const cur = cb.current.graph ?? fallbackGraph;
    const nextGraph = withPromptRefWires(cur, target, nextSources);
    if (nextGraph !== cur) saveGraph(nextGraph);
    const wires = promptRefWires(nextGraph, target);
    const byId = new Map(cb.current.references.map((r) => [r.id, r.name]));
    const names = wires.flatMap((s) => {
      const name = s.startsWith("ref:") ? byId.get(s.slice(4)) : undefined;
      return name ? [name] : [];
    });
    const knownNames = cb.current.references.map((r) => r.name);
    const syncText = (t: string) => syncRefTags(t, names, knownNames);
    const vpId = parseVideoPromptNode(target);
    const evpId = vpId ? null : parseEditVideoPromptNode(target);
    const videoNodeId = vpId ?? evpId;
    if (target === "composer") {
      if (!applyDraftEdit("composer", syncText)) cb.current.onPromptChange(syncText(cb.current.prompt));
    } else if (videoNodeId) {
      const key = vpId ? videoApplierKey(vpId) : editVideoApplierKey(evpId!);
      const curVal = appliers.current[key]?.get() ?? cb.current.videoPromptValues?.get(videoNodeId) ?? "";
      if (!applyDraftEdit(key, syncText)) patchVideoNode(videoNodeId, { prompt: stripSharedSections(syncText(curVal)) });
      // Direct generation wires ride the node's refIds as sentinels (the
      // source node id IS the sentinel); plain ref entries are preserved.
      const node = (cb.current.graphVideoNodes ?? []).find((n) => n.id === videoNodeId);
      if (node) {
        const plain = (node.refIds ?? []).filter((id) => !isVideoGenRef(id));
        const refIds = [...plain, ...wires.filter((s) => !s.startsWith("ref:"))];
        const prev = node.refIds ?? [];
        if (refIds.length !== prev.length || refIds.some((id, i) => id !== prev[i])) {
          patchVideoNode(videoNodeId, { refIds });
        }
      }
    } else {
      const editId = target === "editprompt" ? "edit0" : target.slice(EDITPROMPT_NODE_PREFIX.length);
      const curVal = appliers.current[`edit:${editId}`]?.get() ?? cb.current.editPromptValues.get(editId) ?? "";
      if (!applyDraftEdit(`edit:${editId}`, syncText)) cb.current.onEditNodePrompt(editId, syncText(curVal));
    }
  };
  /** Connect one source into a prompt node's reference socket (the open
   *  socket appends/heals, a numbered socket replaces that slot). */
  const connectPromptWire = (target: string, handle: string, source: string): void => {
    const cur = cb.current.graph ?? fallbackGraph;
    const slot = /^in-ref-(\d+)$/.exec(handle);
    const next = promptWiresAfterConnect(promptRefWires(cur, target), canonicalNodeId(source), slot ? Number(slot[1]) : null);
    applyPromptWireChange(target, next);
  };
  /** Disconnect one source from a prompt node's reference sockets. */
  const disconnectPromptWire = (target: string, source: string): void => {
    const cur = cb.current.graph ?? fallbackGraph;
    const src = canonicalNodeId(source);
    applyPromptWireChange(target, promptRefWires(cur, target).filter((w) => w !== src));
  };
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
            // Prompt reference wires are removed through the single-list
            // sync below (their tags must drop with them), not edge-only.
            const hit = cur.edges.find((e) => e.id === c.id);
            if (!(hit && REF_SOCKET_RE.test(hit.to.port) && isPromptNodeId(hit.to.node))) {
              gg = removeGraphEdge(cur, c.id);
            }
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
        // Edit-video source wire: select + Delete unbinds that node's source.
        const evEdge = /^e-(?:vid|ref)-ev(?::(.+))?$/.exec(c.id);
        if (evEdge) {
          const nodeId = evEdge[1] ?? "ev0";
          graphField({ graphVideoNodes: (cb.current.graphVideoNodes ?? []).map((n) => (n.id === nodeId ? { ...n, source: undefined } : n)) });
          setSelectedEdges(new Set());
          continue;
        }
        // Composer brand plug: select + Delete drops it and disables the side
        // panel's shot-level brand toggle mirror.
        if (c.id === "e-brand") { cb.current.onToggleBrand(false); setSelectedEdges(new Set()); continue; }
        // Composer style plug: select + Delete drops it and mirrors to None
        // so the sidepanel dropdown reflects the unwired state.
        if (c.id === "e-style") { graphField({ graphStyleConnected: false, styleNone: true }); setSelectedEdges(new Set()); continue; }
        // Reference edges are deletable via keyboard (select+Delete) —
        // ids are `e-<source>-<target>-<idx>` for the prompt nodes.
        const m = /^e-(.+)-(composer|videoprompt(?::[^:]+)?|editvideoprompt(?::[^:]+)?|editprompt(?::[^:]+)?)-(\d+)$/.exec(c.id);
        if (m) {
          const [, genSource, targetKind] = m;
          const vpId = parseVideoPromptNode(targetKind);
          const evpId = parseEditVideoPromptNode(targetKind);
          const editId = targetKind === "editprompt" ? "edit0" : targetKind.startsWith(EDITPROMPT_NODE_PREFIX) ? targetKind.slice(EDITPROMPT_NODE_PREFIX.length) : null;
          const targetNode = targetKind === "composer" ? "composer"
            : vpId ? videoPromptNodeId(vpId)
            : evpId ? editVideoPromptNodeId(evpId)
            : editId ? editPromptNodeId(editId)
            : null;
          // Identity, never socket index: the wire's source — from the
          // stored edge when found (a prior removal in this same change
          // set may have renumbered its id, so fall back to the id's own
          // source segment) — leaves the list, and its tag (or video
          // sentinel) goes with it via the single-list sync.
          const srcEdge = cb.current.graph?.edges.find((e) => e.id === c.id);
          const source = srcEdge?.from.node ?? genSource;
          if (targetNode && source) disconnectPromptWire(targetNode, source);
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
  }, [tagged, taggedVideo, taggedEditByNode, prompt, onPromptChange]);

  /**
   * Complete a generation-output → video/edit-video-prompt-reference-socket
   * connection WITHOUT saving a reference: wire the generation node directly
   * into the socket and record its sentinel on the node's `refIds` (resolved
   * to the selected take at submit time). No `CustomRef`, no prompt tag, no
   * shelf tile — the frame rides as an extra visual reference.
   * Reads everything mutable through refs (synchronous, no await).
   */
  const attachGenerationDirect = (target: string, handle: string, source: string) => {
    const vpId = parseVideoPromptNode(target);
    const nodeId = vpId ?? parseEditVideoPromptNode(target);
    if (!nodeId) return;
    const sentinel = source === "imagegen" ? TWEEN_KEY_IMGGEN : source;
    if (!isVideoGenRef(sentinel)) return;
    // One-list sync: a displaced wire loses its substance with its slot —
    // a ref's tag is rewritten away, a generation's sentinel drops from
    // refIds — because both are rebuilt from the new wire list.
    connectPromptWire(target, handle, source);
    const label = source === "imagegen" ? "Image node frame" : `Edit node ${source.slice("editgen:".length)}`;
    showHint(`Wired ${label} directly into the prompt — no reference saved.`);
  };

  /**
   * Complete a generation-output → prompt-reference-socket connection: save
   * the take as a reference (main copies the file), place its ref node beside
   * the prompt, then wire the edge and tag the prompt at the target socket.
   * Reads everything mutable through refs so it stays correct across the await.
   */
  const attachGenerationAsReference = async (target: string, handle: string, rel: string, name?: string) => {
    const saved = await cb.current.onSaveGenerationAsReference(rel, name);
    if (!saved) return;
    const refNodeId = `ref:${saved.id}`;
    // Wire + tag through the single-list sync (it also adds the new ref's
    // graph node, so the wire can never dangle and vanish on reopen).
    connectPromptWire(target, handle, refNodeId);
    // Place the new ref node beside its prompt node and persist the position.
    const anchor = nodesRef.current.find((n) => n.id === target)?.position;
    const posMap = Object.fromEntries(nodesRef.current.map((n) => [n.id, n.position]));
    posMap[refNodeId] = anchor ? { x: anchor.x - 260, y: anchor.y + 48 } : { x: 40, y: 40 };
    saveLayout({ positions: posMap });
    showHint(`Saved the take as @[${saved.name}] and wired it into the prompt.`);
  };

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return;
    // Dragging a generation node's output onto a prompt's reference socket.
    // Video and edit-video prompts wire directly (no saved reference — the
    // take resolves at submit time from the node's refIds); the composer and
    // edit-image prompts save the take as a reference first (main copies the
    // file asynchronously, then the wire + tag land), since their prompts
    // cite references by @[name] tag.
    const genRel = selectedGenerationRel(shot, canonicalNodeId(conn.source));
    if (genRel && isPromptNodeId(canonicalNodeId(conn.target)) && isRefSocketHandle(conn.targetHandle)) {
      const target = canonicalNodeId(conn.target);
      if (parseVideoPromptNode(target) || parseEditVideoPromptNode(target)) {
        attachGenerationDirect(target, conn.targetHandle ?? "", canonicalNodeId(conn.source));
        return;
      }
      void attachGenerationAsReference(target, conn.targetHandle ?? "", genRel, generationNodeRefName(canonicalNodeId(conn.source)));
      return;
    }
    // Reference → prompt reference socket: the single-list sync path
    // (wires and tags rebuilt together in applyPromptWireChange) — never
    // the generic stored-edge write plus a hand-mirrored tag edit.
    if (conn.source.startsWith("ref:") && isPromptNodeId(canonicalNodeId(conn.target)) && isRefSocketHandle(conn.targetHandle)) {
      connectPromptWire(canonicalNodeId(conn.target), conn.targetHandle ?? "", canonicalNodeId(conn.source));
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
      const cur = cb.current.graph ?? fallbackGraph;
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
      graphField({ graphEditNodes: (cb.current.graphEditNodes ?? []).map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) });
    };
    const srcEditId = parseEditGenNode(conn.source);
    const tgtEditId = parseEditGenNode(conn.target);
    // Edit-video node: `in-video` = the source clip (a video node's output —
    // generate or edit — or a video reference). References ride the edit-video
    // prompt node's sockets, like the video node.
    const evTargetId = parseEditVideoGenNode(conn.target);
    if (evTargetId) {
      if (conn.targetHandle === "in-video") {
        const srcVidId = parseVideoGenNode(conn.source);
        const srcEvId = parseEditVideoGenNode(conn.source);
        if (srcVidId || srcEvId) { patchVideoNode(evTargetId, { source: { kind: "video", nodeId: srcVidId ?? srcEvId! } }); return; }
        const rid = /^ref:(.+)$/.exec(conn.source)?.[1];
        const ref = rid ? references.find((r) => r.id === rid) : undefined;
        if (ref && ref.media === "video") { patchVideoNode(evTargetId, { source: { kind: "ref", refId: rid! } }); return; }
      }
      return;
    }
    // Camera-grid node: the source socket takes one image (image node / edit
    // node / reference); the grid-image socket takes an already-made sheet to
    // cut up (manual fallback); the style socket plugs the shot's style into
    // the generated prompt; the reference sockets take references
    // positionally. (The stored in-style/in-image/in-grid edge is written by
    // the gating block above; the positional reference edges are rebuilt from
    // refIds.)
    if (conn.target === "cameraGrid") {
      const handle = conn.targetHandle ?? "";
      if (handle === "in-style") { stable.onCameraGridSave({ styleConnected: true }); return; }
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
        const g = cb.current.graph ?? fallbackGraph;
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
      const srcEv = parseEditVideoGenNode(conn.source);
      if (srcVid || srcEv) { if (conn.target === "output") { cb.current.onPipeVideoToOutput(srcVid ?? srcEv!); return; } }
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
    const evpTargetId = parseEditVideoPromptNode(conn.target);
    const isEditVideoPrompt = evpTargetId !== null;
    const editPromptId = conn.target === "editprompt" ? "edit0" : conn.target.startsWith(EDITPROMPT_NODE_PREFIX) ? conn.target.slice(EDITPROMPT_NODE_PREFIX.length) : null;
    if (isComposer || isVideo || isEditVideoPrompt || editPromptId) {
      if (conn.source === "style") {
        // The edge (written above) is the plug; no paragraph is pasted. The
        // legacy flag still mirrors it for graph-less rebuilds (projection).
        // The sidepanel selection mirrors the wire: plugging the composer wire
        // re-activates a style (clears None so the dropdown shows the style).
        if (isComposer) graphField({ graphStyleConnected: true, styleNone: false });
        else if (isVideo) patchVideoNode(tgtVideoPromptId!, { styleConnected: true });
        else if (isEditVideoPrompt) patchVideoNode(evpTargetId!, { styleConnected: true });
        else patchEditNode(editPromptId!, { styleConnected: true });
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
      // Reference sources take the single-list sync path at the top of
      // onConnect (connectPromptWire) and never reach here.
      return;
    }
  }, [references, prompt, onPromptChange, shot]);

  /** Reference→open-input, style→style, brand→brand, imagegen→video/edit/output
   *  (all at once allowed), videogen/tween→output, ref→output
   *  (image/video refs only), ref→edit-node source (image refs only),
   *  ref→tween keyframe sockets (image refs only, 5 max), plus fixed
   *  prompt plugs (any prompt node into any generator's prompt input) —
   *  everything else is rejected. Prompt nodes (composer,
   *  videoprompt, editprompt) each accept Style / Reference / Brand exactly alike. */
  const isValidConnection = useCallback((c: Connection | Edge) => {
    const source = c.source ?? "";
    // A generation node's output may be dropped onto any prompt reference
    // socket: video prompts wire directly (no saved reference), every other
    // prompt saves the selected take as a reference, then wires it in.
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
    const sourceEv = parseEditVideoGenNode(source);
    const targetEv = parseEditVideoGenNode(c.target ?? "");
    const sourceVideoPrompt = parseVideoPromptNode(source);
    const targetVideoPrompt = parseVideoPromptNode(c.target ?? "");
    const sourceEvPrompt = parseEditVideoPromptNode(source);
    const targetEvPrompt = parseEditVideoPromptNode(c.target ?? "");
    // Any prompt node may plug into any generator's prompt input (the
    // paired prompt is just the default wire generation follows).
    const srcEditPromptId = source === "editprompt" ? "edit0" : source.startsWith(EDITPROMPT_NODE_PREFIX) ? source.slice(EDITPROMPT_NODE_PREFIX.length) : null;
    if (source === "composer" || sourceVideoPrompt || sourceEvPrompt || srcEditPromptId) {
      return c.targetHandle === "in-prompt" && (c.target === "imagegen" || targetVid !== null || targetEv !== null || parseEditGenNode(c.target ?? "") !== null);
    }
    const srcEditId = parseEditGenNode(source);
    const tgtEditId = parseEditGenNode(c.target ?? "");
    // Edit-video node: the source socket takes a video node clip (generate or
    // edit) or a video reference. References ride the edit-video prompt node's
    // sockets.
    if (targetEv) {
      if (c.targetHandle === "in-video") {
        if (sourceVid || sourceEv) return targetEv !== sourceEv;
        const rid = /^ref:(.+)$/.exec(source)?.[1];
        const ref = rid ? references.find((r) => r.id === rid) : undefined;
        return !!ref && ref.media === "video";
      }
      return false;
    }
    // Camera-grid node: one image source (image node / edit node / reference),
    // a style plug, plus positional reference sockets (image references only).
    if (c.target === "cameraGrid") {
      const handle = c.targetHandle ?? "";
      if (handle === "in-style") return source === "style";
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
    void editPromptId; // prompt sources return above (any prompt feeds any prompt input)
    if (source === "imagegen") {
      if (targetVid) return c.targetHandle === "in-image";
      if (tgtEditId) return c.targetHandle === "in-image";
      if (c.target === "output") return c.targetHandle === "in-out";
      if (c.target === "tween") return tweenSlotOk(TWEEN_KEY_IMGGEN);
      return false;
    }
    if (sourceVid) return c.target === "output" && c.targetHandle === "in-out";
    if (sourceEv) {
      if (targetEv && c.targetHandle === "in-video") return targetEv !== sourceEv;
      return c.target === "output" && c.targetHandle === "in-out";
    }
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
      if (c.target === "composer" || targetVideoPrompt || targetEvPrompt || targetEditPrompt) {
        // The open socket appends; dropping onto an occupied reference socket
        // replaces the reference in that slot (same type — an image/any ref).
        return (c.targetHandle === "in-ref-open" || /^in-ref-\d+$/.test(c.targetHandle ?? "")) && !!ref;
      }
      return false;
    }
    if (c.target === "composer" || targetVideoPrompt || targetEvPrompt || targetEditPrompt) {
      if (source === "style") return c.targetHandle === "in-style";
      if (source === "brand") return c.targetHandle === "in-brand";
      return false;
    }
    return false;
  }, [references, shot.graphTweenRefIds, shot]);

  /** Popup offered when an image/video output is dragged into empty canvas. */
  const [dropMenu, setDropMenu] = useState<{ x: number; y: number; pos: { x: number; y: number }; source: string; sourceHandle: string | null; media: "image" | "video" } | null>(null);
  const addAndConnect = (choice: "edit" | "editvideo" | "output", m: NonNullable<typeof dropMenu>) => {
    captureHistory(true);
    if (choice === "output") {
      onConnect({ source: m.source, sourceHandle: m.sourceHandle, target: "output", targetHandle: "in-out" });
      return;
    }
    if (choice === "edit") {
      const id = nextEditNodeId(editNodes);
      addTool("edit", m.pos);
      // Let the new node render so onConnect sees the updated graph.
      window.setTimeout(() => onConnectRef.current({ source: m.source, sourceHandle: m.sourceHandle, target: editGenNodeId(id), targetHandle: "in-image" }), 60);
      return;
    }
    const id = nextEditVideoNodeId(allVideoNodes);
    addTool("editvideo", m.pos);
    window.setTimeout(() => onConnectRef.current({ source: m.source, sourceHandle: m.sourceHandle, target: editVideoGenNodeId(id), targetHandle: "in-video" }), 60);
  };
  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;

  // A wired source input shows a pinned `@[source]` tag first in the edit
  // node's prompt; it can't be removed by hand and goes when the source is
  // disconnected. Reconciled on every change so connect, disconnect, source
  // deletion and hand edits all converge.
  useEffect(() => {
    if (readOnly) return;
    for (const n of editNodes) {
      const cur = appliers.current[`edit:${n.id}`]?.get() ?? editPromptValues.get(n.id) ?? n.prompt ?? "";
      const fixed = enforceSourceTag(cur, !!n.source);
      if (fixed === cur) continue;
      if (!applyDraftEdit(`edit:${n.id}`, (t) => enforceSourceTag(t, !!n.source))) cb.current.onEditNodePrompt(n.id, fixed);
    }
    // Video, Edit video and Genjutsu nodes: same rule on their source socket.
    for (const n of allVideoNodes) {
      const key = isVideoEditFamilyMode(n.mode) ? editVideoApplierKey(n.id) : videoApplierKey(n.id);
      const cur = appliers.current[key]?.get() ?? videoPromptValues.get(n.id) ?? n.prompt ?? "";
      const want = !!n.source;
      const fixed = enforceSourceTag(cur, want);
      if (fixed === cur) continue;
      if (!applyDraftEdit(key, (t) => enforceSourceTag(t, want))) patchVideoNode(n.id, { prompt: stripSharedSections(fixed) });
    }
  }, [editNodes, editPromptValues, allVideoNodes, videoPromptValues, readOnly]);
  const onConnectEnd = useCallback<OnConnectEnd>((event, state) => {
    // Input-socket-only disconnect: grab a link at its input (target) end and
    // release it into empty space. Dragging out from an output (source) socket
    // of an image/video node opens an add-and-connect popup instead. Releasing
    // on/near any socket snaps back instead.
    if (state.isValid || state.toHandle) return;
    const from = state.fromHandle;
    if (!from) return;
    if (from.type === "source" && !readOnly) {
      const srcId = canonicalNodeId(String(from.nodeId ?? ""));
      const media: "image" | "video" | null = srcId === "imagegen" || parseEditGenNode(srcId) ? "image"
        : parseVideoGenNode(srcId) || parseEditVideoGenNode(srcId) ? "video" : null;
      if (media) {
        const me = event as MouseEvent & { changedTouches?: TouchList };
        const cx = me.clientX ?? me.changedTouches?.[0]?.clientX ?? 0;
        const cy = me.clientY ?? me.changedTouches?.[0]?.clientY ?? 0;
        const p = flowRef.current?.screenToFlowPosition({ x: cx, y: cy }) ?? { x: 0, y: 0 };
        setDropMenu({ x: cx, y: cy, pos: p, source: String(from.nodeId), sourceHandle: (from as { id?: string | null }).id ?? null, media });
      }
      return;
    }
    if (from.type !== "target") return;
    // Remember the wire being dragged off (before the stored-graph removal
    // below) so a direct generation→video-prompt wire can drop its sentinel
    // instead of stripping an unrelated prompt tag by index.
    const detachedEdge = cb.current.graph?.edges.find(
      (e) => e.to.node === canonicalNodeId(String(from.nodeId ?? "")) && e.to.port === String((from as { id?: unknown }).id ?? "")
    );
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
      // Reference-socket detach with a known wire: one-list sync by
      // source identity (the graph edge was already dropped above; this
      // strips the tag/sentinel to match, on whichever prompt kind).
      // Falls through to the legacy per-kind strips only when the wire
      // isn't in the stored graph.
      if (/^in-ref-\d+$/.test(handleId) && detachedEdge && detachedEdge.to.node === canonicalNodeId(nodeId) && detachedEdge.to.port === handleId) {
        disconnectPromptWire(nodeId, detachedEdge.from.node);
        return true;
      }
      const vpId = parseVideoPromptNode(nodeId);
      const evpId = parseEditVideoPromptNode(nodeId);
      // The tag to strip is the one the detached wire actually carried
      // (resolved from its source reference), not whatever tag now sits at
      // the socket index — the two diverge once any earlier wire moved.
      const detachedRefName = detachedEdge?.from.node.startsWith("ref:")
        ? cb.current.references.find((r) => r.id === detachedEdge.from.node.slice(4))?.name
        : undefined;
      if (nodeId === "composer") {
        if (handleId === "in-style") {
          // The edge is the plug and the sidepanel mirrors it: detaching the
          // composer wire selects None so the dropdown reflects the unwired state.
          graphField({ graphStyleConnected: false, styleNone: true });
          return true;
        }
        if (handleId === "in-brand") { cb.current.onToggleBrand(false); return true; }
        const m = /^in-ref-(\d+)$/.exec(handleId);
        if (m) { const name = detachedRefName ?? tagged[Number(m[1])]?.name; if (name && !applyDraftEdit("composer", (cur) => removeRefTag(cur, name))) cb.current.onPromptChange(removeRefTag(cb.current.prompt, name)); return true; }
      } else if (vpId) {
        const key = videoApplierKey(vpId);
        const curVal = cb.current.videoPromptValues?.get(vpId) ?? "";
        const applyVideo = (fn: (t: string) => string) => { if (!applyDraftEdit(key, fn)) patchVideoNode(vpId, { prompt: stripSharedSections(fn(curVal)) }); };
        if (handleId === "in-style") { patchVideoNode(vpId, { styleConnected: false }); return true; }
        if (handleId === "in-brand") return true;
        const m = /^in-ref-(\d+)$/.exec(handleId);
        if (m) {
          // A direct generation wire carries no tag: drop its sentinel and
          // leave the prompt text alone (otherwise an unrelated tag at this
          // index would be stripped).
          const genFrom = detachedEdge && parseVideoPromptNode(detachedEdge.to.node) ? detachedEdge.from.node : "";
          if (genFrom && isVideoGenRef(genFrom)) {
            const nodes = cb.current.graphVideoNodes ?? [];
            const node = nodes.find((n) => n.id === vpId);
            if (node && (node.refIds ?? []).includes(genFrom)) {
              patchVideoNode(vpId, { refIds: (node.refIds ?? []).filter((id) => id !== genFrom) });
            }
            return true;
          }
          const idx = Number(m[1]);
          const fresh = appliers.current[key]?.get() ?? curVal;
          const freshName = refTagNames(fresh)[idx];
          const t = detachedRefName ?? freshName ?? (cb.current.taggedVideoByNode?.get(vpId) ?? [])[idx]?.name;
          if (t) applyVideo((cur) => removeRefTag(cur, t));
          return true;
        }
      } else if (nodeId === "editprompt" || nodeId.startsWith(EDITPROMPT_NODE_PREFIX)) {
        const editId = nodeId === "editprompt" ? "edit0" : nodeId.slice(EDITPROMPT_NODE_PREFIX.length);
        const pv = cb.current.editPromptValues.get(editId) ?? "";
        const freshEdit = appliers.current[`edit:${editId}`]?.get() ?? pv;
        const patchNode = (patch: Partial<GraphEditNode>) => graphField({ graphEditNodes: (cb.current.graphEditNodes ?? []).map((n) => (n.id === editId ? { ...n, ...patch } : n)) });
        const applyEdit = (fn: (t: string) => string) => { if (!applyDraftEdit(`edit:${editId}`, fn)) cb.current.onEditNodePrompt(editId, fn(freshEdit)); };
        if (handleId === "in-style") { patchNode({ styleConnected: false }); return true; }
        if (handleId === "in-brand") return true;
        const m = /^in-ref-(\d+)$/.exec(handleId);
        if (m) {
          const idx = Number(m[1]);
          const freshName = refTagNames(freshEdit)[idx];
          const t = detachedRefName ?? freshName ?? (taggedEditByNode.get(editId) ?? [])[idx]?.name;
          if (t) applyEdit((cur) => removeRefTag(cur, t));
          return true;
        }
      } else if (evpId) {
        const key = editVideoApplierKey(evpId);
        const curVal = cb.current.videoPromptValues?.get(evpId) ?? "";
        const applyEditVideo = (fn: (t: string) => string) => { if (!applyDraftEdit(key, fn)) patchVideoNode(evpId, { prompt: stripSharedSections(fn(curVal)) }); };
        if (handleId === "in-style") { patchVideoNode(evpId, { styleConnected: false }); return true; }
        if (handleId === "in-brand") return true;
        const m = /^in-ref-(\d+)$/.exec(handleId);
        if (m) {
          // A direct generation wire carries no tag: drop its sentinel and
          // leave the prompt text alone.
          const genFrom = detachedEdge && parseEditVideoPromptNode(detachedEdge.to.node) ? detachedEdge.from.node : "";
          if (genFrom && isVideoGenRef(genFrom)) {
            const nodes = cb.current.graphVideoNodes ?? [];
            const node = nodes.find((n) => n.id === evpId);
            if (node && (node.refIds ?? []).includes(genFrom)) {
              patchVideoNode(evpId, { refIds: (node.refIds ?? []).filter((id) => id !== genFrom) });
            }
            return true;
          }
          const idx = Number(m[1]);
          const fresh = appliers.current[key]?.get() ?? curVal;
          const t = detachedRefName ?? refTagNames(fresh)[idx] ?? (cb.current.taggedVideoByNode?.get(evpId) ?? [])[idx]?.name;
          if (t) applyEditVideo((cur) => removeRefTag(cur, t));
          return true;
        }
      }
      return false;
    };
    if (from.type === "target" && (from.nodeId === "composer" || parseVideoPromptNode(from.nodeId ?? "") !== null || parseEditVideoPromptNode(from.nodeId ?? "") !== null || from.nodeId === "editprompt" || (from.nodeId ?? "").startsWith(EDITPROMPT_NODE_PREFIX))) {
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
      const evId = parseEditVideoGenNode(from.nodeId ?? "");
      if (evId && from.id === "in-video") {
        patchVideoNode(evId, { source: undefined });
        return;
      }
    }
    if (from.type === "target") {
      const editId = parseEditGenNode(from.nodeId ?? "");
      if (editId && from.id === "in-image") {
        graphField({ graphEditNodes: (cb.current.graphEditNodes ?? []).map((n) => (n.id === editId ? { ...n, source: undefined } : n)) });
        return;
      }
    }
    if (from.type === "target" && from.nodeId === "cameraGrid") {
      if (from.id === "in-style") { stable.onCameraGridSave({ styleConnected: false }); return; }
      if (from.id === "in-image") { stable.onCameraGridSave({ source: undefined }); return; }
      // Unplugging the grid image leaves the last sheet in place (still cuttable).
      if (from.id === "in-grid") { stable.onCameraGridSave({ gridSource: undefined }); return; }
      const m = /^in-ref-(\d+)$/.exec(from.id ?? "");
      if (m) {
        const cur = normalizeCameraGridData(cb.current.graphCameraGrid);
        const refIds = removeCameraGridRefAt(cur?.refIds ?? [], Number(m[1]));
        stable.onCameraGridSave({ refIds: refIds.length ? refIds : undefined });
        const g = cb.current.graph ?? fallbackGraph;
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
  }, [tagged, taggedVideo, taggedEditByNode, unionTagged, readOnly]);

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
  // files prompt via the parent with auto-numbered defaults (Ref_001…) so a batch never collides
  // on a generic clipboard file name. Text pastes are untouched.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Never hijack a paste aimed at a text field (the save popup included).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
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
    if (toolKind === "video" || toolKind === "edit" || toolKind === "tween" || toolKind === "editvideo" || toolKind === "genjutsu-motion" || toolKind === "genjutsu-swap" || toolKind === "cameraGrid" || toolKind === "upscale") {
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
    // Design-grid / moodboard-shelf drag: place the dragged reference(s) —
    // the same tiles the shelf drag carries, under the Step 2 mime types.
    const dragIds = refDragIds(e.dataTransfer);
    if (dragIds.length) {
      let n = 0;
      for (const id of dragIds) {
        const ref = references.find((r) => r.id === id);
        if (ref) addPlacedRef(ref, { x: pos.x + (n % 5) * 32, y: pos.y + (n % 5) * 32 });
        n += 1;
      }
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

  // ---- CTRL+Click → Frame Output ------------------------------------------
  // The one shortcut that changes wiring, and only as an explicit gesture:
  // it routes through the exact same onConnect code path as dragging the
  // wire by hand (canonical edge + legacy projection + one history step).
  const [outputChooser, setOutputChooser] = useState<{ nodeId: string; x: number; y: number; outputs: { id: string; label: string }[] } | null>(null);
  const routeNodeToOutput = useCallback((nodeId: string, sourceHandle: string) => {
    captureHistory(true);
    onConnect({ source: nodeId, sourceHandle, target: "output", targetHandle: "in-out" });
  }, [captureHistory, onConnect]);
  const onNodeClick = useCallback((e: React.MouseEvent, node: { id: string }) => {
    if (!(e.ctrlKey || e.metaKey) || readOnly) return;
    const nodeId = canonicalNodeId(node.id);
    if (nodeId === "output") return;
    const kind = nodeKindForId(nodeId);
    if (!kind) return;
    const outputs = nodeOutputs(kind).filter((o) => o.media === "image" || o.media === "video");
    if (outputs.length === 0) return;
    if (outputs.length === 1) {
      routeNodeToOutput(nodeId, outputs[0].id);
      return;
    }
    setOutputChooser({ nodeId, x: e.clientX, y: e.clientY, outputs: outputs.map((o) => ({ id: o.id, label: o.label })) });
  }, [readOnly, routeNodeToOutput]);

  // ---- Trace path (visual only) -------------------------------------------
  // Holding Alt while hovering a node dims everything outside its
  // upstream/downstream chain; a plain hover never dims.
  // Applied as DOM classes on the rendered wrappers — no React state, no
  // selection or graph change, and no node/edge re-render per hover.
  const traceRootRef = useRef<HTMLElement | null>(null);
  const traceHoverRef = useRef<string | null>(null);
  const traceAltRef = useRef(false);
  const applyTrace = useCallback((hoverId: string | null) => {
    const rootEl = traceRootRef.current;
    if (!rootEl) return;
    rootEl.querySelectorAll(".prod-trace-dim").forEach((el) => el.classList.remove("prod-trace-dim"));
    if (!hoverId) return;
    const graphNow = cb.current.graph ?? fallbackGraph;
    const chain = traceChain(graphNow, canonicalNodeId(hoverId));
    rootEl.querySelectorAll<HTMLElement>(".react-flow__node").forEach((el) => {
      const id = el.getAttribute("data-id");
      if (id && !chain.nodes.has(canonicalNodeId(id))) el.classList.add("prod-trace-dim");
    });
    rootEl.querySelectorAll<HTMLElement>(".react-flow__edge").forEach((el) => {
      const id = el.getAttribute("data-id");
      if (id && !chain.edges.has(id)) el.classList.add("prod-trace-dim");
    });
  }, [fallbackGraph]);
  const refreshTrace = useCallback(() => {
    applyTrace(traceAltRef.current ? traceHoverRef.current : null);
  }, [applyTrace]);
  const onNodeMouseEnter = useCallback((e: React.MouseEvent, node: { id: string }) => {
    traceHoverRef.current = node.id;
    // Sync from the event so entering with Alt already held (or released
    // outside the window) is right even if a key event was missed.
    traceAltRef.current = e.altKey;
    refreshTrace();
  }, [refreshTrace]);
  const onNodeMouseLeave = useCallback(() => {
    traceHoverRef.current = null;
    refreshTrace();
  }, [refreshTrace]);

  // Pressing or releasing Alt mid-hover toggles the trace in place. Blur
  // clears the held flag so Alt+Tab away and back never leaves it stuck on.
  useEffect(() => {
    const setAlt = (down: boolean) => {
      if (traceAltRef.current === down) return;
      traceAltRef.current = down;
      refreshTrace();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      // Keep a bare Alt from activating the application menu while tracing.
      if (traceHoverRef.current) e.preventDefault();
      setAlt(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      if (traceHoverRef.current) e.preventDefault();
      setAlt(false);
    };
    const onBlur = () => setAlt(false);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [refreshTrace]);

  /** Per-tool disabled hints: the provider gates (their tiles stay visible,
   *  disabled, with an explanation). Host-hidden tools have no tile at all. */
  const toolHints = {
    editvideo: videoEditUnavailable ? VIDEO_EDIT_UNAVAILABLE_HINT : undefined,
    "genjutsu-motion": genjutsuUnavailable ? GENJUTSU_UNAVAILABLE_HINT : undefined,
    "genjutsu-swap": genjutsuUnavailable ? GENJUTSU_UNAVAILABLE_HINT : undefined,
    upscale: upscaleUnavailable ? UPSCALE_UNAVAILABLE_HINT : undefined,
  } as const;

  return (
    <div className="prod-edit-overlay prod-graph-overlay" onClick={onClose}>
      <div className={"prod-graph-panel" + (magicActive ? " magic-active" : "") + (readOnly ? " prod-graph-readonly" : "")} onClick={(e) => e.stopPropagation()}>
        <div className="prod-graph-head">
          <span className="prod-graph-title">{subjectLabel ?? `Shot ${shot.number}`} — node graph</span>
          <span className="prod-graph-hint">Connections are stored wiring · drag references from the left shelf or tool nodes from the right panel onto the canvas · left-drag moves nodes · right-drag pans · drag a connection off an input socket to detach it · CTRL+Click a node routes it to Frame Output · hold ALT and hover a node to trace its chain</span>
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
          {magicActive && onRegenMagicShot && (
            <button
              className="prod-btn prod-magic-refresh"
              disabled={magicBusy}
              onClick={onRegenMagicShot}
              title="Regenerate this shot's Magic Prompt only (other shots are untouched)"
            >
              {magicBusy ? "…" : <><RegenerateIcon size={13} /> Regenerate this shot's magic prompt</>}
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
          {!readOnly && (
            <>
              <button className="prod-btn" onClick={doUndo} disabled={!historyRef.current.canUndo()} title="Undo (Ctrl+Z)">Undo</button>
              <button className="prod-btn" onClick={doRedo} disabled={!historyRef.current.canRedo()} title="Redo (Ctrl+Shift+Z)">Redo</button>
              <button className="prod-btn" onClick={tidyLayout} title="Arrange all nodes into a clean left-to-right flow (clears edge waypoints)">Tidy</button>
            </>
          )}
          <button className="prod-btn" onClick={onClose}>Close</button>
        </div>
        <div className="prod-graph-body">
          <RefShelf
            prodId={prod.meta.id}
            prod={prod}
            references={references}
            usage={refUsage}
            onCanvasRefIds={onCanvasRefIds}
            highlightId={highlightRefId}
            onDismissHighlight={dismissHighlight}
            onZoom={stable.onShelfRefZoom}
          />
          <div className="prod-graph-canvas" ref={(el) => { traceRootRef.current = el; }} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }} onDrop={onDrop}>
            <NodeDeleteContext.Provider value={requestDeleteNode}>
            <NodeHistoryContext.Provider value={setHistoryTarget}>
            <WaypointContext.Provider value={waypointHandlers}>
            <GraphLodProvider handleRef={lodHandleRef}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onInit={(inst) => { flowRef.current = inst; }}
              onNodesChange={onNodesChange}
              onNodeClick={onNodeClick}
              onNodeMouseEnter={onNodeMouseEnter}
              onNodeMouseLeave={onNodeMouseLeave}
              onPaneClick={() => setSelectedWaypoint(null)}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              isValidConnection={isValidConnection}
              onMoveStart={onCanvasMoveStart}
              onMoveEnd={onCanvasMoveEnd}
              fitView={!initialLayout?.viewport}
              defaultViewport={initialLayout?.viewport ?? { x: 0, y: 0, zoom: 1 }}
              fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
              minZoom={0.2}
              connectionRadius={30}
              nodesConnectable
              connectionLineType={ConnectionLineType.Straight}
              autoPanOnSelection={false}
              elevateEdgesOnSelect
              nodesDraggable
              panOnDrag={[1, 2]}
              selectionOnDrag
              deleteKeyCode={["Backspace", "Delete"]}
              onlyRenderVisibleElements={nodes.length > GRAPH_CULL_NODE_LIMIT}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={22} />
            </ReactFlow>
            </GraphLodProvider>
            </WaypointContext.Provider>
            </NodeHistoryContext.Provider>
            </NodeDeleteContext.Provider>
          {dropHint && <div className="prod-graph-drop-hint">{dropHint}</div>}
          {dropMenu && (
            <div className="prod-graph-output-chooser" style={{ left: dropMenu.x, top: dropMenu.y }}>
              <div className="prod-graph-output-chooser-title">Add and connect</div>
              {(dropMenu.media === "image"
                ? [{ id: "edit" as const, label: "Edit image" }, { id: "output" as const, label: "Output" }]
                : [{ id: "editvideo" as const, label: "Edit video" }, { id: "output" as const, label: "Output" }]
              ).map((o) => (
                <button key={o.id} type="button" className="prod-graph-output-chooser-item"
                  onClick={() => { const m = dropMenu; setDropMenu(null); addAndConnect(o.id, m); }}>
                  {o.label}
                </button>
              ))}
              <button type="button" className="prod-graph-output-chooser-item" onClick={() => setDropMenu(null)}>Cancel</button>
            </div>
          )}
          {outputChooser && (
            <div className="prod-graph-output-chooser" style={{ left: outputChooser.x, top: outputChooser.y }}>
              <div className="prod-graph-output-chooser-title">Route to Frame Output</div>
              {outputChooser.outputs.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className="prod-graph-output-chooser-item"
                  onClick={() => { routeNodeToOutput(outputChooser.nodeId, o.id); setOutputChooser(null); }}
                >
                  {o.label}
                </button>
              ))}
              <button type="button" className="prod-graph-output-chooser-item" onClick={() => setOutputChooser(null)}>Cancel</button>
            </div>
          )}
          {lightbox && (
            <MediaLightbox
              name={lightbox.name}
              src={lightbox.artwork}
              kind={lightbox.kind === "video" ? "video" : "image"}
              rel={lightbox.rel}
              productionId={prod.meta.id}
              backdropClassName="prod-graph-lightbox"
              hint={lightbox.kind === "video" ? (lightbox.rel ? "right-click for options" : "") : (lightbox.rel ? "scroll to zoom · drag to pan · right-click for options" : undefined)}
              onClose={() => setLightbox(null)}
              onNavigate={lightbox.nav && lightbox.nav.items.length > 1 ? (dir) => setLightbox((lb) => (lb ? stepLightbox(lb, dir) : lb)) : undefined}
              onContextMenu={(e) => { if (lightbox.rel) lightboxMenu.open(e, lightbox.rel, { src: lightbox.artwork, media: lightbox.kind }); }}
              onVideoStillSaved={onVideoStillSaved}
            />
          )}
          <GenerationMenu menu={lightboxMenu.menu} onClose={lightboxMenu.close} onSaveAsReference={stable.onSaveAsRef} onRefresh={stable.onRefreshGen} onEditInSuite={stable.onEditInSuite} />
          {historyTarget && (() => {
            const view = historyViewFor(shot, prod.meta.id, historyTarget);
            return (
              <GraphHistoryModal
                target={historyTarget}
                items={view.items}
                selected={view.selected}
                media={view.media}
                onSelect={(i) => cb.current.onSelectGraphGen(historyTarget.kind, i, historyTarget.nodeId)}
                onClose={() => setHistoryTarget(null)}
                onZoom={(name, url, kind, rel) => cb.current.setLightbox({ name, artwork: url, kind, rel })}
                onDelete={stable.onDeleteGen}
                onSaveAsRef={stable.onSaveAsRef}
                onEditInSuite={stable.onEditInSuite}
                onRefresh={stable.onRefreshGen}
                onUpgradeDraft={(rel) => { void stable.onUpgradeDraft(historyTarget.nodeId ?? "vid0", rel); }}
              />
            );
          })()}
          </div>
          <div className={"prod-graph-tools" + (hidePalette ? " hidden" : "")}>
            <div className="prod-graph-tools-head">
              <span className="prod-graph-tools-title">Nodes</span>
              <span className="prod-graph-tools-hint">Drag onto the canvas to add</span>
            </div>
            <div className="prod-graph-tools-list">
              <div
                className="prod-graph-tools-item"
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
              </div>
              {!hiddenToolsSet.has("edit") && (
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
              )}
              {!hiddenToolsSet.has("editvideo") && (
                <div
                  className={"prod-graph-tools-item" + (videoEditUnavailable ? " disabled" : "")}
                  draggable={!videoEditUnavailable}
                  aria-disabled={videoEditUnavailable}
                  title={videoEditUnavailable ? VIDEO_EDIT_UNAVAILABLE_HINT : "Drag onto the canvas to add another edit-video node"}
                  onDragStart={(e) => {
                    if (videoEditUnavailable) { e.preventDefault(); return; }
                    e.dataTransfer.setData("application/x-cascade-tool", "editvideo");
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                >
                  <EditVideoIcon size={14} className="prod-graph-tools-icon" />
                  <span className="prod-graph-tools-label">Edit video</span>
                  {hasEditVideoTool && <span className="prod-graph-shelf-count">{editVidNodes.length}</span>}
                </div>
              )}
              {!hiddenToolsSet.has("genjutsu-motion") && (
                <div
                  className={"prod-graph-tools-item" + (genjutsuUnavailable ? " disabled" : "")}
                  draggable={!genjutsuUnavailable}
                  aria-disabled={genjutsuUnavailable}
                  title={genjutsuUnavailable ? GENJUTSU_UNAVAILABLE_HINT : "Drag onto the canvas to add a Genjutsu Motion Transfer node — rebuild the scene around the source clip's motion"}
                  onDragStart={(e) => {
                    if (genjutsuUnavailable) { e.preventDefault(); return; }
                    e.dataTransfer.setData("application/x-cascade-tool", "genjutsu-motion");
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                >
                  <GenjutsuMotionIcon size={14} className="prod-graph-tools-icon" />
                  <span className="prod-graph-tools-label">Genjutsu Motion Transfer</span>
                  {hasGenjutsuMotionTool && <span className="prod-graph-shelf-count">{genjutsuMotionNodes.length}</span>}
                </div>
              )}
              {!hiddenToolsSet.has("genjutsu-swap") && (
                <div
                  className={"prod-graph-tools-item" + (genjutsuUnavailable ? " disabled" : "")}
                  draggable={!genjutsuUnavailable}
                  aria-disabled={genjutsuUnavailable}
                  title={genjutsuUnavailable ? GENJUTSU_UNAVAILABLE_HINT : "Drag onto the canvas to add a Genjutsu Object Swap node — replace one element, keep the rest of the shot"}
                  onDragStart={(e) => {
                    if (genjutsuUnavailable) { e.preventDefault(); return; }
                    e.dataTransfer.setData("application/x-cascade-tool", "genjutsu-swap");
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                >
                  <GenjutsuSwapIcon size={14} className="prod-graph-tools-icon" />
                  <span className="prod-graph-tools-label">Genjutsu Object Swap</span>
                  {hasGenjutsuSwapTool && <span className="prod-graph-shelf-count">{genjutsuSwapNodes.length}</span>}
                </div>
              )}
              {!hiddenToolsSet.has("tween") && (
                <div
                  className="prod-graph-tools-item"
                  draggable={!hasTweenTool}
                  title={hasTweenTool ? "Already on the canvas" : "Drag onto the canvas to add the in-betweener node"}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/x-cascade-tool", "tween");
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                >
                  <InbetweenIcon size={14} className="prod-graph-tools-icon" />
                  <span className="prod-graph-tools-label">In-betweener</span>
                </div>
              )}
              {!hiddenToolsSet.has("cameraGrid") && (
                <div
                  className="prod-graph-tools-item"
                  draggable={!hasCameraGridTool}
                  title={hasCameraGridTool ? "Already on the canvas" : "Drag onto the canvas to add the 16-angle camera grid node"}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/x-cascade-tool", "cameraGrid");
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" className="prod-graph-tools-icon" aria-hidden="true"><path fill="currentColor" d="M1 1h6v6H1V1zm8 0h6v6H9V1zM1 9h6v6H1V9zm8 0h6v6H9V9z" /></svg>
                  <span className="prod-graph-tools-label">Camera grid</span>
                </div>
              )}
              {!hiddenToolsSet.has("upscale") && (
                <div
                  className={"prod-graph-tools-item" + (upscaleUnavailable ? " disabled" : "")}
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
                </div>
              )}
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
