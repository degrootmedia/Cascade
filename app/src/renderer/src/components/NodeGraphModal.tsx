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
import { addRefTag, addStyleParagraph, composePromptBoxes, hasBrandParagraph, parsePromptBoxes, refTagNames, removeRefTag, removeStyleParagraph, stripBrandParagraph } from "../../../shared/prompt-grammar.js";
import { TriplePrompt } from "./TriplePrompt.js";
import { usePersistedCollapsed } from "./production/persisted-state.js";
import { useExternalImageMenu } from "./external-menu.js";

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
  /** Real reference id (absent for dangling tags) — for the remove button. */
  refId?: string;
  onToggle: (name: string, tagged: boolean) => void;
  /** Open the reference image in a lightbox (image refs only). */
  onZoom: (name: string, artwork: string) => void;
  /** Remove a placed ref node from the canvas (shelf refs only). */
  onRemove?: (refId: string) => void;
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
  onGenerate: (model: string, resolution: string, durationSec: number) => Promise<void>;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
  onModelOptions: (model: string, withImage: boolean) => Promise<VideoModelOptions | null>;
}
type VideoGenFlowNode = Node<VideoGenData, "videogen">;

interface EditGenData extends Record<string, unknown> {
  models: OpenArtModelChoice[];
  /** Default from the production's OpenArt config (matches the image node). */
  defaultResolution: string;
  items: { url: string; prompt: string }[];
  selected: number;
  /** Where the source image comes from (drives the hint + the onGenerate path). */
  sourceHint: string;
  onGenerate: (model: string, resolution: string) => Promise<void>;
  onSelect: (index: number) => void;
  onCycle: (dir: 1 | -1) => void;
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
  /** The edit instructions, synced with the classic EditBoardModal (`shot.graphEditPrompt`). */
  value: string;
  refHandles: string[];
  openHandleId: string;
  includeBrand: boolean;
  onChange: (text: string) => void;
  registerApplier: (applier: PromptDraftApplier | undefined) => void;
}
type EditPromptFlowNode = Node<EditPromptData, "editprompt">;

type GraphNode = RefFlowNode | ComposerFlowNode | StyleFlowNode | BrandFlowNode | OutputFlowNode | ImageGenFlowNode | VideoGenFlowNode | EditGenFlowNode | VideoPromptFlowNode | EditPromptFlowNode;

/* ------------------------------------------------------------------ */
/* Custom node views                                                   */
/* ------------------------------------------------------------------ */

