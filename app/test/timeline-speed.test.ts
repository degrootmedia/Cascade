/**
 * Constant-speed + reverse tests — Animatic Editor Expansion Item A4.
 *
 * Duration is derived (source range / speed) by the shared timing code;
 * every A2 op must stay correct on sped clips (timeline deltas convert
 * through speed at the source boundary); setClipSpeed clamps or ripples;
 * the assembly plan carries speed/reverse to the render and states it in
 * the EDL/manifest instead of dropping it silently.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production, ProductionTimeline, TimelineClip, TimelineTrack } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  clipDurationSec,
  clipEndSec,
  clipSourceTimeAt,
  clipSourceWindowAt,
  clipSpeed,
  normalizeTimeline,
  rollEdit,
  setClipSpeed,
  slipClip,
  splitClipAt,
  trimClip,
  validateTimeline,
} from "../src/shared/ipc.js";
import { assemblyPlanFromTimeline, buildEdl, buildManifest, buildNormalizeArgs } from "../src/main/assembly.js";

let n = 0;
const newId = (prefix: string): string => `${prefix}-${++n}`;

function vTrack(id: string): TimelineTrack {
  return { id, kind: "video", name: id.toUpperCase() };
}
function vClip(id: string, startSec: number, inSec: number, outSec: number, over: Partial<TimelineClip> = {}): TimelineClip {
  return { id, trackId: "v1", sourceKind: "video", srcRel: `clips/${id}.mp4`, sourceInSec: inSec, sourceOutSec: outSec, timelineStartSec: startSec, ...over };
}
/** V1: a[0..] 10s source range at 1x unless sped; b after it (placed by test). */
function base(aOver: Partial<TimelineClip> = {}): ProductionTimeline {
  const a = vClip("a", 0, 0, 10, aOver);
  const b = vClip("b", clipEndSec(a), 0, 4);
  return { version: 1, tracks: [vTrack("v1")], clips: [a, b] };
}
const byId = (t: ProductionTimeline, id: string): TimelineClip => t.clips.find((c) => c.id === id)!;
const valid = (t: ProductionTimeline | null): ProductionTimeline => {
  expect(t).not.toBeNull();
  expect(validateTimeline(t!)).toEqual([]);
  return t!;
};
const SRC = { "clips/a.mp4": 20, "clips/b.mp4": 20 };

describe("derived duration under speed", () => {
  it("a 10s source range at 0.5x occupies 20s; at 2x, 5s", () => {
    expect(clipDurationSec(vClip("x", 0, 0, 10, { speed: 0.5 }))).toBe(20);
    expect(clipDurationSec(vClip("x", 0, 0, 10, { speed: 2 }))).toBe(5);
    expect(clipDurationSec(vClip("x", 0, 0, 10))).toBe(10);
    expect(clipSpeed(vClip("x", 0, 0, 10))).toBe(1);
    // Reverse does not change duration.
    expect(clipDurationSec(vClip("x", 0, 0, 10, { speed: 2, reversed: true }))).toBe(5);
  });

  it("maps timeline-local time to source time (and back for reverse)", () => {
    const fwd = vClip("x", 0, 2, 12, { speed: 2 });
    expect(clipSourceTimeAt(fwd, 0)).toBe(2);
    expect(clipSourceTimeAt(fwd, 2.5)).toBe(7);
    expect(clipSourceTimeAt(fwd, 5)).toBe(12);
    const rev = vClip("x", 0, 2, 12, { speed: 2, reversed: true });
    expect(clipSourceTimeAt(rev, 0)).toBe(12);
    expect(clipSourceTimeAt(rev, 5)).toBe(2);
    // The source window a render span needs:
    expect(clipSourceWindowAt(fwd, 1, 2)).toEqual({ startSec: 4, endSec: 8 });
    expect(clipSourceWindowAt(rev, 1, 2)).toEqual({ startSec: 6, endSec: 10 });
  });

  it("normalize strips unusable speeds and speed on stills", () => {
    const t = normalizeTimeline({
      version: 1,
      tracks: [vTrack("v1")],
      clips: [
        vClip("a", 0, 0, 4, { speed: -2 }),
        { id: "s", trackId: "v1", sourceKind: "still", srcRel: "s.jpg", holdSec: 3, timelineStartSec: 5, speed: 2, reversed: true },
        vClip("b", 9, 0, 4, { speed: 1 }),
      ],
    })!;
    expect(byId(t, "a").speed).toBeUndefined();
    expect(byId(t, "s").speed).toBeUndefined();
    expect(byId(t, "s").reversed).toBeUndefined();
    expect(byId(t, "b").speed).toBeUndefined(); // 1x is stored sparse
  });
});

