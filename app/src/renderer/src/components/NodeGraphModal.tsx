/**
 * Storyboard node graph: a visual projection of one shot's board prompt.
 *
 * The prompt text (with its `@[Name]` reference tags) stays the single source
 * of truth — every interaction here (connect a reference, delete an edge, edit
 * the composer textarea) just rewrites that text through the same serialized
 * save flow as the side panel, so the generation pipeline, history, and the
 * prompts-export fallback are untouched.
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  ConnectionLineType,
  Handle,
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
import type { GraphGenItem, GraphLayout, OpenArtModelChoice, Production, ProductionShot, ProductionStyle, VideoModelOptions } from "../../../shared/ipc.js";
import { TriplePrompt } from "./TriplePrompt.js";

/** Default motion prompt for the video-prompt node (matches the video panel). */
export const VIDEO_PROMPT_DEFAULT = "Animate this reference image with smooth, cinematic motion.";

/** cascade-media URL for any workspace-relative asset in the production. */
function graphMediaUrl(prodId: string, rel: string): string {
  return `cascade-media://${prodId}/${encodeURIComponent(rel)}`;
}

/** Per-model/per-mode cache for video form options — the MCP form lookup is
 *  slow, and nodes re-render often, so fetch each combination once. */
const videoOptionsCache = new Map<string, VideoModelOptions | null>();

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
/* Prompt tag helpers                                                  */
/* ------------------------------------------------------------------ */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Append an `@[Name]` tag beneath the content paragraphs — before the
 *  generated `Brand identity:` section when one is present, so tags never
 *  land after the brand. Idempotent (case-insensitive). */
export function addRefTag(prompt: string, name: string): string {
  const tag = `@[${name}]`;
  if (new RegExp(`@\\[${escapeRegExp(name)}\\]`, "i").test(prompt)) return prompt;
  const brand = /(?:^|\n\n)Brand identity: /.exec(prompt);
  if (brand) {
    const start = brand.index + (brand[0].startsWith("\n\n") ? 2 : 0);
    const before = prompt.slice(0, start).trimEnd();
    const after = prompt.slice(start);
    return before ? `${before}\n\n${tag}\n\n${after}` : `${tag}\n\n${after}`;
  }
  const base = prompt.trimEnd();
  return base ? `${base}\n\n${tag}` : tag;
}

