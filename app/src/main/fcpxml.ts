/**
 * FCPXML export (Animatic Editor Expansion, Item 10) — Final Cut Pro
 * and DaVinci Resolve. Reads the timeline MODEL directly (exporters
 * never read the flattened render plan): the bottom video track is
 * the primary storyline, other video tracks become positive lanes,
 * audio tracks negative lanes. Constant speeds and ramps become
 * <timeMap> point sets sampled from the same timing math the render
 * uses (final point exact); dissolves ride the spine as transitions.
 *
 * Everything the format can't carry is listed in the returned report
 * (Phase 4 rule: silent loss is a bug) — assemble() saves it next to
 * the .fcpxml and logs it. Version 1.10, the dialect current FCP and
 * Resolve both import.
 */
import {
  clipDurationSec,
  clipGainAt,
  clipSourceTimeAtLoose,
  clipSpeed,
  clipVolume,
  resolveTimeline,
  seedTimelineFromProduction,
  trackVolume,
  type Production,
  type ProductionTimeline,
  type TimelineClip,
  type TimelineTrack,
} from "../shared/ipc.js";
import { mediaPathForId } from "../shared/media-registry.js";
import { assetPath } from "./pipeline.js";

export const xmlEsc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rational FCPXML time at the project frame rate ("100/2400s" style). */
function rat(sec: number, fps: number): string {
  const frames = Math.round(sec * fps);
  if (frames === 0) return "0s";
  return `${frames * 100}/${fps * 100}s`;
}

export function mediaFileUrl(absPath: string): string {
  const slashed = absPath.replace(/\\/g, "/");
  return `file://${slashed.startsWith("/") ? "" : "/"}${encodeURI(slashed).replace(/#/g, "%23")}`;
}

export const volumeDb = (v: number): string => (v <= 0 ? "-96dB" : `${(20 * Math.log10(v)).toFixed(1)}dB`);
const dbOf = volumeDb;
const esc = xmlEsc;
const fileUrl = mediaFileUrl;