describe("setClipSpeed", () => {
  it("sets speed and derives the new duration; 1x clears the field", () => {
    const t = valid(setClipSpeed(base(), ["a"], { speed: 2 }));
    expect(byId(t, "a").speed).toBe(2);
    expect(clipDurationSec(byId(t, "a"))).toBe(5);
    const back = valid(setClipSpeed(t, ["a"], { speed: 1 }));
    expect(byId(back, "a").speed).toBeUndefined();
    expect(clipDurationSec(byId(back, "a"))).toBe(10);
  });

  it("without ripple, slowing down clamps at the next clip", () => {
    // b starts right after a (at 10): a cannot grow at all.
    const t = valid(setClipSpeed(base(), ["a"], { speed: 0.5 }));
    expect(clipDurationSec(byId(t, "a"))).toBe(10); // clamped: no room
    // Speeding up is always free (a gap opens).
    const fast = valid(setClipSpeed(base(), ["a"], { speed: 2 }));
    expect(clipDurationSec(byId(fast, "a"))).toBe(5);
    expect(byId(fast, "b").timelineStartSec).toBe(10);
  });

  it("with ripple, the suffix shifts by the duration change", () => {
    const t = valid(setClipSpeed(base(), ["a"], { speed: 0.5 }, { ripple: "all" }));
    expect(clipDurationSec(byId(t, "a"))).toBe(20);
    expect(byId(t, "b").timelineStartSec).toBe(20);
    const fast = valid(setClipSpeed(base(), ["a"], { speed: 2 }, { ripple: "all" }));
    expect(byId(fast, "b").timelineStartSec).toBe(5);
  });

  it("refuses locked tracks and inapplicable targets", () => {
    const locked = base();
    locked.tracks[0].locked = true;
    expect(setClipSpeed(locked, ["a"], { speed: 2 })).toBeNull();
    expect(setClipSpeed(base(), ["a"], { speed: 0 })).toBeNull();
    expect(setClipSpeed(base(), ["a"], { speed: Number.NaN })).toBeNull();
    const stillOnly: ProductionTimeline = {
      version: 1, tracks: [vTrack("v1")],
      clips: [{ id: "s", trackId: "v1", sourceKind: "still", srcRel: "s.jpg", holdSec: 3, timelineStartSec: 0 }],
    };
    expect(setClipSpeed(stillOnly, ["s"], { speed: 2 })).toBeNull();
  });
});

describe("A2 ops stay correct on sped clips", () => {
  it("split of a 2x clip cuts the source at twice the timeline offset", () => {
    n = 0;
    const t = valid(splitClipAt(base({ speed: 2 }), "a", 2, newId));
    const left = byId(t, "a");
    const right = t.clips.find((c) => c.timelineStartSec === 2 && c.trackId === "v1")!;
    expect([left.sourceInSec, left.sourceOutSec]).toEqual([0, 4]);
    expect([right.sourceInSec, right.sourceOutSec]).toEqual([4, 10]);
    expect(clipDurationSec(left) + clipDurationSec(right)).toBe(5);
  });

  it("split of a reversed clip gives each half its own sub-range, both reversed", () => {
    n = 0;
    const t = valid(splitClipAt(base({ reversed: true }), "a", 4, newId));
    const left = byId(t, "a");
    const right = t.clips.find((c) => c.timelineStartSec === 4 && c.trackId === "v1")!;
    // Plays 10→0 backwards: first 4 timeline seconds show source 10→6.
    expect([left.sourceInSec, left.sourceOutSec, left.reversed]).toEqual([6, 10, true]);
    expect([right.sourceInSec, right.sourceOutSec, right.reversed]).toEqual([0, 6, true]);
  });

  it("trim converts timeline deltas through speed at the source boundary", () => {
    // 2x clip, tail +1 timeline second = +2 source seconds (source is 20s).
    const t0 = base({ speed: 2 }); // a occupies 0..5, b at 5
    const t = valid(trimClip(t0, "a", "tail", 1, { ripple: "all", sourceDurationsSec: SRC }));
    expect(byId(t, "a").sourceOutSec).toBe(12);
    expect(clipDurationSec(byId(t, "a"))).toBe(6);
    expect(byId(t, "b").timelineStartSec).toBe(6);
    // Source-end clamp is also in timeline terms: at most (20-10)/2 = +5.
    const t2 = valid(trimClip(t0, "a", "tail", 100, { ripple: "all", sourceDurationsSec: SRC }));
    expect(byId(t2, "a").sourceOutSec).toBe(20);
  });

  it("slip and roll keep their invariants at speed", () => {
    const t0 = base({ speed: 2 });
    const slipped = valid(slipClip(t0, "a", 2, { sourceDurationsSec: SRC }));
    expect([byId(slipped, "a").sourceInSec, clipDurationSec(byId(slipped, "a"))]).toEqual([2, 5]);
    const rolled = valid(rollEdit(t0, "a", 1, { sourceDurationsSec: SRC }));
    // Total timeline duration conserved; a grew 1 timeline second = 2 source.
    expect(clipDurationSec(byId(rolled, "a")) + clipDurationSec(byId(rolled, "b"))).toBe(9);
    expect(byId(rolled, "a").sourceOutSec).toBe(12);
  });
});

