/**
 * Step 5 Assembly — the editor-handoff + render module.
 *
 * Deep module with a small surface. The pure builders (assemblyPlan, buildEdl,
 * buildAeScript, buildManifest, buildRenderArgs / buildConcatArgs / buildMixArgs)
 * hold the real logic and are unit-tested in app/test/assembly.test.ts.
 * `assemble()` does the file copying + artifact writes; `renderAnimatic()`
 * drives the 3-pass ffmpeg pipeline through an injected `runFfmpeg`/`probe`
 * seam so it's fakeable in tests.
 *
 * Media rule (mirrors the animatic timeline): a shot with a `videoPath` plays
 * as a clip (its full-res still is still gathered for the storyboard); a shot
 * with only `artwork` is a still (full-res original preferred); a shot with
 * neither is a `blank` event — a black slot that still holds its full animatic
 * duration, so nothing ever shifts later timing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Production, ProductionAssembly, ProductionShot, TimelineClip } from "../shared/ipc.js";
import { applyShotSequences, clipDurationSec, clipSourceTimeAtLoose, clipSourceWindowAt, clipSpeed, clipVolume, resolveTimeline, sanitizeVideoOffset, seedTimelineFromProduction, speedCurveForSpan, speedCurveIntegral, speedCurveSpeedAt, trackVolume, type SpeedKeyframe } from "../shared/ipc.js";
import { mediaPathForId } from "../shared/media-registry.js";
import { resolveShotDisplay } from "../shared/selected-output.js";
import { assetPath, formatRuntime, originalForJpegRel, tweenSelectedClips } from "./pipeline.js";
import { buildFcpxml } from "./fcpxml.js";
import { buildPremiereXml } from "./premiere-xml.js";

export type AssemblyEmit = (message: string, level?: "info" | "error" | "done") => void;

export interface AssemblyConfig {
  fps: number;
  width: number;
  height: number;
}

export interface AssemblyEvent {
  shotId: string;
  number: string;
  kind: "still" | "clip" | "blank";
  /** Workspace-relative source file (boards JPEG/original or videos clip).
   *  Absent for `blank` (black) slots. */
  srcRel?: string;
  /** Path relative to the export folder's media/ dir, e.g. "shots/0100.png".
   *  Absent for `blank` (black) slots. */
  mediaRel?: string;
  durationSec: number;
  muted: boolean;
  /** Cumulative timeline position (computed over included events only). */
  startSec: number;
  endSec: number;
  /** Slip offset into a clip's source in seconds (Step 4 right-drag): the
   *  event plays its window from `offsetSec`, not from the top. Absent = 0. */
  offsetSec?: number;
  /** Constant playback speed for clip events (Item 4): the event's
   *  durationSec is timeline time; the source window is duration×speed.
   *  Absent = 1x. */
  speed?: number;
  /** Play the source window backwards (render reverses the segment). */
  reversed?: boolean;
  /** Speed ramp for this event's span (Item 5), rebased to the span.
   *  When present, `speed` carries the span's average for notes. */
  speedCurve?: SpeedKeyframe[];
  /** Retime interpolation: absent = frame sampling. */
  speedInterp?: "blend" | "flow";
  /** Embedded-audio gain (Item 7): clip volume × track volume already
   *  folded. Absent = unity (no filter emitted). */
  volume?: number;
  /** Clip-local linear fades in timeline seconds (Item 7); the gain
   *  expression evaluates at `gainOffsetSec + t` over `clipDurSec` so
   *  a span starting mid-clip resumes the fade where it should. */
  fadeInSec?: number;
  fadeOutSec?: number;
  gainOffsetSec?: number;
  clipDurSec?: number;
  /** Pitch handling when retimed: absent = preserve (atempo). */
  pitchMode?: "preserve" | "natural";
  /** Cross-dissolve (Item 8): this event is the OUTGOING side of a
   *  centered blend window (its durationSec spans the whole window,
   *  source window extended into the tail handle); blendWith is the
   *  incoming side's window event (extended into the head handle).
   *  The render normalizes both, then xfades them into one segment. */
  blendWith?: AssemblyEvent;
  /** Actual clip length when probed (used for EDL source-out + render padding). */
  probedSec?: number;
  hasAudio?: boolean;
}

export interface AssemblyAudio {
  /** Bed fades (Item 7, timeline seconds) + the bed clip's duration
   *  the fade-out anchors to. Timeline plans only; legacy beds omit. */
  fadeInSec?: number;
  fadeOutSec?: number;
  durationSec?: number;
  srcRel: string;
  mediaRel: string;
  volume: number;
  probedSec?: number;
}

/** One audible timeline audio clip for the generalized render mix
 *  (Item 9): timeline position, source window, retime, and gain —
 *  every audible clip mixes, not just the VO/music beds. Timeline
 *  plans only; the legacy plan leaves the field absent and the
 *  render falls back to the bed mix. */
export interface AssemblyAudioEvent {
  srcRel: string;
  mediaRel: string;
  startSec: number;
  durationSec: number;
  /** Source window start (seconds into the source file). */
  offsetSec?: number;
  speed?: number;
  reversed?: boolean;
  pitchMode?: "preserve" | "natural";
  volume: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  clipDurSec?: number;
  role?: "voiceover" | "music";
}

export interface AssemblyPlan {
  events: AssemblyEvent[];
  voiceover?: AssemblyAudio;
  music?: AssemblyAudio;
  totalSec: number;
  /** Shot numbers rendered as black slots because they had no frame and no clip. */
  blanks: string[];
  /** Shot numbers rendered as a still even though the production shows a video
   *  generation for them (a pending job, a `videogen` output pipe, or stored
   *  clip takes) — the "clip exists but isn't registered" symptom. A loud
   *  warning so a wrong deliverable can't be produced silently. */
  suspiciousStills: string[];
  /** All audible audio clips for the generalized mix (Item 9,
   *  timeline plans only — role beds above stay for EDL/JSX). */
  audioEvents?: AssemblyAudioEvent[];
  /** Every media file that must land in the export folder (events + audio), deduped. */
  media: { srcRel: string; mediaRel: string }[];
}

export interface ProbeResult {
  durationSec: number | null;
  hasAudio: boolean;
}
export type ProbeFn = (bin: string, absPath: string) => Promise<ProbeResult>;

// ---- pure helpers ----------------------------------------------------------

function pickInt(v: number | undefined, fallback: number): number {
  return Number.isFinite(v) && (v ?? 0) >= 1 ? Math.round(v!) : fallback;
}

export function assemblyConfig(
  p: Production,
  cfg?: Partial<Pick<ProductionAssembly, "fps" | "width" | "height">>
): AssemblyConfig {
  return {
    fps: pickInt(cfg?.fps ?? p.assembly?.fps, 24),
    width: pickInt(cfg?.width ?? p.assembly?.width, 1920),
    height: pickInt(cfg?.height ?? p.assembly?.height, 1080),
  };
}

function extOf(rel: string, fallback: string): string {
  const slash = rel.lastIndexOf("/");
  const dot = rel.lastIndexOf(".");
  if (dot <= slash) return fallback;
  const ext = rel.slice(dot).toLowerCase();
  return ext.length >= 2 && ext.length <= 6 ? ext : fallback;
}

function clampVolume(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
}

function round3(x: number): string {
  return (Math.round(x * 1000) / 1000).toFixed(3);
}

/** Non-drop-frame timecode HH:MM:SS:FF from a frame count. */
export function framesToTc(frames: number, fps: number): string {
  const f = Math.max(0, Math.round(frames));
  const fi = Math.max(1, Math.round(fps));
  const pad = (x: number, l = 2) => String(x).padStart(l, "0");
  const ff = f % fi;
  const totalSec = Math.floor(f / fi);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor(totalSec / 60) % 60;
  const s = totalSec % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
}

// ---- assemblyPlan ----------------------------------------------------------

