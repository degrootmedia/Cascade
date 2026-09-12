import { memo, useEffect, useRef, useState } from "react";
import type { OpenArtModelChoice, Production, ProductionShot, VideoGenOptions, VideoModelOptions } from "../../../../shared/ipc.js";
import { isImageModel, isVideoModel, shotHasContent } from "../../../../shared/ipc.js";
import { getMediaDefault } from "./media-defaults.js";
import { afterFirstPaint, batchedBoardThumb } from "./board-thumbs.js";
import { boardFrameHistory } from "../../../../shared/board-frames.js";
import { closestResolution } from "../resolution.js";
import { promptRefsForShot } from "./references.js";
import { ReferencePromptEditor } from "./prompt-panel.js";
import { cascadeMedia } from "./animatic.js";
import { AutoTextarea } from "../AutoTextarea.js";
import { DragHandleIcon, EditIcon, FilmStripIcon, ImportIcon, MagnifyIcon, PlusIcon, RegenerateIcon } from "../icons.js";

function BoardCardInner({ prod, shot, bust, regenerating, videoBusy, pending, rechecking, onRegenerate, onRecheck, onImport, onEdit, onVideo, onTextChange, showScript, onPromptFocus, selected, onDropFrame, onPromoteHistory, draggable, onReorderDragStart, onReorderDrop, onReorderDragOver, onReorderDragEnd, isReorderTarget, isDragging, onInsertAfter, onDelete }: {
  prod: Production;
  shot: ProductionShot;
  bust: number;
  regenerating: boolean;
  videoBusy: boolean;
  /** A frame job outlived its wait — show a pending badge + recheck. */
  pending?: boolean;
  /** A recheck is currently polling the pending job. */
  rechecking?: boolean;
  onRegenerate: (shotId: string) => void;
  /** Recheck the shot's pending generation job and download the frame when ready. */
  onRecheck?: (shotId: string) => void;
  onImport: (shotId: string) => void;
  /** Open the AI edit dialog for this frame. */
  onEdit: (shotId: string) => void;
  /** Open the video-generation modal for this frame. */
  onVideo: (shotId: string) => void;
  /** Persist the shot's Audio/Visual direction edited in the card's boxes. */
  onTextChange: (shotId: string, patch: { audio: string; visual: string }) => void;
  /** Whether the Audio/Visual direction boxes render under the frame. */
  showScript: boolean;
  onPromptFocus: (shotId: string, prompt: string) => void;
  selected: boolean;
  /** Attach a frame dragged from another card as a reference on this shot. */
  onDropFrame: (shotId: string, source: { prodId: string; shotId: string; number: number }) => void;
  /** Select the browsed frame on its owning node and wire it to the output. */
  onPromoteHistory: (shotId: string, framePath: string) => void;
  draggable?: boolean;
  onReorderDragStart?: (shotId: string, e: React.DragEvent) => void;
  onReorderDrop?: (targetShotId: string, e: React.DragEvent) => void;
  onReorderDragOver?: (shotId: string) => void;
  onReorderDragEnd?: () => void;
  isReorderTarget?: boolean;
  isDragging?: boolean;
  /** Insert a blank shot in the gutter after this card (Step 3 hover "+"). */
  onInsertAfter?: (shotId: string) => void;
  /** Delete this shot (right-click menu). Confirmation is handled here when
   *  the shot has content; blank shots delete immediately. */
  onDelete?: (shotId: string) => void;
}) {
  const [img, setImg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [expandedImg, setExpandedImg] = useState<string | null>(null);
  const [expandedVideo, setExpandedVideo] = useState<string | null>(null);
  // The prompt lives in the parent (focused-shot) fetch — every card firing
  // its own getBoardPrompt IPC at mount was N wasted round-trips per page
  // open, and the value was never even read (focusPrompt ignores it).
  // Shot direction edited on the card (Step 1's table edits the same fields).
  // Local drafts commit on blur; incoming saves resync while not focused.
  const [audio, setAudio] = useState(shot.audio);
  const [visual, setVisual] = useState(shot.visual);
  const [textFocused, setTextFocused] = useState(false);
  useEffect(() => {
    if (textFocused) return;
    setAudio(shot.audio);
    setVisual(shot.visual);
  }, [shot.audio, shot.visual, textFocused]);
  function commitText() {
    if (audio !== shot.audio || visual !== shot.visual) onTextChange(shot.id, { audio, visual });
  }
  // Hover-preview video for the shot's generated clip (muted, looping). Falls
  // back to the still image if the clip can't be loaded.
  const boardVideoRef = useRef<HTMLVideoElement | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  // Browse the nodes' combined history by path, not a shifting array index.
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [histCache, setHistCache] = useState<Record<string, string>>({});
  const history = boardFrameHistory(shot);
  const histLen = history.length;
  const histIdx = historyPath && history.includes(historyPath) ? history.indexOf(historyPath) : null;
  const histPath = histIdx === null ? null : history[histIdx];
  // Thumbnails load icons-first through a narrow queue: each card waits for
  // first paint (so the icon <img>s committed in the same render win the
  // race to the screen) AND for the card to near the viewport, then takes
  // one of 4 queue slots — N cards no longer slam N parallel IPC resizes at
  // mount while icons are still decoding.
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let live = true;
    setImg(null);
    setHistoryPath(null);
    setHistCache({});
    setVideoFailed(false);
    if (!shot.artwork) return () => { live = false; };
    const load = () => {
      if (!live) return;
      void afterFirstPaint().then(() => {
        if (!live) return;
        // Perf 1.4: coalesced batch — N mounting cards collapse into one
        // boardThumbnails IPC per production instead of N round-trips.
        void batchedBoardThumb(prod.meta.id, shot.id)
          .then((d) => { if (live) setImg(d); })
          .catch(() => {});
      });
    };
    const el = cardRef.current;
    if (typeof IntersectionObserver === "function" && el) {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) { io.disconnect(); load(); }
        },
        // Start early so scrolling never shows a blank frame.
        { rootMargin: "600px" },
      );
      io.observe(el);
      return () => { live = false; io.disconnect(); };
    }
    load();
    return () => { live = false; };
  }, [prod.meta.id, shot.id, shot.artwork, shot.videoPath, bust]);

  // Lazily load the history frame being viewed.
  useEffect(() => {
    if (histPath === null) return;
    let live = true;
    if (!histCache[histPath]) {
      window.cascade.boardThumbnail(prod.meta.id, shot.id, histPath)
        .then((d) => { if (live && d) setHistCache((c) => ({ ...c, [histPath]: d })); })
        .catch(() => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histPath, prod.meta.id, shot.id]);

  const shownImg = histPath === null ? img : histCache[histPath] ?? null;

  // Right-click → native image menu, with the full-res file pinned for "Edit externally".
  const relForExternal = histPath ?? shot.artwork;
  const nativeSrc = relForExternal ? cascadeMedia(prod.meta.id, relForExternal) : (shownImg ?? undefined);
  // The card can show the shot's video instead of a frame — "Open file folder"
  // reveals whichever file is actually on screen.
  const relForFolder = histIdx === null && shot.videoPath && !videoFailed ? shot.videoPath : relForExternal;

  // Right-click anywhere on the panel → custom menu with Delete shot (red).
  // Text inputs keep their native edit menu, so clicks inside them are ignored.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  function openPanelMenu(e: React.MouseEvent) {
    if (!onDelete) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest("input, textarea")) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }
  function confirmDeleteShot() {
    setMenu(null);
    // Include uncommitted card drafts: typed-but-unblurred direction counts.
    const effective = { ...shot, audio, visual };
    if (shotHasContent(effective)) {
      if (!window.confirm(`Delete Shot ${shot.number}? This shot has content and deleting it can't be undone.`)) return;
    }
    onDelete?.(shot.id);
  }
  function saveMenuImage() {
    if (!nativeSrc) return;
    const src = nativeSrc;
    setMenu(null);
    void window.cascade.saveImage(src);
  }
  function copyMenuImage() {
    const pos = menu;
    setMenu(null);
    void window.cascade.copyImage(pos?.x ?? 0, pos?.y ?? 0);
  }
  function editMenuImageExternally() {
    setMenu(null);
    void window.cascade.editImageExternally({
      src: nativeSrc,
      productionId: relForExternal ? prod.meta.id : undefined,
      relPath: relForExternal ?? undefined,
    });
  }
  function openMenuFolder() {
    setMenu(null);
    if (relForFolder) void window.cascade.showInFolder({ productionId: prod.meta.id, relPath: relForFolder });
  }

  // The focused shot's prompt is fetched by the parent (ProductionWorkspace's
  // focused-shot effect) only when a card is clicked — see onPromptFocus.

  return (
    <figure
      ref={cardRef}
      className={"prod-board" + (selected ? " selected" : "") + (isDragging ? " dragging" : "") + (isReorderTarget ? " drop-target" : "")}
      onContextMenu={onDelete ? openPanelMenu : undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-cascade-shot-order")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (onReorderDragOver) onReorderDragOver(shot.id);
        }
      }}
      onDragLeave={(e) => {
        const rt = e.relatedTarget as HTMLElement | null;
        if (rt && e.currentTarget.contains(rt)) return;
        // clearing is handled by parent's global handler; no-op here
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes("application/x-cascade-shot-order")) {
          e.preventDefault();
          if (onReorderDrop) onReorderDrop(shot.id, e);
        }
      }}
      onDragEnd={() => { if (onReorderDragEnd) onReorderDragEnd(); }}
    >
      {isReorderTarget && <div className="prod-board-insert-indicator" aria-hidden />}
      {onInsertAfter && (
        /* Anchored to the frame region (top of the card, same 16:9 box) so the
           "+" is always vertically centered on the frame, not the whole card. */
        <div className="prod-board-insert-anchor">
          <button
            className="prod-board-insert-after"
            title="Insert a blank shot here"
            onClick={(e) => { e.stopPropagation(); onInsertAfter(shot.id); }}
          ><PlusIcon size={12} /></button>
        </div>
      )}
      {draggable && onReorderDragStart && (
        <button
          className="prod-board-drag-handle"
          draggable
          title="Drag to reorder — drop before another card"
          aria-label="Drag to reorder shot"
          onDragStart={(e) => { e.stopPropagation(); onReorderDragStart(shot.id, e); }}
          onDragEnd={(e) => { e.stopPropagation(); e.currentTarget.blur(); if (onReorderDragEnd) onReorderDragEnd(); }}
        >
          <DragHandleIcon size={14} />
        </button>
      )}
      <div
        className="prod-board-frame"
        onClick={() => onPromptFocus(shot.id, "")}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-cascade-frame")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; e.currentTarget.classList.add("dragover"); }
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove("dragover")}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.classList.remove("dragover");
          const raw = e.dataTransfer.getData("application/x-cascade-frame");
          if (!raw) return;
          try { const src = JSON.parse(raw) as { prodId: string; shotId: string; number: number }; if (src.shotId !== shot.id) void onDropFrame(shot.id, src); } catch { /* ignore malformed drag payload */ }
        }}
      >
        {histLen > 0 && histIdx === null && (
          <button
            className="prod-board-hist prev"
            title={`Previous frame (${histLen} in history)`}
            onClick={(e) => { e.stopPropagation(); setHistoryPath(history[0]); }}
          >
            ‹
          </button>
        )}
        {histIdx !== null && (
          <>
            <button
              className="prod-board-hist prev"
              title={histIdx + 1 < histLen ? "Older frame" : "Start of history"}
              disabled={histIdx + 1 >= histLen}
              onClick={(e) => { e.stopPropagation(); setHistoryPath(history[Math.min(histIdx + 1, histLen - 1)]); }}
            >
              ‹
            </button>
            <button
              className={"prod-board-hist next" + (histIdx === 0 ? " to-current" : "")}
              title={histIdx === 0 ? "Back to current frame" : "Newer frame"}
              onClick={(e) => { e.stopPropagation(); setHistoryPath(histIdx === 0 ? null : history[histIdx - 1]); }}
            >
              ›
            </button>
          </>
        )}
        {histPath !== null && shownImg && (
          <button
            className="prod-board-promote"
            title="Set this history frame as the primary frame for this shot (the current frame moves into history)"
            onClick={(e) => { e.stopPropagation(); onPromoteHistory(shot.id, histPath); }}
          >
            Make Primary
          </button>
        )}
        {histIdx === null && shot.videoPath && !videoFailed ? (
          <video
            ref={boardVideoRef}
            className="prod-board-frame-video"
            src={`cascade-media://${prod.meta.id}/${encodeURIComponent(shot.videoPath)}`}
            muted
            loop
            playsInline
            // Clips load on demand: every card preloading metadata at page
            // open was N parallel media fetches racing the icons. The first
            // hover play() pulls the stream, so the delay is one hover only.
            preload="none"
            onLoadedMetadata={(e) => {
              // Nudge past 0 so the first frame renders while paused.
              try { if (e.currentTarget.currentTime < 0.05) e.currentTarget.currentTime = 0.05; } catch {}
            }}
            onMouseEnter={() => { try { boardVideoRef.current?.play(); } catch {} }}
            onMouseLeave={() => { try { boardVideoRef.current?.pause(); } catch {} }}
            onError={() => setVideoFailed(true)}
            onClick={(e) => { e.stopPropagation(); onPromptFocus(shot.id, ""); }}
            onContextMenu={onDelete ? openPanelMenu : undefined}
            onDragStart={(e) => {
              // Carry this frame's identity so another frame can accept it as a reference.
              e.dataTransfer.setData(
                "application/x-cascade-frame",
                JSON.stringify({ prodId: prod.meta.id, shotId: shot.id, number: shot.number }),
              );
              e.dataTransfer.effectAllowed = "copy";
            }}
            title="Hover to preview this shot's video — click to edit its prompt, or drag onto another frame as a reference"
          />
        ) : shownImg ? (
          <>
            <img
              src={shownImg}
              alt={`Shot ${shot.number}`}
              className="prod-board-frame-img"
              // Yield to icons and anything more critical: this image's IPC
              // already waited for first paint + viewport + queue slot.
              loading="lazy"
              decoding="async"
              onClick={(e) => { e.stopPropagation(); onPromptFocus(shot.id, ""); }}
              onContextMenu={onDelete ? openPanelMenu : undefined}
              onDragStart={(e) => {
                // Carry this frame's identity so another frame can accept it as a reference.
                e.dataTransfer.setData(
                  "application/x-cascade-frame",
                  JSON.stringify({ prodId: prod.meta.id, shotId: shot.id, number: shot.number }),
                );
                e.dataTransfer.effectAllowed = "copy";
              }}
              title="Click to edit this shot's prompt — right-click for shot options — or drag onto another frame as a reference"
            />
          </>
        ) : (
          <span className="prod-board-empty">{shot.artwork ? "…" : pending ? "pending…" : "no frame"}</span>
        )}
        {histIdx === null && shot.videoPath && !videoFailed && (
          <span
            className="prod-board-video-badge"
            title="This shot has a video clip — hover the frame to preview it"
          >
            <FilmStripIcon size={40} />
          </span>
        )}
        {pending && (
          <span
            className="prod-board-pending"
            title="This frame is still rendering — recheck to download it when ready"
          >
            pending
          </span>
        )}
        <button
          className="prod-board-zoom"
          title={histPath === null && shot.videoPath ? "Play this shot's video" : "Enlarge this frame"}
          disabled={!shownImg && !(histPath === null && shot.videoPath)}
          onClick={(e) => {
            e.stopPropagation();
            if (histPath === null && shot.videoPath) {
              setExpandedImg(null);
              setExpandedVideo(`cascade-media://${prod.meta.id}/${encodeURIComponent(shot.videoPath)}`);
              setExpanded(true);
            } else {
              setExpandedVideo(null);
              void window.cascade.boardImageFull(prod.meta.id, shot.id, histPath ?? undefined).then((full) => { if (full) { setExpandedImg(full); setExpanded(true); } });
            }
          }}
        ><MagnifyIcon size={12} /></button>
        <div className="prod-board-actions">
          <button
            className="prod-board-regen"
            title="Regenerate this frame"
            disabled={regenerating}
            onClick={() => onRegenerate(shot.id)}
          >
            {regenerating ? "…" : <RegenerateIcon size={12} />}
          </button>
          <button
            className="prod-board-edit"
            title="Edit this frame with AI (image-input model + prompt)"
            disabled={regenerating || !img}
            onClick={() => onEdit(shot.id)}
          >
            <EditIcon size={12} />
          </button>
          <button
            className="prod-board-video"
            title={shot.videoPath ? "Replace this shot's video" : "Generate a video from this frame"}
            disabled={regenerating || !img}
            onClick={(e) => { e.stopPropagation(); onVideo(shot.id); }}
          >
            {videoBusy ? "…" : <FilmStripIcon size={12} />}
          </button>
          <button className="prod-board-import" title="Import a frame for this shot" disabled={regenerating} onClick={(e) => { e.stopPropagation(); onImport(shot.id); }}><ImportIcon size={12} /></button>
        </div>
        {pending && (
          <button
            className="prod-board-recheck"
            title="Recheck the pending generation job and download the frame when ready"
            disabled={rechecking}
            onClick={(e) => { e.stopPropagation(); onRecheck?.(shot.id); }}
          >
            {rechecking ? "…" : "◷"}
          </button>
        )}
      </div>
      <div className="prod-board-number" title={`Shot ${shot.number}`}>{shot.number}</div>
      {showScript && (
        <div className="prod-board-script" onBlur={commitText}>
          <label className="prod-board-script-field">
            <span className="prod-board-script-title">Audio</span>
            <AutoTextarea
              className="prod-board-script-input audio"
              value={audio}
              maxHeight={120}
              placeholder="Dialogue / VO / SFX"
              onChange={(e) => setAudio(e.target.value)}
              onFocus={() => setTextFocused(true)}
              onBlur={() => setTextFocused(false)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitText(); e.currentTarget.blur(); } }}
            />
          </label>
          <label className="prod-board-script-field">
            <span className="prod-board-script-title">Visual</span>
            <AutoTextarea
              className="prod-board-script-input visual"
              value={visual}
              maxHeight={120}
              placeholder="What we see"
              onChange={(e) => setVisual(e.target.value)}
              onFocus={() => setTextFocused(true)}
              onBlur={() => setTextFocused(false)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitText(); e.currentTarget.blur(); } }}
            />
          </label>
        </div>
      )}
      {expanded && (expandedImg || expandedVideo) && (
        <div className="prod-ref-lightbox" onClick={() => setExpanded(false)}>
          <figure className="prod-ref-lightbox-card">
            {expandedVideo ? (
              <video
                className="prod-ref-lightbox-video"
                src={expandedVideo}
                controls
                autoPlay
                playsInline
              />
            ) : expandedImg ? (
              <img src={expandedImg} alt={`Shot ${shot.number}`} />
            ) : null}
            <figcaption>Shot {shot.number} — click anywhere to close</figcaption>
          </figure>
        </div>
      )}
      {menu && onDelete && (
        <div
          ref={menuRef}
          className="session-context-menu"
          style={{ position: "fixed", top: menu.y, left: menu.x, zIndex: 60 }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          {(nativeSrc || relForFolder) && (
            <>
              {nativeSrc && (
                <>
                  <button
                    className="ctx-item"
                    onClick={saveMenuImage}
                  >
                    Save image as…
                  </button>
                  <button
                    className="ctx-item"
                    onClick={copyMenuImage}
                  >
                    Copy image
                  </button>
                  <button
                    className="ctx-item"
                    onClick={editMenuImageExternally}
                  >
                    Edit externally
                  </button>
                </>
              )}
              {relForFolder && (
                <button
                  className="ctx-item"
                  onClick={openMenuFolder}
                >
                  Open file folder
                </button>
              )}
              <div className="ctx-sep" />
            </>
          )}
          <button
            className="ctx-item danger"
            onClick={confirmDeleteShot}
          >
            Delete shot…
          </button>
        </div>
      )}
    </figure>
  );
}

