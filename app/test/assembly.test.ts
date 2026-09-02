/**
 * assembly tests — Step 5 Assembly. The pure builders (assemblyPlan, buildEdl,
 * buildAeScript, buildManifest, buildNormalizeArgs / buildConcatArgs /
 * buildMixArgs) hold the real logic; `assemble` is exercised end-to-end over a
 * temp production folder and `renderAnimatic` against a fake runFfmpeg/probe
 * seam (the openart.test.ts pattern).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Production, ProductionShot, ProductionScene } from "../src/shared/ipc.js";

// pipeline.ts imports scripting.ts; the tests never call its helpers and its
// dynamic pdf-parse import doesn't resolve under Vitest — mock it away.
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  assemble,
  assemblyPlan,
  buildAeScript,
  buildConcatArgs,
  buildConcatList,
  buildEdl,
  buildManifest,
  buildMixArgs,
  buildNormalizeArgs,
  framesToTc,
  renderAnimatic,
  type AssemblyEmit,
} from "../src/main/assembly.js";

// ---- fixture ---------------------------------------------------------------

let fixtureRoot: string;
let prodFolder: string;

function makeShot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return {
    id: crypto.randomUUID(),
    number: "0100",
    audio: "",
    visual: "A hero walks through the valley.",
    ...overrides,
  };
}

function makeScene(shots: ProductionShot[], number = 1, title = "Arrival"): ProductionScene {
  return { number, title, shots };
}

function makeProduction(overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "prod-a", name: "Test Production", folder: prodFolder, createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
    currentStep: 5,
    visualStyle: "",
    styles: [],
    scenes: [makeScene([])],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    voiceoverPath: "voiceover/voiceover.mp3",
    voiceoverVolume: 1,
    musicPath: "music/music.mp3",
    musicVolume: 0.5,
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    ...overrides,
  };
}

const emit: AssemblyEmit = () => {};

beforeEach(() => {
  fixtureRoot = path.join(os.tmpdir(), `cascade-assembly-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  prodFolder = path.join(fixtureRoot, "prod");
  const write = (rel: string) => {
    const abs = path.join(prodFolder, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `fake-${rel}`);
  };
  write("boards/0100/shot-0100-abc.jpg");
  write("boards/0100/originals/shot-0100-abc.png");
  write("boards/0200/shot-0200-def.jpg");
  write("boards/0200/originals/shot-0200-def.png");
  write("videos/shot-0200-x.mp4");
  write("voiceover/voiceover.mp3");
  write("music/music.mp3");
});

afterEach(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function sampleProduction(): Production {
  return makeProduction({
    scenes: [
      makeScene([
        makeShot({ number: "0100", artwork: "boards/0100/shot-0100-abc.jpg", durationSec: 2.5 }),
        makeShot({ number: "0200", artwork: "boards/0200/shot-0200-def.jpg", videoPath: "videos/shot-0200-x.mp4", durationSec: 4, muted: true }),
        makeShot({ number: "0300", durationSec: 3 }),
      ]),
    ],
  });
}

// ---- assemblyPlan ----------------------------------------------------------

describe("assemblyPlan", () => {
  it("maps shots to timeline events in order with cumulative timing", () => {
    const plan = assemblyPlan(sampleProduction());
    expect(plan.events.map((e) => e.number)).toEqual(["0100", "0200", "0300"]);
    expect(plan.events[0]).toMatchObject({ kind: "still", startSec: 0, endSec: 2.5, muted: false });
    expect(plan.events[1]).toMatchObject({ kind: "clip", startSec: 2.5, endSec: 6.5, muted: true });
    expect(plan.events[2]).toMatchObject({ kind: "blank", startSec: 6.5, endSec: 9.5, muted: false });
    expect(plan.totalSec).toBeCloseTo(9.5);
  });

  it("prefers the full-res original for stills and still gathers a clip shot's frame", () => {
    const plan = assemblyPlan(sampleProduction());
    expect(plan.events[0].srcRel).toBe("boards/0100/originals/shot-0100-abc.png");
    const rels = plan.media.map((m) => m.mediaRel);
    expect(rels).toContain("shots/0100.png");
    expect(rels).toContain("shots/0200.png"); // still gathered alongside the clip
    expect(rels).toContain("clips/0200.mp4");
  });

  it("gathers voiceover + music with volumes", () => {
    const plan = assemblyPlan(sampleProduction());
    expect(plan.voiceover).toMatchObject({ mediaRel: "audio/voiceover.mp3", volume: 1 });
    expect(plan.music).toMatchObject({ mediaRel: "audio/music.mp3", volume: 0.5 });
    expect(plan.media.some((m) => m.mediaRel === "audio/voiceover.mp3")).toBe(true);
  });

  it("renders black slots for shots with no frame or clip, holding their timeline slot", () => {
    const plan = assemblyPlan(sampleProduction());
    expect(plan.blanks).toEqual(["0300"]);
    expect(plan.totalSec).toBeCloseTo(9.5);
    expect(plan.media.some((m) => m.mediaRel === "shots/0300.png")).toBe(false);
  });

  it("defaults missing durations to 3 seconds", () => {
    const p = makeProduction({
      scenes: [makeScene([makeShot({ number: "0100", artwork: "boards/0100/shot-0100-abc.jpg" })])],
    });
    const plan = assemblyPlan(p);
    expect(plan.events[0].durationSec).toBe(3);
    expect(plan.totalSec).toBe(3);
  });

  it("dedupes media referenced by more than one shot", () => {
    const p = makeProduction({
      scenes: [
        makeScene([
          makeShot({ number: "0100", videoPath: "videos/shot-0200-x.mp4", durationSec: 2 }),
          makeShot({ number: "0200", videoPath: "videos/shot-0200-x.mp4", durationSec: 2 }),
        ]),
      ],
    });
    const plan = assemblyPlan(p);
    expect(plan.events.map((e) => e.mediaRel)).toEqual(["clips/0100.mp4", "clips/0100.mp4"]);
    expect(plan.media.filter((m) => m.mediaRel === "clips/0100.mp4")).toHaveLength(1);
  });

  it("keeps a clip-only shot (no artwork) as a clip event", () => {
    const p = makeProduction({
      scenes: [makeScene([makeShot({ number: "0100", videoPath: "videos/shot-0200-x.mp4" })])],
    });
    const plan = assemblyPlan(p);
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0].kind).toBe("clip");
  });
});

// ---- buildEdl --------------------------------------------------------------

describe("buildEdl", () => {
  it("emits a CMX3600 header and per-shot video events with 8-char reels", () => {
    const plan = assemblyPlan(sampleProduction());
    const edl = buildEdl(plan, 24, "Test Production");
    const lines = edl.split("\r\n");
    expect(lines[0]).toBe("TITLE: Test Production");
    expect(lines[1]).toBe("FCM: NON-DROP FRAME");
    expect(lines).toContain("001  SHOT0100  V     C        00:00:00:00 00:00:00:00 00:00:00:00 00:00:02:12");
    // clip src-out is the planned duration (4s * 24 = 96 frames = 00:00:04:00)
    expect(lines).toContain("002  SHOT0200  V     C        00:00:00:00 00:00:04:00 00:00:02:12 00:00:06:12");
    // no-frame shot is a BL reel event holding its full animatic slot
    expect(lines).toContain("003  BL        V     C        00:00:00:00 00:00:00:00 00:00:06:12 00:00:09:12");
    expect(lines).toContain("* FROM CLIP NAME: shots/0100.png");
    expect(lines).toContain("* FROM CLIP NAME: clips/0200.mp4");
    expect(lines).toContain("* FROM CLIP NAME: BLACK");
    // audio events ride the A track spanning the full timeline
    expect(edl).toMatch(/004\s+VOICE\s+A\s+C\s+00:00:00:00 00:00:09:12 00:00:00:00 00:00:09:12/);
    expect(edl).toContain("* FROM CLIP NAME: audio/voiceover.mp3");
    expect(edl).toContain("* NOTE: voiceover duration unverified");
    expect(edl).toMatch(/005\s+MUSIC\s+A\s+C\s+00:00:00:00 00:00:09:12 00:00:00:00 00:00:09:12/);
  });

  it("clamps a clip's source-out to its probed length", () => {
    const plan = assemblyPlan(sampleProduction());
    plan.events[1].probedSec = 3;
    const edl = buildEdl(plan, 24, "Test Production");
    expect(edl).toContain("002  SHOT0200  V     C        00:00:00:00 00:00:03:00 00:00:02:12 00:00:06:12");
  });

  it("appends VO and music as A-track events spanning the timeline", () => {
    const plan = assemblyPlan(sampleProduction());
    const edl = buildEdl(plan, 24, "Test Production");
    expect(edl).toMatch(/004\s+VOICE\s+A\s+C\s+00:00:00:00 00:00:09:12 00:00:00:00 00:00:09:12/);
    expect(edl).toContain("* FROM CLIP NAME: audio/voiceover.mp3");
    expect(edl).toContain("* NOTE: voiceover duration unverified");
    expect(edl).toMatch(/005\s+MUSIC\s+A\s+C\s+00:00:00:00 00:00:09:12 00:00:00:00 00:00:09:12/);
  });
});

describe("framesToTc", () => {
  it("formats non-drop-frame timecode", () => {
    expect(framesToTc(0, 24)).toBe("00:00:00:00");
    expect(framesToTc(60, 24)).toBe("00:00:02:12");
    expect(framesToTc(86400, 24)).toBe("01:00:00:00");
  });
});

// ---- buildAeScript ---------------------------------------------------------

describe("buildAeScript", () => {
  it("creates the comp and layers with in/out points, muted handling, and dB levels", () => {
    const plan = assemblyPlan(sampleProduction());
    const script = buildAeScript(plan, { fps: 24, width: 1920, height: 1080 }, "C:/prod/out/assembly");
    expect(script).toContain('var comp = proj.items.addComp("Assembly", 1920, 1080, 1, 9.500, 24);');
    expect(script).toContain('var foot0 = proj.importFile(new ImportOptions(new File(media + "/shots/0100.png")));');
    expect(script).toContain("lay0.startTime = 0.000;");
    expect(script).toContain("lay0.outPoint = 2.500;");
    expect(script).toContain("lay1.startTime = 2.500;");
    expect(script).toContain("lay1.outPoint = 6.500;");
    expect(script).toContain("lay1.audioEnabled = false;"); // muted clip
    expect(script).toContain('var lay2 = comp.layers.addSolid([0, 0, 0], "BLANK", 1920, 1080, 1);');
    expect(script).toContain("lay2.startTime = 6.500;");
    expect(script).toContain("lay2.outPoint = 9.500;");
    expect(script).toContain('voLay.property("ADBE Audio Group").property("ADBE Audio Levels").setValue([0.00]);');
    expect(script).toContain('musicLay.property("ADBE Audio Group").property("ADBE Audio Levels").setValue([-6.02]);');
    expect(script).toContain('app.project.save(new File(scriptDir + "/Assembly.aep"));');
  });

  it("escapes quotes in paths", () => {
    const plan = assemblyPlan(sampleProduction());
    const script = buildAeScript(plan, { fps: 24, width: 1920, height: 1080 }, "C:/a \"b\"/out");
    expect(script).toContain('scriptDir + "/media"');
  });
});

// ---- buildManifest ---------------------------------------------------------

describe("buildManifest", () => {
  it("lists timeline, media, skips, and artifacts", () => {
    const plan = assemblyPlan(sampleProduction());
    const md = buildManifest(plan, { fps: 24, width: 1920, height: 1080 }, { title: "Test Production", builtAt: "2026-01-01T00:00:00Z", edlName: "Assembly.edl", jsxName: "Assembly.jsx" });
    expect(md).toContain("# Test Production — Manifest");
    expect(md).toContain("1920×1080 @ 24 fps");
    expect(md).toContain("runtime 0:10");
    expect(md).toContain("| 0100 | still | shots/0100.png | 2.5s |");
    expect(md).toContain("| 0300 | blank | - | 3.0s |");
    expect(md).toContain("## Blank slots (no frame/clip)");
    expect(md).toContain("- 0300");
    expect(md).toContain("- Assembly.edl");
    expect(md).toContain("- render.mp4 (after Render MP4)");
  });
});

// ---- ffmpeg argv builders --------------------------------------------------

describe("buildNormalizeArgs", () => {
  const cfg = { fps: 24, width: 1920, height: 1080 };

  it("loops stills to an exact duration with silent audio", () => {
    const args = buildNormalizeArgs({ kind: "still", durationSec: 2.5, muted: false }, cfg, "C:/src/a.png", "C:/out/0001.mp4");
    expect(args).toContain("-loop");
    expect(args).toContain("-framerate");
    expect(args).toContain("24");
    expect(args).toContain("-i");
    expect(args).toContain("C:/src/a.png");
    expect(args).toContain("anullsrc=r=48000:cl=stereo");
    expect(args).toContain("-t");
    expect(args).toContain("2.500");
    expect(args[args.length - 1]).toBe("C:/out/0001.mp4");
  });

  it("renders blank slots from a black lavfi source with no input file", () => {
    const args = buildNormalizeArgs({ kind: "blank", durationSec: 3, muted: false }, cfg, "", "C:/out/0003.mp4");
    expect(args).toContain("-f");
    expect(args).toContain("lavfi");
    expect(args).toContain("color=c=black:s=1920x1080:r=24");
    expect(args.some((a) => a === "C:/src/a.png" || a === "C:/src/b.mp4")).toBe(false);
    expect(args).toContain("anullsrc=r=48000:cl=stereo");
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).not.toContain("scale=");
    expect(vf).toContain("fps=24");
    expect(args).toContain("3.000");
  });

  it("keeps an unmuted clip's embedded audio, padded with apad", () => {
    const args = buildNormalizeArgs({ kind: "clip", durationSec: 4, muted: false, hasAudio: true }, cfg, "C:/src/b.mp4", "C:/out/0002.mp4");
    expect(args).toContain("-map");
    expect(args).toContain("0:a");
    expect(args).toContain("-af");
    expect(args).toContain("apad");
    expect(args.some((a) => a.includes("anullsrc"))).toBe(false);
  });

  it("silences muted clips and clips without audio", () => {
    for (const ev of [
      { kind: "clip" as const, durationSec: 4, muted: true, hasAudio: true },
      { kind: "clip" as const, durationSec: 4, muted: false, hasAudio: false },
    ]) {
      const args = buildNormalizeArgs(ev, cfg, "C:/src/b.mp4", "C:/out/0002.mp4");
      expect(args.some((a) => a.includes("anullsrc"))).toBe(true);
      expect(args.indexOf("-map")).toBeGreaterThan(0);
    }
  });

  it("pads a clip shorter than its planned duration with tpad", () => {
    const args = buildNormalizeArgs({ kind: "clip", durationSec: 4, muted: true, probedSec: 2 }, cfg, "C:/src/b.mp4", "C:/out/0002.mp4");
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("tpad=stop_mode=clone:stop_duration=2.000");
  });
});

describe("buildConcatList / buildConcatArgs", () => {
  it("writes a concat list with escaped paths and a stream-copy command", () => {
    const list = buildConcatList(["C:/a/b.mp4", "C:/c/'quoted'.mp4"]);
    expect(list).toBe("file 'C:/a/b.mp4'\nfile 'C:/c/'\\''quoted'\\''.mp4'\n");
    const args = buildConcatArgs("C:/list.txt", "C:/out.mp4");
    expect(args).toEqual(["-y", "-f", "concat", "-safe", "0", "-i", "C:/list.txt", "-c", "copy", "-movflags", "+faststart", "C:/out.mp4"]);
  });
});

describe("buildMixArgs", () => {
  const base = { renderAbs: "C:/pre.mp4", totalSec: 6.5, outAbs: "C:/render.mp4" };

  it("copies audio through when there are no beds", () => {
    const args = buildMixArgs(base);
    expect(args).toContain("-c");
    expect(args).toContain("copy");
  });

  it("mixes VO + music with per-bed volumes", () => {
    const args = buildMixArgs({
      ...base,
      voiceover: { abs: "C:/vo.mp3", volume: 1 },
      music: { abs: "C:/mu.mp3", volume: 0.5 },
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("volume=1.00");
    expect(filter).toContain("volume=0.50");
    expect(filter).toContain("amix=inputs=3:normalize=0");
    expect(args).toContain("-c:v");
    expect(args).toContain("copy");
  });
});

// ---- assemble e2e ----------------------------------------------------------

describe("assemble", () => {
  it("copies media into the export folder and writes all four artifacts", async () => {
    const p = sampleProduction();
    const result = await assemble(p, undefined, emit, {});
    const exportAbs = path.join(prodFolder, "out/assembly");
    for (const rel of ["media/shots/0100.png", "media/shots/0200.png", "media/clips/0200.mp4", "media/audio/voiceover.mp3", "media/audio/music.mp3"]) {
      expect(fs.existsSync(path.join(exportAbs, rel))).toBe(true);
    }
    expect(fs.existsSync(path.join(exportAbs, "Assembly.edl"))).toBe(true);
    expect(fs.existsSync(path.join(exportAbs, "Assembly.jsx"))).toBe(true);
    expect(fs.existsSync(path.join(exportAbs, "MANIFEST.md"))).toBe(true);
    expect(result.copied).toBeGreaterThanOrEqual(5);
    expect(p.assembly?.assembledAt).toBeTruthy();
    expect(p.assembly?.totalSec).toBeCloseTo(9.5);
    expect(p.assembly?.skippedShots).toEqual(["0300"]);
  });

  it("persists a custom config and probes clip lengths when ffmpeg is available", async () => {
    const p = sampleProduction();
    const probe = vi.fn(async () => ({ durationSec: 3, hasAudio: false }));
    await assemble(p, { fps: 30, width: 2560, height: 1440 }, emit, { ffmpegBin: "ffmpeg", probe });
    expect(p.assembly?.fps).toBe(30);
    expect(p.assembly?.width).toBe(2560);
    expect(probe).toHaveBeenCalled();
    const edl = fs.readFileSync(path.join(prodFolder, "out/assembly/Assembly.edl"), "utf8");
    expect(edl).toContain("00:00:03:00"); // clip clamped to probed 3s @ 30fps
  });
});

// ---- renderAnimatic --------------------------------------------------------

describe("renderAnimatic", () => {
  it("runs normalize per shot, then concat, then mix — and cleans up temp segments", async () => {
    const p = sampleProduction();
    const calls: string[][] = [];
    const runFfmpeg = vi.fn(async (_bin: string, argv: string[]) => {
      calls.push(argv);
    });
    const probe = vi.fn(async () => ({ durationSec: 3, hasAudio: false }));
    const tempDir = path.join(fixtureRoot, "segments");

    const rel = await renderAnimatic(p, undefined, emit, { bin: "ffmpeg", runFfmpeg, probe, tempDir });

    expect(rel).toBe("out/assembly/render.mp4");
    expect(runFfmpeg).toHaveBeenCalledTimes(5); // 3 normalize + 1 concat + 1 mix
    // three normalize passes: still, clip, and a black blank slot
    expect(calls[0].some((a) => a.includes(path.join("boards", "0100", "originals", "shot-0100-abc.png")))).toBe(true);
    expect(calls[1].some((a) => a.includes(path.join("videos", "shot-0200-x.mp4")))).toBe(true);
    expect(calls[2].some((a) => a.includes("color=c=black:s=1920x1080:r=24"))).toBe(true);
    // concat pass reads the list file
    expect(calls[3].includes("-f")).toBe(true);
    expect(calls[3].includes("concat")).toBe(true);
    // mix pass mixes VO + music
    const mixFilter = calls[4][calls[4].indexOf("-filter_complex") + 1];
    expect(mixFilter).toContain("amix");
    // final output path
    expect(calls[4][calls[4].length - 1]).toBe(path.join(prodFolder, "out/assembly/render.mp4"));
    // temp segments cleaned up
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it("throws only when the timeline has no shots at all", async () => {
    const p = makeProduction({ scenes: [makeScene([])] });
    const runFfmpeg = vi.fn(async () => {});
    await expect(
      renderAnimatic(p, undefined, emit, { bin: "ffmpeg", runFfmpeg, tempDir: path.join(fixtureRoot, "segments") })
    ).rejects.toThrow("Nothing to render");
    expect(runFfmpeg).not.toHaveBeenCalled();
  });
});