export function assemblyPlan(p: Production): AssemblyPlan {
  const events: AssemblyEvent[] = [];
  const blanks: AssemblyPlan["blanks"] = [];
  const suspiciousStills: AssemblyPlan["suspiciousStills"] = [];
  const media: AssemblyPlan["media"] = [];
  const seen = new Map<string, string>();

  const addMedia = (srcRel: string, mediaRel: string): string => {
    const existing = seen.get(srcRel);
    if (existing) return existing;
    seen.set(srcRel, mediaRel);
    media.push({ srcRel, mediaRel });
    return mediaRel;
  };

  let t = 0;
  // Timeline projection (Spec 06): an enabled shot sequence's contiguous span
  // collapses into ONE event — its clip when it has one, a blank slot when it
  // doesn't (the animatic's slate). The member shots are replaced, so their
  // numbers land in `blanks` (the skipped-shots bookkeeping) and no per-shot
  // event is emitted for them.
  const shotById = new Map<string, ProductionShot>();
  for (const scene of p.scenes) for (const shot of scene.shots) shotById.set(shot.id, shot);
  for (const item of applyShotSequences([...shotById.values()], p.shotSequences ?? [], p.references)) {
    if (item.kind === "sequence") {
      const number = `SQ${(item.shotIds.map((id) => shotById.get(id)?.number).find(Boolean) ?? "0000")}`;
      const dur = item.durationSec;
      const clipRel = item.videoPath;
      // An output bound to a still holds that image over the span (the
      // animatic's held frame); an unbound output is a blank slot (its slate).
      const stillRel = !clipRel && item.artwork ? (originalForJpegRel(p, item.artwork) ?? item.artwork) : undefined;
      if (clipRel) {
        const mediaRel = addMedia(clipRel, `clips/${number}${extOf(clipRel, ".mp4")}`);
        const offsetSec = sanitizeVideoOffset(item.videoOffsetSec);
        events.push({ shotId: item.id, number, kind: "clip", srcRel: clipRel, mediaRel, durationSec: dur, muted: !!item.muted, startSec: t, endSec: t + dur, ...(offsetSec != null ? { offsetSec } : {}) });
      } else if (stillRel) {
        const mediaRel = addMedia(stillRel, `shots/${number}${extOf(stillRel, ".png")}`);
        events.push({ shotId: item.id, number, kind: "still", srcRel: stillRel, mediaRel, durationSec: dur, muted: false, startSec: t, endSec: t + dur });
      } else {
        events.push({ shotId: item.id, number, kind: "blank", durationSec: dur, muted: false, startSec: t, endSec: t + dur });
      }
      for (const id of item.shotIds) {
        const member = shotById.get(id);
        if (member) blanks.push(member.number);
      }
      t += dur;
      continue;
    }
    const shot = shotById.get(item.id);
    if (!shot) continue;
    {
      const dur = Math.max(0.1, shot.durationSec ?? 3);
      // The export resolves exactly what the storyboard shows: the shared
      // display helper reads the pipe when bound, the legacy mirrors when
      // the shot never had a pipe (classic docs).
      const display = resolveShotDisplay(shot);
      const clipRel = display.media === "clip" ? display.path : undefined;
      const stillFrame = display.media === "still" ? display.path : display.stillPath;
      const stillRel = stillFrame ? originalForJpegRel(p, stillFrame) ?? stillFrame : undefined;

      // In-betweener shots lay their ORIGINAL per-block clips back-to-back —
      // never the stitched preview (which may be a re-encode). Each block
      // keeps its own timeline duration, so no recompression ever reaches the
      // EDL, the export folder, the AE script, or the render.
      if (shot.graphOutputSource === "tween") {
        const clips = tweenSelectedClips(shot.graphTweenBlocks ?? []);
        const filesExist = clips.length > 0 && clips.every((c) => {
          try { return fs.existsSync(assetPath(p, c.path)); } catch { return false; }
        });
        if (filesExist) {
          if (stillRel) addMedia(stillRel, `shots/${shot.number}${extOf(stillRel, ".png")}`);
          clips.forEach((c, i) => {
            const letter = String.fromCharCode(97 + Math.min(i, 25));
            const mediaRel = addMedia(c.path, `clips/${shot.number}-tween-${letter}${extOf(c.path, ".mp4")}`);
            const bDur = Math.max(0.1, c.durationSec);
            events.push({ shotId: shot.id, number: `${shot.number}${letter}`, kind: "clip", srcRel: c.path, mediaRel, durationSec: bDur, muted: !!shot.muted, startSec: t, endSec: t + bDur });
            t += bDur;
          });
          continue;
        }
        // Unstitched / missing blocks: fall through to the normal single-clip
        // path below (stitched preview or blank) so the timeline never shifts.
      }

      // A still is legitimate (a shot may be still-only) — but if the
      // production shows a video generation for this shot, the still means the
      // clip was generated yet never registered. Flag it loudly rather than
      // silently shipping a frozen frame.
      const expectedClip =
        !!shot.pendingVideoGen ||
        shot.graphOutputSource === "videogen" ||
        (shot.graphVideoNodes ?? []).some((n) => (n.gens?.length ?? 0) > 0);
      if (!clipRel && stillRel && expectedClip) suspiciousStills.push(shot.number);

      // Selects: video generations tagged as selects ship with the assembly
      // even when they are not the shot's active clip (deduped by source).
      for (const node of shot.graphVideoNodes ?? []) {
        (node.gens ?? []).forEach((g, gi) => {
          if (g.select && g.path) addMedia(g.path, `clips/selects/${shot.number}-${node.id}-${gi + 1}${extOf(g.path, ".mp4")}`);
        });
      }
      if (stillRel) addMedia(stillRel, `shots/${shot.number}${extOf(stillRel, ".png")}`);
      if (clipRel) {
        const mediaRel = addMedia(clipRel, `clips/${shot.number}${extOf(clipRel, ".mp4")}`);
        const offsetSec = sanitizeVideoOffset(shot.videoOffsetSec);
        events.push({ shotId: shot.id, number: shot.number, kind: "clip", srcRel: clipRel, mediaRel, durationSec: dur, muted: !!shot.muted, startSec: t, endSec: t + dur, ...(offsetSec != null ? { offsetSec } : {}) });
      } else if (stillRel) {
        const mediaRel = addMedia(stillRel, `shots/${shot.number}${extOf(stillRel, ".png")}`);
        events.push({ shotId: shot.id, number: shot.number, kind: "still", srcRel: stillRel, mediaRel, durationSec: dur, muted: false, startSec: t, endSec: t + dur });
      } else {
        events.push({ shotId: shot.id, number: shot.number, kind: "blank", durationSec: dur, muted: false, startSec: t, endSec: t + dur });
        blanks.push(shot.number);
      }
      t += dur;
    }
  }

  const voiceover = p.voiceoverPath
    ? { srcRel: p.voiceoverPath, mediaRel: addMedia(p.voiceoverPath, `audio/voiceover${extOf(p.voiceoverPath, ".mp3")}`), volume: clampVolume(p.voiceoverVolume ?? 1) }
    : undefined;
  const music = p.musicPath
    ? { srcRel: p.musicPath, mediaRel: addMedia(p.musicPath, `audio/music${extOf(p.musicPath, ".mp3")}`), volume: clampVolume(p.musicVolume ?? 0.5) }
    : undefined;

  return { events, voiceover, music, totalSec: t, blanks, suspiciousStills, media };
}

// ---- assemblyPlanFromTimeline ---------------------------------------------

/**
 * The same plan, read from the multi-track timeline model instead of the
 * shot projection (Animatic Editor Expansion Item 1). The shared resolver
 * flattens video to topmost-visible spans; this builder turns spans into
 * the exact AssemblyEvent shape `assemblyPlan` produces, so buildEdl /
 * buildAeScript / buildManifest / renderAnimatic consume either plan
 * unchanged. On a timeline seeded from the legacy projection the two
 * plans are identical (the Item 1 migration guarantee, unit-tested
 * against a pre-change fixture) — including the shot-level concerns the
 * legacy plan carries: tween block expansion, selects gathering, and the
 * suspicious-still warning, all keyed by the clips' shot provenance.
 * `assemble()` still plans from the projection until Item 9 switches the
 * call site.
 */
/** Sparse bed fade fields from a timeline audio clip (Item 7). */
function bedFadeFields(clip: TimelineClip): Pick<AssemblyAudio, "fadeInSec" | "fadeOutSec" | "durationSec"> {
  return {
    ...((clip.fadeInSec ?? 0) > 0 ? { fadeInSec: clip.fadeInSec } : {}),
    ...((clip.fadeOutSec ?? 0) > 0 ? { fadeOutSec: clip.fadeOutSec } : {}),
    ...(clip.fadeInSec || clip.fadeOutSec ? { durationSec: clipDurationSec(clip) } : {}),
  };
}

