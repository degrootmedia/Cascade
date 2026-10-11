/**
 * Voice seam — locating the bundled whisper.cpp binary, fetching its ggml
 * model on first use, and transcribing 16 kHz mono PCM.
 *
 * Mirrors `ffmpeg.ts`: pure node (no electron import) so the module loads in
 * vitest, with the binary/model/run paths injected as seams. The IPC handler
 * supplies the real directories; these functions stay host-agnostic.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WhisperModel } from "../shared/voice.js";

export { coerceWhisperModel } from "../shared/voice.js";

/** Hugging Face host for the ggml-format Whisper models whisper.cpp consumes.
 *  The converted models live at the repository root (not under `models/`). */
const MODEL_URL_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/** whisper.cpp's CLI executable name per platform. */
export function whisperExeName(platform: string = process.platform): string {
  return platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
}

/** Where a ggml model file for `model` lives inside a model directory. */
export function whisperModelFilename(model: WhisperModel): string {
  return `ggml-${model}.bin`;
}

export function whisperModelPath(modelDir: string, model: WhisperModel): string {
  return path.join(modelDir, whisperModelFilename(model));
}

/** Whether a non-empty model file exists (a partial `.part` download never
 *  counts as ready). */
export function isModelReady(modelDir: string, model: WhisperModel): boolean {
  try {
    const p = whisperModelPath(modelDir, model);
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

function findOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    try {
      const full = path.join(d, name);
      if (fs.existsSync(full)) return full;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Locate the whisper.cpp CLI. Resolution order: explicit override (Settings),
 * `CASCADE_WHISPER_BIN`, the packaged resource dir (`process.resourcesPath`),
 * the repo's `resources/whisper` (dev), then PATH. Returns null when none is
 * available — the UI then hides voice input.
 */
export function resolveWhisperBinary(override?: string | null): string | null {
  const exe = whisperExeName();
  const candidates: string[] = [];
  if (override) candidates.push(override);
  if (process.env.CASCADE_WHISPER_BIN) candidates.push(process.env.CASCADE_WHISPER_BIN);
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "whisper", exe));
  }
  // Dev: run from the repo `app/` dir (npm run dev) or the repo root.
  candidates.push(path.join(process.cwd(), "resources", "whisper", exe));
  candidates.push(path.join(process.cwd(), "app", "resources", "whisper", exe));
  // Built main lives at `<app>/out/main`, so `../../resources/whisper` is the
  // repo resources dir. `__dirname` is absent under the ESM test runner.
  try {
    candidates.push(path.join(__dirname, "..", "..", "resources", "whisper", exe));
  } catch {
    /* no __dirname (ESM) */
  }
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* keep looking */
    }
  }
  return findOnPath(exe);
}

// ------------------------------------------------------------- model download

export type ModelProgress = (received: number, total: number) => void;

/** Injectable file-download seam (the test surface for `ensureWhisperModel`). */
export type FetchToFile = (url: string, dest: string, onProgress?: ModelProgress) => Promise<void>;

/** Default downloader: stream `fetch` bodies to disk, reporting progress. */
export const fetchToFile: FetchToFile = async (url, dest, onProgress) => {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0) || 0;
  const out = createWriteStream(dest);
  let received = 0;
  try {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const buf = Buffer.from(value);
      if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", () => r()));
      received += buf.length;
      onProgress?.(received, total);
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
};

/**
 * Ensure the ggml model for `model` is present in `modelDir`, downloading it
 * (to a `.part` file, then atomically renaming) on first use. Returns the path.
 */
export async function ensureWhisperModel(
  modelDir: string,
  model: WhisperModel,
  onProgress?: ModelProgress,
  fetchTo: FetchToFile = fetchToFile
): Promise<string> {
  const dest = whisperModelPath(modelDir, model);
  if (isModelReady(modelDir, model)) return dest;
  fs.mkdirSync(modelDir, { recursive: true });
  const tmp = `${dest}.part`;
  try {
    await fetchTo(`${MODEL_URL_BASE}/${whisperModelFilename(model)}`, tmp, onProgress);
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw e;
  }
  return dest;
}

// ------------------------------------------------------------------ WAV + run

/** Wrap raw little-endian 16-bit mono PCM in a minimal WAV container. whisper
 *  requires 16 kHz mono; the renderer resamples before sending. */
export function pcm16ToWav(pcm: Int16Array, sampleRate = 16000): Buffer {
  const dataBytes = pcm.length * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes);
  return Buffer.concat([header, data]);
}

/** Normalize whisper-cli's plain-text output into one line (drop timestamps and
 *  blank lines). whisper emits each segment on its own line with `-otxt`. */
export function parseWhisperText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\[[0-9:.\s\-–>]+\]\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Spawn seam: run a command to completion, resolving on exit 0. */
export type RunFn = (bin: string, argv: string[], opts?: { cwd?: string; signal?: AbortSignal }) => Promise<void>;

/** Default spawn implementation (captures stderr for the failure message). */
export const spawnRun: RunFn = (bin, argv, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { windowsHide: true, cwd: opts.cwd, signal: opts.signal });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (err) => reject(new Error(`Failed to run whisper: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split("\n").slice(-4).join("\n") || `whisper exited with code ${code}`));
    });
  });

export interface TranscribeOptions {
  /** Language hint (e.g. "en"). Omitted = auto-detect. */
  language?: string;
  /** CPU threads; defaults to (cores - 1), capped at 8. */
  threads?: number;
}

function defaultThreads(): number {
  const cores = os.cpus()?.length ?? 4;
  return Math.max(1, Math.min(8, cores - 1));
}

/**
 * Transcribe a 16 kHz mono WAV file, writing `<outBase>.txt` via whisper-cli's
 * `-otxt -of` and reading it back. `run` is the spawn seam (faked in tests).
 */
export async function transcribeWav(
  opts: { bin: string; modelPath: string; wavPath: string; outBase: string; language?: string; threads?: number },
  run: RunFn = spawnRun
): Promise<string> {
  const argv = [
    "-m", opts.modelPath,
    "-f", opts.wavPath,
    "-otxt",
    "-of", opts.outBase,
    "-t", String(opts.threads ?? defaultThreads()),
    "--no-prints",
  ];
  if (opts.language) argv.push("-l", opts.language);
  await run(opts.bin, argv, { cwd: path.dirname(opts.outBase) });
  const txtPath = `${opts.outBase}.txt`;
  let raw = "";
  try {
    raw = fs.readFileSync(txtPath, "utf8");
  } finally {
    try {
      fs.unlinkSync(txtPath);
    } catch {
      /* best-effort cleanup */
    }
  }
  return parseWhisperText(raw);
}
