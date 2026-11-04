/**
 * End-to-end constant-speed + reverse render through the REAL bundled
 * FFmpeg (Animatic Editor Expansion Item A4) — gated like assembly-ffmpeg:
 *
 *   ASSEMBLY_E2E=1 npx vitest run test/timeline-render-ffmpeg.test.ts
 *
 * Source: 4s clip, first 2s red, second 2s blue, with a sine tone.
 * Timeline: A = whole clip at 2x (→2s), B = first half at 0.5x (→4s),
 * C = whole clip reversed (→4s). The render must be 10s to the frame
 * budget, A/B open on red, and C must run blue→red (frames in reverse
 * order, spotted at its head and tail).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { Production } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { assemblyPlanForProduction, segmentSec } from "../src/main/assembly.js";
import { clipDurationSec, setClipTransition, type ProductionTimeline } from "../src/shared/ipc.js";
import { renderTimelineAnimatic } from "../src/main/assembly.js";
import { probeMedia, runFfmpeg } from "../src/main/ffmpeg.js";

// Same gate + binary resolution as assembly-ffmpeg.test.ts (inlined:
// importing one test file from another proved fragile under vitest).
const bin = ((): string | null => {
  if (process.env.ASSEMBLY_E2E !== "1") return null;
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  for (const cand of [
    path.resolve(__dirname, "..", "node_modules", "ffmpeg-static", "ffmpeg.exe"),
    path.resolve(__dirname, "..", "node_modules", "ffmpeg-static", "ffmpeg"),
    path.resolve(__dirname, "..", "..", "app", "node_modules", "ffmpeg-static", "ffmpeg.exe"),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
})();

async function probeSeconds(fileAbs: string): Promise<number> {
  const r = await probeMedia(bin!, fileAbs);
  if (r.durationSec == null) throw new Error(`could not probe duration of ${fileAbs}`);
  return r.durationSec;
}

function spawnBuf(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin!, args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${err.slice(-400)}`))));
  });
}

/** Dominant RGB of the frame at `sec` (1x1 downscale, raw pixels). */
async function frameColorAt(fileAbs: string, sec: number): Promise<{ r: number; g: number; b: number }> {
  const buf = await spawnBuf([
    "-hide_banner", "-loglevel", "error",
    "-ss", sec.toFixed(3), "-i", fileAbs,
    "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  return { r: buf[0] ?? 0, g: buf[1] ?? 0, b: buf[2] ?? 0 };
}

describe.skipIf(!bin)("timeline speed/reverse render (real ffmpeg, ASSEMBLY_E2E=1)", () => {
  let dir: string;
  let renderAbs: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-tl-speed-"));
    const srcAbs = path.join(dir, "media", "src.mp4");
    fs.mkdirSync(path.dirname(srcAbs), { recursive: true });
    await spawnBuf([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:size=320x180:rate=24:duration=2",
      "-f", "lavfi", "-i", "color=c=blue:size=320x180:rate=24:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-map", "2:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      srcAbs,
    ]);
    expect(existsSync(srcAbs)).toBe(true);

    const prod = {
      meta: { id: "sp1", name: "Speed E2E", folder: dir, createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
      currentStep: 5, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
      timeline: {
        version: 1,
        tracks: [{ id: "v1", kind: "video", name: "V1" }],
        clips: [
          { id: "a", trackId: "v1", sourceKind: "video", srcRel: "media/src.mp4", sourceInSec: 0, sourceOutSec: 4, timelineStartSec: 0, speed: 2 },
          { id: "b", trackId: "v1", sourceKind: "video", srcRel: "media/src.mp4", sourceInSec: 0, sourceOutSec: 2, timelineStartSec: 2, speed: 0.5 },
          { id: "c", trackId: "v1", sourceKind: "video", srcRel: "media/src.mp4", sourceInSec: 0, sourceOutSec: 4, timelineStartSec: 6, reversed: true },
        ],
      },
      assembly: { fps: 24, width: 320, height: 180, exportDir: "out/assembly" },
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    } as unknown as Production;

    const rel = await renderTimelineAnimatic(
      prod,
      { fps: 24, width: 320, height: 180 },
      () => {},
      { bin: bin!, runFfmpeg, probe: probeMedia, tempDir: path.join(dir, "_segs") }
    );
    renderAbs = path.join(dir, rel);
    expect(existsSync(renderAbs)).toBe(true);
  }, 240_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("renders 2x + 0.5x + reversed to exactly 10s (frame budget)", async () => {
    const sec = await probeSeconds(renderAbs);
    expect(Math.abs(sec - 10)).toBeLessThan(0.15);
  }, 60_000);

  it("places source colors where speed and reverse say they belong", async () => {
    const a = await frameColorAt(renderAbs, 0.2); // A @2x: source ~0.4s → red
    expect(a.r).toBeGreaterThan(a.b + 40);
    const b = await frameColorAt(renderAbs, 2.2); // B @0.5x: source ~0.1s → red
    expect(b.r).toBeGreaterThan(b.b + 40);
    const bLate = await frameColorAt(renderAbs, 5.8); // B tail: source ~1.9s → still red
    expect(bLate.r).toBeGreaterThan(bLate.b + 40);
    const cHead = await frameColorAt(renderAbs, 6.2); // C reversed opens on source end → blue
    expect(cHead.b).toBeGreaterThan(cHead.r + 40);
    const cTail = await frameColorAt(renderAbs, 9.8); // C reversed ends on source start → red
    expect(cTail.r).toBeGreaterThan(cTail.b + 40);
  }, 60_000);
});

describe.skipIf(!bin)("timeline speed-RAMP render (real ffmpeg, ASSEMBLY_E2E=1)", () => {
  let dir: string;
  let renderAbs: string;
  // Source 6s: red 0-3, blue 3-6. Curve 2x for 2s (consumes 4 source sec),
  // easing to 0.5x — the integral puts the end at ≈3.117s of timeline.
  const curve = [
    { atSec: 0, speed: 2 },
    { atSec: 2, speed: 2 },
    { atSec: 6, speed: 0.5 },
  ];
  const rampClip = {
    id: "r", trackId: "v1", sourceKind: "video" as const, srcRel: "media/src6.mp4",
    sourceInSec: 0, sourceOutSec: 6, timelineStartSec: 0, speedCurve: curve,
  };
  const expectedDur = clipDurationSec(rampClip);

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-tl-ramp-"));
    const srcAbs = path.join(dir, "media", "src6.mp4");
    fs.mkdirSync(path.dirname(srcAbs), { recursive: true });
    await spawnBuf([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:size=320x180:rate=24:duration=3",
      "-f", "lavfi", "-i", "color=c=blue:size=320x180:rate=24:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-map", "2:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      srcAbs,
    ]);
    const timeline: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [rampClip],
    };
    const prod = {
      meta: { id: "rp1", name: "Ramp E2E", folder: dir, createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
      currentStep: 5, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
      timeline,
      assembly: { fps: 24, width: 320, height: 180, exportDir: "out/assembly" },
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    } as unknown as Production;
    const rel = await renderTimelineAnimatic(
      prod,
      { fps: 24, width: 320, height: 180 },
      () => {},
      { bin: bin!, runFfmpeg, probe: probeMedia, tempDir: path.join(dir, "_segs") }
    );
    renderAbs = path.join(dir, rel);
    expect(existsSync(renderAbs)).toBe(true);
  }, 240_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rendered duration equals the curve integral", async () => {
    expect(expectedDur).toBeGreaterThan(3.1);
    expect(expectedDur).toBeLessThan(3.13);
    const sec = await probeSeconds(renderAbs);
    expect(Math.abs(sec - expectedDur)).toBeLessThan(0.12);
  }, 60_000);

  it("frames land where the integral says (fast head red, eased tail blue)", async () => {
    const head = await frameColorAt(renderAbs, 0.5); // ∫=1.0 source sec → red half
    expect(head.r).toBeGreaterThan(head.b + 40);
    const tail = await frameColorAt(renderAbs, 2.05); // ∫≈4.1 source sec → blue half
    expect(tail.b).toBeGreaterThan(tail.r + 40);
  }, 60_000);
});

