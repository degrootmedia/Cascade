/**
 * Timeline model tests — Animatic Editor Expansion Item A1.
 *
 * The shared timeline model (types, normalize, validate, resolver, seed from
 * the legacy shot projection, track ops) and the Item 1 migration guarantee:
 * a pre-change project file (app/test/fixtures/pre-timeline-production.json)
 * seeds into a timeline whose assembly plan + EDL are identical to the
 * legacy shot-based plan.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Production, ProductionTimeline, TimelineClip, TimelineTrack } from "../src/shared/ipc.js";

// pipeline.ts imports scripting.ts; mirror assembly.test.ts and mock it away.
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  addTrack,
  clipDurationSec,
  emptyTimeline,
  moveClipToTrack,
  normalizeTimeline,
  removeTrack,
  renameTrack,
  resolveTimeline,
  seedTimelineFromProduction,
  setTrackLocked,
  validateTimeline,
} from "../src/shared/ipc.js";
import { assemblyPlan, assemblyPlanFromTimeline, buildEdl } from "../src/main/assembly.js";

// ---- helpers ---------------------------------------------------------------

let n = 0;
const newId = (prefix: string): string => `${prefix}-${++n}`;

function vTrack(id: string, over: Partial<TimelineTrack> = {}): TimelineTrack {
  return { id, kind: "video", name: id.toUpperCase(), ...over };
}
function aTrack(id: string, over: Partial<TimelineTrack> = {}): TimelineTrack {
  return { id, kind: "audio", name: id.toUpperCase(), ...over };
}
function vClip(id: string, trackId: string, startSec: number, durSec: number, over: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id,
    trackId,
    sourceKind: "video",
    srcRel: `clips/${id}.mp4`,
    sourceInSec: 0,
    sourceOutSec: durSec,
    timelineStartSec: startSec,
    ...over,
  };
}

// ---- normalize / validate ----------------------------------------------------

describe("normalizeTimeline", () => {
  it("rejects a non-object and a wrong version", () => {
    expect(normalizeTimeline(undefined)).toBeUndefined();
    expect(normalizeTimeline(null)).toBeUndefined();
    expect(normalizeTimeline({ version: 99, tracks: [], clips: [] })).toBeUndefined();
  });

  it("drops corrupt entries, dedupes ids, drops overlaps and orphan clips", () => {
    const raw = {
      version: 1,
      tracks: [vTrack("v1"), vTrack("v1"), { id: 42 }, aTrack("a1")],
      clips: [
        vClip("c1", "v1", 0, 4),
        vClip("c2", "v1", 2, 4), // overlaps c1 — dropped
        vClip("c3", "v1", 4, 2),
        vClip("c4", "gone", 0, 1), // missing track — dropped
        { ...vClip("c5", "a1", 0, 1), sourceKind: "audio", srcRel: "a.mp3" },
        { junk: true },
      ],
    };
    const t = normalizeTimeline(raw)!;
    expect(t.tracks.map((x) => x.id)).toEqual(["v1", "a1"]);
    expect(t.clips.map((x) => x.id)).toEqual(["c1", "c3", "c5"]);
    expect(validateTimeline(t)).toEqual([]);
  });

  it("repairs unusable numbers instead of keeping NaN ranges", () => {
    const raw = {
      version: 1,
      tracks: [vTrack("v1")],
      clips: [{ ...vClip("c1", "v1", -5, 3), sourceInSec: Number.NaN, sourceOutSec: -1 }],
    };
    const t = normalizeTimeline(raw)!;
    // Out <= in after repair = no playable range — the clip is dropped.
    expect(t.clips).toEqual([]);
  });
});

describe("validateTimeline", () => {
  it("names overlaps and duplicate ids", () => {
    const t: ProductionTimeline = {
      version: 1,
      tracks: [vTrack("v1"), vTrack("v1")],
      clips: [vClip("c1", "v1", 0, 4), vClip("c2", "v1", 2, 4)],
    };
    const errs = validateTimeline(t);
    expect(errs.some((e) => e.includes("v1"))).toBe(true);
    expect(errs.some((e) => /overlap/.test(e))).toBe(true);
  });
});

// ---- resolver ----------------------------------------------------------------

describe("resolveTimeline", () => {
  it("stacks 3 video tracks topmost-wins, gaps read as black spans", () => {
    const t: ProductionTimeline = {
      version: 1,
      tracks: [vTrack("v3"), vTrack("v2"), vTrack("v1"), aTrack("a1"), aTrack("a2"), aTrack("a3")],
      clips: [
        vClip("base", "v1", 0, 10),
        vClip("mid", "v2", 2, 3),
        vClip("top", "v3", 3, 1),
        { ...vClip("au1", "a1", 0, 10), sourceKind: "audio" as const, srcRel: "a1.mp3" },
        { ...vClip("au2", "a2", 5, 2), sourceKind: "audio" as const, srcRel: "a2.mp3" },
      ],
    };
    const r = resolveTimeline(t);
    const at = (sec: number) => r.videoSpans.find((s) => sec >= s.startSec && sec < s.endSec)?.clip?.id ?? null;
    expect(at(0.5)).toBe("base");
    expect(at(2.5)).toBe("mid");
    expect(at(3.5)).toBe("top");
    expect(at(4.5)).toBe("mid");
    expect(at(6)).toBe("base");
    expect(r.totalSec).toBe(10);
    expect(r.audioClips.map((c) => c.clip.id)).toEqual(["au1", "au2"]);
  });

  it("hidden video tracks and muted audio tracks resolve to nothing", () => {
    const t: ProductionTimeline = {
      version: 1,
      tracks: [vTrack("v1", { hidden: true }), aTrack("a1", { muted: true })],
      clips: [vClip("c1", "v1", 0, 5), { ...vClip("c2", "a1", 0, 5), sourceKind: "audio" as const }],
    };
    const r = resolveTimeline(t);
    expect(r.videoSpans.every((s) => s.clip === null)).toBe(true);
    expect(r.audioClips).toEqual([]);
    expect(r.totalSec).toBe(5);
  });
});

// ---- track ops -----------------------------------------------------------------

describe("track ops", () => {
  const base = (): ProductionTimeline => ({
    version: 1,
    tracks: [vTrack("v1"), vTrack("v2"), aTrack("a1")],
    clips: [vClip("c1", "v1", 0, 4), vClip("c2", "v2", 0, 4)],
  });

  it("adds, renames, and removes tracks (clips go with a removed track)", () => {
    let t = addTrack(base(), aTrack("a2"));
    t = renameTrack(t, "a2", "Music");
    expect(t.tracks.find((x) => x.id === "a2")?.name).toBe("Music");
    t = removeTrack(t, "v2");
    expect(t.tracks.map((x) => x.id)).toEqual(["v1", "a1", "a2"]);
    expect(t.clips.map((c) => c.id)).toEqual(["c1"]);
  });

  it("moves a clip between same-kind tracks only, never into lock or overlap", () => {
    const t = base();
    // v2 is occupied 0..4 by c2: moving c1 there overlaps.
    expect(moveClipToTrack(t, "c1", "v2")).toBeNull();
    // Cross-kind is refused.
    expect(moveClipToTrack(t, "c1", "a1")).toBeNull();
    // Locked target is refused.
    const locked = setTrackLocked(addTrack(t, vTrack("v3")), "v3", true);
    expect(moveClipToTrack(locked, "c1", "v3")).toBeNull();
    // A free same-kind track accepts.
    const free = addTrack(t, vTrack("v3"));
    const moved = moveClipToTrack(free, "c1", "v3")!;
    expect(moved.clips.find((c) => c.id === "c1")?.trackId).toBe("v3");
    // The source timeline is untouched (pure op).
    expect(t.clips.find((c) => c.id === "c1")?.trackId).toBe("v1");
  });

  it("clipDurationSec derives from the source range (hold for stills/blanks)", () => {
    expect(clipDurationSec(vClip("c", "v1", 0, 4, { sourceInSec: 1.5, sourceOutSec: 5.5 }))).toBe(4);
    expect(clipDurationSec({ id: "s", trackId: "v1", sourceKind: "still", timelineStartSec: 0, holdSec: 2.5 })).toBe(2.5);
  });
});

// ---- seed from the pre-change fixture ------------------------------------------

let fixtureRoot: string;
let prodFolder: string;

function loadFixture(): Production {
  const raw = fs.readFileSync(path.join(__dirname, "fixtures", "pre-timeline-production.json"), "utf8");
  const p = JSON.parse(raw) as Production;
  p.meta.folder = prodFolder;
  return p;
}

beforeEach(() => {
  fixtureRoot = path.join(os.tmpdir(), `cascade-timeline-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  prodFolder = path.join(fixtureRoot, "prod");
  const write = (rel: string) => {
    const abs = path.join(prodFolder, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `fake-${rel}`);
  };
  for (const rel of [
    "boards/0100/shot-0100.jpg",
    "boards/0100/video/clip-0100.mp4",
    "boards/0200/shot-0200.jpg",
    "boards/0400/video/clip-0400.mp4",
    "boards/0500/shot-0500.jpg",
    "boards/0600/shot-0600.jpg",
    "out/sequences/seq1/take.mp4",
    "voiceover/voiceover.mp3",
    "music/music.mp3",
  ]) write(rel);
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("seedTimelineFromProduction (pre-change fixture)", () => {
  it("migrates the single-track animatic with identical order and timing", () => {
    n = 0;
    const p = loadFixture();
    expect(p.timeline).toBeUndefined(); // the fixture predates the timeline field
    const t = seedTimelineFromProduction(p, newId);

    expect(t.tracks.map((x) => `${x.kind}:${x.name}`)).toEqual(["video:V1", "audio:Voiceover", "audio:Music"]);
    const v = t.clips.filter((c) => c.trackId === t.tracks[0].id);
    expect(v.map((c) => [c.sourceKind, c.timelineStartSec, clipDurationSec(c)])).toEqual([
      ["video", 0, 4],
      ["still", 4, 2.5],
      ["blank", 6.5, 3],
      ["video", 9.5, 5],
      ["video", 14.5, 6],
    ]);
    // Slip and mute carried over; the disabled shot never appears.
    expect([v[0].sourceInSec, v[0].sourceOutSec, v[0].mediaId, v[0].shotId]).toEqual([1.5, 5.5, "m-clip0100", "s1"]);
    expect(v[3].muted).toBe(true);
    expect(t.clips.some((c) => c.shotId === "s7")).toBe(false);
    // The sequence collapses to one clip over its member shots.
    expect([v[4].sequenceId, v[4].memberShotIds, v[4].mediaId]).toEqual(["seq1", ["s5", "s6"], "m-seqtake"]);
    // VO + music beds become clips on their own tracks with their volumes.
    const vo = t.clips.find((c) => c.role === "voiceover")!;
    const mu = t.clips.find((c) => c.role === "music")!;
    expect([vo.volume, vo.mediaId, clipDurationSec(vo)]).toEqual([0.8, "m-vo", 20.5]);
    expect([mu.volume, mu.mediaId]).toEqual([0.4, "m-music"]);
    expect(validateTimeline(t)).toEqual([]);
  });

  it("emptyTimeline is a valid empty model", () => {
    expect(validateTimeline(emptyTimeline())).toEqual([]);
    expect(resolveTimeline(emptyTimeline()).totalSec).toBe(0);
  });
});

describe("assemblyPlanFromTimeline (pre-change fixture)", () => {
  it("produces a plan and EDL identical to the legacy shot-based plan", () => {
    n = 0;
    const p = loadFixture();
    const legacy = assemblyPlan(p);
    p.timeline = seedTimelineFromProduction(p, newId);
    const fromTimeline = assemblyPlanFromTimeline(p);
    // Identical to the legacy plan in every legacy-shaped field; the
    // one additive key is Item 9's generalized audioEvents, which for
    // a seeded production must mirror the two beds exactly.
    const { audioEvents, ...fromTimelineLegacyShape } = fromTimeline;
    expect(fromTimelineLegacyShape).toEqual(legacy);
    expect(audioEvents?.map((a) => [a.role, a.srcRel, a.volume, a.startSec])).toEqual([
      ["voiceover", legacy.voiceover!.srcRel, legacy.voiceover!.volume, 0],
      ["music", legacy.music!.srcRel, legacy.music!.volume, 0],
    ]);
    expect(buildEdl(fromTimeline, 24, p.meta.name)).toBe(buildEdl(legacy, 24, p.meta.name));
  });

  it("hiding the video track blanks the render plan; muting VO silences it", () => {
    n = 0;
    const p = loadFixture();
    let t = seedTimelineFromProduction(p, newId);
    const v = t.tracks.find((x) => x.kind === "video")!;
    const vo = t.tracks.find((x) => x.name === "Voiceover")!;
    t = {
      ...t,
      tracks: t.tracks.map((x) => (x.id === v.id ? { ...x, hidden: true } : x.id === vo.id ? { ...x, muted: true } : x)),
    };
    p.timeline = t;
    const plan = assemblyPlanFromTimeline(p);
    expect(plan.events.every((e) => e.kind === "blank")).toBe(true);
    expect(plan.totalSec).toBe(20.5);
    expect(plan.voiceover).toBeUndefined();
    expect(plan.music).toBeDefined();
  });

  it("refuses to plan without a timeline", () => {
    const p = loadFixture();
    expect(() => assemblyPlanFromTimeline(p)).toThrow(/timeline/);
  });
});
