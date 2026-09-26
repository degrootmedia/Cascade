import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { dataUrlToBytes } from "../../../../shared/prompt-grammar.js";
import type { Production, ProductionShot } from "../../../../shared/ipc.js";
import { PlayButtonIcon, StopButtonIcon } from "../icons.js";
import { GenerationMenu, useGenerationMenu } from "../generation-menu.js";
import { mediaRev } from "./media-rev.js";

/** Animatic timeline: max simultaneously-mounted pooled preview <video>s. */
export const VIDEO_POOL_MAX = 12;
/** Animatic timeline: max wheel-zoom multiplier over the fit-to-width scale. */
export const ANIMATIC_MAX_ZOOM = 24;

export const STEPS: { n: 1 | 2 | 3 | 4 | 5; title: string; desc: string }[] = [
  { n: 1, title: "Script", desc: "PDF / DOCX / Google Doc → two-column shot breakdown" },
  { n: 2, title: "Design", desc: "Master style + character consistency keys" },
  { n: 3, title: "Storyboard", desc: "Board frames per shot" },
  { n: 4, title: "Animatic", desc: "Timed pre-viz timeline" },
  { n: 5, title: "Assembly", desc: "Audio + final render + manifest" },
];

export interface LogLine {
  id: string;
  at: string;
  message: string;
  level: "info" | "error" | "done";
}

const animaticThumbCache = new Map<string, string>();
function AnimaticThumb({ prodId, shotId, artwork }: { prodId: string; shotId: string; artwork?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const key = `${prodId}:${shotId}:${artwork ?? ""}`;
    const cached = animaticThumbCache.get(key);
    if (cached) { setSrc(cached); return () => { live = false; }; }
    setSrc(null);
    if (artwork) {
      window.cascade.boardThumbnail(prodId, shotId).then((d) => {
        if (!live) return;
        if (d) {
          // Bounded memory: after enough distinct thumbs, drop the whole map
          // (entries are cheap to refetch and rarely thrash during editing).
          if (animaticThumbCache.size > 200) animaticThumbCache.clear();
          animaticThumbCache.set(key, d);
        }
        setSrc(d);
      }).catch(() => {});
    }
    return () => { live = false; };
  }, [prodId, shotId, artwork]);
  if (!src) return <span className="prod-timeline-thumb blank" title="No frame yet — generate one in Storyboard" />;
  return <img className="prod-timeline-thumb" src={src} alt="Shot frame" title="Primary frame for this shot" />;
}

/** Flatten scenes to a single ordered shot list with a global timeline cursor. */
function flatShots(scenes: Production["scenes"]): ProductionShot[] {
  return scenes.flatMap((s) => s.shots);
}

/** Sum of all shot durations (clamped to >=0.1 so the strip always has a width). */
function totalDuration(scenes: Production["scenes"]): number {
  const t = flatShots(scenes).reduce((n, s) => n + (s.durationSec ?? 3), 0);
  return t > 0 ? t : 0.1;
}

/** Convert a data URL into an ArrayBuffer for AudioContext decoding. The VO
 *  / music IPCs prefer streamable cascade-media:// URLs, but legacy builds
 *  fall back to data URLs — decode those without a fetch (and in chunks so
 *  multi-MB base64 never hits a single-string limit). */
function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer | null {
  const bytes = dataUrlToBytes(dataUrl);
  return bytes ? (bytes.buffer as ArrayBuffer) : null;
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  if (url.startsWith("data:")) {
    const ab = dataUrlToArrayBuffer(url);
    if (!ab || !ab.byteLength) throw new Error("empty data URL");
    return ab;
  }
  const resp = await fetch(url);
  const ab = await resp.arrayBuffer();
  if (!ab.byteLength) throw new Error("empty");
  return ab;
}

/** Compact design-language preview player for the VO / Music import rows.
 *  Replaces the native `<audio controls>` (whose Chromium chrome clashes with
 *  the dark theme): play/pause + click-to-seek progress bar + elapsed/total.
 *  Reports the loaded duration via `onDurationKnown` (used by the VO row to
 *  feed the Fit-to-VO math). */
/** Mutable audio-element ref (React 18's RefObject.current is readonly, but
 *  MiniAudioPlayer / VolumeSlider need to write `.current`). */
type AudioElRef = { current: HTMLAudioElement | null };


export function MiniAudioPlayer({ src, onDurationKnown, audioRef }: {
  src: string | null;
  onDurationKnown?: (sec: number) => void;
  /** Optional external ref — lets a sibling volume slider set the audio
   *  element's volume live while dragging. */
  audioRef?: AudioElRef;
}) {
  const internalRef = useRef<HTMLAudioElement | null>(null) as AudioElRef;
  const barRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    // Reset the transport when the clip changes (re-import / replace).
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
  }, [src]);

  const toggle = () => {
    const el = internalRef.current;
    if (!el || !src) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = internalRef.current;
    const bar = barRef.current;
    if (!el || !bar || !Number.isFinite(el.duration) || el.duration <= 0) return;
    const r = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    el.currentTime = ratio * el.duration;
    setCurrent(el.currentTime);
  };

  const pct = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <div className="prod-mini-player">
      <button
        className="prod-mini-play"
        onClick={toggle}
        title={playing ? "Pause preview" : "Play preview"}
        disabled={!src}
        aria-label={playing ? "Pause preview" : "Play preview"}
      >
{playing ? "❚❚" : <PlayButtonIcon size={12} />}
      </button>
      <div className="prod-mini-bar" ref={barRef} onClick={seek} title="Click to seek">
        <div className="prod-mini-fill" style={{ width: `${pct}%` }} />
        <div className="prod-mini-head" style={{ left: `${pct}%` }} />
      </div>
      <span className="prod-mini-time">
        {formatRuntime(current)} / {duration > 0 ? formatRuntime(duration) : "–:––"}
      </span>
      <audio
        ref={(el) => {
          internalRef.current = el;
          if (audioRef) audioRef.current = el;
        }}
        src={src ?? undefined}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) { setDuration(d); onDurationKnown?.(d); }
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrent(0); }}
      />
    </div>
  );
}

