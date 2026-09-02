import { useEffect, useRef, useState } from "react";
import type { OpenArtModelChoice, Production, ProductionShot, VideoGenOptions, VideoModelOptions } from "../../../../shared/ipc.js";
import { promptRefsForShot, shotStyleSelectValue } from "./references.js";
import { ReferencePromptEditor } from "./prompt-panel.js";
import { useExternalImageMenu } from "../external-menu.js";

export function BoardCard({ prod, shot, bust, regenerating, videoBusy, pending, rechecking, onRegenerate, onRecheck, onImport, onEdit, onVideo, onStyleChange, onPromptFocus, selected, onDropFrame, onPromoteHistory, draggable, onReorderDragStart, onReorderDrop, onReorderDragOver, onReorderDragEnd, isReorderTarget, isDragging }: {
  prod: Production;
  shot: ProductionShot;
  bust: number;
  regenerating: boolean;
  videoBusy: boolean;
  /** An OpenArt frame job outlived its wait — show a pending badge + recheck. */
  pending?: boolean;
  /** A recheck is currently polling the pending job. */
  rechecking?: boolean;
  onRegenerate: () => void;
  /** Recheck the shot's pending OpenArt job and download the frame when ready. */
  onRecheck?: () => void;
  onImport: () => void;
  /** Open the AI edit dialog for this frame. */
  onEdit: () => void;
  /** Open the video-generation modal for this frame. */
  onVideo: () => void;
  onStyleChange: (style: string) => void;
  onPromptFocus: (shotId: string, prompt: string) => void;
  selected: boolean;
  /** Attach a frame dragged from another card as a reference on this shot. */
  onDropFrame: (source: { prodId: string; shotId: string; number: number }) => void;
  /** Promote the browsed history frame (by artworkHistory index) to primary. */
  onPromoteHistory: (index: number) => void;
  draggable?: boolean;
  onReorderDragStart?: (shotId: string, e: React.DragEvent) => void;
  onReorderDrop?: (targetShotId: string, e: React.DragEvent) => void;
  onReorderDragOver?: (shotId: string) => void;
  onReorderDragEnd?: () => void;
  isReorderTarget?: boolean;
  isDragging?: boolean;
}) {
  const [img, setImg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [expandedImg, setExpandedImg] = useState<string | null>(null);
  const [expandedVideo, setExpandedVideo] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string>("");
  // Hover-preview video for the shot's generated clip (muted, looping). Falls
  // back to the still image if the clip can't be loaded.
  const boardVideoRef = useRef<HTMLVideoElement | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  // Frame history browsing: null = current frame; otherwise an index into
  // shot.artworkHistory (0 = most recent previous frame). Thumbnails are
  // fetched lazily and cached per index.
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [histCache, setHistCache] = useState<Record<string, string>>({});
  const histLen = shot.artworkHistory?.length ?? 0;
  useEffect(() => {
    let live = true;
    setImg(null);
    setHistIdx(null);
    setHistCache({});
    setVideoFailed(false);
    if (shot.artwork) {
      window.cascade.boardThumbnail(prod.meta.id, shot.id).then((d) => { if (live) setImg(d); }).catch(() => {});
    }
    return () => { live = false; };
  }, [prod.meta.id, shot.id, shot.artwork, shot.videoPath, bust]);

  // Lazily load the history frame being viewed.
  useEffect(() => {
    if (histIdx === null) return;
    let live = true;
    const key = String(histIdx);
    if (!histCache[key]) {
        window.cascade.boardThumbnail(prod.meta.id, shot.id, histIdx)
        .then((d) => { if (live && d) setHistCache((c) => ({ ...c, [key]: d })); })
        .catch(() => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histIdx, prod.meta.id, shot.id]);

  const shownImg = histIdx === null ? img : histCache[String(histIdx)] ?? null;

  // Right-click → edit the underlying file (full-res) in the external editor, not the thumbnail data URL.
  const relForExternal = histIdx === null ? shot.artwork : shot.artworkHistory?.[histIdx ?? 0];
  const canEditExternal = !!relForExternal;
  const externalMenu = useExternalImageMenu(() => {
    if (!relForExternal) return;
    void window.cascade.openInExternalEditor({ productionId: prod.meta.id, relPath: relForExternal }).catch(() => {});
  });

  // Load the effective prompt into the editor when this shot OR the design
  // it derives from changes (styles, brand, references, shot text) — so
  // editing the master style in Step 2 is reflected here immediately. The
  // override (shot.prompt) still wins over the auto-derived prompt.
  const designSig = JSON.stringify([
    prod.styles ?? [],
    prod.brand ?? {},
    prod.characters.map((c) => [c.id, c.name, c.key, !!(c.artwork || c.imagePath)]),
    prod.products.map((pr) => [pr.id, pr.name, !!(pr.artwork || pr.imagePath)]),
    (prod.references ?? []).map((r) => [(r.shotIds ?? []).includes(shot.id), r.name, !!(r.artwork || r.imagePath || r.media)]),
    shot.refIds ?? [],
    shot.audio,
    shot.visual,
  ]);
  useEffect(() => {
    let live = true;
    window.cascade.getBoardPrompt(prod.meta.id, shot.id).then((p) => {
      if (!live) return;
      // While the user is typing in this card's editor, never replace the
      // value: the debounced save changes shot.prompt, re-runs this effect,
      // and a round-tripped (normalized) string would reset the textarea's
      // DOM value and yank the caret to the end.
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement
        && (el.classList.contains("prod-board-prompt") || el.classList.contains("prod-prompt-drawer-text"))) return;
      setPrompt(p ?? shot.prompt ?? "");
    }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prod.meta.id, shot.id, shot.prompt, shot.style, shot.styleNone, designSig]);

  return (
    <figure
      className={"prod-board" + (selected ? " selected" : "") + (isDragging ? " dragging" : "") + (isReorderTarget ? " drop-target" : "")}
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
      {isReorderTarget && (
        <div className="prod-board-insert-indicator" aria-hidden>
          <span className="prod-board-insert-label">Insert before {shot.number}</span>
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
          ⋮⋮
        </button>
      )}
      <div
        className="prod-board-frame"
        onClick={() => onPromptFocus(shot.id, prompt)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-cascade-frame")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; e.currentTarget.classList.add("dragover"); }
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove("dragover")}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.classList.remove("dragover");
          const raw = e.dataTransfer.getData("application/x-cascade-frame");
          if (!raw) return;
          try { const src = JSON.parse(raw) as { prodId: string; shotId: string; number: number }; if (src.shotId !== shot.id) void onDropFrame(src); } catch { /* ignore malformed drag payload */ }
        }}
      >
        {histLen > 0 && histIdx === null && (
          <button
            className="prod-board-hist prev"
            title={`Previous frame (${histLen} in history)`}
            onClick={() => setHistIdx(0)}
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
              onClick={() => setHistIdx((i) => Math.min((i ?? 0) + 1, histLen - 1))}
            >
              ‹
            </button>
            <button
              className={"prod-board-hist next" + (histIdx === 0 ? " to-current" : "")}
              title={histIdx === 0 ? "Back to current frame" : "Newer frame"}
              onClick={() => setHistIdx((i) => ((i ?? 0) - 1 < 0 ? null : (i ?? 0) - 1))}
            >
              ›
            </button>
            <span
              className={"prod-board-hist-tag" + (histIdx === 0 ? " old" : "")}
              title={histIdx === 0 ? "Most recent previous frame" : `History frame ${histIdx + 1} of ${histLen}`}
            >
              {histIdx === 0 ? "prev" : `−${histIdx}`}
            </span>
          </>
        )}
        {histIdx !== null && shownImg && (
          <button
            className="prod-board-promote"
            title="Set this history frame as the primary frame for this shot (the current frame moves into history)"
            onClick={() => onPromoteHistory(histIdx)}
          >
            Set as primary
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
            preload="metadata"
            onLoadedMetadata={(e) => {
              // Nudge past 0 so the first frame renders while paused.
              try { if (e.currentTarget.currentTime < 0.05) e.currentTarget.currentTime = 0.05; } catch {}
            }}
            onMouseEnter={() => { try { boardVideoRef.current?.play(); } catch {} }}
            onMouseLeave={() => { try { boardVideoRef.current?.pause(); } catch {} }}
            onError={() => setVideoFailed(true)}
            onClick={(e) => { e.stopPropagation(); onPromptFocus(shot.id, prompt); }}
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
              onClick={(e) => { e.stopPropagation(); onPromptFocus(shot.id, prompt); }}
              onContextMenu={canEditExternal ? externalMenu.onContextMenu : undefined}
              onDragStart={(e) => {
                // Carry this frame's identity so another frame can accept it as a reference.
                e.dataTransfer.setData(
                  "application/x-cascade-frame",
                  JSON.stringify({ prodId: prod.meta.id, shotId: shot.id, number: shot.number }),
                );
                e.dataTransfer.effectAllowed = "copy";
              }}
              title={canEditExternal ? "Click to edit this shot's prompt — right-click to edit externally — or drag onto another frame" : "Click to edit this shot's prompt — or drag onto another frame to use it as a reference"}
            />
            {canEditExternal && externalMenu.menu}
          </>
        ) : (
          <span className="prod-board-empty">{shot.artwork ? "…" : pending ? "pending…" : "no frame"}</span>
        )}
        {pending && (
          <span
            className="prod-board-pending"
            title="This frame is still rendering on OpenArt — recheck to download it when ready"
          >
            pending
          </span>
        )}
        <button
          className="prod-board-zoom"
          title={shot.videoPath ? "Play this shot's video" : "Enlarge this frame"}
          disabled={!img && !shot.videoPath}
          onClick={(e) => {
            e.stopPropagation();
            if (shot.videoPath) {
              setExpandedImg(null);
              setExpandedVideo(`cascade-media://${prod.meta.id}/${encodeURIComponent(shot.videoPath)}`);
              setExpanded(true);
            } else {
              setExpandedVideo(null);
              void window.cascade.boardImageFull(prod.meta.id, shot.id).then((full) => { if (full) { setExpandedImg(full); setExpanded(true); } });
            }
          }}
        >⌕</button>
        <button
          className="prod-board-video"
          title={shot.videoPath ? "Replace this shot's video" : "Generate a video from this frame"}
          disabled={regenerating || !img}
          onClick={(e) => { e.stopPropagation(); onVideo(); }}
        >
          {videoBusy ? "…" : "▶"}
        </button>
        <button className="prod-board-import" title="Import a frame for this shot" disabled={regenerating} onClick={(e) => { e.stopPropagation(); onImport(); }}>⤒</button>
        <button
          className="prod-board-edit"
          title="Edit this frame with AI (image-input model + prompt)"
          disabled={regenerating || !img}
          onClick={onEdit}
        >
          ✎
        </button>
<button
          className="prod-board-regen"
          title="Regenerate this frame"
          disabled={regenerating}
          onClick={onRegenerate}
        >
          {regenerating ? "…" : "↻"}
        </button>
        {pending && (
          <button
            className="prod-board-recheck"
            title="Recheck the pending OpenArt job and download the frame when ready"
            disabled={rechecking}
            onClick={(e) => { e.stopPropagation(); onRecheck?.(); }}
          >
            {rechecking ? "…" : "◷"}
          </button>
        )}
      </div>
      <div className="prod-board-style-row">
        <select
          className="prod-board-style"
          value={shotStyleSelectValue(shot, prod)}
          onChange={(e) => onStyleChange(e.target.value)}
          title="Render style for this frame (from the styles created in Design, Step 2)"
        >
          <option value="">None</option>
          {(prod.styles ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.index}. {s.name || `Style ${s.index}`}</option>
          ))}
        </select>
      </div>
      <div className="prod-board-number" title={`Shot ${shot.number}`}>{shot.number}</div>
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
    </figure>
  );
}

