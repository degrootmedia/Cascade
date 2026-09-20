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
import { TWEEN_KEY_IMGGEN, TWEEN_KEY_EDITGEN, TWEEN_KEY_EDITGEN_PREFIX, modelOnSurface, type CliModelSchema, type GenParams, type Graph, type GraphEditNode, type GraphGenItem, type GraphLayout, type OpenArtModelChoice, type Production, type ProductionShot, type ProductionStyle, type TweenBlock, type VideoModelOptions } from "../../../shared/ipc.js";
import { ModelOptionsForm, pruneModelOptionValues, type ModelOptionValues } from "./ModelOptionsForm.js";
import { closestResolution } from "./resolution.js";
import { addRefTag, composePromptBoxes, parsePromptBoxes, refTagNames, removeRefTag, replaceRefTagAt } from "../../../shared/prompt-grammar.js";
import { TriplePrompt } from "./TriplePrompt.js";
import { TweenTimelineModal, deriveTweenBlocksClient, filterTweenModels } from "./TweenTimelineModal.js";
import { usePersistedCollapsed } from "./production/persisted-state.js";
import { getMediaDefault, rememberMediaDefault } from "./production/media-defaults.js";
import { costAspect, isQuotableCostModel } from "./production/generation-cost.js";
import { GenerationCostSuffix } from "./production/generation-cost-label.js";
import { seedModelOptionValues } from "./production/model-param-defaults.js";
import { useImageContextMenu } from "./image-context-menu.js";
import { graphEdgesToFlow, promptSockets } from "./graphFlow.js";
import { materializeGraph } from "../../../shared/graph/materialize.js";
import { normalizeGraph } from "../../../shared/graph/normalize.js";
import { addGraphNode, applyConnection, applyTweenKeys, canonicalNodeId, connectionToEdge, connectTweenKey, ensurePromptPipe, graphEdgesForDetach, nodeKindForId, removeGraphEdge, removeGraphNode, tweenKeyForSource, tweenKeyToNode } from "../../../shared/graph/connect.js";
import { canConnect, portDecl, refOutputMedia, TWEEN_SOCKET_RE } from "../../../shared/graph/ports.js";
import { isBrandAttached, renderShotPrompt, stripSharedSections } from "../../../shared/graph/render.js";
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

/** Default motion prompt for the video-prompt node (matches the video panel). */
export const VIDEO_PROMPT_DEFAULT = "Animate this reference image with smooth, cinematic motion.";

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

/** The selected stored take's path for a generation node id, or null when the
 *  node holds no generation (nothing to save as a reference). */
function selectedGenerationRel(shot: ProductionShot, nodeId: string): string | null {
  if (nodeId === "imagegen") return shot.graphImageGens?.[shot.graphImageGenIndex ?? 0]?.path ?? null;
  if (nodeId === "videogen") return shot.graphVideoGens?.[shot.graphVideoGenIndex ?? 0]?.path ?? null;
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
  return nodeId === "composer" || nodeId === "videoprompt" || nodeId === "editvideoprompt" || nodeId === "editprompt" || nodeId.startsWith(EDITPROMPT_NODE_PREFIX);
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

/** Reference-node size: resizable, but a collapsed node shows only its name, so
 *  a saved height would pin it open — collapsed refs get width only. */
function refSizeStyle(layout: GraphLayout | undefined, id: string, collapsed: boolean): { width: number; height?: number } {
  const saved = layout?.sizes?.[id];
  const width = saved?.width ?? 236;
  return collapsed || !saved ? { width } : { width, height: saved.height };
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

/** Thumbnail variant of a reference's artwork URL: the cascade-media protocol
 *  serves a small compressed JPEG for `?thumb=1`, so the side shelf never pulls
 *  full-resolution reference files just to draw its tiles. Legacy inline data
 *  URLs are already in-memory and pass through unchanged. Canvas reference
 *  nodes render the full-res `artwork` directly (the graph is a working
 *  surface, not a list). */
export function refThumbUrl(artwork: string): string {
  if (artwork.startsWith("cascade-media://")) {
    return `${artwork}${artwork.includes("?") ? "&" : "?"}thumb=1`;
  }
  return artwork;
}

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
  /** The model's full option schema (Advanced panel). */
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  /** Persists a per-shot advanced-params change onto the shot. */
  onSaveFields: (patch: Partial<ProductionShot>) => void;
  /** Open a generation in the lightbox (same zoom as reference nodes). */
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string) => void;
}
type ImageGenFlowNode = Node<ImageGenData, "imagegen">;

interface VideoGenData extends Record<string, unknown> {
  models: OpenArtModelChoice[];
  /** This shot's saved video-gen picks (win over the global media-default,
   *  which only seeds shots that never picked). */
  savedModel?: string;
  savedResolution?: string;
  savedDurationSec?: number;
  /** This shot's saved advanced/variant params (schema-driven). */
  savedParams?: GenParams;
  items: { url: string; prompt: string; path: string }[];
  selected: number;
  hasImageSource: boolean;
  /** Lifted in-flight flag (see ImageGenData.busy). */
  busy: boolean;
  onGenerate: (model: string, resolution: string, durationSec: number, params?: GenParams) => Promise<void>;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
  /** Right-click a take → delete it (blocked while it feeds a pipe/output). */
  onDeleteGen: (rel: string) => void;
  /** Right-click a take → copy it into the production as a new reference. */
  onSaveAsRef: (rel: string) => void;
  onModelOptions: (model: string, withImage: boolean) => Promise<VideoModelOptions | null>;
  /** The model's full option schema (for the Advanced panel). */
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  /** Persists a per-shot model/resolution/length change onto the shot. */
  onSaveFields: (patch: Partial<ProductionShot>) => void;
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
  onGenerate: (model: string, prompt: string, params: GenParams) => Promise<void>;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
  /** Right-click a take → delete it (blocked while it feeds a pipe/output). */
  onDeleteGen: (rel: string) => void;
  /** Right-click a take → copy it into the production as a new reference. */
  onSaveAsRef: (rel: string) => void;
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
  /** Lifted in-flight flag (see ImageGenData.busy). */
  busy: boolean;
  onGenerate: (nodeId: string, model: string, resolution: string, params?: GenParams) => Promise<void>;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
  /** Right-click a take → delete it (blocked while it feeds a pipe/output). */
  onDeleteGen: (rel: string) => void;
  /** Right-click a take → copy it into the production as a new reference. */
  onSaveAsRef: (rel: string) => void;
  /** Persists a per-node model/resolution change onto this edit node. */
  onSave: (patch: Partial<GraphEditNode>) => void;
  /** The model's full option schema (Advanced panel). */
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  /** Open a generation in the lightbox (same zoom as reference nodes). */
  onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string) => void;
}
type EditGenFlowNode = Node<EditGenData, "editgen">;

