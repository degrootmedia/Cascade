import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Retry720pAction, type SequenceTimelineItem } from "../../../../shared/ipc.js";
import { PlayButtonIcon, StopButtonIcon } from "../icons.js";
import { GenerationMenu, useGenerationMenu } from "../generation-menu.js";
import { usePersistedCollapsed } from "./persisted-state.js";
import { mediaRev } from "./media-rev.js";
import { batchedBoardThumb } from "./board-thumbs.js";
import { blendUnderShouldSeek, loopWrapAt, type TimelineLoopRegion, type TimelineOverride } from "./timeline-preview.js";

/** Timeline preview: max simultaneously-mounted pooled preview <video>s. */
export const VIDEO_POOL_MAX = 12;

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
  /** Optional 720p-retry offer rendered as a button on this line. */
  action?: Retry720pAction;
}


const animaticThumbCache = new Map<string, string>();
function AnimaticThumb({ prodId, shotId, artwork, explicitRel, title }: { prodId: string; shotId: string; artwork?: string; explicitRel?: string; /** Hover text override. */ title?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    // A sequence's held still renders directly (see the return below) — no
    // board-thumbnail fetch for it.
    if (explicitRel) return;
    let live = true;
    const key = `${prodId}:${shotId}:${artwork ?? ""}`;
    const cached = animaticThumbCache.get(key);
    if (cached) { setSrc(cached); return () => { live = false; }; }
    setSrc(null);
    if (artwork) {
      batchedBoardThumb(prodId, shotId).then((d) => {
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
  }, [prodId, shotId, artwork, explicitRel]);
  if (explicitRel) return <img className="prod-timeline-thumb" src={`cascade-media://${prodId}/${encodeURIComponent(explicitRel)}`} alt="Held still" title={title ?? "The sequence output's held still"} />;
  if (!src) return <span className="prod-timeline-thumb blank" title="No frame yet — generate one in Storyboard" />;
  return <img className="prod-timeline-thumb" src={src} alt="Shot frame" title={title ?? "Primary frame for this shot"} />;
}


/** Real-time playback preview (monitor + transport). Plays the
 *  resolved timeline: picture items from the video pool, audio from
 *  one hidden <audio> per audio-track clip, all synced to the shared
 *  playhead owned by the Step 4 section. */

export function TimelinePreview({
  prodId, timelineOverride,
  playheadSec: playhead, onPlayheadChange: setPlayhead, playing, onPlayingChange: setPlaying, onSaveAsReference, loopRegion,
}: {
  prodId: string;
  /** Preview items resolved from Production.timeline (proxy-preferred) —
   *  the ONLY timeline this preview plays. Editing lives in the
   *  TimelineEditor below; this component is the monitor + transport. */
  timelineOverride: TimelineOverride;
  /** Shared playhead in seconds, owned by the Step 4 section so the
   *  editor below follows playback and its scrubs seek this preview. */
  playheadSec: number;
  onPlayheadChange: (sec: number) => void;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  /** Copy the previewed shot's generated clip/frame into the production
   *  as a new reference (right-click the preview). */
  onSaveAsReference?: (shotId: string, rel: string) => void;
  /** Loop In/Out region from the editor below: with Loop on, the
   *  transport wraps from Out back to In instead of playing past. */
  loopRegion?: TimelineLoopRegion;
}) {
  // Preview items resolved from the production timeline: one block per
  // resolved span, topmost visible video winning (the render's rule).
  const shots: SequenceTimelineItem[] = timelineOverride.items;
  const sumDur = shots.reduce((n, s) => n + s.durationSec, 0) || 0.1;
  const total = sumDur;
  const [animaticMuted, setAnimaticMuted] = useState(false);

  const scrubRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const [previewHeight, setPreviewHeight] = useState(440);
  const genMenu = useGenerationMenu();

  // ---- Per-shot video pool (state) ------------------------------------
  // The preview pane keeps one <video> element MOUNTED PER SHOT
  // (LRU-capped): cutting between clips toggles visibility instead of
  // swapping src, which is what removes the black reload flash.
  const playheadRef = useRef(0);
  // Pooled video elements + LRU bookkeeping, keyed by shot id.
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const poolLruRef = useRef<Map<string, number>>(new Map());
  const poolTickRef = useRef(0);
  const [mountedVideos, setMountedVideos] = useState<string[]>([]);



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

  // Audio-track playback: one hidden <audio> per audio clip in the
  // override, synced to the shared playhead like the video pool.
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const stopFlagRef = useRef(0);
  // The rAF tick reads the loop region through a ref so toggling
  // Loop or moving I/O mid-playback takes effect immediately.
  const loopRegionRef = useRef(loopRegion);
  loopRegionRef.current = loopRegion;
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const startedHeadRef = useRef(0);
  const audioItems = timelineOverride.audioItems;
  const pauseAllAudio = useCallback(() => {
    for (const el of audioElsRef.current.values()) { try { el.pause(); } catch {} }
  }, []);

  const stop = useCallback(() => {
    stopFlagRef.current++;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    pauseAllAudio();
    setPlaying(false);
  }, [pauseAllAudio]);

  // Playhead/playing are owned by the parent section: when it pauses us
  // from outside (an editor scrub, a production switch), halt the local
  // transport too. Idempotent with stop() above.
  useEffect(() => {
    if (playing) return;
    stopFlagRef.current++;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    pauseAllAudio();
  }, [playing, pauseAllAudio]);

  const play = useCallback(async () => {
    if (playing) { stop(); return; }
    const flag = ++stopFlagRef.current;
    const head = playhead;
    startedHeadRef.current = head;
    startedAtRef.current = performance.now() / 1000;
    // Start every audio clip active at the playhead (the per-frame
    // sync effect keeps them aligned and starts later ones).
    const toPlay: Promise<void>[] = [];
    for (const item of audioItems) {
      const el = audioElsRef.current.get(item.id);
      if (!el) continue;
      const local = head - item.startSec;
      if (local < 0 || local >= item.durationSec) continue;
      const rate = item.rateAt(local);
      if (rate < 0) continue; // reversed audio previews silent (render is exact)
      try { el.currentTime = item.sourceAt(local); } catch {}
      try { el.playbackRate = Math.max(0.1, Math.min(4, rate || 1)); } catch {}
      el.volume = animaticMuted || item.muted ? 0 : Math.max(0, Math.min(1, item.gainAt(local)));
      toPlay.push(el.play().catch(() => {}));
    }
    await Promise.all(toPlay);
    // Re-anchor the wall clock after play() settles (it may be async).
    startedAtRef.current = performance.now() / 1000;
    setPlaying(true);
    const tick = () => {
      if (flag !== stopFlagRef.current) return;
      const h = startedHeadRef.current + (performance.now() / 1000 - startedAtRef.current);
      // Loop region: wrap Out -> In and keep playing (re-anchoring
      // the wall clock so the drift-corrected media re-syncs).
      const wrap = loopRegionRef.current ? loopWrapAt(loopRegionRef.current, h) : null;
      if (wrap != null) {
        startedHeadRef.current = wrap;
        startedAtRef.current = performance.now() / 1000;
        setPlayhead(wrap);
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      if (h >= total) { stop(); setPlayhead(0); return; }
      setPlayhead(h);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [playing, playhead, audioItems, animaticMuted, total, stop]);

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

  const activeId = activeIdx >= 0 && shots[activeIdx] ? shots[activeIdx].id : null;
  /** Playhead's local time within the shot it sits in. */
  const offsetInShot = activeIdx >= 0 ? Math.max(0, playhead - (starts[activeIdx] ?? 0)) : 0;

  /** Source timestamp for the playhead inside the active block's window. */
  const activeItem = activeIdx >= 0 ? shots[activeIdx] : null;
  const overrideSourceAt = activeItem ? timelineOverride?.sourceAt.get(activeItem.id) : undefined;
  /** Outgoing side of a dissolve covering the active item (Item 8). */
  const activeBlend = activeItem ? timelineOverride?.blendFrom.get(activeItem.id) : undefined;
  /** The NEXT item's dissolve, preloaded (hidden, seeked to its first
   *  frame) so the under-layer is already decoded when the blend
   *  starts — mounting it at the blend's first frame left it black
   *  while loading, which read as a dip to black. */
  const nextItem = activeIdx >= 0 ? shots[activeIdx + 1] : undefined;
  const nextBlend = !activeBlend && nextItem ? timelineOverride?.blendFrom.get(nextItem.id) : undefined;
  const underBlend = activeBlend ?? nextBlend;
  const blendRate = activeBlend
    ? (activeBlend.sourceAt(offsetInShot + 0.05) - activeBlend.sourceAt(offsetInShot)) / 0.05
    : 1;
  const blendVideoRef = useRef<HTMLVideoElement | null>(null);
  const activeVideoTime = overrideSourceAt ? overrideSourceAt(offsetInShot) : offsetInShot;
  /** Instantaneous preview rate from the override mapping (negative when
   *  the clip plays in reverse — browsers can't play backwards, so the
   *  frame-pin effect steps it instead of free-running). */
  const overrideRate = overrideSourceAt
    ? (overrideSourceAt(offsetInShot + 0.05) - overrideSourceAt(offsetInShot)) / 0.05
    : 1;

  playheadRef.current = playhead;





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
        v.currentTime = Math.min(activeVideoTime, v.duration);
    } catch {}
    try { v.playbackRate = timelineOverride ? Math.max(0.1, Math.min(4, Math.abs(overrideRate) || 1)) : 1; } catch {}
    if (playing && !(timelineOverride && overrideRate < 0)) void v.play().catch(() => {});
    else { try { v.pause(); } catch {} }
    // activeVideoTime intentionally omitted: mid-playback offsets advance
    // every frame while the video free-runs against the wall clock between
    // cuts (it only re-pins here on cuts and play/pause toggles).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, activeIdx, activeId]);

  // Embedded clip audio follows the override gain curve (volume ×
  // fades × track, Item 7) as the playhead moves — preview plays the
  // same gain math the render encodes.
  useEffect(() => {
    if (!timelineOverride || !activeId) return;
    const v = videoElsRef.current.get(activeId);
    if (!v) return;
    const g = timelineOverride.gainAt.get(activeId);
    try { v.volume = animaticMuted ? 0 : Math.max(0, Math.min(1, g ? g(offsetInShot) : 1)); } catch {}
  }, [playhead, activeId, timelineOverride, animaticMuted, offsetInShot]);

  // Ramp-following preview rate: the pool-transport effect sets the rate
  // once at cut-in (enough for constant speeds), but a speed RAMP's rate
  // changes continuously — follow the override derivative as the
  // playhead advances and re-pin on drift, so preview motion actually
  // accelerates/decelerates through the curve (approximate; the render
  // is exact). Forward playback only; reverse is frame-pinned above.
  useEffect(() => {
    if (!playing || !timelineOverride || !activeId || overrideRate < 0) return;
    const v = videoElsRef.current.get(activeId);
    if (!v) return;
    try { v.playbackRate = Math.max(0.1, Math.min(4, Math.abs(overrideRate) || 1)); } catch {}
    try {
      if (v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0
        && Math.abs(v.currentTime - activeVideoTime) > 0.4) {
        v.currentTime = Math.min(Math.max(0, activeVideoTime), v.duration);
      }
    } catch {}
  }, [playhead, playing, activeId, timelineOverride, overrideRate, activeVideoTime]);

  // Audio-track sync: each mounted <audio> follows the shared
  // playhead - playing inside its window at the clip's rate and gain,
  // paused outside it; drift beyond 0.4s re-pins (ramps included).
  useEffect(() => {
    for (const item of audioItems) {
      const el = audioElsRef.current.get(item.id);
      if (!el) continue;
      const local = playhead - item.startSec;
      const inWindow = local >= 0 && local < item.durationSec;
      const rate = inWindow ? item.rateAt(local) : 1;
      if (!inWindow || !playing || rate < 0) {
        if (!el.paused) { try { el.pause(); } catch {} }
        continue;
      }
      el.volume = animaticMuted || item.muted ? 0 : Math.max(0, Math.min(1, item.gainAt(local)));
      try { el.playbackRate = Math.max(0.1, Math.min(4, rate || 1)); } catch {}
      try {
        const want = item.sourceAt(local);
        if (el.readyState >= 1 && Number.isFinite(el.duration) && el.duration > 0 && Math.abs(el.currentTime - want) > 0.4) {
          el.currentTime = Math.min(Math.max(0, want), el.duration);
        }
      } catch {}
      if (el.paused) void el.play().catch(() => {});
    }
  }, [playhead, playing, audioItems, animaticMuted]);

  // Dissolve preview (Item 8): the outgoing clip plays on a dedicated
  // under-layer while the incoming (active) video fades in over it —
  // opacity follows blend progress; both sides use the same loose
  // source mapping and gain curves as the render.
  useEffect(() => {
    const blendOpacity = activeBlend ? String(Math.min(1, Math.max(0, offsetInShot / Math.max(0.0001, activeItem?.durationSec ?? 1)))) : "";
    videoElsRef.current.forEach((el, id) => {
      try { el.style.opacity = activeBlend && id === activeId ? blendOpacity : ""; } catch {}
    });
    // Incoming STILL: fade the monitor thumb the same way.
    try {
      const thumb = previewRef.current?.querySelector(".prod-timeline-thumb") as HTMLElement | null;
      if (thumb) thumb.style.opacity = blendOpacity;
    } catch {}
    const bv = blendVideoRef.current;
    if (!bv) return;
    if (!activeBlend) {
      // Preload the upcoming blend's under-layer: park it on the
      // blend's first frame (paused) so activation starts decoded.
      if (nextBlend?.videoPath) {
        try {
          if (bv.readyState >= 1 && Number.isFinite(bv.duration) && bv.duration > 0) {
            const want = Math.min(Math.max(0, nextBlend.sourceAt(0)), bv.duration);
            if (Math.abs(bv.currentTime - want) > 0.1) bv.currentTime = want;
          }
        } catch {}
        try { bv.pause(); } catch {}
      }
      return;
    }
    if (!activeBlend.videoPath) return; // still under-layer: no transport
    try {
      if (bv.readyState >= 1 && Number.isFinite(bv.duration) && bv.duration > 0) {
        // Pin the frame when paused/scrubbing; while playing, seek
        // only on real drift. Seeking every frame starved the
        // decoder (readyState stuck at HAVE_METADATA) so the
        // under-layer painted BLACK and the dissolve dipped to
        // black instead of crossfading.
        const want = Math.min(Math.max(0, activeBlend.sourceAt(offsetInShot)), bv.duration);
        if (blendUnderShouldSeek(playing, bv.currentTime, want)) bv.currentTime = want;
      }
    } catch {}
    try { bv.volume = animaticMuted || activeBlend.muted ? 0 : Math.max(0, Math.min(1, activeBlend.gainAt(offsetInShot))); } catch {}
    try { bv.playbackRate = Math.max(0.1, Math.min(4, Math.abs(blendRate) || 1)); } catch {}
    if (playing && blendRate >= 0) void bv.play().catch(() => {});
    else { try { bv.pause(); } catch {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, activeId, playing, activeBlend, nextBlend, animaticMuted, offsetInShot]);

  // Paused / scrubbing: pin the active clip to the frame under the playhead.
  useEffect(() => {
    if ((playing && !(timelineOverride && overrideRate < 0)) || !activeId) return;
    const v = videoElsRef.current.get(activeId);
    if (!v) return;
    try {
      if (v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0)
        v.currentTime = Math.min(Math.max(0, activeVideoTime), v.duration);
    } catch {}
  }, [playhead, playing, activeIdx, activeId, activeVideoTime]);

  // ---- Interactions -----------------------------------------------------



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

  /** Seek by pointer position on the transport scrubber (full-range). */
  const seekFromEvent = (ref: React.RefObject<HTMLElement>, clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0)) return;
    const x = clientX - r.left;
    setPlayhead(Math.max(0, Math.min(total, (x / r.width) * total)));
  };
  const headDragRef = useRef<{ ref: React.RefObject<HTMLElement> } | null>(null);
  const onSeekDown = (ref: React.RefObject<HTMLElement>) => (e: React.PointerEvent) => {
    // Left button only.
    if (e.button !== 0) return;
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
    return <p className="hint">Nothing on the timeline yet - add clips in the timeline editor below.</p>;
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
        title={activeShot?.videoPath || activeShot?.artwork ? "Right-click for save, copy, edit, or reference options" : undefined}
        onContextMenu={(e) => {
          // The shared take menu is shot-addressed (delete/save name a shot);
          // a sequence's takes are managed on its own canvas instead.
          if (activeShot?.kind === "sequence") return;
          const rel = activeShot?.videoPath ?? activeShot?.artwork;
          if (activeShot && rel) genMenu.open(e, rel, { src: cascadeMedia(prodId, rel), media: activeShot.videoPath ? "video" : "image" });
        }}
      >
        {/* One mounted <video> per recently-active shot (LRU-capped); only the
            active clip is visible, so cuts swap pixels instead of reloading
            media — no black flash between clips. The wall clock drives which
            clip shows; a video longer than its shot is cut at the boundary and
            a shorter one loops. */}
        {underBlend?.videoPath && (
          <video
            key={`blend:${underBlend.videoPath}`}
            ref={blendVideoRef}
            className={"prod-animatic-video" + (activeBlend ? " blend-under" : "")}
            src={`cascade-media://${prodId}/${encodeURIComponent(underBlend.videoPath)}`}
            muted={!!underBlend.muted}
            preload="auto"
            playsInline
          />
        )}
        {underBlend?.stillPath && (
          <img
            key={`blend:${underBlend.stillPath}`}
            className={"prod-animatic-video" + (activeBlend ? " blend-under" : "")}
            src={`cascade-media://${prodId}/${encodeURIComponent(underBlend.stillPath)}`}
            alt=""
          />
        )}
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
                try { v.currentTime = Math.min(activeVideoTime, v.duration); } catch {}
                try { v.playbackRate = timelineOverride ? Math.max(0.1, Math.min(4, Math.abs(overrideRate) || 1)) : 1; } catch {}
                if (playing && !(timelineOverride && overrideRate < 0)) void v.play().catch(() => {});
              }}
            />
          );
        })}
        {activeShot && !activeShot.videoPath && activeThumb ? (
          <AnimaticThumb
            prodId={prodId}
            shotId={activeShot.shotIds[0] ?? activeShot.id}
            artwork={activeThumb}
            explicitRel={activeShot.kind === "sequence" ? activeThumb : undefined}
          />
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
        <button onClick={() => setAnimaticMuted((m) => !m)} title={animaticMuted ? "Unmute animatic audio" : "Mute animatic audio"} aria-label={animaticMuted ? "Unmute animatic audio" : "Mute animatic audio"}>{animaticMuted ? "Unmute" : "Mute"}</button>
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
          {formatRuntime(playhead)} / {formatRuntime(total)}
        </span>
      </div>


      {/* Hidden audio-track players - one per audio clip, synced to
          the shared playhead by the transport. */}
      {audioItems.map((item) => (
        <audio
          key={item.id}
          ref={(el) => {
            if (el) audioElsRef.current.set(item.id, el);
            else audioElsRef.current.delete(item.id);
          }}
          src={cascadeMedia(prodId, item.rel)}
          preload="auto"
          hidden
        />
      ))}
      <GenerationMenu
        menu={genMenu.menu}
        onClose={genMenu.close}
        onSaveAsReference={onSaveAsReference && activeShot ? (rel) => onSaveAsReference(activeShot.shotIds[0] ?? activeShot.id, rel) : undefined}
      />
    </div>
  );
}