/** Volume slider that stays responsive during a drag: the thumb moves and the
 *  audio element's volume updates immediately (local state + direct ref write),
 *  but the expensive production save only happens when the user lets go. The
 *  old onChange→saveField-per-tick path was noticeably sluggish. */
export function VolumeSlider({ value, onCommit, audioRef, title }: {
  value: number;
  onCommit: (v: number) => void;
  /** Optional audio element to adjust live while dragging. */
  audioRef?: AudioElRef;
  title?: string;
}) {
  const [live, setLive] = useState(value);
  const timerRef = useRef<number | null>(null);

  useEffect(() => { setLive(value); }, [value]);
  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);

  const apply = (v: number) => {
    setLive(v);
    if (audioRef?.current) audioRef.current.volume = v;
    // Safety net: persist shortly after the last change even if a pointerup
    // is missed (e.g. release outside the input).
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => onCommit(v), 250);
  };

  const commitNow = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    onCommit(live);
  };

  return (
    <label className="prod-music-vol" title={title}>
      Vol
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={live}
        onChange={(e) => apply(Number(e.target.value))}
        onPointerUp={commitNow}
        onKeyUp={commitNow}
        onBlur={commitNow}
      />
    </label>
  );
}

/** Real-time playback preview + draggable cut points. The voiceover clip
 *  (one file for the whole production) drives the timeline total when it
 *  exists; otherwise the total is the sum of per-shot durations. Each block
 *  is a shot, width is proportional to durationSec, and dragging the right
 *  edge sets that shot's duration. The playhead can be drag-scrubbed; the
 *  preview pane's height can be dragged from its bottom border. Both VO and
 *  music are decoded to AudioBuffers and mixed via GainNodes so the sliders
 *  affect live playback. The voiceover waveform is drawn on a canvas behind
 *  the semi-transparent shot blocks. */

