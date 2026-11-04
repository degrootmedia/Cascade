/**
 * Multi-track timeline — the animatic editor's data model (Animatic Editor
 * Expansion, Item 1).
 *
 * Domain module of `shared/ipc.ts`; the barrel re-exports everything, so
 * `../shared/ipc.js` import paths work from both processes. Everything here
 * is pure: no filesystem, no id generation (callers inject `newId`), no DOM.
 *
 * ONE TIMELINE, THREE READERS: this model is the single source of truth the
 * preview player, the FFmpeg renderer, and every exporter read. A clip is a
 * non-destructive reference — a source media id (the media registry's stable
 * identity, with `srcRel` as path transport like generation takes), a source
 * in/out range, and a timeline position. Editing never touches source files.
 *
 * Track stacking: `tracks[0]` is the TOPMOST video track. At any moment the
 * topmost visible video clip shows; gaps show black. Audio tracks mix: every
 * audible clip plays together. Times are seconds; frame quantization happens
 * in the render layer (`segmentFrames` in main/assembly.ts), never here.
 */
import type { Production, ProductionShot } from "./production.js";
import { applyShotSequences, sanitizeVideoOffset } from "./shot-sequence.js";
import { mediaEntryForPath } from "../media-registry.js";
import { resolveShotDisplay } from "../selected-output.js";

export type TimelineTrackKind = "video" | "audio";

export interface TimelineTrack {
  id: string;
  kind: TimelineTrackKind;
  name: string;
  /** Locked tracks reject edits (enforced by the edit operations). */
  locked?: boolean;
  /** Track gain 0..1 multiplying every clip's volume (Item 7).
   *  Absent = unity. Applies to video tracks' embedded audio too. */
  volume?: number;
  /** Video: hidden tracks do not appear in preview or render. */
  hidden?: boolean;
  /** Audio: muted tracks are silent in preview and render. */
  muted?: boolean;
}

export type TimelineClipSourceKind = "video" | "audio" | "still" | "blank";
// (Track gain 0..1 lives on TimelineTrack.volume — Item 7; see trackVolume.)

export interface TimelineClip {
  id: string;
  trackId: string;
  sourceKind: TimelineClipSourceKind;
  /** Stable media-registry id of the source file (blank clips have none). */
  mediaId?: string;
  /** Workspace-relative source path — transport alongside `mediaId`, the
   *  same deal generation takes get; readers resolve id first. */
  srcRel?: string;
  /** Source in-point in seconds (video/audio clips). */
  sourceInSec?: number;
  /** Source out-point in seconds (video/audio clips). Duration is derived
   *  from the range, never stored separately. */
  sourceOutSec?: number;
  /** Held duration for still and blank clips, which have no source range. */
  holdSec?: number;
  /** Position on the timeline in seconds. */
  timelineStartSec: number;
  /** A video clip's embedded audio muted (the legacy shot `muted`). */
  muted?: boolean;
  /** Linear fade-in length in TIMELINE seconds from the clip start
   *  (Item 7). Absent = no fade. fadeIn + fadeOut never exceed the
   *  clip's duration (normalize and the setter clamp). */
  fadeInSec?: number;
  /** Linear fade-out length in timeline seconds to the clip end. */
  fadeOutSec?: number;
  /** Pitch handling when retimed (Item 7): absent = "preserve"
   *  (time-stretch, the default); "natural" = resample, so pitch
   *  shifts with speed — stored only when the user chooses it. */
  pitchMode?: "preserve" | "natural";
  /** Playback volume 0..1 (seeded beds; the audio model widens in Item 7). */
  volume?: number;
  name?: string;
  /** Provenance for clips seeded from the storyboard projection: the shot
   *  whose media seeded this clip. Identity is still the media ref — this
   *  only records where the seed came from. */
  shotId?: string;
  /** Provenance: the shot sequence whose output seeded this clip. */
  sequenceId?: string;
  /** For a sequence clip: the member shots it stands in for. */
  memberShotIds?: string[];
  /** Seeded audio beds keep their legacy bed role until Item 7's audio
   *  model lands, so the assembly plan can map them back exactly. */
  role?: "voiceover" | "music";
  /** Linked-clips group: clips sharing a linkId (typically a video clip
   *  and its detached audio) are selected and edited as one unit for
   *  split, trim, delete, and ripple. A group of one is meaningless —
   *  normalize and the edit ops prune singleton linkIds. */
  linkId?: string;
  /** Constant playback speed (Item 4): timeline duration is DERIVED as
   *  source range / speed, never stored beside it. Absent = 1x. Speed
   *  curves (Item 5) supersede this when present. Video/audio only. */
  speed?: number;
  /** Play the source range backwards (frames in reverse order in the
   *  render; preview may approximate). Video/audio only. */
  reversed?: boolean;
  /** Speed ramp (Item 5): keyframes anchored to the clip's TIMELINE
   *  position (adopted judgment), piecewise-linear between keyframes,
   *  constant extrapolation past the ends. Duration is the integral
   *  solve ∫speed dt = source range. When present, supersedes `speed`. */
  speedCurve?: SpeedKeyframe[];
  /** Retime interpolation in the render: absent = frame sampling
   *  (default); "blend"/"flow" = minterpolate blend / motion-compensated
   *  (slow renders — opt-in, per adopted judgment 4). */
  speedInterp?: "blend" | "flow";
}

/** One speed-ramp keyframe: at `atSec` seconds along the clip's timeline
 *  span, playback runs at `speed`. */
export interface SpeedKeyframe {
  atSec: number;
  speed: number;
}

/** A transition between two ADJACENT clips on the same video track
 *  (Item 8): pure timeline data — type, the two clip ids, duration.
 *  The edit point is DERIVED (outgoing end = incoming start) and the
 *  dissolve is CENTERED on it (adopted convention): the blend window
 *  is [edit − d/2, edit + d/2], fed by the incoming clip's pre-in
 *  handle and the outgoing clip's post-out handle. Clip positions and
 *  durations never change because a transition exists. */
export interface TimelineTransition {
  id: string;
  type: "dissolve";
  outgoingClipId: string;
  incomingClipId: string;
  durationSec: number;
}

export interface ProductionTimeline {
  version: 1;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  /** Dissolves between adjacent clips (Item 8). Absent = all cuts. */
  transitions?: TimelineTransition[];
  /** Explicit total timeline length in seconds, set from the toolbar
   *  length field. Readers use max(this, last clip end), so a longer
   *  value pads the tail with empty space and a stale shorter value
   *  never truncates clips. Absent = length is the last clip's end. */
  durationSec?: number;
}

export function emptyTimeline(): ProductionTimeline {
  return { version: 1, tracks: [], clips: [] };
}

// ---- derived timing ------------------------------------------------------------

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** A clip's timeline duration: the source range for video/audio, the held
 *  duration for stills and blanks. Unusable ranges read as 0. */
/** The constant speed FIELD only (1 when unset/unusable). */
function constantSpeedOf(clip: TimelineClip): number {
  const s = num(clip.speed);
  return s != null && s > 0 ? s : 1;
}

// ---- speed-ramp math (Item 5) ---------------------------------------------------
// Keyframes live in timeline-local seconds; speed(t) is piecewise-linear
// with constant extrapolation. All integrals are closed-form (trapezoids
// and one quadratic solve), so preview, render, and exporters agree to
// the frame by construction — they all call these functions.

/** Curve points for math: sorted, with a virtual head at t=0 when the
 *  first keyframe sits later (constant extrapolation covers [0, first)). */
function rampPoints(curve: readonly SpeedKeyframe[]): SpeedKeyframe[] {
  const pts = [...curve].sort((a, b) => a.atSec - b.atSec);
  if (pts.length && pts[0].atSec > 0) pts.unshift({ atSec: 0, speed: pts[0].speed });
  return pts;
}

/** Instantaneous speed of a raw curve at timeline-local `localSec`. */
export function speedCurveSpeedAt(curve: readonly SpeedKeyframe[], localSec: number): number {
  const pts = rampPoints(curve);
  if (!pts.length) return 1;
  if (localSec <= pts[0].atSec) return pts[0].speed;
  for (let i = 1; i < pts.length; i++) {
    if (localSec <= pts[i].atSec) {
      const a = pts[i - 1];
      const b = pts[i];
      const span = b.atSec - a.atSec;
      return span > 0 ? a.speed + ((b.speed - a.speed) * (localSec - a.atSec)) / span : b.speed;
    }
  }
  return pts[pts.length - 1].speed;
}

/** Source seconds consumed between timeline-local 0 and `localSec`
 *  (the integral of the curve; exact trapezoids). */
export function speedCurveIntegral(curve: readonly SpeedKeyframe[], localSec: number): number {
  const pts = rampPoints(curve);
  if (!pts.length || localSec <= 0) return 0;
  let acc = 0;
  let prevT = 0;
  let prevS = speedCurveSpeedAt(pts, 0);
  for (let i = 1; i <= pts.length; i++) {
    const segEnd = i < pts.length ? pts[i].atSec : Infinity;
    const t1 = Math.min(localSec, segEnd);
    if (t1 > prevT) {
      const s1 = speedCurveSpeedAt(pts, t1);
      acc += ((prevS + s1) / 2) * (t1 - prevT);
      prevT = t1;
      prevS = s1;
    }
    if (prevT >= localSec) break;
  }
  return acc;
}

/** Timeline duration at which the curve has consumed `rangeSec` of source. */
function rampDurationForRange(curve: readonly SpeedKeyframe[], rangeSec: number): number {
  const pts = rampPoints(curve);
  if (!pts.length || rangeSec <= 0) return 0;
  let remaining = rangeSec;
  let prevT = 0;
  let prevS = speedCurveSpeedAt(pts, 0);
  for (let i = 1; i <= pts.length; i++) {
    const segEnd = i < pts.length ? pts[i].atSec : Infinity;
    const s1 = i < pts.length ? pts[i].speed : prevS;
    const segLen = segEnd - prevT;
    const segSource = Number.isFinite(segLen) ? ((prevS + s1) / 2) * segLen : Infinity;
    if (remaining > segSource) {
      remaining -= segSource;
      prevT = segEnd;
      prevS = s1;
      continue;
    }
    // Solve prevS·Δ + k·Δ²/2 = remaining within this segment.
    const k = Number.isFinite(segLen) && segLen > 0 ? (s1 - prevS) / segLen : 0;
    if (Math.abs(k) < 1e-12) return prevT + remaining / prevS;
    const disc = prevS * prevS + 2 * k * remaining;
    return prevT + (-prevS + Math.sqrt(Math.max(0, disc))) / k;
  }
  return prevT;
}

/** A clip's effective speed: the constant field, or a ramp's average
 *  (range ÷ derived duration). Labels/notes read this; precise timing
 *  goes through clipSourceTimeAt. */
export function clipSpeed(clip: TimelineClip): number {
  if (clip.speedCurve?.length) {
    const inSec = num(clip.sourceInSec) ?? 0;
    const outSec = num(clip.sourceOutSec);
    if (outSec == null) return 1;
    const range = Math.max(0, outSec - inSec);
    const dur = rampDurationForRange(clip.speedCurve, range);
    return dur > 0 ? range / dur : 1;
  }
  return constantSpeedOf(clip);
}

/** Instantaneous speed at a timeline-local position (curve-aware). */
export function clipSpeedAt(clip: TimelineClip, localSec: number): number {
  return clip.speedCurve?.length ? speedCurveSpeedAt(clip.speedCurve, localSec) : constantSpeedOf(clip);
}

/** Source seconds consumed (play direction) up to a timeline-local time. */
function consumedAt(clip: TimelineClip, localSec: number): number {
  return clip.speedCurve?.length
    ? speedCurveIntegral(clip.speedCurve, Math.max(0, localSec))
    : Math.max(0, localSec) * constantSpeedOf(clip);
}

export function clipDurationSec(clip: TimelineClip): number {
  if (clip.sourceKind === "still" || clip.sourceKind === "blank") {
    const hold = num(clip.holdSec);
    return hold != null && hold > 0 ? hold : 0;
  }
  const inSec = num(clip.sourceInSec) ?? 0;
  const outSec = num(clip.sourceOutSec);
  if (outSec == null) return 0;
  const range = Math.max(0, outSec - inSec);
  return clip.speedCurve?.length ? rampDurationForRange(clip.speedCurve, range) : range / constantSpeedOf(clip);
}

