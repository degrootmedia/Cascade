/**
 * Premiere XML (xmeml v5) export tests — Animatic Editor Expansion
 * Item A11. Frame-based dialect: tracks in stacking order (V1 =
 * bottom), clipitems with record/source frame ranges, constant speed
 * as a time-remap filter, ramps as a STATED average-speed
 * simplification (duration + end frame still exact), dissolves as
 * transitionitems, audio levels with fade keyframes. Degradations
 * are reported, never silent.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production, ProductionTimeline } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { buildPremiereXml } from "../src/main/premiere-xml.js";

const parse = (xml: string): Document => {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
};
const num = (el: Element, tag: string): number => Number(el.querySelector(`:scope > ${tag}`)?.textContent);

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
    { id: "ramp", trackId: "v1", sourceKind: "video", srcRel: "ramp.mp4", sourceInSec: 0, sourceOutSec: 6, timelineStartSec: 4, speedCurve: [{ atSec: 0, speed: 2 }, { atSec: 2, speed: 2 }, { atSec: 6, speed: 0.5 }] },
    { id: "vo", trackId: "a1", sourceKind: "audio", srcRel: "vo.mp3", sourceInSec: 0, sourceOutSec: 7, timelineStartSec: 0, role: "voiceover", volume: 0.5, fadeOutSec: 1 },
  ],
  transitions: [{ id: "d1", type: "dissolve", outgoingClipId: "fast", incomingClipId: "ramp", durationSec: 1 }],
};

const prod = (): Production =>
  ({
    meta: { id: "px", name: "Premiere Test", folder: "/tmp/prod", createdAt: "", updatedAt: "", stepDone: 5, shotCount: 0 },
    currentStep: 5, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
    timeline,
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
  }) as unknown as Production;

const clipByName = (doc: Document, name: string): Element =>
  [...doc.querySelectorAll("clipitem")].find((c) => c.querySelector(":scope > name")?.textContent === name)!;

describe("buildPremiereXml", () => {
  it("emits well-formed xmeml with frame-based sequence + track order (V1 bottom)", () => {
    const { xml } = buildPremiereXml(prod(), { fps: 24, width: 1920, height: 1080 });
    const doc = parse(xml);
    expect(doc.querySelector("xmeml")?.getAttribute("version")).toBe("5");
    const vtracks = [...doc.querySelectorAll("media > video > track")];
    expect(vtracks).toHaveLength(2);
    // First video track = bottom (V1: fast + ramp); second = top clip.
    expect([...vtracks[0].querySelectorAll("clipitem > name")].map((n) => n.textContent)).toEqual(["fast.mp4", "ramp.mp4"]);
    expect([...vtracks[1].querySelectorAll("clipitem > name")].map((n) => n.textContent)).toEqual(["top.mp4"]);
    const top = clipByName(doc, "top.mp4");
    expect(num(top, "start")).toBe(24);
    expect(num(top, "end")).toBe(72);
  });

  it("constant speed becomes a time-remap filter; ranges in frames", () => {
    const { xml } = buildPremiereXml(prod(), { fps: 24, width: 1920, height: 1080 });
    const doc = parse(xml);
    const fast = clipByName(doc, "fast.mp4");
    expect(num(fast, "start")).toBe(0);
    expect(num(fast, "end")).toBe(96); // 4s of timeline
    expect(num(fast, "in")).toBe(24); // 1s source in
    expect(num(fast, "out")).toBe(216); // 9s source out
    const speed = [...fast.querySelectorAll("filter parameter")].find(
      (p) => p.querySelector("parameterid")?.textContent === "speed"
    );
    expect(speed).toBeDefined();
    expect(Number(speed!.querySelector("value")?.textContent)).toBe(200);
    const file = fast.querySelector("file");
    expect(file?.querySelector("pathurl")?.textContent).toMatch(/^file:/);
    expect(file?.querySelector("pathurl")?.textContent).toContain("fast.mp4");
  });

  it("ramps export at average speed (exact duration and source out) with a report line", () => {
    const { xml, report } = buildPremiereXml(prod(), { fps: 24, width: 1920, height: 1080 });
    const doc = parse(xml);
    const ramp = clipByName(doc, "ramp.mp4");
    // Duration from the shared integral: 6 source sec under 2x->0.5x
    // (2s at 2x consumes 4; the rest solves 2t-0.1875t^2=2) ≈ 3.117s.
    expect(Math.abs((num(ramp, "end") - num(ramp, "start")) / 24 - 3.11696312)).toBeLessThan(0.05);
    expect(num(ramp, "out") - num(ramp, "in")).toBe(144); // full 6s range consumed
    expect(report.join("\n")).toMatch(/average/i);
  });

  it("dissolve becomes a centered transitionitem; audio level + fade keyframes present", () => {
    const { xml } = buildPremiereXml(prod(), { fps: 24, width: 1920, height: 1080 });
    const doc = parse(xml);
    const tr = doc.querySelector("transitionitem");
    expect(tr).not.toBeNull();
    expect(num(tr!, "start")).toBe(96 - 12); // centered on frame 96
    expect(num(tr!, "end")).toBe(96 + 12);
    expect(tr!.querySelector("alignment")?.textContent).toBe("center");
    expect(tr!.querySelector("effect effectid")?.textContent).toMatch(/dissolve/i);
    const vo = clipByName(doc, "vo.mp3");
    const kfs = [...vo.querySelectorAll("filter parameter keyframe")];
    expect(kfs.length).toBeGreaterThanOrEqual(2);
    const last = kfs[kfs.length - 1];
    expect(Number(last.querySelector("value")?.textContent)).toBeLessThanOrEqual(-60); // faded to silence
  });

  it("reverse + natural pitch are stated in the report", () => {
    const t2: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        { id: "r", trackId: "v1", sourceKind: "video", srcRel: "r.mp4", sourceInSec: 0, sourceOutSec: 4, timelineStartSec: 0, reversed: true, pitchMode: "natural" },
      ],
    };
    const { xml, report } = buildPremiereXml({ ...prod(), timeline: t2 }, { fps: 24, width: 1920, height: 1080 });
    const doc = parse(xml);
    const speed = [...doc.querySelectorAll("filter parameter")].find(
      (p) => p.querySelector("parameterid")?.textContent === "speed"
    );
    expect(Number(speed!.querySelector("value")?.textContent)).toBe(-100);
    expect(report.join("\n")).toMatch(/pitch/i);
  });
});
