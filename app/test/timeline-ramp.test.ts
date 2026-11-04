/**
 * Speed-ramp tests — Animatic Editor Expansion Item A5.
 *
 * Keyframes are anchored to the clip's TIMELINE position (adopted
 * judgment): speed(t) is piecewise-linear in timeline-local seconds,
 * duration is the closed-form integral solve ∫speed = source range,
 * and every reader (duration, source mapping, render expression,
 * exporters later) derives from the same functions.
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
  clipSpeedAt,
  normalizeTimeline,
  setClipSpeed,
  setClipSpeedCurve,
  slipClip,
  speedCurveForSpan,
  splitClipAt,
  trimClip,
  validateTimeline,
  type SpeedKeyframe,
} from "../src/shared/ipc.js";
import { assemblyPlanFromTimeline, buildNormalizeArgs } from "../src/main/assembly.js";

let n = 0;
const newId = (prefix: string): string => `${prefix}-${++n}`;
const vTrack = (id: string): TimelineTrack => ({ id, kind: "video", name: id.toUpperCase() });

/** The acceptance ramp: 1x → 0.25x → 2x at timeline 0 / 4 / 8.
 *  ∫0..4 = 2.5 source sec; ∫0..8 = 7. Range 7 → duration exactly 8. */
const RAMP: SpeedKeyframe[] = [
  { atSec: 0, speed: 1 },
  { atSec: 4, speed: 0.25 },
  { atSec: 8, speed: 2 },
];
function rampClip(over: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: "r", trackId: "v1", sourceKind: "video", srcRel: "clips/r.mp4",
    sourceInSec: 0, sourceOutSec: 7, timelineStartSec: 0, speedCurve: RAMP.map((k) => ({ ...k })),
    ...over,
  };
}
function base(clip: TimelineClip): ProductionTimeline {
  const b: TimelineClip = {
    id: "b", trackId: "v1", sourceKind: "video", srcRel: "clips/b.mp4",
    sourceInSec: 0, sourceOutSec: 4, timelineStartSec: clipEndSec(clip),
  };
  return { version: 1, tracks: [vTrack("v1")], clips: [clip, b] };
}
const byId = (t: ProductionTimeline, id: string): TimelineClip => t.clips.find((c) => c.id === id)!;
const valid = (t: ProductionTimeline | null): ProductionTimeline => {
  expect(t).not.toBeNull();
  expect(validateTimeline(t!)).toEqual([]);
  return t!;
};
const SRC = { "clips/r.mp4": 30, "clips/b.mp4": 20 };

describe("ramp integral timing", () => {
  it("duration is the integral solve; source mapping matches at points", () => {
    const c = rampClip();
    expect(clipDurationSec(c)).toBeCloseTo(8, 9);
    expect(clipSourceTimeAt(c, 0)).toBe(0);
    expect(clipSourceTimeAt(c, 2)).toBeCloseTo(1.625, 9); // avg(1, 0.625) * 2
    expect(clipSourceTimeAt(c, 4)).toBeCloseTo(2.5, 9);
    expect(clipSourceTimeAt(c, 8)).toBeCloseTo(7, 9);
    expect(clipSpeedAt(c, 2)).toBeCloseTo(0.625, 9);
    expect(clipSpeedAt(c, 6)).toBeCloseTo(1.125, 9);
    expect(clipSpeedAt(c, 99)).toBe(2); // last speed extrapolates
  });

  it("a range ending mid-segment solves inside the segment", () => {
    const c = rampClip({ sourceOutSec: 2.5 });
    expect(clipDurationSec(c)).toBeCloseTo(4, 9);
    const short = rampClip({ sourceOutSec: 1.625 });
    expect(clipDurationSec(short)).toBeCloseTo(2, 9);
  });

  it("reversed consumes the integral from the out-point", () => {
    const c = rampClip({ reversed: true });
    expect(clipDurationSec(c)).toBeCloseTo(8, 9);
    expect(clipSourceTimeAt(c, 0)).toBe(7);
    expect(clipSourceTimeAt(c, 4)).toBeCloseTo(4.5, 9);
    expect(clipSourceTimeAt(c, 8)).toBeCloseTo(0, 9);
  });

  it("speedCurveForSpan rebases and crops with boundary interpolation", () => {
    const span = speedCurveForSpan(rampClip(), 2, 4)!;
    // Local 2..6 of the clip: starts at speed(2)=0.625, keyframe at 4→2, ends speed(6)=1.125.
    expect(span[0]).toEqual({ atSec: 0, speed: 0.625 });
    expect(span[1]).toEqual({ atSec: 2, speed: 0.25 });
    expect(span[span.length - 1]).toEqual({ atSec: 4, speed: 1.125 });
    expect(speedCurveForSpan({ ...rampClip(), speedCurve: undefined }, 0, 4)).toBeUndefined();
  });

  it("normalize sorts, dedupes, and collapses a constant curve to speed", () => {
    const t = normalizeTimeline({
      version: 1,
      tracks: [vTrack("v1")],
      clips: [
        { ...rampClip(), speedCurve: [{ atSec: 4, speed: 2 }, { atSec: 0, speed: 2 }, { atSec: 4, speed: 3 }] },
        { ...rampClip(), id: "r2", timelineStartSec: 20, speedCurve: [{ atSec: 0, speed: 0.5 }] },
      ],
    })!;
    // First clip: speeds all differ after dedupe (last wins at t=4) — curve kept, sorted.
    expect(byId(t, "r").speedCurve).toEqual([{ atSec: 0, speed: 2 }, { atSec: 4, speed: 3 }]);
    // Second: constant curve collapses to the plain speed field.
    expect(byId(t, "r2").speedCurve).toBeUndefined();
    expect(byId(t, "r2").speed).toBe(0.5);
  });
});

