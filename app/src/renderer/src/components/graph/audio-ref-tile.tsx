/**
 * The audio reference tile body: a canvas waveform (peaks from
 * audio-peaks.ts) in the reference's accent color, with play/pause +
 * click/drag-to-seek transport (MiniAudioPlayer semantics, not the native
 * <audio controls> chrome). Right-click opens the waveform-color swatch
 * menu (the sequence bar's palette), portaled out of the transformed
 * React Flow viewport. Only one tile plays at a time — starting one
 * pauses whichever tile was playing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SEQUENCE_ACCENT_COLORS, normalizeSequenceAccent, sequenceAccentHex } from "../../../../shared/ipc.js";
import { useClampedMenuStyle } from "../menu-position.js";
import { PlayButtonIcon } from "../icons.js";
import { useAudioPeaks, type AudioPeaks } from "./audio-peaks.js";

/** The one tile audio element currently sounding (pause-others). */
let activeAudioEl: HTMLAudioElement | null = null;

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Paint the waveform columns: played portion at full strength, the rest
 *  dimmed. Without peaks (still decoding / undecodable) a flat center
 *  line carries the same progress split, so seek feedback never depends
 *  on the decode. */
function drawWaveform(canvas: HTMLCanvasElement, peaks: AudioPeaks | null, hex: string, progress: number): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = hex;
  const playedX = Math.max(0, Math.min(1, progress)) * w;
  const cols = Math.max(1, Math.floor(w / 2));
  const colW = Math.max(1, w / cols - 0.5);
  for (let i = 0; i < cols; i++) {
    const x = (i / cols) * w;
    ctx.globalAlpha = x < playedX ? 1 : 0.45;
    if (!peaks || !peaks.mins.length) {
      ctx.fillRect(x, h / 2 - 0.5, colW, 1);
      continue;
    }
    const { mins, maxs } = peaks;
    let b0 = Math.floor((i / cols) * mins.length);
    let b1 = Math.floor(((i + 1) / cols) * mins.length);
    b0 = Math.max(0, Math.min(mins.length - 1, b0));
    b1 = Math.max(b0, Math.min(mins.length - 1, b1));
    let min = Infinity;
    let max = -Infinity;
    for (let b = b0; b <= b1; b++) {
      if (mins[b] < min) min = mins[b];
      if (maxs[b] > max) max = maxs[b];
    }
    if (!Number.isFinite(min)) { min = 0; max = 0; }
    const y1 = ((1 - max) / 2) * h;
    const y2 = ((1 - min) / 2) * h;
    const barH = Math.max(1, y2 - y1);
    if (barH < 1.5) ctx.fillRect(x, (h - barH) / 2, colW, barH);
    else ctx.fillRect(x, y1, colW, barH);
  }
  ctx.globalAlpha = 1;
}

export function AudioRefTile({ url, name, colorId, onPickColor }: {
  /** Playable cascade-media URL for the audio file. */
  url: string;
  name: string;
  /** Persisted waveform palette id (absent = the blue default). */
  colorId?: string;
  /** Persist a new waveform color (right-click menu); absent = no menu. */
  onPickColor?: (colorId: string) => void;
}) {
  const peaks = useAudioPeaks(url);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const seekingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [size, setSize] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuStyle = useClampedMenuStyle(menu, menuRef);
  const hex = sequenceAccentHex(colorId);
  const currentColor = normalizeSequenceAccent(colorId);
  const progress = duration > 0 ? current / duration : 0;
  const compact = size > 0 && size < 120;

  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
  }, [url]);

  useEffect(() => {
    const el = waveRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSize(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (cvs) drawWaveform(cvs, peaks, hex, progress);
  }, [peaks, hex, progress, size]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenu(null);
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, []);

  const seekTo = useCallback((clientX: number) => {
    const el = audioRef.current;
    const wrap = waveRef.current;
    if (!el || !wrap || !Number.isFinite(el.duration) || el.duration <= 0) return;
    const r = wrap.getBoundingClientRect();
    if (r.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    el.currentTime = ratio * el.duration;
    setCurrent(el.currentTime);
  }, []);

  return (
    <div
      className="prod-graph-audio nodrag"
      onContextMenu={(e) => {
        if (!onPickColor) return;
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div
        className="prod-graph-audio-wave"
        ref={waveRef}
        title="Click to seek"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          seekingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seekTo(e.clientX);
        }}
        onPointerMove={(e) => { if (seekingRef.current) seekTo(e.clientX); }}
        onPointerUp={() => { seekingRef.current = false; }}
        onPointerCancel={() => { seekingRef.current = false; }}
      >
        <canvas ref={canvasRef} className="prod-graph-audio-canvas" />
      </div>
      <div className="prod-graph-audio-transport">
        <button
          className="prod-graph-audio-play"
          onClick={(e) => { e.stopPropagation(); toggle(); }}
          onPointerDown={(e) => e.stopPropagation()}
          title={playing ? `Pause ${name}` : `Play ${name}`}
          aria-label={playing ? `Pause ${name}` : `Play ${name}`}
        >
          {playing ? "❚❚" : <PlayButtonIcon size={11} />}
        </button>
        {!compact && (
          <span className="prod-graph-audio-time">
            {formatTime(current)} / {duration > 0 ? formatTime(duration) : "–:––"}
          </span>
        )}
      </div>
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={(e) => {
          if (activeAudioEl && activeAudioEl !== e.currentTarget) activeAudioEl.pause();
          activeAudioEl = e.currentTarget;
          setPlaying(true);
        }}
        onPause={(e) => {
          if (activeAudioEl === e.currentTarget) activeAudioEl = null;
          setPlaying(false);
        }}
        onEnded={() => { setPlaying(false); setCurrent(0); }}
      />
      {menu && onPickColor && createPortal(
        <div
          ref={menuRef}
          className="session-context-menu seq-accent-menu prod-graph-audio-menu"
          style={{ ...menuStyle, zIndex: 300 }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <div className="ctx-title">Waveform color</div>
          <div className="seq-accent-grid">
            {SEQUENCE_ACCENT_COLORS.map((c) => (
              <button
                key={c.id}
                className={"seq-accent-swatch" + (c.id === currentColor ? " current" : "")}
                style={{ background: c.hex }}
                title={c.label}
                onClick={() => { onPickColor(c.id); setMenu(null); }}
              />
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