// ---- audio gain (Item 7) ---------------------------------------------------------
// One gain definition read by preview and render alike: clip volume ×
// linear fades, in clip-local TIMELINE seconds (post-retime), so a fade
// drawn on a sped clip lasts its drawn seconds on the timeline.

/** A clip's own volume, clamped to 0..1 (absent = unity). */
export function clipVolume(clip: TimelineClip): number {
  const v = num(clip.volume);
  return v == null ? 1 : Math.max(0, Math.min(1, v));
}

/** A track's gain, clamped to 0..1 (absent = unity). */
export function trackVolume(track: TimelineTrack): number {
  const v = num(track.volume);
  return v == null ? 1 : Math.max(0, Math.min(1, v));
}

const fadeOf = (v: number | undefined): number => {
  const f = num(v);
  return f != null && f > 0 ? f : 0;
};

/** The timeline's effective total length: the last clip's end, or
 *  the explicit `durationSec` when that reaches further (empty tail). */
export function timelineLengthSec(t: ProductionTimeline): number {
  let end = 0;
  for (const c of t.clips) end = Math.max(end, clipEndSec(c));
  const explicit = num(t.durationSec) ?? 0;
  return Math.max(end, explicit);
}

/** Set the explicit total length (toolbar mm:ss field). A value at
 *  or before the last clip's end CLAMPS: the field is dropped and
 *  the length is exactly that end — clips are never truncated.
 *  A longer value pads empty space after the last clip. Returns
 *  the input unchanged when nothing would change. */
export function setTimelineDuration(t: ProductionTimeline, sec: number): ProductionTimeline {
  if (!Number.isFinite(sec) || sec < 0) return t;
  let lastEnd = 0;
  for (const c of t.clips) lastEnd = Math.max(lastEnd, clipEndSec(c));
  const next = structuredClone(t);
  if (sec <= lastEnd + 1e-9) delete next.durationSec;
  else next.durationSec = sec;
  return (next.durationSec ?? null) === (t.durationSec ?? null) ? t : next;
}

/** Format seconds as the length field's `mm:ss` (zero-padded;
 *  minutes keep counting past 59). Rounds to the nearest second. */
export function formatTimelineLength(totalSec: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(totalSec) ? totalSec : 0));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Parse the length field's text: `mm:ss` (minutes any size,
 *  seconds 0-59) or a plain number of seconds. Anything else is
 *  null — the field reverts to the current length. */
export function parseTimelineLength(text: string): number | null {
  const v = text.trim();
  if (!v) return null;
  const mmss = /^(\d+):([0-5]?\d)$/.exec(v);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  return null;
}

/** The clip's gain `localSec` into its timeline span: volume × fade-in
 *  × fade-out (linear). Muted clips and out-of-range times read 0.
 *  Track gain is the reader's to multiply (it owns the track). */
export function clipGainAt(clip: TimelineClip, localSec: number): number {
  if (clip.muted) return 0;
  const dur = clipDurationSec(clip);
  if (!(localSec >= 0) || localSec > dur) return 0;
  let g = clipVolume(clip);
  const fIn = fadeOf(clip.fadeInSec);
  if (fIn > 0 && localSec < fIn) g *= localSec / fIn;
  const fOut = fadeOf(clip.fadeOutSec);
  if (fOut > 0 && localSec > dur - fOut) g *= Math.max(0, (dur - localSec) / fOut);
  return g;
}

/** Clamp a fade pair so in+out fit the duration (fade-in wins the
 *  overlap, matching normalize and the editor's drag clamp). */
function clampFades(dur: number, fIn: number, fOut: number): { fadeInSec: number; fadeOutSec: number } {
  const fadeInSec = Math.max(0, Math.min(dur, fIn));
  return { fadeInSec, fadeOutSec: Math.max(0, Math.min(dur - fadeInSec, fOut)) };
}

/** The source timestamp showing `localSec` into the clip's timeline
 *  span (speed + reverse applied, clamped to the source range). */
export function clipSourceTimeAt(clip: TimelineClip, localSec: number): number {
  const inSec = num(clip.sourceInSec) ?? 0;
  const outSec = num(clip.sourceOutSec) ?? inSec;
  const consumed = consumedAt(clip, localSec);
  const t = clip.reversed ? outSec - consumed : inSec + consumed;
  return Math.max(inSec, Math.min(outSec, t));
}

/** Like clipSourceTimeAt but UNCLAMPED to the source range: times
 *  before the clip start / past its end extrapolate at the boundary
 *  speed — the handle material a centered dissolve plays (Item 8).
 *  Still floored at source 0. */
export function clipSourceTimeAtLoose(clip: TimelineClip, localSec: number): number {
  const inSec = num(clip.sourceInSec) ?? 0;
  const outSec = num(clip.sourceOutSec) ?? inSec;
  const range = Math.max(0, outSec - inSec);
  const dur = clipDurationSec(clip);
  const consumed =
    localSec < 0
      ? localSec * clipSpeedAt(clip, 0)
      : localSec > dur
        ? range + (localSec - dur) * clipSpeedAt(clip, dur)
        : consumedAt(clip, localSec);
  const t = clip.reversed ? outSec - consumed : inSec + consumed;
  return Math.max(0, t);
}

/** The source window a render span starting `intoClipSec` into the clip
 *  and lasting `spanDurSec` timeline seconds consumes. */
export function clipSourceWindowAt(clip: TimelineClip, intoClipSec: number, spanDurSec: number): { startSec: number; endSec: number } {
  const inSec = num(clip.sourceInSec) ?? 0;
  const outSec = num(clip.sourceOutSec) ?? inSec;
  const c0 = consumedAt(clip, intoClipSec);
  const c1 = consumedAt(clip, intoClipSec + Math.max(0, spanDurSec));
  return clip.reversed
    ? { startSec: Math.max(0, outSec - c1), endSec: outSec - c0 }
    : { startSec: inSec + c0, endSec: inSec + c1 };
}

/** The sub-curve covering a span of the clip, rebased to the span start
 *  with interpolated boundary keyframes at both ends (render spans and
 *  split halves). Undefined when the clip has no curve. */
export function speedCurveForSpan(clip: TimelineClip, intoClipSec: number, spanDurSec: number): SpeedKeyframe[] | undefined {
  if (!clip.speedCurve?.length) return undefined;
  const from = Math.max(0, intoClipSec);
  const to = from + Math.max(0, spanDurSec);
  const pts: SpeedKeyframe[] = [{ atSec: 0, speed: speedCurveSpeedAt(clip.speedCurve, from) }];
  for (const kf of rampPoints(clip.speedCurve)) {
    if (kf.atSec > from && kf.atSec < to) pts.push({ atSec: kf.atSec - from, speed: kf.speed });
  }
  pts.push({ atSec: Math.max(0, spanDurSec), speed: speedCurveSpeedAt(clip.speedCurve, to) });
  return pts;
}

/** Shift a curve in timeline time (head trims/splits), cropping at 0
 *  with an interpolated boundary keyframe. */
function shiftSpeedCurve(curve: readonly SpeedKeyframe[], bySec: number): SpeedKeyframe[] {
  const speedAt0 = speedCurveSpeedAt(curve, Math.max(0, -bySec));
  const shifted = rampPoints(curve)
    .map((p) => ({ atSec: p.atSec + bySec, speed: p.speed }))
    .filter((p) => p.atSec > 0);
  return [{ atSec: 0, speed: bySec < 0 ? speedAt0 : speedCurveSpeedAt(curve, 0) }, ...shifted];
}

/** Normalize a raw curve: usable points only, sorted, last-wins dedupe. */
function normalizeSpeedCurve(raw: unknown): SpeedKeyframe[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const byAt = new Map<number, number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const at = num(e.atSec);
    const sp = num(e.speed);
    if (at == null || at < 0 || sp == null || sp <= 0) continue;
    byAt.set(at, Math.min(100, sp));
  }
  if (!byAt.size) return undefined;
  return [...byAt.entries()].sort((a, b) => a[0] - b[0]).map(([atSec, speed]) => ({ atSec, speed }));
}

export function clipEndSec(clip: TimelineClip): number {
  const start = num(clip.timelineStartSec) ?? 0;
  return start + clipDurationSec(clip);
}

/** Clear linkIds left with fewer than two members (mutates the list). */
function pruneSingletonLinksInPlace(clips: TimelineClip[]): void {
  const counts = new Map<string, number>();
  for (const c of clips) if (c.linkId) counts.set(c.linkId, (counts.get(c.linkId) ?? 0) + 1);
  for (const c of clips) if (c.linkId && (counts.get(c.linkId) ?? 0) < 2) delete c.linkId;
}

/** Which source kinds a track of `kind` may carry. */
function trackAccepts(trackKind: TimelineTrackKind, sourceKind: TimelineClipSourceKind): boolean {
  return trackKind === "audio" ? sourceKind === "audio" : sourceKind !== "audio";
}

// ---- normalize (read repair) ---------------------------------------------------

const TRACK_KINDS: readonly string[] = ["video", "audio"];
const SOURCE_KINDS: readonly string[] = ["video", "audio", "still", "blank"];
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Read-side repair of a persisted timeline (it can come from an old or
 * hand-edited file): corrupt tracks/clips drop, ids dedupe (first wins,
 * so the oldest identity survives), numbers clamp to usable ranges,
 * source-less media clips and cross-kind placements drop, and overlaps on
 * a track resolve by keeping the earliest clip. `undefined` when the raw
 * value is not a v1 timeline at all — the field is additive, so absence is
 * the repair for a shape this build cannot trust (the magicBible deal).
 */