/** Mono 48k s16 samples of a render window (for level + pitch measures). */
async function pcmWindow(fileAbs: string, startSec: number, durSec: number): Promise<Int16Array> {
  const buf = await spawnBuf([
    "-hide_banner", "-loglevel", "error",
    "-ss", startSec.toFixed(3), "-t", durSec.toFixed(3), "-i", fileAbs,
    "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "s16le", "-",
  ]);
  const out = new Int16Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

function rms(samples: Int16Array): number {
  let acc = 0;
  for (const s of samples) acc += (s / 32768) * (s / 32768);
  return samples.length ? Math.sqrt(acc / samples.length) : 0;
}

/** Dominant sine frequency estimate via zero crossings (pure tones). */
function zcrHz(samples: Int16Array, sampleRate = 48000): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) crossings++;
  }
  return crossings / 2 / (samples.length / sampleRate);
}

describe.skipIf(!bin)("timeline audio render — fade + pitch (Item 7, ASSEMBLY_E2E=1)", () => {
  let dir: string;
  let renderAbs: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-tl-audio-"));
    const srcAbs = path.join(dir, "media", "tone.mp4");
    fs.mkdirSync(path.dirname(srcAbs), { recursive: true });
    await spawnBuf([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=green:size=320x180:rate=24:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      srcAbs,
    ]);
    // D: 2x preserve-pitch with a 2s fade-out (→3s). E: 2x natural (→3s).
    const prod = {
      meta: { id: "au1", name: "Audio E2E", folder: dir, createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
      currentStep: 5, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
      timeline: {
        version: 1,
        tracks: [{ id: "v1", kind: "video", name: "V1" }],
        clips: [
          { id: "d", trackId: "v1", sourceKind: "video", srcRel: "media/tone.mp4", sourceInSec: 0, sourceOutSec: 6, timelineStartSec: 0, speed: 2, fadeOutSec: 2 },
          { id: "e", trackId: "v1", sourceKind: "video", srcRel: "media/tone.mp4", sourceInSec: 0, sourceOutSec: 6, timelineStartSec: 3, speed: 2, pitchMode: "natural" },
        ],
      },
      assembly: { fps: 24, width: 320, height: 180, exportDir: "out/assembly" },
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    } as unknown as Production;
    const rel = await renderTimelineAnimatic(
      prod,
      { fps: 24, width: 320, height: 180 },
      () => {},
      { bin: bin!, runFfmpeg, probe: probeMedia, tempDir: path.join(dir, "_segs") }
    );
    renderAbs = path.join(dir, rel);
    expect(existsSync(renderAbs)).toBe(true);
  }, 240_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("duration matches the timeline (3s + 3s)", async () => {
    const sec = await probeSeconds(renderAbs);
    expect(Math.abs(sec - 6)).toBeLessThan(0.15);
  }, 60_000);

  it("the 2-second fade-out lands near silence at the clip end", async () => {
    const head = rms(await pcmWindow(renderAbs, 0.2, 0.5));
    const tail = rms(await pcmWindow(renderAbs, 2.85, 0.14));
    expect(head).toBeGreaterThan(0.03); // the tone is really there (lavfi sine is quiet)
    expect(tail).toBeLessThan(head * 0.08); // …and fades to (near) nothing
  }, 60_000);

  it("preserve-pitch keeps 440 Hz at 2x; natural shifts it to ~880 Hz", async () => {
    const keepHz = zcrHz(await pcmWindow(renderAbs, 0.2, 0.6));
    expect(keepHz).toBeGreaterThan(380);
    expect(keepHz).toBeLessThan(520);
    const natHz = zcrHz(await pcmWindow(renderAbs, 3.3, 0.6));
    expect(natHz).toBeGreaterThan(760);
    expect(natHz).toBeLessThan(1000);
  }, 60_000);
});