describe("assembly carriage", () => {
  function prodWith(t: ProductionTimeline): Production {
    return {
      meta: { id: "p1", name: "Speed", folder: "/tmp/p1", createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
      currentStep: 5, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
      timeline: t,
      assembly: { fps: 24, width: 640, height: 360, exportDir: "out/assembly" },
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    } as Production;
  }

  it("plan events carry speed/reversed and timeline durations", () => {
    const plan = assemblyPlanFromTimeline(prodWith(base({ speed: 0.5, reversed: true })));
    const ev = plan.events[0];
    expect(ev.durationSec).toBe(20);
    expect(ev.speed).toBe(0.5);
    expect(ev.reversed).toBe(true);
    expect(plan.totalSec).toBe(24);
    // Unsped events stay sparse (the A1 equality guarantee).
    expect(plan.events[1].speed).toBeUndefined();
    expect(plan.events[1].reversed).toBeUndefined();
  });

  it("EDL and manifest state the speed instead of dropping it", () => {
    const plan = assemblyPlanFromTimeline(prodWith(base({ speed: 0.5, reversed: true })));
    const edl = buildEdl(plan, 24, "Speed");
    expect(edl).toMatch(/speed 0\.50x/);
    expect(edl).toMatch(/reversed/);
    const manifest = buildManifest(plan, { fps: 24, width: 640, height: 360 }, { title: "Speed", builtAt: "", edlName: "Assembly.edl", jsxName: "Assembly.jsx" });
    expect(manifest).toMatch(/0\.5x/);
    expect(manifest).toMatch(/reversed/);
  });

  it("normalize args apply setpts/reverse only when sped", () => {
    const cfg = { fps: 24, width: 640, height: 360 };
    const plain = buildNormalizeArgs({ kind: "clip", durationSec: 2, muted: false, hasAudio: true }, cfg, "in.mp4", "out.mov");
    expect(plain.join(" ")).not.toMatch(/setpts|reverse|atempo/);
    const sped = buildNormalizeArgs({ kind: "clip", durationSec: 4, muted: false, hasAudio: true, speed: 0.5, probedSec: 10, offsetSec: 0 }, cfg, "in.mp4", "out.mov");
    expect(sped.join(" ")).toMatch(/setpts=PTS\/0\.5/);
    expect(sped.join(" ")).toMatch(/atempo=0\.5/);
    const rev = buildNormalizeArgs({ kind: "clip", durationSec: 2, muted: false, hasAudio: true, reversed: true, offsetSec: 3 }, cfg, "in.mp4", "out.mov");
    const joined = rev.join(" ");
    expect(joined).toMatch(/reverse/);
    expect(joined).toMatch(/areverse/);
    // The source window is bounded before reversing: -ss 3 then input -t 2.
    expect(rev.slice(0, rev.indexOf("-i") + 2).join(" ")).toMatch(/-ss 3\.000 -t 2\.000 -i/);
  });
});