export function assemblyPlanFromTimeline(p: Production): AssemblyPlan {
  const timeline = p.timeline;
  if (!timeline) {
    throw new Error("assemblyPlanFromTimeline: production has no timeline (seed it from the shot projection first)");
  }
  const resolved = resolveTimeline(timeline);
  const events: AssemblyEvent[] = [];
  const blanks: AssemblyPlan["blanks"] = [];
  const suspiciousStills: AssemblyPlan["suspiciousStills"] = [];
  const media: AssemblyPlan["media"] = [];
  const seen = new Map<string, string>();
  const addMedia = (srcRel: string, mediaRel: string): string => {
    const existing = seen.get(srcRel);
    if (existing) return existing;
    seen.set(srcRel, mediaRel);
    media.push({ srcRel, mediaRel });
    return mediaRel;
  };
  const shotById = new Map<string, ProductionShot>();
  for (const scene of p.scenes) for (const shot of scene.shots) shotById.set(shot.id, shot);
  const clipSrc = (clip: TimelineClip): string | undefined =>
    mediaPathForId(p.media, clip.mediaId) ?? clip.srcRel;

  // Split spans at blend boundaries (Item 8) so each half-window is
  // its own event; the pairs merge into blend events after the loop.
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

  for (const span of pieces) {
    const dur = span.endSec - span.startSec;
    const clip = span.clip;
    if (!clip) {
      events.push({ shotId: "gap", number: "BLANK", kind: "blank", durationSec: dur, muted: false, startSec: span.startSec, endSec: span.endSec });
      continue;
    }
    // How far into the clip this span begins (0 unless a higher track
    // covered the clip's head): the source window advances with the span.
    const intoClip = Math.max(0, span.startSec - clip.timelineStartSec);
    const win = clipSourceWindowAt(clip, intoClip, dur);
    const offsetSec = win.startSec;
    const spanCurve = speedCurveForSpan(clip, intoClip, dur);
    const avgSpeed = dur > 0 ? (win.endSec - win.startSec) / dur : 1;
    // Audio (Item 7): effective gain folds track volume in here so the
    // render chain stays a dumb applier; fades ride clip-local with the
    // span offset. Sparse: unity/no-fade/preserve emit nothing.
    const effVol = clipVolume(clip) * (span.track ? trackVolume(span.track) : 1);
    const audioFields = {
      ...(effVol !== 1 ? { volume: effVol } : {}),
      ...((clip.fadeInSec ?? 0) > 0 ? { fadeInSec: clip.fadeInSec } : {}),
      ...((clip.fadeOutSec ?? 0) > 0 ? { fadeOutSec: clip.fadeOutSec } : {}),
      ...(clip.fadeInSec || clip.fadeOutSec ? { clipDurSec: clipDurationSec(clip), ...(intoClip > 0 ? { gainOffsetSec: intoClip } : {}) } : {}),
      ...(clip.pitchMode === "natural" ? { pitchMode: "natural" as const } : {}),
    };
    const speedFields = {
      ...(spanCurve ? { speedCurve: spanCurve, speed: avgSpeed } : clipSpeed(clip) !== 1 ? { speed: clipSpeed(clip) } : {}),
      ...(clip.speedInterp ? { speedInterp: clip.speedInterp } : {}),
      ...(clip.reversed ? { reversed: true } : {}),
      ...audioFields,
    };

    if (clip.sequenceId) {
      const number = `SQ${(clip.memberShotIds?.map((id) => shotById.get(id)?.number).find(Boolean) ?? "0000")}`;
      const eventId = `seq:${clip.sequenceId}`;

      const src = clipSrc(clip);
      if (clip.sourceKind === "video" && src) {
        const mediaRel = addMedia(src, `clips/${number}${extOf(src, ".mp4")}`);
        events.push({ shotId: eventId, number, kind: "clip", srcRel: src, mediaRel, durationSec: dur, muted: !!clip.muted, startSec: span.startSec, endSec: span.endSec, ...(offsetSec > 0 ? { offsetSec } : {}), ...speedFields });
      } else if (clip.sourceKind === "still" && src) {
        const stillRel = originalForJpegRel(p, src) ?? src;
        const mediaRel = addMedia(stillRel, `shots/${number}${extOf(stillRel, ".png")}`);
        events.push({ shotId: eventId, number, kind: "still", srcRel: stillRel, mediaRel, durationSec: dur, muted: false, startSec: span.startSec, endSec: span.endSec });
      } else {
        events.push({ shotId: eventId, number, kind: "blank", durationSec: dur, muted: false, startSec: span.startSec, endSec: span.endSec });
      }
      for (const id of clip.memberShotIds ?? []) {
        const member = shotById.get(id);
        if (member) blanks.push(member.number);
      }
      continue;
    }

    const shot = clip.shotId ? shotById.get(clip.shotId) : undefined;
    const number = shot?.number ?? clip.name ?? "CLIP";
    const eventId = clip.shotId ?? clip.id;

    // In-betweener shots lay their original per-block clips back-to-back,
    // exactly as the legacy plan does (anchored at the span's start).
    if (shot?.graphOutputSource === "tween") {
      const clips = tweenSelectedClips(shot.graphTweenBlocks ?? []);
      const filesExist = clips.length > 0 && clips.every((c) => {
        try { return fs.existsSync(assetPath(p, c.path)); } catch { return false; }
      });
      if (filesExist) {
        const display = resolveShotDisplay(shot);
        const stillFrame = display.media === "still" ? display.path : display.stillPath;
        const stillRel = stillFrame ? originalForJpegRel(p, stillFrame) ?? stillFrame : undefined;
        if (stillRel) addMedia(stillRel, `shots/${shot.number}${extOf(stillRel, ".png")}`);
        let bt = span.startSec;
        clips.forEach((c, i) => {
          const letter = String.fromCharCode(97 + Math.min(i, 25));
          const mediaRel = addMedia(c.path, `clips/${shot.number}-tween-${letter}${extOf(c.path, ".mp4")}`);
          const bDur = Math.max(0.1, c.durationSec);
          events.push({ shotId: shot.id, number: `${shot.number}${letter}`, kind: "clip", srcRel: c.path, mediaRel, durationSec: bDur, muted: !!shot.muted, startSec: bt, endSec: bt + bDur });
          bt += bDur;
        });
        continue;
      }
    }

    if (shot) {
      // Selects ship with the assembly even when not the active clip.
      for (const node of shot.graphVideoNodes ?? []) {
        (node.gens ?? []).forEach((g, gi) => {
          if (g.select && g.path) addMedia(g.path, `clips/selects/${shot.number}-${node.id}-${gi + 1}${extOf(g.path, ".mp4")}`);
        });
      }
      // The shot's full-res still is gathered beside its clip (storyboard).
      const display = resolveShotDisplay(shot);
      const stillFrame = display.media === "still" ? display.path : display.stillPath;
      const stillRel = stillFrame ? originalForJpegRel(p, stillFrame) ?? stillFrame : undefined;
      if (stillRel && clip.sourceKind === "video") addMedia(stillRel, `shots/${shot.number}${extOf(stillRel, ".png")}`);
      const expectedClip =
        !!shot.pendingVideoGen ||
        shot.graphOutputSource === "videogen" ||
        (shot.graphVideoNodes ?? []).some((n) => (n.gens?.length ?? 0) > 0);
      if (clip.sourceKind === "still" && expectedClip) suspiciousStills.push(shot.number);
    }

    const src = clipSrc(clip);
    if (clip.sourceKind === "video" && src) {
      const mediaRel = addMedia(src, `clips/${number}${extOf(src, ".mp4")}`);
      events.push({ shotId: eventId, number, kind: "clip", srcRel: src, mediaRel, durationSec: dur, muted: !!clip.muted, startSec: span.startSec, endSec: span.endSec, ...(offsetSec > 0 ? { offsetSec } : {}), ...speedFields });
    } else if (clip.sourceKind === "still" && src) {
      const stillRel = originalForJpegRel(p, src) ?? src;
      const mediaRel = addMedia(stillRel, `shots/${number}${extOf(stillRel, ".png")}`);
      events.push({ shotId: eventId, number, kind: "still", srcRel: stillRel, mediaRel, durationSec: dur, muted: false, startSec: span.startSec, endSec: span.endSec });
    } else {
      events.push({ shotId: eventId, number, kind: "blank", durationSec: dur, muted: false, startSec: span.startSec, endSec: span.endSec });
      if (shot) blanks.push(shot.number);
    }
  }

  // Merge blend half-window event pairs (Item 8): the outgoing event
  // (ending at the edit) becomes a full-window blend event whose source
  // window extends into its tail handle; the incoming event rides
  // along as blendWith with its window extended into the head handle.
  // Pairs are located by exact boundaries + source; spans that took a
  // multi-event path (tween blocks) simply don't match and stay cuts.
  for (let bi = resolved.blendSpans.length - 1; bi >= 0; bi--) {
    const blend = resolved.blendSpans[bi];
    const i = events.findIndex(
      (e) =>
        Math.abs(e.startSec - blend.startSec) < 1e-9 &&
        Math.abs(e.endSec - blend.editSec) < 1e-9 &&
        (blend.outgoing.sourceKind !== "video" || e.srcRel === clipSrc(blend.outgoing))
    );
    if (i < 0) continue;
    const a = events[i];
    const b = events[i + 1];
    if (!b || Math.abs(b.startSec - blend.editSec) > 1e-9 || Math.abs(b.endSec - blend.endSec) > 1e-9) continue;
    if (blend.incoming.sourceKind === "video" && b.srcRel !== clipSrc(blend.incoming)) continue;
    const D = blend.transition.durationSec;
    const half = D / 2;
    a.durationSec = D;
    a.endSec = blend.endSec;
    if (a.reversed && a.kind === "clip") {
      a.offsetSec = clipSourceTimeAtLoose(blend.outgoing, clipDurationSec(blend.outgoing) + half);
    }
    b.durationSec = D;
    b.startSec = blend.startSec;
    if (b.kind === "clip") {
      b.offsetSec = b.reversed
        ? clipSourceTimeAtLoose(blend.incoming, half)
        : clipSourceTimeAtLoose(blend.incoming, -half);
      if (b.offsetSec <= 0) delete b.offsetSec;
      if (b.fadeInSec || b.fadeOutSec) b.gainOffsetSec = -half;
    }
    a.blendWith = b;
    events.splice(i + 1, 1);
  }

  // Audio: the seeded beds map back to the plan's voiceover/music slots by
  // role; any other audible clip is at least gathered into the export
  // folder (the plan's audio shape generalizes in Item 9).
  let voiceover: AssemblyAudio | undefined;
  let music: AssemblyAudio | undefined;
  // Legacy gather order (voiceover bed, then music bed, then anything
  // else) so a seeded timeline's media list matches the legacy plan's.
  const orderedAudio = [
    ...resolved.audioClips.filter((a) => a.clip.role === "voiceover"),
    ...resolved.audioClips.filter((a) => a.clip.role === "music"),
    ...resolved.audioClips.filter((a) => !a.clip.role),
  ];
  for (const { clip, track } of orderedAudio) {
    const src = clipSrc(clip);
    if (!src) continue;
    if (clip.role === "voiceover" && !voiceover) {
      voiceover = { srcRel: src, mediaRel: addMedia(src, `audio/voiceover${extOf(src, ".mp3")}`), volume: clampVolume((clip.volume ?? 1) * trackVolume(track)), ...bedFadeFields(clip) };
    } else if (clip.role === "music" && !music) {
      music = { srcRel: src, mediaRel: addMedia(src, `audio/music${extOf(src, ".mp3")}`), volume: clampVolume((clip.volume ?? 0.5) * trackVolume(track)), ...bedFadeFields(clip) };
    } else {
      addMedia(src, `audio/${clip.id}${extOf(src, ".mp3")}`);
    }
  }

  // Generalized mix entries (Item 9): every audible clip with its
  // position/trim/retime/gain — the same fields preview plays. Curve
  // clips ride at their average tempo (the stated A5 approximation).
  const audioEvents: AssemblyAudioEvent[] = [];
  for (const { clip, track } of orderedAudio) {
    const src = clipSrc(clip);
    if (!src) continue;
    const mediaRel = seen.get(src);
    if (!mediaRel) continue;
    const dur = clipDurationSec(clip);
    const fallbackVol = clip.role === "music" ? 0.5 : 1;
    audioEvents.push({
      srcRel: src,
      mediaRel,
      startSec: clip.timelineStartSec,
      durationSec: dur,
      offsetSec: clip.reversed ? clipSourceTimeAtLoose(clip, dur) : (clip.sourceInSec ?? 0),
      ...(clipSpeed(clip) !== 1 ? { speed: clipSpeed(clip) } : {}),
      ...(clip.reversed ? { reversed: true } : {}),
      ...(clip.pitchMode === "natural" ? { pitchMode: "natural" as const } : {}),
      volume: clampVolume((clip.volume ?? fallbackVol) * trackVolume(track)),
      ...((clip.fadeInSec ?? 0) > 0 ? { fadeInSec: clip.fadeInSec } : {}),
      ...((clip.fadeOutSec ?? 0) > 0 ? { fadeOutSec: clip.fadeOutSec } : {}),
      ...(clip.fadeInSec || clip.fadeOutSec ? { clipDurSec: dur } : {}),
      ...(clip.role ? { role: clip.role } : {}),
    });
  }

  return { events, voiceover, music, totalSec: resolved.totalSec, blanks, suspiciousStills, media, audioEvents };
}

// ---- buildEdl --------------------------------------------------------------

/** EDL reel for an event: normal shots ride `SHOT<NNNN>`; in-betweener block
 *  sub-events (number `NNNNx`) ride `TW<NNNN><X>`; shot-sequence events
 *  (number `SQ<NNNN>`, named after their first member) ride `SQ<NNNN>` — so
 *  every reel stays within the 8-char CMX3600 field while remaining distinct
 *  per original clip. */
export function edlReelFor(number: string): string {
  const m = /^(\d{4})([a-z])$/.exec(number);
  if (m) return `TW${m[1]}${m[2].toUpperCase()}`;
  const sq = /^SQ(\d{4})$/.exec(number);
  if (sq) return `SQ${sq[1]}`;
  return `SHOT${number}`;
}

/** CMX3600 M2 motion-effect speed: signed frames/sec (48.0 = 2x at a
 *  24 timebase; negative = reverse), zero-padded like editor output. */
export function m2Speed(speedFactor: number, reversed: boolean, fps: number): string {
  const v = Math.abs(speedFactor * fps).toFixed(1).padStart(5, "0");
  return reversed ? `-${v}` : v;
}

/** CMX3600 EDL. Stills use source-in == source-out == 0 (a freeze); clips use
 *  the planned (probe-clamped) duration; blank slots use the `BL` reel with a
 *  zero-length source. VO/music ride the A track as events spanning the full
 *  timeline. CRLF line endings. */
