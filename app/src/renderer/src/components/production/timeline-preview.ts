/**
 * Timeline → Step 4 preview mapping (Animatic Expansion, Item 6).
 *
 * Turns a ProductionTimeline into the flat item list the TimelinePreview
 * monitor consumes, resolving each span's media
 * through the registry and preferring a ready PROXY for playback
 * (originals stay the render/export truth). Per-item `sourceAt` maps a
 * block-local time to the exact source timestamp via the shared timing
 * code, so speed/ramps/reverse preview with the same math as the
 * render (browsers play it approximately; the render is exact).
 * Pure: no DOM, no IPC.
 */
import {
  clipDurationSec,
  clipGainAt,
  clipSourceTimeAt,
  clipSourceTimeAtLoose,
  resolveTimeline,
  timelineLengthSec,
  trackVolume,
  type ProductionTimeline,
  type SequenceTimelineItem,
} from "../../../../shared/ipc.js";
import { mediaPathForId, type MediaEntry } from "../../../../shared/media-registry.js";

/** One audible audio-track clip for preview playback: every audio
 *  clip plays from its track (there are no separate VO/music beds). */
export interface TimelineAudioItem {
  id: string;
  /** Source rel path (audio has no proxy variant). */
  rel: string;
  /** Timeline start (seconds). */
  startSec: number;
  /** Timeline duration (seconds). */
  durationSec: number;
  /** Clip muted flag (track state is already folded into gainAt). */
  muted?: boolean;
  /** Source seconds at a clip-local timeline offset. */
  sourceAt(localSec: number): number;
  /** Signed playback-rate factor at a clip-local offset (preview). */
  rateAt(localSec: number): number;
  /** Linear gain 0..2 (clip envelope × track volume) at a local offset. */
  gainAt(localSec: number): number;
}

export interface TimelineOverride {
  items: SequenceTimelineItem[];
  /** Audio-track clips to play alongside the picture. */
  audioItems: TimelineAudioItem[];
  /** itemId → source timestamp for a block-local timeline second. */
  sourceAt: ReadonlyMap<string, (localSec: number) => number>;
  /** itemId → embedded-audio gain (clip×track, fades incl.) for a
   *  block-local timeline second (Item 7). */
  gainAt: ReadonlyMap<string, (localSec: number) => number>;
  /** itemId → the OUTGOING side of a dissolve covering this item
   *  (Item 8): preview stacks it under the incoming item and fades
   *  the incoming item's opacity across the window, so both images
   *  stay visible mid-transition (a true crossfade, matching the
   *  render). Exactly one of videoPath/stillPath is set. */
  blendFrom: ReadonlyMap<string, TimelineBlendFrom>;
}

/** The outgoing side of one preview dissolve. `sourceAt`/`gainAt`
 *  map a blend-window-local second like the render's loose mapping
 *  (zero-functions for a still, which has neither). */
export interface TimelineBlendFrom {
  videoPath?: string;
  stillPath?: string;
  sourceAt: (localSec: number) => number;
  gainAt: (localSec: number) => number;
  muted?: boolean;
}

