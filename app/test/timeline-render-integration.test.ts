/**
 * Assembly/render integration tests — Animatic Editor Expansion Item A9.
 *
 * The shipping path renders the shared timeline model for EVERY
 * production (seeded in-memory when a legacy production has no
 * timeline yet — plan events identical to the legacy plan). All
 * audible audio clips mix (not just VO/music beds): position, trim,
 * speed/pitch, gain and fades ride plan audioEvents into a generalized
 * mix. Renders are ledger jobs (`assemblyRender`) with progress, and
 * cancellation kills ffmpeg mid-flight leaving no partial render.mp4.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Production, ProductionTimeline } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { jobForChannel, jobLabel, jobTargetKey } from "../src/shared/ipc.js";
import {
  assemblyPlan,
  assemblyPlanForProduction,
  buildTimelineMixArgs,
  renderTimelineAnimatic,
} from "../src/main/assembly.js";
import { runFfmpeg } from "../src/main/ffmpeg.js";
import { createJobLedger, currentJobControls, runWithJobLedger } from "../src/main/jobs.js";
import fixtureJson from "./fixtures/pre-timeline-production.json";

const timeline: ProductionTimeline = {
  version: 1,
  tracks: [
    { id: "v1", kind: "video", name: "V1" },
    { id: "a1", kind: "audio", name: "VO", volume: 0.5 },
    { id: "a2", kind: "audio", name: "SFX" },
  ],
  clips: [
    { id: "v", trackId: "v1", sourceKind: "video", srcRel: "c.mp4", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0 },
    { id: "vo", trackId: "a1", sourceKind: "audio", srcRel: "vo.mp3", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0, role: "voiceover", volume: 0.8, fadeOutSec: 1 },
    { id: "sfx", trackId: "a2", sourceKind: "audio", srcRel: "sfx.wav", sourceInSec: 1, sourceOutSec: 5, timelineStartSec: 2, speed: 2, volume: 0.6, fadeInSec: 0.5 },
  ],
};

const prodOf = (t?: ProductionTimeline, folder = "/tmp"): Production =>
  ({
    meta: { id: "p9", name: "A9", folder, createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
    currentStep: 5, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
    ...(t ? { timeline: t } : {}),
    assembly: { fps: 24, width: 320, height: 180, exportDir: "out/assembly" },
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
  }) as unknown as Production;

describe("generalized audio events", () => {
  it("every audible clip rides audioEvents with position/trim/speed/gain/fades", () => {
    const plan = assemblyPlanForProduction(prodOf(timeline));
    expect(plan.audioEvents).toHaveLength(2);
    const vo = plan.audioEvents!.find((a) => a.srcRel === "vo.mp3")!;
    expect(vo).toMatchObject({ startSec: 0, durationSec: 8, role: "voiceover", fadeOutSec: 1 });
    expect(vo.volume).toBeCloseTo(0.4, 9); // 0.8 clip × 0.5 track
    const sfx = plan.audioEvents!.find((a) => a.srcRel === "sfx.wav")!;
    expect(sfx).toMatchObject({ startSec: 2, durationSec: 2, speed: 2, fadeInSec: 0.5 });
    expect(sfx.offsetSec).toBe(1);
    expect(sfx.volume).toBeCloseTo(0.6, 9);
    // Role slots still derived for EDL/JSX compat.
    expect(plan.voiceover?.srcRel).toBe("vo.mp3");
  });

  it("mix args delay, retime, gain, and fade each event into one amix", () => {
    const plan = assemblyPlanForProduction(prodOf(timeline));
    const args = buildTimelineMixArgs({
      renderAbs: "/pre.mov",
      audio: plan.audioEvents!.map((a) => ({ ...a, abs: `/${a.srcRel}` })),
      totalSec: 8,
      outAbs: "/out.mp4",
    });
    const joined = args.join(" ");
    expect(joined).toContain("amix=inputs=3:normalize=0");
    expect(joined).toContain("adelay=2000|2000"); // sfx starts at 2s
    expect(joined).toContain("atempo=2");
    expect(joined).toContain("eval=frame"); // fades ride the gain expression
    // No events at all → plain single encode of the premix (like no beds).
    const plain = buildTimelineMixArgs({ renderAbs: "/pre.mov", audio: [], totalSec: 8, outAbs: "/out.mp4" });
    expect(plain.join(" ")).not.toContain("amix");
    expect(plain.join(" ")).toContain("-c:a aac");
  });

  it("legacy productions (no timeline) plan identically through the unified path", () => {
    const legacy = structuredClone(fixtureJson) as unknown as Production;
    delete (legacy as { timeline?: unknown }).timeline;
    const unified = assemblyPlanForProduction(legacy);
    const old = assemblyPlan(legacy);
    expect(unified.events).toEqual(old.events);
    expect(unified.media).toEqual(old.media);
    expect(unified.totalSec).toBe(old.totalSec);
    expect(unified.voiceover).toEqual(old.voiceover);
    expect(unified.music).toEqual(old.music);
  });
});

describe("ledger registration", () => {
  it("assemblyRender is a ledger job kind with a per-production target", () => {
    expect(jobForChannel("production:assemblyRender", ["p1"])).toMatchObject({ kind: "assemblyRender" });
    expect(jobTargetKey("assemblyRender", ["p1"])).toBe("render:p1");
    expect(jobLabel("assemblyRender")).toMatch(/render/i);
  });
});

describe("runFfmpeg cancellation", () => {
  it("kills the child and rejects as cancelled when the flag flips", async () => {
    let cancelled = false;
    const t0 = Date.now();
    const p = runFfmpeg(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], undefined, { isCancelled: () => cancelled });
    setTimeout(() => { cancelled = true; }, 60);
    await expect(p).rejects.toThrow(/cancel/i);
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 15000);
});

describe("render cancel + progress (fake ffmpeg)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-a9-"));
    fs.mkdirSync(path.join(dir, "media"), { recursive: true });
    fs.writeFileSync(path.join(dir, "c.mp4"), "x");
    fs.writeFileSync(path.join(dir, "vo.mp3"), "x");
    fs.writeFileSync(path.join(dir, "sfx.wav"), "x");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writingRun = async (_bin: string, argv: string[]): Promise<void> => {
    fs.writeFileSync(argv[argv.length - 1], "segment");
  };

  it("reports progress to 100 and lands render.mp4 via tmp-then-rename", async () => {
    const progress: number[] = [];
    const rel = await renderTimelineAnimatic(prodOf(timeline, dir), undefined, () => {}, {
      bin: "fake",
      runFfmpeg: writingRun,
      onProgress: (pct) => progress.push(pct),
    });
    expect(rel).toBe("out/assembly/render.mp4");
    expect(fs.existsSync(path.join(dir, "out/assembly/render.mp4"))).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(100);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress); // monotonic
  });

  it("cancelling mid-render rejects as cancelled and leaves no render.mp4", async () => {
    let calls = 0;
    let cancelled = false;
    const flippingRun = async (_bin: string, argv: string[]): Promise<void> => {
      calls++;
      if (calls >= 1) cancelled = true;
      fs.writeFileSync(argv[argv.length - 1], "segment");
    };
    await expect(
      renderTimelineAnimatic(prodOf(timeline, dir), undefined, () => {}, {
        bin: "fake",
        runFfmpeg: flippingRun,
        isCancelled: () => cancelled,
      })
    ).rejects.toThrow(/cancel/i);
    expect(fs.existsSync(path.join(dir, "out/assembly/render.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "out/assembly/_render"))).toBe(false);
  });

  it("through the real ledger: progress records, cancel lands as cancelled", async () => {
    const ledger = createJobLedger({});
    const slowRun = async (_bin: string, argv: string[]): Promise<void> => {
      await new Promise((r) => setTimeout(r, 80));
      fs.writeFileSync(argv[argv.length - 1], "segment");
    };
    const running = runWithJobLedger(ledger, "production:assemblyRender", ["p9"], async () => {
      const controls = currentJobControls();
      expect(controls).toBeDefined();
      return renderTimelineAnimatic(prodOf(timeline, dir), undefined, () => {}, {
        bin: "fake",
        runFfmpeg: slowRun,
        isCancelled: () => controls!.isCancelled(),
        onProgress: (pct) => controls!.setProgress(pct),
      });
    });
    // Let it get going, check it is visibly running with progress, then cancel.
    await new Promise((r) => setTimeout(r, 130));
    const mid = ledger.snapshot("p9").jobs;
    expect(mid).toHaveLength(1);
    expect(mid[0].kind).toBe("assemblyRender");
    expect(ledger.cancel(mid[0].id)).toBe(true);
    await expect(running).rejects.toThrow(/cancel/i);
    const after = ledger.snapshot("p9").jobs[0];
    expect(after.state).toBe("cancelled");
    expect(fs.existsSync(path.join(dir, "out/assembly/render.mp4"))).toBe(false);
  });
});