describe("curve-aware ops", () => {
  it("split cuts the curve at the split point", () => {
    n = 0;
    const t = valid(splitClipAt(base(rampClip()), "r", 2, newId));
    const left = byId(t, "r");
    const right = t.clips.find((c) => c.timelineStartSec === 2 && c.id !== "b")!;
    expect(left.sourceOutSec).toBeCloseTo(1.625, 9);
    expect(left.speedCurve).toEqual([{ atSec: 0, speed: 1 }, { atSec: 2, speed: 0.625 }]);
    expect(right.sourceInSec).toBeCloseTo(1.625, 9);
    expect(right.speedCurve![0]).toEqual({ atSec: 0, speed: 0.625 });
    expect(right.speedCurve![1]).toEqual({ atSec: 2, speed: 0.25 });
    expect(clipDurationSec(left) + clipDurationSec(right)).toBeCloseTo(8, 9);
    // The mapping is seamless across the cut.
    expect(clipSourceTimeAt(right, 0)).toBeCloseTo(clipSourceTimeAt(rampClip(), 2), 9);
  });

  it("slip shifts the source window; the ramp shape is unchanged", () => {
    const t = valid(slipClip(base(rampClip()), "r", 3, { sourceDurationsSec: SRC }));
    const c = byId(t, "r");
    expect([c.sourceInSec, c.sourceOutSec]).toEqual([3, 10]);
    expect(c.speedCurve).toEqual(RAMP);
    expect(clipDurationSec(c)).toBeCloseTo(8, 9);
  });

  it("head trim crops and shifts keyframes with a boundary keyframe", () => {
    const t = valid(trimClip(base(rampClip()), "r", "head", -2, { sourceDurationsSec: SRC }));
    const c = byId(t, "r");
    expect(c.timelineStartSec).toBe(2);
    expect(c.sourceInSec).toBeCloseTo(1.625, 9);
    expect(c.speedCurve![0]).toEqual({ atSec: 0, speed: 0.625 });
    expect(c.speedCurve![1]).toEqual({ atSec: 2, speed: 0.25 });
    expect(clipDurationSec(c)).toBeCloseTo(6, 9);
    expect(clipEndSec(c)).toBeCloseTo(8, 9); // end anchored
  });

  it("tail trim extends through the curve's extrapolation", () => {
    const t = valid(trimClip(base(rampClip()), "r", "tail", 2, { ripple: "all", sourceDurationsSec: SRC }));
    const c = byId(t, "r");
    // Two more timeline seconds past the last keyframe run at 2x → +4 source.
    expect(c.sourceOutSec).toBeCloseTo(11, 9);
    expect(clipDurationSec(c)).toBeCloseTo(10, 9);
    expect(byId(t, "b").timelineStartSec).toBeCloseTo(10, 9);
  });

  it("setClipSpeedCurve applies, ripples, refuses without room, and clears", () => {
    const plain: TimelineClip = { id: "p", trackId: "v1", sourceKind: "video", srcRel: "clips/r.mp4", sourceInSec: 0, sourceOutSec: 7, timelineStartSec: 0 };
    const t0 = base(plain); // b right after p (at 7)
    // Ramp would stretch p to 8s > the 7s available: refused without ripple.
    expect(setClipSpeedCurve(t0, ["p"], RAMP)).toBeNull();
    const t = valid(setClipSpeedCurve(t0, ["p"], RAMP, { ripple: "all" }));
    expect(clipDurationSec(byId(t, "p"))).toBeCloseTo(8, 9);
    expect(byId(t, "b").timelineStartSec).toBeCloseTo(8, 9);
    // Clearing returns to constant timing (speed field as-is).
    const cleared = valid(setClipSpeedCurve(t, ["p"], null));
    expect(byId(cleared, "p").speedCurve).toBeUndefined();
    expect(clipDurationSec(byId(cleared, "p"))).toBe(7);
    // And a constant-speed set replaces a curve.
    const flat = valid(setClipSpeed(t, ["p"], { speed: 2 }));
    expect(byId(flat, "p").speedCurve).toBeUndefined();
    expect(byId(flat, "p").speed).toBe(2);
  });

  it("authoring fits the curve to the derived duration: a 100%->200% end ramp ends AT 2x (regression)", () => {
    // Regression: keyframes stayed at their authored atSec after the
    // duration shrank, so the end keyframe ended up beyond the clip —
    // invisible/ungrabbable in the editor, and its speed never reached.
    const plain: TimelineClip = { id: "p", trackId: "v1", sourceKind: "video", srcRel: "clips/r.mp4", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0 };
    const t0: ProductionTimeline = { version: 1, tracks: [vTrack("v1")], clips: [plain] };
    const t = valid(setClipSpeedCurve(t0, ["p"], [{ atSec: 0, speed: 1 }, { atSec: 8, speed: 2 }]));
    const c = byId(t, "p");
    const dur = clipDurationSec(c);
    // Progressively faster: shorter than the 8s source window, and the
    // fixed point of a 1->2 linear ramp spanning its own duration.
    expect(dur).toBeCloseTo(8 / 1.5, 3);
    const last = c.speedCurve![c.speedCurve!.length - 1];
    expect(Math.abs(last.atSec - dur)).toBeLessThan(0.01);
    expect(last.speed).toBe(2);
    // The clip ENDS at 200%, and the full source range is consumed.
    expect(clipSpeedAt(c, dur)).toBeCloseTo(2, 2);
    expect(clipSourceTimeAt(c, dur)).toBeCloseTo(8, 6);
    // Progressive: less than half the source is consumed by halfway.
    expect(clipSourceTimeAt(c, dur / 2)).toBeLessThan(4);
    expect(clipSpeedAt(c, 0)).toBeCloseTo(1, 9);
  });
});

