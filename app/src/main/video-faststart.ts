/**
 * MP4/MOV faststart for generated clips (perf phase 4, evidence-gated).
 *
 * Vendor clips arrive with the `moov` atom at the END of the file (measured
 * on real projects: mdat at ~21 KB, moov after megabytes of media), so every
 * <video> metadata load range-reads to the tail before it can show or play
 * anything. A lossless `-c copy -movflags +faststart` remux moves moov to
 * the front; done once when a clip lands on disk, every later load is a
 * front-seek. The remux is fire-and-forget behind a bounded queue: a failure
 * (no ffmpeg, rename raced by a playing element) leaves the original file
 * untouched. The poster pre-warm runs after the remux so its cache version
 * keys on the final file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createGenerationQueue } from "./providers/generation-queue.js";
import { prewarmMediaThumbnail } from "./thumbnails.js";

/** Injected ffmpeg seam (main wires the real binary; tests fake it). */
export interface FastStartDeps {
  resolveBin: () => Promise<string | null>;
  run: (bin: string, argv: string[]) => Promise<void>;
}
let fastStartDeps: FastStartDeps | null = null;

export function setFastStartDeps(deps: FastStartDeps | null): void {
  fastStartDeps = deps;
}

const FASTSTART_EXT_RX = /\.(mp4|m4v|mov)$/i;
/** Head bytes scanned for box order — ftyp/moov/mdat all declare themselves
 *  within the first boxes of every real-world file we measured. */
const FASTSTART_HEAD_BYTES = 1024 * 1024;

/**
 * True when a `moov` box precedes the first `mdat` box in `head` (the file
 * can start playback from the front), false when `mdat` comes first, and
 * null when the head doesn't decide it (truncated/unusual layout — callers
 * treat that as "leave it alone" rather than remuxing on a guess). Walks
 * real box headers (32-bit and 64-bit sizes), never substring search —
 * media payloads contain the bytes "moov" by chance.
 */
export function isFastStartBuffer(head: Buffer): boolean | null {
  let offset = 0;
  while (offset + 8 <= head.length) {
    const size32 = head.readUInt32BE(offset);
    const type = head.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "moov") return true;
    if (type === "mdat") return false;
    let size: number;
    let header = 8;
    if (size32 === 1) {
      if (offset + 16 > head.length) return null;
      const big = head.readBigUInt64BE(offset + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(big);
      header = 16;
    } else if (size32 === 0) {
      return null; // box extends to EOF and it isn't moov — undecidable from a head
    } else {
      size = size32;
    }
    if (size < header) return null;
    offset += size;
  }
  return null;
}

async function readHead(absPath: string, bytes: number): Promise<Buffer | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(absPath, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    try { await fh?.close(); } catch { /* already closed */ }
  }
}

export type FastStartOutcome = "already" | "remuxed" | "skipped";

/** Ensure `absPath` is faststart, remuxing losslessly when needed. Never
 *  throws; any failure leaves the original file byte-identical. */
export async function ensureFastStart(absPath: string, depsOverride?: FastStartDeps | null): Promise<FastStartOutcome> {
  if (!FASTSTART_EXT_RX.test(absPath)) return "skipped";
  const head = await readHead(absPath, FASTSTART_HEAD_BYTES);
  if (!head) return "skipped";
  const fast = isFastStartBuffer(head);
  if (fast === true) return "already";
  if (fast === null) return "skipped";
  const deps = depsOverride === undefined ? fastStartDeps : depsOverride;
  if (!deps) return "skipped";
  let bin: string | null = null;
  try { bin = await deps.resolveBin(); } catch { bin = null; }
  if (!bin) return "skipped";
  const ext = path.extname(absPath);
  const tmp = `${absPath}.faststart-${process.pid}.tmp${ext}`;
  try {
    await deps.run(bin, ["-hide_banner", "-nostdin", "-y", "-i", absPath, "-c", "copy", "-movflags", "+faststart", tmp]);
    const st = await fs.promises.stat(tmp);
    if (!st.isFile() || st.size <= 0) return "skipped";
    await fs.promises.rename(tmp, absPath);
    return "remuxed";
  } catch {
    return "skipped";
  } finally {
    try { await fs.promises.unlink(tmp); } catch { /* renamed away or never written */ }
  }
}

const postProcessQueue = createGenerationQueue(2);
const postProcessInFlight = new Set<string>();

/** Fire-and-forget post-processing for a clip that just landed on disk:
 *  faststart remux (bounded, max 2 at once), then poster pre-warm keyed on
 *  the final file. Deduped per path; failures are silent by design — the
 *  clip is already written and registered. */
export function queueVideoFilePostProcess(absPath: string): void {
  if (postProcessInFlight.has(absPath)) return;
  postProcessInFlight.add(absPath);
  void postProcessQueue.run(async () => {
    try { await ensureFastStart(absPath); } catch { /* never throws, but stay safe */ }
    prewarmMediaThumbnail(absPath);
  }).finally(() => { postProcessInFlight.delete(absPath); });
}
