/**
 * Old-animatic replacement support ops:
 *
 * - scaleTimelineToDuration: the timeline-native "Fit to VO / set total"
 *   (the legacy strip rescaled shot windows; here every clip's timeline
 *   span scales proportionally, speeds unchanged).
 * - reconcileTimelineShotMedia: clips seeded from shots follow the shot's
 *   CURRENT selected output when it changes kind-for-kind, so regenerating
 *   a shot's video updates the edit instead of leaving stale media behind
 *   once the shot-driven strip is gone.
 */
import { describe, it, expect } from "vitest";
import type { Production, ProductionTimeline } from "../src/shared/ipc.js";
import {
  clipDurationSec,
  clipEndSec,
  reconcileTimelineShotMedia,
  scaleTimelineToDuration,
  syncTimelineBeds,
  validateTimeline,
} from "../src/shared/ipc.js";

function baseTimeline(): ProductionTimeline {
  return {
    version: 1,
    tracks: [
      { id: "v1", kind: "video", name: "V1" },
      { id: "a1", kind: "audio", name: "A1" },
    ],
    clips: [
      { id: "c1", trackId: "v1", sourceKind: "video", srcRel: "clips/one.mp4", sourceInSec: 2, sourceOutSec: 6, timelineStartSec: 0 },
      { id: "c2", trackId: "v1", sourceKind: "still", srcRel: "stills/two.jpg", holdSec: 2, timelineStartSec: 4 },
      { id: "vo", trackId: "a1", sourceKind: "audio", srcRel: "vo.mp3", sourceInSec: 0, sourceOutSec: 6, timelineStartSec: 0, role: "voiceover", volume: 0.5, fadeInSec: 1, fadeOutSec: 1 },
    ],
  };
}

const byId = (t: ProductionTimeline, id: string) => t.clips.find((c) => c.id === id)!;
const end = (t: ProductionTimeline) => Math.max(...t.clips.map(clipEndSec));

describe("scaleTimelineToDuration", () => {
  it("scales every span proportionally to land on the target total", () => {
    const t = baseTimeline();
    expect(end(t)).toBe(6);
    const s = scaleTimelineToDuration(t, 12);
    expect(validateTimeline(s)).toEqual([]);
    expect(end(s)).toBeCloseTo(12, 6);
    // Video clip: same in-point and speed, source range scaled.
    expect(byId(s, "c1").sourceInSec).toBe(2);
    expect(byId(s, "c1").sourceOutSec).toBeCloseTo(10, 6);
    expect(clipDurationSec(byId(s, "c1"))).toBeCloseTo(8, 6);
    // Still: start and hold scaled.
    expect(byId(s, "c2").timelineStartSec).toBeCloseTo(8, 6);
    expect(byId(s, "c2").holdSec).toBeCloseTo(4, 6);
    // Bed: range and fades scaled, volume untouched.
    expect(byId(s, "vo").sourceOutSec).toBeCloseTo(12, 6);
    expect(byId(s, "vo").fadeInSec).toBeCloseTo(2, 6);
    expect(byId(s, "vo").fadeOutSec).toBeCloseTo(2, 6);
    expect(byId(s, "vo").volume).toBe(0.5);
    // Input never mutated.
    expect(end(t)).toBe(6);
  });

  it("shrinks as well as grows", () => {
    const s = scaleTimelineToDuration(baseTimeline(), 3);
    expect(end(s)).toBeCloseTo(3, 6);
    expect(validateTimeline(s)).toEqual([]);
  });

  it("scales ramp keyframes and source range together (duration scales, speeds keep)", () => {
    const t = baseTimeline();
    t.clips[0] = {
      ...t.clips[0],
      sourceInSec: 0,
      sourceOutSec: 3,
      speedCurve: [
        { atSec: 0, speed: 1 },
        { atSec: 2, speed: 2 },
      ],
    };
    const before = clipDurationSec(t.clips[0]);
    expect(before).toBeCloseTo(2, 6);
    const s = scaleTimelineToDuration(t, end(t) * 2);
    const c = byId(s, "c1");
    expect(c.speedCurve?.map((k) => k.atSec)).toEqual([0, 4]);
    expect(c.speedCurve?.map((k) => k.speed)).toEqual([1, 2]);
    expect(clipDurationSec(c)).toBeCloseTo(before * 2, 6);
  });

  it("returns the timeline unchanged for a non-positive or empty target", () => {
    const t = baseTimeline();
    expect(scaleTimelineToDuration(t, 0)).toEqual(t);
    expect(scaleTimelineToDuration(t, -5)).toEqual(t);
    const empty: ProductionTimeline = { version: 1, tracks: [], clips: [] };
    expect(scaleTimelineToDuration(empty, 10)).toEqual(empty);
  });
});

function prodWithShot(shot: Record<string, unknown>): Production {
  return {
    meta: { id: "p1" },
    scenes: [{ id: "sc1", shots: [shot] }],
    shotSequences: [],
    references: [],
    media: [
      { id: "m-new", path: "clips/new.mp4", kind: "video", origin: "generated", state: "present" },
      { id: "m-still", path: "stills/new.jpg", kind: "image", origin: "generated", state: "present" },
    ],
  } as unknown as Production;
}

