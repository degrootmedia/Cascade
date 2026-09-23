/**
 * cascade-media protocol helpers — pure node, no Electron imports, so tests
 * can exercise range parsing, MIME mapping, CSP, and the streaming responder
 * outside the main process. index.ts (wiring layer) calls into these.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Content-Type for a production media asset based on its extension. */
export function mediaMimeForPath(rel: string): string {
  const ext = path.extname(rel).slice(1).toLowerCase();
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
    case "aac":
      return "audio/mp4";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "mkv":
      return "video/x-matroska";
    case "avi":
      return "video/x-msvideo";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "avif":
      return "image/avif";
    case "svg":
      return "image/svg+xml";
    case "glb":
      return "model/gltf-binary";
    default:
      return "application/octet-stream";
  }
}

export const MEDIA_STREAM_CHUNK = 256 * 1024;

/** Revalidate-every-time caching: the renderer keeps the decoded image in its
 *  cache, but still asks the protocol handler whether the file changed — a
 *  cheap stat, never a full file read. Used for images only. */
export const CACHE_REVALIDATE = "private, max-age=0, must-revalidate";

/** Strong validator for a file from its stat: two reads of an unchanged file
 *  produce the same ETag, and any edit changes mtime/size. */
export function etagFor(st: { mtimeMs: number; size: number }): string {
  return `"${Math.round(st.mtimeMs)}-${st.size}"`;
}

/** Parse a single-range `Range: bytes=start-end` header. Null = absent. */
export function parseCascadeMediaRange(
  header: string | null,
  size: number
): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";
  const [, a, b] = m;
  if (a === "" && b === "") return "invalid";
  let start: number;
  let end: number;
  if (a === "") {
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  return { start, end };
}

export const CSP_PROD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: cascade-media:",
  "media-src 'self' blob: cascade-media:",
  "font-src 'self' data:",
  // The renderer fetch()es cascade-media:// URLs (reference → data-URL
  // resolution, 3D-model inputs, audio decode) — same-document fetches that
  // need an explicit connect-src entry once a CSP exists at all.
  "connect-src 'self' https: cascade-media:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function cspForEnv(isDev: boolean): string {
  if (!isDev) return CSP_PROD;
  return CSP_PROD.replace("script-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'").replace(
    "connect-src 'self' https: cascade-media:",
    "connect-src 'self' https: cascade-media: ws: http://localhost:*"
  );
}

/**
 * Stream a file as an HTTP-style Response with single-range support.
 * Never buffers the whole file: reads 256 KiB chunks at the requested offset.
 * `absPath` must already be confined (assetPath) by the caller.
 *
 * Images are served with a strong `ETag` and `private, max-age=0,
 * must-revalidate` so a culled/re-mounted tile reuses its decoded bitmap
 * without re-reading the file; a matching `If-None-Match` answers 304. Video
 * and audio keep `no-store` — range responses don't belong in the cache.
 */
export async function serveMediaFile(
  absPath: string,
  rangeHeader: string | null,
  ifNoneMatch: string | null = null,
): Promise<Response> {
  let size: number;
  let mtimeMs: number;
  try {
    const st = await fs.promises.stat(absPath);
    if (!st.isFile()) return new Response("Not found", { status: 404 });
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const mime = mediaMimeForPath(absPath);
  const cacheable = mime.startsWith("image/");
  const etag = cacheable ? etagFor({ mtimeMs, size }) : null;
  if (cacheable && etag && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": CACHE_REVALIDATE },
    });
  }

  const parsed = parseCascadeMediaRange(rangeHeader, size);
  if (parsed === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
    });
  }

  const start = parsed ? parsed.start : 0;
  const end = parsed ? parsed.end : Math.max(0, size - 1);
  const length = size === 0 ? 0 : end - start + 1;

  const fh = await fs.promises.open(absPath, "r").catch(() => null);
  if (!fh) return new Response("Not found", { status: 404 });
  let position = start;
  let remaining = length;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0) {
        controller.close();
        await fh.close().catch(() => {});
        return;
      }
      const buf = Buffer.allocUnsafe(Math.min(MEDIA_STREAM_CHUNK, remaining));
      let bytesRead = 0;
      try {
        ({ bytesRead } = await fh.read(buf, 0, buf.length, position));
      } catch {
        controller.close();
        await fh.close().catch(() => {});
        return;
      }
      if (bytesRead <= 0) {
        controller.close();
        await fh.close().catch(() => {});
        return;
      }
      position += bytesRead;
      remaining -= bytesRead;
      controller.enqueue(new Uint8Array(buf.subarray(0, bytesRead)));
    },
    async cancel() {
      await fh.close().catch(() => {});
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheable ? CACHE_REVALIDATE : "no-store",
  };
  if (cacheable && etag) {
    headers["ETag"] = etag;
    headers["Last-Modified"] = new Date(mtimeMs).toUTCString();
  }
  if (parsed) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;

  return new Response(body, { status: parsed ? 206 : 200, headers });
}