export function buildEdl(plan: AssemblyPlan, fps: number, title: string): string {
  const lines: string[] = [
    `TITLE: ${title.replace(/[\r\n]+/g, " ").slice(0, 80) || "Cascade Assembly"}`,
    "FCM: NON-DROP FRAME",
    "",
  ];
  let n = 1;
  const event = (reel: string, track: "V" | "A", srcIn: string, srcOut: string, recIn: string, recOut: string, clip: string, note?: string, transition?: string, m2?: string) => {
    lines.push(`${String(n).padStart(3, "0")}  ${reel.padEnd(8, " ")}  ${track}     ${transition ?? "C       "} ${srcIn} ${srcOut} ${recIn} ${recOut}`);
    if (m2) lines.push(`M2   ${reel.padEnd(8, " ")}  ${m2}  ${srcIn}`);
    lines.push(`* FROM CLIP NAME: ${clip}`);
    if (note) lines.push(`* NOTE: ${note}`);
    n++;
  };
  for (const ev of plan.events) {
    if (ev.kind === "blank" && !ev.blendWith) {
      event(
        "BL",
        "V",
        "00:00:00:00",
        "00:00:00:00",
        framesToTc(ev.startSec * fps, fps),
        framesToTc(ev.endSec * fps, fps),
        "BLACK"
      );
      continue;
    }
    if (ev.blendWith) {
      // Dissolve (Item 8): the outgoing side ends at the edit point as
      // a cut; the incoming side carries the CMX3600 D transition with
      // its frame count. Source windows are the full handle windows.
      const b = ev.blendWith;
      const editSec = ev.startSec + ev.durationSec / 2;
      const srcOf = (e: typeof ev, fromSec: number, toSec: number): [string, string] => {
        if (e.kind !== "clip") return ["00:00:00:00", "00:00:00:00"];
        const off = e.offsetSec != null && e.offsetSec > 0 ? e.offsetSec : 0;
        const sp = e.speed ?? 1;
        return [framesToTc(Math.round((off + fromSec * sp) * fps), fps), framesToTc(Math.round((off + toSec * sp) * fps), fps)];
      };
      const [aIn, aOut] = srcOf(ev, 0, ev.durationSec / 2);
      event(edlReelFor(ev.number), "V", aIn, aOut, framesToTc(ev.startSec * fps, fps), framesToTc(editSec * fps, fps), ev.mediaRel ?? "BLACK");
      const [bIn, bOut] = srcOf(b, ev.durationSec / 2, ev.durationSec);
      event(
        edlReelFor(b.number), "V", bIn, bOut, framesToTc(editSec * fps, fps), framesToTc(ev.endSec * fps, fps),
        b.mediaRel ?? "BLACK", "Cascade cross-dissolve (centered)", `D    ${String(Math.round(ev.durationSec * fps)).padStart(3, "0")}`
      );
      continue;
    }
    // A slipped clip's source window opens at its offset, not at zero.
    const srcInSec = ev.kind === "clip" && ev.offsetSec != null && ev.offsetSec > 0 ? ev.offsetSec : 0;
    const srcAvailSec = ev.kind === "clip"
      ? Math.max(0, Math.min(ev.probedSec != null ? ev.probedSec - srcInSec : ev.durationSec * (ev.speed ?? 1), ev.durationSec * (ev.speed ?? 1)))
      : 0;
    const srcInFrames = Math.round(srcInSec * fps);
    const srcFrames = ev.kind === "clip" ? srcInFrames + Math.round(srcAvailSec * fps) : 0;
    event(
      edlReelFor(ev.number),
      "V",
      framesToTc(srcInFrames, fps),
      framesToTc(srcFrames, fps),
      framesToTc(ev.startSec * fps, fps),
      framesToTc(ev.endSec * fps, fps),
      ev.mediaRel ?? "BLACK",
      ev.kind === "clip" && (ev.speed != null || ev.reversed || ev.speedCurve)
        ? ev.speedCurve
          ? `Cascade speed ramp, average ${(ev.speed ?? 1).toFixed(2)}x${ev.reversed ? " reversed" : ""} - EDL carries the cut only; retime downstream`
          : `Cascade speed ${ev.speed != null ? `${ev.speed.toFixed(2)}x` : "1.00x"}${ev.reversed ? " reversed" : ""} - see the M2 line`
        : undefined,
      undefined,
      ev.kind === "clip" && (ev.speed != null || ev.reversed) ? m2Speed(ev.speed ?? 1, !!ev.reversed, fps) : undefined
    );
  }
  if (plan.voiceover) {
    const srcFrames = plan.voiceover.probedSec != null ? Math.round(Math.min(plan.voiceover.probedSec, plan.totalSec) * fps) : Math.round(plan.totalSec * fps);
    event(
      "VOICE",
      "A",
      "00:00:00:00",
      framesToTc(srcFrames, fps),
      "00:00:00:00",
      framesToTc(plan.totalSec * fps, fps),
      plan.voiceover.mediaRel,
      plan.voiceover.probedSec == null ? "voiceover duration unverified" : undefined
    );
  }
  if (plan.music) {
    const srcFrames = plan.music.probedSec != null ? Math.round(Math.min(plan.music.probedSec, plan.totalSec) * fps) : Math.round(plan.totalSec * fps);
    event(
      "MUSIC",
      "A",
      "00:00:00:00",
      framesToTc(srcFrames, fps),
      "00:00:00:00",
      framesToTc(plan.totalSec * fps, fps),
      plan.music.mediaRel,
      plan.music.probedSec == null ? "music duration unverified" : undefined
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// ---- buildAeScript ---------------------------------------------------------

function aeStr(s: string): string {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function dB(volume: number): string {
  if (volume <= 0) return "-inf";
  return (20 * Math.log(volume) / Math.LN10).toFixed(2);
}

/** After Effects ExtendScript that rebuilds the animatic as a composition.
 *  Media paths are resolved relative to the script file so the export folder
 *  stays portable. Saves Assembly.aep next to the script. */
/**
 * Per-video-track CMX3600 EDLs (Item 12) — CMX3600 is
 * single-video-track, so each timeline video track gets its own file
 * (Assembly-V1.edl = bottom track …). Reads the timeline model:
 * every clip on the track in record order with BL filler, constant
 * speeds and dissolves native, and speed RAMPS BAKED: each ramped
 * clip splits at its curve keyframes into constant-speed events,
 * each with an M2 line at the segment's average speed. Segment
 * record ranges sum to the clip's exact duration and consumed
 * source ranges are contiguous, so total timeline duration and end
 * frames are preserved; intra-segment timing linearizes (stated).
 */
export function buildTrackEdls(p: Production, fps: number): { files: { name: string; content: string }[]; report: string[] } {
  const report: string[] = [];
  let timeline = p.timeline;
  if (!timeline) {
    let n = 0;
    timeline = seedTimelineFromProduction(p, (prefix) => `${prefix}-seed-${++n}`);
    report.push("Production had no stored timeline; per-track EDLs use the seeded shot-projection timeline.");
  }
  const resolved = resolveTimeline(timeline);
  const totalFrames = Math.round(resolved.totalSec * fps);
  const F = (sec: number): number => Math.round(sec * fps);
  const tc = (frames: number): string => framesToTc(frames, fps);
  const clipSrc = (clip: TimelineClip): string | undefined =>
    mediaPathForId(p.media, clip.mediaId) ?? clip.srcRel;
  const shots = p.scenes.flatMap((sc) => sc.shots);
  const shotById = new Map(shots.map((s) => [s.id, s]));
  const numberOf = (clip: TimelineClip): string => {
    const shot = clip.shotId ? shotById.get(clip.shotId) : undefined;
    return shot?.number ?? "AX";
  };
  const dissolveInto = new Map<string, number>();
  for (const tr of timeline.transitions ?? []) dissolveInto.set(tr.incomingClipId, tr.durationSec);

  let bakedSegments = 0;
  let bakedClips = 0;
  const videoTracks = [...timeline.tracks.filter((t) => t.kind === "video")].reverse(); // V1 = bottom
  const files = videoTracks.map((track, ti) => {
    const lines: string[] = [
      `TITLE: ${(p.meta.name || "Cascade Assembly").replace(/[\r\n]+/g, " ").slice(0, 66)} V${ti + 1} (${track.name})`,
      "FCM: NON-DROP FRAME",
      "",
    ];
    let n = 1;
    const event = (reel: string, srcInF: number, srcOutF: number, recInF: number, recOutF: number, clipName: string, opts?: { note?: string; transitionFrames?: number; m2?: string }): void => {
      const trans = opts?.transitionFrames ? `D    ${String(opts.transitionFrames).padStart(3, "0")}` : "C       ";
      lines.push(`${String(n).padStart(3, "0")}  ${reel.padEnd(8, " ")}  V     ${trans} ${tc(srcInF)} ${tc(srcOutF)} ${tc(recInF)} ${tc(recOutF)}`);
      if (opts?.m2) lines.push(`M2   ${reel.padEnd(8, " ")}  ${opts.m2}  ${tc(srcInF)}`);
      lines.push(`* FROM CLIP NAME: ${clipName}`);
      if (opts?.note) lines.push(`* NOTE: ${opts.note}`);
      n++;
    };
    const blank = (fromF: number, toF: number): void => {
      if (toF <= fromF) return;
      event("BL", 0, 0, fromF, toF, "BLACK");
    };

    let cursorF = 0;
    const clips = timeline.clips
      .filter((c) => c.trackId === track.id)
      .sort((a, b) => a.timelineStartSec - b.timelineStartSec);
    for (const clip of clips) {
      const startF = F(clip.timelineStartSec);
      blank(cursorF, startF);
      const dur = clipDurationSec(clip);
      const endF = F(clip.timelineStartSec + dur);
      if (clip.sourceKind === "blank") {
        blank(Math.max(cursorF, startF), endF);
        cursorF = Math.max(cursorF, endF);
        continue;
      }
      const reel = edlReelFor(numberOf(clip));
      const clipName = clipSrc(clip) ?? clip.name ?? "Clip";
      const dissolve = dissolveInto.get(clip.id);
      if (clip.sourceKind === "still") {
        event(reel, 0, 0, startF, endF, clipName, {
          note: "STILL (freeze) in Cascade",
          transitionFrames: dissolve ? F(dissolve) : undefined,
        });
        cursorF = endF;
        continue;
      }
      // Bake: split at curve keyframes (constant clips = one segment).
      const bounds = [0, ...(clip.speedCurve ?? []).map((k) => k.atSec).filter((t) => t > 0 && t < dur), dur]
        .sort((a, b) => a - b);
      if (clip.speedCurve?.length) bakedClips++;
      for (let s = 0; s + 1 < bounds.length; s++) {
        const t0 = bounds[s];
        const t1 = bounds[s + 1];
        if (t1 <= t0) continue;
        const src0 = clipSourceTimeAtLoose(clip, t0);
        const src1 = clipSourceTimeAtLoose(clip, t1);
        const avg = Math.abs(src1 - src0) / (t1 - t0);
        if (clip.speedCurve?.length) bakedSegments++;
        event(
          reel,
          F(src0),
          F(src1),
          F(clip.timelineStartSec + t0),
          F(clip.timelineStartSec + t1),
          clipName,
          {
            note: clip.speedCurve?.length
              ? `Cascade speed-ramp segment ${s + 1}/${bounds.length - 1} (average ${avg.toFixed(2)}x; baked for EDL)`
              : undefined,
            transitionFrames: s === 0 && dissolve ? F(dissolve) : undefined,
            m2: avg !== 1 || clip.reversed ? m2Speed(avg, !!clip.reversed, fps) : undefined,
          }
        );
      }
      cursorF = endF;
    }
    blank(cursorF, totalFrames);
    return { name: `Assembly-V${ti + 1}.edl`, content: lines.join("\r\n") + "\r\n" };
  });

  if (bakedClips) {
    report.push(`${bakedClips} ramped clip(s) baked into ${bakedSegments} constant-speed EDL segments at curve keyframes (segment-average M2 speeds; total timeline duration preserved at ${resolved.totalSec.toFixed(2)}s).`);
  }
  if (timeline.clips.some((c) => c.pitchMode === "natural")) {
    report.push("Natural pitch-shift retiming has no EDL representation; M2 speeds carry the retime only.");
  }
  report.push("Audio beyond the VO/music beds in Assembly.edl is not represented in EDLs — use the FCPXML or Premiere XML for full audio tracks.");
  return { files, report };
}

export function buildAeScript(plan: AssemblyPlan, cfg: AssemblyConfig, exportRoot: string): string {
  const media = exportRoot.replace(/\\/g, "/") + "/media";
  const lines: string[] = [
    "// Generated by Cascade — Assembly rebuild script (do not edit).",
    "// After Effects CC2019+. File > Scripts > Run Script File…",
    "var scriptDir = (new File($.fileName)).path;",
    `var media = scriptDir + ${aeStr("/media")};`,
    "var proj = app.newProject();",
    `var comp = proj.items.addComp(${aeStr("Assembly")}, ${cfg.width}, ${cfg.height}, 1, ${round3(plan.totalSec)}, ${cfg.fps});`,
    "",
  ];
  // Native AE time-remapping for ramped events (Item 13): keyframes
  // sampled from the shared curve integral (endpoints exact), values
  // in absolute footage seconds. Returns true when remap replaced the
  // layer's plain inPoint handling.
  const emitTimeRemap = (lay: string, evLike: AssemblyEvent): boolean => {
    if (evLike.kind !== "clip" || !evLike.speedCurve?.length) return false;
    const curve = evLike.speedCurve;
    const dur = evLike.durationSec;
    const off = evLike.offsetSec != null && evLike.offsetSec > 0 ? evLike.offsetSec : 0;
    const total = speedCurveIntegral(curve, dur);
    const marks = [0, ...curve.map((k) => k.atSec).filter((t) => t > 0 && t < dur), dur].sort((a, b) => a - b);
    const samples: number[] = [];
    marks.forEach((t, j) => {
      samples.push(t);
      if (j + 1 < marks.length) samples.push((t + marks[j + 1]) / 2);
    });
    lines.push(`// Cascade speed ramp on ${evLike.number}: native time remapping (Item 13).`);
    lines.push(`${lay}.timeRemapEnabled = true;`);
    lines.push(`var tr_${lay} = ${lay}.property("ADBE Time Remapping");`);
    lines.push(`while (tr_${lay}.numKeys > 0) { tr_${lay}.removeKey(1); }`);
    for (const t of samples) {
      const consumed = speedCurveIntegral(curve, t);
      const src = evLike.reversed ? off + (total - consumed) : off + consumed;
      lines.push(`tr_${lay}.setValueAtTime(${round3(evLike.startSec + t)}, ${round3(src)});`);
    }
    return true;
  };

  plan.events.forEach((ev, i) => {
    if (ev.kind === "blank") {
      lines.push(`var lay${i} = comp.layers.addSolid([0, 0, 0], ${aeStr("BLANK")}, ${cfg.width}, ${cfg.height}, 1);`);
    } else {
      lines.push(`var foot${i} = proj.importFile(new ImportOptions(new File(media + ${aeStr("/" + (ev.mediaRel ?? ""))})));`);
      lines.push(`var lay${i} = comp.layers.add(foot${i});`);
    }
    lines.push(`lay${i}.name = ${aeStr(ev.number)};`);
    lines.push(`lay${i}.startTime = ${round3(ev.startSec)};`);
    lines.push(`lay${i}.outPoint = ${round3(ev.endSec)};`);
    const remapped = emitTimeRemap(`lay${i}`, ev);
    if (!remapped && ev.kind === "clip" && ev.offsetSec != null && ev.offsetSec > 0) lines.push(`lay${i}.inPoint = ${round3(ev.offsetSec)};`);
    if (ev.kind === "clip" && ev.muted) lines.push(`lay${i}.audioEnabled = false;`);
    if (!remapped && ev.kind === "clip" && ev.speed != null) lines.push(`// Cascade speed ${ev.speed.toFixed(2)}x on ${ev.number}: apply Time Stretch ${Math.round(100 / ev.speed)}% to this layer.`);
    if (!remapped && ev.kind === "clip" && ev.reversed) lines.push(`// Cascade: ${ev.number} plays reversed — apply Layer > Time > Time-Reverse Layer.`);
    if (ev.blendWith) {
      // Cross-dissolve (Item 8): the incoming side gets its own layer
      // over the blend window with an opacity ramp 0 -> 100; this
      // event's layer plays underneath at full opacity.
      const b = ev.blendWith;
      lines.push(`// Cascade cross-dissolve ${ev.durationSec.toFixed(2)}s into ${b.number} (centered on the cut).`);
      if (b.kind === "blank") {
        lines.push(`var lay${i}b = comp.layers.addSolid([0, 0, 0], ${aeStr("BLANK")}, ${cfg.width}, ${cfg.height}, 1);`);
      } else {
        lines.push(`var foot${i}b = proj.importFile(new ImportOptions(new File(media + ${aeStr("/" + (b.mediaRel ?? ""))})));`);
        lines.push(`var lay${i}b = comp.layers.add(foot${i}b);`);
      }
      lines.push(`lay${i}b.name = ${aeStr(b.number)};`);
      lines.push(`lay${i}b.startTime = ${round3(ev.startSec)};`);
      lines.push(`lay${i}b.outPoint = ${round3(ev.endSec)};`);
      const remappedB = emitTimeRemap(`lay${i}b`, b);
      if (!remappedB && b.kind === "clip" && b.offsetSec != null && b.offsetSec > 0) lines.push(`lay${i}b.inPoint = ${round3(b.offsetSec)};`);
      if (b.kind === "clip" && b.muted) lines.push(`lay${i}b.audioEnabled = false;`);
      lines.push(`lay${i}b.property("ADBE Transform Group").property("ADBE Opacity").setValueAtTime(${round3(ev.startSec)}, 0);`);
      lines.push(`lay${i}b.property("ADBE Transform Group").property("ADBE Opacity").setValueAtTime(${round3(ev.endSec)}, 100);`);
    }
    lines.push("");
  });
  const bed = (name: string, audio: AssemblyAudio | undefined) => {
    if (!audio) return;
    lines.push(`var ${name}Foot = proj.importFile(new ImportOptions(new File(media + ${aeStr("/" + audio.mediaRel)})));`);
    lines.push(`var ${name}Lay = comp.layers.add(${name}Foot);`);
    lines.push(`${name}Lay.startTime = 0;`);
    lines.push(`${name}Lay.outPoint = ${round3(plan.totalSec)};`);
    lines.push(`${name}Lay.property("ADBE Audio Group").property("ADBE Audio Levels").setValue([${dB(audio.volume)}]);`);
    lines.push("");
  };
  bed("vo", plan.voiceover);
  bed("music", plan.music);
  lines.push(`app.project.save(new File(scriptDir + ${aeStr("/Assembly.aep")}));`);
  return lines.join("\n") + "\n";
}

// ---- buildManifest ---------------------------------------------------------

export function buildManifest(
  plan: AssemblyPlan,
  cfg: AssemblyConfig,
  opts: { title: string; builtAt: string; edlName: string; jsxName: string; renderName?: string }
): string {
  const rows = plan.events
    .map((ev) => {
      const flags = [
        ev.muted ? "muted" : "",
        ev.kind === "clip" && ev.offsetSec != null && ev.offsetSec > 0 ? `slip +${ev.offsetSec.toFixed(1)}s` : "",
        ev.kind === "clip" && ev.speed != null ? `speed ${ev.speed}x` : "",
        ev.kind === "clip" && ev.reversed ? "reversed" : "",
        ev.blendWith ? `dissolve ${ev.durationSec.toFixed(1)}s into ${ev.blendWith.number}` : "",
      ].filter(Boolean).join(", ");
      return `| ${ev.number} | ${ev.kind} | ${ev.mediaRel ?? "-"} | ${ev.durationSec.toFixed(1)}s | ${flags} |`;
    })
    .join("\n");
  const lines: string[] = [
    `# ${opts.title || "Assembly"} — Manifest`,
    "",
    `Built ${opts.builtAt} · ${cfg.width}×${cfg.height} @ ${cfg.fps} fps · runtime ${formatRuntime(plan.totalSec)}`,
    "",
    `## Timeline (${plan.events.length} shots)`,
    "",
    "| Shot | Kind | Media | Duration | Notes |",
    "|------|------|-------|----------|-------|",
    rows,
    "",
  ];
  if (plan.suspiciousStills.length) {
    lines.push(
      `> WARNING: shot(s) ${plan.suspiciousStills.join(", ")} had a video generation but no registered clip — they render as frozen stills. Reclaim them (Fetch/recheck) and reassemble before delivering.`,
      ""
    );
  }
  if (plan.voiceover) lines.push(`- Voiceover: ${plan.voiceover.mediaRel} (volume ${plan.voiceover.volume})`);
  if (plan.music) lines.push(`- Music: ${plan.music.mediaRel} (volume ${plan.music.volume})`);
  lines.push("");
  lines.push("## Blank slots (no frame/clip)");
  lines.push(...(plan.blanks.length ? plan.blanks.map((n) => `- ${n}`) : ["- none"]));
  lines.push("");
  lines.push("## Artifacts");
  lines.push(`- ${opts.edlName}`);
  lines.push(`- ${opts.jsxName}`);
  lines.push(`- ${opts.renderName ?? "render.mp4 (after Render MP4)"}`);
  return lines.join("\n") + "\n";
}

// ---- ffmpeg argv builders --------------------------------------------------

/** Whole frames a timeline event occupies at `fps` — the render timeline
 *  is frame-based, so every segment is quantized to an exact frame count
 *  and its audio to the exact matching sample count. Without this, a
 *  1.3s shot at 24fps rendered 31 frames of video (1.2917s) beside
 *  1.300s of audio, and the mismatch compounded at every concat joint
 *  until clip audio audibly drifted away from the picture. */
export function segmentFrames(durationSec: number, fps: number): number {
  return Math.max(1, Math.round(Math.max(0.1, durationSec) * Math.max(1, Math.round(fps))));
}

/** Exact on-timeline duration of a frame-quantized segment, in seconds. */
export function segmentSec(durationSec: number, fps: number): number {
  return segmentFrames(durationSec, fps) / Math.max(1, Math.round(fps));
}

/** Pass A: normalize one timeline event into a uniform h264/PCM segment of
 *  exactly `segmentFrames(durationSec, fps)` frames at the target
 *  resolution/fps, with sample-exact 48kHz audio of the same length.
 *  Every segment gets both a video and an audio stream (silence for
 *  stills, blank slots, muted clips, and clips without embedded audio)
 *  so Pass B can concat with `-c copy`. Segment audio is uncompressed
 *  PCM on purpose: AAC carries per-file priming/padding samples that
 *  stream-copy concat turns into real inserted silence at every joint —
 *  the other half of the cumulative drift. AAC is encoded exactly once,
 *  in Pass C. Blank slots are generated from a black lavfi `color`. */
/**
 * The setpts filter for a speed ramp: a piecewise expression mapping each
 * input frame's relative source time X=((PTS-STARTPTS)*TB) to its output
 * time by inverting the same closed-form integral the model uses
 * (segment i: t = Tᵢ + (−a + √(a² + 2k·(X−Sᵢ)))/k). The fps resample +
 * frame cap downstream make the segment frame-exact.
 */
export function rampSetptsPart(curve: readonly SpeedKeyframe[], durSec: number): string {
  const X = "((PTS-STARTPTS)*TB)";
  const f6 = (v: number): string => v.toFixed(6);
  const bounds = [0, ...curve.map((k) => k.atSec).filter((t) => t > 0 && t < durSec), durSec]
    .filter((v, i, a) => i === 0 || v > a[i - 1]);
  const segExpr = (t0: number, t1: number): string => {
    const a = speedCurveSpeedAt(curve, t0);
    const b = speedCurveSpeedAt(curve, t1);
    const s0 = speedCurveIntegral(curve, t0);
    const k = t1 > t0 ? (b - a) / (t1 - t0) : 0;
    if (Math.abs(k) < 1e-9) return `(${f6(t0)}+(${X}-${f6(s0)})/${f6(a)})`;
    const k2 = 2 * k;
    const term = k2 >= 0 ? `+${f6(k2)}` : `-${f6(-k2)}`;
    return `(${f6(t0)}+(-${f6(a)}+sqrt(${f6(a * a)}${term}*(${X}-${f6(s0)})))/${f6(k)})`;
  };
  let expr = segExpr(bounds[bounds.length - 2] ?? 0, bounds[bounds.length - 1] ?? durSec);
  for (let i = bounds.length - 3; i >= 0; i--) {
    const sNext = speedCurveIntegral(curve, bounds[i + 1]);
    expr = `if(lt(${X},${f6(sNext)}),${segExpr(bounds[i], bounds[i + 1])},${expr})`;
  }
  return `setpts='STARTPTS+(${expr})/TB'`;
}

const fmtGainFactor = (f: number): string => String(parseFloat(f.toFixed(4)));

/** Audio retime chain (Item 7 semantics, shared by segments and the
 *  generalized mix): preserve-pitch via atempo by default; natural
 *  pitch (opt-in) via asetrate reinterpretation. */
export function tempoFilters(speed: number, pitchMode?: "preserve" | "natural"): string[] {
  if (!(speed > 0) || speed === 1) return [];
  if (pitchMode === "natural") {
    return ["aresample=48000", `asetrate=${Math.max(1, Math.round(48000 * speed))}`, "aresample=48000"];
  }
  const out: string[] = [];
  let f = speed;
  while (f > 2) { out.push("atempo=2"); f /= 2; }
  while (f < 0.5) { out.push("atempo=0.5"); f /= 0.5; }
  out.push(`atempo=${fmtGainFactor(f)}`);
  return out;
}

/** Gain + fade filters (Item 7): constant volume, or an eval=frame
 *  expression following the same linear clipGainAt curve the preview
 *  plays, in clip-local time (segDurSec bounds the local window). */
export function gainFilters(
  g: { volume?: number; fadeInSec?: number; fadeOutSec?: number; gainOffsetSec?: number; clipDurSec?: number },
  segDurSec: number
): string[] {
  const gainVol = g.volume != null && Number.isFinite(g.volume) ? Math.max(0, Math.min(1, g.volume)) : 1;
  const fIn = g.fadeInSec != null && g.fadeInSec > 0 ? g.fadeInSec : 0;
  const fOut = g.fadeOutSec != null && g.fadeOutSec > 0 ? g.fadeOutSec : 0;
  if (fIn > 0 || fOut > 0) {
    const off = g.gainOffsetSec != null && Number.isFinite(g.gainOffsetSec) ? g.gainOffsetSec : 0;
    const clipDur = g.clipDurSec != null && g.clipDurSec > 0 ? g.clipDurSec : Math.max(0, off) + segDurSec;
    const lt = off > 0 ? `(t+${fmtGainFactor(off)})` : off < 0 ? `(t-${fmtGainFactor(-off)})` : "t";
    const factors: string[] = [];
    if (gainVol !== 1) factors.push(fmtGainFactor(gainVol));
    if (fIn > 0) factors.push(`min(1,max(0,${lt}/${fmtGainFactor(fIn)}))`);
    if (fOut > 0) factors.push(`min(1,max(0,(${fmtGainFactor(clipDur)}-${lt})/${fmtGainFactor(fOut)}))`);
    return [`volume='${factors.length ? factors.join("*") : "1"}':eval=frame`];
  }
  return gainVol !== 1 ? [`volume=${fmtGainFactor(gainVol)}`] : [];
}

export function buildNormalizeArgs(
  ev: { kind: "still" | "clip" | "blank"; durationSec: number; muted: boolean; probedSec?: number; hasAudio?: boolean; offsetSec?: number; speed?: number; reversed?: boolean; speedCurve?: SpeedKeyframe[]; speedInterp?: "blend" | "flow"; volume?: number; fadeInSec?: number; fadeOutSec?: number; gainOffsetSec?: number; clipDurSec?: number; pitchMode?: "preserve" | "natural" },
  cfg: AssemblyConfig,
  srcAbs: string,
  outAbs: string
): string[] {
  const { fps, width, height } = cfg;
  const frames = segmentFrames(ev.durationSec, fps);
  const dur = frames / fps;
  const samples = Math.round((frames * 48000) / fps);
  // Slip offset into a clip's source (Step 4 right-drag): seek before decode
  // so the window opens on the slipped frame. Anything else stays identical.
  const offset = ev.kind === "clip" && ev.offsetSec != null && Number.isFinite(ev.offsetSec) && ev.offsetSec > 0
    ? ev.offsetSec
    : 0;
  // Constant speed + reverse (Item 4): the event's durationSec is timeline
  // time; the source window is duration×speed. setpts retimes the decoded
  // frames onto the segment's frame count; reverse plays the bounded
  // source window backwards. Unsped events keep byte-identical args.
  const speed = ev.kind === "clip" && ev.speed != null && Number.isFinite(ev.speed) && ev.speed > 0 ? ev.speed : 1;
  const curve = ev.kind === "clip" && ev.speedCurve?.length ? ev.speedCurve : undefined;
  // Audio follows a ramp at its average tempo (exact segment length via
  // atrim; the contour is the stated approximation — pitch preserved).
  const avgSpeed = curve && dur > 0 ? speedCurveIntegral(curve, dur) / dur : speed;
  const reversed = ev.kind === "clip" && !!ev.reversed;
  const fmtFactor = (f: number): string => String(parseFloat(f.toFixed(4)));
  let video: string;
  if (ev.kind === "blank") {
    video = `fps=${fps},format=yuv420p`;
  } else {
    const parts = [`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`];
    if (reversed) parts.push("reverse");
    if (curve) parts.push(rampSetptsPart(curve, dur));
    else if (speed !== 1) parts.push(`setpts=PTS/${fmtFactor(speed)}`);
    if (ev.speedInterp && (curve || speed !== 1 || reversed)) {
      parts.push(`minterpolate=fps=${fps}:mi_mode=${ev.speedInterp === "flow" ? "mci" : "blend"}`);
    } else {
      parts.push(`fps=${fps}`);
    }
    parts.push("format=yuv420p");
    video = parts.join(",");
    const remaining = ev.kind === "clip" && ev.probedSec != null ? (ev.probedSec - offset) / speed : dur;
    const padSec = remaining < dur ? dur - Math.max(0, remaining) : 0;
    if (padSec > 0) video = `${video},tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}`;
  }
  const silent = ev.kind !== "clip" || ev.muted || ev.hasAudio === false;
  const args: string[] = ["-y"];
  if (ev.kind === "blank") {
    args.push("-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${fps}`);
  } else if (ev.kind === "still") {
    args.push("-loop", "1", "-framerate", String(fps), "-i", srcAbs);
  } else {
    if (offset > 0) args.push("-ss", offset.toFixed(3));
    // Reverse buffers its whole input: bound decoding to the source window.
    if (reversed) args.push("-t", (dur * speed).toFixed(3));
    args.push("-i", srcAbs);
  }
  // Sample-exact segment audio: resample, pad with silence when short,
  // then hard-trim to the exact sample count the frame count implies —
  // so audio and video leave Pass A with identical durations.
  const audioPre: string[] = [];
  // NOT on silent segments: their input is the infinite anullsrc and
  // areverse buffers to EOF — a muted reversed clip would hang the
  // render forever (torture-fixture find, A14). Silence reversed is
  // still silence.
  if (reversed && !silent) audioPre.push("areverse");
  audioPre.push(...tempoFilters(avgSpeed, ev.pitchMode));
  // Gain + fades (Item 7), applied post-retime so times are timeline
  // seconds — the same clipGainAt curve the preview plays. Absent
  // fields emit nothing, keeping unsped/ungained args byte-identical.
  audioPre.push(...gainFilters(ev, dur));
  const audioFilter = [...audioPre, "aresample=48000", "apad", `atrim=end_sample=${samples}`].join(",");
  if (silent) {
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v", "-map", "1:a", "-af", audioFilter);
  } else {
    args.push("-map", "0:v", "-map", "0:a", "-af", audioFilter);
  }
  args.push(
    "-t", dur.toFixed(6),
    "-vf", video,
    "-frames:v", String(frames),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
    outAbs
  );
  return args;
}

/** The concat list file consumed by the concat demuxer (Pass B). */
export function buildConcatList(segmentAbsPaths: string[]): string {
  return segmentAbsPaths.map((s) => `file '${s.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

/** Pass B: stream-copy the normalized segments into one file (uniform
 *  codecs; frame/sample-exact segment lengths keep the joints seamless). */
/** Blend two uniform Pass-A segments (each exactly the blend window
 *  long) into one dissolved segment of the same length (Item 8):
 *  xfade across the whole window, acrossfade for audio, same segment
 *  codecs so Pass B concat stays a stream copy. */
export function buildXfadeArgs(aAbs: string, bAbs: string, durSec: number, fps: number, outAbs: string): string[] {
  const frames = segmentFrames(durSec, fps);
  const dur = frames / fps;
  const d = String(parseFloat(dur.toFixed(4)));
  return [
    "-y", "-i", aAbs, "-i", bAbs,
    "-filter_complex", `[0:v][1:v]xfade=transition=fade:duration=${d}:offset=0[v];[0:a][1:a]acrossfade=d=${d}:c1=tri:c2=tri[a]`,
    "-map", "[v]", "-map", "[a]",
    "-frames:v", String(frames),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
    outAbs,
  ];
}

export function buildConcatArgs(concatListAbs: string, outAbs: string): string[] {
  return ["-y", "-f", "concat", "-safe", "0", "-i", concatListAbs, "-c", "copy", outAbs];
}

/** Pass C generalized (Item 9): mix EVERY audible timeline audio
 *  clip over the concat result — each input-seeked to its source
 *  window, retimed (pitch per clip), gained/faded with the shared
 *  Item 7 filters, delayed to its timeline start, then amix'd with
 *  the base. Zero events = the plain single AAC encode. */
export function buildTimelineMixArgs(opts: {
  renderAbs: string;
  audio: (AssemblyAudioEvent & { abs: string })[];
  totalSec: number;
  outAbs: string;
}): string[] {
  const { renderAbs, audio, totalSec, outAbs } = opts;
  const inputs: string[] = ["-y", "-i", renderAbs];
  if (!audio.length) {
    return [...inputs, "-map", "0:v", "-map", "0:a", "-t", totalSec.toFixed(3), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outAbs];
  }
  const chains: string[] = [];
  audio.forEach((ev, i) => {
    const speed = ev.speed != null && ev.speed > 0 ? ev.speed : 1;
    const srcDur = ev.durationSec * speed;
    const off = ev.offsetSec != null && ev.offsetSec > 0 ? ev.offsetSec : 0;
    if (off > 0) inputs.push("-ss", off.toFixed(3));
    inputs.push("-t", srcDur.toFixed(3), "-i", ev.abs);
    const parts: string[] = [`[${i + 1}:a]`];
    const filters: string[] = [];
    if (ev.reversed) filters.push("areverse");
    filters.push(...tempoFilters(speed, ev.pitchMode));
    filters.push(...gainFilters(ev, ev.durationSec));
    filters.push("aresample=48000");
    const delayMs = Math.max(0, Math.round(ev.startSec * 1000));
    if (delayMs > 0) filters.push(`adelay=${delayMs}|${delayMs}`);
    filters.push("apad");
    parts.push(filters.join(","));
    chains.push(`${parts.join("")}[a${i}]`);
  });
  const labels = audio.map((_, i) => `[a${i}]`).join("");
  const filter = `${chains.join(";")};[0:a]${labels}amix=inputs=${audio.length + 1}:normalize=0,alimiter=limit=0.95[outa]`;
  return [...inputs, "-filter_complex", filter, "-map", "0:v", "-map", "[outa]", "-t", totalSec.toFixed(3), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outAbs];
}

/** The unified plan every shipping path reads (Item 9): the stored
 *  timeline when present; otherwise a timeline seeded in-memory from
 *  the shot projection — proven plan-identical to the legacy plan
 *  (A1), so single-track projects render through the same path. */
export function assemblyPlanForProduction(p: Production): AssemblyPlan {
  if (p.timeline) return assemblyPlanFromTimeline(p);
  let n = 0;
  const timeline = seedTimelineFromProduction(p, (prefix) => `${prefix}-seed-${++n}`);
  return assemblyPlanFromTimeline({ ...p, timeline });
}

/** Pass C: mix the VO + music beds over the concat result (clip audio already
 *  baked into the base track) and encode the final AAC track (the premix
 *  carries PCM). `totalSec` is the frame-quantized timeline total. */
export function buildMixArgs(opts: {
  renderAbs: string;
  voiceover?: { abs: string; volume: number; fadeInSec?: number; fadeOutSec?: number; durationSec?: number };
  music?: { abs: string; volume: number; fadeInSec?: number; fadeOutSec?: number; durationSec?: number };
  totalSec: number;
  outAbs: string;
}): string[] {
  const { renderAbs, voiceover, music, totalSec, outAbs } = opts;
  const inputs = ["-y", "-i", renderAbs];
  let beds = 0;
  if (voiceover) {
    inputs.push("-i", voiceover.abs);
    beds++;
  }
  if (music) {
    inputs.push("-i", music.abs);
    beds++;
  }
  if (beds === 0) {
    // The premix carries PCM segment audio — this is the one AAC encode.
    return [...inputs, "-map", "0:v", "-map", "0:a", "-t", totalSec.toFixed(3), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outAbs];
  }
  const v = (x: number) => x.toFixed(2);
  const trimNum = (x: number) => String(parseFloat(x.toFixed(4)));
  // Bed chain: gain, then fades when the (timeline) plan carries them —
  // fade-out anchors to the bed clip's own duration, not the total.
  const bedChain = (inputIdx: number, bed: { volume: number; fadeInSec?: number; fadeOutSec?: number; durationSec?: number }, label: string): string => {
    const parts = [`[${inputIdx}:a]aresample=48000`, `volume=${v(bed.volume)}`];
    if (bed.fadeInSec != null && bed.fadeInSec > 0) parts.push(`afade=t=in:st=0:d=${trimNum(bed.fadeInSec)}`);
    if (bed.fadeOutSec != null && bed.fadeOutSec > 0) {
      const end = bed.durationSec != null && bed.durationSec > 0 ? bed.durationSec : totalSec;
      parts.push(`afade=t=out:st=${trimNum(Math.max(0, end - bed.fadeOutSec))}:d=${trimNum(bed.fadeOutSec)}`);
    }
    return `${parts.join(",")}[${label}]`;
  };
  let filter: string;
  if (voiceover && music) {
    filter = `${bedChain(1, voiceover, "vo")};${bedChain(2, music, "mu")};[0:a][vo][mu]amix=inputs=3:normalize=0,alimiter=limit=0.95[outa]`;
  } else if (voiceover) {
    filter = `${bedChain(1, voiceover, "vo")};[0:a][vo]amix=inputs=2:normalize=0,alimiter=limit=0.95[outa]`;
  } else {
    filter = `${bedChain(1, music!, "mu")};[0:a][mu]amix=inputs=2:normalize=0,alimiter=limit=0.95[outa]`;
  }
  return [...inputs, "-filter_complex", filter, "-map", "0:v", "-map", "[outa]", "-t", totalSec.toFixed(3), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outAbs];
}

// ---- assemble --------------------------------------------------------------

export interface AssembleResult {
  plan: AssemblyPlan;
  exportAbs: string;
  edlRel: string;
  scriptRel: string;
  manifestRel: string;
  fcpxmlRel: string;
  fcpxmlReportRel: string;
  premiereRel: string;
  premiereReportRel: string;
  edlTrackRels: string[];
  edlReportRel: string;
  copied: number;
  bytes: number;
}

export interface AssembleDeps {
  ffmpegBin?: string | null;
  probe?: ProbeFn;
}

/** Gather media + write the EDL / AEScript / manifest into the export folder.
 *  Mutates `p.assembly` bookkeeping (does not save). */
export async function assemble(
  p: Production,
  cfgInput: Partial<Pick<ProductionAssembly, "fps" | "width" | "height">> | undefined,
  emit: AssemblyEmit,
  deps: AssembleDeps = {}
): Promise<AssembleResult> {
  const cfg = assemblyConfig(p, cfgInput);
  const plan = assemblyPlanForProduction(p);
  const asm = p.assembly ?? { fps: 24, width: 1920, height: 1080, exportDir: `${p.assets.outDir}/${p.assets.assemblyDir}` };
  const exportAbs = assetPath(p, asm.exportDir);
  const mediaAbs = path.join(exportAbs, "media");
  fs.mkdirSync(path.join(mediaAbs, "shots"), { recursive: true });
  fs.mkdirSync(path.join(mediaAbs, "clips"), { recursive: true });
  fs.mkdirSync(path.join(mediaAbs, "audio"), { recursive: true });

  let copied = 0;
  let bytes = 0;
  for (const m of plan.media) {
    const srcAbs = assetPath(p, m.srcRel);
    const destAbs = path.join(mediaAbs, m.mediaRel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    if (!fs.existsSync(srcAbs)) {
      emit(`Missing source, skipped: ${m.srcRel}`, "error");
      continue;
    }
    if (!fs.existsSync(destAbs) || fs.statSync(srcAbs).size !== fs.statSync(destAbs).size) {
      fs.copyFileSync(srcAbs, destAbs);
      copied++;
      bytes += fs.statSync(destAbs).size;
    } else {
      bytes += fs.statSync(destAbs).size;
    }
  }

  // Probe clip lengths for accurate EDL source-out and render padding.
  if (deps.probe && deps.ffmpegBin) {
    for (const ev of plan.events) {
      if (ev.kind === "clip") {
        const r = await deps.probe(deps.ffmpegBin, path.join(mediaAbs, ev.mediaRel!));
        ev.probedSec = r.durationSec ?? undefined;
        ev.hasAudio = r.hasAudio;
      }
    }
    if (plan.voiceover) plan.voiceover.probedSec = (await deps.probe(deps.ffmpegBin, path.join(mediaAbs, plan.voiceover.mediaRel))).durationSec ?? undefined;
    if (plan.music) plan.music.probedSec = (await deps.probe(deps.ffmpegBin, path.join(mediaAbs, plan.music.mediaRel))).durationSec ?? undefined;
  }

  const edlRel = `${asm.exportDir}/Assembly.edl`;
  const scriptRel = `${asm.exportDir}/Assembly.jsx`;
  const manifestRel = `${asm.exportDir}/MANIFEST.md`;
  fs.writeFileSync(assetPath(p, edlRel), buildEdl(plan, cfg.fps, p.meta.name), "utf8");
  fs.writeFileSync(assetPath(p, scriptRel), buildAeScript(plan, cfg, exportAbs), "utf8");
  const fcpxmlRel = `${asm.exportDir}/Assembly.fcpxml`;
  const fcpxmlReportRel = `${asm.exportDir}/Assembly-fcpxml-report.md`;
  const fcp = buildFcpxml(p, cfg);
  fs.writeFileSync(assetPath(p, fcpxmlRel), fcp.xml, "utf8");
  fs.writeFileSync(
    assetPath(p, fcpxmlReportRel),
    `# FCPXML export report — ${p.meta.name}\n\n${fcp.report.length ? fcp.report.map((l) => `- ${l}`).join("\n") : "- No degradations."}\n`,
    "utf8"
  );
  for (const line of fcp.report) emit(`FCPXML: ${line}`, "info");
  const premiereRel = `${asm.exportDir}/Assembly-premiere.xml`;
  const premiereReportRel = `${asm.exportDir}/Assembly-premiere-report.md`;
  const prem = buildPremiereXml(p, cfg);
  fs.writeFileSync(assetPath(p, premiereRel), prem.xml, "utf8");
  fs.writeFileSync(
    assetPath(p, premiereReportRel),
    `# Premiere XML (xmeml) export report — ${p.meta.name}\n\n${prem.report.length ? prem.report.map((l) => `- ${l}`).join("\n") : "- No degradations."}\n`,
    "utf8"
  );
  for (const line of prem.report) emit(`Premiere XML: ${line}`, "info");
  const trackEdls = buildTrackEdls(p, cfg.fps);
  const edlTrackRels = trackEdls.files.map((f) => `${asm.exportDir}/${f.name}`);
  trackEdls.files.forEach((f, i) => fs.writeFileSync(assetPath(p, edlTrackRels[i]), f.content, "utf8"));
  const edlReportRel = `${asm.exportDir}/Assembly-edl-report.md`;
  fs.writeFileSync(
    assetPath(p, edlReportRel),
    `# EDL export report — ${p.meta.name}\n\n${trackEdls.report.map((l) => `- ${l}`).join("\n")}\n`,
    "utf8"
  );
  for (const line of trackEdls.report) emit(`EDL: ${line}`, "info");
  fs.writeFileSync(
    assetPath(p, manifestRel),
    buildManifest(plan, cfg, {
      title: p.meta.name,
      builtAt: new Date().toISOString(),
      edlName: "Assembly.edl",
      jsxName: "Assembly.jsx",
      renderName: asm.renderPath ? "render.mp4" : undefined,
    }),
    "utf8"
  );

  p.assembly = {
    fps: cfg.fps,
    width: cfg.width,
    height: cfg.height,
    exportDir: asm.exportDir,
    assembledAt: new Date().toISOString(),
    renderPath: asm.renderPath,
    renderedAt: asm.renderedAt,
    totalSec: plan.totalSec,
    skippedShots: plan.blanks.length ? plan.blanks : undefined,
  };

  emit(
    `Assembly package built: ${plan.events.length} shots, ${plan.media.length} media files, runtime ${formatRuntime(plan.totalSec)}.`,
    "done"
  );
  if (plan.blanks.length) emit(`Blank slot(s) with no frame/clip: ${plan.blanks.join(", ")}.`, "info");
  if (plan.suspiciousStills.length) {
    emit(
      `WARNING: shot(s) ${plan.suspiciousStills.join(", ")} have a video generation but no registered clip — they will render as frozen stills. Reclaim the clip (Fetch) before delivering.`,
      "error"
    );
  }

  return { plan, exportAbs, edlRel, scriptRel, manifestRel, fcpxmlRel, fcpxmlReportRel, premiereRel, premiereReportRel, edlTrackRels, edlReportRel, copied, bytes };
}

// ---- renderAnimatic --------------------------------------------------------

export interface RenderDeps {
  bin: string;
  runFfmpeg: (bin: string, argv: string[], emit: AssemblyEmit, opts?: { isCancelled?: () => boolean }) => Promise<void>;
  probe?: ProbeFn;
  tempDir?: string;
  /** Cooperative cancellation (Item 9): polled between passes and
   *  forwarded into runFfmpeg, which kills the child mid-flight. */
  isCancelled?: () => boolean;
  /** Overall render progress 0-100 (ledger reporting). */
  onProgress?: (percent: number) => void;
}

/** The one render pipeline (Item 9): normalize → concat → mix over a
 *  unified timeline plan. The mix lands in a temp file renamed into
 *  place only on success, so a cancelled/failed render never leaves
 *  a partial render.mp4 presented as finished. */
async function renderPlan(
  p: Production,
  plan: AssemblyPlan,
  cfgInput: Partial<Pick<ProductionAssembly, "fps" | "width" | "height">> | undefined,
  emit: AssemblyEmit,
  deps: RenderDeps
): Promise<string> {
  const cfg = assemblyConfig(p, cfgInput);
  const asm = p.assembly ?? { fps: 24, width: 1920, height: 1080, exportDir: `${p.assets.outDir}/${p.assets.assemblyDir}` };
  const exportAbs = assetPath(p, asm.exportDir);
  const segDir = deps.tempDir ?? path.join(exportAbs, "_render");
  fs.mkdirSync(exportAbs, { recursive: true });
  fs.mkdirSync(segDir, { recursive: true });
  const cancelled = (): boolean => deps.isCancelled?.() ?? false;
  const run = async (argv: string[]): Promise<void> => {
    if (cancelled()) throw new Error("Render cancelled.");
    try {
      await deps.runFfmpeg(deps.bin, argv, emit, { isCancelled: deps.isCancelled });
    } catch (e) {
      if (cancelled()) throw new Error("Render cancelled.");
      throw e;
    }
  };
  try {
    if (deps.probe) {
      for (const ev of plan.events) {
        if (cancelled()) throw new Error("Render cancelled.");
        if (ev.kind === "clip") {
          const r = await deps.probe(deps.bin, assetPath(p, ev.srcRel!));
          ev.probedSec = r.durationSec ?? undefined;
          ev.hasAudio = r.hasAudio;
          if (ev.blendWith?.kind === "clip") {
            const rb = await deps.probe(deps.bin, assetPath(p, ev.blendWith.srcRel!));
            ev.blendWith.probedSec = rb.durationSec ?? undefined;
            ev.blendWith.hasAudio = rb.hasAudio;
          }
        }
      }
    }
    const segments: string[] = [];
    // The rendered timeline is frame-quantized segment by segment; its
    // exact total (not the plan's fractional sum) bounds the final mix
    // so audio and video end together.
    const renderTotalSec = plan.events.reduce((sum, ev) => sum + segmentSec(ev.durationSec, cfg.fps), 0);
    for (let i = 0; i < plan.events.length; i++) {
      const ev = plan.events[i];
      const outAbs = path.join(segDir, String(i + 1).padStart(4, "0") + ".mov");
      if (ev.blendWith) {
        const aAbs = path.join(segDir, String(i + 1).padStart(4, "0") + "-a.mov");
        const bAbs = path.join(segDir, String(i + 1).padStart(4, "0") + "-b.mov");
        await run(buildNormalizeArgs(ev, cfg, ev.srcRel ? assetPath(p, ev.srcRel) : "", aAbs));
        await run(buildNormalizeArgs(ev.blendWith, cfg, ev.blendWith.srcRel ? assetPath(p, ev.blendWith.srcRel) : "", bAbs));
        await run(buildXfadeArgs(aAbs, bAbs, ev.durationSec, cfg.fps, outAbs));
      } else {
        await run(buildNormalizeArgs(ev, cfg, ev.srcRel ? assetPath(p, ev.srcRel) : "", outAbs));
      }
      segments.push(outAbs);
      emit(`Rendered shot ${ev.number} (${i + 1}/${plan.events.length}).`);
      deps.onProgress?.(Math.round(((i + 1) / Math.max(1, plan.events.length)) * 90));
    }
    const concatList = path.join(segDir, "concat.txt");
    fs.writeFileSync(concatList, buildConcatList(segments), "utf8");
    const preMix = path.join(segDir, "premix.mov");
    await run(buildConcatArgs(concatList, preMix));
    deps.onProgress?.(95);
    const tmpAbs = path.join(segDir, "render.tmp.mp4");
    if (plan.audioEvents) {
      await run(buildTimelineMixArgs({
        renderAbs: preMix,
        audio: plan.audioEvents.map((a) => ({ ...a, abs: assetPath(p, a.srcRel) })),
        totalSec: renderTotalSec,
        outAbs: tmpAbs,
      }));
    } else {
      await run(buildMixArgs({
        renderAbs: preMix,
        voiceover: plan.voiceover ? { abs: assetPath(p, plan.voiceover.srcRel), volume: plan.voiceover.volume, fadeInSec: plan.voiceover.fadeInSec, fadeOutSec: plan.voiceover.fadeOutSec, durationSec: plan.voiceover.durationSec } : undefined,
        music: plan.music ? { abs: assetPath(p, plan.music.srcRel), volume: plan.music.volume, fadeInSec: plan.music.fadeInSec, fadeOutSec: plan.music.fadeOutSec, durationSec: plan.music.durationSec } : undefined,
        totalSec: renderTotalSec,
        outAbs: tmpAbs,
      }));
    }
    if (cancelled()) throw new Error("Render cancelled.");
    const renderAbs = path.join(exportAbs, "render.mp4");
    fs.renameSync(tmpAbs, renderAbs);
    deps.onProgress?.(100);
    emit(`Render complete: ${plan.events.length} shots, ${formatRuntime(plan.totalSec)}.`, "done");
    return `${asm.exportDir}/render.mp4`;
  } finally {
    try {
      fs.rmSync(segDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Render to render.mp4 in the export folder. Since Item 9 every
 *  production renders through the unified timeline plan (seeded
 *  in-memory for legacy productions — plan-identical, per A1). */
export async function renderAnimatic(
  p: Production,
  cfgInput: Partial<Pick<ProductionAssembly, "fps" | "width" | "height">> | undefined,
  emit: AssemblyEmit,
  deps: RenderDeps
): Promise<string> {
  const plan = assemblyPlanForProduction(p);
  if (!plan.events.length) throw new Error("Nothing to render — no shots have a frame or clip yet.");
  return renderPlan(p, plan, cfgInput, emit, deps);
}

/** Render the multi-track timeline — the same unified pipeline
 *  (kept as the timeline-named entry the E2E suites drive). */
export async function renderTimelineAnimatic(
  p: Production,
  cfgInput: Partial<Pick<ProductionAssembly, "fps" | "width" | "height">> | undefined,
  emit: AssemblyEmit,
  deps: RenderDeps
): Promise<string> {
  const plan = assemblyPlanForProduction(p);
  if (!plan.events.length) throw new Error("Nothing to render — the timeline has no clips yet.");
  return renderPlan(p, plan, cfgInput, emit, deps);
}
// ---- send any asset to the assembly folder ---------------------------------

/** Copy one workspace file straight into `<exportDir>/media/sent/`. Returns the
 *  destination path relative to the production root. */
export function sendAssetToAssembly(p: Production, rel: string): string {
  const srcAbs = assetPath(p, rel);
  if (!fs.existsSync(srcAbs)) throw new Error(`File not found: ${rel}`);
  const exportDir = p.assembly?.exportDir ?? `${p.assets.outDir}/${p.assets.assemblyDir}`;
  const destRel = `${exportDir}/media/sent/${path.basename(rel)}`;
  const destAbs = assetPath(p, destRel);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
  return destRel;
}
