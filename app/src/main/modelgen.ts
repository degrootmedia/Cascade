/**
 * ModelgenClient — the 3D AI Studio REST integration's domain module.
 *
 * Owns the whole Tencent Hunyuan 3D Pro vertical slice: submit a generation
 * request (text-to-3D or image-to-3D), poll the async status endpoint until
 * the job finishes, then download the GLB bytes. The API key and the HTTP
 * call surface are injected via the constructor — that injection IS the test
 * surface, so a fake fetch substitutes for the live REST API in tests without
 * any Electron or network dependency.
 *
 * index.ts only wires IPC channels and the real fetch + key lookups here.
 * Nothing in this module touches Electron.
 */
import type { Model3dGenOptions, ProductionModel } from "../shared/ipc.js";

const BASE_URL = "https://api.3daistudio.com";

/** How long to keep polling a 3D job before giving up. Tencent Pro takes
 *  3–6 minutes with PBR, so the cap is generous. */
const WAIT_DEADLINE_MS = 15 * 60_000;

/** Poll interval between status checks. */
const POLL_INTERVAL_MS = 5_000;

/** A subset of the injected fetch — the methods the client actually calls.
 *  Keeping the seam narrow keeps the fake in tests trivial. */
export interface HttpFetchResponse {
  ok: boolean;
  status: number;
  contentType?: string;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpFetch {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<HttpFetchResponse>;
}

/** Adapt the global fetch Response to the narrow seam (exposes content-type
 *  so a bad download can report what the server actually returned). */
export function adaptFetch(fetchFn: typeof fetch): HttpFetch {
  return async (url, init) => {
    const res = await fetchFn(url as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type") ?? undefined,
      json: () => res.json(),
      arrayBuffer: () => res.arrayBuffer(),
    };
  };
}

/** A GLB file starts with the 4 magic bytes "glTF" (0x67 0x6C 0x54 0x46). */
export function isGlbBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 12 &&
    bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

/** A short text preview of a byte buffer, for error messages. */
export function bytePreview(bytes: Uint8Array, max = 96): string {
  const head = Array.from(bytes.slice(0, max));
  const ascii = head.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "·")).join("");
  return ascii || `${bytes.length} bytes`;
}

/** The async status endpoint's result entry. */
export interface ModelGenStatusResult {
  asset?: unknown;
  asset_type?: unknown;
}

/** Parsed shape of a generation status reply. */
export interface ModelGenStatus {
  status: "PENDING" | "IN_PROGRESS" | "FINISHED" | "FAILED" | (string & {});
  progress?: number;
  failure_reason?: unknown;
  results?: ModelGenStatusResult[];
}

/** A generation job that outlived the wait — the server keeps working, so the
 *  caller can show it as still-rendering (or re-poll later) rather than dead. */
export class ModelGenPendingError extends Error {
  constructor(readonly taskId: string) {
    super(`3D model generation timed out (task ${taskId.slice(0, 8)}…).`);
    this.name = "ModelGenPendingError";
  }
}

export class ModelGenError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "ModelGenError";
  }
}

export class ModelGenClient {
  /** The injected HTTP seam. */
  private readonly fetchFn: HttpFetch;

  constructor(
    /** Returns the 3D AI Studio API key (or null). Injected so settings stay out of this module. */
    private readonly getKey: () => string | null,
    /** The HTTP call surface. Injected so tests can fake the REST API. */
    fetchFn: HttpFetch = adaptFetch(fetch),
    private readonly pollIntervalMs = POLL_INTERVAL_MS,
    private readonly waitDeadlineMs = WAIT_DEADLINE_MS
  ) {
    this.fetchFn = fetchFn;
  }

