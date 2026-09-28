/**
 * Video stills — save the frame a video is paused on as a reference image.
 *
 * The renderer reads the paused `currentTime` from the lightbox's `<video>`
 * element and sends it with the video's workspace-relative path; main extracts
 * exactly that frame via ffmpeg (accurate output-seeking, full resolution) and
 * stores it as an image reference named `Video still_00`, `_01`, … (the same
 * first-free-suffix scheme as `savedRefName`, starting at 00 per the user's
 * choice). Pure node — no Electron import — so it loads in vitest; the ffmpeg
 * binary/runner arrive through the injected seam (same shape as the thumbnail
 * poster's deps, minus the probe, which a still doesn't need).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Injected ffmpeg seam (main wires the real binary; tests fake it). */
export interface VideoStillDeps {
  resolveBin: () => Promise<string | null>;
  run: (bin: string, argv: string[]) => Promise<void>;
}

/** JPEG quality for extracted stills (higher than the 720p poster thumbs). */
const VIDEO_STILL_JPEG_QUALITY = 2;

/**
 * The reference name for a saved video still: "Video still_00", then
 * "Video still_01", … — the first suffix no existing reference already uses
 * (case-insensitive). Pure; exposed for tests.
 */
export function videoStillName(existingNames: Iterable<string>): string {
  const taken = new Set<string>();
  for (const n of existingNames) taken.add(n.trim().toLowerCase());
  for (let i = 0; ; i++) {
    const candidate = `Video still_${String(i).padStart(2, "0")}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Extract one full-resolution JPEG frame at `timeSec` from the video at
 * `absVideoPath`. The seek is an OUTPUT seek (`-i … -ss t`) so the frame is
 * the exact paused timestamp, not the nearest fast-seek keyframe the thumbnail
 * posters use. Resolves with the JPEG bytes; rejects when ffmpeg is missing or
 * the extract fails (callers surface the error, nothing is written).
 */
export async function extractVideoStillFrame(
  absVideoPath: string,
  timeSec: number,
  deps: VideoStillDeps,
): Promise<Buffer> {
  let bin: string | null = null;
  try {
    bin = await deps.resolveBin();
  } catch {
    bin = null;
  }
  if (!bin) throw new Error("Couldn't grab that frame — no video encoder is available.");
  const seek = Number.isFinite(timeSec) && timeSec > 0 ? timeSec : 0;
  const out = path.join(
    os.tmpdir(),
    `cascade-still-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
  );
  const argv = [
    "-hide_banner", "-nostdin", "-y",
    "-i", absVideoPath,
    "-ss", String(seek),
    "-frames:v", "1",
    "-q:v", String(VIDEO_STILL_JPEG_QUALITY),
    "-update", "1",
    out,
  ];
  try {
    await deps.run(bin, argv);
    const jpeg = await fs.promises.readFile(out);
    if (!jpeg.length) throw new Error("The frame came back empty — try pausing on a different moment.");
    return jpeg;
  } catch (e) {
    if (e instanceof Error) throw e;
    throw new Error("Couldn't grab that frame from the video.");
  } finally {
    try { await fs.promises.unlink(out); } catch { /* best-effort temp cleanup */ }
  }
}
