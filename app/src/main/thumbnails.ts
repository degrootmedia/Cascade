/**
 * Reference thumbnails for the node graph — small compressed JPEGs served over
 * the cascade-media protocol (`?thumb=<tier>`) so a list/canvas never decodes
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
/** Every thumbnail long-edge the protocol may serve (LOD tiers). The
 *  default `?thumb=1` is the first tier; larger tiers serve canvas nodes
 *  drawn bigger than a list tile (moodboard zoom), still far cheaper to
 *  decode/raster than the full-resolution source. */
export const REF_THUMB_TIERS = [256, 512, 1024] as const;

/** Whitelisted `?thumb=` param → long edge, or null (= serve full file).
 *  `"1"` is the legacy list-tile tier. Pure — the protocol handler and
 *  tests share it. */
export function thumbEdgeForParam(param: string | null): number | null {
  if (param === "1") return REF_THUMB_MAX_EDGE;
  const n = Number(param);
  return (REF_THUMB_TIERS as readonly number[]).includes(n) ? n : null;
}

/** Normalize an internal edge request to a real tier (default 256). */
function normalizeThumbEdge(edge: number | undefined): number {
  return edge !== undefined && (REF_THUMB_TIERS as readonly number[]).includes(edge) ? edge : REF_THUMB_MAX_EDGE;
}
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
 *  the durable store. Keyed by `absPath#edge` so LOD tiers never collide. */
const thumbCache = new Map<string, { mtimeMs: number; size: number; jpeg: Buffer }>();
const THUMB_CACHE_MAX = 900;
const THUMB_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let thumbCacheBytes = 0;

function thumbCacheKey(absPath: string, edge: number): string {
  return `${absPath}#${edge}`;
}
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
  thumbCacheBytes = 0;
  masterPosterCache.clear();
  posterFailures.clear();
}

/** In-flight thumbnail encodes, keyed like the cache: simultaneous requests
 *  for the same tile (a graph mounting many tiles of one clip, a remount
 *  storm) share ONE encode instead of spawning one ffmpeg per request. */
const thumbInFlight = new Map<string, Promise<{ jpeg: Buffer; fromDisk: boolean } | null>>();

/** Bounded ffmpeg poster concurrency: poster extraction is a subprocess +
 *  a video decode, and an unbounded burst (a 20-take history grid) used to
 *  saturate CPU/disk and stall the very UI asking for the posters. */
export const POSTER_CONCURRENCY = 3;
let posterActive = 0;
const posterWaiters: Array<() => void> = [];

async function withPosterSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (posterActive >= POSTER_CONCURRENCY) {
    await new Promise<void>((resolve) => posterWaiters.push(resolve));
  }
  posterActive++;
  try {
    return await fn();
  } finally {
    posterActive--;
    posterWaiters.shift()?.();
  }
}

/** The extracted 720p master poster per source version, so deriving the
 *  three LOD tiers runs ffmpeg once, not once per tier. Small and bounded —
 *  the disk cache is the durable store across launches. */
const masterPosterCache = new Map<string, Buffer>();
const POSTER_MASTER_MAX = 24;

/** Clips whose poster extract failed recently (absPath → expiry): a broken
 *  or undecodable file must not re-spawn ffmpeg on every repaint. */
const posterFailures = new Map<string, number>();
const POSTER_FAILURE_TTL_MS = 30_000;

function posterVersionKey(absPath: string, st: { mtimeMs: number; size: number }): string {
  return `${absPath}#${Math.round(st.mtimeMs)}-${st.size}`;
}

/** Versioned disk filename for a thumbnail: the source's path hash plus its
 *  mtime+size and the tier edge, so a cache entry is valid exactly while
 *  its source is the same file. Pure — no I/O, testable. */
