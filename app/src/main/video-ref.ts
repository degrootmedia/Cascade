/**
 * Video-reference 720p copies.
 *
 * Video references upload at native resolution — input-size caps vary per
 * model/mode/slot (e.g. Seedance element2video rejects anything above 720p)
 * and are not declared in any schema Cascade can read, so a universal
 * pre-emptive downscale silently degrades every clip for the few models
 * that need it. Instead, when a generation fails with an oversize video
 * reference attached, the user is offered a one-click 720p duplicate
 * reference + retry. This module is the transcode half of that flow:
 * file-to-file, with the ffmpeg seam injected (main wires the real binary;
 * tests fake it), mirroring video-still.ts. Pure node — no Electron import.
 */

/** Height of the user-approved 720p duplicate, and the threshold above which
 *  a failed submission offers the duplicate-and-retry action. */
export const VIDEO_REF_MAX_HEIGHT = 720;

/** Injected ffmpeg seam (main wires ffmpeg.ts; tests fake it). */
export interface VideoRef720Deps {
  resolveBin: () => Promise<string | null>;
  run: (bin: string, argv: string[]) => Promise<void>;
  probe: (bin: string, absPath: string) => Promise<{ width: number; height: number } | null>;
}

/** The duplicate reference's display name for a source reference name. */
export function ref720pName(sourceName: string): string {
  return `${sourceName.trim() || "Reference"}_720p`;
}

/**
 * Transcode `absSrc` to `absDest` (an .mp4 path) capped at 720p height
 * (aspect preserved, width even for H.264), reusing the recipe the retired
 * submit-time downscaler used. A source already within the cap is
 * re-encoded without scaling — never byte-copied — so the destination is
 * a real MP4 even when the source container isn't. Throws when no ffmpeg
 * is available or the source's dimensions can't be read — callers surface
 * the error and write nothing.
 */
export async function transcodeVideoFileTo720p(
  absSrc: string,
  absDest: string,
  deps: VideoRef720Deps
): Promise<void> {
  let bin: string | null = null;
  try {
    bin = await deps.resolveBin();
  } catch {
    bin = null;
  }
  if (!bin) throw new Error("Couldn't create the 720p copy — no video encoder is available.");
  const size = await deps.probe(bin, absSrc);
  if (!size) throw new Error("Couldn't read that video's dimensions, so no 720p copy was made.");
  const scale = size.height > VIDEO_REF_MAX_HEIGHT ? ["-vf", `scale=-2:${VIDEO_REF_MAX_HEIGHT}`] : [];
  await deps.run(bin, [
    "-hide_banner", "-nostdin", "-y",
    "-i", absSrc,
    ...scale,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac",
    "-movflags", "+faststart",
    absDest,
  ]);
}