export function normalizeTimeline(raw: unknown): ProductionTimeline | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as { version?: unknown; tracks?: unknown; clips?: unknown };
  if (t.version !== 1 || !Array.isArray(t.tracks) || !Array.isArray(t.clips)) return undefined;

  const tracks: TimelineTrack[] = [];
  const trackById = new Map<string, TimelineTrack>();
  for (const entry of t.tracks) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = str(e.id);
    if (!id || trackById.has(id) || !TRACK_KINDS.includes(e.kind as string)) continue;
    const kind = e.kind as TimelineTrackKind;
    const track: TimelineTrack = {
      id,
      kind,
      name: str(e.name) ?? (kind === "video" ? "Video" : "Audio"),
      ...(e.locked === true ? { locked: true } : {}),
      ...(e.hidden === true ? { hidden: true } : {}),
      ...(e.muted === true ? { muted: true } : {}),
    };
    tracks.push(track);
    const tVol = num(e.volume);
    if (tVol != null && tVol !== 1) track.volume = Math.max(0, Math.min(1, tVol));
    trackById.set(id, track);
  }

  const seenClipIds = new Set<string>();
  const byTrack = new Map<string, TimelineClip[]>();
  for (const entry of t.clips) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = str(e.id);
    const trackId = str(e.trackId);
    const track = trackId ? trackById.get(trackId) : undefined;
    if (!id || seenClipIds.has(id) || !trackId || !track) continue;
    if (!SOURCE_KINDS.includes(e.sourceKind as string)) continue;
    const sourceKind = e.sourceKind as TimelineClipSourceKind;
    if (!trackAccepts(track.kind, sourceKind)) continue;
    const start = num(e.timelineStartSec);
    if (start == null) continue;
    const clip: TimelineClip = { id, trackId, sourceKind, timelineStartSec: Math.max(0, start) };
    if (sourceKind === "blank") {
      const hold = num(e.holdSec);
      if (hold == null || hold <= 0) continue;
      clip.holdSec = hold;
    } else if (sourceKind === "still") {
      const hold = num(e.holdSec);
      if (hold == null || hold <= 0) continue;
      if (!str(e.srcRel) && !str(e.mediaId)) continue;
      clip.holdSec = hold;
    } else {
      if (!str(e.srcRel) && !str(e.mediaId)) continue;
      const inSec = Math.max(0, num(e.sourceInSec) ?? 0);
      const outSec = num(e.sourceOutSec);
      if (outSec == null || outSec <= inSec) continue;
      clip.sourceInSec = inSec;
      clip.sourceOutSec = outSec;
    }
    if (sourceKind !== "blank") {
      if (str(e.mediaId)) clip.mediaId = str(e.mediaId);
      if (str(e.srcRel)) clip.srcRel = str(e.srcRel);
    }
    if (e.muted === true) clip.muted = true;
    const vol = num(e.volume);
    if (vol != null) clip.volume = Math.max(0, Math.min(1, vol));
    if (str(e.name)) clip.name = str(e.name);
    if (str(e.shotId)) clip.shotId = str(e.shotId);
    if (str(e.sequenceId)) clip.sequenceId = str(e.sequenceId);
    if (Array.isArray(e.memberShotIds)) {
      const members = e.memberShotIds.filter((x): x is string => typeof x === "string" && !!x);
      if (members.length) clip.memberShotIds = members;
    }
    if (e.role === "voiceover" || e.role === "music") clip.role = e.role;
    if (str(e.linkId)) clip.linkId = str(e.linkId);
    if (sourceKind === "video" || sourceKind === "audio") {
      const curve = normalizeSpeedCurve(e.speedCurve);
      if (curve && !curve.every((k) => k.speed === curve[0].speed)) {
        clip.speedCurve = curve; // supersedes the constant field
      } else {
        // No curve, or a constant one: collapse to the sparse speed field.
        const sp = curve ? curve[0].speed : num(e.speed);
        if (sp != null && sp > 0 && sp !== 1) clip.speed = Math.min(100, sp);
      }
      if (e.reversed === true) clip.reversed = true;
      if (e.speedInterp === "blend" || e.speedInterp === "flow") clip.speedInterp = e.speedInterp;
      if (e.pitchMode === "natural") clip.pitchMode = "natural"; // preserve = absent
      const fades = clampFades(clipDurationSec(clip), fadeOf(num(e.fadeInSec)), fadeOf(num(e.fadeOutSec)));
      if (fades.fadeInSec > 0) clip.fadeInSec = fades.fadeInSec;
      if (fades.fadeOutSec > 0) clip.fadeOutSec = fades.fadeOutSec;
    }
    seenClipIds.add(id);
    const list = byTrack.get(trackId) ?? [];
    list.push(clip);
    byTrack.set(trackId, list);
  }

  // Per track: order by start (id as the tie-break so repair is
  // deterministic), then drop any clip that starts before the previous
  // kept clip ends — overlaps can never persist.
  const clips: TimelineClip[] = [];
  for (const track of tracks) {
    const list = (byTrack.get(track.id) ?? []).sort(
      (a, b) => a.timelineStartSec - b.timelineStartSec || a.id.localeCompare(b.id)
    );
    let end = 0;
    for (const clip of list) {
      if (clip.timelineStartSec < end) continue;
      clips.push(clip);
      end = clipEndSec(clip);
    }
  }
  pruneSingletonLinksInPlace(clips);
  // Transitions (Item 8): keep only dissolves joining two surviving,
  // same-track, exactly-adjacent clips; clamp to the extent fit
  // (handles are a probe-time concern, checked when set/rendered).
  const clipById = new Map(clips.map((c) => [c.id, c]));
  const transitions: TimelineTransition[] = [];
  const seenTrIds = new Set<string>();
  const seenOutgoing = new Set<string>();
  const rawTransitions = (t as { transitions?: unknown }).transitions;
  if (Array.isArray(rawTransitions)) {
    for (const entry of rawTransitions) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const id = str(e.id);
      const out = str(e.outgoingClipId) ? clipById.get(str(e.outgoingClipId)!) : undefined;
      const inc = str(e.incomingClipId) ? clipById.get(str(e.incomingClipId)!) : undefined;
      const dur = num(e.durationSec);
      if (!id || seenTrIds.has(id) || e.type !== "dissolve" || !out || !inc || dur == null || dur <= 0) continue;
      if (out.trackId !== inc.trackId || seenOutgoing.has(out.id)) continue;
      if (Math.abs(inc.timelineStartSec - clipEndSec(out)) > 1e-6) continue;
      const fit = 2 * Math.min(clipDurationSec(out), clipDurationSec(inc));
      const clamped = Math.min(dur, fit);
      if (!(clamped > 0)) continue;
      seenTrIds.add(id);
      seenOutgoing.add(out.id);
      transitions.push({ id, type: "dissolve", outgoingClipId: out.id, incomingClipId: inc.id, durationSec: clamped });
    }
  }
  const durationSec = num((t as { durationSec?: unknown }).durationSec);
  return {
    version: 1, tracks, clips,
    ...(transitions.length ? { transitions } : {}),
    ...(durationSec != null && durationSec > 0 ? { durationSec } : {}),
  };
}

// ---- validate ------------------------------------------------------------------

/** Structural problems with a timeline, as messages naming the offender.
 *  An empty list means the model satisfies every invariant the edit
 *  operations maintain: unique ids, clips on real same-kind tracks,
 *  usable ranges, and no overlaps. */
export function validateTimeline(t: ProductionTimeline): string[] {
  const errs: string[] = [];
  const trackById = new Map<string, TimelineTrack>();
  for (const track of t.tracks) {
    if (!track.id || trackById.has(track.id)) errs.push(`duplicate or missing track id "${track.id ?? ""}"`);
    else trackById.set(track.id, track);
    if (track.volume != null && !(track.volume >= 0 && track.volume <= 1)) errs.push(`track "${track.id}" volume out of range`);
  }
  const clipIds = new Set<string>();
  const byTrack = new Map<string, TimelineClip[]>();
  for (const clip of t.clips) {
    if (!clip.id || clipIds.has(clip.id)) errs.push(`duplicate or missing clip id "${clip.id ?? ""}"`);
    clipIds.add(clip.id);
    const track = trackById.get(clip.trackId);
    if (!track) {
      errs.push(`clip "${clip.id}" sits on missing track "${clip.trackId}"`);
      continue;
    }
    if (!trackAccepts(track.kind, clip.sourceKind)) {
      errs.push(`clip "${clip.id}" (${clip.sourceKind}) sits on ${track.kind} track "${track.id}"`);
    }
    if (clip.speedCurve) {
      const bad = clip.speedCurve.some(
        (k, i) => !(k.atSec >= 0) || !(k.speed > 0) || (i > 0 && k.atSec <= clip.speedCurve![i - 1].atSec)
      );
      if (bad) errs.push(`clip "${clip.id}" has an unusable speed curve`);
    }
    const fIn = fadeOf(clip.fadeInSec);
    const fOut = fadeOf(clip.fadeOutSec);
    if ((clip.fadeInSec != null && !(clip.fadeInSec >= 0)) || (clip.fadeOutSec != null && !(clip.fadeOutSec >= 0)) || fIn + fOut > clipDurationSec(clip) + 1e-9) {
      errs.push(`clip "${clip.id}" has fades exceeding its duration`);
    }
    if (clip.pitchMode != null && clip.pitchMode !== "preserve" && clip.pitchMode !== "natural") {
      errs.push(`clip "${clip.id}" has an unknown pitch mode`);
    }
    if (clip.linkId && t.clips.filter((c) => c.linkId === clip.linkId).length < 2) {
      errs.push(`clip "${clip.id}" carries singleton linkId "${clip.linkId}"`);
    }
    if (!(clip.timelineStartSec >= 0) || clipDurationSec(clip) <= 0) {
      errs.push(`clip "${clip.id}" has an unusable range`);
    }
    const list = byTrack.get(clip.trackId) ?? [];
    list.push(clip);
    byTrack.set(clip.trackId, list);
  }
  for (const [trackId, list] of byTrack) {
    const sorted = [...list].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].timelineStartSec < clipEndSec(sorted[i - 1])) {
        errs.push(`clips "${sorted[i - 1].id}" and "${sorted[i].id}" overlap on track "${trackId}"`);
      }
    }
  }
  const trIds = new Set<string>();
  const byId = new Map(t.clips.map((c) => [c.id, c]));
  for (const tr of t.transitions ?? []) {
    if (!tr.id || trIds.has(tr.id)) errs.push(`duplicate or missing transition id "${tr.id ?? ""}"`);
    trIds.add(tr.id);
    const out = byId.get(tr.outgoingClipId);
    const inc = byId.get(tr.incomingClipId);
    if (!out || !inc) {
      errs.push(`transition "${tr.id}" references a missing clip`);
      continue;
    }
    if (tr.type !== "dissolve" || !(tr.durationSec > 0)) errs.push(`transition "${tr.id}" is not a usable dissolve`);
    if (out.trackId !== inc.trackId || Math.abs(inc.timelineStartSec - clipEndSec(out)) > 1e-6) {
      errs.push(`transition "${tr.id}" does not join adjacent clips on one track`);
    }
    if (tr.durationSec > 2 * Math.min(clipDurationSec(out), clipDurationSec(inc)) + 1e-9) {
      errs.push(`transition "${tr.id}" exceeds the clips it joins`);
    }
  }
  return errs;
}



// ---- resolver (the one flattening every reader shares) --------------------------

export interface ResolvedVideoSpan {
  /** The showing clip, or null for a black gap. */
  clip: TimelineClip | null;
  track: TimelineTrack | null;
  startSec: number;
  endSec: number;
}

export interface ResolvedAudioClip {
  clip: TimelineClip;
  track: TimelineTrack;
  startSec: number;
  endSec: number;
}

export interface ResolvedBlendSpan {
  transition: TimelineTransition;
  outgoing: TimelineClip;
  incoming: TimelineClip;
  track: TimelineTrack;
  editSec: number;
  startSec: number;
  endSec: number;
}

export interface ResolvedTimeline {
  /** Contiguous spans partitioning [0, video extent]: the topmost visible
   *  clip at each moment, gaps as null-clip spans. */
  videoSpans: ResolvedVideoSpan[];
  /** Audible audio clips (unmuted tracks), in start order. */
  audioClips: ResolvedAudioClip[];
  /** Centered blend windows whose two clips are the ones actually
   *  showing around the edit (Item 8); covered edits yield none. */
  blendSpans: ResolvedBlendSpan[];
  /** Timeline length: the last clip end across ALL tracks and clips,
   *  hidden/muted included — hiding is not deleting. */
  totalSec: number;
}

/**
 * Flatten the model the way every reader needs it: video reduced to the
 * topmost visible clip per span (`tracks[0]` is topmost; hidden tracks
 * never show), audio as the audible clip list (muted tracks excluded).
 * Pure and total — any timeline `normalizeTimeline` kept resolves cleanly.
 */
export function resolveTimeline(t: ProductionTimeline): ResolvedTimeline {
  const trackById = new Map(t.tracks.map((x) => [x.id, x]));
  let totalSec = 0;
  let videoExtent = 0;
  for (const clip of t.clips) {
    const end = clipEndSec(clip);
    if (end > totalSec) totalSec = end;
    if (trackById.get(clip.trackId)?.kind === "video" && end > videoExtent) videoExtent = end;
  }

  // Explicit length (toolbar mm:ss field) extends the timeline past
  // the last clip with empty space; it never shortens it.
  const explicitSec = num(t.durationSec) ?? 0;
  if (explicitSec > totalSec) totalSec = explicitSec;
  const spanExtent = Math.max(videoExtent, explicitSec);

  const visibleVideo = t.clips.filter((c) => {
    const track = trackById.get(c.trackId);
    return track?.kind === "video" && !track.hidden;
  });
  const videoSpans: ResolvedVideoSpan[] = [];
  if (spanExtent > 0) {
    const bounds = new Set<number>([0, spanExtent]);
    for (const c of visibleVideo) {
      bounds.add(Math.min(c.timelineStartSec, spanExtent));
      bounds.add(Math.min(clipEndSec(c), spanExtent));
    }
    const points = [...bounds].sort((a, b) => a - b);
    // Topmost first: walk tracks in model order and take the first cover.
    const orderedTracks = t.tracks.filter((x) => x.kind === "video" && !x.hidden);
    for (let i = 0; i + 1 < points.length; i++) {
      const startSec = points[i];
      const endSec = points[i + 1];
      if (endSec <= startSec) continue;
      let clip: TimelineClip | null = null;
      let track: TimelineTrack | null = null;
      for (const tr of orderedTracks) {
        const hit = visibleVideo.find(
          (c) => c.trackId === tr.id && c.timelineStartSec <= startSec && clipEndSec(c) >= endSec
        );
        if (hit) {
          clip = hit;
          track = tr;
          break;
        }
      }
      const last = videoSpans[videoSpans.length - 1];
      if (last && last.clip === clip && last.endSec === startSec) last.endSec = endSec;
      else videoSpans.push({ clip, track, startSec, endSec });
    }
  }

  const audioClips: ResolvedAudioClip[] = t.clips
    .filter((c) => {
      const track = trackById.get(c.trackId);
      return track?.kind === "audio" && !track.muted;
    })
    .map((clip) => ({
      clip,
      track: trackById.get(clip.trackId)!,
      startSec: clip.timelineStartSec,
      endSec: clipEndSec(clip),
    }))
    .sort((a, b) => a.startSec - b.startSec || a.clip.id.localeCompare(b.clip.id));

  const blendSpans: ResolvedBlendSpan[] = [];
  const clipById = new Map(t.clips.map((c) => [c.id, c]));
  for (const tr of t.transitions ?? []) {
    const out = clipById.get(tr.outgoingClipId);
    const inc = clipById.get(tr.incomingClipId);
    if (!out || !inc || out.trackId !== inc.trackId) continue;
    const editSec = clipEndSec(out);
    if (Math.abs(inc.timelineStartSec - editSec) > 1e-6) continue;
    const i = videoSpans.findIndex((s) => s.clip === out && Math.abs(s.endSec - editSec) < 1e-9);
    if (i < 0 || videoSpans[i + 1]?.clip !== inc) continue;
    const track = trackById.get(out.trackId);
    if (!track) continue;
    blendSpans.push({
      transition: tr, outgoing: out, incoming: inc, track, editSec,
      startSec: editSec - tr.durationSec / 2, endSec: editSec + tr.durationSec / 2,
    });
  }
  blendSpans.sort((a, b) => a.startSec - b.startSec);

  return { videoSpans, audioClips, totalSec, blendSpans };
}

