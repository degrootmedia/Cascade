/**
 * ffmpeg seam — locating the binary and running it.
 *
 * Resolution order: bundled `ffmpeg-static` first (dev: node_modules; packaged:
 * the asar-unpacked copy under resources/), then an `ffmpeg` found on PATH.
 * Pure node — no electron import — so the module loads in vitest; the assembly
 * module injects these as its run/probe seam.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type FfmpegEmit = (message: string, level?: "info" | "error" | "done") => void;

function ffmpegExeName(): string {
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

/** Locate an ffmpeg binary, or null when none is available. */
export async function resolveFfmpeg(): Promise<string | null> {
  const candidates: string[] = [];
  try {
    const mod = await import("ffmpeg-static");
    const p = (mod as { default?: string }).default ?? (mod as unknown as string);
    if (typeof p === "string" && p) {
      // Packaged: electron-builder packs deps into app.asar, but binaries must
      // live outside it (asarUnpack) — swap the prefix so the unpacked copy is used.
      candidates.push(p.includes("app.asar") ? p.replace("app.asar", "app.asar.unpacked") : p);
      candidates.push(p);
    }
  } catch {
    /* ffmpeg-static not installed */
  }
  // extraResources fallback (electron-builder "ffmpeg" resource) — only
  // meaningful inside Electron, where resourcesPath is defined.
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "ffmpeg", ffmpegExeName()));
  }
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* keep looking */
    }
  }
  return findOnPath(ffmpegExeName());
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

/** Spawn ffmpeg; resolve on exit 0, reject with the stderr tail otherwise. */
export function runFfmpeg(bin: string, argv: string[], emit?: FfmpegEmit): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(new Error(`Failed to run ffmpeg: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split("\n").slice(-6).join("\n");
      reject(new Error(tail || `ffmpeg exited with code ${code}`));
    });
  });
}

/** Probe a media file's duration and whether it has an audio stream, by
 *  reading ffmpeg's `-i` info output. Never throws; nulls on failure. */
export async function probeMedia(bin: string, absPath: string): Promise<{ durationSec: number | null; hasAudio: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["-hide_banner", "-nostdin", "-i", absPath], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", () => resolve({ durationSec: null, hasAudio: false }));
    child.on("close", () => {
      const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      const durationSec = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null;
      const hasAudio = /Audio:\s*(aac|mp3|pcm|opus|vorbis|flac|alac|wma|amr)/i.test(stderr);
      resolve({ durationSec, hasAudio });
    });
  });
}