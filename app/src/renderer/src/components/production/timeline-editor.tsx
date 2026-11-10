/**
 * Multi-track timeline editor (Animatic Editor Expansion, Item 3).
 *
 * The editing surface for `Production.timeline`: track headers (name,
 * lock, hide/mute), a frame-accurate playhead, zoom, snapping (playhead +
 * clip edges, toggleable), click/shift-click/marquee selection, and the
 * A2 operations behind gestures — drag to move (between tracks too),
 * edge zones trim, Alt+edge rolls, right-drag slips, S splits at the
 * playhead, Delete removes, Ctrl+Z / Ctrl+Shift+Z undo/redo. Ripple is a
 * toolbar toggle (all-tracks default scope) applied to trims and deletes.
 * Every commit is one undo step (snapshot history) and persists through
 * `onTimelineChange`.
 *
 * A gesture applies its pure op to the gesture-start timeline on every
 * pointermove and shows the (already clamped) result as a preview; the
 * commit on release persists exactly what was previewed — the UI never
 * computes its own edit math. All gesture times land on the assembly
 * frame grid. Video clips show filmstrips sampled across their actual
 * source range; audio clips draw waveforms from the decoded source.
 *
 * The Step 4 preview player above still reads the shot projection this
 * phase; it is rewired onto `resolveTimeline` with the proxy preview
 * (Item 6), which rebuilds preview playback anyway.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  addImportedAudioClip,
  addTrack,
  clipDurationSec,
  clipEndSec,
  clipSourceTimeAt,
  clipSpeed,
  clipSpeedAt,
  clipVolume,
  setClipAudio,
  setClipSpeed,
  setClipSpeedCurve,
  setTrackVolume,
  trackVolume,
  maxDissolveSec,
  setClipTransition,
  transitionFor,
  deleteClips,
  linkedClipIds,
  moveClipToTrack,
  moveClipsBy,
  removeTrack,
  renameTrack,
  resolveTimeline,
  formatTimelineLength,
  parseTimelineLength,
  rollEdit,
  scaleTimelineToDuration,
  seedTimelineFromProduction,
  setTimelineDuration,
  setTrackHidden,
  setTrackLocked,
  setTrackMuted,
  slipClip,
  splitAtPlayhead,
  splitClipAt,
  trimClip,
  type Production,
  type ProductionTimeline,
  type SpeedKeyframe,
  type TimelineClip,
  type TimelineEditOpts,
  type TimelineTrack,
} from "../../../../shared/ipc.js";
import { resolveShotDisplay } from "../../../../shared/selected-output.js";
import { cascadeMedia } from "./animatic.js";
import { usePersistedNumber } from "./persisted-state.js";
import { createUndoHistory } from "./undo-history.js";
import { EMPTY_LOOP_REGION, loopSpan, withLoopPoint, type TimelineLoopRegion } from "./timeline-preview.js";
import { HelpTip } from "../common/HelpTip.js";
import { uid } from "./hex.js";

const VIDEO_ROW_H = 56;
/** Audio headers stack name / volume slider / buttons (Item 3), so
 *  audio rows are taller than the old single-row layout. */
const AUDIO_ROW_H = 68;
const RULER_H = 18;
const HEADER_W = 172;
/** Track-header panel width bounds + persistence key (Item 3: the
 *  panel is drag-resizable and the width survives sessions). */
const HEADER_W_MIN = 120;
const HEADER_W_MAX = 420;
const HEADER_W_KEY = "cascade.timeline.headerW";
const EDGE_PX = 7;
const SNAP_PX = 8;
const rowH = (track: TimelineTrack): number => (track.kind === "video" ? VIDEO_ROW_H : AUDIO_ROW_H);
/** Ramp editor vertical scale: clip top = fast, bottom = slow (linear). */
const RAMP_MIN = 0.1;
const RAMP_MAX = 4;
const rampYFrac = (speed: number): number => Math.max(0, Math.min(1, 1 - (speed - RAMP_MIN) / (RAMP_MAX - RAMP_MIN)));
const rampSpeedForY = (yFrac: number): number =>
  Math.max(RAMP_MIN, Math.min(RAMP_MAX, RAMP_MIN + (1 - Math.max(0, Math.min(1, yFrac))) * (RAMP_MAX - RAMP_MIN)));

/** Toolbar glyphs (UI cleanup Item 1): one stroke-icon vocabulary for the
 *  icon-only action buttons. `currentColor` throughout so disabled/active
 *  button states restyle the glyph with no extra CSS. The button carrying
 *  each icon owns the name (aria-label + title tooltip). */