// ---- track operations (pure; the input is never mutated) -------------------------

export function addTrack(t: ProductionTimeline, track: TimelineTrack): ProductionTimeline {
  const next = structuredClone(t);
  if (!next.tracks.some((x) => x.id === track.id)) next.tracks.push({ ...track });
  return next;
}

/** Place an imported audio file as a clip (Item 2: all audio lives on
 *  tracks). Tries the playhead on each existing audio track in order
 *  (first track where [atSec, atSec+duration) is free), then the end of
 *  the first audio track, and only creates a new audio track when the
 *  timeline has none. Locked tracks are skipped. Returns the next
 *  timeline plus the placed clip's id (null clipId when the duration
 *  is unusable — caller should not have offered the import). */
export function addImportedAudioClip(
  t: ProductionTimeline,
  input: { srcRel: string; name?: string; durationSec: number; mediaId?: string },
  atSec: number,
  newId: () => string
): { timeline: ProductionTimeline; clipId: string | null } {
  const dur = input.durationSec;
  if (!input.srcRel || !(dur > 0)) return { timeline: t, clipId: null };
  const start = Math.max(0, atSec);
  const next = structuredClone(t);
  const fitsAt = (trackId: string, from: number): boolean =>
    !next.clips.some(
      (c) => c.trackId === trackId && c.timelineStartSec < from + dur - EPS && clipEndSec(c) > from + EPS
    );
  const audioTracks = next.tracks.filter((tr) => tr.kind === "audio" && !tr.locked);
  let trackId: string | undefined;
  let placeAt = start;
  for (const tr of audioTracks) {
    if (fitsAt(tr.id, start)) {
      trackId = tr.id;
      break;
    }
  }
  if (!trackId && audioTracks.length) {
    const tr = audioTracks[0];
    trackId = tr.id;
    placeAt = next.clips
      .filter((c) => c.trackId === tr.id)
      .reduce((m, c) => Math.max(m, clipEndSec(c)), start);
  }
  if (!trackId) {
    const n = next.tracks.filter((tr) => tr.kind === "audio").length + 1;
    const tr: TimelineTrack = { id: newId(), kind: "audio", name: `A${n}` };
    next.tracks.push(tr);
    trackId = tr.id;
  }
  const clip: TimelineClip = {
    id: newId(),
    trackId,
    sourceKind: "audio",
    srcRel: input.srcRel,
    sourceInSec: 0,
    sourceOutSec: dur,
    timelineStartSec: placeAt,
    ...(input.name ? { name: input.name } : {}),
    ...(input.mediaId ? { mediaId: input.mediaId } : {}),
  };
  next.clips.push(clip);
  next.clips.sort((a, b) => a.timelineStartSec - b.timelineStartSec || a.id.localeCompare(b.id));
  return { timeline: next, clipId: clip.id };
}

export function removeTrack(t: ProductionTimeline, trackId: string): ProductionTimeline {
  const next = structuredClone(t);
  next.tracks = next.tracks.filter((x) => x.id !== trackId);
  next.clips = next.clips.filter((c) => c.trackId !== trackId);
  return next;
}

function patchTrack(
  t: ProductionTimeline,
  trackId: string,
  patch: Partial<Pick<TimelineTrack, "name" | "locked" | "hidden" | "muted">>
): ProductionTimeline {
  const next = structuredClone(t);
  const track = next.tracks.find((x) => x.id === trackId);
  if (track) Object.assign(track, patch);
  return next;
}

export function renameTrack(t: ProductionTimeline, trackId: string, name: string): ProductionTimeline {
  return patchTrack(t, trackId, { name });
}
export function setTrackLocked(t: ProductionTimeline, trackId: string, locked: boolean): ProductionTimeline {
  return patchTrack(t, trackId, { locked: locked || undefined });
}
export function setTrackHidden(t: ProductionTimeline, trackId: string, hidden: boolean): ProductionTimeline {
  return patchTrack(t, trackId, { hidden: hidden || undefined });
}
export function setTrackMuted(t: ProductionTimeline, trackId: string, muted: boolean): ProductionTimeline {
  return patchTrack(t, trackId, { muted: muted || undefined });
}

/**
 * Set a track's gain (Item 7): clamped to 0..1, stored sparse (unity
 * disappears). Locking gates clip edits, not track mixing controls.
 */
export function setTrackVolume(t: ProductionTimeline, trackId: string, volume: number): ProductionTimeline {
  const next = structuredClone(t);
  const track = next.tracks.find((x) => x.id === trackId);
  if (track) {
    const v = Math.max(0, Math.min(1, volume));
    if (v === 1 || !Number.isFinite(v)) delete track.volume;
    else track.volume = v;
  }
  return next;
}

/**
 * Move a clip to another track of the same kind, keeping its timeline
 * position. Returns null when the move is refused: missing clip/track,
 * either track locked, a cross-kind target, or an overlap at the
 * destination. Moving to the clip's own track is a successful no-op.
 */
export function moveClipToTrack(
  t: ProductionTimeline,
  clipId: string,
  trackId: string
): ProductionTimeline | null {
  const clip = t.clips.find((c) => c.id === clipId);
  const target = t.tracks.find((x) => x.id === trackId);
  if (!clip || !target) return null;
  if (clip.trackId === trackId) return structuredClone(t);
  const source = t.tracks.find((x) => x.id === clip.trackId);
  if (source?.locked || target.locked) return null;
  if (!trackAccepts(target.kind, clip.sourceKind)) return null;
  const start = clip.timelineStartSec;
  const end = clipEndSec(clip);
  const clash = t.clips.some(
    (c) => c.trackId === trackId && c.timelineStartSec < end && start < clipEndSec(c)
  );
  if (clash) return null;
  const next = structuredClone(t);
  next.clips.find((c) => c.id === clipId)!.trackId = trackId;
  return next;
}

// ---- edit operations (pure; one call = one undo step) ---------------------------
/**
 * The standard edit operations (Item 2). Every op returns a fresh
 * timeline (the input is never mutated) or null when the edit is refused
 * (missing clip, locked track, an inapplicable target). Drag-style ops
 * CLAMP to the nearest legal result instead of refusing: no operation can
 * produce overlapping clips, a negative duration, or — where the caller
 * supplies source durations — a source range outside its source.
 * Deltas are seconds. Linked partners join split/trim/delete/ripple by
 * default (the spec's list); slip/roll/slide/move act on the named
 * clip(s) only. Split carries no speed curve yet (Item 5 owns cutting
 * curves). Ripple is an op option here; the UI's ripple toggle (Item 3)
 * passes it through.
 */

const EPS = 1e-6;

export interface TimelineEditOpts {
  /** Real source lengths keyed by media id (or srcRel when no id), used
   *  to clamp source ranges. Unknown length = unbounded above, like the
   *  legacy slip (the probe may still be pending). */
  sourceDurationsSec?: Readonly<Record<string, number>>;
  /** Default true: linked partners join the edit as one unit. */
  includeLinked?: boolean;
  /** Ripple scope: every track (the spec default — sync cannot drift)
   *  or just the edited clips' tracks. Absent = no ripple. */
  ripple?: "all" | "track";
}

function sourceDurationOf(clip: TimelineClip, opts: TimelineEditOpts): number | undefined {
  const key = clip.mediaId ?? clip.srcRel;
  const d = key ? opts.sourceDurationsSec?.[key] : undefined;
  return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : undefined;
}
function clipLocked(t: ProductionTimeline, clip: TimelineClip): boolean {
  return !!t.tracks.find((x) => x.id === clip.trackId)?.locked;
}
function trackClipsSorted(t: ProductionTimeline, trackId: string): TimelineClip[] {
  return t.clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec || a.id.localeCompare(b.id));
}
function neighborsOf(t: ProductionTimeline, clip: TimelineClip): { prev?: TimelineClip; next?: TimelineClip } {
  const list = trackClipsSorted(t, clip.trackId);
  const i = list.findIndex((c) => c.id === clip.id);
  return { prev: i > 0 ? list[i - 1] : undefined, next: i >= 0 && i + 1 < list.length ? list[i + 1] : undefined };
}
/** Keep a clone's clips in track-then-start order (deterministic
 *  output) and re-clamp fades to final durations — every duration-
 *  changing op finalizes through here, so a trim/speed change can
 *  never leave fades overrunning a shrunken clip. */
function sortTimelineClipsInPlace(t: ProductionTimeline): void {
  pruneTransitionsInPlace(t);
  for (const c of t.clips) {
    if (c.fadeInSec == null && c.fadeOutSec == null) continue;
    const fades = clampFades(clipDurationSec(c), fadeOf(c.fadeInSec), fadeOf(c.fadeOutSec));
    if (fades.fadeInSec > 0) c.fadeInSec = fades.fadeInSec;
    else delete c.fadeInSec;
    if (fades.fadeOutSec > 0) c.fadeOutSec = fades.fadeOutSec;
    else delete c.fadeOutSec;
  }
  const order = new Map(t.tracks.map((x, i) => [x.id, i]));
  t.clips.sort(
    (a, b) =>
      (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) ||
      a.timelineStartSec - b.timelineStartSec ||
      a.id.localeCompare(b.id)
  );
}

/** The link group containing `clipId` (itself included), or just itself. */
export function linkedClipIds(t: ProductionTimeline, clipId: string): string[] {
  const clip = t.clips.find((c) => c.id === clipId);
  if (!clip) return [];
  if (!clip.linkId) return [clipId];
  return t.clips.filter((c) => c.linkId === clip.linkId).map((c) => c.id);
}
function expandLinked(t: ProductionTimeline, ids: readonly string[], opts: TimelineEditOpts): string[] {
  if (opts.includeLinked === false) return [...new Set(ids)];
  const out = new Set<string>();
  for (const id of ids) for (const g of linkedClipIds(t, id)) out.add(g);
  return [...out];
}

/** How far a clip's tail may extend in TIMELINE seconds: the source
 *  material past the play-end bound at the marginal (end) speed.
 *  Reversed clips extend towards the source start. */
function tailExtendCapacity(clip: TimelineClip, opts: TimelineEditOpts): number {
  if (clip.sourceKind === "still" || clip.sourceKind === "blank") return Infinity;
  const srcDur = sourceDurationOf(clip, opts);
  const edgeSpeed = clipSpeedAt(clip, clipDurationSec(clip));
  if (clip.reversed) return Math.max(0, clip.sourceInSec ?? 0) / edgeSpeed;
  return srcDur != null ? Math.max(0, srcDur - (clip.sourceOutSec ?? 0)) / edgeSpeed : Infinity;
}
/** How far a clip's head may extend in TIMELINE seconds: the source
 *  material before the play-start bound at the marginal (start) speed.
 *  Reversed clips extend towards the source end (needs the length). */
