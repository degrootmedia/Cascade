/**
 * FCPXML export tests — Animatic Editor Expansion Item A10.
 *
 * The exporter reads the timeline model directly (not the flattened
 * plan): bottom video track = spine, others as lanes, audio as
 * negative lanes; constant speeds and ramps as timeMaps whose final
 * point lands EXACTLY on the clip's source range (the end-frame
 * spot-check); dissolves as transition elements; every degradation
 * lands in the export report — silent loss is a bug.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production, ProductionTimeline } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { buildFcpxml } from "../src/main/fcpxml.js";

const parse = (xml: string): Document => {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
};
const rat = (s: string | null): number => {
  if (!s) return NaN;
  const m = /^(-?\d+)\/(\d+)s$/.exec(s);
  if (m) return Number(m[1]) / Number(m[2]);
  const plain = /^(-?[\d.]+)s$/.exec(s);
  return plain ? Number(plain[1]) : NaN;
};

const timeline: ProductionTimeline = {
  version: 1,
  tracks: [
    { id: "v2", kind: "video", name: "V2" },
    { id: "v1", kind: "video", name: "V1" },
    { id: "a1", kind: "audio", name: "VO" },
  ],
  clips: [
    { id: "top", trackId: "v2", sourceKind: "video", srcRel: "clips/top.mp4", sourceInSec: 0, sourceOutSec: 2, timelineStartSec: 1 },
    { id: "fast", trackId: "v1", sourceKind: "video", srcRel: "clips/fast.mp4", sourceInSec: 1, sourceOutSec: 9, timelineStartSec: 0, speed: 2 },
    { id: "ramp", trackId: "v1", sourceKind: "video", srcRel: "clips/ramp.mp4", sourceInSec: 0, sourceOutSec: 6, timelineStartSec: 4, speedCurve: [{ atSec: 0, speed: 2 }, { atSec: 2, speed: 2 }, { atSec: 6, speed: 0.5 }] },
    { id: "vo", trackId: "a1", sourceKind: "audio", srcRel: "vo.mp3", sourceInSec: 0, sourceOutSec: 7, timelineStartSec: 0, role: "voiceover", volume: 0.5, fadeOutSec: 1 },
  ],
  transitions: [
    { id: "d1", type: "dissolve", outgoingClipId: "fast", incomingClipId: "ramp", durationSec: 1 },
  ],
};

const prod = (): Production =>
  ({
    meta: { id: "px", name: "FCPXML Test", folder: "/tmp/prod", createdAt: "", updatedAt: "", stepDone: 5, shotCount: 0 },
    currentStep: 5, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
    timeline,
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
  }) as unknown as Production;

describe("buildFcpxml", () => {
  it("emits well-formed FCPXML 1.x with format + asset resources", () => {
    const { xml } = buildFcpxml(prod(), { fps: 24, width: 1920, height: 1080 });
    const doc = parse(xml);
    expect(doc.querySelector("fcpxml")?.getAttribute("version")).toMatch(/^1\./);
    const format = doc.querySelector("resources > format");
    expect(format?.getAttribute("frameDuration")).toBe("100/2400s");
    expect(format?.getAttribute("width")).toBe("1920");
    const assets = [...doc.querySelectorAll("resources > asset")];
    const srcs = assets.map((a) => a.getAttribute("src") ?? "");
    expect(srcs.some((s) => s.startsWith("file:") && s.endsWith("clips/fast.mp4"))).toBe(true);
  });

  it("bottom video track is the spine; upper video and audio are lanes", () => {
    const { xml } = buildFcpxml(prod(), { fps: 24, width: 1920, height: 1080 });
    const doc = parse(xml);
    const spine = [...doc.querySelectorAll("sequence > spine > *")];
    const spineClips = spine.filter((e) => e.tagName === "asset-clip");
    expect(spineClips.map((c) => c.getAttribute("name"))).toEqual(["fast.mp4", "ramp.mp4"]);
    const all = [...doc.querySelectorAll("asset-clip")];
    const top = all.find((c) => c.getAttribute("name") === "top.mp4")!;
    expect(top.getAttribute("lane")).toBe("1");
    expect(rat(top.getAttribute("offset"))).toBeCloseTo(1, 6);
    const vo = all.find((c) => c.getAttribute("name") === "vo.mp3")!;
    expect(vo.getAttribute("lane")).toBe("-1");
  });

  it("constant speed and ramps become timeMaps ending exactly on the source range", () => {
    const { xml } = buildFcpxml(prod(), { fps: 24, width: 1920, height: 1080 });
    const doc = parse(xml);
    const all = [...doc.querySelectorAll("asset-clip")];
    const fast = all.find((c) => c.getAttribute("name") === "fast.mp4")!;
    expect(rat(fast.getAttribute("duration"))).toBeCloseTo(4, 6); // 8s range at 2x
    expect(rat(fast.getAttribute("start"))).toBeCloseTo(1, 6);
    const fastPts = [...fast.querySelectorAll("timeMap > timept")];
    expect(fastPts.length).toBeGreaterThanOrEqual(2);
    expect(rat(fastPts[fastPts.length - 1].getAttribute("value"))).toBeCloseTo(8, 3);
    expect(rat(fastPts[fastPts.length - 1].getAttribute("time"))).toBeCloseTo(4, 3);

    const ramp = all.find((c) => c.getAttribute("name") === "ramp.mp4")!;
    const rampPts = [...ramp.querySelectorAll("timeMap > timept")];
    // The acceptance spot-check: the ramp's last timept lands on the
    // exact source range (6s) at the exact clip duration.
    const last = rampPts[rampPts.length - 1];
    expect(rat(last.getAttribute("value"))).toBeCloseTo(6, 3);
    expect(rat(last.getAttribute("time"))).toBeCloseTo(rat(ramp.getAttribute("duration")), 3);
    // Monotonic, and denser than a single straight line.
    const values = rampPts.map((p) => rat(p.getAttribute("value")));
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(rampPts.length).toBeGreaterThan(2);
  });

  it("dissolves ride the spine as transition elements; audio carries level + fades", () => {
    const { xml, report } = buildFcpxml(prod(), { fps: 24, width: 1920, height: 1080 });
    const doc = parse(xml);
    const tr = doc.querySelector("sequence > spine > transition");
    expect(tr).not.toBeNull();
    expect(tr!.getAttribute("name")).toMatch(/dissolve/i);
    expect(rat(tr!.getAttribute("duration"))).toBeCloseTo(1, 6);
    const vo = [...doc.querySelectorAll("asset-clip")].find((c) => c.getAttribute("name") === "vo.mp3")!;
    const vol = vo.querySelector("adjust-volume");
    expect(vol).not.toBeNull();
    expect(vol!.getAttribute("amount")).toMatch(/^-6(\.\d)?dB$/); // 0.5 → ≈ -6 dB
    expect(vo.querySelector("fadeOut")).not.toBeNull();
    expect(report.join("\n")).toMatch(/ramp/i); // sampled timeMap stated
  });

  it("degradations are reported, never silent: natural pitch, off-spine dissolve, links", () => {
    const t2: ProductionTimeline = {
      version: 1,
      tracks: [
        { id: "v2", kind: "video", name: "V2" },
        { id: "v1", kind: "video", name: "V1" },
      ],
      clips: [
        { id: "x", trackId: "v2", sourceKind: "video", srcRel: "x.mp4", sourceInSec: 1, sourceOutSec: 5, timelineStartSec: 0 },
        { id: "y", trackId: "v2", sourceKind: "video", srcRel: "y.mp4", sourceInSec: 1, sourceOutSec: 5, timelineStartSec: 4, speed: 2, pitchMode: "natural", linkId: "L" },
        { id: "z", trackId: "v1", sourceKind: "video", srcRel: "z.mp4", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0, linkId: "L" },
      ],
      transitions: [{ id: "d", type: "dissolve", outgoingClipId: "x", incomingClipId: "y", durationSec: 1 }],
    };
    const { xml, report } = buildFcpxml({ ...prod(), timeline: t2 }, { fps: 24, width: 1920, height: 1080 });
    const text = report.join("\n");
    expect(text).toMatch(/pitch/i);
    expect(text).toMatch(/dissolve/i);
    expect(text).toMatch(/link/i);
    // The off-spine dissolve is dropped from the XML and says so.
    expect(parse(xml).querySelector("transition")).toBeNull();
  });
});