export function buildTimelineOverride(
  timeline: ProductionTimeline,
  media: MediaEntry[] | undefined,
  proxyBySrc: Readonly<Record<string, string>>,
  shotNumbers: ReadonlyMap<string, string>
): TimelineOverride {
  const resolved = resolveTimeline(timeline);
  const items: SequenceTimelineItem[] = [];
  const sourceAt = new Map<string, (localSec: number) => number>();
  const gainAt = new Map<string, (localSec: number) => number>();
  const blendFrom = new Map<string, TimelineBlendFrom>();
  // Split spans at blend boundaries like the render plan does.
  const pieces: typeof resolved.videoSpans = [];
  for (const span of resolved.videoSpans) {
    const cuts = resolved.blendSpans
      .flatMap((b) => [b.startSec, b.endSec])
      .filter((x) => x > span.startSec && x < span.endSec)
      .sort((a, b) => a - b);
    let cur = span.startSec;
    for (const cut of cuts) {
      pieces.push({ ...span, startSec: cur, endSec: cut });
      cur = cut;
    }
    pieces.push({ ...span, startSec: cur });
  }
  for (let i = 0; i < pieces.length; i++) {
    const span = pieces[i];
    const dur = span.endSec - span.startSec;
    if (dur <= 0) continue;
    // Dissolve window (Item 8): merge the two half pieces into one
    // incoming item with the outgoing side stacked underneath.
    const blend = resolved.blendSpans.find(
      (b) => b.outgoing === span.clip && Math.abs(span.startSec - b.startSec) < 1e-9 && Math.abs(span.endSec - b.editSec) < 1e-9
    );
    const nextPiece = pieces[i + 1];
    if (blend && nextPiece && nextPiece.clip === blend.incoming) {
      const D = blend.transition.durationSec;
      const half = D / 2;
      const inc = blend.incoming;
      const out = blend.outgoing;
      const inSrc = mediaPathForId(media, inc.mediaId) ?? inc.srcRel;
      const outSrc = mediaPathForId(media, out.mediaId) ?? out.srcRel;
      // Proxies exist for video only; a still side shows its source.
      const inDisplay = inc.sourceKind === "video" ? (inSrc && proxyBySrc[inSrc]) || inSrc : inSrc;
      const outDisplay = out.sourceKind === "video" ? (outSrc && proxyBySrc[outSrc]) || outSrc : outSrc;
      const blendable = (inc.sourceKind === "video" || inc.sourceKind === "still") && (out.sourceKind === "video" || out.sourceKind === "still");
      if (blendable && inDisplay && outDisplay) {
        const id = `tl:${inc.id}:${i}:blend`;
        const number =
          (inc.shotId ? shotNumbers.get(inc.shotId) : undefined) ??
          inc.name ??
          inSrc?.split("/").pop()?.replace(/\.[^.]+$/, "") ??
          "Clip";
        const tVolB = trackVolume(blend.track);
        const prog = (localSec: number): number => Math.min(1, Math.max(0, localSec / D));
        if (inc.sourceKind === "video") {
          items.push({ kind: "shot", id, number, durationSec: D, videoPath: inDisplay, muted: inc.muted, shotIds: inc.shotId ? [inc.shotId] : [] });
          sourceAt.set(id, (localSec: number) => clipSourceTimeAtLoose(inc, -half + localSec));
          gainAt.set(id, (localSec: number) => tVolB * clipGainAt(inc, Math.max(0, -half + localSec)) * prog(localSec));
        } else {
          items.push({ kind: "shot", id, number, durationSec: D, artwork: inDisplay, shotIds: inc.shotId ? [inc.shotId] : [] });
        }
        const outDur = clipDurationSec(out);
        blendFrom.set(id, out.sourceKind === "video" ? {
          videoPath: outDisplay,
          sourceAt: (localSec: number) => clipSourceTimeAtLoose(out, outDur - half + localSec),
          gainAt: (localSec: number) => tVolB * clipGainAt(out, outDur - half + localSec) * (1 - prog(localSec)),
          muted: out.muted,
        } : {
          stillPath: outDisplay,
          sourceAt: () => 0,
          gainAt: () => 0,
          muted: true,
        });
        i++; // consume the incoming half-piece
        continue;
      }
    }
    const clip = span.clip;
    if (!clip || clip.sourceKind === "blank") {
      items.push({
        kind: "shot",
        id: `tl:blank:${i}`,
        number: "—",
        durationSec: dur,
        shotIds: [],
      });
      continue;
    }
    const srcRel = mediaPathForId(media, clip.mediaId) ?? clip.srcRel;
    const id = `tl:${clip.id}:${i}`;
    const number =
      (clip.shotId ? shotNumbers.get(clip.shotId) : undefined) ??
      clip.name ??
      srcRel?.split("/").pop()?.replace(/\.[^.]+$/, "") ??
      "Clip";
    const intoClip = span.startSec - clip.timelineStartSec;
    if (clip.sourceKind === "still") {
      items.push({
        kind: "shot",
        id,
        number,
        durationSec: dur,
        artwork: srcRel,
        shotIds: clip.shotId ? [clip.shotId] : [],
      });
      continue;
    }
    const displayRel = (srcRel && proxyBySrc[srcRel]) || srcRel;
    items.push({
      kind: "shot",
      id,
      number,
      durationSec: dur,
      videoPath: displayRel,
      muted: clip.muted,
      shotIds: clip.shotId ? [clip.shotId] : [],
    });
    sourceAt.set(id, (localSec: number) => clipSourceTimeAt(clip, intoClip + localSec));
    const tVol = span.track ? trackVolume(span.track) : 1;
    gainAt.set(id, (localSec: number) => tVol * clipGainAt(clip, intoClip + localSec));
  }
  // Audio-track clips: every resolved (audible-track) clip plays from
  // its track position with the same source mapping and gain envelope
  // as the render. Rate is the sourceAt derivative over ±1 frame,
  // exactly like picture items.
  const audioItems: TimelineAudioItem[] = [];
  for (const { clip, track } of resolved.audioClips) {
    const rel = mediaPathForId(media, clip.mediaId) ?? clip.srcRel;
    if (!rel) continue;
    const tVol = trackVolume(track);
    audioItems.push({
      id: clip.id,
      rel,
      startSec: clip.timelineStartSec,
      durationSec: clipDurationSec(clip),
      muted: clip.muted,
      sourceAt: (localSec: number) => clipSourceTimeAt(clip, localSec),
      rateAt: (localSec: number) => {
        const eps = 1 / 24;
        return (clipSourceTimeAtLoose(clip, localSec + eps) - clipSourceTimeAtLoose(clip, localSec - eps)) / (2 * eps);
      },
      gainAt: (localSec: number) => tVol * clipGainAt(clip, localSec),
    });
  }
  return { items, audioItems, sourceAt, gainAt, blendFrom };
}