describe("reconcileTimelineShotMedia", () => {
  it("re-points a shot's video clip at the newly selected take, trims kept", () => {
    const prod = prodWithShot({
      id: "s1",
      number: "01",
      graphOutputSource: "videogen",
      graphVideoNodes: [{ id: "vid0", genIndex: 0, gens: [{ path: "clips/new.mp4" }] }],
    });
    const t = baseTimeline();
    t.clips[0] = { ...t.clips[0], shotId: "s1", srcRel: "clips/old.mp4", mediaId: "m-old" };
    const r = reconcileTimelineShotMedia(t, prod);
    expect(r).not.toBe(t);
    expect(byId(r, "c1").srcRel).toBe("clips/new.mp4");
    expect(byId(r, "c1").mediaId).toBe("m-new");
    expect(byId(r, "c1").sourceInSec).toBe(2);
    expect(byId(r, "c1").sourceOutSec).toBe(6);
  });

  it("returns the same object when every shot clip is already current", () => {
    const prod = prodWithShot({
      id: "s1",
      number: "01",
      graphOutputSource: "videogen",
      graphVideoNodes: [{ id: "vid0", genIndex: 0, gens: [{ path: "clips/new.mp4" }] }],
    });
    const t = baseTimeline();
    t.clips[0] = { ...t.clips[0], shotId: "s1", srcRel: "clips/new.mp4", mediaId: "m-new" };
    expect(reconcileTimelineShotMedia(t, prod)).toBe(t);
  });

  it("updates still clips to the newly selected still", () => {
    const prod = prodWithShot({
      id: "s2",
      number: "02",
      graphOutputSource: "imagegen",
      graphImageGenIndex: 0,
      graphImageGens: [{ path: "stills/new.jpg" }],
    });
    const t = baseTimeline();
    t.clips[1] = { ...t.clips[1], shotId: "s2", srcRel: "stills/old.jpg", mediaId: "m-old-still" };
    const r = reconcileTimelineShotMedia(t, prod);
    expect(byId(r, "c2").srcRel).toBe("stills/new.jpg");
    expect(byId(r, "c2").mediaId).toBe("m-still");
    expect(byId(r, "c2").holdSec).toBe(2);
  });

  it("never converts across kinds (a shot that now shows a still leaves its video clip alone)", () => {
    const prod = prodWithShot({
      id: "s1",
      number: "01",
      graphOutputSource: "imagegen",
      graphImageGenIndex: 0,
      graphImageGens: [{ path: "stills/new.jpg" }],
    });
    const t = baseTimeline();
    t.clips[0] = { ...t.clips[0], shotId: "s1", srcRel: "clips/old.mp4" };
    expect(reconcileTimelineShotMedia(t, prod)).toBe(t);
  });
});

let bedN = 0;
const newBedId = (prefix: string): string => `${prefix}-bed${++bedN}`;

function prodWithAudio(over: Record<string, unknown>): Production {
  return {
    meta: { id: "p1" },
    scenes: [],
    shotSequences: [],
    references: [],
    media: [{ id: "m-vo2", path: "vo2.mp3", kind: "audio", origin: "imported", state: "present" }],
    ...over,
  } as unknown as Production;
}

describe("syncTimelineBeds", () => {
  it("adds a voiceover bed when the VO is imported after the seed", () => {
    const t = baseTimeline();
    t.clips = t.clips.filter((c) => c.id !== "vo");
    const r = syncTimelineBeds(t, prodWithAudio({ voiceoverPath: "vo2.mp3", voiceoverVolume: 0.8 }), newBedId);
    const bed = r.clips.find((c) => c.role === "voiceover");
    expect(bed?.srcRel).toBe("vo2.mp3");
    expect(bed?.mediaId).toBe("m-vo2");
    expect(bed?.volume).toBe(0.8);
    expect(bed?.timelineStartSec).toBe(0);
    expect(r.tracks.find((x) => x.id === bed?.trackId)?.kind).toBe("audio");
    expect(validateTimeline(r)).toEqual([]);
  });

  it("re-points the bed on replace, keeping drawn gain and fades", () => {
    const t = baseTimeline();
    const r = syncTimelineBeds(t, prodWithAudio({ voiceoverPath: "vo2.mp3" }), newBedId);
    const bed = byId(r, "vo");
    expect(bed.srcRel).toBe("vo2.mp3");
    expect(bed.volume).toBe(0.5);
    expect(bed.fadeInSec).toBe(1);
    expect(bed.fadeOutSec).toBe(1);
  });

  it("removes the bed clips when the VO is removed", () => {
    const r = syncTimelineBeds(baseTimeline(), prodWithAudio({}), newBedId);
    expect(r.clips.some((c) => c.role === "voiceover")).toBe(false);
  });

  it("is a same-object no-op when beds already match, and on an empty timeline", () => {
    const t = baseTimeline();
    expect(syncTimelineBeds(t, prodWithAudio({ voiceoverPath: "vo.mp3" }), newBedId)).toBe(t);
    const empty: ProductionTimeline = { version: 1, tracks: [{ id: "v1", kind: "video", name: "V1" }], clips: [] };
    expect(syncTimelineBeds(empty, prodWithAudio({ voiceoverPath: "vo2.mp3" }), newBedId)).toBe(empty);
  });
});