const RefNodeView = memo(function RefNodeView({ data }: NodeProps<RefFlowNode>) {
  const extMenu = useExternalImageMenu(() => {
    if (data.artwork) void window.cascade.openInExternalEditor({ dataUrl: data.artwork }).catch(() => {});
  });
  return (
    <div className={"prod-graph-node prod-graph-ref" + (data.tagged ? "" : " avail") + (data.missing ? " missing" : "")}>
      <Handle type="source" position={Position.Right} className="socket-ref" />
      {data.artwork
        ? <><img src={data.artwork} alt={data.name} draggable={false} onContextMenu={extMenu.onContextMenu} />{extMenu.menu}</>
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
          {!data.tagged && data.onRemove && data.refId && (
            <button
              className="prod-graph-ref-btn nodrag"
              title="Remove this reference from the canvas"
              onClick={() => data.onRemove?.(data.refId!)}
            >
              <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </button>
          )}
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
  const n = data.refHandles.length + 1;
  const total = n + 2;
  const sockets: { id: string; kind: "ref" | "style" | "brand"; open: boolean; label: string; top: number }[] = [
    { id: "in-style", kind: "style", open: false, label: "Style", top: (1 / (total + 1)) * 100 },
    ...data.refHandles.map((id, i) => ({ id, kind: "ref" as const, open: false, label: "Reference", top: ((i + 2) / (total + 1)) * 100 })),
    { id: data.openHandleId, kind: "ref", open: true, label: "Reference", top: ((n + 1) / (total + 1)) * 100 },
    { id: "in-brand", kind: "brand", open: false, label: "Brand", top: (total / (total + 1)) * 100 },
  ];
  return (
    <div ref={rootRef} className="prod-graph-node prod-graph-composer">
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
        deferExternalWhileFocused
        value={localValue}
        includeBrand={data.includeBrand}
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
      </div>
      <div className="prod-graph-gen-controls">
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

const VideoGenNodeView = memo(function VideoGenNodeView({ data }: NodeProps<VideoGenFlowNode>) {
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
  const run = async () => {
    setBusy(true);
    try { await data.onGenerate(model, resolution, durationSec); } finally { setBusy(false); }
  };
  return (
    <div className="prod-graph-node prod-graph-gen prod-graph-videogen">
      <Handle id="in-prompt" type="target" position={Position.Left} className="socket-ref" style={{ top: "33%" }} title="Prompt input — from the video-prompt node" />
      <span className="prod-graph-socket-label ref" style={{ top: "33%" }}>Prompt</span>
      <Handle id="in-image" type="target" position={Position.Left} className="socket-ref" style={{ top: "67%" }} title="Source image — pipe the frame in" />
      <span className="prod-graph-socket-label ref" style={{ top: "67%" }}>Source</span>
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

const EditGenNodeView = memo(function EditGenNodeView({ data }: NodeProps<EditGenFlowNode>) {
  const [model, setModel] = useState(data.models[0]?.id ?? "auto");
  const [resolution, setResolution] = useState(data.defaultResolution);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await data.onGenerate(model, resolution); } finally { setBusy(false); }
  };
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
      <div className="prod-graph-node-title">Edit image</div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={model} onChange={(e) => setModel(e.target.value)} title="Image model that accepts a reference image">
          <option value="auto">Auto</option>
          {data.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>)}
        </select>
      </div>
      <div className="prod-graph-gen-controls">
        <select className="prod-openart-select nodrag" value={resolution} onChange={(e) => setResolution(e.target.value)} title="Resolution">
          <option value="1k">1k</option>
          <option value="2k">2k</option>
          <option value="4k">4k</option>
        </select>
      </div>
      <span className="prod-graph-gen-hint">Source: {data.sourceHint}</span>
      {data.items[data.selected]
        ? <img className="prod-graph-gen-preview" src={data.items[data.selected].url} alt="Edited frame" draggable={false} />
        : <div className="prod-graph-gen-preview blank">No edits yet</div>}
      {data.items.length > 0 && (
        <div className="prod-graph-gen-strip nodrag nowheel">
          {[...data.items].map((it, i) => ({ it, i })).reverse().map(({ it, i }) => (
            <button
              key={i}
              className={i === data.selected ? "sel" : ""}
              title={it.prompt || `Edit ${i + 1}`}
              onClick={() => data.onSelect(i)}
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
        {busy ? "Editing…" : "Edit"}
      </button>
    </div>
  );
});

/** External prompt nodes — exactly like the image-gen composer prompt node: left
 *  sockets for Style / Reference(s) / Brand, right source handle, TriplePrompt
 *  with local draft while focused. Each prompt's Style/Brand presence and @-tags
 *  drive its own edges, mirroring the composer. */
const VideoPromptNodeView = memo(function VideoPromptNodeView({ id, data }: NodeProps<VideoPromptFlowNode>) {
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
  const n = data.refHandles.length + 1;
  const total = n + 2;
  const sockets: { id: string; kind: "ref" | "style" | "brand"; open: boolean; label: string; top: number }[] = [
    { id: "in-style", kind: "style", open: false, label: "Style", top: (1 / (total + 1)) * 100 },
    ...data.refHandles.map((h, i) => ({ id: h, kind: "ref" as const, open: false, label: "Reference", top: ((i + 2) / (total + 1)) * 100 })),
    { id: data.openHandleId, kind: "ref", open: true, label: "Reference", top: ((n + 1) / (total + 1)) * 100 },
    { id: "in-brand", kind: "brand", open: false, label: "Brand", top: (total / (total + 1)) * 100 },
  ];
  return (
    <div ref={rootRef} className="prod-graph-node prod-graph-composer prod-graph-videoprompt">
      {sockets.map((s) => (
        <Fragment key={s.id}>
          <Handle id={s.id} type="target" position={Position.Left} className={`socket-${s.kind}` + (s.open ? " open" : "")} style={{ top: `${s.top}%` }} title={s.open ? "Reference input — always open, drop a connection here" : `${s.label} input`} />
          <span className={`prod-graph-socket-label ${s.kind}`} style={{ top: `${s.top}%` }}>{s.label}</span>
        </Fragment>
      ))}
      <div className="prod-graph-node-title">Video prompt</div>
      <TriplePrompt
        className="prod-graph-composer-text nodrag nowheel"
        sideRows={3}
        resizable
        deferExternalWhileFocused
        value={localValue}
        includeBrand={data.includeBrand}
        placeholder="Motion prompt — connect references, type @, or edit the boxes"
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

const EditPromptNodeView = memo(function EditPromptNodeView({ id, data }: NodeProps<EditPromptFlowNode>) {
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
      } else {
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
  // Live-draft handle for the edit-prompt node (see ComposerNodeView).
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
  const n = data.refHandles.length + 1;
  const total = n + 2;
  const sockets: { id: string; kind: "ref" | "style" | "brand"; open: boolean; label: string; top: number }[] = [
    { id: "in-style", kind: "style", open: false, label: "Style", top: (1 / (total + 1)) * 100 },
    ...data.refHandles.map((h, i) => ({ id: h, kind: "ref" as const, open: false, label: "Reference", top: ((i + 2) / (total + 1)) * 100 })),
    { id: data.openHandleId, kind: "ref", open: true, label: "Reference", top: ((n + 1) / (total + 1)) * 100 },
    { id: "in-brand", kind: "brand", open: false, label: "Brand", top: (total / (total + 1)) * 100 },
  ];
  return (
    <div ref={rootRef} className="prod-graph-node prod-graph-composer prod-graph-editprompt">
      {sockets.map((s) => (
        <Fragment key={s.id}>
          <Handle id={s.id} type="target" position={Position.Left} className={`socket-${s.kind}` + (s.open ? " open" : "")} style={{ top: `${s.top}%` }} title={s.open ? "Reference input — always open, drop a connection here" : `${s.label} input`} />
          <span className={`prod-graph-socket-label ${s.kind}`} style={{ top: `${s.top}%` }}>{s.label}</span>
        </Fragment>
      ))}
      <div className="prod-graph-node-title">Edit prompt</div>
      <TriplePrompt
        className="prod-graph-composer-text nodrag nowheel"
        sideRows={3}
        resizable
        deferExternalWhileFocused
        value={localValue}
        includeBrand={data.includeBrand}
        placeholder="Edit instructions — connect references, type @, or edit the boxes"
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
  editgen: EditGenNodeView,
  videoprompt: VideoPromptNodeView,
  editprompt: EditPromptNodeView,
};

/** Exported for the renderer-component tests (the node graph uses it directly). */
export const graphNodeTypes = nodeTypes;

/* ------------------------------------------------------------------ */
/* Reference shelf                                                     */
/* ------------------------------------------------------------------ */

/** One collapsible category in the side reference shelf. Collapsed state is
 *  persisted per production + category name (mirrors the references panel). */
function ShelfGroup({ prodId, group, onCanvasRefIds }: {
  prodId: string;
  group: { title: string; refs: GraphRef[] };
  onCanvasRefIds: ReadonlySet<string>;
}) {
  const [collapsed, setCollapsed] = usePersistedCollapsed(`cascade.prod.${prodId}.graph.shelf.${group.title}`);
  return (
    <div className="prod-graph-shelf-group">
      <button
        className="prod-graph-shelf-group-head"
        aria-expanded={!collapsed}
        title={collapsed ? `Show ${group.title}` : `Hide ${group.title}`}
        onClick={() => setCollapsed(!collapsed)}
      >
        <svg className={"prod-graph-shelf-caret" + (collapsed ? " collapsed" : "")} viewBox="0 0 16 16" width="9" height="9" aria-hidden="true"><path d="M5 3l6 5-6 5V3z" fill="currentColor" /></svg>
        <span className="prod-graph-shelf-group-name">{group.title}</span>
        <span className="prod-graph-shelf-count">{group.refs.length}</span>
      </button>
      {!collapsed && group.refs.map((r) => {
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
              ? <img src={r.artwork} alt={r.name} draggable={false} />
              : <div className="prod-graph-shelf-blank">{r.media === "video" ? "▶" : r.media === "audio" ? "♪" : "?"}</div>}
            <span className="prod-graph-shelf-name" title={`Reference @[${r.name}]`}>@[{r.name}]</span>
            {onCanvas && <span className="prod-graph-shelf-check">on canvas</span>}
          </div>
        );
      })}
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
  if (id === "editprompt") return { x: EDITGEN_X, y: Math.max(20, midY + 140) };
  if (id === "editgen") return { x: EDITGEN_X, y: Math.max(20, midY - 170) };
  if (id === "videoprompt") return { x: VIDGEN_X, y: Math.max(20, midY + 140) };
  if (id === "videogen") return { x: VIDGEN_X, y: Math.max(20, midY - 190) };
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

export function NodeGraphModal({ prod, shot, bust, prompt, references, styles, styleValue, includeBrand, imageModels, videoModels, defaultImageModel, defaultImageResolution, initialLayout, onPromptChange, onStyleChange, onToggleBrand, onDropFile, onStyleDetached, onRunImageGen, onRunVideoGen, onRunEditGen, onSelectGraphGen, onCycleGraphGen, onGraphField, onPipeImageToVideo, onPipeImageToOutput, onPipeVideoToOutput, onPipeEditToOutput, onPipeRefToOutput, onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeEditGen, onUnpipeOutput, onSaveLayout, onClose }: {
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
  /** Run the edit-image node (prompt = the edit-prompt node). */
  onRunEditGen: (model: string, resolution: string) => Promise<void>;
  /** Select a generation node's stored output by index. */
  onSelectGraphGen: (kind: "image" | "video" | "edit", index: number) => void;
  /** Cycle a generation node's stored outputs. */
  onCycleGraphGen: (kind: "image" | "video" | "edit", dir: 1 | -1) => void;
  /** Merge shot-level graph fields (video prompt text, cycle index, pipes). */
  onGraphField: (patch: Partial<ProductionShot>) => void;
  /** Pipe the image node's output into the video node's image input. */
  onPipeImageToVideo: () => void;
  /** Pipe the image node's output into the output (and apply its selection). */
  onPipeImageToOutput: () => void;
  /** Pipe the video node's output into the output (and apply its selection). */
  onPipeVideoToOutput: () => void;
  /** Pipe the edit-image node's output into the output (and apply its selection). */
  onPipeEditToOutput: () => void;
  /** Pipe a reference node's output into the output (applies its media to the shot). */
  onPipeRefToOutput: (refId: string) => void;
  /** Unbind the image node's output entirely (video feed + any output feed). */
  onUnpipeImageGen: () => void;
  /** Unbind the image node from the video node's image input only. */
  onUnpipeImageToVideo: () => void;
  /** Unbind the video node's output. */
  onUnpipeVideoGen: () => void;
  /** Unbind the edit-image node's output. */
  onUnpipeEditGen: () => void;
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
  /** React Flow instance (captured on init) — used to map drop coordinates. */
  const flowRef = useRef<{ screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number } } | null>(null);
  /** Ref ids deleted this session (keyboard/trash). Keeps a deleted tagged node
   *  from being re-added by the reconcile effect while the parent's async prompt
   *  save is still in flight; re-dragging from the shelf clears the entry. */
  const removedRefIdsRef = useRef<Set<string>>(new Set());

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

  const videoPromptValue = shot.graphVideoPrompt ?? VIDEO_PROMPT_DEFAULT;
  const editPromptValue = shot.graphEditPrompt ?? "";

  const taggedNames = useMemo(
    () => refTagNames(prompt),
    [prompt],
  );
  const taggedVideoNames = useMemo(() => refTagNames(videoPromptValue), [videoPromptValue]);
  const taggedEditNames = useMemo(() => refTagNames(editPromptValue), [editPromptValue]);

  // Tagged refs in prompt order; dangling tags (no matching ref) render as
  // "missing" so the user can see and clean them up. Image prompt drives the
  // original `tagged` list; video/edit prompts have their own per-prompt lists.
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
  const taggedEdit = useMemo(
    () => taggedEditNames.map((name) => ({
      name,
      ref: references.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null,
    })),
    [taggedEditNames, references],
  );

  // Union of all tags across the three prompts — every reference that appears
  // in ANY prompt gets a node (tagged); untagged references are NOT
  // auto-populated. They live in the side shelf until the user drags one onto
  // the canvas (see `placedRefIds` below), keeping the tray complete while each
  // prompt node's sockets are driven by its own tag list.
  const unionTagged = useMemo(() => {
    const seen = new Set<string>();
    const out: { name: string; ref: GraphRef | null }[] = [];
    for (const name of [...taggedNames, ...taggedVideoNames, ...taggedEditNames]) {
      const lc = name.toLowerCase();
      if (seen.has(lc)) continue;
      seen.add(lc);
      out.push({ name, ref: references.find((r) => r.name.toLowerCase() === lc) ?? null });
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
  // Shelf items already on the canvas (tagged or placed) are marked + not draggable.
  const onCanvasRefIds = useMemo(() => {
    const out = new Set(placedRefIds);
    for (const t of unionTagged) if (t.ref?.id) out.add(t.ref.id);
    return out;
  }, [placedRefIds, unionTagged]);

  // The video-generation and edit-image nodes are NOT auto-populated either —
  // they live as tiles in the right panel and the user drags one out on demand.
  // A tool is present when it's in use (stored generations, pipes, prompt text,
  // an output/ref binding) or was placed via the panel (a saved position).
  const videoGenActive = !!(shot.graphVideoGens?.length || shot.graphVideoRefIds?.length || shot.graphImageToVideo || shot.graphOutputSource === "videogen" || (shot.graphVideoPrompt ?? "").trim());
  const editGenActive = !!(shot.graphEditGens?.length || shot.graphEditImageSource || shot.graphEditSourceRefId || shot.graphOutputSource === "editgen" || (shot.graphEditPrompt ?? "").trim());
  const [placedTools, setPlacedTools] = useState<Set<string>>(() => {
    const out = new Set<string>();
    const p = initialLayout?.positions ?? {};
    if (p.videogen || p.videoprompt) { out.add("videogen"); out.add("videoprompt"); }
    if (p.editgen || p.editprompt) { out.add("editgen"); out.add("editprompt"); }
    return out;
  });
  const hasVideoTool = videoGenActive || placedTools.has("videogen");
  const hasEditTool = editGenActive || placedTools.has("editgen");

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
  const cb = useRef({ onPromptChange, onStyleChange, onToggleBrand, prompt, videoPromptValue, editPromptValue, setLightbox, styles, styleValue, onStyleDetached, onRunImageGen, onRunVideoGen, onRunEditGen, onSelectGraphGen, onCycleGraphGen, onGraphField, onPipeImageToVideo, onPipeImageToOutput, onPipeVideoToOutput, onPipeEditToOutput, onPipeRefToOutput, onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeEditGen, onUnpipeOutput, references, graphStyleConnected: shot.graphStyleConnected, graphVideoStyleConnected: shot.graphVideoStyleConnected, graphEditStyleConnected: shot.graphEditStyleConnected, graphOutputSource: shot.graphOutputSource, graphOutputRefId: shot.graphOutputRefId, graphEditSourceRefId: shot.graphEditSourceRefId });
  cb.current = { onPromptChange, onStyleChange, onToggleBrand, prompt, videoPromptValue, editPromptValue, setLightbox, styles, styleValue, onStyleDetached, onRunImageGen, onRunVideoGen, onRunEditGen, onSelectGraphGen, onCycleGraphGen, onGraphField, onPipeImageToVideo, onPipeImageToOutput, onPipeVideoToOutput, onPipeEditToOutput, onPipeRefToOutput, onUnpipeImageGen, onUnpipeImageToVideo, onUnpipeVideoGen, onUnpipeEditGen, onUnpipeOutput, references, graphStyleConnected: shot.graphStyleConnected, graphVideoStyleConnected: shot.graphVideoStyleConnected, graphEditStyleConnected: shot.graphEditStyleConnected, graphOutputSource: shot.graphOutputSource, graphOutputRefId: shot.graphOutputRefId, graphEditSourceRefId: shot.graphEditSourceRefId };
  // Live-draft handles registered by the three prompt nodes (see
  // PromptDraftApplier). Prompt mutations below prefer them over cb.current's
  // prop values, which lag the node's local draft while it is focused.
  const appliers = useRef<Partial<Record<"composer" | "video" | "edit", PromptDraftApplier>>>({});
  /** Apply a prompt transform to the live draft when one exists; returns true
   *  when handled (the applier emitted upstream itself). */
  const applyDraftEdit = (kind: "composer" | "video" | "edit", fn: (t: string) => string): boolean => {
    const a = appliers.current[kind];
    if (!a) return false;
    a.apply(fn);
    return true;
  };
  const stable = useRef({
    onPromptChange: (value: string) => cb.current.onPromptChange(value),
    onStyleChange: (style: string) => {
      // Persist first (setGraphStyle rewrites the on-disk prompts and updates
      // the prompt cache), then rewrite the composer's LIVE draft so a focused
      // composer's blur-sync (a setTimeout) can never resurrect the Style
      // paragraph this change removes/replaces. "None" strips the paragraph
      // from any prompt that carries one, plugged or not.
      cb.current.onStyleChange(style);
      const text = cb.current.styles.find((s) => s.id === style)?.prompt.trim() ?? "";
      const rewrite = (cur: string): string => (text ? addStyleParagraph(cur, text) : removeStyleParagraph(cur));
      if (text) {
        if (cb.current.graphStyleConnected ?? /^Style:/m.test(cb.current.prompt ?? "")) applyDraftEdit("composer", rewrite);
      } else {
        applyDraftEdit("composer", rewrite);
      }
    },
    onToggleBrand: (include: boolean) => cb.current.onToggleBrand(include),
    registerApplier: (kind: "composer" | "video" | "edit", applier: PromptDraftApplier | undefined) => {
      if (applier) appliers.current[kind] = applier;
      else delete appliers.current[kind];
    },
    onToggle: (name: string, currentlyTagged: boolean) => {
      // Prefer the live draft: a focused composer holds edits the prop
      // hasn't seen, and its blur-sync would otherwise overwrite the tag
      // change made here (dropping the reference from the saved prompt).
      if (applyDraftEdit("composer", (t) => {
        const tagged = refTagNames(t).some((n) => n.toLowerCase() === name.toLowerCase());
        return tagged ? removeRefTag(t, name) : addRefTag(t, name);
      })) return;
      const p = cb.current.prompt;
      cb.current.onPromptChange(currentlyTagged ? removeRefTag(p, name) : addRefTag(p, name));
    },
    onZoom: (name: string, artwork: string) => cb.current.setLightbox({ name, artwork }),
    onRunImageGen: (model: string, resolution: string) => cb.current.onRunImageGen(model, resolution),
    onRunVideoGen: (model: string, resolution: string, durationSec: number) => cb.current.onRunVideoGen(model, resolution, durationSec),
    onRunEditGen: (model: string, resolution: string) => cb.current.onRunEditGen(model, resolution),
    onSelectImageGen: (index: number) => cb.current.onSelectGraphGen("image", index),
    onSelectVideoGen: (index: number) => cb.current.onSelectGraphGen("video", index),
    onSelectEditGen: (index: number) => cb.current.onSelectGraphGen("edit", index),
    onCycleImageGen: (dir: 1 | -1) => cb.current.onCycleGraphGen("image", dir),
    onCycleVideoGen: (dir: 1 | -1) => cb.current.onCycleGraphGen("video", dir),
    onCycleEditGen: (dir: 1 | -1) => cb.current.onCycleGraphGen("edit", dir),
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
    onEditPromptChange: (text: string) => cb.current.onGraphField({ graphEditPrompt: text }),
    onPipeImageToVideo: () => cb.current.onPipeImageToVideo(),
    onPipeImageToOutput: () => cb.current.onPipeImageToOutput(),
    onPipeVideoToOutput: () => cb.current.onPipeVideoToOutput(),
    onPipeEditToOutput: () => cb.current.onPipeEditToOutput(),
    onPipeRefToOutput: (refId: string) => cb.current.onPipeRefToOutput(refId),
    onUnpipeImageGen: () => cb.current.onUnpipeImageGen(),
    onUnpipeImageToVideo: () => cb.current.onUnpipeImageToVideo(),
    onUnpipeVideoGen: () => cb.current.onUnpipeVideoGen(),
    onUnpipeEditGen: () => cb.current.onUnpipeEditGen(),
    onUnpipeOutput: () => cb.current.onUnpipeOutput(),
    onRemoveRef: (refId: string) => {
      // Remove the node from the canvas, drop its saved position, and strip
      // the reference from every prompt + pipe so nothing dangles.
      removedRefIdsRef.current.add(refId);
      const next = nodesRef.current.filter((n) => n.id !== `ref:${refId}`);
      nodesRef.current = next;
      setNodes(next);
      setPlacedRefIds((prev) => { const n = new Set(prev); n.delete(refId); return n; });
      saveLayoutRef.current({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
      const entry = cb.current.references.find((r) => r.id === refId);
      if (entry) {
        const strip = (cur: string) => removeRefTag(cur, entry.name);
        if (refTagNames(cb.current.prompt).some((n) => n.toLowerCase() === entry.name.toLowerCase())) {
          if (!applyDraftEdit("composer", strip)) cb.current.onPromptChange(strip(cb.current.prompt));
        }
        if (refTagNames(cb.current.videoPromptValue).some((n) => n.toLowerCase() === entry.name.toLowerCase())) {
          cb.current.onGraphField({ graphVideoPrompt: strip(cb.current.videoPromptValue) });
        }
        if (refTagNames(cb.current.editPromptValue).some((n) => n.toLowerCase() === entry.name.toLowerCase())) {
          cb.current.onGraphField({ graphEditPrompt: strip(cb.current.editPromptValue) });
        }
        if (cb.current.graphOutputSource === "ref" && cb.current.graphOutputRefId === refId) cb.current.onUnpipeOutput();
        if (cb.current.graphEditSourceRefId === refId) cb.current.onGraphField({ graphEditSourceRefId: undefined });
      }
    },
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
      data: {
        name: ref.name,
        artwork: ref.artwork,
        media: ref.media,
        mediaUrl: ref.media === "video" && ref.mediaPath ? graphMediaUrl(prod.meta.id, ref.mediaPath) : undefined,
        tagged: false,
        refId: ref.id,
        onToggle: stable.onToggle,
        onZoom: stable.onZoom,
        onRemove: stable.onRemoveRef,
      },
      deletable: true,
    };
    const next = [...nodesRef.current, node];
    nodesRef.current = next;
    setNodes(next);
    setPlacedRefIds((prev) => { const n = new Set(prev); n.add(ref.id); return n; });
    saveLayoutRef.current({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
    showHint(`@[${ref.name}] added to the canvas — connect it to a prompt, the edit source, or the output.`);
  }, [showHint, stable, prod.meta.id]);

  /** Build a draggable-tool node pair (video: videogen+videoprompt, edit:
   *  editgen+editprompt) at the given positions. Shared by buildDerived (which
   *  lays them out at their default slots) and addTool (drop position). */
  const toolPair = useCallback((kind: "video" | "edit", genPos: { x: number; y: number }, promptPos: { x: number; y: number }): GraphNode[] => {
    if (kind === "video") {
      return [
        {
          id: "videogen",
          type: "videogen",
          position: genPos,
          data: {
            models: videoModels,
            items: (shot.graphVideoGens ?? []).map((g) => ({ url: graphMediaUrl(prod.meta.id, g.path), prompt: g.prompt })),
            selected: shot.graphVideoGenIndex ?? 0,
            hasImageSource: shot.graphImageToVideo === true,
            onGenerate: stable.onRunVideoGen,
            onSelect: stable.onSelectVideoGen,
            onCycle: stable.onCycleVideoGen,
            onModelOptions: stable.onModelOptions,
          },
          deletable: true,
        },
        {
          id: "videoprompt",
          type: "videoprompt",
          position: promptPos,
          data: { value: videoPromptValue, refHandles: taggedVideo.map((_, i) => `in-ref-${i}`), openHandleId: "in-ref-open", includeBrand: hasBrandParagraph(videoPromptValue), onChange: stable.onVideoPromptChange, registerApplier: (a) => stable.registerApplier("video", a) },
          deletable: true,
        },
      ];
    }
    return [
      {
        id: "editgen",
        type: "editgen",
        position: genPos,
        data: {
          models: imageModels,
          defaultResolution: prod.openArt?.resolution ?? "1k",
          items: (shot.graphEditGens ?? []).map((g) => ({ url: graphMediaUrl(prod.meta.id, g.path), prompt: g.prompt })),
          selected: shot.graphEditGenIndex ?? 0,
          sourceHint: shot.graphEditImageSource
            ? "piped frame"
            : shot.graphEditSourceRefId
              ? (references.find((r) => r.id === shot.graphEditSourceRefId)?.name ?? "reference")
              : "shot frame",
          onGenerate: stable.onRunEditGen,
          onSelect: stable.onSelectEditGen,
          onCycle: stable.onCycleEditGen,
        },
        deletable: true,
      },
      {
        id: "editprompt",
        type: "editprompt",
        position: promptPos,
        data: { value: editPromptValue, refHandles: taggedEdit.map((_, i) => `in-ref-${i}`), openHandleId: "in-ref-open", includeBrand: hasBrandParagraph(editPromptValue), onChange: stable.onEditPromptChange, registerApplier: (a) => stable.registerApplier("edit", a) },
        deletable: true,
      },
    ];
  }, [videoModels, imageModels, shot.graphVideoGens, shot.graphVideoGenIndex, shot.graphImageToVideo, shot.graphEditGens, shot.graphEditGenIndex, shot.graphEditImageSource, shot.graphEditSourceRefId, videoPromptValue, editPromptValue, taggedVideo, taggedEdit, stable, references, prod.meta.id, prod.openArt?.resolution]);

  /** Place a tool pair dragged from the right panel at the drop point. */
  const addTool = useCallback((kind: "video" | "edit", pos: { x: number; y: number }) => {
    const present = kind === "video" ? hasVideoTool : hasEditTool;
    if (present) {
      showHint(kind === "video" ? "The video generation node is already on the canvas." : "The edit-image node is already on the canvas.");
      return;
    }
    // The gen node lands at the drop point; its prompt node sits to the LEFT
    // (the prompt's source handle feeds the gen's in-prompt socket), keeping
    // the connecting edge roughly horizontal instead of below.
    const genPos = { x: pos.x, y: pos.y };
    const promptPos = { x: pos.x - 400, y: pos.y };
    const pair = toolPair(kind, genPos, promptPos);
    const next = [...nodesRef.current, ...pair];
    nodesRef.current = next;
    setNodes(next);
    setPlacedTools((prev) => { const n = new Set(prev); for (const node of pair) n.add(node.id); return n; });
    saveLayoutRef.current({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
    showHint(kind === "video" ? "Video generation node added — connect a frame or reference in, then generate." : "Edit-image node added — connect a source and an edit prompt, then edit.");
  }, [hasVideoTool, hasEditTool, showHint, toolPair]);

  /** Remove a placed-but-unused tool pair from the canvas (returns it to the
   *  right panel). Tools that are in use (generations/pipes/prompt) stay. */
  const removeTool = useCallback((kind: "video" | "edit") => {
    const ids = kind === "video" ? ["videogen", "videoprompt"] : ["editgen", "editprompt"];
    if ((kind === "video" ? videoGenActive : editGenActive)) return;
    setPlacedTools((prev) => { const n = new Set(prev); for (const id of ids) n.delete(id); return n; });
    const next = nodesRef.current.filter((n) => !ids.includes(n.id));
    nodesRef.current = next;
    setNodes(next);
    saveLayoutRef.current({ positions: Object.fromEntries(next.map((n) => [n.id, n.position])) });
  }, [videoGenActive, editGenActive]);

  const buildDerived = useCallback((): GraphNode[] => {
    const ORIGIN = { x: 0, y: 0 };
    const build = <T extends GraphNode>(node: T): T => ({ ...node, position: defaultPosition(node.id, availIds, taggedIds) });
    const visibleTagged = unionTagged.filter((t) => !(t.ref?.id && removedRefIdsRef.current.has(t.ref.id)));
    return [
      ...visibleTagged.map((t, i) => build({
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
          refId: t.ref?.id,
          onToggle: stable.onToggle,
          onZoom: stable.onZoom,
          onRemove: t.ref?.id ? stable.onRemoveRef : undefined,
        },
        deletable: true,
      })),
      ...available.filter((r) => !removedRefIdsRef.current.has(r.id)).map((r) => build({
        // Same id scheme as tagged refs, so toggling a tag never moves the
        // node — only its edge and column default change.
        id: `ref:${r.id}`,
        type: "ref" as const,
        position: ORIGIN,
        data: { name: r.name, artwork: r.artwork, media: r.media, mediaUrl: r.media === "video" && r.mediaPath ? graphMediaUrl(prod.meta.id, r.mediaPath) : undefined, tagged: false, refId: r.id, onToggle: stable.onToggle, onZoom: stable.onZoom, onRemove: stable.onRemoveRef },
        deletable: true,
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
        data: {},
        deletable: false,
      }),
      build({
        id: "composer",
        type: "composer" as const,
        position: ORIGIN,
        data: { value: prompt, refHandles: tagged.map((_, i) => `in-ref-${i}`), openHandleId: "in-ref-open", includeBrand: hasBrandParagraph(prompt), onChange: stable.onPromptChange, registerApplier: (a) => stable.registerApplier("composer", a) },
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
          if (shot.graphOutputSource === "editgen") {
            const sel = shot.graphEditGens?.[shot.graphEditGenIndex ?? 0];
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
      ...(hasVideoTool ? toolPair("video", ORIGIN, ORIGIN).map((n) => build(n)) : []),
      ...(hasEditTool ? toolPair("edit", ORIGIN, ORIGIN).map((n) => build(n)) : []),
    ];
  }, [unionTagged, tagged, taggedVideo, taggedEdit, available, availIds, taggedIds, stable, styles, styleValue, includeBrand, prompt, videoPromptValue, editPromptValue, thumbnail, shot.number, shot.artworkHistory, prod.meta.id, prod.openArt?.model, prod.openArt?.resolution, shot.graphImageGens, shot.graphImageGenIndex, shot.graphVideoGens, shot.graphVideoGenIndex, shot.graphImageToVideo, shot.graphEditGens, shot.graphEditGenIndex, shot.graphOutputSource, shot.graphOutputRefId, imageModels, videoModels, references, shot.graphEditImageSource, shot.graphEditSourceRefId, hasVideoTool, hasEditTool, toolPair]);

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
      let equal = true;
      if (d.type !== old.type) equal = false;
      else if (d.type === "composer") equal = (a.value as string) === (b.value as string) && (a.includeBrand as boolean) === (b.includeBrand as boolean) && (a.refHandles as string[]).length === (b.refHandles as string[]).length && (a.refHandles as string[]).every((v, i) => v === (b.refHandles as string[])[i]) && (a.openHandleId as string) === (b.openHandleId as string);
      else if (d.type === "videogen") equal = (a.hasImageSource as boolean) === (b.hasImageSource as boolean) && (a.selected as number) === (b.selected as number) && (a.items as unknown[]).length === (b.items as unknown[]).length;
      else if (d.type === "editgen") equal = (a.sourceHint as string) === (b.sourceHint as string) && (a.selected as number) === (b.selected as number) && (a.items as unknown[]).length === (b.items as unknown[]).length;
      else if (d.type === "videoprompt") equal = (a.value as string) === (b.value as string) && (a.includeBrand as boolean) === (b.includeBrand as boolean) && (a.refHandles as string[]).length === (b.refHandles as string[]).length && (a.refHandles as string[]).every((v, i) => v === (b.refHandles as string[])[i]) && (a.openHandleId as string) === (b.openHandleId as string);
      else if (d.type === "editprompt") equal = (a.value as string) === (b.value as string) && (a.includeBrand as boolean) === (b.includeBrand as boolean) && (a.refHandles as string[]).length === (b.refHandles as string[]).length && (a.refHandles as string[]).every((v, i) => v === (b.refHandles as string[])[i]) && (a.openHandleId as string) === (b.openHandleId as string);
      else if (d.type === "style") equal = (a.value as string) === (b.value as string);
      else if (d.type === "brand") equal = (a.include as boolean) === (b.include as boolean);
      else if (d.type === "ref") equal = (a.name as string) === (b.name as string) && (a.artwork as string) === (b.artwork as string) && (a.tagged as boolean) === (b.tagged as boolean) && (a.missing as boolean) === (b.missing as boolean);
      else if (d.type === "frame") equal = (a.previewUrl as string) === (b.previewUrl as string) && (a.previewKind as string) === (b.previewKind as string) && (a.bound as boolean) === (b.bound as boolean);
      else if (d.type === "imagegen") equal = (a.selected as number) === (b.selected as number) && (a.items as unknown[]).length === (b.items as unknown[]).length;
      if (equal) return old;
      changed = true;
      return { ...d, position: old.position, selected: old.selected, measured: old.measured };
    });
    if (!changed && next.length === nodesRef.current.length && next.every((n, i) => n === nodesRef.current[i])) return;
    nodesRef.current = next;
    setNodes(next);
  }, [buildDerived]);

  const edges = useMemo<Edge[]>(() => {
    // Style edges are freely pluggable — the edge shows whether the style node
    // is plugged into that prompt, independent of the dropdown value. Switching
    // the dropdown to "None" removes the Style paragraph but keeps the plug.
    const styleAttached = shot.graphStyleConnected ?? /^Style:/m.test(prompt);
    const styleAttachedVideo = shot.graphVideoStyleConnected ?? /^Style:/m.test(videoPromptValue);
    const styleAttachedEdit = shot.graphEditStyleConnected ?? /^Style:/m.test(editPromptValue);
    const brandAttached = hasBrandParagraph(prompt);
    const brandAttachedVideo = hasBrandParagraph(videoPromptValue);
    const brandAttachedEdit = hasBrandParagraph(editPromptValue);
    const nodeIdForTag = (name: string): string => {
      const entry = unionTagged.find((t) => t.name.toLowerCase() === name.toLowerCase());
      const idx = unionTagged.findIndex((t) => t.name.toLowerCase() === name.toLowerCase());
      return `ref:${entry?.ref?.id ?? "missing-" + idx}`;
    };
    return [
      ...tagged.map((t, i) => {
        const refNodeId = nodeIdForTag(t.name);
        return {
          id: `e-${refNodeId}-composer-${i}`,
          source: refNodeId,
          target: "composer",
          // Each connected reference gets its own input socket on the prompt.
          targetHandle: `in-ref-${i}`,
          style: { stroke: SOCKET_COLORS.ref },
          // No edge-end anchors — disconnecting is done by dragging the link
          // off a socket (onConnectEnd).
          reconnectable: false,
          selected: selectedEdges.has(`e-${refNodeId}-composer-${i}`),
        };
      }),
      ...taggedVideo.map((t, i) => {
        const refNodeId = nodeIdForTag(t.name);
        return {
          id: `e-${refNodeId}-videoprompt-${i}`,
          source: refNodeId,
          target: "videoprompt",
          targetHandle: `in-ref-${i}`,
          style: { stroke: SOCKET_COLORS.ref },
          reconnectable: false,
          selected: selectedEdges.has(`e-${refNodeId}-videoprompt-${i}`),
        };
      }),
      ...taggedEdit.map((t, i) => {
        const refNodeId = nodeIdForTag(t.name);
        return {
          id: `e-${refNodeId}-editprompt-${i}`,
          source: refNodeId,
          target: "editprompt",
          targetHandle: `in-ref-${i}`,
          style: { stroke: SOCKET_COLORS.ref },
          reconnectable: false,
          selected: selectedEdges.has(`e-${refNodeId}-editprompt-${i}`),
        };
      }),
      ...(styleAttached ? [{ id: "e-style", source: "style", target: "composer", targetHandle: "in-style", style: { stroke: SOCKET_COLORS.style }, deletable: false, reconnectable: false }] : []),
      ...(styleAttachedVideo ? [{ id: "e-style-vp", source: "style", target: "videoprompt", targetHandle: "in-style", style: { stroke: SOCKET_COLORS.style }, deletable: false, reconnectable: false }] : []),
      ...(styleAttachedEdit ? [{ id: "e-style-ep", source: "style", target: "editprompt", targetHandle: "in-style", style: { stroke: SOCKET_COLORS.style }, deletable: false, reconnectable: false }] : []),
      ...(brandAttached ? [{ id: "e-brand", source: "brand", target: "composer", targetHandle: "in-brand", style: { stroke: SOCKET_COLORS.brand }, deletable: false, reconnectable: false }] : []),
      ...(brandAttachedVideo ? [{ id: "e-brand-vp", source: "brand", target: "videoprompt", targetHandle: "in-brand", style: { stroke: SOCKET_COLORS.brand }, deletable: false, reconnectable: false }] : []),
      ...(brandAttachedEdit ? [{ id: "e-brand-ep", source: "brand", target: "editprompt", targetHandle: "in-brand", style: { stroke: SOCKET_COLORS.brand }, deletable: false, reconnectable: false }] : []),
      // Generation pipeline: composer feeds the image node; external prompt nodes
      // feed the video/edit nodes; pipes into the output mirror the binding.
      { id: "e-cmp-img", source: "composer", target: "imagegen", targetHandle: "in-prompt", deletable: false, reconnectable: false },
      ...(hasVideoTool ? [{ id: "e-vp-vid", source: "videoprompt", target: "videogen", targetHandle: "in-prompt", deletable: false, reconnectable: false }] : []),
      ...(hasEditTool ? [{ id: "e-ep-edit", source: "editprompt", target: "editgen", targetHandle: "in-prompt", deletable: false, reconnectable: false }] : []),
      ...(shot.graphImageToVideo ? [{ id: "e-img-vid", source: "imagegen", target: "videogen", targetHandle: "in-image", style: { stroke: SOCKET_COLORS.ref }, deletable: false, reconnectable: false }] : []),
      ...(shot.graphEditImageSource ? [{ id: "e-img-edit", source: "imagegen", target: "editgen", targetHandle: "in-image", style: { stroke: SOCKET_COLORS.ref }, deletable: false, reconnectable: false }] : []),
      ...(shot.graphEditSourceRefId && references.some((r) => r.id === shot.graphEditSourceRefId) ? [{ id: "e-ref-edit", source: `ref:${shot.graphEditSourceRefId}`, target: "editgen", targetHandle: "in-image", style: { stroke: SOCKET_COLORS.ref }, deletable: false, reconnectable: false }] : []),
      ...(shot.graphOutputSource === "imagegen" ? [{ id: "e-img-out", source: "imagegen", target: "output", targetHandle: "in-out", deletable: false, reconnectable: false }] : []),
      ...(shot.graphOutputSource === "videogen" ? [{ id: "e-vid-out", source: "videogen", target: "output", targetHandle: "in-out", deletable: false, reconnectable: false }] : []),
      ...(shot.graphOutputSource === "editgen" ? [{ id: "e-edit-out", source: "editgen", target: "output", targetHandle: "in-out", deletable: false, reconnectable: false }] : []),
      ...(shot.graphOutputSource === "ref" && shot.graphOutputRefId && references.some((r) => r.id === shot.graphOutputRefId) ? [{ id: "e-ref-out", source: `ref:${shot.graphOutputRefId}`, target: "output", targetHandle: "in-out", style: { stroke: SOCKET_COLORS.ref }, deletable: false, reconnectable: false }] : []),
      // The output is fed ONLY by the generation nodes or a reference — the
      // composer's classic straight-to-output pipe is gone.
    ];
  }, [unionTagged, tagged, taggedVideo, taggedEdit, selectedEdges, prompt, videoPromptValue, editPromptValue, shot.graphImageToVideo, shot.graphEditImageSource, shot.graphEditSourceRefId, shot.graphOutputSource, shot.graphOutputRefId, references, hasVideoTool, hasEditTool]);

  const onNodesChange = useCallback<OnNodesChange<GraphNode>>((changes) => {
    // Canonical controlled flow: apply every change (position, select,
    // dimension) to the persistent node state in one pass so React Flow's
    // internal selection bookkeeping and our state never diverge.
    const dragStop = changes.some((c) => c.type === "position" && c.dragging !== true);
    let removed = changes.filter((c): c is { type: "remove"; id: string } => c.type === "remove");

    // Tool nodes delete as a PAIR (gen + prompt) and return to the right panel
    // — unless the tool is in use (stored generations, pipes, prompt text), in
    // which case the delete is blocked: the pair owns that data.
    const blockedToolIds = new Set<string>();
    for (const c of removed) {
      if (c.id === "videogen" || c.id === "videoprompt") { if (videoGenActive) blockedToolIds.add(c.id); }
      else if (c.id === "editgen" || c.id === "editprompt") { if (editGenActive) blockedToolIds.add(c.id); }
    }
    if (blockedToolIds.size > 0) {
      showHint("This node is in use (clips, edits, or pipes) — clear its generations or pipes before removing it.");
      removed = removed.filter((c) => !blockedToolIds.has(c.id));
      changes = changes.filter((c) => c.type !== "remove" || !blockedToolIds.has(c.id));
    }
    // Deleting either node of an inactive tool pair removes BOTH, returning the
    // unit to the right panel as one tile.
    const toolKindRemoved = new Set<"video" | "edit">();
    const toolNodeIds = new Set<string>();
    for (const c of removed) {
      if (c.id === "videogen" || c.id === "videoprompt") toolKindRemoved.add("video");
      else if (c.id === "editgen" || c.id === "editprompt") toolKindRemoved.add("edit");
    }
    if (toolKindRemoved.has("video")) { toolNodeIds.add("videogen"); toolNodeIds.add("videoprompt"); }
    if (toolKindRemoved.has("edit")) { toolNodeIds.add("editgen"); toolNodeIds.add("editprompt"); }

    const next = applyNodeChanges(changes, nodesRef.current);
    const final = toolNodeIds.size > 0 ? next.filter((n) => !toolNodeIds.has(n.id)) : next;
    if (toolKindRemoved.has("video")) {
      setPlacedTools((prev) => { const n = new Set(prev); n.delete("videogen"); n.delete("videoprompt"); return n; });
    }
    if (toolKindRemoved.has("edit")) {
      setPlacedTools((prev) => { const n = new Set(prev); n.delete("editgen"); n.delete("editprompt"); return n; });
    }
    // Ref node deletion (select + Delete/Backspace): strip the reference from
    // every prompt + pipe and drop its position so it returns to the shelf.
    for (const c of removed) {
      const m = /^ref:(.+)$/.exec(c.id);
      if (!m) continue;
      const refId = m[1];
      removedRefIdsRef.current.add(refId);
      setPlacedRefIds((prev) => { const n = new Set(prev); n.delete(refId); return n; });
      const entry = cb.current.references.find((r) => r.id === refId);
      if (entry) {
        const strip = (cur: string) => removeRefTag(cur, entry.name);
        if (refTagNames(cb.current.prompt).some((n) => n.toLowerCase() === entry.name.toLowerCase())) {
          if (!applyDraftEdit("composer", strip)) cb.current.onPromptChange(strip(cb.current.prompt));
        }
        if (refTagNames(cb.current.videoPromptValue).some((n) => n.toLowerCase() === entry.name.toLowerCase())) {
          cb.current.onGraphField({ graphVideoPrompt: strip(cb.current.videoPromptValue) });
        }
        if (refTagNames(cb.current.editPromptValue).some((n) => n.toLowerCase() === entry.name.toLowerCase())) {
          cb.current.onGraphField({ graphEditPrompt: strip(cb.current.editPromptValue) });
        }
        if (cb.current.graphOutputSource === "ref" && cb.current.graphOutputRefId === refId) cb.current.onUnpipeOutput();
        if (cb.current.graphEditSourceRefId === refId) cb.current.onGraphField({ graphEditSourceRefId: undefined });
      }
    }
    nodesRef.current = final;
    setNodes(final);
    if (dragStop || removed.length > 0 || toolNodeIds.size > 0) {
      // One save per drag gesture. The state only ever contains live nodes,
      // so no pruning is needed for deleted references.
      saveLayoutRef.current({ positions: Object.fromEntries(final.map((n) => [n.id, n.position])) });
    }
  }, [videoGenActive, editGenActive, showHint]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) {
      if (c.type === "remove") {
        // Reference edges are deletable via keyboard (select+Delete) —
        // ids are `e-<refId>-<target>-<idx>` for the three prompt nodes.
        const m = /^e-ref:(.+)-(composer|videoprompt|editprompt)-(\d+)$/.exec(c.id);
        if (m) {
          const [, , targetKind, idxStr] = m;
          const idx = Number(idxStr);
          const list = targetKind === "composer" ? tagged : targetKind === "videoprompt" ? taggedVideo : taggedEdit;
          const entry = list[idx];
          if (entry) {
            if (targetKind === "composer") { if (!applyDraftEdit("composer", (t) => removeRefTag(t, entry.name))) onPromptChange(removeRefTag(prompt, entry.name)); }
            else if (targetKind === "videoprompt") cb.current.onGraphField({ graphVideoPrompt: removeRefTag(cb.current.videoPromptValue, entry.name) });
            else cb.current.onGraphField({ graphEditPrompt: removeRefTag(cb.current.editPromptValue, entry.name) });
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
  }, [tagged, taggedVideo, taggedEdit, prompt, onPromptChange]);

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return;
    // Generation pipes: the image node's output feeds the video/edit image
    // inputs and/or the output (both can coexist); the video/edit nodes feed
    // the output; a reference can feed the output or the edit node's source.
    if (conn.source === "imagegen" && conn.target === "videogen") { cb.current.onPipeImageToVideo(); return; }
    if (conn.source === "imagegen" && conn.target === "output") { cb.current.onPipeImageToOutput(); return; }
    if (conn.source === "imagegen" && conn.target === "editgen" && conn.targetHandle === "in-image") { cb.current.onGraphField({ graphEditImageSource: true, graphEditSourceRefId: undefined }); return; }
    if (conn.source === "videogen" && conn.target === "output") { cb.current.onPipeVideoToOutput(); return; }
    if (conn.source === "editgen" && conn.target === "output") { cb.current.onPipeEditToOutput(); return; }
    const refId = /^ref:(.+)$/.exec(conn.source)?.[1];
    if (refId) {
      if (conn.target === "output") { cb.current.onPipeRefToOutput(refId); return; }
      if (conn.target === "editgen" && conn.targetHandle === "in-image") {
        cb.current.onGraphField({ graphEditSourceRefId: refId, graphEditImageSource: undefined });
        return;
      }
    }
    // Prompt nodes: style / brand / reference inputs — exactly like composer.
    if (conn.target === "composer" || conn.target === "videoprompt" || conn.target === "editprompt") {
      const isComposer = conn.target === "composer";
      const isVideo = conn.target === "videoprompt";
      if (conn.source === "style") {
        const text = cb.current.styles.find((s) => s.id === cb.current.styleValue)?.prompt.trim() ?? "";
        if (isComposer) {
          cb.current.onGraphField({ graphStyleConnected: true });
          if (!applyDraftEdit("composer", (t) => addStyleParagraph(t, text))) cb.current.onPromptChange(addStyleParagraph(cb.current.prompt, text));
        } else if (isVideo) {
          cb.current.onGraphField({ graphVideoStyleConnected: true, graphVideoPrompt: addStyleParagraph(cb.current.videoPromptValue, text) });
        } else {
          cb.current.onGraphField({ graphEditStyleConnected: true, graphEditPrompt: addStyleParagraph(cb.current.editPromptValue, text) });
        }
        return;
      }
      if (conn.source === "brand") {
        const getBrandNext = (cur: string) => cur.trimEnd() ? `${cur.trimEnd()}\n\nBrand identity: auto` : `Brand identity: auto`;
        if (isComposer) {
          if (!applyDraftEdit("composer", (t) => hasBrandParagraph(t) ? t : getBrandNext(t)) && !hasBrandParagraph(cb.current.prompt)) cb.current.onPromptChange(getBrandNext(cb.current.prompt));
          return;
        }
        const cur = isVideo ? cb.current.videoPromptValue : cb.current.editPromptValue;
        if (!hasBrandParagraph(cur)) {
          const next = getBrandNext(cur);
          if (isVideo) cb.current.onGraphField({ graphVideoPrompt: next });
          else cb.current.onGraphField({ graphEditPrompt: next });
        }
        return;
      }
      const m = /^ref:(.+)$/.exec(conn.source);
      if (!m) return;
      const ref = references.find((r) => r.id === m[1]);
      if (!ref) return;
      if (isComposer) {
        if (!applyDraftEdit("composer", (t) => addRefTag(t, ref.name))) onPromptChange(addRefTag(prompt, ref.name));
      }
      else if (isVideo) cb.current.onGraphField({ graphVideoPrompt: addRefTag(cb.current.videoPromptValue, ref.name) });
      else cb.current.onGraphField({ graphEditPrompt: addRefTag(cb.current.editPromptValue, ref.name) });
      return;
    }
  }, [references, prompt, onPromptChange]);

  /** Reference→open-input, style→style, brand→brand, imagegen→video/edit/output
   *  (all at once allowed), videogen→output, editgen→output, ref→output
   *  (image/video refs only), ref→edit-node source (image refs only), plus fixed
   *  prompt pipes — everything else is rejected. Prompt nodes (composer,
   *  videoprompt, editprompt) each accept Style / Reference / Brand exactly alike. */
  const isValidConnection = useCallback((c: Connection | Edge) => {
    const source = c.source ?? "";
    if (source === "videoprompt") return c.target === "videogen" && c.targetHandle === "in-prompt";
    if (source === "editprompt") return c.target === "editgen" && c.targetHandle === "in-prompt";
    if (source === "composer") return c.target === "imagegen" && c.targetHandle === "in-prompt";
    if (source === "imagegen") {
      if (c.target === "videogen") return c.targetHandle === "in-image";
      if (c.target === "editgen") return c.targetHandle === "in-image";
      if (c.target === "output") return c.targetHandle === "in-out";
      return false;
    }
    if (source === "videogen") return c.target === "output" && c.targetHandle === "in-out";
    if (source === "editgen") return c.target === "output" && c.targetHandle === "in-out";
    const refId = /^ref:(.+)$/.exec(source)?.[1];
    if (refId) {
      const ref = references.find((r) => r.id === refId);
      if (c.target === "output") return c.targetHandle === "in-out" && !!ref && ref.media !== "audio";
      if (c.target === "editgen") return c.targetHandle === "in-image" && !!ref && !!ref.artwork && ref.media !== "audio";
      if (c.target === "composer" || c.target === "videoprompt" || c.target === "editprompt") return c.targetHandle === "in-ref-open" && !!ref;
      return false;
    }
    if (c.target === "composer" || c.target === "videoprompt" || c.target === "editprompt") {
      if (source === "style") return c.targetHandle === "in-style";
      if (source === "brand") return c.targetHandle === "in-brand";
      return false;
    }
    return false;
  }, [references]);

  const onConnectEnd = useCallback<OnConnectEnd>((_event, state) => {
    // Blender-style disconnect: grab a link at either end and release it into
    // empty space. Releasing on/near any socket snaps back instead.
    if (state.isValid || state.toHandle) return;
    const from = state.fromHandle;
    if (!from) return;
    const detachPrompt = (nodeId: string, handleId: string): boolean => {
      if (nodeId === "composer") {
        if (handleId === "in-style") {
          cb.current.onGraphField({ graphStyleConnected: false, style: undefined, styleNone: true });
          if (!applyDraftEdit("composer", (t) => removeStyleParagraph(t))) cb.current.onPromptChange(removeStyleParagraph(cb.current.prompt));
          return true;
        }
        if (handleId === "in-brand") { if (!applyDraftEdit("composer", (t) => stripBrandParagraph(t))) cb.current.onPromptChange(stripBrandParagraph(cb.current.prompt)); return true; }
        const m = /^in-ref-(\d+)$/.exec(handleId);
        if (m) { const t = tagged[Number(m[1])]; if (t && !applyDraftEdit("composer", (cur) => removeRefTag(cur, t.name))) cb.current.onPromptChange(removeRefTag(cb.current.prompt, t.name)); return true; }
      } else if (nodeId === "videoprompt") {
        if (handleId === "in-style") { cb.current.onGraphField({ graphVideoStyleConnected: false, graphVideoPrompt: removeStyleParagraph(cb.current.videoPromptValue) }); return true; }
        if (handleId === "in-brand") { cb.current.onGraphField({ graphVideoPrompt: stripBrandParagraph(cb.current.videoPromptValue) }); return true; }
        const m = /^in-ref-(\d+)$/.exec(handleId);
        if (m) { const t = taggedVideo[Number(m[1])]; if (t) cb.current.onGraphField({ graphVideoPrompt: removeRefTag(cb.current.videoPromptValue, t.name) }); return true; }
      } else if (nodeId === "editprompt") {
        if (handleId === "in-style") { cb.current.onGraphField({ graphEditStyleConnected: false, graphEditPrompt: removeStyleParagraph(cb.current.editPromptValue) }); return true; }
        if (handleId === "in-brand") { cb.current.onGraphField({ graphEditPrompt: stripBrandParagraph(cb.current.editPromptValue) }); return true; }
        const m = /^in-ref-(\d+)$/.exec(handleId);
        if (m) { const t = taggedEdit[Number(m[1])]; if (t) cb.current.onGraphField({ graphEditPrompt: removeRefTag(cb.current.editPromptValue, t.name) }); return true; }
      }
      return false;
    };
    if (from.type === "target" && (from.nodeId === "composer" || from.nodeId === "videoprompt" || from.nodeId === "editprompt")) {
      if (detachPrompt(from.nodeId, from.id ?? "")) return;
    }
    if (from.type === "target" && from.nodeId === "videogen" && from.id === "in-image") {
      cb.current.onUnpipeImageToVideo();
      return;
    }
    if (from.type === "target" && from.nodeId === "editgen" && from.id === "in-image") {
      cb.current.onGraphField({ graphEditImageSource: undefined, graphEditSourceRefId: undefined });
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
    if (from.type === "source" && from.nodeId === "editgen") {
      cb.current.onUnpipeEditGen();
      return;
    }
    if (from.type === "source") {
      if (from.nodeId === "style") {
        const patch: Partial<ProductionShot> = { graphStyleConnected: false, graphVideoStyleConnected: false, graphEditStyleConnected: false, style: undefined, styleNone: true };
        if (/^Style:/m.test(cb.current.videoPromptValue)) patch.graphVideoPrompt = removeStyleParagraph(cb.current.videoPromptValue);
        if (/^Style:/m.test(cb.current.editPromptValue)) patch.graphEditPrompt = removeStyleParagraph(cb.current.editPromptValue);
        cb.current.onGraphField(patch);
        if (!applyDraftEdit("composer", (t) => removeStyleParagraph(t)) && /^Style:/m.test(cb.current.prompt)) cb.current.onPromptChange(removeStyleParagraph(cb.current.prompt));
        return;
      }
      if (from.nodeId === "brand") {
        if (!applyDraftEdit("composer", (t) => stripBrandParagraph(t)) && hasBrandParagraph(cb.current.prompt)) cb.current.onPromptChange(stripBrandParagraph(cb.current.prompt));
        if (hasBrandParagraph(cb.current.videoPromptValue)) cb.current.onGraphField({ graphVideoPrompt: stripBrandParagraph(cb.current.videoPromptValue) });
        if (hasBrandParagraph(cb.current.editPromptValue)) cb.current.onGraphField({ graphEditPrompt: stripBrandParagraph(cb.current.editPromptValue) });
        return;
      }
      const m = /^ref:(.+)$/.exec(from.nodeId ?? "");
      if (!m) return;
      const refId = m[1];
      // Remove this ref from any prompt where it is tagged
      const stripIfTagged = (list: { name: string; ref: GraphRef | null }[], value: string, setter: (v: string) => void) => {
        const entry = list.find((t) => (t.ref?.id ?? `missing:${t.name.toLowerCase()}`) === refId || t.ref?.id === refId);
        if (entry) setter(removeRefTag(value, entry.name));
      };
      stripIfTagged(tagged, cb.current.prompt, (v) => { if (!applyDraftEdit("composer", () => v)) cb.current.onPromptChange(v); });
      stripIfTagged(taggedVideo, cb.current.videoPromptValue, (v) => cb.current.onGraphField({ graphVideoPrompt: v }));
      stripIfTagged(taggedEdit, cb.current.editPromptValue, (v) => cb.current.onGraphField({ graphEditPrompt: v }));
      // Also check union dangling tag by name
      const unionEntry = unionTagged.find((t) => (t.ref?.id ?? `missing:${t.name.toLowerCase()}`) === refId || t.ref?.id === refId);
      if (unionEntry) {
        // Ensure removal even if not in per-prompt list due to timing
        if (refTagNames(cb.current.prompt).some((n) => n.toLowerCase() === unionEntry.name.toLowerCase())) { if (!applyDraftEdit("composer", (t) => removeRefTag(t, unionEntry.name))) cb.current.onPromptChange(removeRefTag(cb.current.prompt, unionEntry.name)); }
        if (refTagNames(cb.current.videoPromptValue).some((n) => n.toLowerCase() === unionEntry.name.toLowerCase())) cb.current.onGraphField({ graphVideoPrompt: removeRefTag(cb.current.videoPromptValue, unionEntry.name) });
        if (refTagNames(cb.current.editPromptValue).some((n) => n.toLowerCase() === unionEntry.name.toLowerCase())) cb.current.onGraphField({ graphEditPrompt: removeRefTag(cb.current.editPromptValue, unionEntry.name) });
      }
      if (cb.current.graphOutputSource === "ref" && cb.current.graphOutputRefId === refId) cb.current.onUnpipeOutput();
      if (cb.current.graphEditSourceRefId === refId) cb.current.onGraphField({ graphEditSourceRefId: undefined });
    }
  }, [tagged, taggedVideo, taggedEdit, unionTagged]);

  useEffect(() => () => { if (hintTimer.current !== null) window.clearTimeout(hintTimer.current); }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Map the drop point into flow coordinates; fall back to the origin when
    // the transform isn't measurable (pre-init, jsdom) or yields non-finite.
    const p = flowRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const pos = { x: Number.isFinite(p?.x) ? (p?.x ?? 0) : 0, y: Number.isFinite(p?.y) ? (p?.y ?? 0) : 0 };
    // Right-panel tool drag: place a video/edit node pair at the drop point.
    const toolKind = e.dataTransfer.getData("application/x-cascade-tool");
    if (toolKind === "video" || toolKind === "edit") {
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
    for (const file of files) {
      if (!file.type.startsWith("image/") && !file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
        showHint(`${file.name}: only image, video, and audio files become references.`);
        continue;
      }
      onDropFile(file);
    }
  }, [onDropFile, showHint, references, addPlacedRef, addTool]);

  return (
    <div className="prod-edit-overlay prod-graph-overlay" onClick={onClose}>
      <div className="prod-graph-panel" onClick={(e) => e.stopPropagation()}>
        <div className="prod-graph-head">
          <span className="prod-graph-title">Shot {shot.number} — node graph</span>
          <span className="prod-graph-hint">Prompt text is the source of truth · drag references from the left shelf or tool nodes from the right panel onto the canvas · left-drag moves nodes · right-drag pans · drag a connection off a socket to detach it</span>
          <button className="prod-btn" onClick={onClose}>Close</button>
        </div>
        <div className="prod-graph-body">
          <div className="prod-graph-shelf">
            <div className="prod-graph-shelf-head">
              <span className="prod-graph-shelf-title">References</span>
              <span className="prod-graph-shelf-hint">Drag onto the canvas to add</span>
            </div>
            <div className="prod-graph-shelf-list">
              {shelfGroups.map((group) => (
                <ShelfGroup key={group.title} prodId={prod.meta.id} group={group} onCanvasRefIds={onCanvasRefIds} />
              ))}
              {references.length === 0 && <div className="prod-graph-shelf-empty">No references yet — drop image, video, or audio files onto the canvas to create them.</div>}
            </div>
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
            <div className="prod-ref-lightbox prod-graph-lightbox" onClick={() => setLightbox(null)}>
              <figure className="prod-ref-lightbox-card">
                <img src={lightbox.artwork} alt={lightbox.name} />
                <figcaption>{lightbox.name} — click anywhere to close</figcaption>
              </figure>
            </div>
          )}
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
                <svg className="prod-graph-tools-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 3l9 5-9 5V3z" fill="currentColor" /></svg>
                <span className="prod-graph-tools-label">Video generation</span>
                {hasVideoTool && (
                  <button
                    className="prod-graph-tools-remove"
                    disabled={videoGenActive}
                    title={videoGenActive ? "In use — has clips or pipes" : "Remove from the canvas"}
                    onClick={() => removeTool("video")}
                  >×</button>
                )}
              </div>
              <div
                className={"prod-graph-tools-item" + (hasEditTool ? " on-canvas" : "")}
                draggable={!hasEditTool}
                title={hasEditTool ? "Already on the canvas" : "Drag onto the canvas to add the edit-image node"}
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-cascade-tool", "edit");
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                <svg className="prod-graph-tools-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M11.5 1.5l3 3-8 8-4 1 1-4 8-8z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
                <span className="prod-graph-tools-label">Edit image</span>
                {hasEditTool && (
                  <button
                    className="prod-graph-tools-remove"
                    disabled={editGenActive}
                    title={editGenActive ? "In use — has edits or pipes" : "Remove from the canvas"}
                    onClick={() => removeTool("edit")}
                  >×</button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
