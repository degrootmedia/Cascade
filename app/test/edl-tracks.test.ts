/**
 * Per-track EDL + ramp baking tests — Animatic Editor Expansion
 * Item A12. One CMX3600 EDL per video track (V1 = bottom), M2 lines
 * for constant speeds, ramps baked into keyframe-split segments at
 * segment-average speeds with total duration preserved.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production, ProductionTimeline } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { clipDurationSec } from "../src/shared/ipc.js";
import { buildTrackEdls, m2Speed } from "../src/main/assembly.js";

const tcToFrames = (tc: string, fps = 24): number => {
  const [h, m, s, f] = tc.split(":").map(Number);
  return ((h * 60 + m) * 60 + s) * fps + f;
};
const eventsOf = (content: string): string[][] =>
  content.split("\r\n").filter((l) => /^\d{3}\s/.test(l)).map((l) => l.trim().split(/\s+/));

const rampClip = {
  id: "ramp", trackId: "v1", sourceKind: "video" as const, srcRel: "ramp.mp4",
  sourceInSec: 0, sourceOutSec: 6, timelineStartSec: 4,
  speedCurve: [{ atSec: 0, speed: 2 }, { atSec: 2, speed: 2 }, { atSec: 6, speed: 0.5 }],
};

const timeline: ProductionTimeline = {
  version: 1,
  tracks: [
    { id: "v2", kind: "video", name: "V2" },
    { id: "v1", kind: "video", name: "V1" },
    { id: "a1", kind: "audio", name: "VO" },
  ],
  clips: [
    { id: "top", trackId: "v2", sourceKind: "video", srcRel: "top.mp4", sourceInSec: 0, sourceOutSec: 2, timelineStartSec: 1 },
    { id: "fast", trackId: "v1", sourceKind: "video", srcRel: "fast.mp4", sourceInSec: 1, sourceOutSec: 9, timelineStartSec: 0, speed: 2 },
    rampClip,
  ],
  transitions: [{ id: "d1", type: "dissolve", outgoingClipId: "fast", incomingClipId: "ramp", durationSec: 1 }],
};

const prod = (): Production =>
  ({
    meta: { id: "px", name: "EDL Test", folder: "/tmp/prod", createdAt: "", updatedAt: "", stepDone: 5, shotCount: 0 },
    currentStep: 5, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
    timeline,
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
  }) as unknown as Production;

describe("buildTrackEdls", () => {
  it("m2Speed formats signed fps", () => {
    expect(m2Speed(2, false, 24)).toBe("048.0");
    expect(m2Speed(0.5, false, 24)).toBe("012.0");
    expect(m2Speed(1, true, 24)).toBe("-024.0");
  });

  it("one EDL per video track (V1 bottom) with full-timeline record ranges", () => {
    const { files } = buildTrackEdls(prod(), 24);
    expect(files.map((f) => f.name)).toEqual(["Assembly-V1.edl", "Assembly-V2.edl"]);
    const total = 4 + clipDurationSec(rampClip);
    for (const f of files) {
      const evs = eventsOf(f.content);
      const last = evs[evs.length - 1];
      expect(tcToFrames(last[last.length - 1])).toBe(Math.round(total * 24));
      // Record ranges are contiguous from 0.
      let cursor = 0;
      for (const e of evs) {
        expect(tcToFrames(e[e.length - 2])).toBe(cursor);
        cursor = tcToFrames(e[e.length - 1]);
      }
    }
  });

  it("the ramp bakes into keyframe segments: contiguous source, exact duration", () => {
    const { files, report } = buildTrackEdls(prod(), 24);
    const v1 = files[0].content;
    const segLines = v1.split("\r\n").filter((l) => l.includes("speed-ramp segment"));
    expect(segLines.length).toBe(2); // keyframes at 0, 2 (+end): 2 segments
    const rampEvents = eventsOf(v1).filter((e) => tcToFrames(e[e.length - 2]) >= 96);
    // Source ranges contiguous 0 -> 144 frames (6s) across segments.
    let srcCursor = 0;
    let recTotal = 0;
    for (const e of rampEvents) {
      const srcIn = tcToFrames(e[e.length - 4]);
      const srcOut = tcToFrames(e[e.length - 3]);
      expect(srcIn).toBe(srcCursor);
      srcCursor = srcOut;
      recTotal += tcToFrames(e[e.length - 1]) - tcToFrames(e[e.length - 2]);
    }
    expect(srcCursor).toBe(144);
    expect(Math.abs(recTotal - Math.round(clipDurationSec(rampClip) * 24))).toBeLessThanOrEqual(1);
    expect(v1).toContain("M2");
    expect(report.join("\n")).toMatch(/baked/i);
    expect(report.join("\n")).toMatch(/preserved/i);
  });

  it("constant speed gets one M2; the dissolve is a D on the incoming event", () => {
    const { files } = buildTrackEdls(prod(), 24);
    const v1 = files[0].content;
    expect(v1).toMatch(/M2\s+\S+\s+048\.0/);
    const lines = v1.split("\r\n");
    const dLine = lines.find((l) => /^\d{3}\s/.test(l) && /\sD\s+024\s/.test(l));
    expect(dLine).toBeDefined();
  });

  it("reverse exports descending source TCs with negative M2", () => {
    const t2: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        { id: "r", trackId: "v1", sourceKind: "video", srcRel: "r.mp4", sourceInSec: 1, sourceOutSec: 5, timelineStartSec: 0, reversed: true },
      ],
    };
    const { files } = buildTrackEdls({ ...prod(), timeline: t2 }, 24);
    const ev = eventsOf(files[0].content)[0];
    expect(tcToFrames(ev[ev.length - 4])).toBe(120); // starts at source 5s
    expect(tcToFrames(ev[ev.length - 3])).toBe(24); // ends at source 1s
    expect(files[0].content).toContain("-024.0");
  });
});