describe("assembly carriage for ramps", () => {
  function prodWith(t: ProductionTimeline): Production {
    return {
      meta: { id: "p1", name: "Ramp", folder: "/tmp/p1", createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
      currentStep: 5, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
      timeline: t,
      assembly: { fps: 24, width: 640, height: 360, exportDir: "out/assembly" },
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    } as Production;
  }

  it("events carry the span curve and an average speed", () => {
    const plan = assemblyPlanFromTimeline(prodWith(base(rampClip())));
    const ev = plan.events[0];
    expect(ev.durationSec).toBeCloseTo(8, 9);
    expect(ev.speedCurve).toEqual(RAMP);
    expect(ev.speed).toBeCloseTo(7 / 8, 9); // average for notes/manifest
  });

  it("normalize args build a piecewise setpts expression from the curve", () => {
    const cfg = { fps: 24, width: 640, height: 360 };
    const args = buildNormalizeArgs(
      { kind: "clip", durationSec: 8, muted: false, hasAudio: true, speedCurve: RAMP, probedSec: 30 },
      cfg, "in.mp4", "out.mov"
    );
    const joined = args.join(" ");
    expect(joined).toMatch(/setpts='[^']*if\(lt\(/);
    expect(joined).toMatch(/sqrt\(/);
    // Audio follows at the average tempo (stated approximation).
    expect(joined).toMatch(/atempo=0\.875/);
    // Optical-flow option swaps the fps filter for minterpolate.
    const flow = buildNormalizeArgs(
      { kind: "clip", durationSec: 8, muted: false, hasAudio: true, speedCurve: RAMP, speedInterp: "flow", probedSec: 30 },
      cfg, "in.mp4", "out.mov"
    ).join(" ");
    expect(flow).toMatch(/minterpolate=fps=24:mi_mode=mci/);
  });
});
