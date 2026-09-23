import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  mediaMimeForPath,
  parseCascadeMediaRange,
  CSP_PROD,
  cspForEnv,
  serveMediaFile,
  etagFor,
} from "../src/main/media-protocol.js";

describe("mediaMimeForPath", () => {
  it("maps common media extensions", () => {
    expect(mediaMimeForPath("a.mp3")).toBe("audio/mpeg");
    expect(mediaMimeForPath("a.mp4")).toBe("video/mp4");
    expect(mediaMimeForPath("a.glb")).toBe("model/gltf-binary");
    expect(mediaMimeForPath("a.png")).toBe("image/png");
  });
  it("falls back to octet-stream, never audio/mpeg", () => {
    expect(mediaMimeForPath("a.unknownext")).toBe("application/octet-stream");
  });
});

describe("parseCascadeMediaRange", () => {
  const size = 100;
  it("returns null when absent", () => {
    expect(parseCascadeMediaRange(null, size)).toBeNull();
  });
  it("parses start-end", () => {
    expect(parseCascadeMediaRange("bytes=0-1", size)).toEqual({ start: 0, end: 1 });
  });
  it("parses suffix ranges", () => {
    expect(parseCascadeMediaRange("bytes=-5", size)).toEqual({ start: 95, end: 99 });
  });
  it("parses open-ended ranges", () => {
    expect(parseCascadeMediaRange("bytes=90-", size)).toEqual({ start: 90, end: 99 });
  });
  it("rejects beyond-EOF and malformed", () => {
    expect(parseCascadeMediaRange("bytes=999999-", size)).toBe("invalid");
    expect(parseCascadeMediaRange("bytes=-", size)).toBe("invalid");
    expect(parseCascadeMediaRange("nonsense", size)).toBe("invalid");
  });
});

describe("CSP", () => {
  it("production policy blocks objects/base and has no unsafe-eval", () => {
    expect(CSP_PROD).toContain("object-src 'none'");
    expect(CSP_PROD).toContain("base-uri 'none'");
    expect(CSP_PROD).not.toContain("unsafe-eval");
    expect(CSP_PROD).toContain("cascade-media:");
  });
  it("connect-src allows same-document cascade-media fetches", () => {
    // The renderer fetch()es cascade-media:// URLs (reference resolution,
    // audio decode). Omitting the scheme breaks those with a CSP violation.
    expect(CSP_PROD).toContain("connect-src 'self' https: cascade-media:");
    expect(cspForEnv(true)).toContain("cascade-media:");
  });
  it("dev policy relaxes script/connect for the dev server", () => {
    expect(cspForEnv(true)).toContain("unsafe-eval");
    expect(cspForEnv(false)).toBe(CSP_PROD);
  });
  it("renderer HTML carries no CSP meta tag (header is the single policy source)", () => {
    // A second policy would intersect with the header and re-block
    // cascade-media:/blob: subresources even when the header allows them.
    const html = fs.readFileSync(path.resolve(__dirname, "../src/renderer/index.html"), "utf8");
    expect(html.toLowerCase()).not.toContain("content-security-policy");
  });
});

describe("serveMediaFile streams ranges without buffering", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-media-"));
    fs.writeFileSync(path.join(dir, "clip.mp4"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves 200 with full length and Accept-Ranges when no Range given", async () => {
    const res = await serveMediaFile(path.join(dir, "clip.mp4"), null);
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("serves 206 with Content-Range for bytes=0-1", async () => {
    const res = await serveMediaFile(path.join(dir, "clip.mp4"), "bytes=0-1");
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-1/10");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes]).toEqual([0, 1]);
  });

  it("serves 416 for unsatisfiable ranges", async () => {
    const res = await serveMediaFile(path.join(dir, "clip.mp4"), "bytes=999999-");
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */10");
  });

  it("serves 404 for missing files", async () => {
    const res = await serveMediaFile(path.join(dir, "nope.mp4"), null);
    expect(res.status).toBe(404);
  });

  it("streams a sparse 1 GiB fixture without buffering it whole", async () => {
    const big = path.join(dir, "big.mp4");
    const fd = fs.openSync(big, "w");
    try {
      // Sparse: allocate the size without writing the bytes.
      fs.writeSync(fd, Buffer.from([0xab]), 0, 1, 1024 ** 3 - 1);
    } finally {
      fs.closeSync(fd);
    }
    const res = await serveMediaFile(big, "bytes=0-1");
    expect(res.status).toBe(206);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(2);
  }, 30000);
});

describe("image caching (revalidate, never no-store)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-cache-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves an image with a strong ETag and revalidate caching", async () => {
    const file = path.join(dir, "hero.png");
    fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
    const res = await serveMediaFile(file, null);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
    expect(res.headers.get("ETag")).toBe(etagFor({ mtimeMs: fs.statSync(file).mtimeMs, size: 4 }));
    expect(res.headers.get("Last-Modified")).toBeTruthy();
    // The body is still the full file (caching must not truncate it).
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it("answers a matching If-None-Match with 304 and no body", async () => {
    const file = path.join(dir, "hero.png");
    fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
    const first = await serveMediaFile(file, null);
    const etag = first.headers.get("ETag")!;
    const cached = await serveMediaFile(file, null, etag);
    expect(cached.status).toBe(304);
    expect(cached.headers.get("ETag")).toBe(etag);
    expect(cached.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
    expect(await cached.text()).toBe("");
  });

  it("keeps video uncached (no-store, no ETag)", async () => {
    const file = path.join(dir, "clip.mp4");
    fs.writeFileSync(file, Buffer.from([1, 2, 3]));
    const res = await serveMediaFile(file, null);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("ETag")).toBeNull();
  });

  it("etagFor is stable across sub-millisecond mtime noise", () => {
    expect(etagFor({ mtimeMs: 1234.1, size: 99 })).toBe(etagFor({ mtimeMs: 1234.4, size: 99 }));
    expect(etagFor({ mtimeMs: 1234, size: 99 })).not.toBe(etagFor({ mtimeMs: 1234, size: 100 }));
  });
});
