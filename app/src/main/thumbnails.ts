/**
 * Reference-image thumbnails for the node graph — small compressed JPEGs
 * served over the cascade-media protocol (`?thumb=1`) so the graph never
 * decodes full-resolution reference files just to paint 64px node tiles.
 * The full-res file is untouched: zoom/lightbox URLs keep the original, and
 * prompt sends read the original from disk on the main side.
 *
 * Thumbs persist to a versioned on-disk cache (`<hash>-<mtimeMs>-<size>.jpg`
 * under a userData dir) so a large project's first graph open is fast on every
 * launch, not just the first. The version lives in the filename — an entry is
 * valid iff its version matches the source file's current stat, so there is
 * no stale-entry race; the Settings → "Regenerate thumbnail cache" action
 * pre-encodes every reference and prunes entries whose source is gone.
 */
import * as fs from "node:fs";
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

/** Ensure a thumbnail exists for `absPath` (memory → disk → encode), returning
 *  the JPEG and whether it was already on disk. Null when the file isn't a
 *  decodable image or nativeImage is unavailable (caller falls through). */
export async function ensureRefThumbnail(absPath: string): Promise<{ jpeg: Buffer; fromDisk: boolean } | null> {
  if (!nativeImage) return null;
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
  const jpeg = encodeThumb(absPath);
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

/** Compressed JPEG thumbnail for an absolute reference-image path, or null —
 *  the protocol handler falls through to the full file on null. */
export async function loadRefThumbnail(absPath: string): Promise<Buffer | null> {
  const hit = await ensureRefThumbnail(absPath);
  return hit?.jpeg ?? null;
}

/** Pre-encode thumbnails for the given reference images (Settings →
 *  Regenerate thumbnail cache) and prune disk entries whose source file no
 *  longer exists among them. Idempotent: existing valid entries are reused.
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