/** Remove every `@[Name]` occurrence and tidy up leftover blank lines. */
export function removeRefTag(prompt: string, name: string): string {
  return prompt.replace(new RegExp(`@\\[${escapeRegExp(name)}\\]`, "gi"), "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Paragraph-scoped `Style:` section — same shape updateShotStyle writes. */
const STYLE_PARA_RE = /(?:^|\n\n)Style:[\s\S]*?(?=\n\n|$)/;

/** Insert (or replace) the leading `Style:` paragraph. */
function addStyleParagraph(prompt: string, styleText: string): string {
  if (!styleText) return prompt;
  const para = `Style: ${styleText}`;
  const rest = prompt.replace(STYLE_PARA_RE, "").trim();
  return rest ? `${para}\n\n${rest}` : para;
}

/** Remove the `Style:` paragraph entirely (style node detached). */
function removeStyleParagraph(prompt: string): string {
  return prompt.replace(STYLE_PARA_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/* ------------------------------------------------------------------ */
/* Node data shapes                                                    */
/* ------------------------------------------------------------------ */

interface RefData extends Record<string, unknown> {
  name: string;
  artwork: string;
  /** Playable cascade-media URL for video references. */
  mediaUrl?: string;
  /** false = tag present in the prompt but no matching reference (dangling). */
  missing?: boolean;
  tagged: boolean;
  onToggle: (name: string, tagged: boolean) => void;
  /** Open the reference image in a lightbox (image refs only). */
  onZoom: (name: string, artwork: string) => void;
}
type RefFlowNode = Node<RefData, "ref">;

interface ComposerData extends Record<string, unknown> {
  value: string;
  /** One dedicated input-socket id per connected reference, in prompt order. */
  refHandles: string[];
  /** Always-open reference socket so new nodes can always be attached. */
  openHandleId: string;
  /** Whether the brand section currently exists (drives the Brand box). */
  includeBrand: boolean;
  onChange: (value: string) => void;
}
type ComposerFlowNode = Node<ComposerData, "composer">;

interface StyleData extends Record<string, unknown> {
  styles: ProductionStyle[];
  value: string;
  onChange: (style: string) => void;
}
type StyleFlowNode = Node<StyleData, "style">;

interface BrandData extends Record<string, unknown> {
  include: boolean;
  onToggle: (include: boolean) => void;
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
  /** Every stored generation (newest first) as media URLs. */
  items: { url: string; prompt: string }[];
  selected: number;
  onGenerate: (model: string, resolution: string) => Promise<void>;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
}
type ImageGenFlowNode = Node<ImageGenData, "imagegen">;

interface VideoGenData extends Record<string, unknown> {
  models: OpenArtModelChoice[];
  items: { url: string; prompt: string }[];
  selected: number;
  hasImageSource: boolean;
  /** One dedicated input-socket id per connected additional reference, in
   *  connection order (ids are `in-vref-<i>`). */
  refHandles: { id: string; name: string }[];
  /** Always-open reference socket so new refs can always be attached. */
  openHandleId: string;
  onGenerate: (model: string, resolution: string, durationSec: number) => Promise<void>;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
  onModelOptions: (model: string, withImage: boolean) => Promise<VideoModelOptions | null>;
}
type VideoGenFlowNode = Node<VideoGenData, "videogen">;

interface VideoPromptData extends Record<string, unknown> {
  value: string;
  onChange: (text: string) => void;
}
type VideoPromptFlowNode = Node<VideoPromptData, "videoprompt">;

type GraphNode = RefFlowNode | ComposerFlowNode | StyleFlowNode | BrandFlowNode | OutputFlowNode | ImageGenFlowNode | VideoGenFlowNode | VideoPromptFlowNode;

/* ------------------------------------------------------------------ */
/* Custom node views                                                   */
/* ------------------------------------------------------------------ */

const RefNodeView = memo(function RefNodeView({ data }: NodeProps<RefFlowNode>) {
  return (
    <div className={"prod-graph-node prod-graph-ref" + (data.tagged ? "" : " avail") + (data.missing ? " missing" : "")}>
      <Handle type="source" position={Position.Right} className="socket-ref" />
      {data.artwork
        ? <img src={data.artwork} alt={data.name} draggable={false} />
        : data.media === "video" && data.mediaUrl
          ? <video className="prod-graph-ref-video" src={data.mediaUrl} muted loop playsInline preload="metadata" onMouseEnter={(e) => { try { e.currentTarget.play(); } catch {} }} onMouseLeave={(e) => { try { e.currentTarget.pause(); } catch {} }} draggable={false} />
          : data.media
            ? <div className="prod-graph-ref-blank" title={data.media === "audio" ? "Audio reference" : "Video reference"}>{data.media === "audio" ? "♪" : "▶"}</div>
            : <div className="prod-graph-ref-blank" title="Reference has no image">?</div>}
      <div className="prod-graph-ref-meta">
        <span className="prod-graph-ref-name" title={data.missing ? "No reference with this name exists (anymore)" : `Reference @[${data.name}]`}>@[{data.name}]</span>
        <div className="prod-graph-ref-actions">
          {data.artwork && (
            <button
              className="prod-graph-ref-zoom nodrag"
              title="View larger"
              onClick={() => data.onZoom(data.name, data.artwork)}
            >
              <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><line x1="10" y1="10" x2="14.5" y2="14.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </button>
          )}
          <button
            className="prod-graph-ref-btn nodrag"
            title={data.tagged ? "Remove this reference from the prompt" : "Add this reference to the prompt"}
            onClick={() => data.onToggle(data.name, data.tagged)}
          >
            {data.tagged ? "×" : "＋"}
          </button>
        </div>
      </div>
    </div>
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
  const n = data.refHandles.length + 1;
  const total = n + 2;
  const sockets: { id: string; kind: "ref" | "style" | "brand"; open: boolean; label: string; top: number }[] = [
    { id: "in-style", kind: "style", open: false, label: "Style", top: (1 / (total + 1)) * 100 },
    ...data.refHandles.map((id, i) => ({ id, kind: "ref" as const, open: false, label: "Reference", top: ((i + 2) / (total + 1)) * 100 })),
    { id: data.openHandleId, kind: "ref", open: true, label: "Reference", top: ((n + 1) / (total + 1)) * 100 },
    { id: "in-brand", kind: "brand", open: false, label: "Brand", top: (total / (total + 1)) * 100 },
  ];
  return (
    <div className="prod-graph-node prod-graph-composer">
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
      <div className="prod-graph-node-title">Prompt</div>
      <TriplePrompt
        className="prod-graph-composer-text nodrag nowheel"
        sideRows={3}
        resizable
        value={data.value}
        includeBrand={data.includeBrand}
        placeholder="Describe the frame — connect references, type @, or edit the boxes"
        onChange={data.onChange}
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

const BrandNodeView = memo(function BrandNodeView({ data }: NodeProps<BrandFlowNode>) {
  return (
    <div className="prod-graph-node prod-graph-brand">
      <div className="prod-graph-node-title">Brand identity</div>
      <label className="prod-brand-toggle nodrag">
        <input type="checkbox" checked={data.include} onChange={(e) => data.onToggle(e.target.checked)} />
        Include in prompt
      </label>
      <Handle type="source" position={Position.Right} className="socket-brand" />
    </div>
  );
});

const OutputNodeView = memo(function OutputNodeView({ data }: NodeProps<OutputFlowNode>) {
  return (
    <div className="prod-graph-node prod-graph-output">
      <Handle id="in-out" type="target" position={Position.Left} title="Primary output — pipe a generation or reference in" />
      <div className="prod-graph-node-title">Frame output</div>
      {data.previewKind === "video" && data.previewUrl
        ? <video className="prod-graph-output-img nodrag nowheel" src={data.previewUrl} controls muted loop playsInline preload="metadata" />
        : data.previewUrl
          ? <img className="prod-graph-output-img" src={data.previewUrl} alt={`Shot ${data.shotNumber}`} draggable={false} />
          : <div className="prod-graph-output-blank">No output yet</div>}
      {!data.bound && <span className="prod-graph-output-hint">Pipe an image, video, or reference in to feed the output</span>}
    </div>
  );
});

const ImageGenNodeView = memo(function ImageGenNodeView({ data }: NodeProps<ImageGenFlowNode>) {
  const [model, setModel] = useState(data.defaultModel);
  const [resolution, setResolution] = useState(data.defaultResolution);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await data.onGenerate(model, resolution); } finally { setBusy(false); }
  };
  return (
    <div className="prod-graph-node prod-graph-gen">
      <Handle id="in-prompt" type="target" position={Position.Left} title="Prompt input" />
      <Handle type="source" position={Position.Right} title="Frame out — pipe into the video node or the output" />
      <div className="prod-graph-node-title">Image generation</div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={model} onChange={(e) => setModel(e.target.value)} title="OpenArt image model">
          <option value="auto">Auto</option>
          {data.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>)}
        </select>
        <select className="prod-openart-select nodrag" value={resolution} onChange={(e) => setResolution(e.target.value)} title="Resolution">
          <option value="1k">1k</option>
          <option value="2k">2k</option>
          <option value="4k">4k</option>
        </select>
      </div>
      {data.items[data.selected]
        ? <img className="prod-graph-gen-preview" src={data.items[data.selected].url} alt="Generated frame" draggable={false} />
        : <div className="prod-graph-gen-preview blank">No generations yet</div>}
      {data.items.length > 0 && (
        <div className="prod-graph-gen-strip nodrag nowheel">
          {[...data.items].map((it, i) => ({ it, i })).reverse().map(({ it, i }) => (
            <button
              key={i}
              className={i === data.selected ? "sel" : ""}
              title={it.prompt || `Generation ${i + 1}`}
              onClick={() => data.onSelect(i)}
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
        {busy ? "Generating…" : "Generate"}
      </button>
    </div>
  );
});

const VideoGenNodeView = memo(function VideoGenNodeView({ id, data }: NodeProps<VideoGenFlowNode>) {
  const [model, setModel] = useState(data.models[0]?.id ?? "auto");
  const [resolution, setResolution] = useState("1080p");
  const [durationSec, setDurationSec] = useState(5);
  const [busy, setBusy] = useState(false);
  const [opts, setOpts] = useState<VideoModelOptions | null>(null);
  // Per-model resolution / length choices, fetched like the video panel. The
  // node ALWAYS animates a source frame (the piped frame or the shot's own),
  // so it always probes the image-to-video form — never text-to-video.
  useEffect(() => {
    let live = true;
    setOpts(null);
    if (model && model !== "auto") void data.onModelOptions(model, true).then((o) => { if (live) setOpts(o); }).catch(() => {});
    return () => { live = false; };
  }, [model]);
  // Keep the current selection valid when the model's options arrive.
  const durations = opts?.durations?.length ? opts.durations : [5, 10, 15, 20];
  const resolutions = opts?.resolutions?.length ? opts.resolutions : ["480p", "720p", "1080p"];
  useEffect(() => {
    if (resolutions.length && !resolutions.includes(resolution)) setResolution(resolutions[0]);
    if (durations.length && !durations.includes(durationSec)) setDurationSec(durations[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts]);
  // Socket positions are percentage styles — when the ref count changes they
  // move without the node resizing, so force a bounds re-measure.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, data.refHandles.length, updateNodeInternals]);
  // Left-edge sockets: prompt at the top, the main source frame, one per
  // connected additional reference, then an always-open reference socket.
  const n = data.refHandles.length + 1;
  const total = n + 2;
  const sockets: { id: string; kind: "prompt" | "ref"; open: boolean; label: string; top: number }[] = [
    { id: "in-prompt", kind: "prompt", open: false, label: "Prompt", top: (1 / (total + 1)) * 100 },
    { id: "in-image", kind: "ref", open: false, label: "Source", top: (2 / (total + 1)) * 100 },
    ...data.refHandles.map((h, i) => ({ id: h.id, kind: "ref" as const, open: false, label: h.name || "Reference", top: ((i + 3) / (total + 1)) * 100 })),
    { id: data.openHandleId, kind: "ref", open: true, label: "Reference", top: ((n + 2) / (total + 1)) * 100 },
  ];
  const run = async () => {
    setBusy(true);
    try { await data.onGenerate(model, resolution, durationSec); } finally { setBusy(false); }
  };
  return (
    <div className="prod-graph-node prod-graph-gen prod-graph-videogen">
      {sockets.map((s) => (
        <Fragment key={s.id}>
          <Handle
            id={s.id}
            type="target"
            position={Position.Left}
            className={`socket-${s.kind}` + (s.open ? " open" : "")}
            style={{ top: `${s.top}%` }}
            title={s.open ? "Additional reference input — always open, drop a connection here" : `${s.label} input`}
          />
          <span className={`prod-graph-socket-label ${s.kind}`} style={{ top: `${s.top}%` }}>{s.label}</span>
        </Fragment>
      ))}
      <Handle type="source" position={Position.Right} title="Clip out — pipe into the output" />
      <div className="prod-graph-node-title">Video generation</div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={model} onChange={(e) => setModel(e.target.value)} title="OpenArt video model">
          <option value="auto">Auto</option>
          {data.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>)}
        </select>
      </div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={resolution} onChange={(e) => setResolution(e.target.value)} title="Resolution">
          {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select className="prod-openart-select nodrag" value={String(durationSec)} onChange={(e) => setDurationSec(Number(e.target.value))} title="Clip length">
          {durations.map((d) => <option key={d} value={d}>{d}s</option>)}
        </select>
      </div>
      <span className="prod-graph-gen-hint">{data.hasImageSource ? "Source: piped frame" : "Source: shot frame"}</span>
      {data.items[data.selected]
        ? <video className="prod-graph-gen-preview nodrag nowheel" src={data.items[data.selected].url} controls muted loop playsInline preload="metadata" />
        : <div className="prod-graph-gen-preview blank">No generations yet</div>}
      {data.items.length > 0 && (
        <div className="prod-graph-gen-strip nodrag nowheel">
          {[...data.items].map((it, i) => ({ it, i })).reverse().map(({ it, i }) => (
            <button
              key={i}
              className={i === data.selected ? "sel" : ""}
              title={it.prompt || `Clip ${i + 1}`}
              onClick={() => data.onSelect(i)}
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
        {busy ? "Generating…" : "Generate"}
      </button>
    </div>
  );
});

const VideoPromptNodeView = memo(function VideoPromptNodeView({ data }: NodeProps<VideoPromptFlowNode>) {
  return (
    <div className="prod-graph-node prod-graph-videoprompt">
      <Handle type="source" position={Position.Right} title="Prompt out" />
      <div className="prod-graph-node-title">Video prompt</div>
      <textarea
        className="prod-graph-composer-text nodrag nowheel"
        rows={4}
        value={data.value}
        placeholder="Motion prompt — e.g. camera pans left, leaves drift"
        onChange={(e) => data.onChange(e.target.value)}
      />
    </div>
  );
});

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
  videoprompt: VideoPromptNodeView,
};

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
const VIDGEN_X = 1520;
const OUTPUT_X = 1960;
const STYLE_STEP = 96;
/** Top of the reference band: the style node sits above it, brand below. */
const REF_COL_TOP = 20 + STYLE_STEP;
/** Node ids that always exist regardless of prompt/reference content. */
const STRUCTURAL_IDS = ["composer", "style", "brand", "output", "imagegen", "videogen", "videoprompt"];
/** Edge strokes match the input-socket colors (see styles.css). */
const SOCKET_COLORS = { ref: "var(--graph-socket-ref)", style: "var(--graph-socket-style)", brand: "var(--graph-socket-brand)" } as const;

/** Column layout, mirroring the prompt node's input order: style node at the
 *  top of the left column, reference nodes in the middle (unused refs in the
 *  left column, tagged refs one column closer to the prompt), brand at the
 *  bottom. User-dragged positions override these defaults. */
function defaultPosition(id: string, availIds: string[], taggedIds: string[]): { x: number; y: number } {
  const band = Math.max(availIds.length, taggedIds.length) * REF_STEP;
  const midY = Math.max(20, REF_COL_TOP + band / 2);
  if (id === "style") return { x: REF_X, y: 20 };
  if (id === "brand") return { x: REF_X, y: REF_COL_TOP + band + 16 };
  if (id === "composer") return { x: COMPOSER_X, y: Math.max(20, midY - 140) };
  if (id === "imagegen") return { x: IMGGEN_X, y: Math.max(20, midY - 170) };
  if (id === "videogen") return { x: VIDGEN_X, y: Math.max(20, midY - 190) };
  if (id === "videoprompt") return { x: VIDGEN_X, y: Math.max(20, midY + 190) };
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

export function NodeGraphModal({ prod, shot, bust, prompt, references, styles, styleValue, includeBrand, imageModels, videoModels, defaultImageModel, defaultImageResolution, initialLayout, onPromptChange, onStyleChange, onToggleBrand, onDropFile, onStyleDetached, onRunImageGen, onRunVideoGen, onSelectGraphGen, onCycleGraphGen, onGraphField, onPipeImageToVideo, onPipeImageToOutput, onPipeVideoToOutput, onPipeRefToOutput, onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeOutput, onSaveLayout, onClose }: {
  prod: Production;
  shot: ProductionShot;
  /** Renderer content key — bumped when frames regenerate so the output thumbnail refetches. */
  bust: number;
  prompt: string;
  references: GraphRef[];
  styles: ProductionStyle[];
  styleValue: string;
  includeBrand: boolean;
  /** Previously saved canvas state for this shot (positions + viewport). */
  initialLayout?: GraphLayout;
  onPromptChange: (value: string) => void;
  onStyleChange: (style: string) => void;
  onToggleBrand: (include: boolean) => void;
  /** A media file dropped onto the canvas — becomes a reference in the parent. */
  onDropFile: (file: File) => void;
  /** The style link was detached: the parent clears the shot's style flag so
   *  the storyboard dropdown shows None. */
  onStyleDetached: () => void;
  /** Image/video-capable OpenArt models for the generation nodes. */
  imageModels: OpenArtModelChoice[];
  videoModels: OpenArtModelChoice[];
  /** Defaults from the production's OpenArt config for the image node. */
  defaultImageModel: string;
  defaultImageResolution: string;
  /** Run the image generation node (prompt = the composer's text). */
  onRunImageGen: (model: string, resolution: string) => Promise<void>;
  /** Run the video generation node (prompt = the video-prompt node). */
  onRunVideoGen: (model: string, resolution: string, durationSec: number) => Promise<void>;
  /** Select a generation node's stored output by index. */
  onSelectGraphGen: (kind: "image" | "video", index: number) => void;
  /** Cycle a generation node's stored outputs. */
  onCycleGraphGen: (kind: "image" | "video", dir: 1 | -1) => void;
  /** Merge shot-level graph fields (video prompt text, cycle index, pipes). */
  onGraphField: (patch: Partial<ProductionShot>) => void;
  /** Pipe the image node's output into the video node's image input. */
  onPipeImageToVideo: () => void;
  /** Pipe the image node's output into the output (and apply its selection). */
  onPipeImageToOutput: () => void;
  /** Pipe the video node's output into the output (and apply its selection). */
  onPipeVideoToOutput: () => void;
  /** Pipe a reference node's output into the output (applies its media to the shot). */
  onPipeRefToOutput: (refId: string) => void;
  /** Unbind the image node's output entirely (video feed + any output feed). */
  onUnpipeImageGen: () => void;
  /** Unbind the image node from the video node's image input only. */
  onUnpipeImageToVideo: () => void;
  /** Unbind the video node's output. */
  onUnpipeVideoGen: () => void;
  /** Unbind whatever feeds the output. */
  onUnpipeOutput: () => void;
  /** Persist part of the canvas state (positions and/or viewport). */
  onSaveLayout: (layout: GraphLayout) => void;
  onClose: () => void;
}) {
  const saveLayoutRef = useRef(onSaveLayout);
  saveLayoutRef.current = onSaveLayout;
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ name: string; artwork: string } | null>(null);
  const hintTimer = useRef<number | null>(null);

  const showHint = useCallback((message: string) => {
    setDropHint(message);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setDropHint(null), 4000);
  }, []);

  // Escape closes the lightbox first, then the graph. When a stacked dialog
  // (video generation) is open above the graph, it owns Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (lightbox) { setLightbox(null); return; }
      if (document.querySelector(".prod-video-overlay")) return;
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

  const taggedNames = useMemo(
    () => Array.from(prompt.matchAll(/@\[([^\]]+)\]/g)).map((m) => m[1]),
    [prompt],
  );

  // Tagged refs in prompt order; dangling tags (no matching ref) render as
  // "missing" so the user can see and clean them up.
  const tagged = useMemo(
    () => taggedNames.map((name) => ({
      name,
      ref: references.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null,
    })),
    [taggedNames, references],
  );

  const taggedKey = useMemo(() => new Set(taggedNames.map((n) => n.toLowerCase())), [taggedNames]);
  const available = useMemo(
    () => references.filter((r) => !taggedKey.has(r.name.toLowerCase())),
    [references, taggedKey],
  );

  const availIds = useMemo(() => available.map((r) => `ref:${r.id}`), [available]);
  const taggedIds = useMemo(() => tagged.map((t, i) => `ref:${t.ref?.id ?? "missing-" + i}`), [tagged]);

  // Node callbacks change identity every parent render; routing them through
  // a ref keeps node data (and node object identities) stable across renders,
  // which keeps React Flow's selection bookkeeping from fighting re-renders.
  const cb = useRef({ onPromptChange, onStyleChange, onToggleBrand, prompt, setLightbox, styles, styleValue, onStyleDetached, onRunImageGen, onRunVideoGen, onSelectGraphGen, onCycleGraphGen, onGraphField, onPipeImageToVideo, onPipeImageToOutput, onPipeVideoToOutput, onPipeRefToOutput, onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeOutput, graphVideoRefIds: shot.graphVideoRefIds ?? [], graphOutputSource: shot.graphOutputSource, graphOutputRefId: shot.graphOutputRefId });
  cb.current = { onPromptChange, onStyleChange, onToggleBrand, prompt, setLightbox, styles, styleValue, onStyleDetached, onRunImageGen, onRunVideoGen, onSelectGraphGen, onCycleGraphGen, onGraphField, onPipeImageToVideo, onPipeImageToOutput, onPipeVideoToOutput, onPipeRefToOutput, onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeOutput, graphVideoRefIds: shot.graphVideoRefIds ?? [], graphOutputSource: shot.graphOutputSource, graphOutputRefId: shot.graphOutputRefId };
  const stable = useRef({
    onPromptChange: (value: string) => cb.current.onPromptChange(value),
    onStyleChange: (style: string) => cb.current.onStyleChange(style),
    onToggleBrand: (include: boolean) => cb.current.onToggleBrand(include),
    onToggle: (name: string, currentlyTagged: boolean) => {
      const p = cb.current.prompt;
      cb.current.onPromptChange(currentlyTagged ? removeRefTag(p, name) : addRefTag(p, name));
    },
    onZoom: (name: string, artwork: string) => cb.current.setLightbox({ name, artwork }),
    onRunImageGen: (model: string, resolution: string) => cb.current.onRunImageGen(model, resolution),
    onRunVideoGen: (model: string, resolution: string, durationSec: number) => cb.current.onRunVideoGen(model, resolution, durationSec),
    onSelectImageGen: (index: number) => cb.current.onSelectGraphGen("image", index),
    onSelectVideoGen: (index: number) => cb.current.onSelectGraphGen("video", index),
    onCycleImageGen: (dir: 1 | -1) => cb.current.onCycleGraphGen("image", dir),
    onCycleVideoGen: (dir: 1 | -1) => cb.current.onCycleGraphGen("video", dir),
    onModelOptions: (model: string, withImage: boolean) => {
      const key = `${model}|${withImage ? 1 : 0}`;
      const cached = videoOptionsCache.get(key);
      if (cached !== undefined) return Promise.resolve(cached);
      return window.cascade.videoModelOptions(model, withImage).then((o) => {
        videoOptionsCache.set(key, o);
        return o;
      }).catch(() => null);
    },
    onVideoPromptChange: (text: string) => cb.current.onGraphField({ graphVideoPrompt: text }),
    onPipeImageToVideo: () => cb.current.onPipeImageToVideo(),
    onPipeImageToOutput: () => cb.current.onPipeImageToOutput(),
    onPipeVideoToOutput: () => cb.current.onPipeVideoToOutput(),
    onPipeRefToOutput: (refId: string) => cb.current.onPipeRefToOutput(refId),
    onUnpipeImageGen: () => cb.current.onUnpipeImageGen(),
    onUnpipeImageToVideo: () => cb.current.onUnpipeImageToVideo(),
    onUnpipeVideoGen: () => cb.current.onUnpipeVideoGen(),
    onUnpipeOutput: () => cb.current.onUnpipeOutput(),
  }).current;

  const buildDerived = useCallback((): GraphNode[] => {
    const ORIGIN = { x: 0, y: 0 };
    const build = <T extends GraphNode>(node: T): T => ({ ...node, position: defaultPosition(node.id, availIds, taggedIds) });
    return [
      ...tagged.map((t, i) => build({
        id: `ref:${t.ref?.id ?? "missing-" + i}`,
        type: "ref" as const,
        position: ORIGIN,
        data: {
          name: t.name,
          artwork: t.ref?.artwork ?? "",
          media: t.ref?.media,
          mediaUrl: t.ref?.media === "video" && t.ref?.mediaPath ? graphMediaUrl(prod.meta.id, t.ref.mediaPath) : undefined,
          missing: !t.ref,
          tagged: true,
          onToggle: stable.onToggle,
          onZoom: stable.onZoom,
        },
        deletable: false,
      })),
      ...available.map((r) => build({
        // Same id scheme as tagged refs, so toggling a tag never moves the
        // node — only its edge and column default change.
        id: `ref:${r.id}`,
        type: "ref" as const,
        position: ORIGIN,
        data: { name: r.name, artwork: r.artwork, media: r.media, mediaUrl: r.media === "video" && r.mediaPath ? graphMediaUrl(prod.meta.id, r.mediaPath) : undefined, tagged: false, onToggle: stable.onToggle, onZoom: stable.onZoom },
        deletable: false,
      })),
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
        data: { include: includeBrand, onToggle: stable.onToggleBrand },
        deletable: false,
      }),
      build({
        id: "composer",
        type: "composer" as const,
        position: ORIGIN,
        data: { value: prompt, refHandles: tagged.map((_, i) => `in-ref-${i}`), openHandleId: "in-ref-open", includeBrand, onChange: stable.onPromptChange },
        deletable: false,
      }),
      build({
        id: "output",
        type: "frame" as const,
        position: ORIGIN,
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
        data: {
          models: imageModels,
          defaultModel: prod.openArt?.model ?? "auto",
          defaultResolution: prod.openArt?.resolution ?? "1k",
          items: (shot.graphImageGens ?? []).map((g) => ({ url: graphMediaUrl(prod.meta.id, g.path), prompt: g.prompt })),
          selected: shot.graphImageGenIndex ?? 0,
          onGenerate: stable.onRunImageGen,
          onSelect: stable.onSelectImageGen,
          onCycle: stable.onCycleImageGen,
        },
        deletable: false,
      }),
      build({
        id: "videogen",
        type: "videogen" as const,
        position: ORIGIN,
        data: {
          models: videoModels,
          items: (shot.graphVideoGens ?? []).map((g) => ({ url: graphMediaUrl(prod.meta.id, g.path), prompt: g.prompt })),
          selected: shot.graphVideoGenIndex ?? 0,
          hasImageSource: shot.graphImageToVideo === true || (shot.graphVideoRefIds?.length ?? 0) > 0,
          refHandles: (shot.graphVideoRefIds ?? []).map((refId, i) => ({ id: `in-vref-${i}`, name: references.find((r) => r.id === refId)?.name ?? "Reference" })),
          openHandleId: "in-vref-open",
          onGenerate: stable.onRunVideoGen,
          onSelect: stable.onSelectVideoGen,
          onCycle: stable.onCycleVideoGen,
          onModelOptions: stable.onModelOptions,
        },
        deletable: false,
      }),
      build({
        id: "videoprompt",
        type: "videoprompt" as const,
        position: ORIGIN,
        data: { value: shot.graphVideoPrompt ?? VIDEO_PROMPT_DEFAULT, onChange: stable.onVideoPromptChange },
        deletable: false,
      }),
    ];
  }, [tagged, available, availIds, taggedIds, stable, styles, styleValue, includeBrand, prompt, thumbnail, shot.number, shot.artworkHistory, prod.meta.id, prod.openArt?.model, prod.openArt?.resolution, shot.graphImageGens, shot.graphImageGenIndex, shot.graphVideoGens, shot.graphVideoGenIndex, shot.graphVideoPrompt, shot.graphImageToVideo, shot.graphVideoRefIds, shot.graphOutputSource, shot.graphOutputRefId, imageModels, videoModels, references]);

  // Persistent node state (the canonical React Flow controlled pattern): all
  // changes flow through applyNodeChanges so selection lives in ONE place.
  // Derived definitions are reconciled in — surviving nodes keep their
  // dragged position, selection flags, and measured size.
  const [nodes, setNodes] = useState<GraphNode[]>(() => {
    const first = buildDerived();
    const saved = initialLayout?.positions;
    return saved ? first.map((d) => ({ ...d, position: saved[d.id] ?? d.position })) : first;
  });
  const nodesRef = useRef(nodes);
  useEffect(() => {
    const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
    const next = buildDerived().map((d) => {
      const old = byId.get(d.id);
      return old ? { ...d, position: old.position, selected: old.selected, measured: old.measured } : d;
    });
    nodesRef.current = next;
    setNodes(next);
  }, [buildDerived]);

  const edges = useMemo<Edge[]>(() => {
    // Style/brand edges mirror the prompt: the edge exists only while that
    // section is present, so detaching = dragging the link off the socket.
    const styleAttached = /^Style:/m.test(prompt);
    return [
      ...tagged.map((t, i) => {
        const refNodeId = `ref:${t.ref?.id ?? "missing-" + i}`;
        return {
          id: `e-${refNodeId}`,
          source: refNodeId,
          target: "composer",
          // Each connected reference gets its own input socket on the prompt.
          targetHandle: `in-ref-${i}`,
          style: { stroke: SOCKET_COLORS.ref },
          // No edge-end anchors — disconnecting is done by dragging the link
          // off a socket (onConnectEnd).
          reconnectable: false,
          selected: selectedEdges.has(`e-${refNodeId}`),
        };
      }),
      ...(styleAttached ? [{ id: "e-style", source: "style", target: "composer", targetHandle: "in-style", style: { stroke: SOCKET_COLORS.style }, deletable: false, reconnectable: false }] : []),
      ...(includeBrand ? [{ id: "e-brand", source: "brand", target: "composer", targetHandle: "in-brand", style: { stroke: SOCKET_COLORS.brand }, deletable: false, reconnectable: false }] : []),
      // Generation pipeline: composer feeds the image node; the video-prompt
      // node feeds the video node; pipes into the output mirror the binding.
      { id: "e-cmp-img", source: "composer", target: "imagegen", targetHandle: "in-prompt", deletable: false, reconnectable: false },
      { id: "e-vp-vid", source: "videoprompt", target: "videogen", targetHandle: "in-prompt", deletable: false, reconnectable: false },
      ...(shot.graphImageToVideo ? [{ id: "e-img-vid", source: "imagegen", target: "videogen", targetHandle: "in-image", style: { stroke: SOCKET_COLORS.ref }, deletable: false, reconnectable: false }] : []),
      ...(shot.graphOutputSource === "imagegen" ? [{ id: "e-img-out", source: "imagegen", target: "output", targetHandle: "in-out", deletable: false, reconnectable: false }] : []),
      ...(shot.graphOutputSource === "videogen" ? [{ id: "e-vid-out", source: "videogen", target: "output", targetHandle: "in-out", deletable: false, reconnectable: false }] : []),
      ...(shot.graphOutputSource === "ref" && shot.graphOutputRefId && references.some((r) => r.id === shot.graphOutputRefId) ? [{ id: "e-ref-out", source: `ref:${shot.graphOutputRefId}`, target: "output", targetHandle: "in-out", style: { stroke: SOCKET_COLORS.ref }, deletable: false, reconnectable: false }] : []),
      // Additional references piped into the video node's extra inputs.
      ...(shot.graphVideoRefIds ?? []).map((refId, i) => ({ refId, i }))
        .filter(({ refId }) => references.some((r) => r.id === refId))
        .map(({ refId, i }) => ({
          id: `e-vref-${refId}`,
          source: `ref:${refId}`,
          target: "videogen",
          targetHandle: `in-vref-${i}`,
          style: { stroke: SOCKET_COLORS.ref },
          deletable: true,
          reconnectable: false,
        })),
      // The output is fed ONLY by the generation nodes or a reference — the
      // composer's classic straight-to-output pipe is gone.
    ];
  }, [tagged, selectedEdges, prompt, includeBrand, shot.graphImageToVideo, shot.graphVideoRefIds, shot.graphOutputSource, shot.graphOutputRefId, references]);

  const onNodesChange = useCallback<OnNodesChange<GraphNode>>((changes) => {
    // Canonical controlled flow: apply every change (position, select,
    // dimension) to the persistent node state in one pass so React Flow's
    // internal selection bookkeeping and our state never diverge.
    const dragStop = changes.some((c) => c.type === "position" && c.dragging !== true);
    const next = applyNodeChanges(changes, nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
    if (dragStop) {
      // One save per drag gesture. The state only ever contains live nodes,
      // so no pruning is needed for deleted references.
      saveLayoutRef.current({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) {
      if (c.type === "remove") {
        // Only reference edges are deletable; deleting one removes its binding.
        const m = /^e-ref:(.+)$/.exec(c.id);
        if (m) {
          const idx = tagged.findIndex((t, i) => (t.ref?.id ?? "missing-" + i) === m[1]);
          if (idx >= 0) onPromptChange(removeRefTag(prompt, tagged[idx].name));
          setSelectedEdges(new Set());
          continue;
        }
        const v = /^e-vref-(.+)$/.exec(c.id);
        if (v) {
          const list = (cb.current.graphVideoRefIds ?? []).filter((id) => id !== v[1]);
          cb.current.onGraphField({ graphVideoRefIds: list });
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
  }, [tagged, prompt, onPromptChange]);

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return;
    // Generation pipes: the image node's output feeds the video node's image
    // input and/or the output (both can coexist); the video node feeds the
    // output; a reference can feed the output or the video node's extra inputs.
    if (conn.source === "imagegen" && conn.target === "videogen") { cb.current.onPipeImageToVideo(); return; }
    if (conn.source === "imagegen" && conn.target === "output") { cb.current.onPipeImageToOutput(); return; }
    if (conn.source === "videogen" && conn.target === "output") { cb.current.onPipeVideoToOutput(); return; }
    const refId = /^ref:(.+)$/.exec(conn.source)?.[1];
    if (refId) {
      if (conn.target === "output") { cb.current.onPipeRefToOutput(refId); return; }
      if (conn.target === "videogen" && conn.targetHandle === "in-vref-open") {
        const list = cb.current.graphVideoRefIds ?? [];
        if (!list.includes(refId)) cb.current.onGraphField({ graphVideoRefIds: [...list, refId] });
        return;
      }
    }
    if (conn.target !== "composer") return;
    if (conn.source === "style") {
      // Re-attach the style section from the currently selected style.
      const text = cb.current.styles.find((s) => s.id === cb.current.styleValue)?.prompt.trim() ?? "";
      cb.current.onPromptChange(addStyleParagraph(cb.current.prompt, text));
      return;
    }
    if (conn.source === "brand") {
      cb.current.onToggleBrand(true);
      return;
    }
    const m = /^ref:(.+)$/.exec(conn.source);
    if (!m) return;
    const ref = references.find((r) => r.id === m[1]);
    if (!ref) return;
    onPromptChange(addRefTag(prompt, ref.name));
  }, [references, prompt, onPromptChange]);

  /** Reference→open-input, style→style, brand→brand, imagegen→video/output
   *  (both at once allowed), videogen→output, ref→output (image/video refs
   *  only) and ref→video-node extra input (image refs only) — everything else
   *  is rejected. */
  const isValidConnection = useCallback((c: Connection | Edge) => {
    const source = c.source ?? "";
    if (source === "imagegen") {
      if (c.target === "videogen") return c.targetHandle === "in-image";
      if (c.target === "output") return c.targetHandle === "in-out";
      return false;
    }
    if (source === "videogen") return c.target === "output" && c.targetHandle === "in-out";
    const refId = /^ref:(.+)$/.exec(source)?.[1];
    if (refId) {
      const ref = references.find((r) => r.id === refId);
      if (c.target === "output") return c.targetHandle === "in-out" && !!ref && ref.media !== "audio";
      if (c.target === "videogen") return c.targetHandle === "in-vref-open" && !!ref && !!ref.artwork;
      if (c.target === "composer") return c.targetHandle === "in-ref-open";
      return false;
    }
    if (c.target !== "composer") return false;
    if (source === "style") return c.targetHandle === "in-style";
    if (source === "brand") return c.targetHandle === "in-brand";
    return false;
  }, [references]);

  const onConnectEnd = useCallback<OnConnectEnd>((_event, state) => {
    // Blender-style disconnect: grab a link at either end and release it into
    // empty space. Releasing on/near any socket snaps back instead.
    if (state.isValid || state.toHandle) return;
    const from = state.fromHandle;
    if (!from) return;
    if (from.type === "target" && from.nodeId === "composer") {
      // Dragged off a prompt input socket → detach that input.
      const id = from.id ?? "";
      if (id === "in-style") {
        // Clear the shot's style flag first (dropdown → None), then strip the
        // paragraph through the serialized prompt save.
        cb.current.onStyleDetached();
        cb.current.onPromptChange(removeStyleParagraph(cb.current.prompt));
        return;
      }
      if (id === "in-brand") {
        cb.current.onToggleBrand(false);
        return;
      }
      const m = /^in-ref-(\d+)$/.exec(id);
      if (!m) return;
      const t = tagged[Number(m[1])];
      if (t) cb.current.onPromptChange(removeRefTag(cb.current.prompt, t.name));
      return;
    }
    if (from.type === "target" && from.nodeId === "videogen" && from.id === "in-image") {
      // Dragged the image pipe off the video node's image input → unbind only
      // that pipe (the output feed, if wired, stays).
      cb.current.onUnpipeImageToVideo();
      return;
    }
    if (from.type === "target" && from.nodeId === "videogen") {
      // Dragged one of the extra reference inputs off → drop that reference.
      const m = /^in-vref-(\d+)$/.exec(from.id ?? "");
      if (m) {
        const i = Number(m[1]);
        cb.current.onGraphField({ graphVideoRefIds: (cb.current.graphVideoRefIds ?? []).filter((_, idx) => idx !== i) });
        return;
      }
    }
    if (from.type === "target" && from.nodeId === "output" && from.id === "in-out") {
      // Dragged the generation pipe off the output's input → unbind.
      cb.current.onUnpipeOutput();
      return;
    }
    if (from.type === "source" && from.nodeId === "imagegen") {
      // Dragged the image node's output off → unbind it (both the video feed
      // and the output feed if it was routed there).
      cb.current.onUnpipeImageGen();
      return;
    }
    if (from.type === "source" && from.nodeId === "videogen") {
      cb.current.onUnpipeVideoGen();
      return;
    }
    if (from.type === "source") {
      // Dragged off a node's output socket → detach it.
      if (from.nodeId === "style") {
        cb.current.onStyleDetached();
        cb.current.onPromptChange(removeStyleParagraph(cb.current.prompt));
        return;
      }
      if (from.nodeId === "brand") {
        cb.current.onToggleBrand(false);
        return;
      }
      const m = /^ref:(.+)$/.exec(from.nodeId ?? "");
      if (!m) return;
      const entry = tagged.find((t) => t.ref?.id === m[1]);
      if (entry) cb.current.onPromptChange(removeRefTag(cb.current.prompt, entry.name));
      // If this reference also feeds the output or the video node's extra
      // inputs, those bindings go with the dragged-off socket.
      const refId = m[1];
      if (cb.current.graphOutputSource === "ref" && cb.current.graphOutputRefId === refId) {
        cb.current.onUnpipeOutput();
      }
      const list = (cb.current.graphVideoRefIds ?? []).filter((id) => id !== refId);
      if (list.length !== (cb.current.graphVideoRefIds ?? []).length) {
        cb.current.onGraphField({ graphVideoRefIds: list });
      }
    }
  }, [tagged]);

  useEffect(() => () => { if (hintTimer.current !== null) window.clearTimeout(hintTimer.current); }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    for (const file of files) {
      if (!file.type.startsWith("image/") && !file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
        showHint(`${file.name}: only image, video, and audio files become references.`);
        continue;
      }
      onDropFile(file);
    }
  }, [onDropFile, showHint]);

  return (
    <div className="prod-edit-overlay prod-graph-overlay" onClick={onClose}>
      <div className="prod-graph-panel" onClick={(e) => e.stopPropagation()}>
        <div className="prod-graph-head">
          <span className="prod-graph-title">Shot {shot.number} — node graph</span>
          <span className="prod-graph-hint">Prompt text is the source of truth · left-drag moves nodes · box-select on empty canvas · right-drag pans · drag a connection off a socket to detach it</span>
          <button className="prod-btn" onClick={onClose}>Close</button>
        </div>
        <div className="prod-graph-canvas" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
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
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} />
          </ReactFlow>
          {dropHint && <div className="prod-graph-drop-hint">{dropHint}</div>}
          {lightbox && (
            <div className="prod-ref-lightbox prod-graph-lightbox" onClick={() => setLightbox(null)}>
              <figure className="prod-ref-lightbox-card">
                <img src={lightbox.artwork} alt={lightbox.name} />
                <figcaption>{lightbox.name} — click anywhere to close</figcaption>
              </figure>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
