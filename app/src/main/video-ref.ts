/**
 * Video-reference resizing.
 *
 * Every dropped video reference is downscaled to at most 720p before upload,
 * regardless of model — some models cap input video *elements* (e.g. Seedance
 * element2video rejects anything above 720p) even when the generated output can
 * be 4K, and a single ceiling keeps both media vendors on the same path.
 * Pure node — the ffmpeg seam is imported, and any failure (no
 * ffmpeg, unreadable clip) falls through to the original data URL.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { probeVideoSize, resolveFfmpeg, runFfmpeg } from "./ffmpeg.js";

const DATA_URL_RX = /^data:([^;]+);base64,(.+)$/s;

const EXT_FOR_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
};

/** Input-video-reference ceiling: every video ref is capped to this height
 *  before upload, regardless of model. */
export const VIDEO_REF_MAX_HEIGHT = 720;

/**
 * Downscale a `data:video/...` URL so its height is at most `maxHeight`,
 * preserving aspect ratio (width rounded to an even number for H.264).
 * Returns the original data URL unchanged for non-video input, when it is
 * already within the limit, when ffmpeg is unavailable, or on any failure.
 */
export async function resizeVideoRefToHeight(dataUrl: string, maxHeight: number): Promise<string> {
  const m = DATA_URL_RX.exec(dataUrl);
  if (!m || !m[1].startsWith("video/")) return dataUrl;
  if (!Number.isFinite(maxHeight) || maxHeight <= 0) return dataUrl;
  const bin = await resolveFfmpeg();
  if (!bin) return dataUrl;

  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const ext = EXT_FOR_MIME[m[1]] ?? "mp4";
  const src = path.join(os.tmpdir(), `cascade-videoref-${tag}.${ext}`);
  const out = path.join(os.tmpdir(), `cascade-videoref-${tag}-${maxHeight}.mp4`);
  try {
    fs.writeFileSync(src, Buffer.from(m[2], "base64"));
    const size = await probeVideoSize(bin, src);
    if (!size || size.height <= maxHeight) return dataUrl;
    await runFfmpeg(bin, [
      "-hide_banner", "-nostdin", "-y",
      "-i", src,
      "-vf", `scale=-2:${maxHeight}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac",
      "-movflags", "+faststart",
      out,
    ]);
    const bytes = fs.readFileSync(out);
    return bytes.length ? `data:video/mp4;base64,${bytes.toString("base64")}` : dataUrl;
  } catch {
    return dataUrl;
  } finally {
    for (const f of [src, out]) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
  }
}

/**
 * Downscale a `data:video/...` URL to the universal 720p ceiling.
 * Thin wrapper over `resizeVideoRefToHeight` so call sites can't drift
 * per-model — pass only the data URL.
 */
export function resizeVideoRef(dataUrl: string): Promise<string> {
  return resizeVideoRefToHeight(dataUrl, VIDEO_REF_MAX_HEIGHT);
}
