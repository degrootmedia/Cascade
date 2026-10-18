/**
 * downloadBytes — the shared result-download failsafe. A finished (paid)
 * generation must survive transient CDN failures: every candidate URL is
 * tried, transient statuses retry with backoff, HTML error pages served
 * with HTTP 200 are rejected, and total failure throws a typed error
 * instead of silently returning nothing.
 */
import { describe, it, expect, vi } from "vitest";
import { DownloadError, downloadBytes, looksLikeErrorPage, tryDownloadBytes } from "../src/main/providers/download.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const noSleep = async () => {};

function stubResponse(status: number, body: Buffer | string = PNG, contentType?: string) {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? contentType ?? null : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  } as unknown as Response;
}

describe("downloadBytes", () => {
  it("returns bytes + the serving URL on the happy path", async () => {
    const fetchImpl = vi.fn(async () => stubResponse(200));
    const got = await downloadBytes(["https://cdn.example/a.png"], { fetchImpl: fetchImpl as never, sleepImpl: noSleep });
    expect(got.buf.equals(PNG)).toBe(true);
    expect(got.url).toBe("https://cdn.example/a.png");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 503 and then succeeds", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n === 1 ? stubResponse(503, "busy") : stubResponse(200)));
    const got = await downloadBytes(["https://cdn.example/a.png"], { fetchImpl: fetchImpl as never, sleepImpl: noSleep });
    expect(got.buf.equals(PNG)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls through to the second URL when the first is gone (404 fails fast, no retry burn)", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("dead") ? stubResponse(404, "nope") : stubResponse(200));
    const got = await downloadBytes(["https://cdn.example/dead.png", "https://cdn2.example/a.png"], {
      fetchImpl: fetchImpl as never, sleepImpl: noSleep, attempts: 3,
    });
    expect(got.url).toBe("https://cdn2.example/a.png");
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 404 not retried
  });

  it("rejects an HTML error page served with HTTP 200 and retries", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () =>
      ++n === 1 ? stubResponse(200, "<html><body>gateway error</body></html>", "text/html") : stubResponse(200));
    const got = await downloadBytes(["https://cdn.example/a.png"], { fetchImpl: fetchImpl as never, sleepImpl: noSleep });
    expect(got.buf.equals(PNG)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects empty bodies", async () => {
    const fetchImpl = vi.fn(async () => stubResponse(200, Buffer.alloc(0)));
    await expect(downloadBytes(["https://cdn.example/a.png"], {
      fetchImpl: fetchImpl as never, sleepImpl: noSleep, attempts: 2,
    })).rejects.toBeInstanceOf(DownloadError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws a typed error naming status + URL after exhausting attempts", async () => {
    const fetchImpl = vi.fn(async () => stubResponse(500, "boom"));
    let caught: unknown = null;
    try {
      await downloadBytes(["https://cdn.example/a.png"], {
        fetchImpl: fetchImpl as never, sleepImpl: noSleep, attempts: 2,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DownloadError);
    const err = caught as DownloadError;
    expect(err.status).toBe(500);
    expect(err.url).toBe("https://cdn.example/a.png");
    expect(err.message).toContain("HTTP 500");
  });

  it("retries a network throw (timeout/reset) and succeeds", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      if (++n === 1) throw new Error("socket hang up");
      return stubResponse(200);
    });
    const got = await downloadBytes(["https://cdn.example/a.png"], { fetchImpl: fetchImpl as never, sleepImpl: noSleep });
    expect(got.buf.equals(PNG)).toBe(true);
  });

  it("passes an abort signal so a hung fetch is time-bounded", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return stubResponse(200);
    });
    await downloadBytes(["https://cdn.example/a.png"], { fetchImpl: fetchImpl as never, sleepImpl: noSleep });
  });

  it("accepts real media bytes even under a wrong content-type", async () => {
    const fetchImpl = vi.fn(async () => stubResponse(200, PNG, "text/plain"));
    const got = await downloadBytes(["https://cdn.example/a.png"], { fetchImpl: fetchImpl as never, sleepImpl: noSleep });
    expect(got.buf.equals(PNG)).toBe(true);
  });

  it("accepts unrecognized non-empty bytes (no false rejection of exotic formats)", async () => {
    const fetchImpl = vi.fn(async () => stubResponse(200, Buffer.from("OUTPUT")));
    const got = await downloadBytes(["https://cdn.example/a.bin"], { fetchImpl: fetchImpl as never, sleepImpl: noSleep });
    expect(got.buf.toString()).toBe("OUTPUT");
  });

  it("throws immediately with no URLs", async () => {
    await expect(downloadBytes([], { sleepImpl: noSleep })).rejects.toBeInstanceOf(DownloadError);
  });

  it("tryDownloadBytes maps total failure to null (recheck-probe contract)", async () => {
    const fetchImpl = vi.fn(async () => stubResponse(404, "gone"));
    await expect(tryDownloadBytes(["https://cdn.example/a.png"], {
      fetchImpl: fetchImpl as never, sleepImpl: noSleep,
    })).resolves.toBeNull();
  });
});

describe("looksLikeErrorPage", () => {
  it("flags HTML and JSON error bodies, passes media", () => {
    expect(looksLikeErrorPage(Buffer.from("<!doctype html><title>403</title>"))).toBe(true);
    expect(looksLikeErrorPage(Buffer.from('{"error":"expired"}'), "application/json")).toBe(true);
    expect(looksLikeErrorPage(PNG, "image/png")).toBe(false);
    expect(looksLikeErrorPage(PNG, "text/html")).toBe(false); // magic wins over a lying header
    expect(looksLikeErrorPage(Buffer.from("OUTPUT"))).toBe(false);
  });
});
