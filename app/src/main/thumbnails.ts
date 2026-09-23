/**
 * Reference thumbnails for the node graph — small compressed JPEGs served over
 * the cascade-media protocol (`?thumb=1`) so a list/canvas never decodes
 * full-resolution reference files just to paint a tile. Images are resized with
 * nativeImage; videos get a poster still extracted from a middle frame at 720p
 * via ffmpeg. The full-res file is untouched: zoom/lightbox URLs keep the
 * original, and prompt sends read the original from disk on the main side.
 *
 * Thumbs persist to a versioned on-disk cache (`<hash>-<mtimeMs>-<size>.jpg`
 * under a userData dir) so a large project's first graph open is fast on every
 * launch, not just the first. The version lives in the filename — an entry is
 * valid iff its version matches the source file's current stat, so there is
 * no stale-entry race; the Settings → "Regenerate thumbnail cache" action
 * pre-encodes every reference and prunes entries whose source is gone.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

// Soft dependency: resizing needs Electron's nativeImage, but this module
// must also load outside Electron (test harness). Without it, thumbnail
// requests fall through to the full file (like mcp.ts's chat thumbnails).
let nativeImage: typeof import("electron").nativeImage | undefined;
void import("electron")
  .then((m) => {
    nativeImage = m.nativeImage;
  })
  .catch(() => {});

/** Long-edge cap for reference-node tiles (node art is 64×48, shelf 42×32). */
export const REF_THUMB_MAX_EDGE = 256;
const REF_THUMB_JPEG_QUALITY = 65;
/** Video posters are a real frame the canvas can draw at size, so they cap at
 *  720p (landscape 1280×720) rather than the tiny list-tile edge. */
export const VIDEO_THUMB_MAX_W = 1280;
export const VIDEO_THUMB_MAX_H = 720;
const VIDEO_THUMB_JPEG_QUALITY = 3;

/** Video containers we can pull a poster frame from (ffmpeg decides support). */
const VIDEO_EXT_RX = /\.(mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|wmv|flv|3gp)$/i;

export function isVideoPath(absPath: string): boolean {
  return VIDEO_EXT_RX.test(absPath);
}

/** Injected ffmpeg seam (main wires the real binary; tests fake it). Video
 *  posters are the only path that needs it — image thumbs stay nativeImage. */
export interface VideoPosterDeps {
  resolveBin: () => Promise<string | null>;
  run: (bin: string, argv: string[]) => Promise<void>;
  probe: (bin: string, absPath: string) => Promise<{ durationSec: number | null; hasAudio: boolean }>;
}
let videoPosterDeps: VideoPosterDeps | null = null;

export function setVideoPosterDeps(deps: VideoPosterDeps | null): void {
  videoPosterDeps = deps;
}
/** Bounded memory cache: repeat requests skip the decode; the disk cache is
 *  the durable store. */
const thumbCache = new Map<string, { mtimeMs: number; size: number; jpeg: Buffer }>();
const THUMB_CACHE_MAX = 500;
/** Directory for the durable thumbnail cache (userData/thumb-cache). */
let thumbCacheDir: string | null = null;

/** Point the durable cache at a directory (main-process wiring; tests set a
 *  temp dir or null to disable disk caching). */
export function setThumbCacheDir(dir: string | null): void {
  thumbCacheDir = dir;
}

export function getThumbCacheDir(): string | null {
  return thumbCacheDir;
}

/** Current memory-cache size — tests use this to assert boundedness. */
export function refThumbCacheSize(): number {
  return thumbCache.size;
}

export function clearRefThumbCache(): void {
  thumbCache.clear();
}

/** Versioned disk filename for a thumbnail: the source's path hash plus its
 *  mtime+size, so a cache entry is valid exactly while its source is the same
 *  file. Pure — no I/O, testable. */
export function thumbDiskPath(cacheDir: string, absPath: string, st: { mtimeMs: number; size: number }): string {
  const hash = createHash("sha1").update(absPath).digest("hex");
  return path.join(cacheDir, `${hash}-${Math.round(st.mtimeMs)}-${st.size}.jpg`);
}

/** Decode → resize → compress the source file. Synchronous nativeImage work;
 *  callers yield between images so the main process stays responsive. */
function encodeThumb(absPath: string): Buffer | null {
  if (!nativeImage) return null;
  const img = nativeImage.createFromPath(absPath);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const longest = Math.max(width, height);
  const scale = longest > REF_THUMB_MAX_EDGE ? REF_THUMB_MAX_EDGE / longest : 1;
  const resized = scale < 1
    ? img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: "good" })
    : img;
  const jpeg = resized.toJPEG(REF_THUMB_JPEG_QUALITY);
  return jpeg && jpeg.length > 0 ? jpeg : null;
}

function remember(absPath: string, st: { mtimeMs: number; size: number }, jpeg: Buffer): void {
  if (thumbCache.size >= THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value;
    if (oldest !== undefined) thumbCache.delete(oldest);
  }
  thumbCache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, jpeg });
}

/** Extract a middle-frame poster (≤720p JPEG) from a video via ffmpeg. Null
 *  when no ffmpeg seam is wired, the binary is missing, or the extract fails
 *  (the caller then falls through to serving the full video). */