function headExtendCapacity(clip: TimelineClip, opts: TimelineEditOpts): number {
  if (clip.sourceKind === "still" || clip.sourceKind === "blank") return Infinity;
  const edgeSpeed = clipSpeedAt(clip, 0);
  if (clip.reversed) {
    const srcDur = sourceDurationOf(clip, opts);
    return srcDur != null ? Math.max(0, srcDur - (clip.sourceOutSec ?? 0)) / edgeSpeed : Infinity;
  }
  return Math.max(0, clip.sourceInSec ?? 0) / edgeSpeed;
}
/** Set a clip's duration by recomputing its play-end source bound from
 *  the (curve-aware) integral; the play-start bound stays fixed. */
function setPlayEndForDurationInPlace(clip: TimelineClip, newDurSec: number): void {
  const dur = Math.max(0, newDurSec);
  if (clip.sourceKind === "still" || clip.sourceKind === "blank") {
    clip.holdSec = dur;
    return;
  }
  const consumed = consumedAt(clip, dur);
  if (clip.reversed) clip.sourceInSec = Math.max(0, (clip.sourceOutSec ?? 0) - consumed);
  else clip.sourceOutSec = (clip.sourceInSec ?? 0) + consumed;
}

/** Grow/shrink a clip's tail by a TIMELINE delta (integral-exact). */
function extendTailInPlace(clip: TimelineClip, byTimelineSec: number): void {
  setPlayEndForDurationInPlace(clip, clipDurationSec(clip) + byTimelineSec);
}

/** Head trim by a signed duration delta: the play-end source bound
 *  stays fixed, the curve shifts with the head (cropped at 0), and the
 *  play-start bound recomputes from the shifted curve's integral. The
 *  caller owns any timelineStart change (non-ripple anchoring). */
function applyHeadTrimInPlace(clip: TimelineClip, durationDelta: number): void {
  const newDur = clipDurationSec(clip) + durationDelta;
  if (clip.sourceKind === "still" || clip.sourceKind === "blank") {
    clip.holdSec = Math.max(0, newDur);
    return;
  }
  if (clip.speedCurve?.length) clip.speedCurve = shiftSpeedCurve(clip.speedCurve, durationDelta);
  const consumed = consumedAt(clip, Math.max(0, newDur));
  if (clip.reversed) clip.sourceOutSec = (clip.sourceInSec ?? 0) + consumed;
  else clip.sourceInSec = Math.max(0, (clip.sourceOutSec ?? 0) - consumed);
}
function rippleScopeTracks(t: ProductionTimeline, targets: TimelineClip[], ripple: "all" | "track"): Set<string> {
  return ripple === "all" ? new Set(t.tracks.map((x) => x.id)) : new Set(targets.map((c) => c.trackId));
}
/** Clamp a negative ripple shift so no shifted clip overruns the last
 *  unshifted clip (or timeline 0) on its track — spanning clips hold. */
function clampRipplePull(t: ProductionTimeline, boundary: number, delta: number, scope: ReadonlySet<string>, exclude: ReadonlySet<string>): number {
  if (delta >= 0) return delta;
  let d = delta;
  for (const trackId of scope) {
    const list = trackClipsSorted(t, trackId);
    const first = list.find((c) => !exclude.has(c.id) && c.timelineStartSec >= boundary - EPS);
    if (!first) continue;
    let prevEnd = 0;
    for (const c of list) {
      if (exclude.has(c.id) || c.timelineStartSec >= boundary - EPS) continue;
      prevEnd = Math.max(prevEnd, clipEndSec(c));
    }
    d = Math.max(d, -(first.timelineStartSec - prevEnd));
  }
  return d;
}
function shiftSuffixInPlace(t: ProductionTimeline, boundary: number, delta: number, scope: ReadonlySet<string>, exclude: ReadonlySet<string>): void {
  if (delta === 0) return;
  for (const c of t.clips) {
    if (!scope.has(c.trackId) || exclude.has(c.id)) continue;
    if (c.timelineStartSec >= boundary - EPS) c.timelineStartSec += delta;
  }
}

// ---- split ----------------------------------------------------------------------

/** Cut one clip of a (cloned, mutable) timeline at `atSec`; returns the
 *  new right half, or null when the point is not strictly inside. */
function splitClipInPlace(t: ProductionTimeline, clip: TimelineClip, atSec: number, newId: (prefix: string) => string): TimelineClip | null {
  const start = clip.timelineStartSec;
  const end = clipEndSec(clip);
  if (atSec <= start + EPS || atSec >= end - EPS) return null;
  const right: TimelineClip = { ...clip, id: newId("clp"), timelineStartSec: atSec };
  if (clip.sourceKind === "still" || clip.sourceKind === "blank") {
    clip.holdSec = atSec - start;
    right.holdSec = end - atSec;
  } else if (clip.reversed) {
    // Reversed playback runs out→in: the left half keeps the source
    // nearest the out-point, the right half the remainder towards in.
    const boundary = (clip.sourceOutSec ?? 0) - consumedAt(clip, atSec - start);
    right.sourceOutSec = boundary;
    clip.sourceInSec = boundary;
  } else {
    const srcAt = (clip.sourceInSec ?? 0) + consumedAt(clip, atSec - start);
    right.sourceInSec = srcAt;
    clip.sourceOutSec = srcAt;
  }
  if (clip.speedCurve?.length) {
    // The cut cuts the curve: each half keeps its own span of it.
    const leftCurve = speedCurveForSpan(clip, 0, atSec - start);
    const rightCurve = speedCurveForSpan(clip, atSec - start, end - atSec);
    if (leftCurve) clip.speedCurve = leftCurve;
    if (rightCurve) right.speedCurve = rightCurve;
  }
  // Fades (Item 7): the left half keeps the fade-in, the right the fade-out.
  const leftFades = clampFades(clipDurationSec(clip), fadeOf(clip.fadeInSec), 0);
  if (leftFades.fadeInSec > 0) clip.fadeInSec = leftFades.fadeInSec;
  else delete clip.fadeInSec;
  delete clip.fadeOutSec;
  const rightFades = clampFades(clipDurationSec(right), 0, fadeOf(right.fadeOutSec));
  delete right.fadeInSec;
  if (rightFades.fadeOutSec > 0) right.fadeOutSec = rightFades.fadeOutSec;
  else delete right.fadeOutSec;
  // A dissolve off the split clip rides its right half (the half that
  // still touches the incoming clip); one INTO it stays on the left.
  for (const tr of t.transitions ?? []) {
    if (tr.outgoingClipId === clip.id) tr.outgoingClipId = right.id;
  }
  t.clips.push(right);
  return right;
}

/**
 * Split a clip at a timeline point into two clips covering the same
 * total range with no gap or overlap. Linked partners containing the
 * point split with it; their right halves form a fresh link group.
 */
export function splitClipAt(
  t: ProductionTimeline,
  clipId: string,
  atSec: number,
  newId: (prefix: string) => string,
  opts: TimelineEditOpts = {}
): ProductionTimeline | null {
  const primary = t.clips.find((c) => c.id === clipId);
  if (!primary || clipLocked(t, primary)) return null;
  if (atSec <= primary.timelineStartSec + EPS || atSec >= clipEndSec(primary) - EPS) return null;
  const group = expandLinked(t, [clipId], opts)
    .map((id) => t.clips.find((c) => c.id === id))
    .filter((c): c is TimelineClip => !!c);
  if (group.some((c) => clipLocked(t, c))) return null;
  const next = structuredClone(t);
  const rights: TimelineClip[] = [];
  for (const member of group) {
    const c = next.clips.find((x) => x.id === member.id)!;
    const r = splitClipInPlace(next, c, atSec, newId);
    if (r) rights.push(r);
  }
  if (!rights.some((r) => r.timelineStartSec === atSec)) return null;
  if (rights.length > 1) {
    const link = newId("lnk");
    for (const r of rights) r.linkId = link;
  } else if (rights.length === 1) {
    // A solo split-off half no longer aligns with any unsplit partner.
    delete rights[0].linkId;
  }
  pruneSingletonLinksInPlace(next.clips);
  sortTimelineClipsInPlace(next);
  return next;
}

/**
 * Split every clip under the playhead (the split-at-playhead command).
 * Locked tracks are skipped; `trackIds` narrows the cut to those tracks.
 * Null when nothing was cut.
 */
export function splitAtPlayhead(
  t: ProductionTimeline,
  atSec: number,
  newId: (prefix: string) => string,
  opts: { trackIds?: readonly string[] } = {}
): ProductionTimeline | null {
  const next = structuredClone(t);
  const rightsByOldLink = new Map<string, TimelineClip[]>();
  let cut = false;
  for (const track of next.tracks) {
    if (track.locked) continue;
    if (opts.trackIds && !opts.trackIds.includes(track.id)) continue;
    const clip = next.clips.find(
      (c) => c.trackId === track.id && atSec > c.timelineStartSec + EPS && atSec < clipEndSec(c) - EPS
    );
    if (!clip) continue;
    const oldLink = clip.linkId;
    const r = splitClipInPlace(next, clip, atSec, newId);
    if (!r) continue;
    cut = true;
    if (oldLink) {
      const list = rightsByOldLink.get(oldLink) ?? [];
      list.push(r);
      rightsByOldLink.set(oldLink, list);
    }
  }
  if (!cut) return null;
  for (const rights of rightsByOldLink.values()) {
    if (rights.length > 1) {
      const link = newId("lnk");
      for (const r of rights) r.linkId = link;
    } else {
      delete rights[0].linkId;
    }
  }
  pruneSingletonLinksInPlace(next.clips);
  sortTimelineClipsInPlace(next);
  return next;
}

// ---- trim -----------------------------------------------------------------------

/** Allowed duration-delta range for trimming one clip's edge. */
function trimDeltaRange(t: ProductionTimeline, clip: TimelineClip, edge: "head" | "tail", opts: TimelineEditOpts): { lo: number; hi: number } {
  const dur = clipDurationSec(clip);
  let lo = EPS - dur;
  let hi = Infinity;
  const { prev, next } = neighborsOf(t, clip);
  if (edge === "tail") {
    hi = Math.min(hi, tailExtendCapacity(clip, opts));
    if (!opts.ripple && next) hi = Math.min(hi, next.timelineStartSec - clipEndSec(clip));
  } else {
    hi = Math.min(hi, headExtendCapacity(clip, opts));
    if (!opts.ripple) hi = Math.min(hi, clip.timelineStartSec - (prev ? clipEndSec(prev) : 0));
  }
  return { lo, hi };
}
function applyTrimInPlace(clip: TimelineClip, edge: "head" | "tail", delta: number, ripple: boolean): void {
  if (edge === "tail") {
    extendTailInPlace(clip, delta);
    return;
  }
  // Head: duration changes by delta. Non-ripple anchors the end (the
  // start moves); ripple anchors the start and the suffix shift absorbs.
  applyHeadTrimInPlace(clip, delta);
  if (!ripple) clip.timelineStartSec -= delta;
}

/**
 * Trim a clip's head or tail by a duration delta (positive extends,
 * negative shortens), clamped at the source's real limits and at
 * neighboring clips. With `ripple`, the start stays anchored on a head
 * trim and every following clip on the scoped tracks shifts by the
 * (pull-clamped) delta, closing or opening the gap exactly. Linked
 * partners trim by the same effective delta.
 */