/** Memoized: the workspace re-renders on every storyboard/node-graph state
 *  change, and re-rendering every card (each builds history arrays + JSX) is
 *  the bulk of that cost on large productions. Cards receive stable, shot-id-
 *  keyed callbacks (see ProductionWorkspace's boardActions) so unrelated state
 *  changes skip them entirely. */
export const BoardCard = memo(BoardCardInner);

/** Step 3: video-generation dialog for one frame. The shot's current frame is
 *  always used as the reference; pick a video model, resolution and length,
 *  and write a motion prompt (with @[name] references, like the side panel).
 *  Shows the estimated credit cost before submitting. */

export function VideoGenModal({ shot, prod, models, prompt: externalPrompt, onShotField, onPromptChange, onClose, onSubmit }: {
  shot: ProductionShot;
  prod: Production;
  models: OpenArtModelChoice[];
  /** Synced prompt — when provided, this IS the `graphVideoPrompt` source of truth shared with the node graph's video-prompt node. */
  prompt?: string;
  onPromptChange?: (text: string) => void;
  /** Persists per-shot selections (model / resolution / length) onto the shot. */
  onShotField: (patch: Partial<ProductionShot>) => void;
  onClose: () => void;
  onSubmit: (opts: VideoGenOptions) => void;
}) {
  const videoModels = models.filter(isVideoModel);
  // Start where THIS shot last left the dropdowns — the saved per-shot choice
  // wins; the global media-default only seeds shots that never picked, so a
  // change in one shot never propagates to the others.
  const remembered = getMediaDefault("video");
  const [model, setModel] = useState(() => shot.graphVideoModel ?? remembered?.model ?? videoModels[0]?.id ?? "");
  const [resolution, setResolution] = useState(() => shot.graphVideoResolution ?? remembered?.resolution ?? "1080p");
  const [durationSec, setDurationSec] = useState(() => shot.graphVideoDurationSec ?? remembered?.durationSec ?? 5);
  const fallback = "Animate this reference image with smooth, cinematic motion.";
  const external = externalPrompt ?? shot.graphVideoPrompt ?? fallback;
  const [prompt, setPrompt] = useState(external);
  const [focused, setFocused] = useState(false);
  const emitted = useRef<Set<string>>(new Set([external]));
  useEffect(() => {
    if (focused) return;
    if (emitted.current.has(external)) return;
    emitted.current.clear();
    emitted.current.add(external);
    setPrompt(external);
  }, [external, focused]);
  const handlePromptChange = (text: string) => {
    setPrompt(text);
    const s = emitted.current;
    if (s.size > 100) s.clear();
    s.add(text);
    onPromptChange?.(text);
  };
  const [credits, setCredits] = useState<number | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  // Resolution / length options are model-specific — fetch them from the
  // model's live form schema whenever the model changes. The shot's frame is
  // always the source, so the image-to-video form is the one that matters.
  const [modelOpts, setModelOpts] = useState<VideoModelOptions | null>(null);
  useEffect(() => {
    let live = true;
    setModelOpts(null);
    if (model && model !== "auto") {
      window.cascade.videoModelOptions(model, true)
        .then((o) => { if (live) setModelOpts(o); })
        .catch(() => {});
    }
    return () => { live = false; };
  }, [model]);
  const resolutions = modelOpts?.resolutions?.length ? modelOpts.resolutions : ["480p", "720p", "1080p"];
  const durations = modelOpts?.durations?.length ? modelOpts.durations : [5, 10, 15, 20];
  // Keep the current selection valid when the model's options arrive — or
  // when the provider switches under the modal (new model list, new options).
  // The dep is the joined id list (not the array) because the parent passes a
  // fresh filtered array every render.
  const videoModelIds = videoModels.map((m) => m.id).join(",");
  useEffect(() => {
    if (videoModels.length && !videoModels.some((m) => m.id === model)) setModel(videoModels[0].id);
    // Snap the selection only once the model's REAL options arrive — the
    // fallback list would prematurely clobber e.g. a saved "2k".
    if (!modelOpts) return;
    if (resolutions.length && !resolutions.includes(resolution)) setResolution(closestResolution(resolution, resolutions));
    if (durations.length && !durations.includes(durationSec)) setDurationSec(durations[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelOpts, videoModelIds]);
  useEffect(() => {
    void window.cascade.getOpenArtCredits().then((c) => setCredits(c)).catch(() => {});
    window.cascade.boardThumbnail(prod.meta.id, shot.id).then((d) => setFrame(d)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prod.meta.id, shot.id]);
  const selected = videoModels.find((m) => m.id === model);
  const cost = selected && typeof selected.cost === "number" ? selected.cost : null;
  const references = promptRefsForShot(prod, shot.id);
  return (
    <div className="prod-edit-overlay prod-video-overlay" onClick={onClose}>
      <div className="prod-edit-panel prod-video-panel" onClick={(e) => e.stopPropagation()}>
        <div className="prod-edit-head">
          <span className="prod-edit-title">Shot {shot.number} — generate video</span>
          <button className="prod-btn" onClick={onClose}>Cancel</button>
        </div>
        <div className="prod-video-frame-row">
          <div className="prod-video-frame">
            {frame ? <img src={frame} alt={`Shot ${shot.number}`} /> : <span>no frame</span>}
          </div>
          <span className="prod-video-frame-label">
            Source frame — the full-resolution version is sent as the video's primary reference.
            {shot.videoPath ? " This shot already has a video; generating replaces it." : ""}
          </span>
        </div>
        <label className="prod-label">Model</label>
        <select
          className="prod-openart-select"
          value={videoModels.some((m) => m.id === model) ? model : (videoModels[0]?.id ?? "")}
          onChange={(e) => { setModel(e.target.value); onShotField({ graphVideoModel: e.target.value }); }}
          title="Video model"
          disabled={videoModels.length === 0}
        >
          {videoModels.map((m) => (
            <option key={m.id} value={m.id} title={m.description}>
              {m.displayName}{typeof m.cost === "number" ? ` ◎${m.cost}` : ""}
            </option>
          ))}
        </select>
        {videoModels.length === 0 && <p className="hint">No video models reported — connect the media MCP server.</p>}
        <div className="prod-video-row">
          <label className="prod-label">Resolution
            <select className="prod-openart-select" value={resolution} onChange={(e) => { setResolution(e.target.value); onShotField({ graphVideoResolution: e.target.value }); }}>
              {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="prod-label">Length
            <select className="prod-openart-select" value={durationSec} onChange={(e) => { setDurationSec(Number(e.target.value)); onShotField({ graphVideoDurationSec: Number(e.target.value) }); }}>
              {durations.map((s) => <option key={s} value={s}>{s}s</option>)}
            </select>
          </label>
        </div>
        <label className="prod-label">Prompt</label>
        <ReferencePromptEditor
          className="prod-video-prompt"
          rows={4}
          value={prompt}
          includeBrand={false}
          references={references}
          placeholder="Motion prompt — type @ to add a reference"
          onChange={handlePromptChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && prompt.trim()) onSubmit({ model, resolution, durationSec, prompt: prompt.trim() });
            if (e.key === "Escape") onClose();
          }}
        />
        {(cost != null || credits != null) && (
          <p className="prod-video-cost">
            {cost != null && <>This clip costs about <strong>◎{cost} credits</strong>.</>}
            {credits != null ? ` You have ~${credits.toLocaleString()} credits available.` : ""}
          </p>
        )}
        <button className="prod-btn prod-edit-go" disabled={!prompt.trim()} onClick={() => onSubmit({ model, resolution, durationSec, prompt: prompt.trim() })}>
          Generate video
        </button>
      </div>
    </div>
  );
}

/** Step 3: AI edit dialog for one board frame - pick an image-input model and
 *  describe the change; the current frame is sent as the visual reference and
 *  the result becomes the new frame (previous one kept in history). */

export function EditBoardModal({ shotNumber, models, savedModel, onSavedModelChange, prompt: externalPrompt, onPromptChange, onSubmit, onClose }: {
  shotNumber: string;
  models: OpenArtModelChoice[];
  /** This shot's edit chain's last-used model (the output-bound edit node's
   *  pick) — per-shot/per-node persistence wins over the global default. */
  savedModel?: string;
  /** Persists a model change onto the same edit node. */
  onSavedModelChange?: (model: string) => void;
  /** Synced prompt — when provided, this IS the `graphEditPrompt` source of truth shared with the node graph's edit-prompt node. */
  prompt?: string;
  onPromptChange?: (text: string) => void;
  onSubmit: (model: string, prompt: string) => void;
  onClose: () => void;
}) {
  const imageModels = models.filter(isImageModel);
  const [model, setModel] = useState(() => savedModel ?? getMediaDefault("edit")?.model ?? imageModels[0]?.id ?? "");
  const external = externalPrompt ?? "";
  const [prompt, setPrompt] = useState(external);
  const [focused, setFocused] = useState(false);
  const emitted = useRef<Set<string>>(new Set([external]));
  useEffect(() => {
    if (focused) return;
    if (emitted.current.has(external)) return;
    emitted.current.clear();
    emitted.current.add(external);
    setPrompt(external);
  }, [external, focused]);
  const handlePromptChange = (text: string) => {
    setPrompt(text);
    const s = emitted.current;
    if (s.size > 100) s.clear();
    s.add(text);
    onPromptChange?.(text);
  };
  return (
    <div className="prod-edit-overlay" onClick={onClose}>
      <div className="prod-edit-panel" onClick={(e) => e.stopPropagation()}>
        <div className="prod-edit-head">
          <span className="prod-edit-title">Shot {shotNumber} - edit frame with AI</span>
          <button className="prod-btn" onClick={onClose}>Cancel</button>
        </div>
        <label className="prod-label">Model</label>
        <select
          className="prod-openart-select"
          value={imageModels.some((m) => m.id === model) ? model : (imageModels[0]?.id ?? "")}
          onChange={(e) => { setModel(e.target.value); onSavedModelChange?.(e.target.value); }}
          title="Image model that accepts a reference image"
          disabled={imageModels.length === 0}
        >
          {imageModels.map((m) => (
            <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>
          ))}
        </select>
        {imageModels.length === 0 && (
          <p className="hint">No image-input models reported — connect the media MCP server.</p>
        )}
        <label className="prod-label">Edit prompt</label>
        <textarea
          className="prod-edit-prompt"
          autoFocus
          rows={4}
          value={prompt}
          placeholder='Describe the edit, e.g. "make it night time, add warm window light, light rain"'
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => handlePromptChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && prompt.trim()) onSubmit(model, prompt);
            if (e.key === "Escape") onClose();
          }}
        />
        <p className="hint">
          The current frame is sent as the reference image — this wires the image&rarr;edit nodes
          and pipes the result to the output, same as the node view. Ctrl+Enter to submit.
          The edit runs in the background &mdash; you can close this and queue more.
          The previous version stays in this frame's history (use the arrows on the card).
        </p>
        <button
          className="prod-btn prod-edit-go"
          disabled={!prompt.trim()}
          onClick={() => onSubmit(model, prompt)}
        >
          Edit frame
        </button>
      </div>
    </div>
  );
}

