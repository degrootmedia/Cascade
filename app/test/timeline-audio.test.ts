/**
 * Audio editing basics tests — Animatic Editor Expansion Item A7.
 *
 * Model: per-clip volume + linear fades, track volume, pitch mode
 * (preserve default; natural only when chosen). Gain math is shared by
 * preview and render so what is drawn is what is encoded. Render: the
 * segment filter carries volume/fades/pitch only when set (unsped,
 * ungained clips keep byte-identical args), beds carry fades + track
 * volume into the mix.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production, ProductionTimeline, TimelineClip } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  addImportedAudioClip,
  clipDurationSec,
  clipGainAt,
  clipVolume,
  normalizeTimeline,
  setClipAudio,
  setTrackVolume,
  splitClipAt,
  trackVolume,
  validateTimeline,
} from "../src/shared/ipc.js";
import { assemblyPlanFromTimeline, buildMixArgs, buildNormalizeArgs } from "../src/main/assembly.js";

let n = 0;
const newId = (p: string): string => `${p}${++n}`;

const audioClip = (patch: Partial<TimelineClip> = {}): TimelineClip => ({
  id: "a1", trackId: "at", sourceKind: "audio", srcRel: "vo.mp3",
  sourceInSec: 0, sourceOutSec: 10, timelineStartSec: 0, ...patch,
});

const tl = (clips: TimelineClip[], trackPatch: object = {}): ProductionTimeline => ({
  version: 1,
  tracks: [
    { id: "vt", kind: "video", name: "V1" },
    { id: "at", kind: "audio", name: "A1", ...trackPatch },
  ],
  clips,
});

describe("gain math", () => {
  it("defaults: unity volume, no fades, preserve pitch", () => {
    const c = audioClip();
    expect(clipVolume(c)).toBe(1);
    expect(clipGainAt(c, 0)).toBe(1);
    expect(clipGainAt(c, 5)).toBe(1);
    expect(trackVolume({ id: "t", kind: "audio", name: "A" })).toBe(1);
  });

  it("fades are linear: 0 at the edge, half at the midpoint, full inside", () => {
    const c = audioClip({ volume: 0.8, fadeInSec: 2, fadeOutSec: 4 });
    expect(clipGainAt(c, 0)).toBe(0);
    expect(clipGainAt(c, 1)).toBeCloseTo(0.4, 9);
    expect(clipGainAt(c, 2)).toBeCloseTo(0.8, 9);
    expect(clipGainAt(c, 6)).toBeCloseTo(0.8, 9);
    expect(clipGainAt(c, 8)).toBeCloseTo(0.4, 9);
    expect(clipGainAt(c, 10)).toBe(0);
    // Outside the clip reads silence, not a negative extrapolation.
    expect(clipGainAt(c, -1)).toBe(0);
    expect(clipGainAt(c, 11)).toBe(0);
  });

  it("a muted clip reads zero gain everywhere", () => {
    expect(clipGainAt(audioClip({ muted: true, volume: 0.9 }), 5)).toBe(0);
  });
});

describe("setClipAudio / setTrackVolume", () => {
  it("sets volume sparse (1 disappears) and clamps to 0..1", () => {
    const t0 = tl([audioClip()]);
    const t1 = setClipAudio(t0, ["a1"], { volume: 0.25 })!;
    expect(t1.clips[0].volume).toBe(0.25);
    const t2 = setClipAudio(t1, ["a1"], { volume: 1 })!;
    expect(t2.clips[0].volume).toBeUndefined();
    const t3 = setClipAudio(t0, ["a1"], { volume: 7 })!;
    expect(t3.clips[0].volume).toBeUndefined(); // clamped to 1 -> sparse
    const t4 = setClipAudio(t0, ["a1"], { volume: -2 })!;
    expect(t4.clips[0].volume).toBe(0);
  });

  it("fades clamp so in+out never exceed the clip duration; 0 is sparse", () => {
    const t0 = tl([audioClip()]);
    const t1 = setClipAudio(t0, ["a1"], { fadeInSec: 3, fadeOutSec: 9 })!;
    expect(t1.clips[0].fadeInSec).toBe(3);
    expect(t1.clips[0].fadeOutSec).toBe(7);
    const t2 = setClipAudio(t1, ["a1"], { fadeInSec: 0 })!;
    expect(t2.clips[0].fadeInSec).toBeUndefined();
    expect(t2.clips[0].fadeOutSec).toBe(7);
  });

  it("pitch mode: natural is stored, preserve (default) is sparse", () => {
    const t0 = tl([audioClip({ speed: 2 })]);
    const t1 = setClipAudio(t0, ["a1"], { pitchMode: "natural" })!;
    expect(t1.clips[0].pitchMode).toBe("natural");
    const t2 = setClipAudio(t1, ["a1"], { pitchMode: "preserve" })!;
    expect(t2.clips[0].pitchMode).toBeUndefined();
  });

  it("refuses locked tracks and still/blank clips; empty patch is null", () => {
    const locked = tl([audioClip()], { locked: true });
    expect(setClipAudio(locked, ["a1"], { volume: 0.5 })).toBeNull();
    const withStill = tl([{ id: "s1", trackId: "vt", sourceKind: "still", srcRel: "s.jpg", holdSec: 2, timelineStartSec: 0 }]);
    expect(setClipAudio(withStill, ["s1"], { volume: 0.5 })).toBeNull();
    expect(setClipAudio(tl([audioClip()]), ["a1"], {})).toBeNull();
  });

  it("linked partners follow audio edits (detached audio of a video clip)", () => {
    const t0 = tl([
      { id: "v1", trackId: "vt", sourceKind: "video", srcRel: "c.mp4", sourceInSec: 0, sourceOutSec: 6, timelineStartSec: 0, linkId: "L1" },
      audioClip({ id: "a9", sourceOutSec: 6, linkId: "L1" }),
    ]);
    const t1 = setClipAudio(t0, ["a9"], { volume: 0.3 })!;
    expect(t1.clips.find((c) => c.id === "v1")!.volume).toBe(0.3);
    expect(t1.clips.find((c) => c.id === "a9")!.volume).toBe(0.3);
  });

  it("track volume is sparse, clamped, and readable via trackVolume", () => {
    const t0 = tl([audioClip()]);
    const t1 = setTrackVolume(t0, "at", 0.4);
    expect(t1.tracks.find((x) => x.id === "at")!.volume).toBe(0.4);
    expect(trackVolume(t1.tracks.find((x) => x.id === "at")!)).toBe(0.4);
    const t2 = setTrackVolume(t1, "at", 1);
    expect(t2.tracks.find((x) => x.id === "at")!.volume).toBeUndefined();
    const t3 = setTrackVolume(t0, "at", 5);
    expect(t3.tracks.find((x) => x.id === "at")!.volume).toBeUndefined();
  });

  it("split keeps fade-in on the left half and fade-out on the right", () => {
    const t0 = tl([audioClip({ fadeInSec: 2, fadeOutSec: 3, volume: 0.5 })]);
    const t1 = splitClipAt(t0, "a1", 4, newId)!;
    const [left, right] = [...t1.clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
    expect(left.fadeInSec).toBe(2);
    expect(left.fadeOutSec).toBeUndefined();
    expect(right.fadeInSec).toBeUndefined();
    expect(right.fadeOutSec).toBe(3);
    expect(left.volume).toBe(0.5);
    expect(right.volume).toBe(0.5);
    expect(clipDurationSec(left) + clipDurationSec(right)).toBeCloseTo(10, 9);
  });
});

describe("normalize + validate", () => {
  it("normalize clamps fades to the clip, drops preserve pitch + unity track volume", () => {
    const t = normalizeTimeline({
      version: 1,
      tracks: [{ id: "at", kind: "audio", name: "A", volume: 1 }],
      clips: [{ id: "a1", trackId: "at", sourceKind: "audio", srcRel: "vo.mp3", sourceInSec: 0, sourceOutSec: 10, timelineStartSec: 0, fadeInSec: 8, fadeOutSec: 8, pitchMode: "preserve" }],
    })!;
    expect(t.tracks[0].volume).toBeUndefined();
    expect(t.clips[0].fadeInSec).toBe(8);
    expect(t.clips[0].fadeOutSec).toBe(2);
    expect(t.clips[0].pitchMode).toBeUndefined();
  });

  it("validate flags out-of-range audio fields", () => {
    const errs = validateTimeline(tl([audioClip({ fadeInSec: 6, fadeOutSec: 6 })]));
    expect(errs.join(" ")).toMatch(/fade/i);
    expect(validateTimeline(tl([audioClip({ fadeInSec: 2, fadeOutSec: 2 })]))).toEqual([]);
  });
});

describe("render args", () => {
  const cfg = { fps: 24, width: 320, height: 180 };
  const baseEv = { kind: "clip" as const, durationSec: 4, muted: false, hasAudio: true };

  it("muted/audioless reversed clips never areverse the infinite silence input (A14 hang)", () => {
    for (const patch of [{ muted: true }, { hasAudio: false }]) {
      const args = buildNormalizeArgs({ ...baseEv, ...patch, reversed: true }, cfg, "/in.mp4", "/out.mov");
      const af = args[args.indexOf("-af") + 1];
      expect(af).not.toContain("areverse");
      // The video side still reverses.
      expect(args[args.indexOf("-vf") + 1]).toContain("reverse");
    }
    const audible = buildNormalizeArgs({ ...baseEv, reversed: true }, cfg, "/in.mp4", "/out.mov");
    expect(audible[audible.indexOf("-af") + 1]).toContain("areverse");
  });

  it("no audio fields -> no gain/fade/pitch filters (legacy-identical)", () => {
    const args = buildNormalizeArgs(baseEv, cfg, "/in.mp4", "/out.mov");
    const af = args[args.indexOf("-af") + 1];
    expect(af).toBe("aresample=48000,apad,atrim=end_sample=192000");
  });

  it("constant volume becomes a volume filter after retiming", () => {
    const args = buildNormalizeArgs({ ...baseEv, volume: 0.5 }, cfg, "/in.mp4", "/out.mov");
    const af = args[args.indexOf("-af") + 1];
    expect(af).toContain("volume=0.5");
    expect(af.indexOf("volume=0.5")).toBeLessThan(af.indexOf("aresample=48000"));
  });

  it("fades become an eval volume expression tracking clip-local time", () => {
    const args = buildNormalizeArgs({ ...baseEv, volume: 0.8, fadeInSec: 1, fadeOutSec: 2 }, cfg, "/in.mp4", "/out.mov");
    const af = args[args.indexOf("-af") + 1];
    expect(af).toContain("eval=frame");
    expect(af).toContain("0.8");
  });

  it("span offset shifts the fade window (covered head resumes mid-fade)", () => {
    const args = buildNormalizeArgs({ ...baseEv, fadeInSec: 2, gainOffsetSec: 1, clipDurSec: 10 }, cfg, "/in.mp4", "/out.mov");
    const af = args[args.indexOf("-af") + 1];
    // local expression time is (t + 1): the span starts 1s into the clip.
    expect(af).toContain("(t+1");
  });

  it("preserve-pitch (default) uses atempo; natural uses asetrate", () => {
    const keep = buildNormalizeArgs({ ...baseEv, speed: 2 }, cfg, "/in.mp4", "/out.mov");
    const keepAf = keep[keep.indexOf("-af") + 1];
    expect(keepAf).toContain("atempo=2");
    expect(keepAf).not.toContain("asetrate");
    const nat = buildNormalizeArgs({ ...baseEv, speed: 2, pitchMode: "natural" }, cfg, "/in.mp4", "/out.mov");
    const natAf = nat[nat.indexOf("-af") + 1];
    expect(natAf).toContain("asetrate=96000");
    expect(natAf).not.toContain("atempo");
    // Natural at 1x is a no-op.
    const one = buildNormalizeArgs({ ...baseEv, pitchMode: "natural" }, cfg, "/in.mp4", "/out.mov");
    expect(one[one.indexOf("-af") + 1]).not.toContain("asetrate");
  });

  it("plan carries clip×track volume, fades, and pitch onto events and beds", () => {
    const prod = {
      meta: { id: "p7", name: "A7", folder: "/tmp", createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
      currentStep: 4, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
      timeline: {
        version: 1,
        tracks: [
          { id: "vt", kind: "video", name: "V1", volume: 0.5 },
          { id: "at", kind: "audio", name: "VO", volume: 0.5 },
        ],
        clips: [
          { id: "v1", trackId: "vt", sourceKind: "video", srcRel: "c.mp4", sourceInSec: 0, sourceOutSec: 4, timelineStartSec: 0, speed: 2, volume: 0.8, fadeOutSec: 1, pitchMode: "natural" },
          { id: "vo", trackId: "at", sourceKind: "audio", srcRel: "vo.mp3", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0, role: "voiceover", volume: 0.6, fadeInSec: 0.5, fadeOutSec: 2 },
        ],
      },
      assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    } as unknown as Production;
    const plan = assemblyPlanFromTimeline(prod);
    const ev = plan.events.find((e) => e.kind === "clip")!;
    expect(ev.volume).toBeCloseTo(0.4, 9); // 0.8 clip × 0.5 track
    expect(ev.fadeOutSec).toBe(1);
    expect(ev.pitchMode).toBe("natural");
    expect(plan.voiceover!.volume).toBeCloseTo(0.3, 9); // 0.6 × 0.5
    expect(plan.voiceover!.fadeInSec).toBe(0.5);
    expect(plan.voiceover!.fadeOutSec).toBe(2);
    expect(plan.voiceover!.durationSec).toBe(8);
  });

  it("mix args fade beds only when fades are present", () => {
    const plain = buildMixArgs({ renderAbs: "/r.mov", voiceover: { abs: "/vo.mp3", volume: 0.9 }, totalSec: 8, outAbs: "/o.mp4" });
    expect(plain.join(" ")).not.toContain("afade");
    const faded = buildMixArgs({
      renderAbs: "/r.mov",
      voiceover: { abs: "/vo.mp3", volume: 0.9, fadeInSec: 0.5, fadeOutSec: 2, durationSec: 8 },
      totalSec: 8, outAbs: "/o.mp4",
    });
    const joined = faded.join(" ");
    expect(joined).toContain("afade=t=in:st=0:d=0.5");
    expect(joined).toContain("afade=t=out:st=6:d=2");
  });
});

describe("addImportedAudioClip placement (audio lives on tracks)", () => {
  const base = (): ProductionTimeline => ({
    version: 1,
    tracks: [
      { id: "v1", kind: "video", name: "V1" },
      { id: "a1", kind: "audio", name: "A1" },
      { id: "a2", kind: "audio", name: "A2" },
    ],
    clips: [
      { id: "x", trackId: "a1", sourceKind: "audio", srcRel: "a.mp3", sourceInSec: 0, sourceOutSec: 10, timelineStartSec: 0 },
    ],
  });
  const placed = (t: ProductionTimeline, id: string | null) => t.clips.find((c) => c.id === id)!;

  it("lands at the playhead on the first audio track with room", () => {
    // a1 is busy 0..10; a2 is free at the playhead (4s).
    const { timeline, clipId } = addImportedAudioClip(base(), { srcRel: "audio/new.mp3", name: "new.mp3", durationSec: 3 }, 4, () => newId("c"));
    const c = placed(timeline, clipId);
    expect(c.trackId).toBe("a2");
    expect(c.timelineStartSec).toBe(4);
    expect(c.sourceKind).toBe("audio");
    expect(clipDurationSec(c)).toBe(3);
    expect(validateTimeline(timeline)).toEqual([]);
  });

  it("falls back to the end of the first audio track when no playhead slot fits", () => {
    const t0 = base();
    t0.clips.push({ id: "y", trackId: "a2", sourceKind: "audio", srcRel: "b.mp3", sourceInSec: 0, sourceOutSec: 10, timelineStartSec: 2 });
    const { timeline, clipId } = addImportedAudioClip(t0, { srcRel: "audio/new.mp3", durationSec: 3 }, 4, () => newId("c"));
    const c = placed(timeline, clipId);
    expect(c.trackId).toBe("a1");
    expect(c.timelineStartSec).toBe(10); // end of a1's content
    expect(validateTimeline(timeline)).toEqual([]);
  });

  it("creates a new audio track when the timeline has none", () => {
    const t0: ProductionTimeline = { version: 1, tracks: [{ id: "v1", kind: "video", name: "V1" }], clips: [] };
    const { timeline, clipId } = addImportedAudioClip(t0, { srcRel: "audio/new.mp3", durationSec: 5 }, 2, () => newId("c"));
    const audioTracks = timeline.tracks.filter((tr) => tr.kind === "audio");
    expect(audioTracks).toHaveLength(1);
    const c = placed(timeline, clipId);
    expect(c.trackId).toBe(audioTracks[0].id);
    expect(c.timelineStartSec).toBe(2);
    expect(validateTimeline(timeline)).toEqual([]);
  });

  it("skips locked audio tracks and refuses an unusable duration", () => {
    const t0 = base();
    t0.tracks[1].locked = true;
    t0.tracks[2].locked = true;
    const { timeline, clipId } = addImportedAudioClip(t0, { srcRel: "audio/new.mp3", durationSec: 2 }, 0, () => newId("c"));
    const c = placed(timeline, clipId);
    expect(["a1", "a2"]).not.toContain(c.trackId); // fresh track
    expect(addImportedAudioClip(base(), { srcRel: "x.mp3", durationSec: 0 }, 0, () => "z").clipId).toBeNull();
  });
});