export function buildFcpxml(
  p: Production,
  cfg: { fps: number; width: number; height: number }
): { xml: string; report: string[] } {
  const fps = Math.max(1, Math.round(cfg.fps));
  const report: string[] = [];
  let timeline: ProductionTimeline;
  if (p.timeline) {
    timeline = p.timeline;
  } else {
    let n = 0;
    timeline = seedTimelineFromProduction(p, (prefix) => `${prefix}-seed-${++n}`);
    report.push("Production had no stored timeline; exported the seeded shot-projection timeline.");
  }
  const resolved = resolveTimeline(timeline);
  const totalSec = resolved.totalSec;
  const clipSrc = (clip: TimelineClip): string | undefined =>
    mediaPathForId(p.media, clip.mediaId) ?? clip.srcRel;

  // ---- resources -------------------------------------------------------------
  const assetIdByRel = new Map<string, string>();
  const assetLines: string[] = [];
  let assetN = 1;
  const assetFor = (clip: TimelineClip): string | undefined => {
    const rel = clipSrc(clip);
    if (!rel || clip.sourceKind === "blank") return undefined;
    const existing = assetIdByRel.get(rel);
    if (existing) return existing;
    const id = `r${++assetN}`;
    assetIdByRel.set(rel, id);
    // Referenced extent (incl. dissolve handles), not a probe: importers
    // re-probe the file; the report says so.
    const dur = clip.sourceKind === "audio" || clip.sourceKind === "video"
      ? clipSourceTimeAtLoose(clip, clipDurationSec(clip)) + 2
      : 0;
    const hasVideo = clip.sourceKind !== "audio" ? ` hasVideo="1"` : "";
    const hasAudio = clip.sourceKind !== "still" ? ` hasAudio="1"` : "";
    assetLines.push(
      `<asset id="${id}" name="${esc(rel.split("/").pop() ?? rel)}" uid="${esc(clip.mediaId ?? rel)}" src="${esc(fileUrl(assetPath(p, rel)))}" start="0s" duration="${rat(Math.max(0.1, dur), fps)}"${hasVideo}${hasAudio} format="r1"/>`
    );
    return id;
  };
  for (const clip of timeline.clips) assetFor(clip);
  report.push("Asset durations are referenced extents (unprobed); the importing editor re-reads the media files.");

  // ---- lane assignment ---------------------------------------------------------
  const videoTracks = timeline.tracks.filter((t) => t.kind === "video");
  const audioTracks = timeline.tracks.filter((t) => t.kind === "audio");
  const spineTrack: TimelineTrack | undefined = videoTracks[videoTracks.length - 1];
  const laneOf = (track: TimelineTrack): number => {
    if (track.kind === "audio") return -(audioTracks.indexOf(track) + 1);
    return videoTracks.length - 1 - videoTracks.indexOf(track);
  };

  let rampNoteAdded = false;
  const timeMapFor = (clip: TimelineClip): string => {
    const dur = clipDurationSec(clip);
    if (!(dur > 0)) return "";
    const needs = clip.reversed || !!clip.speedCurve?.length || clipSpeed(clip) !== 1;
    if (!needs) return "";
    // Sample the exact loose mapping: endpoints, curve keyframes, and
    // segment midpoints (speed is piecewise-linear; time is its
    // integral — midpoints keep the sampled map close).
    const samples = new Set<number>([0, dur]);
    for (const k of clip.speedCurve ?? []) if (k.atSec > 0 && k.atSec < dur) samples.add(k.atSec);
    const sorted = [...samples].sort((a, b) => a - b);
    const withMid: number[] = [];
    sorted.forEach((t, i) => {
      withMid.push(t);
      if (i + 1 < sorted.length) withMid.push((t + sorted[i + 1]) / 2);
    });
    const inSec = clip.sourceInSec ?? 0;
    const pts = withMid.map((t) => {
      const src = clipSourceTimeAtLoose(clip, t);
      const rel = clip.reversed ? (clip.sourceOutSec ?? inSec) - src : src - inSec;
      return `<timept time="${rat(t, fps)}" value="${rat(rel, fps)}"/>`;
    });
    if (clip.speedCurve?.length && !rampNoteAdded) {
      rampNoteAdded = true;
      report.push("Speed ramps export as sampled timeMaps (keyframes + midpoints; end points exact).");
    }
    return `<timeMap>${pts.join("")}</timeMap>`;
  };

  const volumeFor = (clip: TimelineClip, track: TimelineTrack): string => {
    if (clip.sourceKind === "still" || clip.sourceKind === "blank") return "";
    const eff = clip.muted ? 0 : clipVolume(clip) * trackVolume(track);
    const hasFades = (clip.fadeInSec ?? 0) > 0 || (clip.fadeOutSec ?? 0) > 0;
    if (eff === 1 && !hasFades) return "";
    const fades =
      `${(clip.fadeInSec ?? 0) > 0 ? `<fadeIn type="linear" duration="${rat(clip.fadeInSec!, fps)}"/>` : ""}` +
      `${(clip.fadeOutSec ?? 0) > 0 ? `<fadeOut type="linear" duration="${rat(clip.fadeOutSec!, fps)}"/>` : ""}`;
    return `<adjust-volume amount="${dbOf(eff)}">${fades ? `<param name="amount">${fades}</param>` : ""}</adjust-volume>`;
  };

  const clipEl = (clip: TimelineClip, track: TimelineTrack, lane: number): string => {
    const ref = assetFor(clip);
    const name = esc(clip.name ?? clipSrc(clip)?.split("/").pop() ?? "Clip");
    const dur = clipDurationSec(clip);
    const enabled = (track.kind === "video" && track.hidden) || (track.kind === "audio" && track.muted) ? ` enabled="0"` : "";
    const start = clip.sourceKind === "video" || clip.sourceKind === "audio" ? ` start="${rat(clip.reversed ? clipSourceTimeAtLoose(clip, dur) : clip.sourceInSec ?? 0, fps)}"` : "";
    return (
      `<asset-clip ref="${ref}" name="${name}"${lane !== 0 ? ` lane="${lane}"` : ""}` +
      ` offset="${rat(clip.timelineStartSec + (lane === 0 ? 0 : 0), fps)}"${start} duration="${rat(dur, fps)}"${enabled}>` +
      `${timeMapFor(clip)}${volumeFor(clip, track)}</asset-clip>`
    );
  };

  // ---- spine + connected -------------------------------------------------------
  const spineClips = spineTrack
    ? timeline.clips.filter((c) => c.trackId === spineTrack.id).sort((a, b) => a.timelineStartSec - b.timelineStartSec)
    : [];
  const spineTransitionAfter = new Map<string, number>();
  for (const b of resolved.blendSpans) {
    if (spineTrack && b.track.id === spineTrack.id) spineTransitionAfter.set(b.outgoing.id, b.transition.durationSec);
  }
  for (const tr of timeline.transitions ?? []) {
    const out = timeline.clips.find((c) => c.id === tr.outgoingClipId);
    if (out && !spineTransitionAfter.has(out.id)) {
      report.push(`Dissolve after "${out.name ?? out.id}" is not on the primary storyline (or is covered) and was dropped (cut instead).`);
    }
  }

  // Spine items keep head/tail split so connected (lane) clips can
  // nest inside the spine item covering their start — FCPXML has no
  // free-floating lane clips at sequence level.
  interface SpineItem { start: number; end: number; head: string; tail: string; children: string[]; hostable: boolean }
  const spineItems: SpineItem[] = [];
  let cursor = 0;
  const gapItem = (from: number, to: number): SpineItem => ({
    start: from, end: to, head: `<gap name="Gap" duration="${rat(to - from, fps)}">`, tail: `</gap>`, children: [], hostable: true,
  });
  spineClips.forEach((clip, idx) => {
    if (clip.timelineStartSec > cursor + 1e-6) spineItems.push(gapItem(cursor, clip.timelineStartSec));
    if (clip.sourceKind === "blank") {
      spineItems.push(gapItem(clip.timelineStartSec, clip.timelineStartSec + clipDurationSec(clip)));
    } else {
      const el = clipEl(clip, spineTrack!, 0);
      const cut = el.lastIndexOf("</asset-clip>");
      spineItems.push({
        start: clip.timelineStartSec, end: clip.timelineStartSec + clipDurationSec(clip),
        head: el.slice(0, cut), tail: "</asset-clip>", children: [], hostable: true,
      });
    }
    cursor = clip.timelineStartSec + clipDurationSec(clip);
    const d = spineTransitionAfter.get(clip.id);
    if (d && idx + 1 < spineClips.length) {
      spineItems.push({ start: cursor, end: cursor, head: `<transition name="Cross Dissolve" duration="${rat(d, fps)}"/>`, tail: "", children: [], hostable: false });
    }
  });
  if (totalSec > cursor + 1e-6) spineItems.push(gapItem(cursor, totalSec));
  if (!spineItems.length) spineItems.push(gapItem(0, Math.max(0.1, totalSec)));

  for (const track of timeline.tracks) {
    if (spineTrack && track.id === spineTrack.id) continue;
    const lane = laneOf(track);
    for (const clip of timeline.clips.filter((c) => c.trackId === track.id)) {
      if (clip.sourceKind === "blank") {
        report.push(`Blank clip on lane track "${track.name}" skipped (lanes are transparent where empty).`);
        continue;
      }
      const host =
        spineItems.find((s) => s.hostable && clip.timelineStartSec >= s.start - 1e-9 && clip.timelineStartSec < s.end - 1e-9) ??
        [...spineItems].reverse().find((s) => s.hostable && s.start <= clip.timelineStartSec) ??
        spineItems.find((s) => s.hostable)!;
      host.children.push(clipEl(clip, track, lane));
    }
  }
  const spine = spineItems.map((s) => s.head + s.children.join("") + s.tail);

  // ---- report: remaining degradations -------------------------------------------
  const natural = timeline.clips.filter((c) => c.pitchMode === "natural");
  if (natural.length) {
    report.push(`${natural.length} clip(s) use natural pitch-shift retiming; FCPXML retiming preserves pitch, so pitch will differ from the Cascade render.`);
  }
  const linked = new Set(timeline.clips.map((c) => c.linkId).filter(Boolean));
  if (linked.size) report.push(`${linked.size} linked clip group(s) exported unlinked (FCPXML has no equivalent grouping).`);
  if (timeline.clips.some((c) => c.speedInterp)) {
    report.push("Retime frame interpolation (blend/flow) is a Cascade render setting and is not represented in FCPXML.");
  }
  if (videoTracks.length > 1 || audioTracks.length > 1) {
    report.push(`Tracks export as lanes: ${videoTracks.length} video (bottom = primary storyline), ${audioTracks.length} audio (negative lanes).`);
  }

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE fcpxml>`,
    `<fcpxml version="1.10">`,
    `<resources>`,
    `<format id="r1" name="FFVideoFormat${cfg.height}p${fps}" frameDuration="${rat(1 / fps, fps)}" width="${cfg.width}" height="${cfg.height}" colorSpace="1-1-1 (Rec. 709)"/>`,
    ...assetLines,
    `</resources>`,
    `<library><event name="${esc(p.meta.name)}"><project name="${esc(p.meta.name)}">`,
    `<sequence format="r1" duration="${rat(totalSec, fps)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    `<spine>${spine.join("")}</spine>`,
    `</sequence></project></event></library></fcpxml>`,
    ``,
  ].join("\n");
  return { xml, report };
}
