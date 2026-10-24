/**
 * video-faststart: MP4 box-order detection and the lossless remux.
 * Vendor clips arrive with moov at EOF, so every metadata load tail-seeks;
 * ensureFastStart remuxes once on write and never touches a file it can't
 * prove needs it.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isFastStartBuffer, ensureFastStart, type FastStartDeps } from "../src/main/video-faststart.js";

function box(type: string, payloadBytes: number): Buffer {
  const buf = Buffer.alloc(8 + payloadBytes);
  buf.writeUInt32BE(8 + payloadBytes, 0);
  buf.write(type, 4, "ascii");
  return buf;
}

let tmp: string | null = null;
afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = null; });
function tmpDir(): string { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-faststart-")); return tmp; }

describe("isFastStartBuffer", () => {
  it("is true when moov precedes mdat, false when mdat comes first", () => {
    expect(isFastStartBuffer(Buffer.concat([box("ftyp", 16), box("moov", 8), box("mdat", 100)]))).toBe(true);
    expect(isFastStartBuffer(Buffer.concat([box("ftyp", 16), box("free", 8), box("mdat", 100), box("moov", 8)]))).toBe(false);
  });

  it("walks 64-bit box sizes", () => {
    const wide = Buffer.alloc(16);
    wide.writeUInt32BE(1, 0);
    wide.write("free", 4, "ascii");
    wide.writeBigUInt64BE(BigInt(16), 8);
    expect(isFastStartBuffer(Buffer.concat([wide, box("moov", 0)]))).toBe(true);
  });

  it("returns null on truncated or undecidable heads", () => {
    expect(isFastStartBuffer(Buffer.from("tiny"))).toBeNull();
    expect(isFastStartBuffer(box("ftyp", 4).subarray(0, 10))).toBeNull();
    // Payload bytes that merely look like a moov header never decide it:
    // a fake header inside a free box's payload is skipped by box size.
    const free = box("free", 12);
    free.write("moov", 12, "ascii");
    expect(isFastStartBuffer(Buffer.concat([box("ftyp", 4), free]))).toBeNull();
  });
});

describe("ensureFastStart", () => {
  const fakeDeps = (runImpl?: FastStartDeps["run"]): { deps: FastStartDeps; runs: string[][] } => {
    const runs: string[][] = [];
    return {
      runs,
      deps: {
        resolveBin: async () => "ffmpeg",
        run: runImpl ?? (async (_b, argv) => { runs.push(argv); fs.writeFileSync(argv[argv.length - 1], Buffer.concat([box("ftyp", 8), box("moov", 4), box("mdat", 4)])); }),
      },
    };
  };

  it("remuxes a moov-at-end clip in place and reports it", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "clip.mp4");
    fs.writeFileSync(file, Buffer.concat([box("ftyp", 8), box("mdat", 32), box("moov", 4)]));
    const { deps, runs } = fakeDeps();
    expect(await ensureFastStart(file, deps)).toBe("remuxed");
    expect(runs[0]).toContain("-movflags");
    expect(isFastStartBuffer(fs.readFileSync(file))).toBe(true);
    // No temp residue.
    expect(fs.readdirSync(dir).filter((f) => f.includes("faststart"))).toEqual([]);
  });

  it("leaves an already-faststart clip and non-MP4 files alone", async () => {
    const dir = tmpDir();
    const ok = path.join(dir, "ok.mp4");
    const before = Buffer.concat([box("ftyp", 8), box("moov", 4), box("mdat", 32)]);
    fs.writeFileSync(ok, before);
    const { deps, runs } = fakeDeps();
    expect(await ensureFastStart(ok, deps)).toBe("already");
    expect(runs).toHaveLength(0);
    const webm = path.join(dir, "clip.webm");
    fs.writeFileSync(webm, before);
    expect(await ensureFastStart(webm, deps)).toBe("skipped");
  });

  it("a failed remux leaves the original byte-identical", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "clip.mov");
    const before = Buffer.concat([box("ftyp", 8), box("mdat", 32), box("moov", 4)]);
    fs.writeFileSync(file, before);
    const { deps } = fakeDeps(async () => { throw new Error("ffmpeg died"); });
    expect(await ensureFastStart(file, deps)).toBe("skipped");
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});
