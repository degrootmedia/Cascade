/**
 * Real-ffmpeg end-to-end smoke test for the Assembly render pipeline.
 *
 * Skips unless ASSEMBLY_E2E=1 (it needs the bundled ffmpeg-static binary and
 * a real media encode). Generates tiny fixtures with ffmpeg itself, runs
 * assemble + renderAnimatic through the real runFfmpeg/probeMedia, and
 * verifies a playable render.mp4 comes out with the expected runtime.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Production, ProductionShot, ProductionScene } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { assemble, renderAnimatic } from "../src/main/assembly.js";
import { probeMedia, resolveFfmpeg, runFfmpeg } from "../src/main/ffmpeg.js";
import { spawn } from "node:child_process";

/** Detect beep onsets (silence_end times) in a rendered file's audio. */
function detectOnsets(bin: string, absPath: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-hide_banner", "-nostdin", "-i", absPath, "-af", "silencedetect=noise=-40dB:d=0.05", "-f", "null", "-"], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", () => {
      const ends = [...stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
      resolve(ends);
    });
  });
}

const maybe = process.env.ASSEMBLY_E2E === "1" ? it : it.skip;

let root: string;

function ff(cmd: string[]): void {
  // eslint-disable-next-line no-console
  console.log("ffmpeg:", cmd.join(" "));
}