describe.skipIf(!bin)("timeline dissolve render (Item 8, ASSEMBLY_E2E=1)", () => {
  let dir: string;
  let renderAbs: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-tl-dissolve-"));
    fs.mkdirSync(path.join(dir, "media"), { recursive: true });
    for (const [name, color] of [["red.mp4", "red"], ["blue.mp4", "blue"]] as const) {
      await spawnBuf([
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `color=c=${color}:size=320x180:rate=24:duration=6`,
        "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        path.join(dir, "media", name),
      ]);
    }
    let timeline: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        { id: "a", trackId: "v1", sourceKind: "video", srcRel: "media/red.mp4", sourceInSec: 1, sourceOutSec: 5, timelineStartSec: 0 },
        { id: "b", trackId: "v1", sourceKind: "video", srcRel: "media/blue.mp4", sourceInSec: 1, sourceOutSec: 5, timelineStartSec: 4 },
      ],
    };
    timeline = setClipTransition(timeline, "a", 2, (p) => `${p}1`, { sourceDurationsSec: { "media/red.mp4": 6, "media/blue.mp4": 6 } })!;
    expect(timeline.transitions).toHaveLength(1);
    const prod = {
      meta: { id: "d8", name: "Dissolve E2E", folder: dir, createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
      currentStep: 5, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
      timeline,
      assembly: { fps: 24, width: 320, height: 180, exportDir: "out/assembly" },
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    } as unknown as Production;
    const rel = await renderTimelineAnimatic(
      prod,
      { fps: 24, width: 320, height: 180 },
      () => {},
      { bin: bin!, runFfmpeg, probe: probeMedia, tempDir: path.join(dir, "_segs") }
    );
    renderAbs = path.join(dir, rel);
    expect(existsSync(renderAbs)).toBe(true);
  }, 240_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("total duration is unchanged by the dissolve (8s)", async () => {
    const sec = await probeSeconds(renderAbs);
    expect(Math.abs(sec - 8)).toBeLessThan(0.15);
  }, 60_000);

  it("the midpoint frame truly blends both sources; outside the window is pure", async () => {
    const before = await frameColorAt(renderAbs, 2.5);
    expect(before.r).toBeGreaterThan(before.b + 60);
    const mid = await frameColorAt(renderAbs, 4.0); // edit point: 50/50
    expect(Math.min(mid.r, mid.b)).toBeGreaterThan(55);
    expect(Math.abs(mid.r - mid.b)).toBeLessThan(75);
    const after = await frameColorAt(renderAbs, 5.5);
    expect(after.b).toBeGreaterThan(after.r + 60);
  }, 60_000);
});

