/**
 * The one full-size media viewer every surface uses (Design references,
 * storyboard, node graph, moodboard, outdated panels, style frames, Image
 * Suite) — previously eight copy-pasted overlays sharing only CSS.
 *
 * Images get a zoomable stage: wheel zooms toward the cursor, drag pans
 * when zoomed, double-click toggles fit <-> 2.5x, and a small toolbar
 * (- / % / + / Fit) mirrors the same actions. Zoom limits and pan clamping
 * live in the pure `media-lightbox-math.ts`. Videos keep native controls
 * (never CSS-transformed) and the shared Save-this-frame button; a clip
 * that fails to load/decode falls back to its poster still with a note
 * instead of a black box.
 *
 * Close is backdrop-click, the x button, or Esc (capture-phase, so a
 * hosting canvas's own Esc handler doesn't also fire). Clicking the media
 * itself never closes — that click is pan/inspect now.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { Production } from "../../../../shared/ipc.js";
import { SaveVideoStillButton } from "./SaveVideoStillButton.js";
import { XIcon } from "../icons.js";
import { refThumbUrl } from "../production/thumb-url.js";
import {
  LIGHTBOX_IDENTITY,
  LIGHTBOX_TOGGLE_ZOOM,
  lightboxClampPan,
  lightboxFitSize,
  lightboxZoomAt,
  lightboxZoomTo,
  type LightboxViewport,
} from "./media-lightbox-math.js";

/** Media caps inside the 96vw/96vh card (mirrors styles.css). */
function stageCaps(): { maxW: number; maxH: number } {
  const w = typeof window !== "undefined" ? window.innerWidth : 1280;
  const h = typeof window !== "undefined" ? window.innerHeight : 800;
  return { maxW: Math.max(200, w * 0.96 - 20), maxH: Math.max(200, h * 0.96 - 64) };
}