interface VideoPromptData extends Record<string, unknown> {
  /** The motion prompt, synced with the classic VideoGenModal (`shot.graphVideoPrompt`). */
  value: string;
  refHandles: string[];
  openHandleId: string;
  includeBrand: boolean;
  onChange: (text: string) => void;
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

type GraphNode = RefFlowNode | ComposerFlowNode | StyleFlowNode | BrandFlowNode | OutputFlowNode | ImageGenFlowNode | VideoGenFlowNode | TweenFlowNode | EditVideoFlowNode | EditGenFlowNode | VideoPromptFlowNode | EditPromptFlowNode | EditVideoPromptFlowNode;

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
  const zoom = useCallback((e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    if (data.media === "video" && data.mediaUrl) data.onZoom(data.name, data.mediaUrl, "video");
    else if (data.artwork) data.onZoom(data.name, data.artwork);
  }, [data]);
  return (
    <>
      <NodeResizer isVisible={selected && !collapsed} minWidth={150} minHeight={120} lineClassName="prod-graph-resize-line" handleClassName="prod-graph-resize-handle" />
      <div className={"prod-graph-node prod-graph-ref" + (data.tagged ? "" : " avail") + (data.missing ? " missing" : "") + (collapsed ? " collapsed" : "")}>
        <Handle type="source" position={Position.Right} className="socket-ref" />
        <div className="prod-graph-ref-head">
          <button
            className="prod-graph-ref-eye nodrag"
            title={collapsed ? "Expand — show the image" : "Collapse — hide the image"}
            onClick={() => data.onToggleCollapse?.(id, !collapsed)}
          >
            {collapsed ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
          </button>
        </div>
        {!collapsed && (
          <div className="prod-graph-ref-media" onDoubleClick={zoom} title={data.artwork || data.mediaUrl ? "Double-click to view larger" : undefined}>
            {data.artwork
              ? <img src={data.artwork} alt={data.name} draggable={false} loading="lazy" decoding="async" onContextMenu={extMenu.onContextMenu} />
              : data.media === "video" && data.mediaUrl
                ? <video className="prod-graph-ref-video" src={data.mediaUrl} muted loop playsInline preload="metadata" onMouseEnter={(e) => { try { e.currentTarget.play(); } catch {} }} onMouseLeave={(e) => { try { e.currentTarget.pause(); } catch {} }} draggable={false} />
                : data.media
                  ? <div className="prod-graph-ref-blank" title={data.media === "audio" ? "Audio reference" : "Video reference"}>{data.media === "audio" ? "♪" : "▶"}</div>
                  : <div className="prod-graph-ref-blank" title="Reference has no image">?</div>}
          </div>
        )}
        {renameable
          ? <input
              className="prod-graph-ref-name prod-ref-edit-name nodrag"
              value={nameDraft}
              title={`Rename @[${data.name}]`}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            />
          : <span className="prod-graph-ref-name" title={data.missing ? "No reference with this name exists (anymore)" : `Reference @[${data.name}]`}>@[{data.name}]</span>}
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
          const prev = localValue;
          setLocalValue(v);
          draftRef.current = v;
          const s = emitted.current;
          if (s.size > 100) s.clear();
          s.add(v);
          // Tag reorders are discrete moves that must be visible in the
          // side panel and survive a concurrent style change. Sync them
          // immediately to the parent instead of waiting for blur. Regular
          // typing stays local until blur to keep the caret stable.
          try {
            const pc = parsePromptBoxes(prev).content;
            const nc = parsePromptBoxes(v).content;
            if (isTagReorder(pc, nc)) {
              dataRef.current.onChange(v);
            }
          } catch {}
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
            title="Right-click to save as a reference or delete this take"
            onContextMenu={(e) => genMenu.open(e, data.items[data.selected].path)}
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
              onContextMenu={(e) => genMenu.open(e, it.path)}
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
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} onDelete={data.onDeleteGen} />
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
    data.onSaveFields({ graphVideoParams: p });
  };
  const run = async () => {
    await data.onGenerate(effModel, resolution, durationSec, params);
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
      <div className="prod-graph-node-title">Video generation</div>
      <div className="prod-graph-gen-controls">
        <select
          className="prod-openart-select nodrag"
          value={data.models.some((m) => m.id === model) ? model : (data.models[0]?.id ?? "")}
          onChange={(e) => { setModel(e.target.value); data.onSaveFields({ graphVideoModel: e.target.value }); }}
          title="Video model"
          disabled={data.models.length === 0}
        >
          {data.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>)}
        </select>
      </div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={resolution} onChange={(e) => { setResolution(e.target.value); data.onSaveFields({ graphVideoResolution: e.target.value }); }} title="Resolution">
          {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select className="prod-openart-select nodrag" value={String(durationSec)} onChange={(e) => { setDurationSec(Number(e.target.value)); data.onSaveFields({ graphVideoDurationSec: Number(e.target.value) }); }} title="Clip length">
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
            title="Right-click to save as a reference or delete this take"
            onContextMenu={(e) => genMenu.open(e, data.items[data.selected].path)}
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
        : <div className="prod-graph-gen-preview blank">No generations yet</div>}
      {data.items.length > 0 && (
        <div className="prod-graph-gen-strip nodrag">
          {[...data.items].map((it, i) => ({ it, i })).reverse().map(({ it, i }) => (
            <button
              key={i}
              className={i === data.selected ? "sel" : ""}
              title={`${it.prompt || `Clip ${i + 1}`} — right-click for options`}
              onClick={() => data.onSelect(i)}
              onContextMenu={(e) => genMenu.open(e, it.path)}
            >
              <span>{i + 1}</span>
            </button>
          ))}
        </div>
      )}
      {data.items.length > 1 && (
        <div className="prod-graph-gen-cycle">
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(1)} title="Older clip">‹</button>
          <span>{data.selected + 1} / {data.items.length}</span>
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(-1)} title="Newer clip">›</button>
        </div>
      )}
      <button className="prod-btn primary prod-graph-gen-go nodrag" disabled={busy} onClick={() => { void run(); }}>
        {busy ? "Generating…" : <>Generate<GenerationCostSuffix req={videoCostReq} /></>}
      </button>
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} onDelete={data.onDeleteGen} />
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
  const genMenu = useGenerationMenu();
  const prompt = data.savedPrompt ?? "";
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
            title="Right-click to save as a reference or delete this take"
            onContextMenu={(e) => genMenu.open(e, data.items[data.selected].path)}
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
        : <div className="prod-graph-gen-preview blank">No edits yet</div>}
      {data.items.length > 1 && (
        <div className="prod-graph-gen-cycle">
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(1)} title="Older edit">‹</button>
          <span>{data.selected + 1} / {data.items.length}</span>
          <button className="prod-graph-ref-btn nodrag" disabled={busy} onClick={() => data.onCycle(-1)} title="Newer edit">›</button>
        </div>
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
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} onDelete={data.onDeleteGen} />
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
            title="Right-click to save as a reference or delete this take"
            onContextMenu={(e) => genMenu.open(e, data.items[data.selected].path)}
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
              onContextMenu={(e) => genMenu.open(e, it.path)}
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
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={data.onSaveAsRef} onDelete={data.onDeleteGen} />
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
const PromptNodeView = memo(function PromptNodeView({ id, data, title, placeholder, containerClass }: { id: string; data: VideoPromptData; title: string; placeholder: string; containerClass: string }) {
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

/** Video-prompt node: the motion prompt for the video generation node. */
const VideoPromptNodeView = memo((props: NodeProps<VideoPromptFlowNode>) => (
  <PromptNodeView
    id={props.id}
    data={props.data}
    title="Video prompt"
    placeholder="Motion prompt — connect references, type @, or edit the boxes"
    containerClass="prod-graph-videoprompt"
  />
));

/** Edit-image prompt node: the edit instructions for one edit-image node. */
const EditPromptNodeView = memo((props: NodeProps<EditPromptFlowNode>) => {
  const { id, data } = props;
  const adapted: VideoPromptData = {
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
};

/** Exported for the renderer-component tests (the node graph uses it directly). */
export const graphNodeTypes = nodeTypes;

/* ------------------------------------------------------------------ */
/* Reference shelf                                                     */
/* ------------------------------------------------------------------ */

/** Shelf tiles rendered per group before their thumbnails may load — keeps
 *  the initial DOM small so large projects open fast. */
const SHELF_PAGE = 24;
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
 *  Show-more button so large groups don't mount hundreds of rows at once. */
function ShelfGroup({ prodId, group, query, onCanvasRefIds }: {
  prodId: string;
  group: { title: string; refs: GraphRef[] };
  query: string;
  onCanvasRefIds: ReadonlySet<string>;
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
  if (q && matching.length === 0) return null;
  const visible = matching.slice(0, shown);
  return (
    <div ref={rootRef} className="prod-graph-shelf-group">
      <button
        className="prod-graph-shelf-group-head"
        aria-expanded={!collapsed}
        title={collapsed ? `Show ${group.title}` : `Hide ${group.title}`}
        onClick={() => setCollapsed(!collapsed)}
      >
        <svg className={"prod-graph-shelf-caret" + (collapsed ? " collapsed" : "")} viewBox="0 0 16 16" width="9" height="9" aria-hidden="true"><path d="M5 3l6 5-6 5V3z" fill="currentColor" /></svg>
        <span className="prod-graph-shelf-group-name">{group.title}</span>
        <span className="prod-graph-shelf-count">{q ? `${matching.length}/${group.refs.length}` : group.refs.length}</span>
      </button>
      {!collapsed && revealed && visible.map((r) => {
        const onCanvas = onCanvasRefIds.has(r.id);
        return (
          <div
            key={r.id}
            className={"prod-graph-shelf-item" + (onCanvas ? " on-canvas" : "")}
            draggable={!onCanvas}
            title={onCanvas ? "Already on the canvas" : `Drag onto the canvas to add @[${r.name}]`}
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-cascade-ref", r.id);
              e.dataTransfer.effectAllowed = "copy";
            }}
          >
            {r.artwork
              ? <ShelfThumb src={r.artwork} alt={r.name} />
              : <div className="prod-graph-shelf-blank">{r.media === "video" ? "▶" : r.media === "audio" ? "♪" : "?"}</div>}
            <span className="prod-graph-shelf-name" title={`Reference @[${r.name}]`}>@[{r.name}]</span>
            {onCanvas && <span className="prod-graph-shelf-check">on canvas</span>}
          </div>
        );
      })}
      {!collapsed && revealed && matching.length > visible.length && (
        <button
          className="prod-graph-shelf-more nodrag"
          onClick={() => setShown((n) => n + SHELF_PAGE)}
        >
          Show more ({matching.length - visible.length} remaining)
        </button>
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
  if (id === "tween") return { x: VIDGEN_X, y: Math.max(20, midY + 180) };
  if (id === "editvideo") return { x: VIDGEN_X + 360, y: Math.max(20, midY - 190) };
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

export function NodeGraphModal({ prod, shot, bust, prompt, references, styles, styleValue, includeBrand, magicActive = false, magicBusy = false, onToggleMagic, onRegenMagic, imageModels, videoModels, endFrameModelIds = null, defaultImageModel, defaultImageResolution, initialLayout, onPromptChange, onStyleChange, onToggleBrand, onDropFile, onPasteFiles, onStyleDetached, onRunImageGen, onRunVideoGen, onRunEditGen, onRunEditVideo = async () => {}, onRunTweenBlock = async () => {}, onStitchTween = async () => {}, onUnstitchTween = async () => {}, imageGenBusy = false, videoGenBusy = false, editVideoBusy = false, editBusyNodeIds = [], busyTweenBlock = null, tweenStitching = false, onSelectGraphGen, onCycleGraphGen, onDeleteGeneration = () => {}, onSaveAsReference = () => {}, onSaveGenerationAsReference = async () => null, onEditNodePrompt = () => {}, onRenameRef, onGraphField, onPipeImageToVideo, onPipeEditToVideo = () => {}, onPipeRefToVideo = () => {}, onPipeImageToOutput, onPipeVideoToOutput, onPipeTweenToOutput = () => {}, onPipeEditVideoToOutput = () => {}, onPipeEditToOutput, onPipeRefToOutput, onTweenRefs = () => {}, onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeTweenGen = () => {}, onUnpipeEditGen, onUnpipeOutput, onSaveLayout, onClose }: {
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
  onRegenMagic?: () => void;
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
  /** Defaults from the production's OpenArt config for the image node. */
  defaultImageModel: string;
  defaultImageResolution: string;
  /** Run the image generation node (prompt = the composer's text). */
  onRunImageGen: (model: string, resolution: string, params?: GenParams) => Promise<void>;
  /** Run the video generation node (prompt = the video-prompt node). */
  onRunVideoGen: (model: string, resolution: string, durationSec: number, params?: GenParams) => Promise<void>;
  /** Run an edit-image node (prompt = that node's edit-prompt node). */
  onRunEditGen: (nodeId: string, model: string, resolution: string, params?: GenParams) => Promise<void>;
  /** Run the edit-video node (source/refs come from its wired sockets). */
  onRunEditVideo?: (model: string, prompt: string, params?: GenParams) => Promise<void>;
  /** Generate one in-betweener action block's clip (prompt = the block's;
   *  durationSec = the block's displayed length, so the submit never races a
   *  pending retime save). */
  onRunTweenBlock?: (blockId: string, durationSec: number, model: string, params?: GenParams) => Promise<void>;
  /** Stitch every action block's selected clip into the continuous shot. */
  onStitchTween?: () => Promise<void>;
  /** Undo a stitch — back to the individual block clips (toggle on Stitch). */
  onUnstitchTween?: () => Promise<void>;
  /** Lifted in-flight flags so "Generating…" survives the modal unmounting
   *  (the workspace owns them per shot). */
  imageGenBusy?: boolean;
  videoGenBusy?: boolean;
  /** The edit-video node is generating for this shot (workspace-owned). */
  editVideoBusy?: boolean;
  /** Edit node ids currently generating for this shot (per-node busy). */
  editBusyNodeIds?: string[];
  /** The in-betweener block currently generating (workspace-owned). */
  busyTweenBlock?: string | null;
  /** True while a stitch/unstitch runs (workspace-owned). */
  tweenStitching?: boolean;
  /** Select a generation node's stored output by index (edit kind names its node). */
  onSelectGraphGen: (kind: "image" | "video" | "edit" | "editvideo", index: number, nodeId?: string) => void;
  /** Cycle a generation node's stored outputs (edit kind names its node). */
  onCycleGraphGen: (kind: "image" | "video" | "edit" | "editvideo", dir: 1 | -1, nodeId?: string) => void;
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
  /** Pipe the image node's output into the video node's image input. */
  onPipeImageToVideo: () => void;
  /** Pipe an edit-image node's output into the video node's image input
   *  (replacing whatever else feeds it). */
  onPipeEditToVideo?: (nodeId: string) => void;
  /** Pipe a reference image into the video node's image input. */
  onPipeRefToVideo?: (refId: string) => void;
  /** Pipe the image node's output into the output (and apply its selection). */
  onPipeImageToOutput: () => void;
  /** Pipe the video node's output into the output (and apply its selection). */
  onPipeVideoToOutput: () => void;
  /** Pipe the in-betweener's stitched clip into the output (and apply it). */
  onPipeTweenToOutput?: () => void;
  /** Pipe the edit-video node's selected clip into the output (and apply it). */
  onPipeEditVideoToOutput?: () => void;
  /** Pipe an edit-image node's output into the output (and apply its selection). */
  onPipeEditToOutput: (nodeId: string) => void;
  /** Pipe a reference node's output into the output (applies its media to the shot). */
  onPipeRefToOutput: (refId: string) => void;
  /** Replace the in-betweener's ordered keyframe ref ids. */
  onTweenRefs?: (refIds: string[]) => void;
  /** Unbind the image node's output entirely (video feed + any output feed). */
  onUnpipeImageGen: () => void;
  /** Unbind the image node from the video node's image input only. */
  onUnpipeImageToVideo: () => void;
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
}) {
  const saveLayoutRef = useRef(onSaveLayout);
  saveLayoutRef.current = onSaveLayout;
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [shelfQuery, setShelfQuery] = useState("");
  // The reference shelf starts collapsed so opening the graph doesn't mount (and
  // thumbnail-encode) every reference in the production. Toggling it open loads
  // the shelf on demand.
  const [shelfOpen, setShelfOpen] = useState(false);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ name: string; artwork: string; kind?: "image" | "video"; rel?: string } | null>(null);
  /** Right-click menu for the enlarged generation in the lightbox. */
  const lightboxMenu = useGenerationMenu();
  /** In-betweener timeline window (stacked above the graph). */
  const [tweenOpen, setTweenOpen] = useState(false);
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
  /** Reference nodes collapsed to a name-only tile (persisted in the layout). */
  const collapsedRef = useRef<Record<string, boolean>>({ ...(initialLayout?.collapsed ?? {}) });
  /** Expanded heights stashed while a ref node is collapsed, so expanding
   *  restores the user's size instead of the collapsed content height. */
  const refExpandedHeight = useRef<Record<string, number>>({});
  /** Paste stagger — each pasted reference lands offset from the last so a
   *  multi-image paste doesn't stack every node on the same point. */
  const pasteCountRef = useRef(0);

  const showHint = useCallback((message: string) => {
    setDropHint(message);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setDropHint(null), 4000);
  }, []);

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
  const videoPromptValue = renderShotPrompt(prod, { ...shot, graphVideoPrompt: shot.graphVideoPrompt ?? VIDEO_PROMPT_DEFAULT }, "videoprompt");
  const editVideoPromptValue = renderShotPrompt(prod, shot, "editvideoprompt");
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
  const taggedVideoNames = useMemo(() => refTagNames(videoPromptValue), [videoPromptValue]);

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
  const videoGenActive = !!(shot.graphVideoGens?.length || shot.graphVideoRefIds?.length || shot.graphImageToVideo || shot.graphEditToVideo || shot.graphVideoSourceRefId || shot.graphOutputSource === "videogen" || (shot.graphVideoPrompt ?? "").trim());
  /** The in-betweener is in use while it holds keyframes, blocks, a stitch,
   *  or the output feed — like the video/edit tools, it can't be removed then. */
  const tweenActive = !!((shot.graphTweenRefIds?.length ?? 0) > 0 || (shot.graphTweenBlocks?.length ?? 0) > 0 || shot.graphTweenOutput || shot.graphOutputSource === "tween");
  /** The edit-video node is in use while it holds clips, a source, params, or
   *  the output feed — like the other tools, it can't be removed then. */
  const editVideoActive = !!((shot.graphEditVideoGens?.length ?? 0) > 0 || (shot.graphEditVideoPrompt ?? "").trim() || shot.graphEditVideoSourceRefId || shot.graphVideoToEditVideo || shot.graphEditVideoParams || shot.graphOutputSource === "editvideo");
  const [placedTools, setPlacedTools] = useState<Set<string>>(() => {
    const out = new Set<string>();
    const p = initialLayout?.positions ?? {};
    if (p.videogen || p.videoprompt) { out.add("videogen"); out.add("videoprompt"); }
    if (p.tween) { out.add("tween"); }
    if (p.editvideo || p.editvideoprompt) { out.add("editvideo"); out.add("editvideoprompt"); }
    return out;
  });
  const hasVideoTool = videoGenActive || placedTools.has("videogen");
  const hasEditTool = editNodes.length > 0;
  const hasTweenTool = tweenActive || placedTools.has("tween");
  const hasEditVideoTool = editVideoActive || placedTools.has("editvideo");
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
  const cb = useRef({ graph: shot.graph, onPromptChange, onStyleChange, onToggleBrand, prompt, videoPromptValue, editPromptValues, editNodes, setLightbox, styles, styleValue, initialLayout, onStyleDetached, onRunImageGen, onRunVideoGen, onRunEditGen, onRunEditVideo, onEditNodePrompt, onRenameRef, onRunTweenBlock, onStitchTween, onSelectGraphGen, onCycleGraphGen, onDeleteGeneration, onSaveAsReference, onSaveGenerationAsReference, onGraphField, onPipeImageToVideo, onPipeEditToVideo, onPipeRefToVideo, onPipeImageToOutput, onPipeVideoToOutput, onPipeTweenToOutput, onPipeEditVideoToOutput, onPipeEditToOutput, onPipeRefToOutput, onTweenRefs, onOpenTweenTimeline: () => setTweenOpen(true), onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeTweenGen, onUnpipeEditGen, onUnpipeOutput, references, graphStyleConnected: shot.graphStyleConnected, graphVideoStyleConnected: shot.graphVideoStyleConnected, graphEditNodes: shot.graphEditNodes, graphOutputSource: shot.graphOutputSource, graphOutputRefId: shot.graphOutputRefId, graphOutputEditNodeId: shot.graphOutputEditNodeId, graphEditToVideo: shot.graphEditToVideo, graphVideoSourceRefId: shot.graphVideoSourceRefId, graphVideoSourceEditNodeId: shot.graphVideoSourceEditNodeId, graphTweenRefIds: shot.graphTweenRefIds, graphEditVideoSourceRefId: shot.graphEditVideoSourceRefId, graphVideoToEditVideo: shot.graphVideoToEditVideo, graphEditVideoPrompt: shot.graphEditVideoPrompt });
  cb.current = { graph: shot.graph, onPromptChange, onStyleChange, onToggleBrand, prompt, videoPromptValue, editPromptValues, editNodes, setLightbox, styles, styleValue, initialLayout, onStyleDetached, onRunImageGen, onRunVideoGen, onRunEditGen, onRunEditVideo, onEditNodePrompt, onRenameRef, onRunTweenBlock, onStitchTween, onSelectGraphGen, onCycleGraphGen, onDeleteGeneration, onSaveAsReference, onSaveGenerationAsReference, onGraphField, onPipeImageToVideo, onPipeEditToVideo, onPipeRefToVideo, onPipeImageToOutput, onPipeVideoToOutput, onPipeTweenToOutput, onPipeEditVideoToOutput, onPipeEditToOutput, onPipeRefToOutput, onTweenRefs, onOpenTweenTimeline: () => setTweenOpen(true), onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeTweenGen, onUnpipeEditGen, onUnpipeOutput, references, graphStyleConnected: shot.graphStyleConnected, graphVideoStyleConnected: shot.graphVideoStyleConnected, graphEditNodes: shot.graphEditNodes, graphOutputSource: shot.graphOutputSource, graphOutputRefId: shot.graphOutputRefId, graphOutputEditNodeId: shot.graphOutputEditNodeId, graphEditToVideo: shot.graphEditToVideo, graphVideoSourceRefId: shot.graphVideoSourceRefId, graphVideoSourceEditNodeId: shot.graphVideoSourceEditNodeId, graphTweenRefIds: shot.graphTweenRefIds, graphEditVideoSourceRefId: shot.graphEditVideoSourceRefId, graphVideoToEditVideo: shot.graphVideoToEditVideo, graphEditVideoPrompt: shot.graphEditVideoPrompt };
  // Live-draft handles registered by the three prompt nodes (see
  // PromptDraftApplier). Prompt mutations below prefer them over cb.current's
  // prop values, which lag the node's local draft while it is focused.
  const appliers = useRef<Record<string, PromptDraftApplier | undefined>>({});
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
    /** Collapse/expand a reference node: drop its height while collapsed (so the
     *  tile shrinks to the name) and restore it on expand, then persist the
     *  collapsed set in the graph layout. */
    onToggleRefCollapsed: (nodeId: string, collapsed: boolean) => {
      collapsedRef.current = { ...collapsedRef.current, [nodeId]: collapsed };
      const next = nodesRef.current.map((n): GraphNode => {
        if (n.id !== nodeId) return n;
        const ref = n as RefFlowNode;
        const style = (ref.style ?? {}) as { width?: number; height?: number };
        const width = ref.width ?? ref.measured?.width ?? style.width ?? 236;
        if (collapsed) {
          const liveHeight = ref.height ?? ref.measured?.height ?? style.height;
          if (typeof liveHeight === "number") refExpandedHeight.current[nodeId] = liveHeight;
          return { ...ref, height: undefined, style: { width }, data: { ...ref.data, collapsed: true } };
        }
        const height = refExpandedHeight.current[nodeId];
        return { ...ref, height, style: height ? { width, height } : { width }, data: { ...ref.data, collapsed: false } };
      });
      nodesRef.current = next;
      setNodes(next);
      saveLayoutRef.current({ collapsed: { ...collapsedRef.current } });
    },
    onZoom: (name: string, artwork: string, kind?: "image" | "video", rel?: string) => cb.current.setLightbox({ name, artwork, kind, rel }),
    onRunImageGen: (model: string, resolution: string, params?: GenParams) => cb.current.onRunImageGen(model, resolution, params),
    onRunVideoGen: (model: string, resolution: string, durationSec: number, params?: GenParams) => cb.current.onRunVideoGen(model, resolution, durationSec, params),
    onRunEditGen: (nodeId: string, model: string, resolution: string, params?: GenParams) => cb.current.onRunEditGen(nodeId, model, resolution, params),
    onRunEditVideo: (model: string, prompt: string, params?: GenParams) => cb.current.onRunEditVideo?.(model, prompt, params) ?? Promise.resolve(),
    onOpenTweenTimeline: () => cb.current.onOpenTweenTimeline(),
    onSelectImageGen: (index: number) => cb.current.onSelectGraphGen("image", index),
    onSelectVideoGen: (index: number) => cb.current.onSelectGraphGen("video", index),
    onSelectEditGen: (nodeId: string, index: number) => cb.current.onSelectGraphGen("edit", index, nodeId),
    onSelectEditVideoGen: (index: number) => cb.current.onSelectGraphGen("editvideo", index),
    onCycleImageGen: (dir: 1 | -1) => cb.current.onCycleGraphGen("image", dir),
    onCycleVideoGen: (dir: 1 | -1) => cb.current.onCycleGraphGen("video", dir),
    onCycleEditGen: (nodeId: string, dir: 1 | -1) => cb.current.onCycleGraphGen("edit", dir, nodeId),
    onCycleEditVideoGen: (dir: 1 | -1) => cb.current.onCycleGraphGen("editvideo", dir),
    onDeleteGen: (rel: string) => cb.current.onDeleteGeneration(rel),
    onSaveAsRef: (rel: string) => cb.current.onSaveAsReference(rel),
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
    onVideoPromptChange: (text: string) => cb.current.onGraphField({ graphVideoPrompt: stripSharedSections(text) }),
    onEditVideoPromptChange: (text: string) => cb.current.onGraphField({ graphEditVideoPrompt: stripSharedSections(text) }),
    /** Per-shot video-gen selections (model/resolution/length) → the shot. */
    onSaveVideoFields: (patch: Partial<ProductionShot>) => cb.current.onGraphField(patch),
    /** Per-shot edit-video selections → the shot. */
    onSaveEditVideoFields: (patch: Partial<ProductionShot>) => cb.current.onGraphField(patch),
    /** Per-node edit-gen selections → the named edit node in the list. */
    onEditNodeSave: (nodeId: string, patch: Partial<GraphEditNode>) =>
      cb.current.onGraphField({ graphEditNodes: (cb.current.graphEditNodes ?? []).map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) }),
    onEditPromptChange: (nodeId: string, text: string) => cb.current.onEditNodePrompt(nodeId, stripSharedSections(text)),
    onPipeImageToVideo: () => cb.current.onPipeImageToVideo(),
    onPipeEditToVideo: (nodeId: string) => cb.current.onPipeEditToVideo?.(nodeId),
    onPipeRefToVideo: (refId: string) => cb.current.onPipeRefToVideo?.(refId),
    onPipeImageToOutput: () => cb.current.onPipeImageToOutput(),
    onPipeVideoToOutput: () => cb.current.onPipeVideoToOutput(),
    onPipeTweenToOutput: () => cb.current.onPipeTweenToOutput(),
    onPipeEditVideoToOutput: () => cb.current.onPipeEditVideoToOutput?.(),
    onPipeEditToOutput: (nodeId: string) => cb.current.onPipeEditToOutput(nodeId),
    onPipeRefToOutput: (refId: string) => cb.current.onPipeRefToOutput(refId),
    onTweenRefs: (refIds: string[]) => cb.current.onTweenRefs(refIds),
    onUnpipeImageGen: () => cb.current.onUnpipeImageGen(),
    onUnpipeImageToVideo: () => cb.current.onUnpipeImageToVideo(),
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
    const node: RefFlowNode = {
      id,
      type: "ref",
      position: pos,
      style: { width: 236 },
      data: {
        name: ref.name,
        artwork: ref.artwork,
        media: ref.media,
        mediaUrl: ref.media === "video" && ref.mediaPath ? graphMediaUrl(prod.meta.id, ref.mediaPath) : undefined,
        tagged: false,
        refId: ref.id,
        collapsed: collapsedRef.current[id] === true,
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
        onGenerate: stable.onRunEditVideo,
        onSelect: stable.onSelectEditVideoGen,
        onCycle: stable.onCycleEditVideoGen,
        onDeleteGen: stable.onDeleteGen,
        onSaveAsRef: stable.onSaveAsRef,
        onSave: stable.onSaveEditVideoFields,
        onPipeToOutput: stable.onPipeEditVideoToOutput,
        onModelSchema: stable.onModelSchema,
        onZoom: stable.onZoom,
      },
      deletable: true,
    };
  }, [videoModels, videoEditModelIds, shot.graphEditVideoSourceRefId, shot.graphVideoToEditVideo, shot.graphEditVideoModel, shot.graphEditVideoParams, shot.graphEditVideoPrompt, shot.graphEditVideoGens, shot.graphEditVideoGenIndex, shot.graphOutputSource, references, prod.meta.id, editVideoBusy, stable]);

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

  /** Build the video tool node pair (videogen+videoprompt) at the given
   *  positions. Shared by buildDerived and addTool. */
  const videoPair = useCallback((genPos: { x: number; y: number }, promptPos: { x: number; y: number }): GraphNode[] => {
    return [
      {
        id: "videogen",
        type: "videogen",
        position: genPos,
        style: fixedWidth(300),
        data: {
          models: videoModels.filter((m) => modelOnSurface(m, "video:generate")),
          savedModel: shot.graphVideoModel,
          savedResolution: shot.graphVideoResolution,
          savedDurationSec: shot.graphVideoDurationSec,
          savedParams: shot.graphVideoParams,
          items: (shot.graphVideoGens ?? []).map((g) => ({ url: graphMediaUrl(prod.meta.id, g.path), prompt: g.prompt, path: g.path })),
          selected: shot.graphVideoGenIndex ?? 0,
          hasImageSource: shot.graphImageToVideo === true || shot.graphEditToVideo === true || !!shot.graphVideoSourceRefId,
          busy: videoGenBusy === true,
          onGenerate: stable.onRunVideoGen,
          onSelect: stable.onSelectVideoGen,
          onCycle: stable.onCycleVideoGen,
          onDeleteGen: stable.onDeleteGen,
          onSaveAsRef: stable.onSaveAsRef,
          onModelOptions: stable.onModelOptions,
          onModelSchema: stable.onModelSchema,
          onSaveFields: stable.onSaveVideoFields,
          onZoom: stable.onZoom,
        },
        deletable: true,
      },
      {
        id: "videoprompt",
        type: "videoprompt",
        position: promptPos,
        data: { value: videoPromptValue, refHandles: taggedVideo.map((_, i) => `in-ref-${i}`), openHandleId: "in-ref-open", includeBrand: isBrandAttached(shot, "videoprompt", videoPromptValue), onChange: stable.onVideoPromptChange, registerApplier: (a) => stable.registerApplier("video", a) },
        deletable: true,
      },
    ];
  }, [videoModels, shot.graphVideoGens, shot.graphVideoGenIndex, shot.graphVideoModel, shot.graphVideoResolution, shot.graphVideoDurationSec, shot.graphVideoParams, shot.graphImageToVideo, shot.graphEditToVideo, shot.graphVideoSourceRefId, videoPromptValue, taggedVideo, stable, prod.meta.id, videoGenBusy]);

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
          busy: editBusyNodeIds.includes(editNode.id),
          onGenerate: stable.onRunEditGen,
          onSelect: (index: number) => stable.onSelectEditGen(editNode.id, index),
          onCycle: (dir: 1 | -1) => stable.onCycleEditGen(editNode.id, dir),
          onDeleteGen: stable.onDeleteGen,
          onSaveAsRef: stable.onSaveAsRef,
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
  const addTool = useCallback((kind: "video" | "edit" | "tween" | "editvideo", pos: { x: number; y: number }) => {
    const genPos = { x: pos.x, y: pos.y };
    const promptPos = { x: pos.x - 400, y: pos.y };
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
    const present = kind === "video" ? hasVideoTool : hasTweenTool;
    if (present) {
      showHint(kind === "video" ? "The video generation node is already on the canvas." : "The in-betweener node is already on the canvas.");
      return;
    }
    const pair: GraphNode[] = kind === "tween" ? [tweenNode(genPos)] : videoPair(genPos, promptPos);
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
      saveGraph(kind === "video" ? ensurePromptPipe(g, "videogen") : g);
    }
    showHint(kind === "video" ? "Video generation node added — connect a frame or reference in, then generate." : "In-betweener added — pipe 2–5 keyframes (references or generated frames) into its sockets, then open the timeline.");
  }, [editNodes, hasVideoTool, hasTweenTool, hasEditVideoTool, showHint, editPair, videoPair, tweenNode, editVideoPair]);

  /** Remove the placed video/tween/edit-video tool from the canvas (returns it
   *  to the right panel). Tools that are in use (generations/pipes/prompt) stay. */
  const removeTool = useCallback((kind: "video" | "tween" | "editvideo") => {
    const ids = kind === "video" ? ["videogen", "videoprompt"]
      : kind === "editvideo" ? ["editvideo", "editvideoprompt"]
      : [kind];
    if (kind === "video" ? videoGenActive : kind === "tween" ? tweenActive : editVideoActive) return;
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
  }, [videoGenActive, tweenActive, editVideoActive]);

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
          data: { name: r.name, artwork: r.artwork, media: r.media, mediaUrl: r.media === "video" && r.mediaPath ? graphMediaUrl(prod.meta.id, r.mediaPath) : undefined, tagged: false, refId: r.id, collapsed, onToggleCollapse: stable.onToggleRefCollapsed, onRename: stable.onRenameRef, onZoom: stable.onZoom },
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
            const sel = shot.graphVideoGens?.[shot.graphVideoGenIndex ?? 0];
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
          onModelSchema: stable.onModelSchema,
          onSaveFields: stable.onSaveVideoFields,
          onZoom: stable.onZoom,
        },
        deletable: false,
      }),
      ...(hasVideoTool ? videoPair(ORIGIN, ORIGIN).map((n) => build(n)) : []),
      ...editNodes.flatMap((n) => editPair(n, ORIGIN, ORIGIN).map((node) => build(node))),
      ...(hasTweenTool ? [build(tweenNode(ORIGIN))] : []),
      ...(hasEditVideoTool ? editVideoPair(ORIGIN, ORIGIN).map((n) => build(n)) : []),
    ];
  }, [unionTagged, tagged, taggedVideo, available, availIds, taggedIds, stable, styles, styleValue, includeBrand, magicActive, prompt, videoPromptValue, thumbnail, editNodes, editPromptValues, taggedEditByNode, shot.number, shot.artworkHistory, prod.meta.id, prod.openArt?.model, prod.openArt?.resolution, prod.openArt?.quality, shot.graphImageGens, shot.graphImageGenIndex, shot.graphImageParams, shot.graphVideoGens, shot.graphVideoGenIndex, shot.graphImageToVideo, shot.graphEditToVideo, shot.graphVideoSourceEditNodeId, shot.graphTweenRefIds, shot.graphTweenBlocks, shot.graphTweenModel, shot.graphTweenResolution, shot.graphTweenOutput, shot.graphTweenReencoded, shot.graphOutputSource, shot.graphOutputRefId, shot.graphOutputEditNodeId, imageModels, videoModels, references, hasVideoTool, hasTweenTool, hasEditVideoTool, videoPair, editPair, tweenNode, editVideoNode, editVideoPair, taggedEditVideo, editVideoPromptValue, imageGenBusy, videoGenBusy, editVideoBusy, editBusyNodeIds, initialLayout, initialLayout?.sizes?.output?.width, initialLayout?.sizes?.output?.height]);

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
      else if (d.type === "editgen") equal = (a.sourceHint as string) === (b.sourceHint as string) && (a.selected as number) === (b.selected as number) && sameGenItems(a.items, b.items) && (a.busy as boolean) === (b.busy as boolean);
      else if (d.type === "videoprompt") equal = (a.value as string) === (b.value as string) && (a.includeBrand as boolean) === (b.includeBrand as boolean) && (a.refHandles as string[]).length === (b.refHandles as string[]).length && (a.refHandles as string[]).every((v, i) => v === (b.refHandles as string[])[i]) && (a.openHandleId as string) === (b.openHandleId as string);
      else if (d.type === "editprompt") equal = (a.value as string) === (b.value as string) && (a.includeBrand as boolean) === (b.includeBrand as boolean) && (a.refHandles as string[]).length === (b.refHandles as string[]).length && (a.refHandles as string[]).every((v, i) => v === (b.refHandles as string[])[i]) && (a.openHandleId as string) === (b.openHandleId as string);
      else if (d.type === "style") equal = (a.value as string) === (b.value as string);
      else if (d.type === "brand") equal = (a.include as boolean) === (b.include as boolean);
      else if (d.type === "ref") equal = (a.name as string) === (b.name as string) && (a.artwork as string) === (b.artwork as string) && (a.tagged as boolean) === (b.tagged as boolean) && (a.missing as boolean) === (b.missing as boolean) && (a.collapsed as boolean) === (b.collapsed as boolean);
      else if (d.type === "frame") equal = (a.previewUrl as string) === (b.previewUrl as string) && (a.previewKind as string) === (b.previewKind as string) && (a.bound as boolean) === (b.bound as boolean);
      else if (d.type === "imagegen") equal = (a.selected as number) === (b.selected as number) && sameGenItems(a.items, b.items) && (a.busy as boolean) === (b.busy as boolean);
      else if (d.type === "editvideo") equal = (a.selected as number) === (b.selected as number) && sameGenItems(a.items, b.items) && (a.busy as boolean) === (b.busy as boolean) && (a.piped as boolean) === (b.piped as boolean) && (a.sourceLabel as string | null) === (b.sourceLabel as string | null);
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
  // Wiring truth: the stored graph. Pre-migration shots have no graph until
  // the ensure effect persists one — materialize in memory so the first
  // paint already matches, with no flash of an empty canvas.
  const fallbackGraph = useMemo(() => {
    if (shot.graph) return null;
    return normalizeGraph(materializeGraph(shot, references)).graph;
  }, [shot, references]);
  const wiringGraph = shot.graph ?? fallbackGraph;
  const edges = useMemo<Edge[]>(() => {
    if (!wiringGraph) return [];
    return graphEdgesToFlow(wiringGraph, { selected: selectedEdges, colors: SOCKET_COLORS });
  }, [wiringGraph, selectedEdges]);

  // Ensure every opened shot owns a stored graph: legacy shots materialize on
  // first open (load migration skips v2 files), and drift from manual prompt
  // edits heals here — connect-time writes keep the graph live mid-session.
  // Persist-if-different so a settled shot saves nothing.
  const ensuredGraphFor = useRef<string | null>(null);
  useEffect(() => {
    const key = `${prod.meta.id}:${shot.id}`;
    if (ensuredGraphFor.current === key) return;
    ensuredGraphFor.current = key;
    const fresh = normalizeGraph(materializeGraph(shot, references)).graph;
    fresh.migrated = true;
    if (JSON.stringify(shot.graph) !== JSON.stringify(fresh)) {
      onGraphField({ graph: fresh });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prod.meta.id, shot.id]);

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
    for (const c of removed) {
      if (c.id === "videogen" || c.id === "videoprompt") { if (videoGenActive) blockedToolIds.add(c.id); }
      else if (c.id === "tween") { if (tweenActive) blockedToolIds.add(c.id); }
    }
    if (blockedToolIds.size > 0) {
      showHint("This node is in use (clips or pipes) — clear its generations or pipes before removing it.");
      removed = removed.filter((c) => !blockedToolIds.has(c.id));
      changes = changes.filter((c) => c.type !== "remove" || !blockedToolIds.has(c.id));
    }
    // Deleting either node of an inactive video tool pair removes BOTH,
    // returning the unit to the right panel as one tile.
    const toolKindRemoved = new Set<"video" | "tween">();
    const toolNodeIds = new Set<string>();
    for (const c of removed) {
      if (c.id === "videogen" || c.id === "videoprompt") toolKindRemoved.add("video");
      else if (c.id === "tween") toolKindRemoved.add("tween");
    }
    if (toolKindRemoved.has("video")) { toolNodeIds.add("videogen"); toolNodeIds.add("videoprompt"); }
    if (toolKindRemoved.has("tween")) { toolNodeIds.add("tween"); }

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
    if (toolKindRemoved.has("video")) {
      setPlacedTools((prev) => { const n = new Set(prev); n.delete("videogen"); n.delete("videoprompt"); return n; });
    }
    if (toolKindRemoved.has("tween")) {
      setPlacedTools((prev) => { const n = new Set(prev); n.delete("tween"); return n; });
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
        const freshVideo = appliers.current["video"]?.get() ?? cb.current.videoPromptValue;
        if (refTagNames(freshVideo).some((n) => n.toLowerCase() === entry.name.toLowerCase())) {
          if (!applyDraftEdit("video", strip)) cb.current.onGraphField({ graphVideoPrompt: strip(cb.current.videoPromptValue) });
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
  }, [videoGenActive, tweenActive, showHint, flushPosChanges]);

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
        // Reference edges are deletable via keyboard (select+Delete) —
        // ids are `e-<refId>-<target>-<idx>` for the prompt nodes.
        const m = /^e-(.+)-(composer|videoprompt|editvideoprompt|editprompt(?::[^:]+)?)-(\d+)$/.exec(c.id);
        if (m) {
          const [, , targetKind, idxStr] = m;
          const idx = Number(idxStr);
          if (targetKind === "composer") {
            const entry = tagged[idx];
            if (entry) { if (!applyDraftEdit("composer", (t) => removeRefTag(t, entry.name))) onPromptChange(removeRefTag(prompt, entry.name)); }
          } else if (targetKind === "videoprompt") {
            const fresh = appliers.current["video"]?.get() ?? cb.current.videoPromptValue;
            const name = refTagNames(fresh)[idx] ?? taggedVideo[idx]?.name;
            if (name) {
              if (!applyDraftEdit("video", (t) => removeRefTag(t, name))) cb.current.onGraphField({ graphVideoPrompt: removeRefTag(cb.current.videoPromptValue, name) });
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
    if (target === "composer") {
      if (!applyDraftEdit("composer", place)) cb.current.onPromptChange(place(cb.current.prompt));
    } else if (target === "videoprompt") {
      if (!applyDraftEdit("video", place)) cb.current.onGraphField({ graphVideoPrompt: place(cb.current.videoPromptValue) });
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
        if (conn.source === "videogen") { cb.current.onGraphField({ graphVideoToEditVideo: true, graphEditVideoSourceRefId: undefined }); return; }
        const rid = /^ref:(.+)$/.exec(conn.source)?.[1];
        const ref = rid ? references.find((r) => r.id === rid) : undefined;
        if (ref && ref.media === "video") { cb.current.onGraphField({ graphEditVideoSourceRefId: rid, graphVideoToEditVideo: undefined }); return; }
      }
      return;
    }
    // Generation pipes: the image node's output feeds the video/edit image
    // inputs and/or the output (both can coexist); the video/edit nodes feed
    // the output; a reference can feed the output or an edit node's source.
    if (conn.source === "imagegen") {
      if (conn.target === "videogen") { cb.current.onPipeImageToVideo(); return; }
      if (conn.target === "output") { cb.current.onPipeImageToOutput(); return; }
      if (tgtEditId && conn.targetHandle === "in-image") { patchEditNode(tgtEditId, { source: { kind: "imagegen" } }); return; }
      if (wireTweenKeyframe(TWEEN_KEY_IMGGEN)) return;
    }
    if (conn.source === "videogen") { if (conn.target === "output") { cb.current.onPipeVideoToOutput(); return; } }
    if (conn.source === "tween") { if (conn.target === "output") { cb.current.onPipeTweenToOutput(); return; } }
    if (srcEditId) {
      // An edit node's output can feed the video source, the output, another
      // edit node's source, or a tween keyframe.
      if (conn.target === "videogen" && conn.targetHandle === "in-image") { cb.current.onPipeEditToVideo(srcEditId); return; }
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
      if (conn.target === "videogen" && conn.targetHandle === "in-image") {
        cb.current.onPipeRefToVideo(refId);
        return;
      }
      if (tgtEditId && conn.targetHandle === "in-image") {
        patchEditNode(tgtEditId, { source: { kind: "ref", refId } });
        return;
      }
    }
    // Prompt nodes: style / brand / reference inputs — exactly like composer.
    const isComposer = conn.target === "composer";
    const isVideo = conn.target === "videoprompt";
    const isEditVideoPrompt = conn.target === "editvideoprompt";
    const editPromptId = conn.target === "editprompt" ? "edit0" : conn.target.startsWith(EDITPROMPT_NODE_PREFIX) ? conn.target.slice(EDITPROMPT_NODE_PREFIX.length) : null;
    if (isComposer || isVideo || isEditVideoPrompt || editPromptId) {
      const editCur = editPromptId ? (cb.current.editPromptValues.get(editPromptId) ?? "") : "";
      const applyEdit = (fn: (t: string) => string) => {
        if (!editPromptId) return;
        if (!applyDraftEdit(`edit:${editPromptId}`, fn)) cb.current.onEditNodePrompt(editPromptId, fn(editCur));
      };
      const applyVideo = (fn: (t: string) => string) => {
        if (!applyDraftEdit("video", fn)) cb.current.onGraphField({ graphVideoPrompt: fn(cb.current.videoPromptValue) });
      };
      const applyEditVideo = (fn: (t: string) => string) => {
        if (!applyDraftEdit("editvideo", fn)) cb.current.onGraphField({ graphEditVideoPrompt: fn(cb.current.graphEditVideoPrompt ?? "") });
      };
      if (conn.source === "style") {
        // The edge (written above) is the plug; no paragraph is pasted. The
        // legacy flag still mirrors it for graph-less rebuilds (projection).
        if (isComposer) cb.current.onGraphField({ graphStyleConnected: true });
        else if (isVideo) cb.current.onGraphField({ graphVideoStyleConnected: true });
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
    if (source === "videoprompt") return c.target === "videogen" && c.targetHandle === "in-prompt";
    if (source === "editvideoprompt") return c.target === "editvideo" && c.targetHandle === "in-prompt";
    if (source === "composer") return c.target === "imagegen" && c.targetHandle === "in-prompt";
    const srcEditId = parseEditGenNode(source);
    const tgtEditId = parseEditGenNode(c.target ?? "");
    // Edit-video node: the source socket takes a video node clip or a video
    // reference. References ride the edit-video prompt node's sockets.
    if (c.target === "editvideo") {
      if (c.targetHandle === "in-video") {
        if (source === "videogen") return true;
        const rid = /^ref:(.+)$/.exec(source)?.[1];
        const ref = rid ? references.find((r) => r.id === rid) : undefined;
        return !!ref && ref.media === "video";
      }
      return false;
    }
    const editPromptId = source === "editprompt" ? "edit0" : source.startsWith(EDITPROMPT_NODE_PREFIX) ? source.slice(EDITPROMPT_NODE_PREFIX.length) : null;
    const targetEditPrompt = c.target === "editprompt" || (c.target ?? "").startsWith(EDITPROMPT_NODE_PREFIX);
    if (editPromptId) return parseEditGenNode(c.target ?? "") === editPromptId && c.targetHandle === "in-prompt";
    if (source === "imagegen") {
      if (c.target === "videogen") return c.targetHandle === "in-image";
      if (tgtEditId) return c.targetHandle === "in-image";
      if (c.target === "output") return c.targetHandle === "in-out";
      if (c.target === "tween") return tweenSlotOk(TWEEN_KEY_IMGGEN);
      return false;
    }
    if (source === "videogen") return c.target === "output" && c.targetHandle === "in-out";
    if (source === "tween") return c.target === "output" && c.targetHandle === "in-out";
    if (srcEditId) {
      // An edit node's image output feeds every image input: the video node's
      // source, the output, another edit node's source (cycle-checked), and the
      // in-betweener keyframes.
      if (c.target === "videogen") return c.targetHandle === "in-image";
      if (c.target === "output") return c.targetHandle === "in-out";
      if (tgtEditId && c.targetHandle === "in-image") return tgtEditId !== srcEditId && !editNodeDependsOnClient(shot, srcEditId, tgtEditId);
      if (c.target === "tween") return tweenSlotOk(`${TWEEN_KEY_EDITGEN_PREFIX}${srcEditId}`);
      return false;
    }
    const refId = /^ref:(.+)$/.exec(source)?.[1];
    if (refId) {
      const ref = references.find((r) => r.id === refId);
      if (c.target === "output") return c.targetHandle === "in-out" && !!ref && ref.media !== "audio";
      if (c.target === "videogen") return c.targetHandle === "in-image" && !!ref && !!ref.artwork && ref.media !== "audio";
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
      if (c.target === "composer" || c.target === "videoprompt" || c.target === "editvideoprompt" || targetEditPrompt) {
        // The open socket appends; dropping onto an occupied reference socket
        // replaces the reference in that slot (same type — an image/any ref).
        return (c.targetHandle === "in-ref-open" || /^in-ref-\d+$/.test(c.targetHandle ?? "")) && !!ref;
      }
      return false;
    }
    if (c.target === "composer" || c.target === "videoprompt" || c.target === "editvideoprompt" || targetEditPrompt) {
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
      if (nodeId === "composer") {
        if (handleId === "in-style") {
          // The edge is removed above (graphEdgesForDetach); the section
          // disappears on the next render — no stored text to strip.
          cb.current.onGraphField({ graphStyleConnected: false, style: undefined, styleNone: true });
          return true;
        }
        if (handleId === "in-brand") { cb.current.onToggleBrand(false); return true; }
        const m = /^in-ref-(\d+)$/.exec(handleId);
        if (m) { const t = tagged[Number(m[1])]; if (t && !applyDraftEdit("composer", (cur) => removeRefTag(cur, t.name))) cb.current.onPromptChange(removeRefTag(cb.current.prompt, t.name)); return true; }
      } else if (nodeId === "videoprompt") {
        const applyVideo = (fn: (t: string) => string) => { if (!applyDraftEdit("video", fn)) cb.current.onGraphField({ graphVideoPrompt: fn(cb.current.videoPromptValue) }); };
        if (handleId === "in-style") { cb.current.onGraphField({ graphVideoStyleConnected: false }); return true; }
        if (handleId === "in-brand") return true;
        const m = /^in-ref-(\d+)$/.exec(handleId);
        if (m) {
          const idx = Number(m[1]);
          const fresh = appliers.current["video"]?.get() ?? cb.current.videoPromptValue;
          const freshName = refTagNames(fresh)[idx];
          const t = freshName ?? taggedVideo[idx]?.name;
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
    if (from.type === "target" && (from.nodeId === "composer" || from.nodeId === "videoprompt" || from.nodeId === "editprompt" || (from.nodeId ?? "").startsWith(EDITPROMPT_NODE_PREFIX))) {
      if (detachPrompt(from.nodeId ?? "", from.id ?? "")) return;
    }
    if (from.type === "target" && from.nodeId === "videogen" && from.id === "in-image") {
      cb.current.onUnpipeImageToVideo();
      return;
    }
    if (from.type === "target") {
      const editId = parseEditGenNode(from.nodeId ?? "");
      if (editId && from.id === "in-image") {
        cb.current.onGraphField({ graphEditNodes: (cb.current.graphEditNodes ?? []).map((n) => (n.id === editId ? { ...n, source: undefined } : n)) });
        return;
      }
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
      cb.current.onUnpipeImageGen();
      return;
    }
    if (from.type === "source" && from.nodeId === "videogen") {
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
        cb.current.onUnpipeEditGen(editSrcId);
        return;
      }
    }
    if (from.type === "source") {
      if (from.nodeId === "style") {
        // The style edge(s) were removed above; clear the legacy plug flags and
        // the shot selection. No stored paragraphs exist to strip (step 04).
        const editNodesNext = (cb.current.graphEditNodes ?? []).map((n) => (n.styleConnected ? { ...n, styleConnected: false } : n));
        cb.current.onGraphField({
          graphStyleConnected: false,
          graphVideoStyleConnected: false,
          style: undefined,
          styleNone: true,
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
      const videoName = findName(taggedVideo);
      if (videoName) {
        if (!applyDraftEdit("video", (t) => removeRefTag(t, videoName))) {
          if (refTagNames(cb.current.videoPromptValue).some((n) => n.toLowerCase() === videoName.toLowerCase())) cb.current.onGraphField({ graphVideoPrompt: removeRefTag(cb.current.videoPromptValue, videoName) });
        }
      }
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
        const freshVideo = appliers.current["video"]?.get() ?? cb.current.videoPromptValue;
        if (refTagNames(freshVideo).some((n) => n.toLowerCase() === unionEntry.name.toLowerCase())) { if (!applyDraftEdit("video", (t) => removeRefTag(t, unionEntry.name))) cb.current.onGraphField({ graphVideoPrompt: removeRefTag(cb.current.videoPromptValue, unionEntry.name) }); }
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
    if (toolKind === "video" || toolKind === "edit" || toolKind === "tween" || toolKind === "editvideo") {
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
      <div className={"prod-graph-panel" + (magicActive ? " magic-active" : "")} onClick={(e) => e.stopPropagation()}>
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
              title="Regenerate Magic Prompts (AI will re-generate all content prompts)"
            >
              <RegenerateIcon size={13} />
            </button>
          )}
          <button className="prod-btn" onClick={onClose}>Close</button>
        </div>
        <div className="prod-graph-body">
          <div className={"prod-graph-shelf" + (shelfOpen ? "" : " collapsed")}>
            {shelfOpen ? (
              <>
                <div className="prod-graph-shelf-head">
                  <div className="prod-graph-shelf-head-row">
                    <button
                      type="button"
                      className="prod-graph-shelf-toggle nodrag"
                      aria-expanded={true}
                      title="Collapse the reference shelf"
                      onClick={() => setShelfOpen(false)}
                    >
                      <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M10 3L5 8l5 5V3z" fill="currentColor" /></svg>
                    </button>
                    <span className="prod-graph-shelf-title">References</span>
                  </div>
                  <span className="prod-graph-shelf-hint">Drag onto the canvas to add</span>
                  {references.length > 0 && (
                    <input
                      className="prod-graph-shelf-search nodrag"
                      type="text"
                      value={shelfQuery}
                      onChange={(e) => setShelfQuery(e.target.value)}
                      placeholder="Filter references…"
                      aria-label="Filter references"
                    />
                  )}
                </div>
                <div className="prod-graph-shelf-list">
                  {shelfGroups.map((group) => (
                    <ShelfGroup key={group.title} prodId={prod.meta.id} group={group} query={shelfQuery} onCanvasRefIds={onCanvasRefIds} />
                  ))}
                  {references.length === 0 && <div className="prod-graph-shelf-empty">No references yet — drop image, video, or audio files onto the canvas to create them.</div>}
                  {references.length > 0 && shelfGroups.every((g) => qShelfMatch(g.refs, shelfQuery).length === 0) && (
                    <div className="prod-graph-shelf-empty">No references match “{shelfQuery.trim()}”.</div>
                  )}
                </div>
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
              onContextMenu={(e) => { if (lightbox.rel) lightboxMenu.open(e, lightbox.rel); }}
            >
              <figure className="prod-ref-lightbox-card">
                {lightbox.kind === "video" ? (
                  <video className="prod-ref-lightbox-video" src={lightbox.artwork} controls autoPlay playsInline />
                ) : (
                  <img src={lightbox.artwork} alt={lightbox.name} />
                )}
                <figcaption>{lightbox.name} — click anywhere to close{lightbox.rel ? " — right-click to save as a reference" : ""}</figcaption>
              </figure>
            </div>
          )}
          <GenerationMenu menu={lightboxMenu.menu} onClose={lightboxMenu.close} onSaveAsReference={onSaveAsReference} />
          </div>
          <div className="prod-graph-tools">
            <div className="prod-graph-tools-head">
              <span className="prod-graph-tools-title">Nodes</span>
              <span className="prod-graph-tools-hint">Drag onto the canvas to add</span>
            </div>
            <div className="prod-graph-tools-list">
              <div
                className={"prod-graph-tools-item" + (hasVideoTool ? " on-canvas" : "")}
                draggable={!hasVideoTool}
                title={hasVideoTool ? "Already on the canvas" : "Drag onto the canvas to add the video generation node"}
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-cascade-tool", "video");
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                <FilmStripIcon size={14} className="prod-graph-tools-icon" />
                <span className="prod-graph-tools-label">Video generation</span>
                {hasVideoTool && (
                  <button
                    className="prod-graph-tools-remove"
                    disabled={videoGenActive}
                    title={videoGenActive ? "In use — has clips or pipes" : "Remove from the canvas"}
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
                className={"prod-graph-tools-item" + (hasEditVideoTool ? " on-canvas" : "")}
                draggable={!hasEditVideoTool}
                title={hasEditVideoTool ? "Already on the canvas" : "Drag onto the canvas to add the edit-video node"}
                onDragStart={(e) => {
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
          onSaveAsRef={onSaveAsReference}
          onRunBlock={(blockId: string, durationSec: number, model: string, params?: GenParams) => onRunTweenBlock(blockId, durationSec, model, params)}
          busyBlock={busyBlock}
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
    </div>
  );
}