async function encodeVideoPoster(absPath: string): Promise<Buffer | null> {
  const deps = videoPosterDeps;
  if (!deps) return null;
  let bin: string | null = null;
  try {
    bin = await deps.resolveBin();
  } catch {
    bin = null;
  }
  if (!bin) return null;
  // Middle frame: seek to half the duration. An unknown duration falls back to
  // the first frame (still better than nothing).
  let durationSec: number | null = null;
  try {
    durationSec = (await deps.probe(bin, absPath)).durationSec;
  } catch {
    durationSec = null;
  }
  const seek = durationSec && durationSec > 0 ? durationSec / 2 : 0;
  const outDir = thumbCacheDir ?? os.tmpdir();
  try {
    await fs.promises.mkdir(outDir, { recursive: true });
  } catch {
    /* fall through to the temp path */
  }
  const out = path.join(outDir, `vposter-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  // Cap at 720p without upscaling smaller sources.
  const vf = `scale='min(${VIDEO_THUMB_MAX_W},iw)':'min(${VIDEO_THUMB_MAX_H},ih)':force_original_aspect_ratio=decrease`;
  const argv = [
    "-hide_banner", "-nostdin", "-y",
    "-ss", String(seek),
    "-i", absPath,
    "-frames:v", "1",
    "-vf", vf,
    "-q:v", String(VIDEO_THUMB_JPEG_QUALITY),
    "-update", "1",
    out,
  ];
  try {
    await deps.run(bin, argv);
    const jpeg = await fs.promises.readFile(out);
    return jpeg.length > 0 ? jpeg : null;
  } catch {
    return null;
  } finally {
    try { await fs.promises.unlink(out); } catch { /* best-effort */ }
  }
}

/** Ensure a thumbnail exists for `absPath` (memory → disk → encode), returning
 *  the JPEG and whether it was already on disk. Images go through nativeImage;
 *  videos through the ffmpeg poster seam. Null when the source isn't decodable
 *  or the needed encoder is unavailable (the caller falls through to the full
 *  file). */
export async function ensureRefThumbnail(absPath: string): Promise<{ jpeg: Buffer; fromDisk: boolean } | null> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(absPath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const mem = thumbCache.get(absPath);
  if (mem && mem.mtimeMs === st.mtimeMs && mem.size === st.size) return { jpeg: mem.jpeg, fromDisk: false };
  if (thumbCacheDir) {
    const diskPath = thumbDiskPath(thumbCacheDir, absPath, st);
    try {
      const jpeg = await fs.promises.readFile(diskPath);
      remember(absPath, st, jpeg);
      return { jpeg, fromDisk: true };
    } catch {
      /* cache miss → encode below */
    }
  }
  const jpeg = isVideoPath(absPath) ? await encodeVideoPoster(absPath) : encodeThumb(absPath);
  if (!jpeg) return null;
  if (thumbCacheDir) {
    try {
      await fs.promises.mkdir(thumbCacheDir, { recursive: true });
      await fs.promises.writeFile(thumbDiskPath(thumbCacheDir, absPath, st), jpeg);
    } catch {
      /* cache write is best-effort */
    }
  }
  remember(absPath, st, jpeg);
  return { jpeg, fromDisk: false };
}

/** Compressed JPEG thumbnail for an absolute reference path (image, or a
 *  video's middle-frame poster), or null — the protocol handler falls through
 *  to the full file on null. */
export async function loadRefThumbnail(absPath: string): Promise<Buffer | null> {
  const hit = await ensureRefThumbnail(absPath);
  return hit?.jpeg ?? null;
}

/** Pre-encode thumbnails for the given reference media — images and videos
 *  (Settings → Regenerate thumbnail cache) — and prune disk entries whose
 *  source file no longer exists among them. Idempotent: existing valid entries
 *  are reused.
 *  Yields periodically so the main process stays responsive on large projects. */
export async function regenerateRefThumbnails(absPaths: string[]): Promise<{ generated: number; fromDisk: number; failed: number }> {
  const result = { generated: 0, fromDisk: 0, failed: 0 };
  const seen = new Set<string>();
  const keep = new Set<string>();
  const statCache = new Map<string, { mtimeMs: number; size: number } | null>();
  const statOf = async (absPath: string) => {
    if (statCache.has(absPath)) return statCache.get(absPath);
    let st: { mtimeMs: number; size: number } | null = null;
    try {
      const s = await fs.promises.stat(absPath);
      if (s.isFile()) st = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      /* missing source → stale entry */
    }
    statCache.set(absPath, st);
    return st;
  };
  for (let i = 0; i < absPaths.length; i++) {
    const absPath = absPaths[i];
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    if (i % 16 === 0) await new Promise<void>((r) => setImmediate(r));
    const st = await statOf(absPath);
    if (st && thumbCacheDir) keep.add(thumbDiskPath(thumbCacheDir, absPath, st));
    const hit = await ensureRefThumbnail(absPath);
    if (!hit) { result.failed++; continue; }
    if (hit.fromDisk) result.fromDisk++;
    else result.generated++;
  }
  if (thumbCacheDir) {
    try {
      const existing = await fs.promises.readdir(thumbCacheDir);
      for (const name of existing) {
        const full = path.join(thumbCacheDir, name);
        if (!keep.has(full)) {
          try { await fs.promises.unlink(full); } catch { /* raced or locked */ }
        }
      }
    } catch {
      /* cache dir absent → nothing to prune */
    }
  }
  return result;
}