export function trimClip(
  t: ProductionTimeline,
  clipId: string,
  edge: "head" | "tail",
  deltaSec: number,
  opts: TimelineEditOpts = {}
): ProductionTimeline | null {
  if (!Number.isFinite(deltaSec)) return null;
  const targets = expandLinked(t, [clipId], opts)
    .map((id) => t.clips.find((c) => c.id === id))
    .filter((c): c is TimelineClip => !!c);
  if (!targets.length || !targets.some((c) => c.id === clipId)) return null;
  if (targets.some((c) => clipLocked(t, c))) return null;
  let lo = -Infinity;
  let hi = Infinity;
  for (const c of targets) {
    const r = trimDeltaRange(t, c, edge, opts);
    lo = Math.max(lo, r.lo);
    hi = Math.min(hi, r.hi);
  }
  let d = Math.max(lo, Math.min(hi, deltaSec));
  const targetIds = new Set(targets.map((c) => c.id));
  const boundary = Math.min(...targets.map((c) => clipEndSec(c)));
  if (opts.ripple && d < 0) {
    d = clampRipplePull(t, boundary, d, rippleScopeTracks(t, targets, opts.ripple), targetIds);
  }
  const next = structuredClone(t);
  for (const c of targets) {
    applyTrimInPlace(next.clips.find((x) => x.id === c.id)!, edge, d, !!opts.ripple);
  }
  if (opts.ripple) shiftSuffixInPlace(next, boundary, d, rippleScopeTracks(t, targets, opts.ripple), targetIds);
  sortTimelineClipsInPlace(next);
  return next;
}

// ---- slip -----------------------------------------------------------------------

/**
 * Slip a clip's contents by `deltaSec`: source in/out move together,
 * timeline position and duration stay fixed, clamped by the available
 * source material on both sides. Single-clip even when linked (the
 * spec's linked list), and inapplicable to stills/blanks.
 */
export function slipClip(
  t: ProductionTimeline,
  clipId: string,
  deltaSec: number,
  opts: TimelineEditOpts = {}
): ProductionTimeline | null {
  if (!Number.isFinite(deltaSec)) return null;
  const clip = t.clips.find((c) => c.id === clipId);
  if (!clip || clipLocked(t, clip)) return null;
  if (clip.sourceKind === "still" || clip.sourceKind === "blank") return null;
  const inSec = clip.sourceInSec ?? 0;
  const dur = sourceDurationOf(clip, opts);
  const hi = dur != null ? Math.max(0, dur - (clip.sourceOutSec ?? 0)) : Infinity;
  const d = Math.max(-inSec, Math.min(hi, deltaSec));
  const next = structuredClone(t);
  const c = next.clips.find((x) => x.id === clipId)!;
  c.sourceInSec = inSec + d;
  c.sourceOutSec = (clip.sourceOutSec ?? 0) + d;
  return next;
}

// ---- roll -----------------------------------------------------------------------

/**
 * Roll the shared boundary after `leftClipId`: the left clip's tail and
 * the right clip's head trade the same delta, total duration unchanged.
 * Requires the two clips to be adjacent on their track; clamped by both
 * sources' limits and by either duration reaching zero.
 */
export function rollEdit(
  t: ProductionTimeline,
  leftClipId: string,
  deltaSec: number,
  opts: TimelineEditOpts = {}
): ProductionTimeline | null {
  if (!Number.isFinite(deltaSec)) return null;
  const left = t.clips.find((c) => c.id === leftClipId);
  if (!left || clipLocked(t, left)) return null;
  const { next: right } = neighborsOf(t, left);
  if (!right) return null;
  if (right.timelineStartSec - clipEndSec(left) > EPS) return null; // a gap is not a boundary
  const dMax = Math.min(tailExtendCapacity(left, opts), clipDurationSec(right) - EPS);
  const dMin = -Math.min(headExtendCapacity(right, opts), clipDurationSec(left) - EPS);
  const d = Math.max(dMin, Math.min(dMax, deltaSec));
  const next = structuredClone(t);
  const l = next.clips.find((x) => x.id === left.id)!;
  const r = next.clips.find((x) => x.id === right.id)!;
  extendTailInPlace(l, d);
  r.timelineStartSec += d;
  applyHeadTrimInPlace(r, -d);
  sortTimelineClipsInPlace(next);
  return next;
}

// ---- slide ----------------------------------------------------------------------

/**
 * Slide a clip earlier or later: its own duration and source range are
 * unchanged while its neighbors stretch or shrink to absorb the move.
 * Gaps beside the clip are consumed before a neighbor absorbs anything;
 * clamped by the neighbors' source material and durations.
 */
export function slideClip(
  t: ProductionTimeline,
  clipId: string,
  deltaSec: number,
  opts: TimelineEditOpts = {}
): ProductionTimeline | null {
  if (!Number.isFinite(deltaSec)) return null;
  const clip = t.clips.find((c) => c.id === clipId);
  if (!clip || clipLocked(t, clip)) return null;
  const { prev, next: nxt } = neighborsOf(t, clip);
  const gapBefore = clip.timelineStartSec - (prev ? clipEndSec(prev) : 0);
  const gapAfter = nxt ? nxt.timelineStartSec - clipEndSec(clip) : Infinity;
  let move = 0;
  if (deltaSec > 0) {
    const nextShrinkCap = nxt ? clipDurationSec(nxt) - EPS : 0;
    const prevExtendCap = prev ? tailExtendCapacity(prev, opts) : Infinity;
    move = Math.max(0, Math.min(deltaSec, gapAfter + nextShrinkCap, gapBefore + prevExtendCap));
  } else if (deltaSec < 0) {
    const prevShrinkCap = prev ? clipDurationSec(prev) - EPS : 0;
    const nextExtendCap = nxt ? headExtendCapacity(nxt, opts) : Infinity;
    move = -Math.max(0, Math.min(-deltaSec, gapBefore + prevShrinkCap, gapAfter + nextExtendCap));
  }
  const out = structuredClone(t);
  const c = out.clips.find((x) => x.id === clipId)!;
  c.timelineStartSec += move;
  const prevC = prev ? out.clips.find((x) => x.id === prev.id)! : undefined;
  const nextC = nxt ? out.clips.find((x) => x.id === nxt.id)! : undefined;
  if (move > 0) {
    const fillPrev = Math.max(0, move - gapBefore);
    if (prevC && fillPrev > 0) extendTailInPlace(prevC, fillPrev);
    const eatNext = Math.max(0, move - gapAfter);
    if (nextC && eatNext > 0) {
      nextC.timelineStartSec += eatNext;
      applyHeadTrimInPlace(nextC, -eatNext);
    }
  } else if (move < 0) {
    const m = -move;
    const shrinkPrev = Math.max(0, m - gapBefore);
    if (prevC && shrinkPrev > 0) extendTailInPlace(prevC, -shrinkPrev);
    const extendNext = Math.max(0, m - (gapAfter === Infinity ? Infinity : gapAfter));
    if (nextC && extendNext > 0 && Number.isFinite(extendNext)) {
      nextC.timelineStartSec -= extendNext;
      applyHeadTrimInPlace(nextC, extendNext);
    }
  }
  sortTimelineClipsInPlace(out);
  return out;
}

// ---- move / delete ---------------------------------------------------------------

/**
 * Move a selection of clips by the same delta on their own tracks,
 * clamped so no moved clip overruns an unselected clip or timeline 0.
 * Acts on exactly the named clips (the UI expands linked selections).
 */
export function moveClipsBy(
  t: ProductionTimeline,
  clipIds: readonly string[],
  deltaSec: number
): ProductionTimeline | null {
  if (!Number.isFinite(deltaSec)) return null;
  const moving = [...new Set(clipIds)]
    .map((id) => t.clips.find((c) => c.id === id))
    .filter((c): c is TimelineClip => !!c);
  if (!moving.length) return null;
  if (moving.some((c) => clipLocked(t, c))) return null;
  const movingIds = new Set(moving.map((c) => c.id));
  let eff = deltaSec;
  for (const c of moving) {
    const list = trackClipsSorted(t, c.trackId);
    if (eff > 0) {
      const blocker = list.find((x) => !movingIds.has(x.id) && x.timelineStartSec >= clipEndSec(c) - EPS);
      if (blocker) eff = Math.min(eff, blocker.timelineStartSec - clipEndSec(c));
    } else if (eff < 0) {
      let room = c.timelineStartSec;
      for (const x of list) {
        if (!movingIds.has(x.id) && clipEndSec(x) <= c.timelineStartSec + EPS) room = Math.min(room, c.timelineStartSec - clipEndSec(x));
      }
      eff = Math.max(eff, -room);
    }
  }
  const next = structuredClone(t);
  for (const c of next.clips) if (movingIds.has(c.id)) c.timelineStartSec += eff;
  sortTimelineClipsInPlace(next);
  return next;
}

/**
 * Delete clips (linked partners included by default). Without ripple the
 * gap stays; with ripple each deletion closes its own gap in start
 * order, shifting the scoped suffix earlier (pull-clamped so spanning
 * clips on other tracks are never overrun).
 */
export function deleteClips(
  t: ProductionTimeline,
  clipIds: readonly string[],
  opts: TimelineEditOpts = {}
): ProductionTimeline | null {
  const targetIds = new Set(expandLinked(t, clipIds, opts));
  const targets = t.clips.filter((c) => targetIds.has(c.id));
  if (!targets.length) return null;
  if (targets.some((c) => clipLocked(t, c))) return null;
  const next = structuredClone(t);
  if (!opts.ripple) {
    next.clips = next.clips.filter((c) => !targetIds.has(c.id));
  } else {
    const scope = rippleScopeTracks(t, targets, opts.ripple);
    for (;;) {
      const cand = next.clips
        .filter((c) => targetIds.has(c.id))
        .sort((a, b) => a.timelineStartSec - b.timelineStartSec || a.id.localeCompare(b.id))[0];
      if (!cand) break;
      const boundary = clipEndSec(cand);
      let d = -clipDurationSec(cand);
      next.clips = next.clips.filter((c) => c.id !== cand.id);
      d = clampRipplePull(next, boundary, d, scope, targetIds);
      shiftSuffixInPlace(next, boundary, d, scope, targetIds);
    }
  }
  pruneSingletonLinksInPlace(next.clips);
  sortTimelineClipsInPlace(next);
  return next;
}

// ---- linking ----------------------------------------------------------------------

/** Link 2+ clips into one group (a fresh linkId replaces prior groups). */
export function linkClips(
  t: ProductionTimeline,
  clipIds: readonly string[],
  newId: (prefix: string) => string
): ProductionTimeline | null {
  const ids = [...new Set(clipIds)];
  const members = ids.map((id) => t.clips.find((c) => c.id === id)).filter((c): c is TimelineClip => !!c);
  if (members.length < 2 || members.length !== ids.length) return null;
  if (members.some((c) => clipLocked(t, c))) return null;
  const next = structuredClone(t);
  const link = newId("lnk");
  for (const c of next.clips) if (ids.includes(c.id)) c.linkId = link;
  pruneSingletonLinksInPlace(next.clips);
  return next;
}

/** Remove the named clips from their link groups (singletons prune). */
export function unlinkClips(t: ProductionTimeline, clipIds: readonly string[]): ProductionTimeline | null {
  const members = clipIds.map((id) => t.clips.find((c) => c.id === id)).filter((c): c is TimelineClip => !!c);
  if (!members.length) return null;
  if (members.some((c) => clipLocked(t, c))) return null;
  const next = structuredClone(t);
  for (const c of next.clips) if (clipIds.includes(c.id)) delete c.linkId;
  pruneSingletonLinksInPlace(next.clips);
  return next;
}

// ---- constant speed --------------------------------------------------------------

/**
 * Set constant speed and/or reverse on clips (linked partners included by
 * default). Duration re-derives as range/speed. Without ripple, a slower
 * speed clamps at the next clip on the track (the gap is the limit);
 * with ripple, following clips on the scoped tracks shift by the
 * duration change (pull-clamped like ripple trims, with the speed
 * itself reduced when the pull clamps). Stills/blanks are inapplicable;
 * targeting only those returns null. Speed exactly 1 clears the field.
 */
/**
 * Set per-clip audio (Item 7): volume, fades, pitch mode — on audio
 * clips and video clips (their embedded audio) alike, linked partners
 * included. Pure presentation data: no timing changes, so no ripple.
 * Values clamp (volume 0..1; fades so in+out fit the duration, fade-in
 * winning) and store sparse — unity volume, zero fades, and preserve
 * pitch are absence. Null when nothing applies (empty patch, no
 * video/audio targets, a locked track).
 */