export function AnimaticTimeline({
  prodId, scenes, voUrl, voDuration, onVoDurationKnown, musicUrl, musicVolume, voiceoverVolume,
  onUpdateDurations, onFitToVo, onUpdateTotal, onRemoveVideo, onToggleMute, onSaveAsReference,
}: {
  prodId: string;
  scenes: Production["scenes"];
  voUrl: string | null;
  voDuration: number | null;
  onVoDurationKnown: (sec: number) => void;
  musicUrl: string | null;
  musicVolume: number;
  voiceoverVolume: number;
  onUpdateDurations: (updates: { shotId: string; durationSec: number }[]) => void;
  onFitToVo: () => void;
  onUpdateTotal: (sec: number) => void;
  /** Remove a shot's generated video (the preview falls back to the still). */
  onRemoveVideo: (shotId: string) => void;
  /** Toggle whether a shot's own embedded audio plays in the preview. */
  onToggleMute: (shotId: string) => void;
  /** Copy the previewed shot's generated clip/frame into the production as a
   *  new reference (right-click the preview). */
  onSaveAsReference?: (shotId: string, rel: string) => void;
}) {
  const shots = flatShots(scenes);
  const sumDur = totalDuration(scenes);
  // Total is always the sum of shot durations — the user can edit it freely
  // (and "Fit to VO" rescales the shots to match the voiceover). The VO's
  // own length is overlaid on the strip as a waveform at its true scale.
  const total = sumDur;
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [editingTotal, setEditingTotal] = useState(false);
  const [totalDraft, setTotalDraft] = useState("");
  const stripRef = useRef<HTMLDivElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [previewHeight, setPreviewHeight] = useState(440);
  const genMenu = useGenerationMenu();

  // ---- Zoomable strip + per-shot video pool (state) ----------------------
  // The strip scales from a "fit" baseline (whole runtime at 1x). Wheel-zooming
  // pins the playhead to its current screen X; the wrapper scrolls horizontally
  // once the content outgrows it. The preview pane keeps one <video> element
  // MOUNTED PER SHOT (LRU-capped): cutting between clips toggles visibility
  // instead of swapping src, which is what removes the black reload flash.
  const [zoom, setZoom] = useState(1);
  const [stripW, setStripW] = useState(0);
  const scrollWrapRef = useRef<HTMLDivElement>(null);
  const pendingScrollRef = useRef<number | null>(null);
  // Mirrors of render-time values read by stable closures (wheel handler).
  const playheadRef = useRef(0);
  const ppsRef = useRef(0);
  const zoomRef = useRef(1);
  // Pooled video elements + LRU bookkeeping, keyed by shot id.
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const poolLruRef = useRef<Map<string, number>>(new Map());
  const poolTickRef = useRef(0);
  const [mountedVideos, setMountedVideos] = useState<string[]>([]);

  /** Parse a user-entered total: "1:30", "0:42", "90", "1m30s", "45s". */
  function parseTotalInput(s: string): number | null {
    const t = s.trim();
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    let m = t.match(/^(\d+)m(\d+(?:\.\d+)?)?s?$/);
    if (m) return Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0);
    m = t.match(/^(\d+(?:\.\d+)?)s$/);
    if (m) return Number(m[1]);
    m = t.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    m = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    return null;
  }

  function startEditTotal() {
    setTotalDraft(formatRuntime(total));
    setEditingTotal(true);
  }

  function commitTotal() {
    const next = parseTotalInput(totalDraft);
    if (next != null && next > 0) onUpdateTotal(next);
    setEditingTotal(false);
  }

  // Decode VO and music once into AudioBuffers (cached for playback + waveform).
  // The decoded duration is the primary source for the waveform, but the
  // <audio> element's metadata is the source of truth for playback length.
  // If decode fails (e.g. codec supported by <audio> but not by
  // AudioContext), we must NOT clobber a valid duration already reported
  // by onLoadedMetadata — otherwise the UI sticks at 0:00 even though the
  // file plays.
  const [voBuffer, setVoBuffer] = useState<AudioBuffer | null>(null);
  const [musicBuffer, setMusicBuffer] = useState<AudioBuffer | null>(null);
  useEffect(() => {
    if (!voUrl) { setVoBuffer(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const ab = await fetchArrayBuffer(voUrl);
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        const buf = await ctx.decodeAudioData(ab.slice(0));
        await ctx.close().catch(() => {});
        if (cancelled) return;
        setVoBuffer(buf);
        onVoDurationKnown(buf.duration);
      } catch (e) {
        if (!cancelled) {
          setVoBuffer(null);
          // Do NOT call onVoDurationKnown(0) here — the hidden <audio>
          // element's onLoadedMetadata will provide the real duration even
          // when AudioContext can't decode this file (e.g. some mp3s).
          console.warn("VO AudioContext decode failed, falling back to <audio> metadata:", e);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voUrl]);

  useEffect(() => {
    if (!musicUrl) { setMusicBuffer(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const ab = await fetchArrayBuffer(musicUrl);
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        const buf = await ctx.decodeAudioData(ab.slice(0));
        await ctx.close().catch(() => {});
        if (cancelled) return;
        setMusicBuffer(buf);
      } catch {
        if (!cancelled) setMusicBuffer(null);
      }
    })();
    return () => { cancelled = true; };
  }, [musicUrl]);

  /** Cumulative start time of each shot in seconds. */
  const starts = useMemo(() => {
    const acc: number[] = [];
    let t = 0;
    for (const s of shots) { acc.push(t); t += s.durationSec ?? 3; }
    return acc;
  }, [shots]);

  /** Index of the shot the playhead is currently inside. */
  const activeIdx = useMemo(() => {
    if (playhead < 0 || !shots.length) return -1;
    for (let i = 0; i < shots.length; i++) {
      const end = starts[i] + (shots[i].durationSec ?? 3);
      if (playhead < end) return i;
    }
    return shots.length - 1;
  }, [playhead, shots, starts]);

  // Timeline playback uses hidden <audio> elements (more reliable codec support
  // than AudioContext decoding). Both are mixed via volume props so sliders take
  // effect live; the visual playhead follows wall-clock time synced to the
  // audio currentTime when possible.
  const voAudioRef = useRef<HTMLAudioElement | null>(null);
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const stopFlagRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const startedHeadRef = useRef(0);

  // Keep hidden players in sync with slider volumes and src changes.
  useEffect(() => { if (voAudioRef.current) voAudioRef.current.volume = Math.max(0, Math.min(1, voiceoverVolume)); }, [voiceoverVolume, voUrl]);
  useEffect(() => { if (musicAudioRef.current) musicAudioRef.current.volume = Math.max(0, Math.min(1, musicVolume)); }, [musicVolume, musicUrl]);
  useEffect(() => {
    if (voAudioRef.current) voAudioRef.current.src = voUrl ?? "";
    if (voAudioRef.current && !voUrl) { try { voAudioRef.current.pause(); } catch {} }
  }, [voUrl]);
  useEffect(() => {
    if (musicAudioRef.current) musicAudioRef.current.src = musicUrl ?? "";
    if (musicAudioRef.current) musicAudioRef.current.loop = true;
    if (musicAudioRef.current && !musicUrl) { try { musicAudioRef.current.pause(); } catch {} }
  }, [musicUrl]);

  const stop = useCallback(() => {
    stopFlagRef.current++;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    try { voAudioRef.current?.pause(); } catch {}
    try { musicAudioRef.current?.pause(); } catch {}
    setPlaying(false);
  }, []);

  const play = useCallback(async () => {
    if (playing) { stop(); return; }
    const flag = ++stopFlagRef.current;
    const voEl = voAudioRef.current;
    const muEl = musicAudioRef.current;
    const head = playhead;
    startedHeadRef.current = head;
    startedAtRef.current = performance.now() / 1000;
    // Wait until each element can play. Only force a load when it hasn't
    // loaded yet; the seek below is applied AFTER this settles so a deferred
    // load() can't reset currentTime back to 0 (which would restart playback
    // from the top regardless of the playhead).
    const waitUntilReady = (el: HTMLAudioElement | null): Promise<void> => {
      if (!el || el.readyState >= 2) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => resolve();
        el.addEventListener("canplay", done, { once: true });
        el.addEventListener("error", done, { once: true });
        window.setTimeout(done, 3000);
        el.load();
      });
    };
    await Promise.all([waitUntilReady(voEl), waitUntilReady(muEl)]);
    // Seek both players to the playhead (music loops by its own length).
    const toPlay: Promise<void>[] = [];
    if (voEl && voUrl) {
      const elDur = Number.isFinite(voEl.duration) && voEl.duration > 0 ? voEl.duration : 0;
      const voDur = voBuffer ? voBuffer.duration : elDur; // 0 = unknown length
      const pastEnd = voDur > 0 && head >= voDur;
      if (!pastEnd) {
        // Known duration: clamp to the playhead; unknown: best-effort seek and play anyway.
        try { voEl.currentTime = voDur > 0 ? Math.max(0, Math.min(head, voDur)) : Math.max(0, head); } catch {}
        voEl.volume = Math.max(0, Math.min(1, voiceoverVolume));
        toPlay.push(voEl.play().catch(() => {}));
      } else {
        // Playhead is past the end of the voiceover — keep it silent and let
        // the wall clock run the visuals (music may still be looping).
        try { voEl.pause(); } catch {}
      }
    }
    if (muEl && musicUrl) {
      try {
        const d = muEl.duration;
        muEl.currentTime = Number.isFinite(d) && d > 0 ? head % d : head;
      } catch { try { muEl.currentTime = head; } catch {} }
      muEl.volume = Math.max(0, Math.min(1, musicVolume));
      muEl.loop = true;
      toPlay.push(muEl.play().catch(() => {}));
    }
    // Even with no audio, we still run the visual clock.
    await Promise.all(toPlay);
    // Re-anchor wall clock after play() resolves (play may be async).
    startedAtRef.current = performance.now() / 1000;
    setPlaying(true);
    const tick = () => {
      if (flag !== stopFlagRef.current) return;
      // Prefer audio clock when VO is playing for sample-accurate sync.
      let head: number;
      if (voEl && !voEl.paused && voEl.currentTime > 0 && voBuffer && voEl.currentTime < voBuffer.duration) {
        head = startedHeadRef.current + (voEl.currentTime - Math.min(startedHeadRef.current, voBuffer.duration));
        // Fallback to wall clock if audio time stalls
        const wallHead = startedHeadRef.current + (performance.now() / 1000 - startedAtRef.current);
        if (Math.abs(head - wallHead) > 0.5) head = wallHead;
      } else {
        head = startedHeadRef.current + (performance.now() / 1000 - startedAtRef.current);
      }
      if (head >= total) { stop(); setPlayhead(0); return; }
      setPlayhead(head);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [playing, playhead, voUrl, musicUrl, voBuffer, total, stop, voiceoverVolume, musicVolume]);

  useEffect(() => () => stop(), [stop]);

  // Spacebar toggles playback (ignored while typing in inputs/textareas/selects).
  const playRef = useRef(play);
  useEffect(() => { playRef.current = play; }, [play]);
  const shotsLenRef = useRef(shots.length);
  useEffect(() => { shotsLenRef.current = shots.length; }, [shots.length]);
  useEffect(() => {
    const isEditable = (el: Element | null) => {
      if (!el) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if ((el as HTMLElement).isContentEditable) return true;
      return false;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " " && e.key !== "Spacebar") return;
      if (e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as Element | null;
      if (isEditable(target)) return;
      if (!shotsLenRef.current) return;
      e.preventDefault();
      void playRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ---- Zoomable strip + per-shot video pool (behavior) -------------------

  /** Pixels per second at the current zoom (fit scale × zoom). */
  const fitPps = stripW > 0 ? stripW / total : 0;
  const pps = fitPps * zoom;
  const contentW = Math.max(stripW, Math.ceil(total * pps));
  const activeId = activeIdx >= 0 && shots[activeIdx] ? shots[activeIdx].id : null;
  /** Playhead's local time within the shot it sits in. */
  const offsetInShot = activeIdx >= 0 ? Math.max(0, playhead - (starts[activeIdx] ?? 0)) : 0;

  playheadRef.current = playhead;
  ppsRef.current = pps;
  zoomRef.current = zoom;

  // Zoom is a per-session view of this production; refit when switching.
  useEffect(() => { setZoom(1); }, [prodId]);

  // Track the scroll viewport's width so blocks stay pixel-accurate.
  useEffect(() => {
    const el = scrollWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setStripW(el.clientWidth));
    ro.observe(el);
    setStripW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // A wheel-zoom computes the scroll position that pins the playhead to its
  // current screen X; apply it AFTER React lays out the resized content.
  useLayoutEffect(() => {
    const wrap = scrollWrapRef.current;
    if (!wrap || pendingScrollRef.current == null) return;
    wrap.scrollLeft = pendingScrollRef.current;
    pendingScrollRef.current = null;
  }, [zoom, pps]);

  // Wheel zoom anchored on the playhead. This listener must be native
  // (non-passive) — React's delegated wheel handler cannot preventDefault,
  // so the page would scroll while zooming without it.
  useEffect(() => {
    const wrap = scrollWrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      // Horizontal deltas pan natively; zoom only on vertical wheels/pinch.
      if (!e.deltaY || e.deltaX) return;
      e.preventDefault();
      const viewport = wrap.clientWidth;
      if (viewport <= 0 || total <= 0) return;
      const fit = viewport / total;
      const cur = zoomRef.current;
      const next = Math.max(1, Math.min(ANIMATIC_MAX_ZOOM, cur * Math.exp(-e.deltaY * 0.0016)));
      if (next === cur) return;
      const headT = Math.min(Math.max(playheadRef.current, 0), total);
      // Keep the playhead under its current screen position across the rescale.
      const headScreenX = headT * fit * cur - wrap.scrollLeft;
      const maxScroll = Math.max(0, total * fit * next - viewport);
      pendingScrollRef.current = Math.max(0, Math.min(maxScroll, headT * fit * next - headScreenX));
      zoomRef.current = next;
      setZoom(next);
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [total]);

  // Keep the playhead visible: auto-follow during playback (centered), and
  // reveal it right after a manual seek when the strip has been zoomed in.
  // Skipped while the user is drag-scrubbing so the strip never slides under
  // a stationary cursor.
  useEffect(() => {
    if (headDragRef.current) return;
    const wrap = scrollWrapRef.current;
    if (!wrap || pps <= 0 || stripW <= 0) return;
    const maxScroll = Math.max(0, contentW - stripW);
    const x = playhead * pps;
    const left = wrap.scrollLeft;
    if (x < left + 8 || x > left + stripW - 8) {
      wrap.scrollLeft = Math.max(0, Math.min(maxScroll, x - stripW / 2));
    }
  }, [playhead, playing, pps, stripW, contentW]);

  // Mount <video> elements for the active shot and its neighbours ahead of
  // time so approaching cuts never reload; evict least-recently-active ones
  // beyond VIDEO_POOL_MAX so long timelines don't hold every clip open.
  useEffect(() => {
    if (activeIdx < 0) return;
    const tick = ++poolTickRef.current;
    for (let i = Math.max(0, activeIdx - 2); i <= Math.min(shots.length - 1, activeIdx + 2); i++) {
      if (shots[i]?.videoPath) poolLruRef.current.set(shots[i].id, tick);
    }
    const valid = new Set<string>();
    shots.forEach((s) => { if (s.videoPath) valid.add(s.id); });
    const next = [...poolLruRef.current.entries()]
      .filter(([id]) => valid.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, VIDEO_POOL_MAX)
      .map(([id]) => id);
    setMountedVideos((prev) => (
      prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next
    ));
  }, [activeIdx, shots]);

  // Pool transport: pause everything except the active shot. The active one
  // snaps to the playhead's local time, then plays or pauses with the clock.
  useEffect(() => {
    videoElsRef.current.forEach((v, id) => {
      if (id === activeId) return;
      try { if (!v.paused) v.pause(); } catch {}
    });
    if (!activeId) return;
    const v = videoElsRef.current.get(activeId);
    if (!v) return;
    try {
      if (v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0)
        v.currentTime = Math.min(offsetInShot, v.duration);
    } catch {}
    if (playing) void v.play().catch(() => {});
    else { try { v.pause(); } catch {} }
    // offsetInShot intentionally omitted: mid-playback offsets advance every
    // frame while the video free-runs against the wall clock between cuts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, activeIdx, activeId]);

  // Paused / scrubbing: pin the active clip to the frame under the playhead.
  useEffect(() => {
    if (playing || !activeId) return;
    const v = videoElsRef.current.get(activeId);
    if (!v) return;
    try {
      if (v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0)
        v.currentTime = Math.min(Math.max(0, offsetInShot), v.duration);
    } catch {}
  }, [playhead, playing, activeIdx, activeId]);

  // ---- Waveform ----------------------------------------------------------
  // The canvas covers the visible window only: time t maps to x = t*pps −
  // scrollLeft. Peaks are downsampled once per decode into fixed ~6ms buckets
  // so a zoom-follow playback loop can redraw every frame without rescanning
  // raw PCM; redraws themselves stay event-driven.

  const voPeaks = useMemo(() => {
    if (!voBuffer || !total) return null;
    const ch = voBuffer.getChannelData(0);
    // Cap the bucket count: enough resolution to stay smooth at max zoom,
    // small enough that the one-time scan is instant.
    const targetBuckets = Math.min(32768, Math.max(64, Math.ceil(total * 640)));
    const per = Math.max(1, Math.floor(ch.length / targetBuckets));
    const n = Math.ceil(ch.length / per);
    const mins = new Float32Array(n);
    const maxs = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      let lo = 1, hi = -1;
      const s0 = b * per;
      const s1 = Math.min(ch.length, s0 + per);
      for (let j = s0; j < s1; j++) {
        const v = ch[j];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      mins[b] = lo;
      maxs[b] = hi;
    }
    return { mins, maxs, bucketSec: per / voBuffer.sampleRate };
  }, [voBuffer]);

  const drawWaveform = useCallback(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cvs.clientWidth, h = cvs.clientHeight;
    if (w <= 0 || h <= 0) return;
    cvs.width = Math.max(1, Math.floor(w * dpr));
    cvs.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!voPeaks || total <= 0 || pps <= 0 || voPeaks.bucketSec <= 0) return;
    const scrollLeft = scrollWrapRef.current?.scrollLeft ?? 0;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4f8ef7";
    // Columns of ~2 CSS px across the visible window only.
    const cols = Math.max(1, Math.floor(w / 2));
    const secondsPerCol = 2 / pps;
    const tStart = scrollLeft / pps;
    const { mins, maxs, bucketSec } = voPeaks;
    const voSecs = voBuffer?.duration ?? 0;
    for (let i = 0; i < cols; i++) {
      const t0 = tStart + i * secondsPerCol;
      if (t0 >= total || t0 >= voSecs) break;
      let b0 = Math.floor(t0 / bucketSec);
      let b1 = Math.floor((t0 + secondsPerCol) / bucketSec);
      b0 = Math.max(0, Math.min(mins.length - 1, b0));
      b1 = Math.max(b0, Math.min(mins.length - 1, b1));
      let min = 1, max = -1;
      for (let b = b0; b <= b1; b++) {
        if (mins[b] < min) min = mins[b];
        if (maxs[b] > max) max = maxs[b];
      }
      const x = (i / cols) * w;
      const y1 = ((1 - max) / 2) * h;
      const y2 = ((1 - min) / 2) * h;
      const barH = Math.max(1, y2 - y1);
      if (barH < 1.5) ctx.fillRect(x, (h - barH) / 2, Math.max(1, w / cols - 0.5), barH);
      else ctx.fillRect(x, y1, Math.max(1, w / cols - 0.5), barH);
    }
  }, [voPeaks, voBuffer, total, pps]);

  useEffect(() => { drawWaveform(); }, [drawWaveform, previewHeight, shots.length]);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => drawWaveform());
    ro.observe(el);
    return () => ro.disconnect();
  }, [drawWaveform]);
  // Also redraw after fonts/style settle
  useEffect(() => {
    const id = window.setTimeout(drawWaveform, 100);
    return () => window.clearTimeout(id);
  }, [drawWaveform]);
  // Redraw as the strip scrolls under the waveform row (rAF-throttled).
  useEffect(() => {
    const wrap = scrollWrapRef.current;
    if (!wrap) return;
    let queued = false;
    let queuedRaf = 0;
    const schedule = () => {
      if (queued) return;
      queued = true;
      queuedRaf = window.requestAnimationFrame(() => { queued = false; drawWaveform(); });
    };
    wrap.addEventListener("scroll", schedule, { passive: true });
    return () => {
      wrap.removeEventListener("scroll", schedule);
      window.cancelAnimationFrame(queuedRaf);
    };
  }, [drawWaveform]);
  // Page zoom (Ctrl+/-/0) rescales content without resizing the waveform's CSS
  // box, so the ResizeObserver never fires; devicePixelRatio also updates late.
  // Redraw on zoom notification and window resize, with retries to catch the
  // late dpr change.
  useEffect(() => {
    let timers: number[] = [];
    const schedule = () => {
      for (const t of timers) window.clearTimeout(t);
      timers = [0, 150, 600].map((d) => window.setTimeout(drawWaveform, d));
    };
    window.addEventListener("resize", schedule);
    const offZoom = window.cascade.onZoomChanged(schedule);
    return () => {
      for (const t of timers) window.clearTimeout(t);
      window.removeEventListener("resize", schedule);
      offZoom();
    };
  }, [drawWaveform]);

  // ---- Interactions -----------------------------------------------------

  /** Drag a block's right edge to set its duration. This is a roll edit: the
   *  dragged shot trades time with the following shot, so the total stays put
   *  and every later edit point is untouched. */
  const dragRef = useRef<{
    shotId: string;
    startX: number;
    startDur: number;
    pxPerSec: number;
    nextShot: { id: string; dur: number } | null;
  } | null>(null);
  const onHandleDown = (e: React.PointerEvent, shotId: string) => {
    if (pps <= 0) return;
    const idx = shots.findIndex((s) => s.id === shotId);
    if (idx < 0) return;
    dragRef.current = {
      shotId,
      startX: e.clientX,
      startDur: shots[idx].durationSec ?? 3,
      pxPerSec: pps,
      nextShot: idx + 1 < shots.length
        ? { id: shots[idx + 1].id, dur: shots[idx + 1].durationSec ?? 3 }
        : null,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    stop();
    e.preventDefault();
    e.stopPropagation();
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    let next = Math.max(0.5, Math.min(20, d.startDur + dx / d.pxPerSec));
    const updates: { shotId: string; durationSec: number }[] = [{ shotId: d.shotId, durationSec: next }];
    if (d.nextShot) {
      // Keep the boundary after the next shot fixed: shot i+1 absorbs the delta.
      let nextDur = d.nextShot.dur - (next - d.startDur);
      if (nextDur < 0.5) { nextDur = 0.5; next = d.startDur + (d.nextShot.dur - 0.5); }
      if (nextDur > 20) { nextDur = 20; next = d.startDur - (20 - d.nextShot.dur); }
      next = Math.max(0.5, Math.min(20, next));
      updates[0].durationSec = next;
      updates.push({ shotId: d.nextShot.id, durationSec: nextDur });
    }
    onUpdateDurations(updates.map((u) => ({ ...u, durationSec: Math.round(u.durationSec * 10) / 10 })));
  };
  const onHandleUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };

  /** Drag the preview's bottom border to resize. */
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const onResizeDown = (e: React.PointerEvent) => {
    resizeRef.current = { startY: e.clientY, startH: previewHeight };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    const dy = e.clientY - r.startY;
    setPreviewHeight(Math.max(80, Math.min(640, r.startH + dy)));
  };
  const onResizeUp = (e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    resizeRef.current = null;
  };

  /** Seek by pointer position. `ref` is the element whose rect defines the
   *  coordinate system: the zoomed strip is the scrolled content itself, so
   *  its bounding rect already accounts for scrollLeft and px map directly
   *  via the current scale — while the narrower transport scrubber stays a
   *  fixed full-range overview. */
  const seekFromEvent = (ref: React.RefObject<HTMLElement>, clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (ref === stripRef) {
      if (pps <= 0) return;
      const next = (clientX - r.left) / pps;
      setPlayhead(Math.max(0, Math.min(total, next)));
      return;
    }
    const x = clientX - r.left;
    const next = Math.max(0, Math.min(total, (x / r.width) * total));
    setPlayhead(next);
  };
  const headDragRef = useRef<{ ref: React.RefObject<HTMLElement> } | null>(null);
  const onSeekDown = (ref: React.RefObject<HTMLElement>) => (e: React.PointerEvent) => {
    headDragRef.current = { ref };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    stop();
    seekFromEvent(ref, e.clientX);
    e.preventDefault();
  };
  const onSeekMove = (e: React.PointerEvent) => {
    const d = headDragRef.current;
    if (!d) return;
    seekFromEvent(d.ref, e.clientX);
  };
  const onSeekUp = (e: React.PointerEvent) => {
    if (!headDragRef.current) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    headDragRef.current = null;
  };

  if (!shots.length) {
    return <p className="hint">Add shots in Step 1 to start building the timeline.</p>;
  }

  const activeShot = activeIdx >= 0 ? shots[activeIdx] : null;
  const activeThumb = activeShot?.artwork;
  const headX = total > 0 ? (playhead / total) * 100 : 0;

  return (
    <div className="prod-animatic-body">
      <div
        className="prod-animatic-preview"
        ref={previewRef}
        style={{ height: `${previewHeight}px` }}
        title={activeShot?.videoPath || activeShot?.artwork ? "Right-click for save, copy, edit, reference, or delete options" : undefined}
        onContextMenu={(e) => {
          const rel = activeShot?.videoPath ?? activeShot?.artwork;
          if (activeShot && rel) genMenu.open(e, rel, { src: cascadeMedia(prodId, rel), media: activeShot.videoPath ? "video" : "image" });
        }}
      >
        {/* One mounted <video> per recently-active shot (LRU-capped); only the
            active clip is visible, so cuts swap pixels instead of reloading
            media — no black flash between clips. The wall clock drives which
            clip shows; a video longer than its shot is cut at the boundary and
            a shorter one loops. */}
        {mountedVideos.map((vidId) => {
          const s = shots.find((q) => q.id === vidId);
          if (!s?.videoPath) return null;
          const isActive = vidId === activeShot?.id;
          return (
            <video
              key={vidId}
              ref={(el) => {
                if (el) videoElsRef.current.set(vidId, el);
                else videoElsRef.current.delete(vidId);
              }}
              className={"prod-animatic-video" + (isActive ? " live" : "")}
              src={`cascade-media://${prodId}/${encodeURIComponent(s.videoPath)}`}
              muted={!!s.muted}
              loop
              preload="auto"
              playsInline
              onLoadedMetadata={() => {
                if (!isActive) return; // it will be aligned when promoted
                const v = videoElsRef.current.get(vidId);
                if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
                try { v.currentTime = Math.min(offsetInShot, v.duration); } catch {}
                if (playing) void v.play().catch(() => {});
              }}
            />
          );
        })}
        {activeShot && activeShot.videoPath && (
          <button
            className="prod-animatic-video-remove"
            title="Remove this shot's video (back to a still frame)"
            onClick={(e) => { e.stopPropagation(); onRemoveVideo(activeShot.id); }}
          >
            ×
          </button>
        )}
        {activeShot && !activeShot.videoPath && activeThumb ? (
          <AnimaticThumb prodId={prodId} shotId={activeShot.id} artwork={activeThumb} />
        ) : null}
        {activeShot && !activeThumb ? (
          <div className="prod-animatic-preview-slate">
            <span>SLATE</span>
            <strong>{activeShot.number}</strong>
          </div>
        ) : null}
        {!activeShot && <div className="prod-animatic-preview-slate"><span>No shots yet</span></div>}
        <div
          className="prod-animatic-preview-resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          title="Drag to resize the preview"
        />
      </div>

<div className="prod-animatic-transport">
        <button
          onClick={() => void play()}
          disabled={!shots.length}
          title={playing ? "Pause playback" : "Play from playhead"}
        >
          {playing ? "❚❚" : <PlayButtonIcon size={15} />}
        </button>
        <button onClick={() => { stop(); setPlayhead(0); }} title="Stop and rewind"><StopButtonIcon size={15} /></button>
        <div
          className="prod-animatic-scrub"
          ref={scrubRef}
          onPointerDown={onSeekDown(scrubRef)}
          onPointerMove={onSeekMove}
          onPointerUp={onSeekUp}
          onPointerCancel={onSeekUp}
          title="Drag the playhead, or click to seek"
        >
          <div className="prod-animatic-scrub-fill" style={{ width: `${headX}%` }} />
          <div className="prod-animatic-scrub-head" style={{ left: `${headX}%` }} />
        </div>
        <span className="prod-animatic-time">
          {formatRuntime(playhead)} / {editingTotal ? (
            <input
              className="prod-animatic-total-input"
              autoFocus
              value={totalDraft}
              onChange={(e) => setTotalDraft(e.target.value)}
              onBlur={commitTotal}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitTotal(); }
                if (e.key === "Escape") { e.preventDefault(); setEditingTotal(false); }
              }}
              onFocus={(e) => e.currentTarget.select()}
              title="hh:mm:ss, mm:ss, or seconds"
            />
          ) : (
            <button
              className="prod-animatic-total-btn"
              onClick={startEditTotal}
              title="Click to set the total runtime"
            >
              {formatRuntime(total)}
            </button>
          )}
        </span>
        {voDuration && Math.abs(voDuration - sumDur) > 0.1 && (
          <button
            className="prod-btn"
            onClick={onFitToVo}
            title="Rescale every shot's length so the total matches the voiceover"
          >
            Fit to VO
          </button>
        )}
      </div>

      <div className="prod-animatic-strip-wrap">
        {/* Horizontal scroll frame: the wheel-zoomed strip lives inside. The
            transport scrubber above stays a fixed full-range overview. */}
        <div className="prod-animatic-scroll" ref={scrollWrapRef}>
          <div
            className="prod-animatic-strip"
            ref={stripRef}
            style={{ width: `${contentW}px`, minWidth: "100%" }}
            onPointerDown={onSeekDown(stripRef)}
            onPointerMove={onSeekMove}
            onPointerUp={onSeekUp}
            onPointerCancel={onSeekUp}
            title="Click or drag to seek · Mouse wheel zooms around the playhead"
          >
            {shots.map((s, i) => {
              const dur = s.durationSec ?? 3;
              return (
                <div
                  key={s.id}
                  className={"prod-animatic-block" + (i === activeIdx ? " active" : "")}
                  style={{ left: `${starts[i] * pps}px`, width: `${dur * pps}px` }}
                  title={`${s.number} · ${dur.toFixed(1)}s`}
                >
                  {s.artwork
                    ? <AnimaticThumb prodId={prodId} shotId={s.id} artwork={s.artwork} />
                    : <div className="prod-animatic-block-slate">SLATE<br /><strong>{s.number}</strong></div>}
                  {s.videoPath && (
                    <button
                      className={"prod-animatic-block-mute" + (s.muted ? " muted" : "")}
                      title={s.muted ? "Unmute this clip's audio" : "Mute this clip's audio"}
                      aria-label={s.muted ? "Unmute this clip's audio" : "Mute this clip's audio"}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onToggleMute(s.id); }}
                    >
                      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                        <path d="M2 6h3l4-3.5v11L5 10H2z" fill="currentColor" />
                        {s.muted ? (
                          <path d="M10.7 5.7l4 4M14.7 5.7l-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
                        ) : (
                          <>
                            <path d="M10.8 5.8a3.1 3.1 0 010 4.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
                            <path d="M12.9 3.9a5.9 5.9 0 010 8.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
                          </>
                        )}
                      </svg>
                    </button>
                  )}
                  <span className="prod-animatic-block-num">{s.number}</span>
                  <span className="prod-animatic-block-dur">{dur.toFixed(1)}s</span>
                  <div
                    className="prod-animatic-block-handle"
                    onPointerDown={(e) => onHandleDown(e, s.id)}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                    onPointerCancel={onHandleUp}
                    title="Drag to set the length of this clip"
                  />
                </div>
              );
            })}
            <div className="prod-animatic-playhead" style={{ left: `${playhead * pps}px` }} />
          </div>
        </div>
        {voUrl && (
          <div className="prod-animatic-wave-row" aria-label="Voiceover waveform">
            <canvas ref={canvasRef} className="prod-animatic-waveform" />
          </div>
        )}
      </div>

      {/* Hidden playback elements — the animatic transport plays these; they
          have no visible chrome (the volume sliders live next to the import
          buttons, the waveform lives under the image strip). */}
      <audio ref={voAudioRef} src={voUrl ?? ""} preload="auto" hidden onLoadedMetadata={(e) => {
        const duration = e.currentTarget.duration;
        if (Number.isFinite(duration) && duration > 0) onVoDurationKnown(duration);
      }} />
      <audio ref={musicAudioRef} src={musicUrl ?? ""} preload="auto" loop hidden />
      <GenerationMenu
        menu={genMenu.menu}
        onClose={genMenu.close}
        onSaveAsReference={onSaveAsReference && activeShot ? (rel) => onSaveAsReference(activeShot.id, rel) : undefined}
      />
    </div>
  );
}

export function ProdLog({ lines }: { lines: LogLine[] }) {  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [lines.length]);
  return (
    <div className="prod-log" ref={ref}>
      {lines.map((l, i) => (
        <div key={i} className={"prod-log-line " + l.level}>
          <span className="prod-log-time">{l.at}</span> {l.message}
        </div>
      ))}
    </div>
  );
}


export function cascadeMedia(prodId: string, rel: string): string {
  const base = `cascade-media://${prodId}/${encodeURIComponent(rel)}`;
  const rev = mediaRev(prodId, rel);
  return rev ? `${base}?v=${rev}` : base;
}


export function formatRuntime(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** One storyboard frame in the Step 3 contact sheet. The PNG lives in the
 *  production folder; the thumbnail is fetched on demand as a data URL. */


