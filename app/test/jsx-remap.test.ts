/**
 * After Effects JSX native time remapping — Item A13. Ramped events
 * emit real ADBE Time Remapping keyframes sampled from the curve
 * integral (end keyframe value == the source-out time); constant
 * speeds keep the existing stretch-comment behavior.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production, ProductionTimeline } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { assemblyPlanForProduction, buildAeScript } from "../src/main/assembly.js";

const cfg = { fps: 24, width: 320, height: 180 };
const prod = (timeline: ProductionTimeline): Production =>
  ({
    meta: { id: "px", name: "JSX", folder: "/tmp/prod", createdAt: "", updatedAt: "", stepDone: 5, shotCount: 0 },
    currentStep: 5, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
    timeline,
    assembly: { fps: 24, width: 320, height: 180, exportDir: "out/assembly" },
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
  }) as unknown as Production;

const jsxOf = (timeline: ProductionTimeline): string =>
  buildAeScript(assemblyPlanForProduction(prod(timeline)), cfg, "/tmp/prod/out/assembly");

const remapKeysOf = (jsx: string, lay: string): [number, number][] =>
  [...jsx.matchAll(new RegExp(`tr_${lay}\\.setValueAtTime\\(([^,]+), ([^)]+)\\)`, "g"))].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);

describe("buildAeScript time remapping (A13)", () => {
  it("ramped clip gets native remap keyframes ending at the source-out", () => {
    const timeline: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        {
          id: "r", trackId: "v1", sourceKind: "video", srcRel: "ramp.mp4",
          sourceInSec: 1, sourceOutSec: 7, timelineStartSec: 0,
          speedCurve: [{ atSec: 0, speed: 2 }, { atSec: 2, speed: 2 }, { atSec: 6, speed: 0.5 }],
        },
      ],
    };
    const jsx = jsxOf(timeline);
    expect(jsx).toContain("lay0.timeRemapEnabled = true;");
    expect(jsx).toContain('property("ADBE Time Remapping")');
    const keys = remapKeysOf(jsx, "lay0");
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(keys[0]).toEqual([0, 1]); // comp 0 -> source in (1s)
    const last = keys[keys.length - 1];
    expect(last[1]).toBe(7); // ends exactly on source-out
    // No stretch comment, no source-offset inPoint (baked into values).
    expect(jsx).not.toContain("apply Time Stretch");
    expect(jsx).not.toContain("lay0.inPoint");
  });

  it("constant speed keeps the previous stretch comment; 1x stays plain", () => {
    const timeline: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        { id: "f", trackId: "v1", sourceKind: "video", srcRel: "f.mp4", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0, speed: 2 },
        { id: "n", trackId: "v1", sourceKind: "video", srcRel: "n.mp4", sourceInSec: 0, sourceOutSec: 4, timelineStartSec: 4 },
      ],
    };
    const jsx = jsxOf(timeline);
    expect(jsx).toContain("apply Time Stretch 50%");
    expect(jsx).not.toContain("timeRemapEnabled");
  });

  it("reversed ramp values descend from out to in", () => {
    const timeline: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        {
          id: "r", trackId: "v1", sourceKind: "video", srcRel: "r.mp4",
          sourceInSec: 1, sourceOutSec: 7, timelineStartSec: 0, reversed: true,
          speedCurve: [{ atSec: 0, speed: 2 }, { atSec: 2, speed: 2 }, { atSec: 6, speed: 0.5 }],
        },
      ],
    };
    const jsx = jsxOf(timeline);
    const keys = remapKeysOf(jsx, "lay0");
    expect(keys[0][1]).toBe(7);
    expect(keys[keys.length - 1][1]).toBe(1);
    const values = keys.map((k) => k[1]);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });
});