describe.skipIf(!bin)("every-feature timeline render (Item 9 acceptance, ASSEMBLY_E2E=1)", () => {
  let dir: string;
  let renderAbs: string;
  let prod: Production;
  let editSec = 0;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-tl-a9-"));
    fs.mkdirSync(path.join(dir, "media"), { recursive: true });
    for (const [name, color, dur] of [["red.mp4", "red", 8], ["blue.mp4", "blue", 6], ["green.mp4", "green", 6]] as const) {
      await spawnBuf([
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `color=c=${color}:size=320x180:rate=24:duration=${dur}`,
        "-f", "lavfi", "-i", `sine=frequency=440:duration=${dur}`,
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        path.join(dir, "media", name),
      ]);
    }
    for (const [name, freq] of [["tone440.wav", 440], ["tone880.wav", 880]] as const) {
      await spawnBuf([
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=10:sample_rate=48000`,
        "-c:a", "pcm_s16le",
        path.join(dir, "media", name),
      ]);
    }
    // R: red 6s of source under a 2x→0.5x ramp; B: blue after it with a
    // 1s dissolve; G: green at 2x on the TOP track for the first seconds.
    const ramp = {
      id: "r", trackId: "v1", sourceKind: "video" as const, srcRel: "media/red.mp4",
      sourceInSec: 0, sourceOutSec: 6, timelineStartSec: 0, muted: true,
      speedCurve: [{ atSec: 0, speed: 2 }, { atSec: 2, speed: 2 }, { atSec: 6, speed: 0.5 }],
    };
    editSec = clipDurationSec(ramp);
    let timeline: ProductionTimeline = {
      version: 1,
      tracks: [
        { id: "v2", kind: "video", name: "V2" },
        { id: "v1", kind: "video", name: "V1" },
        { id: "a1", kind: "audio", name: "SFX" },
        { id: "a2", kind: "audio", name: "Muted", muted: true },
      ],
      clips: [
        ramp,
        { id: "b", trackId: "v1", sourceKind: "video", srcRel: "media/blue.mp4", sourceInSec: 1, sourceOutSec: 5, timelineStartSec: editSec, muted: true },
        { id: "g", trackId: "v2", sourceKind: "video", srcRel: "media/green.mp4", sourceInSec: 0, sourceOutSec: 4, timelineStartSec: 0.5, speed: 2, muted: true },
        // Non-role audio with a fade-out: only the generalized mix renders it.
        { id: "sfx", trackId: "a1", sourceKind: "audio", srcRel: "media/tone440.wav", sourceInSec: 0, sourceOutSec: 4, timelineStartSec: 0, fadeOutSec: 2 },
        { id: "mut", trackId: "a2", sourceKind: "audio", srcRel: "media/tone880.wav", sourceInSec: 0, sourceOutSec: 10, timelineStartSec: 0 },
      ],
    };
    timeline = setClipTransition(timeline, "r", 1, (p) => `${p}1`, {
      sourceDurationsSec: { "media/red.mp4": 8, "media/blue.mp4": 6 },
    })!;
    expect(timeline.transitions).toHaveLength(1);
    prod = {
      meta: { id: "a9", name: "A9 E2E", folder: dir, createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
      currentStep: 5, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
      timeline,
      assembly: { fps: 24, width: 320, height: 180, exportDir: "out/assembly" },
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    } as unknown as Production;
    const rel = await renderTimelineAnimatic(
      prod,
      { fps: 24, width: 320, height: 180 },
      () => {},
      { bin: bin!, runFfmpeg, probe: probeMedia, tempDir: path.join(dir, "_segs") }
    );
    renderAbs = path.join(dir, rel);
    expect(existsSync(renderAbs)).toBe(true);
  }, 240_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("duration matches the model's frame budget", async () => {
    const plan = assemblyPlanForProduction(prod);
    const budget = plan.events.reduce((s, ev) => s + segmentSec(ev.durationSec, 24), 0);
    const sec = await probeSeconds(renderAbs);
    expect(Math.abs(sec - budget)).toBeLessThan(0.1);
    expect(Math.abs(budget - (editSec + 4))).toBeLessThan(0.15);
  }, 60_000);

  it("spot-checks: top track wins, ramp+dissolve land, muted track silent, fade ends quiet", async () => {
    const head = await frameColorAt(renderAbs, 0.2); // before G starts: red ramp clip
    expect(head.r).toBeGreaterThan(head.g + 40);
    const top = await frameColorAt(renderAbs, 1.2); // G (top track, 2x) covers
    expect(top.g).toBeGreaterThan(top.r + 40);
    const mid = await frameColorAt(renderAbs, editSec); // dissolve midpoint
    expect(Math.min(mid.r, mid.b)).toBeGreaterThan(45);
    const tail = await frameColorAt(renderAbs, editSec + 2);
    expect(tail.b).toBeGreaterThan(tail.r + 40);
    // SFX tone present early (440 Hz, not the muted track's 880)…
    const early = await pcmWindow(renderAbs, 0.2, 0.5);
    expect(rms(early)).toBeGreaterThan(0.03);
    expect(zcrHz(early)).toBeGreaterThan(360);
    expect(zcrHz(early)).toBeLessThan(560);
    // …and faded to near silence by its end (4s, 2s fade).
    const late = rms(await pcmWindow(renderAbs, 3.85, 0.14));
    expect(late).toBeLessThan(rms(early) * 0.15);
  }, 60_000);
});