export function thumbDiskPath(cacheDir: string, absPath: string, st: { mtimeMs: number; size: number }, edge: number = REF_THUMB_MAX_EDGE): string {
  const hash = createHash("sha1").update(absPath).digest("hex");
  return path.join(cacheDir, `${hash}-${Math.round(st.mtimeMs)}-${st.size}-${edge}.jpg`);
}

/** Decode → resize → compress the source file at one tier. Synchronous
 *  nativeImage work; callers yield between images so the main process stays
 *  responsive. */
function encodeThumb(absPath: string, maxEdge: number): Buffer | null {
  if (!nativeImage) return null;
  const img = nativeImage.createFromPath(absPath);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const longest = Math.max(width, height);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const resized = scale < 1
    ? img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: "good" })
    : img;
  const jpeg = resized.toJPEG(REF_THUMB_JPEG_QUALITY);
  return jpeg && jpeg.length > 0 ? jpeg : null;
}

function remember(absPath: string, edge: number, st: { mtimeMs: number; size: number }, jpeg: Buffer): void {
  const key = thumbCacheKey(absPath, edge);
  const prev = thumbCache.get(key);
  if (prev) thumbCacheBytes -= prev.jpeg.length;
  thumbCache.delete(key);
  thumbCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, jpeg });
  thumbCacheBytes += jpeg.length;
  while (thumbCache.size > THUMB_CACHE_MAX || thumbCacheBytes > THUMB_CACHE_MAX_BYTES) {
    const oldest = thumbCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = thumbCache.get(oldest);
    thumbCache.delete(oldest);
    if (evicted) thumbCacheBytes -= evicted.jpeg.length;
  }
}

/** Downscale an already-encoded JPEG (a 720p video poster) to a smaller
 *  tier without re-running ffmpeg. Never upscales; without nativeImage
 *  the master poster is served as-is (still one bounded bitmap). */
function resizeJpegBuffer(jpeg: Buffer, maxEdge: number): Buffer {
  if (!nativeImage) return jpeg;
  const img = nativeImage.createFromBuffer(jpeg);
  if (img.isEmpty()) return jpeg;
  const { width, height } = img.getSize();
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return jpeg;
  const scale = maxEdge / longest;
  const out = img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: "good" }).toJPEG(REF_THUMB_JPEG_QUALITY + 15);
  return out && out.length > 0 ? out : jpeg;
}

/** Encode one tier: images resize directly; videos extract the 720p
 *  master poster once and downscale it to the tier. */
async function encodeThumbFor(absPath: string, edge: number, st: { mtimeMs: number; size: number }): Promise<Buffer | null> {
  if (!isVideoPath(absPath)) return encodeThumb(absPath, edge);
  const poster = await masterPoster(absPath, st);
  return poster ? resizeJpegBuffer(poster, edge) : null;
}

/** The 720p master poster for one source version: served from the bounded
 *  in-memory master cache (all LOD tiers share one ffmpeg extract), bounded
 *  by the poster-slot concurrency cap, with a short negative cache so an
 *  undecodable clip doesn't re-spawn ffmpeg on every repaint. */