export function setClipAudio(
  t: ProductionTimeline,
  clipIds: readonly string[],
  patch: { volume?: number; fadeInSec?: number; fadeOutSec?: number; pitchMode?: "preserve" | "natural"; muted?: boolean },
  opts: TimelineEditOpts = {}
): ProductionTimeline | null {
  if (patch.volume == null && patch.fadeInSec == null && patch.fadeOutSec == null && patch.pitchMode == null && patch.muted == null) return null;
  const targets = expandLinked(t, clipIds, opts)
    .map((id) => t.clips.find((c) => c.id === id))
    .filter((c): c is TimelineClip => !!c && (c.sourceKind === "video" || c.sourceKind === "audio"));
  if (!targets.length) return null;
  if (targets.some((c) => clipLocked(t, c))) return null;
  const next = structuredClone(t);
  for (const target of targets) {
    const c = next.clips.find((x) => x.id === target.id)!;
    if (patch.muted != null) {
      if (patch.muted) c.muted = true;
      else delete c.muted;
    }
    if (patch.volume != null) {
      const v = Math.max(0, Math.min(1, patch.volume));
      if (v === 1) delete c.volume;
      else c.volume = v;
    }
    if (patch.fadeInSec != null || patch.fadeOutSec != null) {
      const fades = clampFades(
        clipDurationSec(c),
        patch.fadeInSec ?? fadeOf(c.fadeInSec),
        patch.fadeOutSec ?? fadeOf(c.fadeOutSec)
      );
      if (fades.fadeInSec > 0) c.fadeInSec = fades.fadeInSec;
      else delete c.fadeInSec;
      if (fades.fadeOutSec > 0) c.fadeOutSec = fades.fadeOutSec;
      else delete c.fadeOutSec;
    }
    if (patch.pitchMode != null) {
      if (patch.pitchMode === "natural") c.pitchMode = "natural";
      else delete c.pitchMode;
    }
  }
  return next;
}

/** The dissolve (if any) whose outgoing side is `outgoingClipId`. */
export function transitionFor(t: ProductionTimeline, outgoingClipId: string): TimelineTransition | undefined {
  return t.transitions?.find((tr) => tr.outgoingClipId === outgoingClipId);
}

/** Timeline seconds of source handle BEFORE a clip's start (what a
 *  centered dissolve plays of the incoming clip before the edit).
 *  Stills/blanks are infinite; unknown source length is unbounded for
 *  the side that needs it (the opts convention). */
function headHandleSec(clip: TimelineClip, opts: TimelineEditOpts): number {
  if (clip.sourceKind === "still" || clip.sourceKind === "blank") return Infinity;
  const sp = clipSpeedAt(clip, 0);
  if (clip.reversed) {
    const sd = sourceDurationOf(clip, opts);
    return sd == null ? Infinity : Math.max(0, sd - (clip.sourceOutSec ?? 0)) / sp;
  }
  return Math.max(0, clip.sourceInSec ?? 0) / sp;
}

/** Timeline seconds of source handle AFTER a clip's end. */
function tailHandleSec(clip: TimelineClip, opts: TimelineEditOpts): number {
  if (clip.sourceKind === "still" || clip.sourceKind === "blank") return Infinity;
  const sp = clipSpeedAt(clip, clipDurationSec(clip));
  if (clip.reversed) return Math.max(0, clip.sourceInSec ?? 0) / sp;
  const sd = sourceDurationOf(clip, opts);
  return sd == null ? Infinity : Math.max(0, sd - (clip.sourceOutSec ?? 0)) / sp;
}

/**
 * The longest centered dissolve that fits the edit after
 * `outgoingClipId`: 0 when there is no exactly-adjacent successor on
 * the same video track. Bounded by both clips' lengths, both handles
 * (timeline seconds), and the room neighbor transitions leave inside
 * the two clips. The editor clamps to this; the setter refuses past it.
 */
export function maxDissolveSec(t: ProductionTimeline, outgoingClipId: string, opts: TimelineEditOpts = {}): number {
  const out = t.clips.find((c) => c.id === outgoingClipId);
  if (!out) return 0;
  const track = t.tracks.find((x) => x.id === out.trackId);
  if (!track || track.kind !== "video") return 0;
  const inc = neighborsOf(t, out).next;
  if (!inc || Math.abs(inc.timelineStartSec - clipEndSec(out)) > EPS) return 0;
  const durOut = clipDurationSec(out);
  const durIn = clipDurationSec(inc);
  let max = 2 * Math.min(durOut, durIn);
  max = Math.min(max, 2 * headHandleSec(inc, opts), 2 * tailHandleSec(out, opts));
  const inTrans = transitionFor(t, inc.id);
  if (inTrans) max = Math.min(max, 2 * (durIn - inTrans.durationSec / 2));
  const prevTrans = t.transitions?.find((tr) => tr.incomingClipId === out.id);
  if (prevTrans && prevTrans.outgoingClipId !== out.id) max = Math.min(max, 2 * (durOut - prevTrans.durationSec / 2));
  return Math.max(0, max);
}

/**
 * Set (or with null/≤0, remove) the dissolve after `outgoingClipId`
 * (Item 8). Refuses (null) when: no adjacent successor, a locked
 * track, or the duration exceeds the handles/room `maxDissolveSec`
 * computes — the editor clamps to that max so a refusal here means
 * the model moved under the gesture. Removal of a nonexistent
 * transition is also null (nothing changed). Clip positions and
 * durations never change either way.
 */
export function setClipTransition(
  t: ProductionTimeline,
  outgoingClipId: string,
  durationSec: number | null,
  newId: (prefix: string) => string,
  opts: TimelineEditOpts = {}
): ProductionTimeline | null {
  const existing = transitionFor(t, outgoingClipId);
  if (durationSec == null || !(durationSec > 0)) {
    if (!existing) return null;
    const next = structuredClone(t);
    next.transitions = (next.transitions ?? []).filter((tr) => tr.outgoingClipId !== outgoingClipId);
    if (!next.transitions.length) delete next.transitions;
    return next;
  }
  const out = t.clips.find((c) => c.id === outgoingClipId);
  if (!out || clipLocked(t, out)) return null;
  const inc = neighborsOf(t, out).next;
  if (!inc || clipLocked(t, inc)) return null;
  if (durationSec > maxDissolveSec(t, outgoingClipId, opts) + 1e-9) return null;
  const next = structuredClone(t);
  const rest = (next.transitions ?? []).filter((tr) => tr.outgoingClipId !== outgoingClipId);
  rest.push({ id: existing?.id ?? newId("trn"), type: "dissolve", outgoingClipId, incomingClipId: inc.id, durationSec });
  next.transitions = rest;
  return next;
}

/** Drop transitions an edit invalidated (clip deleted, join broken)
 *  and clamp durations back inside shrunken clips. Part of the ops'
 *  finalize pass, like the fade re-clamp. */
function pruneTransitionsInPlace(t: ProductionTimeline): void {
  if (!t.transitions?.length) return;
  const byId = new Map(t.clips.map((c) => [c.id, c]));
  t.transitions = t.transitions.filter((tr) => {
    const out = byId.get(tr.outgoingClipId);
    const inc = byId.get(tr.incomingClipId);
    if (!out || !inc || out.trackId !== inc.trackId) return false;
    if (Math.abs(inc.timelineStartSec - clipEndSec(out)) > EPS) return false;
    const fit = 2 * Math.min(clipDurationSec(out), clipDurationSec(inc));
    if (!(fit > 0)) return false;
    if (tr.durationSec > fit) tr.durationSec = fit;
    return tr.durationSec > 0;
  });
  if (!t.transitions.length) delete t.transitions;
}

export function setClipSpeed(
  t: ProductionTimeline,
  clipIds: readonly string[],
  patch: { speed?: number; reversed?: boolean },
  opts: TimelineEditOpts = {}
): ProductionTimeline | null {
  if (patch.speed != null && (!Number.isFinite(patch.speed) || patch.speed <= 0)) return null;
  if (patch.speed == null && patch.reversed == null) return null;
  const targets = expandLinked(t, clipIds, opts)
    .map((id) => t.clips.find((c) => c.id === id))
    .filter((c): c is TimelineClip => !!c && (c.sourceKind === "video" || c.sourceKind === "audio"));
  if (!targets.length) return null;
  if (targets.some((c) => clipLocked(t, c))) return null;
  const next = structuredClone(t);
  const ordered = [...targets].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
  for (const target of ordered) {
    const c = next.clips.find((x) => x.id === target.id)!;
    const range = Math.max(0, (c.sourceOutSec ?? 0) - (c.sourceInSec ?? 0));
    if (range <= 0) continue;
    const oldDur = clipDurationSec(c);
    if (patch.speed != null) delete c.speedCurve; // a constant set replaces any ramp
    let speed = patch.speed != null ? Math.min(100, patch.speed) : clipSpeed(c);
    if (patch.speed != null && !opts.ripple) {
      const { next: nxt } = neighborsOf(next, c);
      const available = nxt ? nxt.timelineStartSec - c.timelineStartSec : Infinity;
      if (range / speed > available) speed = range / Math.max(EPS, available);
    }
    if (speed === 1) delete c.speed;
    else c.speed = speed;
    if (patch.reversed != null) {
      if (patch.reversed) c.reversed = true;
      else delete c.reversed;
    }
    if (opts.ripple && patch.speed != null) {
      let delta = clipDurationSec(c) - oldDur;
      if (delta !== 0) {
        const scope = rippleScopeTracks(next, [c], opts.ripple);
        const boundary = c.timelineStartSec + oldDur;
        if (delta < 0) {
          const clamped = clampRipplePull(next, boundary, delta, scope, new Set([c.id]));
          if (clamped !== delta) {
            // The suffix can only pull so far: the speed gives instead.
            delta = clamped;
            const effSpeed = range / Math.max(EPS, oldDur + delta);
            if (effSpeed === 1) delete c.speed;
            else c.speed = effSpeed;
          }
        }
        shiftSuffixInPlace(next, boundary, delta, scope, new Set([c.id]));
      }
    }
  }
  sortTimelineClipsInPlace(next);
  return next;
}

/**
 * Apply (or clear, with null) a speed-ramp curve on clips (linked
 * partners included by default). Duration re-derives from the integral.
 * Without ripple, a curve that would lengthen a clip past its neighbor
 * is REFUSED (a curve has no single clampable speed); with ripple the
 * suffix shifts, refusing when a pull would have to clamp against a
 * spanning clip. Clearing returns the clip to its constant speed field.
 */
/** Pull keyframes that fall past the clip's derived duration back to
 *  its end (last-wins on ties), re-solving until the curve spans the
 *  clip. Authoring-time only (setClipSpeedCurve): speeding a clip up
 *  would otherwise strand its later keyframes beyond the shorter end —
 *  invisible in the editor, ungrabbable, and the drawn end speed would
 *  never actually be reached. Duration still derives from the stored
 *  curve's integral; this only guarantees lastAt <= duration so the
 *  last keyframe's speed IS the speed at the clip's end. */
function fitCurveToClipDuration(clip: TimelineClip): void {
  if (!clip.speedCurve?.length) return;
  for (let i = 0; i < 8; i++) {
    const dur = clipDurationSec(clip);
    if (!(dur > 0)) return;
    const last = clip.speedCurve[clip.speedCurve.length - 1];
    if (last.atSec <= dur + 1e-9) return;
    const pulled = normalizeSpeedCurve(
      clip.speedCurve.map((k) => ({ atSec: Math.min(k.atSec, dur), speed: k.speed }))
    );
    if (!pulled) return;
    clip.speedCurve = pulled;
  }
}

export function setClipSpeedCurve(
  t: ProductionTimeline,
  clipIds: readonly string[],
  curve: readonly SpeedKeyframe[] | null,
  opts: TimelineEditOpts = {}
): ProductionTimeline | null {
  const normalized = curve != null ? normalizeSpeedCurve(curve) : undefined;
  if (curve != null && !normalized) return null;
  const targets = expandLinked(t, clipIds, opts)
    .map((id) => t.clips.find((c) => c.id === id))
    .filter((c): c is TimelineClip => !!c && (c.sourceKind === "video" || c.sourceKind === "audio"));
  if (!targets.length) return null;
  if (targets.some((c) => clipLocked(t, c))) return null;
  const next = structuredClone(t);
  const ordered = [...targets].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
  for (const target of ordered) {
    const c = next.clips.find((x) => x.id === target.id)!;
    const oldDur = clipDurationSec(c);
    if (normalized) {
      c.speedCurve = normalized.map((k) => ({ ...k }));
      fitCurveToClipDuration(c);
      delete c.speed;
    } else {
      delete c.speedCurve;
    }
    const newDur = clipDurationSec(c);
    const delta = newDur - oldDur;
    if (delta === 0) continue;
    if (!opts.ripple) {
      const { next: nxt } = neighborsOf(next, c);
      if (nxt && c.timelineStartSec + newDur > nxt.timelineStartSec + EPS) return null;
      continue;
    }
    const scope = rippleScopeTracks(next, [c], opts.ripple);
    const boundary = c.timelineStartSec + oldDur;
    if (delta < 0) {
      const clamped = clampRipplePull(next, boundary, delta, scope, new Set([c.id]));
      if (clamped !== delta) return null; // a spanning clip blocks the pull
    }
    shiftSuffixInPlace(next, boundary, delta, scope, new Set([c.id]));
  }
  sortTimelineClipsInPlace(next);
  return next;
}

