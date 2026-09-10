/**
 * Reference-thumbnail module: disk-cache filename derivation (versioned by
 * source mtime+size), regenerate-then-prune behavior, and the fallbacks
 * outside Electron (test harness) — nativeImage is absent, so every encode
 * resolves to null and the protocol falls through to the full file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadRefThumbnail,
  refThumbCacheSize,
  clearRefThumbCache,
  setThumbCacheDir,
  getThumbCacheDir,
  thumbDiskPath,
  regenerateRefThumbnails,
} from "../src/main/thumbnails.js";

let tmp: string;
let cacheDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-thumb-"));
  cacheDir = path.join(tmp, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  setThumbCacheDir(cacheDir);
  clearRefThumbCache();
});

afterEach(() => {
  setThumbCacheDir(null);
  clearRefThumbCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("thumbDiskPath", () => {
  it("versions the filename by source mtime+size so staleness is a name mismatch", () => {
    const a = thumbDiskPath(cacheDir, "C:/x/refs/a.png", { mtimeMs: 1000, size: 100 });
    const b = thumbDiskPath(cacheDir, "C:/x/refs/a.png", { mtimeMs: 1000, size: 101 });
    const c = thumbDiskPath(cacheDir, "C:/x/refs/b.png", { mtimeMs: 1000, size: 100 });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a.endsWith(".jpg")).toBe(true);
    // Deterministic for the same source.
    expect(thumbDiskPath(cacheDir, "C:/x/refs/a.png", { mtimeMs: 1000, size: 100 })).toBe(a);
  });
});

describe("regenerateRefThumbnails (without Electron nativeImage)", () => {
  it("counts un-encodable refs as failed and does not throw", async () => {
    const src = path.join(tmp, "hero.png");
    fs.writeFileSync(src, Buffer.from("not really an image", "utf8"));
    const missing = path.join(tmp, "gone.png");

    const res = await regenerateRefThumbnails([src, src, missing]);
    expect(res.failed).toBe(2); // unique paths only
    expect(res.generated).toBe(0);
    expect(res.fromDisk).toBe(0);
  });

  it("prunes disk entries whose source is gone, keeps ones that still resolve", async () => {
    const keep = path.join(tmp, "keep.png");
    const drop = path.join(tmp, "drop.png");
    fs.writeFileSync(keep, Buffer.from("k"));
    fs.writeFileSync(drop, Buffer.from("d"));
    const stK = fs.statSync(keep);
    const stD = fs.statSync(drop);
    const keepEntry = thumbDiskPath(cacheDir, keep, stK);
    const dropEntry = thumbDiskPath(cacheDir, drop, stD);
    fs.writeFileSync(keepEntry, Buffer.from("thumb-k"));
    fs.writeFileSync(dropEntry, Buffer.from("thumb-d"));
    fs.writeFileSync(path.join(cacheDir, "stray.jpg"), Buffer.from("thumb-stray"));

    // Only `keep` is still in the production; drop's source file is gone.
    fs.rmSync(drop, { force: true });
    await regenerateRefThumbnails([keep]);

    expect(fs.existsSync(keepEntry)).toBe(true);
    expect(fs.existsSync(dropEntry)).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, "stray.jpg"))).toBe(false);
  });
});

describe("loadRefThumbnail fallbacks", () => {
  it("returns null for a missing file (protocol falls through to full file)", async () => {
    const missing = path.join(tmp, "missing.png");
    expect(await loadRefThumbnail(missing)).toBeNull();
    expect(refThumbCacheSize()).toBe(0);
  });

  it("returns null for a non-file path", async () => {
    expect(await loadRefThumbnail(tmp)).toBeNull();
  });

  it("returns null without Electron nativeImage (test environment)", async () => {
    const src = path.join(tmp, "real.png");
    fs.writeFileSync(src, Buffer.from("not really an image", "utf8"));
    // Even a real file yields null — nativeImage is unavailable here, so
    // the caller serves the original file exactly as before the change.
    expect(await loadRefThumbnail(src)).toBeNull();
    expect(getThumbCacheDir()).toBe(cacheDir);
  });
});