async function masterPoster(absPath: string, st: { mtimeMs: number; size: number }): Promise<Buffer | null> {
  const key = posterVersionKey(absPath, st);
  const hit = masterPosterCache.get(key);
  if (hit) {
    masterPosterCache.delete(key);
    masterPosterCache.set(key, hit);
    return hit;
  }
  const failedUntil = posterFailures.get(absPath);
  if (failedUntil !== undefined) {
    if (Date.now() < failedUntil) return null;
    posterFailures.delete(absPath);
  }
  const poster = await withPosterSlot(() => encodeVideoPoster(absPath));
  if (poster) {
    masterPosterCache.set(key, poster);
    while (masterPosterCache.size > POSTER_MASTER_MAX) {
      const oldest = masterPosterCache.keys().next().value;
      if (oldest === undefined) break;
      masterPosterCache.delete(oldest);
    }
    posterFailures.delete(absPath);
  } else if (videoPosterDeps) {
    // Brief negative cache (self-healing): even a missing-binary state
    // expires in seconds, while a broken clip stops costing a spawn per paint.
    posterFailures.set(absPath, Date.now() + POSTER_FAILURE_TTL_MS);
  }
  return poster;
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

/** Ensure a thumbnail exists for `absPath` at one LOD tier (memory → disk
 *  → encode), returning the JPEG and whether it was already on disk. Images
 *  go through nativeImage; videos through the ffmpeg poster seam. Null when
 *  the source isn't decodable or the needed encoder is unavailable (the
 *  caller falls through to the full file). */
export async function ensureRefThumbnail(absPath: string, maxEdge?: number): Promise<{ jpeg: Buffer; fromDisk: boolean } | null> {
  const edge = normalizeThumbEdge(maxEdge);
  const key = thumbCacheKey(absPath, edge);
  const existing = thumbInFlight.get(key);
  if (existing) return existing;
  const pending = ensureRefThumbnailOnce(absPath, edge).finally(() => { thumbInFlight.delete(key); });
  thumbInFlight.set(key, pending);
  return pending;
}

async function ensureRefThumbnailOnce(absPath: string, edge: number): Promise<{ jpeg: Buffer; fromDisk: boolean } | null> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(absPath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const mem = thumbCache.get(thumbCacheKey(absPath, edge));
  if (mem && mem.mtimeMs === st.mtimeMs && mem.size === st.size) return { jpeg: mem.jpeg, fromDisk: false };
  if (thumbCacheDir) {
    const diskPath = thumbDiskPath(thumbCacheDir, absPath, st, edge);
    try {
      const jpeg = await fs.promises.readFile(diskPath);
      remember(absPath, edge, st, jpeg);
      return { jpeg, fromDisk: true };
    } catch {
      /* cache miss → encode below */
    }
  }
  const jpeg = await encodeThumbFor(absPath, edge, st);
  if (!jpeg) return null;
  if (thumbCacheDir) {
    try {
      await fs.promises.mkdir(thumbCacheDir, { recursive: true });
      await fs.promises.writeFile(thumbDiskPath(thumbCacheDir, absPath, st, edge), jpeg);
    } catch {
      /* cache write is best-effort */
    }
  }
  remember(absPath, edge, st, jpeg);
  return { jpeg, fromDisk: false };
}

/** Compressed JPEG thumbnail for an absolute reference path at one LOD
 *  tier (image, or a video's middle-frame poster), or null — the protocol
 *  handler falls through to the full file on null. */
export async function loadRefThumbnail(absPath: string, maxEdge?: number): Promise<Buffer | null> {
  const hit = await ensureRefThumbnail(absPath, maxEdge);
  return hit?.jpeg ?? null;
}

/** Fire-and-forget poster/thumb pre-warm for a file that just landed on disk
 *  (a generated/imported clip): the first graph view then reads the disk
 *  cache instead of paying the ffmpeg extract at paint time. Bounded by the
 *  same poster-slot cap as on-demand encodes; failures are silent. */
export function prewarmMediaThumbnail(absPath: string): void {
  void loadRefThumbnail(absPath, 512).catch(() => {});
}

/** Pre-encode thumbnails (every LOD tier) for the given reference media —
 *  images and videos (Settings → Regenerate thumbnail cache) — and prune
 *  disk entries whose source file no longer exists among them. Idempotent:
 *  existing valid entries are reused.
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
    if (st && thumbCacheDir) {
      for (const edge of REF_THUMB_TIERS) keep.add(thumbDiskPath(thumbCacheDir, absPath, st, edge));
    }
    let anyHit = false;
    let allFromDisk = true;
    for (const edge of REF_THUMB_TIERS) {
      const hit = await ensureRefThumbnail(absPath, edge);
      if (hit) { anyHit = true; if (!hit.fromDisk) allFromDisk = false; }
    }
    if (!anyHit) { result.failed++; continue; }
    if (allFromDisk) result.fromDisk++;
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