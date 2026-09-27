/**
 * The reference-node tile (extracted from NodeGraphModal so the shot-sequence
 * canvas can reuse the exact same node — its image nodes are "exactly like
 * reference nodes"). Also owns the ref node's saved-size math, which both
 * canvases persist into `GraphLayout.sizes`.
 */
import { memo, useCallback, useEffect, useState } from "react";
import {
  Handle,
  NodeResizer,
  Position,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { GraphLayout } from "../../../../shared/ipc.js";
import { useImageContextMenu } from "../image-context-menu.js";
import { refThumbUrl } from "../production/thumb-url.js";
import { EyeIcon, EyeOffIcon, MagnifyIcon } from "../icons.js";

/** Split a `cascade-media://` URL into the production id + workspace-relative
 *  path main needs to resolve the full-res file (e.g. "Edit externally").
 *  Returns null for inline data URLs and anything else. */
export function parseGraphMediaUrl(url: string): { productionId: string; relPath: string } | null {
  if (!url.startsWith("cascade-media://")) return null;
  try {
    const u = new URL(url);
    const relPath = decodeURIComponent(u.pathname).replace(/^\/+/, "");
    return u.hostname && relPath ? { productionId: u.hostname, relPath } : null;
  } catch {
    return null;
  }
}

/** Reference-node size. A collapsed ref shows only the name + a small thumb, so
 *  it takes a fixed narrow width - its expanded width/height stay in
 *  `GraphLayout.sizes` and are restored on expand. */
export const REF_DEFAULT_WIDTH = 236;
export const REF_COLLAPSED_WIDTH = 170;
export function refSizeStyle(layout: GraphLayout | undefined, id: string, collapsed: boolean): { width: number; height?: number } {
  if (collapsed) return { width: REF_COLLAPSED_WIDTH };
  const saved = layout?.sizes?.[id];
  return saved ? { width: saved.width, height: saved.height } : { width: REF_DEFAULT_WIDTH };
}

/** Minimal reference shape (structurally identical to PromptReference). */
export interface GraphRef {
  id: string;
  name: string;
  artwork: string;
  media?: "video" | "audio";
  /** Workspace-relative media path (video/audio refs), for cascade-media URLs. */
  mediaPath?: string;
  /** A host-supplied input that is not a user-managed reference (e.g. a shot
   *  sequence's member frame): rendered with a plain name and not deletable or
   *  renameable on the canvas. */
  locked?: boolean;
}

/** The reference tile's node payload. */
export interface RefData extends Record<string, unknown> {
  name: string;
  /** Full-resolution artwork (cascade-media URL or inline data URL) - the node
   *  tile, the zoom lightbox, and the context menu all use it. */
  artwork: string;
  /** Playable cascade-media URL for video references. */
  mediaUrl?: string;
  /** false = tag present in the prompt but no matching reference (dangling). */
  missing?: boolean;
  tagged: boolean;
  /** Wired into a generation input rather than a prompt reference socket -
   *  source frame/clip, tween keyframe, or the output feed. Such a node is in
   *  use even when no prompt cites it, so it renders opaque (not the idle
   *  "available" tint). */
  sourced?: boolean;
  /** Real reference id (absent for dangling tags) - for the rename box. */
  refId?: string;
  /** Show the name verbatim (e.g. "Shot 0100" on a sequence-canvas frame
   *  node) instead of the `@[name]` prompt-tag form. */
  plainName?: boolean;
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
export type RefFlowNode = Node<RefData, "ref">;

export const RefNodeView = memo(function RefNodeView({ id, data, selected }: NodeProps<RefFlowNode>) {
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
  // just-placed tile can be dragged from before that measurement lands - the
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
        ? <div className="prod-graph-ref-blank" title={data.media === "audio" ? "Audio reference" : "Video reference"}>{data.media === "audio" ? "\u266A" : "\u25B6"}</div>
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
    : data.plainName
      ? <span className="prod-graph-ref-name" title={data.name}>{data.name}</span>
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
      title={collapsed ? "Expand - show the image" : "Collapse - hide the image"}
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