// ---- seed from the legacy shot projection ---------------------------------------

const clampVolume = (v: number | undefined, fallback: number): number =>
  Math.max(0, Math.min(1, typeof v === "number" && Number.isFinite(v) ? v : fallback));

/**
 * Migrate a production's single-track animatic (shots + sequences + the VO
 * and music beds) into the multi-track model, unchanged: the projected
 * items land back-to-back on V1 in the same order with the same durations,
 * slip offsets become source in-points, still-only shots become held still
 * clips, media-less shots become blank clips, disabled shots stay out, and
 * the two beds become clips on their own audio tracks spanning the seeded
 * timeline (exactly how the legacy render lays them). Media ids resolve
 * through the production's registry by path. Pure; ids come from the
 * caller's `newId` (`uid("trk")` / `uid("clp")` in the app).
 *
 * The result passes through `normalizeTimeline`, so what seeds is by
 * construction what a reload would keep.
 */
export function seedTimelineFromProduction(
  p: Production,
  newId: (prefix: string) => string
): ProductionTimeline {
  const shots: ProductionShot[] = p.scenes.flatMap((sc) => sc.shots);
  const shotById = new Map(shots.map((s) => [s.id, s]));
  const items = applyShotSequences(shots, p.shotSequences ?? [], p.references);
  const mediaIdFor = (rel: string | undefined): string | undefined =>
    rel ? mediaEntryForPath(p.media, rel)?.id : undefined;

  const vTrack: TimelineTrack = { id: newId("trk"), kind: "video", name: "V1" };
  const tracks: TimelineTrack[] = [vTrack];
  const clips: TimelineClip[] = [];
  let t = 0;

  for (const item of items) {
    const dur = Math.max(0.1, item.durationSec);
    const base: TimelineClip = {
      id: newId("clp"),
      trackId: vTrack.id,
      sourceKind: "blank",
      timelineStartSec: t,
    };
    if (item.kind === "sequence") {
      base.sequenceId = item.sequenceId;
      base.memberShotIds = [...item.shotIds];
      if (item.videoPath) {
        const inSec = sanitizeVideoOffset(item.videoOffsetSec) ?? 0;
        Object.assign(base, {
          sourceKind: "video" as const,
          srcRel: item.videoPath,
          mediaId: mediaIdFor(item.videoPath),
          sourceInSec: inSec,
          sourceOutSec: inSec + dur,
          ...(item.muted ? { muted: true } : {}),
        });
      } else if (item.artwork) {
        Object.assign(base, {
          sourceKind: "still" as const,
          srcRel: item.artwork,
          mediaId: mediaIdFor(item.artwork),
          holdSec: dur,
        });
      } else {
        base.holdSec = dur;
      }
    } else {
      const shot = shotById.get(item.id);
      base.shotId = item.id;
      const display = shot ? resolveShotDisplay(shot) : { media: "none" as const };
      if (display.media === "clip" && display.path) {
        const inSec = sanitizeVideoOffset(item.videoOffsetSec) ?? 0;
        Object.assign(base, {
          sourceKind: "video" as const,
          srcRel: display.path,
          mediaId: mediaIdFor(display.path),
          sourceInSec: inSec,
          sourceOutSec: inSec + dur,
          ...(item.muted ? { muted: true } : {}),
        });
      } else if (display.media === "still" && display.path) {
        Object.assign(base, {
          sourceKind: "still" as const,
          srcRel: display.path,
          mediaId: mediaIdFor(display.path),
          holdSec: dur,
        });
      } else {
        base.holdSec = dur;
      }
    }
    clips.push(base);
    t += dur;
  }

  const bed = (
    name: string,
    rel: string,
    volume: number,
    role: "voiceover" | "music"
  ): void => {
    const track: TimelineTrack = { id: newId("trk"), kind: "audio", name };
    tracks.push(track);
    clips.push({
      id: newId("clp"),
      trackId: track.id,
      sourceKind: "audio",
      srcRel: rel,
      mediaId: mediaIdFor(rel),
      sourceInSec: 0,
      sourceOutSec: t,
      timelineStartSec: 0,
      volume,
      role,
    });
  };
  if (p.voiceoverPath) bed("Voiceover", p.voiceoverPath, clampVolume(p.voiceoverVolume, 1), "voiceover");
  if (p.musicPath) bed("Music", p.musicPath, clampVolume(p.musicVolume, 0.5), "music");

  return normalizeTimeline({ version: 1, tracks, clips }) ?? emptyTimeline();
}

/** Rescale the WHOLE edit so its total runtime becomes `targetSec` — the
 *  timeline-native "Fit to VO / set total" (the legacy strip rescaled shot
 *  windows; here every clip's span scales by the same factor and speeds
 *  are unchanged, so a video clip shows proportionally more/less source).
 *  Positions, source ranges, holds, ramp keyframe TIMES, fades, and
 *  transition durations scale; speeds, volumes, and in-points do not.
 *  The result is re-normalized, so transitions re-clamp to their handles.
 *  A non-positive target or an empty timeline returns the input. */
export function scaleTimelineToDuration(
  t: ProductionTimeline,
  targetSec: number
): ProductionTimeline {
  if (!Number.isFinite(targetSec) || targetSec <= 0 || !t.clips.length) return t;
  const total = Math.max(...t.clips.map(clipEndSec));
  if (!(total > 0)) return t;
  const f = targetSec / total;
  if (Math.abs(f - 1) < 1e-9) return t;
  const next = structuredClone(t);
  for (const c of next.clips) {
    c.timelineStartSec *= f;
    if (c.sourceKind === "still" || c.sourceKind === "blank") {
      if (c.holdSec != null) c.holdSec *= f;
    } else if (c.sourceInSec != null && c.sourceOutSec != null) {
      c.sourceOutSec = c.sourceInSec + (c.sourceOutSec - c.sourceInSec) * f;
    }
    if (c.speedCurve?.length) {
      c.speedCurve = c.speedCurve.map((k) => ({ atSec: k.atSec * f, speed: k.speed }));
    }
    if (c.fadeInSec != null) c.fadeInSec *= f;
    if (c.fadeOutSec != null) c.fadeOutSec *= f;
  }
  for (const tr of next.transitions ?? []) tr.durationSec *= f;
  if (next.durationSec != null) next.durationSec *= f;
  return normalizeTimeline(next) ?? next;
}

/** Re-point shot/sequence-seeded clips at each shot's CURRENT selected
 *  output, kind-for-kind (video→video, still→still): regenerating a shot
 *  or a sequence replaces the media its timeline clip plays, while the
 *  clip's trims, timing, and retime survive. Cross-kind changes (a shot
 *  that now shows a still where the clip is video) are left alone —
 *  re-adding is the explicit gesture for those. Returns the SAME object
 *  when nothing changed, so callers can skip the save. */
export function reconcileTimelineShotMedia(
  t: ProductionTimeline,
  p: Production
): ProductionTimeline {
  const shots: ProductionShot[] = p.scenes.flatMap((sc) => sc.shots);
  const shotById = new Map(shots.map((s) => [s.id, s]));
  const seqItems = new Map(
    applyShotSequences(shots, p.shotSequences ?? [], p.references)
      .filter((i) => i.kind === "sequence" && i.sequenceId)
      .map((i) => [i.sequenceId as string, i])
  );
  const mediaIdFor = (rel: string): string | undefined =>
    mediaEntryForPath(p.media, rel)?.id;

  let changed = false;
  const clips = t.clips.map((c) => {
    let wantKind: "video" | "still" | null = null;
    let wantRel: string | undefined;
    if (c.shotId && shotById.has(c.shotId)) {
      const display = resolveShotDisplay(shotById.get(c.shotId)!);
      if (display.media === "clip" && display.path) { wantKind = "video"; wantRel = display.path; }
      else if (display.media === "still" && display.path) { wantKind = "still"; wantRel = display.path; }
    } else if (c.sequenceId && seqItems.has(c.sequenceId)) {
      const item = seqItems.get(c.sequenceId)!;
      if (item.videoPath) { wantKind = "video"; wantRel = item.videoPath; }
      else if (item.artwork) { wantKind = "still"; wantRel = item.artwork; }
    }
    if (!wantKind || !wantRel || c.sourceKind !== wantKind) return c;
    const wantId = mediaIdFor(wantRel);
    if (c.srcRel === wantRel && (c.mediaId ?? undefined) === (wantId ?? undefined)) return c;
    changed = true;
    const nextClip: TimelineClip = { ...c, srcRel: wantRel };
    if (wantId) nextClip.mediaId = wantId;
    else delete nextClip.mediaId;
    return nextClip;
  });
  if (!changed) return t;
  return normalizeTimeline({ ...t, clips }) ?? { ...t, clips };
}

/** Keep the timeline's VO/music bed clips in step with the production's
 *  imported audio files: importing a VO after the timeline was seeded
 *  adds its bed clip, replacing the file re-points the bed (drawn gain
 *  and fades survive), and removing the file removes its bed clips.
 *  Role is only ever set by the seed and this sync, so role clips are
 *  safe to manage here; user gain/fades on them are never overwritten.
 *  Returns the SAME object when nothing changed (including when the
 *  timeline has no clips yet to bed under), so callers can skip the save
 *  and effect loops cannot spin. */
export function syncTimelineBeds(
  t: ProductionTimeline,
  p: Production,
  newId: (prefix: string) => string
): ProductionTimeline {
  if (!t.clips.length) return t;
  const total = Math.max(...t.clips.map(clipEndSec));
  const wanted: { role: "voiceover" | "music"; path?: string; name: string; volume: number }[] = [
    { role: "voiceover", path: p.voiceoverPath, name: "Voiceover", volume: clampVolume(p.voiceoverVolume, 1) },
    { role: "music", path: p.musicPath, name: "Music", volume: clampVolume(p.musicVolume, 0.5) },
  ];
  const mediaIdFor = (rel: string): string | undefined =>
    mediaEntryForPath(p.media, rel)?.id;

  let changed = false;
  let tracks = t.tracks;
  let clips = t.clips;
  for (const w of wanted) {
    const existing = clips.filter((c) => c.role === w.role);
    if (!w.path) {
      if (existing.length) {
        changed = true;
        clips = clips.filter((c) => c.role !== w.role);
      }
      continue;
    }
    if (!existing.length) {
      if (!(total > 0)) continue;
      changed = true;
      const track: TimelineTrack = { id: newId("trk"), kind: "audio", name: w.name };
      tracks = [...tracks, track];
      clips = [
        ...clips,
        {
          id: newId("clp"),
          trackId: track.id,
          sourceKind: "audio",
          srcRel: w.path,
          mediaId: mediaIdFor(w.path),
          sourceInSec: 0,
          sourceOutSec: total,
          timelineStartSec: 0,
          volume: w.volume,
          role: w.role,
        },
      ];
      continue;
    }
    if (existing.some((c) => c.srcRel !== w.path || (c.mediaId ?? undefined) !== (mediaIdFor(w.path as string) ?? undefined))) {
      changed = true;
      const wantId = mediaIdFor(w.path);
      clips = clips.map((c) => {
        if (c.role !== w.role) return c;
        const nextClip: TimelineClip = { ...c, srcRel: w.path };
        if (wantId) nextClip.mediaId = wantId;
        else delete nextClip.mediaId;
        return nextClip;
      });
    }
  }
  if (!changed) return t;
  const next = normalizeTimeline({ ...t, tracks, clips }) ?? { ...t, tracks, clips };
  return JSON.stringify(next) === JSON.stringify(t) ? t : next;
}
