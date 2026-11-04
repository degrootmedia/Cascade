/**
 * Premiere XML (xmeml v5) export (Animatic Editor Expansion, Item 11)
 * — Premiere Pro and DaVinci Resolve. Reads the timeline MODEL: all
 * times in frames, video tracks in stacking order (V1 = bottom),
 * clipitems with record/source ranges, constant speeds as
 * time-remap filters, dissolves as centered transitionitems, audio
 * levels with fade keyframes.
 *
 * Speed RAMPS export at their AVERAGE speed — a stated simplification
 * (the xmeml variable-speed graph is not reliably portable): clip
 * duration and consumed source range stay exact, so cuts and end
 * frames land identically; intra-clip timing differs from the
 * Cascade render and the report says so.
 */
import {
  clipDurationSec,
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
import { mediaFileUrl, volumeDb, xmlEsc } from "./fcpxml.js";

const esc = xmlEsc;

export function buildPremiereXml(
  p: Production,
  cfg: { fps: number; width: number; height: number }
): { xml: string; report: string[] } {
  const fps = Math.max(1, Math.round(cfg.fps));
  const F = (sec: number): number => Math.round(sec * fps);
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
  const clipSrc = (clip: TimelineClip): string | undefined =>
    mediaPathForId(p.media, clip.mediaId) ?? clip.srcRel;

  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;

  // ---- files (first reference full, later ones by id) -------------------------
  const fileIdByRel = new Map<string, string>();
  let fileN = 0;
  const fileEl = (clip: TimelineClip): string => {
    const rel = clipSrc(clip);
    if (!rel) return "";
    const seen = fileIdByRel.get(rel);
    if (seen) return `<file id="${seen}"/>`;
    const id = `file-${++fileN}`;
    fileIdByRel.set(rel, id);
    const durFrames = F(Math.max(1, (clip.sourceOutSec ?? clip.holdSec ?? 1) + 2));
    const media =
      clip.sourceKind === "audio"
        ? `<media><audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media>`
        : `<media><video><samplecharacteristics><width>${cfg.width}</width><height>${cfg.height}</height><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>${
            clip.sourceKind === "video"
              ? `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>`
              : ""
          }</media>`;
    return `<file id="${id}"><name>${esc(rel.split("/").pop() ?? rel)}</name><pathurl>${esc(mediaFileUrl(assetPath(p, rel)))}</pathurl>${rate}<duration>${durFrames}</duration>${media}</file>`;
  };

  // ---- effects ------------------------------------------------------------------
  const timeRemap = (clip: TimelineClip): string => {
    const avg = clipSpeed(clip);
    const pct = Math.round(100 * avg) * (clip.reversed ? -1 : 1);
    if (!clip.reversed && avg === 1 && !clip.speedCurve?.length) return "";
    if (clip.speedCurve?.length) {
      report.push(`"${clip.name ?? clipSrc(clip) ?? clip.id}" speed ramp exported at its average ${pct}% (stated simplification: duration and end frame exact, intra-clip timing flattened vs the Cascade render).`);
    }
    return (
      `<filter><effect><name>Time Remap</name><effectid>timeremap</effectid>` +
      `<effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>` +
      `<parameter><parameterid>speed</parameterid><name>speed</name><valuemin>-10000</valuemin><valuemax>10000</valuemax><value>${pct}</value></parameter>` +
      `<parameter><parameterid>variablespeed</parameterid><name>variablespeed</name><value>0</value></parameter>` +
      `<parameter><parameterid>frameblending</parameterid><name>frameblending</name><value>0</value></parameter>` +
      `</effect></filter>`
    );
  };

  const levelDbNum = (v: number): number => (v <= 0 ? -96 : Math.max(-96, 20 * Math.log10(v)));
  const audioLevels = (clip: TimelineClip, track: TimelineTrack): string => {
    if (clip.sourceKind === "still" || clip.sourceKind === "blank") return "";
    const eff = clip.muted ? 0 : clipVolume(clip) * trackVolume(track);
    const hasFades = (clip.fadeInSec ?? 0) > 0 || (clip.fadeOutSec ?? 0) > 0;
    if (eff === 1 && !hasFades) return "";
    const dur = clipDurationSec(clip);
    const base = levelDbNum(eff);
    let param = `<parameter><parameterid>level</parameterid><name>Level</name><valuemin>-96</valuemin><valuemax>12</valuemax><value>${base.toFixed(2)}</value>`;
    if (hasFades) {
      const kf = (whenSec: number, v: number): string =>
        `<keyframe><when>${F(whenSec)}</when><value>${v.toFixed(2)}</value></keyframe>`;
      const pts: string[] = [];
      pts.push(kf(0, (clip.fadeInSec ?? 0) > 0 ? -96 : base));
      if ((clip.fadeInSec ?? 0) > 0) pts.push(kf(clip.fadeInSec!, base));
      if ((clip.fadeOutSec ?? 0) > 0) {
        pts.push(kf(dur - clip.fadeOutSec!, base));
        pts.push(kf(dur, -96));
      } else {
        pts.push(kf(dur, base));
      }
      param += pts.join("");
    }
    param += `</parameter>`;
    return `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effecttype>audiolevels</effecttype>${param}</effect></filter>`;
  };

  let clipN = 0;
  const clipItem = (clip: TimelineClip, track: TimelineTrack): string => {
    const dur = clipDurationSec(clip);
    const srcIn = clip.sourceKind === "still" || clip.sourceKind === "blank" ? 0 : clip.sourceInSec ?? 0;
    const srcRange = clip.sourceKind === "still" || clip.sourceKind === "blank"
      ? dur
      : Math.max(0, (clip.sourceOutSec ?? srcIn) - srcIn);
    const enabled = (track.kind === "video" && track.hidden) || (track.kind === "audio" && track.muted) ? "<enabled>FALSE</enabled>" : "";
    const name = esc(clip.name ?? clipSrc(clip)?.split("/").pop() ?? "Clip");
    return (
      `<clipitem id="clipitem-${++clipN}"><name>${name}</name>${enabled}` +
      `<duration>${F(srcRange)}</duration>${rate}` +
      `<start>${F(clip.timelineStartSec)}</start><end>${F(clip.timelineStartSec + dur)}</end>` +
      `<in>${F(srcIn)}</in><out>${F(srcIn + srcRange)}</out>` +
      `${fileEl(clip)}${timeRemap(clip)}${audioLevels(clip, track)}</clipitem>`
    );
  };

  // ---- tracks ---------------------------------------------------------------------
  const transitionAt = new Map<string, number>();
  for (const b of resolved.blendSpans) transitionAt.set(b.outgoing.id, b.transition.durationSec);
  for (const tr of timeline.transitions ?? []) {
    if (!resolved.blendSpans.some((b) => b.transition.id === tr.id)) {
      const out = timeline.clips.find((c) => c.id === tr.outgoingClipId);
      report.push(`Dissolve after "${out?.name ?? tr.outgoingClipId}" is covered by another track and was dropped (cut instead).`);
    }
  }

  const trackEl = (track: TimelineTrack): string => {
    const clips = timeline.clips
      .filter((c) => c.trackId === track.id)
      .sort((a, b) => a.timelineStartSec - b.timelineStartSec);
    const items: string[] = [];
    clips.forEach((clip, i) => {
      if (clip.sourceKind === "blank") return; // xmeml gaps are implicit
      items.push(clipItem(clip, track));
      const d = transitionAt.get(clip.id);
      const next = clips.slice(i + 1).find((c) => c.sourceKind !== "blank");
      if (d && next) {
        const edit = F(clip.timelineStartSec + clipDurationSec(clip));
        const half = Math.round(F(d) / 2);
        items.push(
          `<transitionitem><start>${edit - half}</start><end>${edit + (F(d) - half)}</end><alignment>center</alignment>` +
          `<effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effecttype>transition</effecttype><mediatype>video</mediatype></effect></transitionitem>`
        );
      }
    });
    return `<track>${items.join("")}</track>`;
  };

  const videoTracks = [...timeline.tracks.filter((t) => t.kind === "video")].reverse(); // V1 = bottom
  const audioTrackList = timeline.tracks.filter((t) => t.kind === "audio");

  // ---- degradations -----------------------------------------------------------------
  const natural = timeline.clips.filter((c) => c.pitchMode === "natural");
  if (natural.length) {
    report.push(`${natural.length} clip(s) use natural pitch-shift retiming; xmeml time remap has no pitch flag (Premiere's Maintain Audio Pitch defaults on), so pitch may differ from the Cascade render.`);
  }
  const linked = new Set(timeline.clips.map((c) => c.linkId).filter(Boolean));
  if (linked.size) report.push(`${linked.size} linked clip group(s) exported without link metadata.`);
  if (timeline.clips.some((c) => c.speedInterp)) {
    report.push("Retime frame interpolation (blend/flow) is a Cascade render setting and is not represented in xmeml.");
  }
  if (timeline.clips.some((c) => c.sourceKind === "video" && c.muted)) {
    report.push("Muted embedded video audio: Premiere may relink the file's audio on import; mute those clips' audio after import to match the Cascade render.");
  }
  report.push("File durations are referenced extents (unprobed); the importing editor re-reads the media.");

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE xmeml>`,
    `<xmeml version="5">`,
    `<sequence id="sequence-1"><name>${esc(p.meta.name)}</name><duration>${F(resolved.totalSec)}</duration>${rate}`,
    `<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`,
    `<media><video><format><samplecharacteristics>${rate}<width>${cfg.width}</width><height>${cfg.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>`,
    ...videoTracks.map(trackEl),
    `</video>`,
    `<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>`,
    ...audioTrackList.map(trackEl),
    `</audio></media></sequence></xmeml>`,
    ``,
  ].join("\n");
  return { xml, report };
}