/** Whether the dissolve under-layer video should seek to `wantSec`
 *  now. While playing, seeking every frame starves the decoder
 *  (readyState never leaves HAVE_METADATA, so the layer paints
 *  BLACK and the dissolve dips to black instead of crossfading) —
 *  only correct real drift; the element's own playback tracks the
 *  wall clock in between. Paused, the frame is pinned exactly. */
export function blendUnderShouldSeek(playing: boolean, currentSec: number, wantSec: number): boolean {
  if (!playing) return true;
  return Math.abs(currentSec - wantSec) > 0.4;
}

/** Loop region for preview playback: In/Out points on the ruler
 *  plus the toolbar Loop toggle. Session state (not saved with the
 *  production) shared by the editor (keys, highlight, toggle) and
 *  the preview transport (wrapping). */
export interface TimelineLoopRegion {
  inSec: number | null;
  outSec: number | null;
  enabled: boolean;
}

export const EMPTY_LOOP_REGION: TimelineLoopRegion = { inSec: null, outSec: null, enabled: false };

/** The loopable span, or null until both points exist in order. */
export function loopSpan(r: TimelineLoopRegion): { startSec: number; endSec: number } | null {
  if (r.inSec == null || r.outSec == null || !(r.outSec > r.inSec)) return null;
  return { startSec: r.inSec, endSec: r.outSec };
}

/** Where playback wraps to when the head reaches the Out point with
 *  Loop on; null = play through (no region, or Loop off). */
export function loopWrapAt(r: TimelineLoopRegion, headSec: number): number | null {
  if (!r.enabled) return null;
  const span = loopSpan(r);
  if (!span) return null;
  return headSec >= span.endSec ? span.startSec : null;
}

/** Set (or clear, with null) one loop point; the other fields ride. */
export function withLoopPoint(r: TimelineLoopRegion, which: "in" | "out", sec: number | null): TimelineLoopRegion {
  return which === "in" ? { ...r, inSec: sec } : { ...r, outSec: sec };
}

/** Timeline duration from the model (for the preview's total display). */
export function timelineTotalSec(timeline: ProductionTimeline): number {
  return timelineLengthSec(timeline);
}