  private async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const key = this.getKey();
    if (!key) {
      throw new ModelGenError("No 3D AI Studio API key stored — add one in Settings.");
    }
    const res = await this.fetchFn(`${BASE_URL}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      let detail = "";
      try {
        const obj = (await res.json()) as Record<string, unknown>;
        detail = typeof obj?.detail === "string" ? obj.detail : "";
      } catch {
        /* non-JSON error body */
      }
      throw new ModelGenError(
        detail || `3D AI Studio request failed (HTTP ${res.status}).`,
        res.status
      );
    }
    return (await res.json()) as T;
  }

  /** Resolve the user's model choices into the request body. The Tencent Pro
   *  API only accepts a prompt+image pair together in Sketch mode; for
   *  Normal/Geometry/LowPoly image-to-3D the prompt must be omitted, and
   *  multi-view input uses its own `multi_view_images` array (front required). */
  private buildRequest(opts: Model3dGenOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: opts.version,
      enable_pbr: opts.enablePbr,
      face_count: opts.faceCount,
    };
    if (opts.generateType !== "Normal") body.generate_type = opts.generateType;

    if (opts.multiViewImages && opts.multiViewImages.length) {
      body.multi_view_images = opts.multiViewImages.map((v) => ({
        view_type: v.viewType,
        view_image: v.dataUrl,
      }));
      return body;
    }

    if (opts.imageDataUrl) {
      if (opts.generateType === "Sketch") body.prompt = opts.prompt;
      body.image = opts.imageDataUrl;
      return body;
    }

    body.prompt = opts.prompt;
    return body;
  }

  /** Remaining credit balance, or null when the key is missing/invalid. */
  async getCredits(): Promise<number | null> {
    try {
      const obj = (await this.request<{ balance?: unknown }>("/account/user/wallet/")) as Record<string, unknown>;
      const balance = obj?.balance;
      const n = typeof balance === "string" ? parseFloat(balance) : typeof balance === "number" ? balance : NaN;
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * Submit a Tencent Hunyuan Pro generation and poll until it finishes.
   * `opts` carries the input mode: text (prompt), image-to-3D (imageDataUrl),
   * or multi-view (multiViewImages). `onPoll` is invoked after each status
   * check (for progress UI). Resolves with the downloaded GLB bytes.
   */
  async generate(
    opts: Model3dGenOptions,
    onPoll?: (status: string, progress?: number) => void
  ): Promise<Uint8Array> {
    const key = this.getKey();
    if (!key) throw new ModelGenError("No 3D AI Studio API key stored — add one in Settings.");

    const submit = await this.request<{ task_id?: unknown }>("/v1/3d-models/tencent/generate/pro/", {
      method: "POST",
      body: this.buildRequest(opts),
    });
    const taskId = submit?.task_id;
    if (typeof taskId !== "string" || !taskId) {
      throw new ModelGenError("3D AI Studio didn't return a task id.");
    }

    const deadline = Date.now() + this.waitDeadlineMs;
    for (;;) {
      const status = await this.poll(taskId, onPoll);
      if (status.status === "FINISHED") {
        const url = this.resultUrl(status);
        return this.download(url);
      }
      if (status.status === "FAILED") {
        const reason = status.failure_reason;
        throw new ModelGenError(
          typeof reason === "string" && reason ? `3D generation failed: ${reason}` : "3D generation failed."
        );
      }
      if (Date.now() > deadline) {
        throw new ModelGenPendingError(taskId);
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  /** One status check for a task. */
  async poll(taskId: string, onPoll?: (status: string, progress?: number) => void): Promise<ModelGenStatus> {
    const raw = await this.request<ModelGenStatus>(`/v1/generation-request/${taskId}/status/`);
    onPoll?.(raw.status, raw.progress);
    return raw;
  }

  /** Pull the first downloadable asset URL out of a finished status. */
  private resultUrl(status: ModelGenStatus): string {
    for (const r of status.results ?? []) {
      if (typeof r?.asset === "string" && r.asset) return r.asset;
    }
    throw new ModelGenError("3D generation finished but no asset URL was returned.");
  }

  /** Download the finished asset bytes and verify they are a real GLB. The
   *  asset lives on a storage host that may or may not expect the API Bearer
   *  token — some hosts reject it (400) and others require it (401/403/error
   *  body on a 200). So we try both auth modes, and never write a non-GLB
   *  body to disk. If all attempts fail, throw a descriptive error showing
   *  what the server actually returned. */
  private async download(url: string): Promise<Uint8Array> {
    const key = this.getKey();
    const browserAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/122.0.0.0 Safari/537.36";
    const attempts: Array<{ label: string; headers: Record<string, string> }> = [];
    if (key) {
      attempts.push({
        label: "authenticated",
        headers: { Authorization: `Bearer ${key}`, "User-Agent": browserAgent, Accept: "application/octet-stream, application/gltf-binary, */*" },
      });
    }
    attempts.push({
      label: "anonymous",
      headers: { "User-Agent": browserAgent, Accept: "application/octet-stream, application/gltf-binary, */*" },
    });

    let lastError: ModelGenError | null = null;
    for (const attempt of attempts) {
      const res = await this.fetchFn(url, { headers: attempt.headers });
      if (!res.ok) {
        lastError = new ModelGenError(
          `Failed to download the generated model (HTTP ${res.status}, ${attempt.label}).`,
          res.status
        );
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (isGlbBytes(bytes)) return bytes;
      lastError = new ModelGenError(
        `Downloaded data is not a GLB model (${attempt.label}, ${res.contentType ?? "unknown content-type"}, ` +
          `${bytes.length} bytes). Server returned: "${bytePreview(bytes)}". ` +
          `Try re-running the generation — the asset link may have expired.`
      );
    }
    throw lastError ?? new ModelGenError("Failed to download the generated model.");
  }
}

/** Derive the .glb filename for a completed generation. */
export function modelFileName(opts: Model3dGenOptions, at: number): string {
  const raw = (opts.prompt || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const stem = raw ? `-${raw}` : "";
  return `model${stem}-${at.toString(36)}.glb`;
}

/** Build the persisted production record for a completed generation. */
export function toProductionModel(
  glbRel: string,
  opts: Model3dGenOptions,
  at: number
): ProductionModel {
  return {
    id: `model3d-${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    glbPath: glbRel,
    prompt: opts.prompt,
    edition: "pro",
    pbr: opts.enablePbr,
    fromImage: !!opts.imageDataUrl || !!opts.multiViewImages?.length,
    at: new Date(at).toISOString(),
  };
}