/** Step 3: video-generation dialog for one frame. The shot's current frame is
 *  always used as the reference; pick a video model, resolution and length,
 *  and write a motion prompt (with @[name] references, like the side panel).
 *  Shows the estimated credit cost before submitting. */

export function VideoGenModal({ shot, prod, models, prompt: externalPrompt, onPromptChange, onClose, onSubmit }: {
  shot: ProductionShot;
  prod: Production;
  models: OpenArtModelChoice[];
  /** Synced prompt — when provided, this IS the `graphVideoPrompt` source of truth shared with the node graph's video-prompt node. */
  prompt?: string;
  onPromptChange?: (text: string) => void;
  onClose: () => void;
  onSubmit: (opts: VideoGenOptions) => void;
}) {
  const videoModels = models.filter((m) => m.videoInput);
  const [model, setModel] = useState(videoModels[0]?.id ?? "auto");
  const [resolution, setResolution] = useState("1080p");
  const [durationSec, setDurationSec] = useState(5);
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
  // Keep the current selection valid when the model's options arrive.
  useEffect(() => {
    if (resolutions.length && !resolutions.includes(resolution)) setResolution(resolutions[0]);
    if (durations.length && !durations.includes(durationSec)) setDurationSec(durations[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelOpts]);
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
          value={videoModels.some((m) => m.id === model) ? model : "auto"}
          onChange={(e) => setModel(e.target.value)}
          title="OpenArt video model (Auto lets Cascade pick)"
        >
          {videoModels.length === 0 && <option value="auto">Auto</option>}
          {videoModels.map((m) => (
            <option key={m.id} value={m.id} title={m.description}>
              {m.displayName}{typeof m.cost === "number" ? ` ◎${m.cost}` : ""}
            </option>
          ))}
        </select>
        <div className="prod-video-row">
          <label className="prod-label">Resolution
            <select className="prod-openart-select" value={resolution} onChange={(e) => setResolution(e.target.value)}>
              {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="prod-label">Length
            <select className="prod-openart-select" value={durationSec} onChange={(e) => setDurationSec(Number(e.target.value))}>
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
            {credits != null ? ` You have ~${credits.toLocaleString()} OpenArt credits available.` : ""}
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

export function EditBoardModal({ shotNumber, models, prompt: externalPrompt, onPromptChange, onSubmit, onClose }: {
  shotNumber: string;
  models: OpenArtModelChoice[];
  /** Synced prompt — when provided, this IS the `graphEditPrompt` source of truth shared with the node graph's edit-prompt node. */
  prompt?: string;
  onPromptChange?: (text: string) => void;
  onSubmit: (model: string, prompt: string) => void;
  onClose: () => void;
}) {
  const imageModels = models.filter((m) => m.imageInput);
  const [model, setModel] = useState(imageModels[0]?.id ?? "auto");
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
          value={model}
          onChange={(e) => setModel(e.target.value)}
          title="Image model that accepts a reference image"
        >
          {imageModels.length === 0 && <option value="auto">Auto</option>}
          {imageModels.map((m) => (
            <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>
          ))}
        </select>
        {imageModels.length === 0 && (
          <p className="hint">No image-input model reported by OpenArt - Auto will pick one that accepts references.</p>
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
          The current frame is sent as the reference image. Ctrl+Enter to submit.
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
 * One brand-palette swatch row: color chip (opens the in-app picker) + a hex
 * text field that accepts pastes with or without the leading "#" and commits
 * live once the text is a complete color.
 */