const TL_ICONS: Record<string, ReactNode> = {
  undo: (<><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>),
  redo: (<><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></>),
  split: (<><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M8.2 7.8 20 19" /><path d="M8.2 16.2 20 5" /></>),
  delete: (<><path d="M4 7h16" /><path d="M9.5 7V4.5h5V7" /><path d="M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7" /><path d="M10 11v5.5M14 11v5.5" /></>),
  reverse: (<g fill="currentColor" stroke="none"><path d="M11.5 5.5 4 12l7.5 6.5z" /><path d="M20 5.5 12.5 12l7.5 6.5z" /></g>),
  speaker: (<><path d="M4 9.8v4.4h3.2L12 18.5v-13L7.2 9.8H4z" fill="currentColor" stroke="none" /><path d="M15.5 9.3a3.8 3.8 0 0 1 0 5.4" /><path d="M18.2 6.8a7.4 7.4 0 0 1 0 10.4" /></>),
  speakerMuted: (<><path d="M4 9.8v4.4h3.2L12 18.5v-13L7.2 9.8H4z" fill="currentColor" stroke="none" /><path d="m15.5 9.5 5.5 5.5M21 9.5l-5.5 5.5" /></>),
  ramp: (<><path d="M4 19.5C9 19.5 11.5 5.5 20 5.5" /><g fill="currentColor" stroke="none"><circle cx="4" cy="19.5" r="1.7" /><circle cx="12.4" cy="10.6" r="1.7" /><circle cx="20" cy="5.5" r="1.7" /></g></>),
  fitView: (<><path d="M4 9.5v-5h5M20 9.5v-5h-5M4 14.5v5h5M20 14.5v5h-5" /></>),
  proxies: (<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7.5 5v14M16.5 5v14M3 9.7h4.5M3 14.3h4.5M16.5 9.7H21M16.5 14.3H21" /></>),
  addVideo: (<><rect x="2.5" y="7.5" width="13.5" height="11" rx="2" /><path d="M7.8 10.6v4.8l4-2.4z" fill="currentColor" stroke="none" /><path d="M19.3 3.5v6M16.3 6.5h6" /></>),
  addAudio: (<><path d="M3.5 10.2v3.6M6.8 7.8v8.4M10.1 5.2v13.6M13.4 8.6v6.8" /><path d="M19.3 3.5v6M16.3 6.5h6" /></>),
  addClip: (<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M12 9v6M9 12h6" /></>),
  importAudio: (<><path d="M12 3.5v9" /><path d="m8 8.5 4 4 4-4" /><path d="M4 15.5v3A1.5 1.5 0 0 0 5.5 20h13A1.5 1.5 0 0 0 20 18.5v-3" /></>),
  fitTotal: (<><path d="M4 15.5h16" /><path d="m7.2 13.1-3 2.4 3 2.4M16.8 13.1l3 2.4-3 2.4" /><path d="M8 15.5V11M12 15.5V9.5M16 15.5V11" /></>),
};

function TlIcon({ name }: { name: string }) {
  return (
    <svg
      className="prod-tl-icon"
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {TL_ICONS[name]}
    </svg>
  );
}

/** mm:ss:ff timecode on the timeline frame grid. */
function fmtTc(sec: number, fps: number): string {
  const frames = Math.max(0, Math.round(sec * fps));
  const ff = frames % fps;
  const totalSec = Math.floor(frames / fps);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}:${String(ff).padStart(2, "0")}`;
}

/** Media URL whose #t= fragment makes a <video> show the frame at `sec`. */
function stillAt(prodId: string, rel: string, sec: number): string {
  return `cascade-media://${prodId}/${encodeURIComponent(rel)}#t=${Math.max(0, sec).toFixed(3)}`;
}

interface Peaks {
  mins: Float32Array;
  maxs: Float32Array;
  bucketSec: number;
  durationSec: number;
}
/** Decoded waveform peaks per source rel, decoded once (module cache). */
const peaksCache = new Map<string, Peaks>();

type GestureKind = "move" | "trim-head" | "trim-tail" | "roll" | "slip" | "playhead" | "marquee" | "ramp-kf" | "vol" | "fade-in" | "fade-out";
interface Gesture {
  kind: GestureKind;
  clipId?: string;
  /** Ramp keyframe drags: which keyframe, and the clip's rect at grab. */
  kfIndex?: number;
  kfRectTop?: number;
  kfRectH?: number;
  /** For roll from a head edge: the left neighbor whose boundary rolls. */
  rollLeftId?: string;
  /** Playhead gestures that STARTED on the ruler
   *  stay scrubs for the whole drag — they never promote to a
   *  marquee, however far the cursor roams (Batch Item 5). A press
   *  inside a track is always a box select, even on the playhead line. */
  scrubLocked?: boolean;
  startX: number;
  startY: number;
  orig: ProductionTimeline;
  moved: boolean;
}

export function TimelineEditor({
  prodId,
  production,
  onTimelineChange,
  proxyBySrc = {},
  onGenerateProxies,
  onImportAudio,
  playheadSec,
  onSeek,
  loopRegion: loopRegionProp,
  onLoopRegionChange,
}: {
  prodId: string;
  production: Production;
  onTimelineChange: (timeline: ProductionTimeline) => void;
  /** Ready proxies (source rel → proxy rel); filmstrips prefer them. */
  proxyBySrc?: Readonly<Record<string, string>>;
  /** Kick off proxy generation (whole timeline when no rels given). */
  onGenerateProxies?: (srcRels?: string[]) => Promise<void>;
  /** Controlled playhead (seconds) shared with the preview above. When
   *  present, the editor renders this position and reports seeks through
   *  `onSeek` instead of owning the state. */
  playheadSec?: number;
  onSeek?: (sec: number) => void;
  /** Pick + copy an audio file into the production (main process);
   *  the editor places the result as an audio-track clip. */
  onImportAudio?: () => Promise<{ rel: string; name: string; durationSec: number | null } | null>;
  /** Loop region (In/Out + Loop toggle) shared with the preview
   *  transport, which does the wrapping. Uncontrolled fallback keeps
   *  the editor self-contained in tests. */
  loopRegion?: TimelineLoopRegion;
  onLoopRegionChange?: (region: TimelineLoopRegion) => void;
}) {
  const fps = Math.max(1, Math.round(production.assembly?.fps ?? 24));
  const q = useCallback((sec: number): number => Math.round(sec * fps) / fps, [fps]);

  // Effective timeline: the persisted one when present; otherwise a seed
  // derived once from the shot projection (materialized on first edit).
  const [seededTimeline] = useState<ProductionTimeline>(
    () => production.timeline ?? seedTimelineFromProduction(production, uid)
  );
  const persisted = production.timeline ?? seededTimeline;
  const [preview, setPreview] = useState<ProductionTimeline | null>(null);
  const timeline = preview ?? persisted;
  const timelineRef = useRef(timeline);
  timelineRef.current = persisted;

  const [internalPlayhead, setInternalPlayhead] = useState(0);
  const playhead = playheadSec ?? internalPlayhead;
  const setPlayhead = useCallback(
    (sec: number) => {
      if (onSeek) onSeek(sec);
      else setInternalPlayhead(sec);
    },
    [onSeek]
  );
  const [internalLoop, setInternalLoop] = useState<TimelineLoopRegion>(EMPTY_LOOP_REGION);
  const loopRegion = loopRegionProp ?? internalLoop;
  const setLoopRegion = useCallback(
    (region: TimelineLoopRegion) => {
      if (onLoopRegionChange) onLoopRegionChange(region);
      else setInternalLoop(region);
    },
    [onLoopRegionChange]
  );
  const activeLoopSpan = loopSpan(loopRegion);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [snapOn, setSnapOn] = useState(true);
  const [rippleOn, setRippleOn] = useState(false);
  const [rippleScope, setRippleScope] = useState<"all" | "track">("all");
  const [zoom, setZoom] = useState(1);
  // Track-header panel width (drag-resizable, remembered across sessions).
  const [headerW, setHeaderW] = usePersistedNumber(HEADER_W_KEY, HEADER_W, { min: HEADER_W_MIN, max: HEADER_W_MAX });
  const headerResizeRef = useRef<{ startX: number; startW: number; curW: number } | null>(null);
  const [viewportW, setViewportW] = useState(0);
  const [historyTick, setHistoryTick] = useState(0);
  const [addShotId, setAddShotId] = useState("");
  /** Length field draft (mm:ss); null = display the current length. */
  const [lenDraft, setLenDraft] = useState<string | null>(null);
  const [activeKf, setActiveKf] = useState<{ clipId: string; atSec: number } | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const historyRef = useRef(createUndoHistory<ProductionTimeline>({ limit: 100, coalesceMs: 0 }));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lanesRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const hasAvSelection = timeline.clips.some(
    (c) => selected.has(c.id) && (c.sourceKind === "video" || c.sourceKind === "audio")
  );
  const selectedClipHasCurve = timeline.clips.some((c) => selected.has(c.id) && !!c.speedCurve?.length);
  const selectedInterp = timeline.clips.find((c) => selected.has(c.id))?.speedInterp ?? "sample";
  const firstAvSelected = timeline.clips.find((c) => selected.has(c.id) && (c.sourceKind === "video" || c.sourceKind === "audio"));
  const selectedPitchNatural = firstAvSelected?.pitchMode === "natural";
  const selectedMuted = !!firstAvSelected?.muted;
  const selectedSped = !!firstAvSelected && (!!firstAvSelected.speedCurve?.length || clipSpeed(firstAvSelected) !== 1);

  const resolved = useMemo(() => resolveTimeline(timeline), [timeline]);
  const total = Math.max(resolved.totalSec, 1);
  const fitPps = viewportW > 0 ? viewportW / total : 40;
  const pps = fitPps * zoom;
  const contentW = Math.max(viewportW, Math.ceil((total + 5) * pps));

  // Prune selection to clips that still exist.
  useEffect(() => {
    setSelected((prev) => {
      const alive = new Set(timeline.clips.map((c) => c.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [timeline]);

  // Measure the lanes viewport (fit scale), like the animatic strip.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth));
    ro.observe(el);
    setViewportW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // ---- source probes: real clip durations + waveform peaks -----------------
  const [probedSec, setProbedSec] = useState<Record<string, number>>({});
  const [peaksByRel, setPeaksByRel] = useState<ReadonlyMap<string, Peaks>>(() => new Map());
  const videoRels = useMemo(
    () => [...new Set(timeline.clips.filter((c) => c.sourceKind === "video" && c.srcRel).map((c) => c.srcRel!))].sort().join("|"),
    [timeline]
  );
  useEffect(() => {
    if (!videoRels) return;
    let cancelled = false;
    const pending: HTMLVideoElement[] = [];
    for (const rel of videoRels.split("|")) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      pending.push(v);
      v.onloadedmetadata = () => {
        const sec = v.duration;
        try { v.removeAttribute("src"); v.load(); } catch { /* already gone */ }
        if (cancelled || !Number.isFinite(sec) || sec <= 0) return;
        setProbedSec((prev) => (prev[rel] != null ? prev : { ...prev, [rel]: sec }));
      };
      v.onerror = () => { try { v.removeAttribute("src"); v.load(); } catch { /* no marker */ } };
      v.src = cascadeMedia(prodId, rel);
    }
    return () => {
      cancelled = true;
      for (const v of pending) {
        v.onloadedmetadata = null;
        v.onerror = null;
        try { v.removeAttribute("src"); v.load(); } catch { /* noop */ }
      }
    };
  }, [prodId, videoRels]);

  const audioRels = useMemo(
    () => [...new Set(timeline.clips.filter((c) => c.sourceKind === "audio" && c.srcRel).map((c) => c.srcRel!))].sort().join("|"),
    [timeline]
  );
  useEffect(() => {
    if (!audioRels) return;
    let cancelled = false;
    for (const rel of audioRels.split("|")) {
      if (peaksCache.has(rel)) {
        setPeaksByRel((prev) => (prev.has(rel) ? prev : new Map(prev).set(rel, peaksCache.get(rel)!)));
        continue;
      }
      void (async () => {
        try {
          const resp = await fetch(cascadeMedia(prodId, rel));
          const ab = await resp.arrayBuffer();
          const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          const ctx = new Ctor();
          const buf = await ctx.decodeAudioData(ab.slice(0));
          await ctx.close().catch(() => {});
          const ch = buf.getChannelData(0);
          const targetBuckets = Math.min(32768, Math.max(64, Math.ceil(buf.duration * 640)));
          const per = Math.max(1, Math.floor(ch.length / targetBuckets));
          const nB = Math.ceil(ch.length / per);
          const mins = new Float32Array(nB);
          const maxs = new Float32Array(nB);
          for (let b = 0; b < nB; b++) {
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
          const peaks: Peaks = { mins, maxs, bucketSec: per / buf.sampleRate, durationSec: buf.duration };
          if (peaksCache.size > 24) peaksCache.clear();
          peaksCache.set(rel, peaks);
          if (!cancelled) {
            setPeaksByRel((prev) => new Map(prev).set(rel, peaks));
            setProbedSec((prev) => (prev[rel] != null ? prev : { ...prev, [rel]: buf.duration }));
          }
        } catch { /* waveform stays empty; edits still work */ }
      })();
    }
    return () => { cancelled = true; };
  }, [prodId, audioRels]);

  /** Source durations for the ops, keyed the way TimelineEditOpts expects. */
  const editOpts = useCallback((): TimelineEditOpts => {
    const sourceDurationsSec: Record<string, number> = {};
    for (const c of timelineRef.current.clips) {
      if (c.srcRel && probedSec[c.srcRel] != null) sourceDurationsSec[c.mediaId ?? c.srcRel] = probedSec[c.srcRel];
    }
    return { sourceDurationsSec, ...(rippleOn ? { ripple: rippleScope } : {}) };
  }, [probedSec, rippleOn, rippleScope]);

  // ---- commit / undo ---------------------------------------------------------
  const commit = useCallback((next: ProductionTimeline | null) => {
    if (!next || next === timelineRef.current) return;
    historyRef.current.push(timelineRef.current, { force: true });
    setHistoryTick((n) => n + 1);
    onTimelineChange(next);
  }, [onTimelineChange]);

  // Track volume slider: apply LIVE while dragging / arrow-keying so
  // the monitor's level follows the thumb (committing only on
  // release read as "the slider does nothing"; keyboard steps never
  // fired pointerup at all). One history entry per gesture; commits
  // throttled so a drag doesn't whole-document-save every pixel.
  const [volDraft, setVolDraft] = useState<{ trackId: string; pct: number } | null>(null);
  const volLiveRef = useRef<{ trackId: string; base: ProductionTimeline; pendingPct: number; lastAt: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const applyTrackVolume = useCallback((trackId: string, pct: number) => {
    const g = volLiveRef.current;
    const base = g && g.trackId === trackId ? g.base : timelineRef.current;
    onTimelineChange(setTrackVolume(base, trackId, pct / 100));
  }, [onTimelineChange]);
  const onTrackVolumeInput = useCallback((trackId: string, pct: number) => {
    setVolDraft({ trackId, pct });
    let g = volLiveRef.current;
    if (!g || g.trackId !== trackId) {
      historyRef.current.push(timelineRef.current, { force: true });
      setHistoryTick((n) => n + 1);
      g = { trackId, base: timelineRef.current, pendingPct: pct, lastAt: 0, timer: null };
      volLiveRef.current = g;
    }
    g.pendingPct = pct;
    const now = Date.now();
    if (now - g.lastAt >= 150) {
      g.lastAt = now;
      applyTrackVolume(trackId, pct);
    } else if (!g.timer) {
      g.timer = setTimeout(() => {
        const live = volLiveRef.current;
        if (!live) return;
        live.timer = null;
        live.lastAt = Date.now();
        applyTrackVolume(live.trackId, live.pendingPct);
      }, 150);
    }
  }, [applyTrackVolume]);
  const endTrackVolumeGesture = useCallback((trackId: string) => {
    const g = volLiveRef.current;
    if (g?.timer) clearTimeout(g.timer);
    if (g && g.trackId === trackId) applyTrackVolume(trackId, g.pendingPct);
    volLiveRef.current = null;
    setVolDraft((d) => (d?.trackId === trackId ? null : d));
  }, [applyTrackVolume]);
  const undo = useCallback(() => {
    const prev = historyRef.current.undo(timelineRef.current);
    if (prev) {
      setHistoryTick((n) => n + 1);
      onTimelineChange(prev);
    }
  }, [onTimelineChange]);
  const redo = useCallback(() => {
    const next = historyRef.current.redo(timelineRef.current);
    if (next) {
      setHistoryTick((n) => n + 1);
      onTimelineChange(next);
    }
  }, [onTimelineChange]);
  void historyTick;
  const canUndo = historyRef.current.canUndo();
  const canRedo = historyRef.current.canRedo();

  // ---- snapping ---------------------------------------------------------------
  /** Snap points: 0, the playhead, and every clip edge on every track
   *  (markers join this list when the model grows them). */
  const snapPoints = useCallback((t: ProductionTimeline, excludeIds: ReadonlySet<string>): number[] => {
    const pts = new Set<number>([0, playhead]);
    for (const c of t.clips) {
      if (excludeIds.has(c.id)) continue;
      pts.add(c.timelineStartSec);
      pts.add(clipEndSec(c));
    }
    return [...pts];
  }, [playhead]);
  /** Snap a candidate time to the nearest point within SNAP_PX (frame grid
   *  always applies; with snapping off the value lands exactly as dragged). */
  const snapTime = useCallback((t: ProductionTimeline, candidate: number, excludeIds: ReadonlySet<string>): number => {
    const base = q(candidate);
    if (!snapOn || pps <= 0) return base;
    let best = base;
    let bestDist = SNAP_PX / pps;
    for (const p of snapPoints(t, excludeIds)) {
      const d = Math.abs(p - candidate);
      if (d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    return best;
  }, [q, snapOn, pps, snapPoints]);

  // ---- gesture application: preview = op(orig) on every move ------------------
  const timeAtClientX = useCallback((clientX: number): number => {
    const el = lanesRef.current;
    if (!el || pps <= 0) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left) / pps);
  }, [pps]);
  const trackAtClientY = useCallback((clientY: number): TimelineTrack | undefined => {
    const el = lanesRef.current;
    if (!el) return undefined;
    const r = el.getBoundingClientRect();
    let y = clientY - r.top - RULER_H;
    for (const track of timelineRef.current.tracks) {
      const h = rowH(track);
      if (y >= 0 && y < h) return track;
      y -= h;
    }
    return undefined;
  }, []);

  /** Interactive curve set with a fit clamp: the op refuses a curve
   *  that would lengthen the clip into its neighbor (constant-speed
   *  sets clamp instead); bisect the edited keyframe's speed toward
   *  its current value so the drag stops at the fit boundary instead
   *  of feeling dead. Returns null only when even the current speed
   *  (at the new time) does not fit. */
  const curveOrClamped = useCallback((
    t: ProductionTimeline,
    clipId: string,
    curve: SpeedKeyframe[],
    kfIndex: number,
    fromSpeed: number,
    opts: TimelineEditOpts
  ): ProductionTimeline | null => {
    const direct = setClipSpeedCurve(t, [clipId], curve, opts);
    if (direct) return direct;
    const target = curve[kfIndex];
    if (!target || target.speed === fromSpeed) return null;
    let lo = fromSpeed;
    let hi = target.speed;
    let best: ProductionTimeline | null = null;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      const trial = curve.map((k, j) => (j === kfIndex ? { ...k, speed: mid } : k));
      const r = setClipSpeedCurve(t, [clipId], trial, opts);
      if (r) {
        best = r;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return best;
  }, []);

  const applyGesture = useCallback((g: Gesture, clientX: number, clientY: number): ProductionTimeline | null => {
    const orig = g.orig;
    const opts = editOpts();
    const dxSec = pps > 0 ? (clientX - g.startX) / pps : 0;
    if (g.kind === "playhead" || g.kind === "marquee" || !g.clipId) return null;
    const clip = orig.clips.find((c) => c.id === g.clipId);
    if (!clip) return null;
    if (g.kind === "ramp-kf") {
      const curve = clip.speedCurve;
      if (!curve?.length || g.kfIndex == null || !curve[g.kfIndex]) return null;
      const kf = curve[g.kfIndex];
      const prevAt = g.kfIndex > 0 ? curve[g.kfIndex - 1].atSec : 0;
      const nextAt = g.kfIndex + 1 < curve.length ? curve[g.kfIndex + 1].atSec : clipDurationSec(clip);
      const newAt = Math.max(prevAt + (g.kfIndex > 0 ? 1 / fps : 0), Math.min(nextAt - 1 / fps, q(kf.atSec + dxSec)));
      const rectH = g.kfRectH && g.kfRectH > 0 ? g.kfRectH : VIDEO_ROW_H;
      const newSpeed = rampSpeedForY((clientY - (g.kfRectTop ?? 0)) / rectH);
      const nextCurve = curve.map((k, i) => (i === g.kfIndex ? { atSec: newAt, speed: newSpeed } : k));
      return curveOrClamped(orig, clip.id, nextCurve, g.kfIndex, kf.speed, opts);
    }
    if (g.kind === "vol") {
      // Volume line: vertical position maps linearly to 0..1 gain.
      const rectH = g.kfRectH && g.kfRectH > 0 ? g.kfRectH : AUDIO_ROW_H;
      const frac = 1 - (clientY - (g.kfRectTop ?? 0)) / rectH;
      return setClipAudio(orig, [clip.id], { volume: Math.max(0, Math.min(1, frac)) }, opts);
    }
    if (g.kind === "fade-in" || g.kind === "fade-out") {
      // Fade handles: drag in from the clip corner. Frame-quantized;
      // the op clamps so in+out fit the clip.
      const dur = clipDurationSec(clip);
      if (g.kind === "fade-in") {
        const next = Math.max(0, Math.min(dur, q((clip.fadeInSec ?? 0) + dxSec)));
        return setClipAudio(orig, [clip.id], { fadeInSec: next }, opts);
      }
      const next = Math.max(0, Math.min(dur, q((clip.fadeOutSec ?? 0) - dxSec)));
      return setClipAudio(orig, [clip.id], { fadeOutSec: next }, opts);
    }
    if (g.kind === "slip") {
      const inSec = clip.sourceInSec ?? 0;
      return slipClip(orig, clip.id, q(inSec - dxSec * clipSpeed(clip)) - inSec, opts);
    }
    if (g.kind === "trim-tail" || g.kind === "trim-head") {
      const edge = g.kind === "trim-tail" ? "tail" : "head";
      const edgeTime = edge === "tail" ? clipEndSec(clip) : clip.timelineStartSec;
      const snapped = snapTime(orig, edgeTime + dxSec, new Set([clip.id]));
      const dTime = snapped - edgeTime;
      // Duration delta: tail grows with +dTime; head grows with -dTime.
      return trimClip(orig, clip.id, edge, edge === "tail" ? dTime : -dTime, opts);
    }
    if (g.kind === "roll") {
      const boundaryClip = g.rollLeftId ? orig.clips.find((c) => c.id === g.rollLeftId) : clip;
      if (!boundaryClip) return null;
      const boundary = clipEndSec(boundaryClip);
      const snapped = snapTime(orig, boundary + dxSec, new Set([boundaryClip.id]));
      return rollEdit(orig, boundaryClip.id, snapped - boundary, opts);
    }
    // move (single-clip drag may also change track by row)
    const selection = selectedRef.current.has(clip.id) && selectedRef.current.size > 1
      ? [...selectedRef.current]
      : [clip.id];
    let work = orig;
    if (selection.length === 1) {
      const target = trackAtClientY(clientY);
      if (target && target.id !== clip.trackId) {
        work = moveClipToTrack(orig, clip.id, target.id) ?? orig;
      }
    }
    const exclude = new Set(selection);
    const snappedStart = snapTime(work, clip.timelineStartSec + dxSec, exclude);
    const snappedEnd = snapTime(work, clipEndSec(clip) + dxSec, exclude);
    // Prefer whichever of the clip's edges snapped (moved off the raw grid).
    const rawStart = q(clip.timelineStartSec + dxSec);
    const delta = snappedStart !== rawStart ? snappedStart - clip.timelineStartSec : snappedEnd - clipEndSec(clip);
    return moveClipsBy(work, selection, delta);
  }, [curveOrClamped, editOpts, fps, pps, q, snapTime, trackAtClientY]);

  /** Volume-line / fade-handle grabs (Item 7): same preview-via-op
   *  gesture machinery as trims, anchored to the clip's rect. */
  const startAudioGesture = (e: React.PointerEvent, clip: TimelineClip, kind: "vol" | "fade-in" | "fade-out") => {
    e.stopPropagation();
    e.preventDefault();
    if (pps <= 0 || e.button !== 0) return;
    if (timeline.tracks.find((x) => x.id === clip.trackId)?.locked) return;
    setSelected(new Set([clip.id]));
    const clipEl = (e.currentTarget as HTMLElement).closest(".prod-tl-clip") as HTMLElement | null;
    const rect = clipEl?.getBoundingClientRect();
    gestureRef.current = {
      kind, clipId: clip.id,
      kfRectTop: rect?.top ?? 0, kfRectH: rect?.height || AUDIO_ROW_H,
      startX: e.clientX, startY: e.clientY, orig: timelineRef.current, moved: false,
    };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* jsdom */ }
  };

  const onClipPointerDown = (e: React.PointerEvent, clip: TimelineClip, zone: "head" | "tail" | "body") => {
    if (pps <= 0) return;
    const track = timeline.tracks.find((x) => x.id === clip.trackId);
    if (track?.locked) return;
    let kind: GestureKind;
    let rollLeftId: string | undefined;
    if (e.button === 2) {
      kind = "slip";
    } else if (e.button === 0 && zone !== "body" && e.altKey) {
      kind = "roll";
      if (zone === "head") {
        const sorted = timeline.clips.filter((c) => c.trackId === clip.trackId).sort((a, b) => a.timelineStartSec - b.timelineStartSec);
        const idx = sorted.findIndex((c) => c.id === clip.id);
        rollLeftId = idx > 0 ? sorted[idx - 1].id : undefined;
        if (!rollLeftId) return;
      }
    } else if (e.button === 0 && zone === "head") kind = "trim-head";
    else if (e.button === 0 && zone === "tail") kind = "trim-tail";
    else if (e.button === 0) kind = "move";
    else return;
    // Selection: plain click selects just this clip (a drag of an
    // already-selected clip keeps the multi-selection); shift toggles.
    if (e.button === 0) {
      if (e.shiftKey) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(clip.id)) next.delete(clip.id);
          else next.add(clip.id);
          return next;
        });
      } else if (!selectedRef.current.has(clip.id)) {
        setSelected(new Set(linkedClipIds(timeline, clip.id)));
      }
    }
    gestureRef.current = { kind, clipId: clip.id, rollLeftId, startX: e.clientX, startY: e.clientY, orig: timelineRef.current, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };

  const onLanesPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Background press: where it STARTS decides the whole gesture.
    // On the ruler it is a scrub until
    // release (Item 5). Inside a track it is a box select from the
    // first pixel -- it never seeks, however the drag travels.
    const rect = lanesRef.current?.getBoundingClientRect();
    // Only the vertical start decides: ruler scrubs, tracks box-select.
    const localY = rect ? e.clientY - rect.top : 0;
    const scrubLocked = localY < RULER_H;
    gestureRef.current = { kind: scrubLocked ? "playhead" : "marquee", scrubLocked, startX: e.clientX, startY: e.clientY, orig: timelineRef.current, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (scrubLocked) setPlayhead(q(timeAtClientX(e.clientX)));
    e.preventDefault();
  };

  const onEditorPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    if (Math.abs(e.clientX - g.startX) + Math.abs(e.clientY - g.startY) > 3) g.moved = true;
    if (g.kind === "playhead") {
      setPlayhead(q(timeAtClientX(e.clientX)));
      return;
    }
    if (g.kind === "marquee") {
      const el = lanesRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setMarquee({ x0: g.startX - r.left, y0: g.startY - r.top - RULER_H, x1: e.clientX - r.left, y1: e.clientY - r.top - RULER_H });
      return;
    }
    if (!g.moved) return;
    setPreview(applyGesture(g, e.clientX, e.clientY));
  };

  const onEditorPointerUp = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (g.kind === "marquee") {
      if (!marquee) {
        if (!g.moved) setSelected(new Set());
        setMarquee(null);
        return;
      }
      const t0 = Math.min(marquee.x0, marquee.x1) / pps;
      const t1 = Math.max(marquee.x0, marquee.x1) / pps;
      let y = 0;
      const hits = new Set<string>();
      for (const track of timeline.tracks) {
        const h = rowH(track);
        const rowHit = Math.max(marquee.y0, marquee.y1) >= y && Math.min(marquee.y0, marquee.y1) <= y + h;
        if (rowHit) {
          for (const c of timeline.clips) {
            if (c.trackId === track.id && clipEndSec(c) > t0 && c.timelineStartSec < t1) hits.add(c.id);
          }
        }
        y += h;
      }
      setSelected(hits);
      setMarquee(null);
      return;
    }
    setMarquee(null);
    if (g.kind === "playhead") {
      if (!g.moved) setSelected(new Set());
      return;
    }
    if (g.moved) {
      const final = applyGesture(g, e.clientX, e.clientY);
      if (final) {
        commit(final);
        if (g.kind === "ramp-kf" && g.clipId && g.kfIndex != null) {
          const kf = final.clips.find((c) => c.id === g.clipId)?.speedCurve?.[g.kfIndex];
          if (kf) setActiveKf({ clipId: g.clipId, atSec: kf.atSec });
        }
      }
    }
    setPreview(null);
  };

  // ---- commands -----------------------------------------------------------------
  const doSplitAtPlayhead = useCallback(() => {
    const t = timelineRef.current;
    const sel = [...selectedRef.current];
    if (sel.length) {
      let work: ProductionTimeline | null = t;
      for (const id of sel) {
        work = splitClipAt(work, id, playhead, uid, editOpts()) ?? work;
      }
      if (work !== t) commit(work);
      return;
    }
    commit(splitAtPlayhead(t, playhead, uid));
  }, [commit, editOpts, playhead]);

  const doDeleteSelected = useCallback(() => {
    const sel = [...selectedRef.current];
    if (!sel.length) return;
    commit(deleteClips(timelineRef.current, sel, editOpts()));
  }, [commit, editOpts]);

  const onEditorKeyDown = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    } else if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      doDeleteSelected();
    } else if (!mod && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      doSplitAtPlayhead();
    } else if (!mod && (e.code === "KeyI" || e.key === "i" || e.key === "I")) {
      // I marks the loop In point at the playhead; Alt+I clears it.
      e.preventDefault();
      setLoopRegion(withLoopPoint(loopRegion, "in", e.altKey ? null : q(playhead)));
    } else if (!mod && (e.code === "KeyO" || e.key === "o" || e.key === "O")) {
      // O marks the loop Out point at the playhead; Alt+O clears it.
      e.preventDefault();
      setLoopRegion(withLoopPoint(loopRegion, "out", e.altKey ? null : q(playhead)));
    }
  };

  /** Shots with timeline-usable media, for the add-clip picker. */
  const addableShots = useMemo(() => {
    const out: { shotId: string; label: string; kind: "video" | "still"; rel: string; durSec: number; offsetSec: number }[] = [];
    for (const scene of production.scenes) {
      for (const shot of scene.shots) {
        if (shot.disabled) continue;
        const display = resolveShotDisplay(shot);
        if (!display.path || display.media === "none") continue;
        out.push({
          shotId: shot.id,
          label: `${shot.number} · ${display.media === "clip" ? "video" : "still"}`,
          kind: display.media === "clip" ? "video" : "still",
          rel: display.path,
          durSec: shot.durationSec ?? 3,
          offsetSec: shot.videoOffsetSec ?? 0,
        });
      }
    }
    return out;
  }, [production.scenes]);

  const doAddClipFromShot = () => {
    const shot = addableShots.find((s) => s.shotId === addShotId) ?? addableShots[0];
    if (!shot) return;
    const t = timelineRef.current;
    const track = t.tracks.find((x) => x.kind === "video" && !x.locked);
    if (!track) return;
    const onTrack = t.clips.filter((c) => c.trackId === track.id);
    const overlaps = (start: number, end: number) => onTrack.some((c) => c.timelineStartSec < end && start < clipEndSec(c));
    let start = q(playhead);
    if (overlaps(start, start + shot.durSec)) {
      start = onTrack.reduce((m, c) => Math.max(m, clipEndSec(c)), 0);
    }
    const mediaId = production.media?.find((m) => m.path === shot.rel)?.id;
    const clip: TimelineClip = shot.kind === "video"
      ? {
          id: uid("clp"), trackId: track.id, sourceKind: "video", srcRel: shot.rel,
          ...(mediaId ? { mediaId } : {}),
          sourceInSec: shot.offsetSec, sourceOutSec: shot.offsetSec + shot.durSec,
          timelineStartSec: start, shotId: shot.shotId,
        }
      : {
          id: uid("clp"), trackId: track.id, sourceKind: "still", srcRel: shot.rel,
          ...(mediaId ? { mediaId } : {}),
          holdSec: shot.durSec, timelineStartSec: start, shotId: shot.shotId,
        };
    commit({ ...t, clips: [...t.clips, clip] });
    setSelected(new Set([clip.id]));
  };

  /** Import audio (Item 2): main picks + copies + probes the file;
   *  placement is the shared op (playhead slot on an audio track, else
   *  track end, else a new track). Falls back to <audio> metadata when
   *  the probe could not read a duration. */
  const doImportAudio = async () => {
    if (!onImportAudio) return;
    const picked = await onImportAudio();
    if (!picked) return;
    let dur = picked.durationSec ?? 0;
    if (!(dur > 0)) {
      dur = await new Promise<number>((resolve) => {
        const el = new Audio();
        const done = (v: number) => { el.removeAttribute("src"); resolve(v); };
        el.preload = "metadata";
        el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : 0);
        el.onerror = () => done(0);
        window.setTimeout(() => done(0), 4000);
        el.src = cascadeMedia(prodId, picked.rel);
      });
    }
    if (!(dur > 0)) return;
    const mediaId = production.media?.find((m) => m.path === picked.rel)?.id;
    const { timeline: next, clipId } = addImportedAudioClip(
      timelineRef.current,
      { srcRel: picked.rel, name: picked.name, durationSec: dur, mediaId },
      q(playhead),
      () => uid("clp")
    );
    if (!clipId) return;
    commit(next);
    setSelected(new Set([clipId]));
  };

  const doAddTrack = (kind: "video" | "audio") => {
    const t = timelineRef.current;
    const n = t.tracks.filter((x) => x.kind === kind).length + 1;
    commit(addTrack(t, { id: uid("trk"), kind, name: kind === "video" ? `V${n}` : `A${n}` }));
  };

  // Wheel zoom anchored on the cursor (native, non-passive like the strip).
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const wrap = scrollRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaY || e.deltaX) return;
      e.preventDefault();
      const next = Math.max(0.25, Math.min(40, zoomRef.current * Math.exp(-e.deltaY * 0.0016)));
      if (next === zoomRef.current) return;
      const cursorInViewport = e.clientX - wrap.getBoundingClientRect().left;
      const ratio = next / zoomRef.current;
      const newScroll = Math.max(0, (wrap.scrollLeft + cursorInViewport) * ratio - cursorInViewport);
      zoomRef.current = next;
      setZoom(next);
      window.requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollLeft = newScroll;
      });
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, []);

  // ---- render -------------------------------------------------------------------
  const tickStep = pps >= 80 ? 1 : pps >= 30 ? 2 : pps >= 12 ? 5 : 10;
  const ticks: number[] = [];
  for (let s = 0; s <= total + 5; s += tickStep) ticks.push(s);

  const renderClipMedia = (clip: TimelineClip, widthPx: number) => {
    if (clip.sourceKind === "blank" || !clip.srcRel) {
      return <div className="prod-tl-clip-slate">SLATE</div>;
    }
    if (clip.sourceKind === "still") {
      return <img className="prod-tl-clip-still" src={cascadeMedia(prodId, clip.srcRel)} alt="" draggable={false} />;
    }
    if (clip.sourceKind === "audio") {
      return (
        <WaveformCanvas
          peaks={peaksByRel.get(clip.srcRel)}
          inSec={clip.sourceInSec ?? 0}
          outSec={clip.sourceOutSec ?? 0}
          widthPx={widthPx}
        />
      );
    }
    // Filmstrip: stills sampled at the frames playback actually shows
    // (speed/ramp/reverse mapping via the shared timing code).
    const durHere = clipDurationSec(clip);
    const frames = Math.max(1, Math.min(8, Math.round(widthPx / 56)));
    return (
      <div className="prod-tl-filmstrip" aria-hidden="true">
        {Array.from({ length: frames }, (_, i) => {
          const local = frames === 1 ? 0 : (i / (frames - 1)) * Math.max(0, durHere - 0.05);
          const at = clipSourceTimeAt(clip, local);
          return (
            <video
              key={i}
              className="prod-tl-filmframe"
              src={stillAt(prodId, (clip.srcRel && proxyBySrc[clip.srcRel]) || clip.srcRel!, at)}
              preload="metadata"
              muted
              playsInline
              disablePictureInPicture
              tabIndex={-1}
            />
          );
        })}
      </div>
    );
  };

  const dissolveTarget = firstAvSelected && timeline.tracks.find((x) => x.id === firstAvSelected.trackId)?.kind === "video" ? firstAvSelected : undefined;
  const dissolveCurrent = dissolveTarget ? transitionFor(timeline, dissolveTarget.id) : undefined;
  const dissolveMax = dissolveTarget ? maxDissolveSec(timeline, dissolveTarget.id, editOpts()) : 0;

  return (
    <div
      className="prod-tl-editor"
      data-testid="timeline-editor"
      data-pps={pps}
      tabIndex={0}
      role="application"
      aria-label="Multi-track timeline editor"
      onKeyDown={onEditorKeyDown}
      onPointerMove={onEditorPointerMove}
      onPointerUp={onEditorPointerUp}
      onPointerCancel={onEditorPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="prod-tl-toolbar" role="toolbar" aria-label="Timeline tools">
        <span className="prod-tl-group" role="group" aria-label="Editing actions">
          <button className="prod-tl-icon-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><TlIcon name="undo" /></button>
          <button className="prod-tl-icon-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><TlIcon name="redo" /></button>
          <button className="prod-tl-icon-btn" onClick={doSplitAtPlayhead} title="Split at playhead (S)" aria-label="Split at playhead"><TlIcon name="split" /></button>
          <button className="prod-tl-icon-btn" onClick={doDeleteSelected} disabled={!selected.size} title="Delete selected (Delete)" aria-label="Delete selected"><TlIcon name="delete" /></button>
          <button className={snapOn ? "active" : ""} aria-pressed={snapOn} onClick={() => setSnapOn((v) => !v)} title={`Snap: ${snapOn ? "on" : "off"} — snap drags to the playhead and clip edges`}>Snap</button>
          <button className={rippleOn ? "active" : ""} aria-pressed={rippleOn} onClick={() => setRippleOn((v) => !v)} title={`Ripple: ${rippleOn ? "on" : "off"} — trims and deletes shift following clips`}>Ripple</button>
          <select
            className="prod-tl-scope"
            value={rippleScope}
            onChange={(e) => setRippleScope(e.target.value as "all" | "track")}
            title="Ripple scope"
            aria-label="Ripple scope"
          >
            <option value="all">All tracks</option>
            <option value="track">This track</option>
          </select>
          <select
            className="prod-tl-dissolve"
            disabled={!dissolveTarget || (dissolveMax <= 0 && !dissolveCurrent)}
            value={dissolveCurrent ? String(dissolveCurrent.durationSec) : "0"}
            title={!dissolveTarget
              ? "Cut / dissolve — select a video clip to set the transition into the next clip"
              : dissolveMax <= 0 && !dissolveCurrent
                ? "Cut / dissolve — no dissolve fits here: the clips are not adjacent, or the source handles (material before/after the cut) are too short"
                : `Cut / dissolve — cross-dissolve into the next clip, centered on the cut (max ${dissolveMax.toFixed(2)}s from the available handles; longer picks clamp)`}
            aria-label="Cross-dissolve into next clip"
            onChange={(e) => {
              if (!dissolveTarget) return;
              const v = Number(e.target.value);
              if (!(v > 0)) {
                commit(setClipTransition(timelineRef.current, dissolveTarget.id, null, uid, editOpts()));
              } else {
                commit(setClipTransition(timelineRef.current, dissolveTarget.id, Math.min(v, dissolveMax), uid, editOpts()));
              }
            }}
          >
            <option value="0">Cut</option>
            {[0.5, 1, 2].map((s) => (
              <option key={s} value={s}>Dissolve {s}s</option>
            ))}
            {dissolveCurrent && ![0.5, 1, 2].includes(dissolveCurrent.durationSec) && (
              <option value={String(dissolveCurrent.durationSec)}>Dissolve {dissolveCurrent.durationSec.toFixed(2)}s</option>
            )}
          </select>
        </span>
        <span className="prod-tl-sep" />
        <span className="prod-tl-group" role="group" aria-label="Speed">
        <select
          className="prod-tl-speed"
          defaultValue=""
          disabled={!hasAvSelection}
          title="Set constant speed on the selected clip(s)"
          aria-label="Clip speed"
          onChange={(e) => {
            const v = Number(e.target.value);
            e.target.value = "";
            if (!(v > 0)) return;
            // With an active ramp keyframe, the preset sets THAT keyframe.
            const ak = activeKf;
            const akClip = ak ? timelineRef.current.clips.find((c) => c.id === ak.clipId) : undefined;
            if (ak && akClip?.speedCurve?.some((k) => k.atSec === ak.atSec)) {
              const kfIndex = akClip.speedCurve.findIndex((k) => k.atSec === ak.atSec);
              commit(curveOrClamped(
                timelineRef.current,
                ak.clipId,
                akClip.speedCurve.map((k) => (k.atSec === ak.atSec ? { ...k, speed: v } : k)),
                kfIndex,
                akClip.speedCurve[kfIndex].speed,
                editOpts()
              ));
              return;
            }
            commit(setClipSpeed(timelineRef.current, [...selectedRef.current], { speed: v }, editOpts()));
          }}
        >
          <option value="">Speed…</option>
          {[0.25, 0.5, 1, 1.5, 2, 4].map((s) => (
            <option key={s} value={s}>{s}×</option>
          ))}
        </select>
        <button
          className="prod-tl-icon-btn"
          disabled={!hasAvSelection}
          title="Reverse — play the selected clip(s) in reverse"
          aria-label="Reverse"
          onClick={() => {
            const first = timelineRef.current.clips.find((c) => selectedRef.current.has(c.id) && (c.sourceKind === "video" || c.sourceKind === "audio"));
            commit(setClipSpeed(timelineRef.current, [...selectedRef.current], { reversed: !(first?.reversed ?? false) }, editOpts()));
          }}
        ><TlIcon name="reverse" /></button>
        <button
          className={selectedPitchNatural ? "active" : ""}
          disabled={!selectedSped}
          aria-pressed={selectedPitchNatural}
          title={selectedSped
            ? (selectedPitchNatural
              ? "Pitch shifts with speed on render (natural resample). Click to preserve pitch (time-stretch)."
              : "Pitch is preserved on render (time-stretch, the default). Click to let pitch shift naturally with speed.")
            : "Pitch handling applies to sped-up/slowed clips (preserved by default)"}
          onClick={() => commit(setClipAudio(timelineRef.current, [...selectedRef.current], { pitchMode: selectedPitchNatural ? "preserve" : "natural" }, editOpts()))}
        >{selectedPitchNatural ? "Pitch: shifted" : "Pitch: preserved"}</button>
        <button
          className={"prod-tl-icon-btn" + (selectedMuted ? " active" : "")}
          disabled={!hasAvSelection}
          aria-pressed={selectedMuted}
          aria-label={selectedMuted ? "Unmute clips" : "Mute clips"}
          title={selectedMuted ? "Unmute clips — unmute the selected clip(s)' audio" : "Mute clips — mute the selected clip(s)' audio (preview and render)"}
          onClick={() => commit(setClipAudio(timelineRef.current, [...selectedRef.current], { muted: !selectedMuted }, editOpts()))}
        ><TlIcon name={selectedMuted ? "speakerMuted" : "speaker"} /></button>
        <button
          className={"prod-tl-icon-btn" + (selectedClipHasCurve ? " active" : "")}
          disabled={!hasAvSelection}
          aria-label={selectedClipHasCurve ? "Clear ramp" : "Add ramp"}
          title={selectedClipHasCurve ? "Clear ramp — remove the speed ramp from the selected clip(s)" : "Add ramp — add a speed ramp (3 keyframes at the current speed); drag the dots, double-click a clip to add keyframes, Alt+click a dot to delete one"}
          onClick={() => {
            const t = timelineRef.current;
            const target = t.clips.find((c) => selectedRef.current.has(c.id) && (c.sourceKind === "video" || c.sourceKind === "audio"));
            if (!target) return;
            if (selectedClipHasCurve) {
              commit(setClipSpeedCurve(t, [...selectedRef.current], null, editOpts()));
              setActiveKf(null);
            } else {
              const cs = clipSpeed(target);
              const dur = clipDurationSec(target);
              commit(setClipSpeedCurve(t, [target.id], [
                { atSec: 0, speed: cs },
                { atSec: q(dur / 2), speed: cs },
                { atSec: q(dur), speed: cs },
              ], editOpts()));
            }
          }}
        ><TlIcon name="ramp" /></button>
        <select
          className="prod-tl-interp"
          disabled={!hasAvSelection}
          value={selectedInterp}
          title="Retime interpolation in the render: Sample is exact frame selection; Blend/Flow synthesize frames (slow renders)"
          aria-label="Retime interpolation"
          onChange={(e) => {
            const v = e.target.value as "sample" | "blend" | "flow";
            const next = structuredClone(timelineRef.current);
            for (const c of next.clips) {
              if (!selectedRef.current.has(c.id)) continue;
              if (v === "sample") delete c.speedInterp;
              else c.speedInterp = v;
            }
            commit(next);
          }}
        >
          <option value="sample">Sample</option>
          <option value="blend">Blend (slow)</option>
          <option value="flow">Flow (slow)</option>
        </select>
        </span>
        <span className="prod-tl-sep" />
        <span className="prod-tl-group" role="group" aria-label="Track and clip adding">
          <button
            className="prod-tl-icon-btn"
            disabled={!onGenerateProxies || proxyBusy}
            aria-label="Proxies"
            title={proxyBusy ? "Proxies — generating…" : "Proxies — generate 720p preview proxies for the timeline's video sources (background job; editing never waits — originals preview until proxies land)"}
            onClick={async () => {
              if (!onGenerateProxies) return;
              setProxyBusy(true);
              try { await onGenerateProxies(); } finally { setProxyBusy(false); }
            }}
          ><TlIcon name="proxies" /></button>
          <button className="prod-tl-icon-btn" onClick={() => doAddTrack("video")} title="Add video track" aria-label="Add video track"><TlIcon name="addVideo" /></button>
          <button className="prod-tl-icon-btn" onClick={() => doAddTrack("audio")} title="Add audio track" aria-label="Add audio track"><TlIcon name="addAudio" /></button>
          <select
            className="prod-tl-addshot"
            value={addShotId}
            onChange={(e) => setAddShotId(e.target.value)}
            title="Add clip from shot — shot media to place on the timeline"
            aria-label="Shot media to add"
          >
            <option value="">Add clip from shot…</option>
            {addableShots.map((s) => (
              <option key={s.shotId} value={s.shotId}>{s.label}</option>
            ))}
          </select>
          <button className="prod-tl-icon-btn" onClick={doAddClipFromShot} disabled={!addableShots.length} title="Add clip — place the chosen shot's media at the playhead on the first unlocked video track" aria-label="Add clip"><TlIcon name="addClip" /></button>
          <button className="prod-tl-icon-btn" onClick={() => void doImportAudio()} disabled={!onImportAudio} title="Import audio… — pick an audio file and place it as a clip on an audio track at the playhead" aria-label="Import audio"><TlIcon name="importAudio" /></button>
        </span>
        <span className="prod-tl-sep" />
        <span className="prod-tl-group" role="group" aria-label="View and fit">
          <button className="prod-tl-icon-btn" onClick={() => setZoom((z) => Math.max(0.25, z / 1.3))} title="Zoom out" aria-label="Zoom out">−</button>
          <button className="prod-tl-icon-btn" onClick={() => setZoom((z) => Math.min(40, z * 1.3))} title="Zoom in" aria-label="Zoom in">+</button>
          <button className="prod-tl-icon-btn" onClick={() => setZoom(1)} title="Fit — zoom to fit" aria-label="Zoom to fit"><TlIcon name="fitView" /></button>
          <button
            className={loopRegion.enabled ? "active" : ""}
            aria-pressed={loopRegion.enabled}
            onClick={() => setLoopRegion({ ...loopRegion, enabled: !loopRegion.enabled })}
            title={`Loop: ${loopRegion.enabled ? "on" : "off"} — with Loop on, playback repeats between the In point (I) and Out point (O) marked at the playhead. Alt+I / Alt+O clear the points`}
          >Loop</button>
          <input
            className="prod-tl-fit-total"
            type="text"
            inputMode="numeric"
            value={lenDraft ?? formatTimelineLength(resolved.totalSec)}
            onFocus={(e) => { setLenDraft(formatTimelineLength(resolved.totalSec)); e.target.select(); }}
            onChange={(e) => setLenDraft(e.target.value)}
            onBlur={() => setLenDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const parsed = parseTimelineLength(e.currentTarget.value);
                // Invalid input reverts to the current length.
                if (parsed != null) commit(setTimelineDuration(timelineRef.current, parsed));
                setLenDraft(null);
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                setLenDraft(null);
                e.currentTarget.blur();
              }
            }}
            title="Timeline length (minutes:seconds) — type a new length and press Enter. Longer adds empty space after the last clip; shorter stops at the last clip's end"
            aria-label="Timeline length"
          />
          <button
            className="prod-tl-icon-btn"
            disabled={parseTimelineLength(lenDraft ?? formatTimelineLength(resolved.totalSec)) == null}
            title="Fit total — rescale the whole edit so its runtime becomes the length in the field"
            aria-label="Fit total"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const parsed = parseTimelineLength(lenDraft ?? formatTimelineLength(resolved.totalSec));
              if (parsed != null) commit(scaleTimelineToDuration(timelineRef.current, parsed));
              setLenDraft(null);
            }}
          ><TlIcon name="fitTotal" /></button>
        </span>
        <span className="prod-tl-tc" title={`Playhead (${fps} fps grid)`}>{fmtTc(playhead, fps)}</span>
        <HelpTip
          label="Timeline editor help"
          text={`Drag a clip to move it (across tracks too). Edges trim — Alt+edge rolls the edit point. Right-drag slips. S splits at the playhead · Delete removes · Ctrl+Z undoes. Edits land on the ${fps} fps frame grid. Loop: I and O mark In and Out points at the playhead (Alt+I / Alt+O clear them); with the Loop toggle on, playback repeats between them. Speed ramps: Add ramp, drag the dots (up = faster), double-click a clip to add a keyframe, Alt+click a dot to delete it. Ramp preview here is approximate; the render is exact.`}
        />
      </div>
      <div className="prod-tl-body">
        <div className="prod-tl-headers" style={{ width: headerW }}>
          <div
            className="prod-tl-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize track header panel"
            title="Drag to resize the track header panel"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              headerResizeRef.current = { startX: e.clientX, startW: headerW, curW: headerW };
            }}
            onPointerMove={(e) => {
              const r = headerResizeRef.current;
              if (!r) return;
              r.curW = Math.max(HEADER_W_MIN, Math.min(HEADER_W_MAX, r.startW + (e.clientX - r.startX)));
              setHeaderW(r.curW);
            }}
            onPointerUp={(e) => {
              if (!headerResizeRef.current) return;
              headerResizeRef.current = null;
              try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
              // Width persists via usePersistedNumber's effect on setHeaderW.
            }}
            onPointerCancel={() => { headerResizeRef.current = null; }}
          />
          <div className="prod-tl-ruler-corner" />
          {timeline.tracks.map((track) => (
            <div key={track.id} className={"prod-tl-header" + (track.locked ? " locked" : "")} style={{ height: rowH(track) }}>
              <div className="prod-tl-header-top">
                <span className="prod-tl-track-kind">{track.kind === "video" ? "V" : "A"}</span>
                <input
                  className="prod-tl-track-name"
                  defaultValue={track.name}
                  aria-label={`Name of track ${track.name}`}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== track.name) commit(renameTrack(timelineRef.current, track.id, name));
                    else e.target.value = track.name;
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              </div>
              {track.kind === "audio" && (
                <input
                  className="prod-tl-track-vol"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={volDraft?.trackId === track.id ? volDraft.pct : Math.round(trackVolume(track) * 100)}
                  aria-label={`Volume for track ${track.name}`}
                  title={`Track volume ${volDraft?.trackId === track.id ? volDraft.pct : Math.round(trackVolume(track) * 100)}% (multiplies every clip on this track)`}
                  onChange={(e) => onTrackVolumeInput(track.id, Number(e.currentTarget.value))}
                  onPointerUp={() => endTrackVolumeGesture(track.id)}
                  onBlur={() => endTrackVolumeGesture(track.id)}
                />
              )}
              <div className="prod-tl-header-btns">
                <button
                  className={track.locked ? "active" : ""}
                  aria-pressed={!!track.locked}
                  title={track.locked ? "Unlock track" : "Lock track (no edits)"}
                  onClick={() => commit(setTrackLocked(timelineRef.current, track.id, !track.locked))}
                >Lock</button>
                {track.kind === "video" ? (
                  <button
                    className={track.hidden ? "active" : ""}
                    aria-pressed={!!track.hidden}
                    title={track.hidden ? "Show track" : "Hide track (excluded from preview and render)"}
                    onClick={() => commit(setTrackHidden(timelineRef.current, track.id, !track.hidden))}
                  >Hide</button>
                ) : (
                  <button
                    className={track.muted ? "active" : ""}
                    aria-pressed={!!track.muted}
                    title={track.muted ? "Unmute track" : "Mute track"}
                    onClick={() => commit(setTrackMuted(timelineRef.current, track.id, !track.muted))}
                  >Mute</button>
                )}
                <button
                  title="Remove track and its clips"
                  aria-label={`Remove track ${track.name}`}
                  onClick={() => commit(removeTrack(timelineRef.current, track.id))}
                >×</button>
              </div>
            </div>
          ))}
        </div>
        <div className="prod-tl-scroll" ref={scrollRef}>
          <div className="prod-tl-lanes" ref={lanesRef} style={{ width: contentW }} onPointerDown={onLanesPointerDown}>
            <div className="prod-tl-ruler" aria-hidden="true">
              {activeLoopSpan && (
                <div
                  className="prod-tl-loop-region"
                  style={{ left: activeLoopSpan.startSec * pps, width: (activeLoopSpan.endSec - activeLoopSpan.startSec) * pps }}
                />
              )}
              {ticks.map((s) => (
                <span key={s} className="prod-tl-tick" style={{ left: s * pps }}>{fmtTc(s, fps)}</span>
              ))}
              {loopRegion.inSec != null && <span className="prod-tl-loop-pt" style={{ left: loopRegion.inSec * pps }}>I</span>}
              {loopRegion.outSec != null && <span className="prod-tl-loop-pt" style={{ left: loopRegion.outSec * pps }}>O</span>}
            </div>
            {timeline.tracks.map((track) => (
              <div
                key={track.id}
                className={"prod-tl-lane" + (track.kind === "audio" ? " audio" : "") + (track.locked ? " locked" : "")}
                style={{ height: rowH(track) }}
                data-track-id={track.id}
              >
                {timeline.clips.filter((c) => c.trackId === track.id).map((clip) => {
                  const left = clip.timelineStartSec * pps;
                  const widthPx = Math.max(2, clipDurationSec(clip) * pps);
                  const dimmed = (track.kind === "video" && track.hidden) || (track.kind === "audio" && track.muted);
                  const baseLabel = clip.name ?? clip.srcRel?.split("/").pop() ?? (clip.sourceKind === "blank" ? "Blank" : "Clip");
                  const label = `${clip.reversed ? "◀ " : ""}${baseLabel}${clip.speedCurve?.length ? ` · ramp ${clipSpeed(clip).toFixed(2)}×` : clipSpeed(clip) !== 1 ? ` · ${clipSpeed(clip)}×` : ""}${clip.pitchMode === "natural" ? " · pitch shift" : ""}${clip.srcRel && proxyBySrc[clip.srcRel] ? " · proxy" : ""}`;
                  return (
                    <div
                      key={clip.id}
                      className={"prod-tl-clip " + clip.sourceKind + (selected.has(clip.id) ? " selected" : "") + (dimmed ? " dimmed" : "")}
                      data-clip-id={clip.id}
                      style={{ left, width: widthPx }}
                      title={`${label} · ${clipDurationSec(clip).toFixed(2)}s · drag to move, edges trim (Alt rolls), right-drag slips`}
                      onPointerDown={(e) => onClipPointerDown(e, clip, "body")}
                      onDoubleClick={(e) => {
                        if (clip.sourceKind !== "video" && clip.sourceKind !== "audio") return;
                        if (timeline.tracks.find((x) => x.id === clip.trackId)?.locked) return;
                        const local = Math.max(0, Math.min(clipDurationSec(clip), q(timeAtClientX(e.clientX) - clip.timelineStartSec)));
                        const speedHere = clipSpeedAt(clip, local);
                        const baseCurve = clip.speedCurve?.length
                          ? clip.speedCurve
                          : [{ atSec: 0, speed: clipSpeed(clip) }];
                        if (baseCurve.some((k) => Math.abs(k.atSec - local) < 1 / fps)) return;
                        const nextCurve = [...baseCurve, { atSec: local, speed: speedHere }].sort((a, b) => a.atSec - b.atSec);
                        commit(setClipSpeedCurve(timelineRef.current, [clip.id], nextCurve, editOpts()));
                        setSelected(new Set([clip.id]));
                        setActiveKf({ clipId: clip.id, atSec: local });
                      }}
                    >
                      {renderClipMedia(clip, widthPx)}
                      {(() => {
                        const outT = transitionFor(timeline, clip.id);
                        const inT = timeline.transitions?.find((tr) => tr.incomingClipId === clip.id);
                        if (!outT && !inT) return null;
                        const remove = (e: React.MouseEvent, outgoingId: string) => {
                          e.stopPropagation();
                          commit(setClipTransition(timelineRef.current, outgoingId, null, uid, editOpts()));
                        };
                        return (
                          <>
                            {inT && (
                              <div
                                className="prod-tl-dissolve-zone in"
                                data-dissolve-in={clip.id}
                                style={{ width: (inT.durationSec / 2) * pps }}
                                title={`Dissolve ${inT.durationSec}s in (centered) — click to remove`}
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => remove(e, inT.outgoingClipId)}
                              />
                            )}
                            {outT && (
                              <div
                                className="prod-tl-dissolve-zone out"
                                data-dissolve-out={clip.id}
                                style={{ width: (outT.durationSec / 2) * pps }}
                                title={`Dissolve ${outT.durationSec}s out (centered) — click to remove`}
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => remove(e, clip.id)}
                              />
                            )}
                          </>
                        );
                      })()}
                      {clip.speedCurve?.length ? (
                        <svg
                          className="prod-tl-ramp"
                          viewBox={`0 0 ${Math.max(1, widthPx)} 100`}
                          preserveAspectRatio="none"
                          style={{ pointerEvents: selected.has(clip.id) ? "auto" : "none" }}
                          aria-hidden="true"
                        >
                          <polyline
                            className="prod-tl-ramp-line"
                            points={[
                              ...clip.speedCurve.map((k) => `${Math.min(k.atSec * pps, widthPx)},${rampYFrac(k.speed) * 100}`),
                              `${widthPx},${rampYFrac(clipSpeedAt(clip, clipDurationSec(clip))) * 100}`,
                            ].join(" ")}
                          />
                          {clip.speedCurve.map((kf, ki) => (
                            <circle
                              key={ki}
                              data-kf-index={ki}
                              className={"prod-tl-ramp-dot" + (activeKf?.clipId === clip.id && activeKf.atSec === kf.atSec ? " active" : "")}
                              cx={Math.min(Math.max(Math.min(kf.atSec, clipDurationSec(clip)) * pps, 5), Math.max(5, widthPx - 5))}
                              cy={rampYFrac(kf.speed) * 100}
                              r={4}
                              onPointerDown={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                if (e.altKey) {
                                  const curve = clip.speedCurve!;
                                  commit(curve.length > 1
                                    ? setClipSpeedCurve(timelineRef.current, [clip.id], curve.filter((_, i) => i !== ki), editOpts())
                                    : setClipSpeedCurve(timelineRef.current, [clip.id], null, editOpts()));
                                  setActiveKf(null);
                                  return;
                                }
                                setActiveKf({ clipId: clip.id, atSec: kf.atSec });
                                const clipEl = (e.currentTarget as SVGCircleElement).closest(".prod-tl-clip") as HTMLElement | null;
                                const rect = clipEl?.getBoundingClientRect();
                                gestureRef.current = {
                                  kind: "ramp-kf", clipId: clip.id, kfIndex: ki,
                                  kfRectTop: rect?.top ?? 0, kfRectH: rect?.height || VIDEO_ROW_H,
                                  startX: e.clientX, startY: e.clientY, orig: timelineRef.current, moved: false,
                                };
                                try { (e.currentTarget as unknown as HTMLElement).setPointerCapture(e.pointerId); } catch { /* jsdom */ }
                              }}
                            />
                          ))}
                        </svg>
                      ) : null}
                      <span className="prod-tl-clip-label">{label}</span>
                      {(clip.sourceKind === "audio" || clip.sourceKind === "video") && (
                        <>
                          {(clip.fadeInSec ?? 0) > 0 && (
                            <div className="prod-tl-fade in" style={{ width: (clip.fadeInSec ?? 0) * pps }} aria-hidden="true" />
                          )}
                          {(clip.fadeOutSec ?? 0) > 0 && (
                            <div className="prod-tl-fade out" style={{ width: (clip.fadeOutSec ?? 0) * pps }} aria-hidden="true" />
                          )}
                          <div
                            className="prod-tl-vol-line"
                            data-vol={clip.id}
                            style={{ top: `${(1 - clipVolume(clip)) * 100}%` }}
                            title={`Clip volume ${Math.round(clipVolume(clip) * 100)}% — drag to set (applies to ${clip.sourceKind === "audio" ? "the clip" : "its embedded/linked audio"})`}
                            onPointerDown={(e) => startAudioGesture(e, clip, "vol")}
                          />
                          <div
                            className="prod-tl-fade-handle in"
                            data-fade-in={clip.id}
                            style={{ left: (clip.fadeInSec ?? 0) * pps }}
                            title={`Fade in ${((clip.fadeInSec ?? 0)).toFixed(2)}s — drag from the corner`}
                            onPointerDown={(e) => startAudioGesture(e, clip, "fade-in")}
                          />
                          <div
                            className="prod-tl-fade-handle out"
                            data-fade-out={clip.id}
                            style={{ right: (clip.fadeOutSec ?? 0) * pps }}
                            title={`Fade out ${((clip.fadeOutSec ?? 0)).toFixed(2)}s — drag from the corner`}
                            onPointerDown={(e) => startAudioGesture(e, clip, "fade-out")}
                          />
                        </>
                      )}
                      {clip.linkId && <span className="prod-tl-clip-link" title="Linked clip">⛓</span>}
                      <div
                        className="prod-tl-clip-edge head"
                        title="Trim head (Alt: roll)"
                        onPointerDown={(e) => onClipPointerDown(e, clip, "head")}
                      />
                      <div
                        className="prod-tl-clip-edge tail"
                        title="Trim tail (Alt: roll)"
                        onPointerDown={(e) => onClipPointerDown(e, clip, "tail")}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
            <div className="prod-tl-playhead" style={{ left: playhead * pps }} />
            {marquee && (
              <div
                className="prod-tl-marquee"
                style={{
                  left: Math.min(marquee.x0, marquee.x1),
                  top: Math.min(marquee.y0, marquee.y1) + RULER_H,
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One audio clip's waveform, drawn from precomputed peaks over exactly
 *  the clip's source range. */
function WaveformCanvas({ peaks, inSec, outSec, widthPx }: { peaks?: Peaks; inSec: number; outSec: number; widthPx: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cvs.clientWidth;
    const h = cvs.clientHeight;
    if (w <= 0 || h <= 0) return;
    cvs.width = Math.max(1, Math.floor(w * dpr));
    cvs.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!peaks || peaks.bucketSec <= 0 || outSec <= inSec) return;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4f8ef7";
    const range = outSec - inSec;
    const cols = Math.max(1, Math.floor(w / 2));
    for (let i = 0; i < cols; i++) {
      const t0 = inSec + (i / cols) * range;
      const t1 = inSec + ((i + 1) / cols) * range;
      let b0 = Math.max(0, Math.min(peaks.mins.length - 1, Math.floor(t0 / peaks.bucketSec)));
      let b1 = Math.max(b0, Math.min(peaks.mins.length - 1, Math.floor(t1 / peaks.bucketSec)));
      let min = 1, max = -1;
      for (let b = b0; b <= b1; b++) {
        if (peaks.mins[b] < min) min = peaks.mins[b];
        if (peaks.maxs[b] > max) max = peaks.maxs[b];
      }
      const y1 = ((1 - max) / 2) * h;
      const y2 = ((1 - min) / 2) * h;
      ctx.fillRect((i / cols) * w, y1, Math.max(1, w / cols - 0.5), Math.max(1, y2 - y1));
    }
  }, [peaks, inSec, outSec, widthPx]);
  return <canvas ref={ref} className="prod-tl-wave" aria-hidden="true" />;
}