/**
 * Step 3 storyboard-PDF export dialog: landscape pages with 1 or 3 panels
 * per page (still frame or placeholder over Audio:/Visual: boxes), production
 * name + version lower-left, optional attached logo lower-right. The version
 * label, layout, and logo are remembered on the production.
 */
export function StoryboardPdfModal({ prod, onClose, onDone }: {
  prod: Production;
  onClose: () => void;
  /** Updated production after pick/clear/export; filePath is null when the
   *  Save dialog was cancelled or no file was written yet. */
  onDone: (next: Production, filePath: string | null) => void;
}) {
  const [panelsPerPage, setPanelsPerPage] = useState<1 | 3>(prod.storyboardPdf?.panelsPerPage === 3 ? 3 : 1);
  const [version, setVersion] = useState(prod.storyboardPdf?.version ?? "v1");
  const [logo, setLogo] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const logoRel = prod.storyboardPdf?.logoRel ?? null;

  useEffect(() => {
    if (!logoRel) {
      setLogo(null);
      return;
    }
    let live = true;
    void window.cascade.storyboardLogoImage(prod.meta.id).then((d) => {
      if (live) setLogo(d);
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [prod.meta.id, logoRel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function pickLogo() {
    if (logoBusy || busy) return;
    setLogoBusy(true);
    setErr(null);
    try {
      const next = await window.cascade.pickStoryboardLogo(prod.meta.id);
      if (next) onDone(next, null);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setLogoBusy(false);
    }
  }

  async function removeLogo() {
    if (logoBusy || busy) return;
    setLogoBusy(true);
    setErr(null);
    try {
      const next = await window.cascade.clearStoryboardLogo(prod.meta.id);
      onDone(next, null);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setLogoBusy(false);
    }
  }

  async function runExport() {
    if (busy || logoBusy) return;
    setBusy(true);
    setErr(null);
    setSavedPath(null);
    try {
      const res = await window.cascade.exportStoryboardPdf(prod.meta.id, { panelsPerPage, version });
      onDone(res.production, res.filePath);
      setVersion(res.production.storyboardPdf?.version ?? version);
      if (res.filePath) setSavedPath(res.filePath);
      // Cancelled Save dialog: stay open silently so settings aren't lost.
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="prod-edit-overlay" onClick={onClose}>
      <div className="prod-edit-panel" onClick={(e) => e.stopPropagation()}>
        <div className="prod-edit-head">
          <span className="prod-edit-title">Export storyboard PDF</span>
          <button className="prod-btn" onClick={onClose}>Cancel</button>
        </div>
        <p className="hint">
          Landscape A4 pages — one still frame (or placeholder) per panel with
          Audio: and Visual: boxes underneath. The footer shows the production
          name and version on the left and the logo on the right.
        </p>
        <label className="prod-label">Panels per page</label>
        <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="radio"
              name="storyboard-pdf-layout"
              checked={panelsPerPage === 1}
              onChange={() => setPanelsPerPage(1)}
            />
            1 panel
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="radio"
              name="storyboard-pdf-layout"
              checked={panelsPerPage === 3}
              onChange={() => setPanelsPerPage(3)}
            />
            3 panels
          </label>
        </div>
        <label className="prod-label">Storyboard version</label>
        <input
          className="prod-openart-select"
          style={{ width: "100%", marginBottom: 12 }}
          value={version}
          maxLength={24}
          placeholder="v1"
          onChange={(e) => setVersion(e.target.value)}
          title="Printed in the footer and used in the file name"
        />
        <label className="prod-label">Logo (lower-right corner)</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          {logo ? (
            <img src={logo} alt="Storyboard logo" style={{ maxHeight: 40, maxWidth: 130, objectFit: "contain" }} />
          ) : (
            <span className="hint" style={{ margin: 0 }}>{logoRel ? "Loading…" : "No logo attached"}</span>
          )}
          <button className="prod-btn" disabled={logoBusy || busy} onClick={() => void pickLogo()}>
            {logoBusy ? "…" : logoRel ? "Change…" : "Attach…"}
          </button>
          {logoRel && (
            <button className="prod-btn" disabled={logoBusy || busy} onClick={() => void removeLogo()}>
              Remove
            </button>
          )}
        </div>
        {err && <p className="error-text">{err}</p>}
        {savedPath && <p className="hint">Saved to <code>{savedPath}</code></p>}
        <button className="prod-btn prod-edit-go" disabled={busy || logoBusy} onClick={() => void runExport()}>
          {busy ? "Exporting…" : "Export PDF"}
        </button>
      </div>
    </div>
  );
}

/**
 * One brand-palette swatch row: color chip (opens the in-app picker) + a hex
 * text field that accepts pastes with or without the leading "#" and commits
 * live once the text is a complete color.
 */