export function ProdLog({ lines, onRetry720p }: { lines: LogLine[]; onRetry720p?: (action: Retry720pAction) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = usePersistedCollapsed("cascade.prodLog.collapsed");
  const [usedActions, setUsedActions] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    if (!collapsed) ref.current?.scrollTo?.({ top: ref.current.scrollHeight });
  }, [lines.length, collapsed]);
  return (
    <div className="prod-log">
      <div className="prod-log-head">
        <button
          type="button"
          className="prod-log-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? "Show activity log" : "Hide activity log"}
        >
          <span className={"prod-log-caret" + (collapsed ? " collapsed" : "")} aria-hidden="true" />
          Activity
          <span className="prod-log-count">{lines.length}</span>
        </button>
      </div>
      {!collapsed && (
        <div className="prod-log-lines" ref={ref}>
          {lines.map((l, i) => (
            <div key={i} className={"prod-log-line " + l.level}>
              <span className="prod-log-time">{l.at}</span> {l.message}{" "}
              {l.action && onRetry720p && (
                <button
                  type="button"
                  className="prod-log-action-btn"
                  disabled={usedActions.has(i)}
                  onClick={() => {
                    setUsedActions((prev) => new Set(prev).add(i));
                    onRetry720p(l.action!);
                  }}
                >
                  {usedActions.has(i) ? "Retrying…" : "Create 720p copy & retry"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
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