export function MediaLightbox({
  name,
  src,
  kind,
  rel,
  productionId,
  loop = false,
  backdropClassName,
  hint,
  onClose,
  onNavigate,
  onContextMenu,
  onVideoStillSaved,
}: {
  name: string;
  /** Full-resolution media URL (never a `?thumb=1` tile URL). */
  src: string;
  kind: "image" | "video";
  /** Workspace-relative path of a video clip (Save-this-frame source). */
  rel?: string;
  productionId?: string;
  loop?: boolean;
  /** Extra backdrop class (e.g. the node graph's raised z-index). */
  backdropClassName?: string;
  /** Caption hint replacing the default image gesture hint. */
  hint?: string;
  onClose: () => void;
  /** Left/right arrow navigation (storyboard steps between shots). */
  onNavigate?: (dir: -1 | 1) => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  onVideoStillSaved?: (next: Production) => void;
}) {
  const isVideo = kind === "video";
  const [vp, setVp] = useState<LightboxViewport>(LIGHTBOX_IDENTITY);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [caps, setCaps] = useState(stageCaps);
  const [videoFailed, setVideoFailed] = useState(false);
  const [panning, setPanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; vp: LightboxViewport } | null>(null);

  // Fresh media (or an arrow-step to a neighbour): back to fit.
  useEffect(() => {
    setVp(LIGHTBOX_IDENTITY);
    setNatural(null);
    setVideoFailed(false);
  }, [src]);

  useEffect(() => {
    const onResize = () => setCaps(stageCaps());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const base = natural ? lightboxFitSize(natural.w, natural.h, caps.maxW, caps.maxH) : null;
  const baseRef = useRef(base);
  baseRef.current = base;
  const vpRef = useRef(vp);
  vpRef.current = vp;

  const applyVp = useCallback((next: LightboxViewport) => {
    const b = baseRef.current;
    setVp(b ? lightboxClampPan(next, b.w, b.h, b.w, b.h) : next);
  }, []);

  // A window resize can strand a panned image off-stage; re-clamp.
  useEffect(() => { applyVp(vpRef.current); }, [caps, applyVp]);

  // Esc / arrows / zoom keys. Capture + stopPropagation so hosting
  // canvases (node graph, moodboard) don't also act on the same key.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft" && onNavigateRef.current) { e.preventDefault(); onNavigateRef.current(-1); return; }
      if (e.key === "ArrowRight" && onNavigateRef.current) { e.preventDefault(); onNavigateRef.current(1); return; }
      if (isVideo) return;
      if (e.key === "+" || e.key === "=") { e.preventDefault(); applyVp(lightboxZoomAt(vpRef.current, 0, 0, 1.25)); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); applyVp(lightboxZoomAt(vpRef.current, 0, 0, 1 / 1.25)); }
      else if (e.key === "0") { e.preventDefault(); setVp(LIGHTBOX_IDENTITY); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [applyVp, isVideo]);

  // Wheel zoom toward the cursor. Non-passive (React's delegated wheel
  // can't preventDefault); deltaMode-normalized so line/page wheels and
  // trackpad pinch (wheel+ctrlKey) step comparably.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || isVideo) return;
    const onWheel = (e: WheelEvent) => {
      if (!baseRef.current) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      applyVp(lightboxZoomAt(vpRef.current, cx, cy, Math.exp(-e.deltaY * unit * 0.0015)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyVp, isVideo, natural]);

  const cursorFromCenter = (clientX: number, clientY: number): { cx: number; cy: number } => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { cx: 0, cy: 0 };
    return { cx: clientX - rect.left - rect.width / 2, cy: clientY - rect.top - rect.height / 2 };
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (isVideo || e.button !== 0 || !base) return;
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, vp };
    setPanning(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    applyVp({ ...drag.vp, x: drag.vp.x + (e.clientX - drag.startX), y: drag.vp.y + (e.clientY - drag.startY) });
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    if (!dragRef.current || e.pointerId !== dragRef.current.pointerId) return;
    dragRef.current = null;
    setPanning(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  const onDoubleClick = (e: ReactMouseEvent) => {
    if (isVideo || !base) return;
    const { cx, cy } = cursorFromCenter(e.clientX, e.clientY);
    applyVp(lightboxZoomTo(vp, cx, cy, vp.zoom > 1.01 ? 1 : LIGHTBOX_TOGGLE_ZOOM));
  };

  const zoomPct = Math.round(vp.zoom * 100);
  const showStill = isVideo && videoFailed;

  return createPortal(
    <div
      className={"prod-ref-lightbox" + (backdropClassName ? ` ${backdropClassName}` : "")}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onContextMenu={onContextMenu}
    >
      <figure className="prod-ref-lightbox-card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="media-lightbox-close" title="Close (Esc)" onClick={onClose}>
          <XIcon size={13} />
        </button>
        {isVideo && !videoFailed ? (
          <video
            ref={videoRef}
            className="prod-ref-lightbox-video"
            src={src}
            controls
            autoPlay
            loop={loop}
            playsInline
            onError={() => setVideoFailed(true)}
          />
        ) : showStill ? (
          <img src={refThumbUrl(src)} alt={name} />
        ) : (
          <div
            ref={stageRef}
            className={"media-lightbox-stage" + (base ? " ready" : "") + (vp.zoom > 1 ? " zoomed" : "") + (panning ? " panning" : "")}
            style={base ? { width: base.w, height: base.h } : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
          >
            <img
              src={src}
              alt={name}
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              style={base
                ? {
                    width: base.w,
                    height: base.h,
                    maxWidth: "none",
                    maxHeight: "none",
                    transform: `translate(-50%, -50%) translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
                  }
                : undefined}
            />
            {base && (
              <div className="media-lightbox-tools" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                <button type="button" title="Zoom out (-)" onClick={() => applyVp(lightboxZoomAt(vp, 0, 0, 1 / 1.25))}>-</button>
                <span className="media-lightbox-pct">{zoomPct}%</span>
                <button type="button" title="Zoom in (+)" onClick={() => applyVp(lightboxZoomAt(vp, 0, 0, 1.25))}>+</button>
                <button type="button" title="Fit in view (0)" onClick={() => setVp(LIGHTBOX_IDENTITY)}>Fit</button>
              </div>
            )}
          </div>
        )}
        <figcaption>
          {name}
          {hint !== undefined
            ? (hint ? ` — ${hint}` : "")
            : isVideo ? "" : " — scroll to zoom · drag to pan · double-click to fit"}
          {showStill && " — this clip couldn't be played in-app (missing file or unsupported codec); showing a still frame"}
          {isVideo && !videoFailed && rel && productionId && onVideoStillSaved && (
            <>{" · "}<SaveVideoStillButton productionId={productionId} videoRel={rel} getTime={() => videoRef.current?.currentTime ?? 0} onSaved={(next) => { onVideoStillSaved(next); onClose(); }} /></>
          )}
        </figcaption>
      </figure>
    </div>,
    document.body,
  );
}
