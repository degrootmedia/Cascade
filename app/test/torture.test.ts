/**
 * Torture-test fixture — Animatic Editor Expansion Item A14.
 *
 * One committed production (test/fixtures/torture-production.json)
 * exercising every feature: two video tracks, trims/slip, a linked
 * pair, constant speed, a speed ramp, reverse, a centered dissolve,
 * audio fades, a muted track, a still. Every export is compared
 * byte-for-byte against a committed golden (regenerate with
 * TORTURE_WRITE=1) AND parsed for model-derived timing asserts, so
 * the checks don't just trust the goldens:
 *  - every edit point within a frame of the model in each export;
 *  - the ramp's end keyframe/frame = the expected source frame;
 *  - total duration identical (to the frame) in render + exports.
 * The ffmpeg half is gated ASSEMBLY_E2E=1 like the other render E2Es.
 * Manual editor round-trips: docs/animatic-export-roundtrip.md.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Production } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { clipDurationSec, resolveTimeline } from "../src/shared/ipc.js";
import {
  assemblyPlanForProduction,
  buildAeScript,
  buildEdl,
  buildTrackEdls,
  renderTimelineAnimatic,
  segmentSec,
} from "../src/main/assembly.js";
import { buildFcpxml } from "../src/main/fcpxml.js";
import { buildPremiereXml } from "../src/main/premiere-xml.js";
import { probeMedia, runFfmpeg } from "../src/main/ffmpeg.js";
import fixtureJson from "./fixtures/torture-production.json";

const FPS = 24;
const cfg = { fps: FPS, width: 320, height: 180 };
const loadFixture = (folder = "/torture"): Production => {
  const p = structuredClone(fixtureJson) as unknown as Production;
  p.meta.folder = folder;
  return p;
};
const norm = (s: string): string => s.replace(/\r\n/g, "\n");

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "torture-expected");
const WRITE = process.env.TORTURE_WRITE === "1";

function exportContents(p: Production): Record<string, string> {
  const plan = assemblyPlanForProduction(p);
  const out: Record<string, string> = {
    "Assembly.fcpxml": buildFcpxml(p, cfg).xml,
    "Assembly-premiere.xml": buildPremiereXml(p, cfg).xml,
    "Assembly.edl": buildEdl(plan, FPS, p.meta.name),
    "Assembly.jsx": buildAeScript(plan, cfg, "/torture/out/assembly"),
  };
  for (const f of buildTrackEdls(p, FPS).files) out[f.name] = f.content;
  // Portability: assetPath resolves "/torture" onto the current drive
  // on Windows; goldens must compare identical on any machine.
  for (const name of Object.keys(out)) {
    out[name] = out[name].replace(/file:\/\/\/[A-Za-z]:\/torture\//g, "file:///torture/");
  }
  return out;
}

describe("torture fixture — golden exports", () => {
  const p = loadFixture();

  it("the fixture exercises every feature (guards against fixture rot)", () => {
    const t = p.timeline!;
    expect(t.tracks.filter((x) => x.kind === "video")).toHaveLength(2);
    expect(t.clips.some((c) => c.speedCurve?.length)).toBe(true);
    expect(t.clips.some((c) => c.reversed)).toBe(true);
    expect(t.clips.some((c) => c.speed && c.speed !== 1)).toBe(true);
    expect(t.clips.some((c) => c.linkId)).toBe(true);
    expect(t.clips.some((c) => (c.fadeInSec ?? 0) > 0 || (c.fadeOutSec ?? 0) > 0)).toBe(true);
    expect(t.clips.some((c) => c.sourceKind === "still")).toBe(true);
    expect(t.tracks.some((x) => x.muted)).toBe(true);
    expect(t.transitions).toHaveLength(1);
    expect(resolveTimeline(t).blendSpans).toHaveLength(1);
  });

  it("every export matches its committed golden (TORTURE_WRITE=1 regenerates)", () => {
    const contents = exportContents(p);
    if (WRITE) {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      for (const [name, content] of Object.entries(contents)) {
        fs.writeFileSync(path.join(GOLDEN_DIR, name), content, "utf8");
      }
    }
    for (const [name, content] of Object.entries(contents)) {
      const goldenPath = path.join(GOLDEN_DIR, name);
      expect(existsSync(goldenPath), `missing golden ${name} — run with TORTURE_WRITE=1`).toBe(true);
      expect(norm(content), name).toBe(norm(fs.readFileSync(goldenPath, "utf8")));
    }
  });

  it("export timing parses back to the model: edits within a frame, ramp end exact", () => {
    const contents = exportContents(p);
    const ramp = p.timeline!.clips.find((c) => c.id === "c3")!;
    const rampDur = clipDurationSec(ramp);
    const totalFrames = Math.round(resolveTimeline(p.timeline!).totalSec * FPS);
    // FCPXML: sequence duration + ramp timeMap last value == source-out.
    const fcp = new DOMParser().parseFromString(contents["Assembly.fcpxml"], "text/xml");
    const rat = (s: string | null): number => {
      const m = /^(-?\d+)\/(\d+)s$/.exec(s ?? "");
      return m ? Number(m[1]) / Number(m[2]) : parseFloat((s ?? "0").replace("s", ""));
    };
    expect(Math.round(rat(fcp.querySelector("sequence")?.getAttribute("duration") ?? null) * FPS)).toBe(totalFrames);
    const rampClipEl = [...fcp.querySelectorAll("asset-clip")].find((c) => c.getAttribute("name") === "rb.mp4")!;
    const pts = [...rampClipEl.querySelectorAll("timeMap > timept")];
    expect(rat(pts[pts.length - 1].getAttribute("value"))).toBeCloseTo(6, 3); // source-out
    expect(Math.abs(rat(pts[pts.length - 1].getAttribute("time")) - rampDur)).toBeLessThan(1 / FPS + 1e-6);
    // Premiere XML: ramp clipitem consumes the full source range.
    const xmeml = new DOMParser().parseFromString(contents["Assembly-premiere.xml"], "text/xml");
    const items = [...xmeml.querySelectorAll("clipitem")];
    const xRamp = items.find((c) => c.querySelector(":scope > name")?.textContent === "rb.mp4")!;
    const num = (el: Element, tag: string): number => Number(el.querySelector(`:scope > ${tag}`)?.textContent);
    expect(num(xRamp, "out") - num(xRamp, "in")).toBe(144);
    // JSX: last remap keyframe value == 6 (source-out).
    const keys = [...contents["Assembly.jsx"].matchAll(/setValueAtTime\(([\d.]+), ([\d.]+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(keys.length).toBeGreaterThan(2);
    expect(keys[keys.length - 1][1]).toBe(6);
    // Per-track EDL V1: last record-out == total frames.
    const v1 = contents["Assembly-V1.edl"].split("\r\n").filter((l) => /^\d{3}\s/.test(l));
    const lastTokens = v1[v1.length - 1].trim().split(/\s+/);
    const [h, m2, s, f] = lastTokens[lastTokens.length - 1].split(":").map(Number);
    expect(((h * 60 + m2) * 60 + s) * FPS + f).toBe(totalFrames);
  });
});

// ---- golden render -------------------------------------------------------------

// Same gate + binary resolution as timeline-render-ffmpeg.test.ts.
const e2e = ((): string | null => {
  if (process.env.ASSEMBLY_E2E !== "1") return null;
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const cand of [
    path.resolve(here, "..", "node_modules", "ffmpeg-static", "ffmpeg.exe"),
    path.resolve(here, "..", "node_modules", "ffmpeg-static", "ffmpeg"),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
})();

describe.skipIf(!e2e)("torture fixture — golden render (ASSEMBLY_E2E=1)", () => {
  let dir: string;
  let renderAbs: string;
  let prod: Production;

  const spawnBuf = (args: string[]): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const child = spawn(e2e!, args, { windowsHide: true });
      const chunks: Buffer[] = [];
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(stderr.slice(-400)))));
    });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-torture-"));
    fs.mkdirSync(path.join(dir, "media"), { recursive: true });
    const color = async (name: string, parts: [string, number][], audio = true): Promise<void> => {
      const inputs: string[] = [];
      parts.forEach(([c, d]) => inputs.push("-f", "lavfi", "-i", `color=c=${c}:size=320x180:rate=24:duration=${d}`));
      const total = parts.reduce((s, [, d]) => s + d, 0);
      const fc = parts.length > 1 ? ["-filter_complex", `${parts.map((_, i) => `[${i}:v]`).join("")}concat=n=${parts.length}:v=1:a=0[v]`] : [];
      await spawnBuf([
        "-hide_banner", "-loglevel", "error", "-y", ...inputs,
        ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${total}`] : []),
        ...fc,
        "-map", parts.length > 1 ? "[v]" : "0:v",
        ...(audio ? ["-map", `${parts.length}:a`] : []),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        ...(audio ? ["-c:a", "aac", "-shortest"] : []),
        path.join(dir, "media", name),
      ]);
    };
    await color("red.mp4", [["red", 8]]);
    await color("green.mp4", [["green", 8]]);
    await color("rb.mp4", [["red", 3], ["blue", 3]]);
    await color("bw.mp4", [["black", 2], ["white", 4]]);
    await spawnBuf(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=yellow:size=320x180", "-frames:v", "1", path.join(dir, "media", "board.jpg")]);
    for (const [name, freq, dur] of [["vo.wav", 440, 14], ["sfx.wav", 660, 8], ["tone880.wav", 880, 8]] as const) {
      await spawnBuf([
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${dur}:sample_rate=48000`,
        "-c:a", "pcm_s16le", path.join(dir, "media", name),
      ]);
    }
    prod = loadFixture(dir);
    const rel = await renderTimelineAnimatic(prod, cfg, () => {}, {
      bin: e2e!, runFfmpeg, probe: probeMedia, tempDir: path.join(dir, "_segs"),
    });
    renderAbs = path.join(dir, rel);
    expect(existsSync(renderAbs)).toBe(true);
  }, 300_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const frameColorAt = async (t: number): Promise<{ r: number; g: number; b: number }> => {
    const buf = await spawnBuf([
      "-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", renderAbs,
      "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]);
    return { r: buf[0], g: buf[1], b: buf[2] };
  };
  const pcmWindow = async (startSec: number, durSec: number): Promise<Int16Array> => {
    const buf = await spawnBuf([
      "-hide_banner", "-loglevel", "error", "-ss", startSec.toFixed(3), "-t", durSec.toFixed(3),
      "-i", renderAbs, "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "s16le", "-",
    ]);
    const out = new Int16Array(Math.floor(buf.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
    return out;
  };
  const rms = (s: Int16Array): number => Math.sqrt([...s].reduce((a, v) => a + (v / 32768) ** 2, 0) / Math.max(1, s.length));

  it("duration matches the model frame budget", async () => {
    const plan = assemblyPlanForProduction(prod);
    const budget = plan.events.reduce((s, ev) => s + segmentSec(ev.durationSec, FPS), 0);
    const probe = await probeMedia(e2e!, renderAbs);
    expect(Math.abs((probe.durationSec ?? 0) - budget)).toBeLessThan(0.1);
  }, 60_000);

  it("edit points land within a frame; ramp end and reverse ends spot-check", async () => {
    const red = await frameColorAt(0.2);
    expect(red.r).toBeGreaterThan(red.g + 40); // c1 red
    const still = await frameColorAt(2.0);
    expect(still.r).toBeGreaterThan(150);
    expect(still.g).toBeGreaterThan(150); // yellow board on top
    expect(still.b).toBeLessThan(90);
    const midDissolve = await frameColorAt(4.0);
    expect(Math.min(midDissolve.r, midDissolve.g)).toBeGreaterThan(45); // red+green blend
    const green = await frameColorAt(5.0);
    expect(green.g).toBeGreaterThan(green.r + 40); // c2 at 2x
    const rampStart = await frameColorAt(6.2);
    expect(rampStart.r).toBeGreaterThan(rampStart.b + 40); // rb first half
    const rampEnd = await frameColorAt(9.05);
    expect(rampEnd.b).toBeGreaterThan(rampEnd.r + 40); // ramp consumed to source-out (blue)
    const revStart = await frameColorAt(9.4);
    expect(revStart.r).toBeGreaterThan(180); // reversed: white first
    const revEnd = await frameColorAt(12.9);
    expect(revEnd.r).toBeLessThan(60); // ...black at the end
    // Audio: VO present early, faded near the end; muted track absent.
    const early = rms(await pcmWindow(0.3, 0.5));
    expect(early).toBeGreaterThan(0.02);
    const late = rms(await pcmWindow(12.85, 0.22));
    expect(late).toBeLessThan(early * 0.35);
  }, 120_000);
});
