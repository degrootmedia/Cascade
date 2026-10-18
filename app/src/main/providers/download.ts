/**
 * download — the shared result-download seam for every media provider.
 *
 * A finished generation is only useful once its bytes are on disk, and the
 * download used to be the flakiest link: each provider hand-rolled a
 * single-attempt `fetch` of the FIRST result URL, with no timeout and no
 * validation, so a transient CDN hiccup (or an HTML error page served with
 * HTTP 200) silently discarded a paid, finished job. This module is the
 * one place result bytes are fetched:
 *
 * - EVERY candidate URL is tried, in order — one dead CDN host never
 *   strands a result that another URL could serve.
 * - Transient failures (network error, timeout, 408/429/5xx, a non-media
 *   body) retry with backoff; other 4xx fail fast to the next URL.
 * - Each attempt is time-bounded, so a hung connection can't stall a
 *   poll loop forever.
 * - The body must be non-empty and must not be positively identifiable as
 *   a non-media error page (HTML/XML/JSON). Validation is deliberately
 *   conservative — only negative evidence rejects — so an exotic but
 *   valid media format is never refused.
 *
 * Callers keep their own semantics on top: poll loops pass a small
 * attempt count (their outer loop is the retry), terminal fetches pass
 * the default. A total failure throws `DownloadError` naming the last
 * status/URL so nothing about a lost download is silent.
 */

export interface DownloadOptions {
  /** Attempts per URL (default 3). Poll loops pass 1–2. */
  attempts?: number;
  /** Per-attempt timeout in ms (default 30s image/any, 180s video). */
  timeoutMs?: number;
  /** What is being fetched — picks the default timeout. */
  kind?: "image" | "video" | "any";
  /** Injectable fetch (tests). Defaults to the global at call time. */
  fetchImpl?: typeof fetch;
  /** Injectable backoff sleep (tests). */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** A download that exhausted every URL/attempt. Carries the last HTTP
 *  status (when a response arrived at all) and the last URL tried. */
export class DownloadError extends Error {
  readonly status?: number;
  readonly url?: string;
  constructor(message: string, opts: { status?: number; url?: string } = {}) {
    super(message);
    this.name = "DownloadError";
    this.status = opts.status;
    this.url = opts.url;
  }
}

const RETRYABLE_STATUS = new Set([408, 429]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when a body is positively identifiable as NOT media bytes: an
 *  HTML/XML error page or a JSON error object served with HTTP 200.
 *  Anything else (including formats we don't recognize) passes — a
 *  finished generation must never be rejected on a guess. */
/** Known media magic bytes — a match is conclusive proof of media,
 *  whatever the content-type header claims. */
function hasMediaMagic(buf: Buffer): boolean {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
    if (buf[0] === 0xff && buf[1] === 0xd8) return true; // JPEG
    if (buf.subarray(0, 4).toString("ascii") === "GIF8") return true; // GIF
    if (buf.subarray(0, 4).toString("ascii") === "RIFF") return true; // WebP/WAV
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true; // WebM/Matroska
    if (buf.subarray(0, 2).toString("ascii") === "BM") return true; // BMP
  }
  if (buf.length >= 8 && buf.subarray(4, 8).toString("ascii") === "ftyp") return true; // MP4/MOV/AVIF
  return false;
}

export function looksLikeErrorPage(buf: Buffer, contentType?: string | null): boolean {
  if (hasMediaMagic(buf)) return false;
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("text/html") || ct.startsWith("application/json") || ct.startsWith("text/plain")) return true;
  const head = buf.subarray(0, 64).toString("utf8").trimStart();
  if (head.startsWith("<")) return true; // HTML/XML/SVG-as-error — never a raster/video result
  if ((head.startsWith("{") || head.startsWith("[")) && /"(error|message|code|status)"/i.test(head)) return true;
  return false;
}

async function attemptOnce(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<{ buf: Buffer } | { retry: boolean; status?: number; reason: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { retry: true, reason: e instanceof Error ? e.message : String(e) };
  }
  const status = typeof res.status === "number" ? res.status : undefined;
  if (!res.ok) {
    const retry = status === undefined || RETRYABLE_STATUS.has(status) || status >= 500;
    return { retry, status, reason: `HTTP ${status ?? "?"}` };
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { retry: true, status, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!buf.length) return { retry: true, status, reason: "empty body" };
  let contentType: string | null = null;
  try {
    contentType = res.headers?.get?.("content-type") ?? null;
  } catch { /* a stubbed/minimal Response — byte sniffing still applies */ }
  if (looksLikeErrorPage(buf, contentType)) {
    return { retry: true, status, reason: "response was not media (error page)" };
  }
  return { buf };
}

/**
 * Download the first reachable result from `urls`, retrying transient
 * failures per URL with backoff. Resolves with the bytes and the URL that
 * served them; rejects with `DownloadError` after every URL is exhausted.
 */
export async function downloadBytes(
  urls: string[],
  opts: DownloadOptions = {}
): Promise<{ buf: Buffer; url: string }> {
  const candidates = [...new Set(urls.filter((u) => typeof u === "string" && u))];
  if (!candidates.length) throw new DownloadError("No download URL was provided.");
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  const timeoutMs = opts.timeoutMs ?? (opts.kind === "video" ? 180_000 : 30_000);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;

  let lastStatus: number | undefined;
  let lastReason = "no attempt completed";
  let lastUrl: string | undefined;
  for (const url of candidates) {
    lastUrl = url;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(Math.min(300 * 2 ** (attempt - 1), 2_000));
      const got = await attemptOnce(url, timeoutMs, fetchImpl);
      if ("buf" in got) return { buf: got.buf, url };
      lastStatus = got.status ?? lastStatus;
      lastReason = got.reason;
      if (!got.retry) break; // fail fast to the next URL (e.g. signed URL expired → 403)
    }
  }
  throw new DownloadError(
    `Couldn't download the generated result (${lastReason}) from ${lastUrl ?? "the result URL"}.`,
    { status: lastStatus, url: lastUrl }
  );
}

/** `downloadBytes` for callers whose contract is "bytes or null" (poll /
 *  recheck probes — null means "not fetchable yet, keep the receipt"). */
export async function tryDownloadBytes(
  urls: string[],
  opts: DownloadOptions = {}
): Promise<{ buf: Buffer; url: string } | null> {
  try {
    return await downloadBytes(urls, opts);
  } catch {
    return null;
  }
}