beforeEach(async () => {
  root = path.join(os.tmpdir(), `cascade-assembly-e2e-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeProd(p: Production): Production {
  return p;
}

describe("renderAnimatic against real ffmpeg", () => {
  maybe("renders stills + clips + VO + music into a playable mp4", async () => {
    const bin = await resolveFfmpeg();
    if (!bin) throw new Error("no ffmpeg available for the e2e smoke test");

    // --- generate tiny fixtures with the real binary -----------------------
    const prod = path.join(root, "prod");
    const write = (rel: string) => {
      const abs = path.join(prod, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      return abs;
    };
    const stillA = write("boards/0100/originals/shot-0100-aaa.png");
    const stillB = write("boards/0200/originals/shot-0200-bbb.png");
    const clip = write("videos/clip.mp4");
    const vo = write("voiceover/vo.wav");
    const music = write("music/music.wav");

    const enc = async (argv: string[]) => {
      const r = await runFfmpeg(bin, argv);
      return r;
    };
    await enc(["-y", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=24", "-frames:v", "1", stillA]);
    await enc(["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24", "-frames:v", "1", stillB]);
    await enc(["-y", "-f", "lavfi", "-i", "color=c=green:s=320x180:r=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", clip]);
    await enc(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ar", "48000", "-ac", "2", vo]);
    await enc(["-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-ar", "48000", "-ac", "2", music]);
    // artwork must be a board JPEG for originalForJpegRel to find the original
    fs.writeFileSync(path.join(prod, "boards/0100/shot-0100-aaa.jpg"), fs.readFileSync(stillA));
    fs.writeFileSync(path.join(prod, "boards/0200/shot-0200-bbb.jpg"), fs.readFileSync(stillB));

    const shot = (o: Partial<ProductionShot>): ProductionShot => ({
      id: crypto.randomUUID(), number: "0100", audio: "", visual: "",
      ...o,
    });
    const p = makeProd({
      meta: { id: "e2e", name: "E2E", folder: prod, createdAt: "", updatedAt: "", stepDone: 4, shotCount: 2 },
      currentStep: 5,
      visualStyle: "",
      styles: [],
      scenes: [{
        number: 1, title: "T",
        shots: [
          shot({ number: "0100", artwork: "boards/0100/shot-0100-aaa.jpg", durationSec: 1.5 }),
          shot({ number: "0200", artwork: "boards/0200/shot-0200-bbb.jpg", videoPath: "videos/clip.mp4", durationSec: 2 }),
          shot({ number: "0300", durationSec: 2 }), // no frame/clip -> black slot
        ],
      } as ProductionScene],
      characters: [], products: [], openArt: { model: "auto", resolution: "1k" }, status: {},
      voiceoverPath: "voiceover/vo.wav", voiceoverVolume: 1,
      musicPath: "music/music.wav", musicVolume: 0.5,
      assembly: { fps: 24, width: 640, height: 360, exportDir: "out/assembly" },
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    });

    const emit = (m: string) => ff([m]);
    await assemble(p, undefined, emit, {});
    const rel = await renderAnimatic(p, undefined, emit, { bin, runFfmpeg, probe: probeMedia });

    const outAbs = path.join(prod, rel);
    expect(fs.existsSync(outAbs)).toBe(true);
    const info = await probeMedia(bin, outAbs);
    expect(info.durationSec).not.toBeNull();
    expect(info.durationSec!).toBeGreaterThan(5.2);
    expect(info.durationSec!).toBeLessThan(5.8);
    expect(info.hasAudio).toBe(true);
  });

  maybe("keeps clip audio in sync across many segments (no cumulative drift)", async () => {
    const bin = await resolveFfmpeg();
    if (!bin) throw new Error("no ffmpeg available for the e2e smoke test");

    // One beep clip reused for every shot: a 0.15s tone burst at the very
    // start, silence after. Any per-segment timing error (AAC priming,
    // frame quantization) compounds across concat boundaries, so the
    // last beep lands measurably late when sync is broken.
    const prod = path.join(root, "prod-sync");
    const write = (rel: string) => {
      const abs = path.join(prod, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      return abs;
    };
    const clip = write("videos/beep.mp4");
    const still = write("boards/0100/shot.jpg");
    await runFfmpeg(bin, ["-y", "-f", "lavfi", "-i", "color=c=white:s=320x180:r=24", "-frames:v", "1", still]);
    await runFfmpeg(bin, [
      "-y",
      "-f", "lavfi", "-i", "color=c=green:s=320x180:r=24",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=0.15:sample_rate=48000",
      "-af", "apad", "-t", "1.3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2",
      clip,
    ]);

    const N = 16;
    const DUR = 1.3; // deliberately NOT frame-aligned at 24fps (31.2 frames)
    const shots: ProductionShot[] = Array.from({ length: N }, (_, i) => ({
      id: `s${i}`,
      number: String((i + 1) * 100).padStart(4, "0"),
      audio: "",
      visual: "",
      artwork: "boards/0100/shot.jpg",
      videoPath: "videos/beep.mp4",
      durationSec: DUR,
    } as ProductionShot));
    const p = makeProd({
      meta: { id: "e2e-sync", name: "E2E Sync", folder: prod, createdAt: "", updatedAt: "", stepDone: 4, shotCount: N },
      currentStep: 5,
      visualStyle: "",
      styles: [],
      scenes: [{ number: 1, title: "T", shots } as ProductionScene],
      characters: [], products: [], openArt: { model: "auto", resolution: "1k" }, status: {},
      assembly: { fps: 24, width: 640, height: 360, exportDir: "out/assembly" },
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    });

    const rel = await renderAnimatic(p, undefined, () => {}, { bin, runFfmpeg, probe: probeMedia });
    const outAbs = path.join(prod, rel);
    const ends = await detectOnsets(bin, outAbs);
    // A beep at t=0 produces no leading silence_end (and silencedetect
    // may flush a final silence_end at EOF); a beep after a short
    // priming gap does. Normalize both shapes to N onsets.
    const firstDetected = ends.length > 0 && ends[0] < DUR / 2;
    const onsets = (firstDetected ? ends : [0, ...ends]).slice(0, N);
    // eslint-disable-next-line no-console
    console.log("beep onsets:", onsets.map((t) => t.toFixed(3)).join(" "));
    expect(onsets.length).toBe(N);
    // Each segment holds exactly round(1.3*24)=31 frames, so beep i must
    // land at i * 31/24 within a frame-ish tolerance — with NO growth
    // across the timeline.
    const segSec = Math.round(DUR * 24) / 24;
    onsets.forEach((t, i) => {
      expect(Math.abs(t - i * segSec)).toBeLessThan(0.06);
    });
    const info = await probeMedia(bin, outAbs);
    expect(info.durationSec!).toBeGreaterThan(N * segSec - 0.15);
    expect(info.durationSec!).toBeLessThan(N * segSec + 0.15);
  }, 180_000);
});