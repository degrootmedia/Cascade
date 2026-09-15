/**
 * HiggsfieldProvider — the official Higgsfield MCP server's MediaProvider
 * adapter (https://mcp.higgsfield.ai/mcp, streamable-HTTP + OAuth).
 *
 * Tool mapping (probed live 2026-09-07, see tasks/todo.md Phase 0):
 * - catalog:   models_explore {action: list|get} →  JSON items with
 *              parameters/medias[].roles/aspect_ratios (+ trailing prose)
 * - submit:    generate_image / generate_video {params: {model, prompt,
 *              count, aspect_ratio, resolution/duration, medias:
 *              [{value: media_id|job_id, role}], get_cost}} → 
 *              prose + `- <job-uuid> "<prompt>"` lines
 * - poll:      job_status {jobId, sync:true} →  `Job <id> → <status>` +
 *              result URL + resource_link item (sync long-polls ~25s)
 * - upload:    media_upload {filename, content_type} →  presigned S3 PUT URL
 *              + media_id (prose) →  PUT bytes →  media_confirm {type, media_id}
 * - credits:   balance →  `Credits: N | Plan: <plan>`
 *
 * Differences from OpenArt worth knowing: no per-model form introspection
 * (parameters ride the catalog, so there is no options cache to warm);
 * end-frame support is a first-class catalog role (`end_image`), not a
 * probed schema slot; unset resolution silently becomes the model default
 * (the adapter always passes it explicitly); there is no project concept
 * (resolveProject returns null).
 *
 * The McpManager is injected via the constructor — the seam. A fake manager
 * substitutes for the live server in tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { McpManager } from "../mcp.js";
import { assetPath, writeShotVideo, type ImageGenFn } from "../pipeline.js";
import { resizeVideoRef, VIDEO_REF_MAX_HEIGHT } from "../video-ref.js";
import {
  dataUrlToBytes,
  IMAGE_URL_RX,
  parseJsonLooseObject,
  VIDEO_URL_RX,
} from "../../shared/prompt-grammar.js";
import type {
  CliModelSchema,
  ImageGenAspectRatio,
  ImageModelOptions,
  LedgerGenMeta,
  OpenArtBoardConfig,
  OpenArtModelChoice,
  PendingImageGen,
  Production,
  ProductionShot,
  VideoGenOptions,
  VideoModelOptions,
} from "../../shared/ipc.js";
import type { GenerationRecorder, MediaProvider, ProviderEmit } from "./types.js";
import { citePrompt, resolvePromptRefs, styleRefNames } from "./refs.js";
import { buildModelSchema, type RawModelParam } from "./model-schema.js";

const SERVER = "higgsfield";

/** Prefix marking model ids that belong to this provider (see types.ts). */
export const HIGGSFIELD_ID_PREFIX = "higgsfield:";

/** Strip the vendor prefix; foreign ids come back unchanged. */
export function higgsfieldRawId(modelId: string): string {
  return modelId.startsWith(HIGGSFIELD_ID_PREFIX) ? modelId.slice(HIGGSFIELD_ID_PREFIX.length) : modelId;
}

/** House defaults, preferred when present in the catalog (probed working). */
const DEFAULT_IMAGE_MODEL = "cinematic_studio_2_5";
const DEFAULT_VIDEO_MODEL = "seedance_2_5";

const IMAGE_POLL_DEADLINE_MS = 5 * 60_000;
const VIDEO_POLL_DEADLINE_MS = 20 * 60_000;
const CATALOG_TTL_MS = 10 * 60_000;

const UUID_RX = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
// Live status words observed on job_status replies (2026-09-07: `queued` on a
// plain poll, `in_progress` on a sync:true poll that outlived the server's
// internal wait). Anything matching keeps polling; anything else is treated
// as terminal and must carry a result URL.
const NON_TERMINAL_RX = /queued|processing|running|pending|starting|submitted|in[-_ ]?progress|poll_after_seconds/i;
const FAILED_RX = /—\s*(failed|cancelled|error|nsfw|blocked)\b/i;

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strip the MCP namespace prefix (`higgsfield__⬦`) from a tool key. */
const rawToolName = (n: string) => n.replace(/^higgsfield__/, "");

/** One catalog parameter (resolution/duration/quality/⬦). */
export interface HiggsParam {
  name?: string;
  type?: string;
  description?: string;
  default?: unknown;
  options?: unknown[];
  min?: number;
  max?: number;
}

/** One catalog media declaration with its accepted roles. */
export interface HiggsMedia {
  name?: string;
  type?: string;
  roles?: string[];
  /** Declared max inputs for this media slot (e.g. "roles: image x1" →  1). */
  max?: number;
}

/** One models_explore catalog item (list/get/recommend share the shape). */
export interface HiggsModel {
  id?: string;
  name?: string;
  provider_name?: string;
  description?: string;
  output_type?: string;
  parameters?: HiggsParam[];
  medias?: HiggsMedia[];
  aspect_ratios?: string[];
}

export class HiggsfieldProvider implements MediaProvider {
  readonly id = "higgsfield" as const;
  readonly displayName = "Higgsfield";

  private catalogCache: { at: number; items: HiggsModel[] } | null = null;
  private detailCache = new Map<string, { at: number; model: HiggsModel | null }>();

  /** A recorder (the expenses ledger) that observes every successful
   *  generation with its resolved metadata. Injected so the tally is testable
   *  at the same seam as the McpManager fake. */
  constructor(
    private readonly mcp: McpManager,
    private readonly recorder?: GenerationRecorder
  ) {}

  /** Drop cached catalog/detail probes (dev customizer refresh). */
  refreshProbes(): void {
    this.catalogCache = null;
    this.detailCache.clear();
  }

  /** Fire the generation recorder; a tally write must never break a
   *  generation, so recorder errors are non-fatal. */
  private fireGeneration(meta: LedgerGenMeta): void {
    try {
      this.recorder?.onGeneration(meta);
    } catch {
      /* ignored */
    }
  }

  // ---- tool discovery -------------------------------------------------------

  /** The first connected Higgsfield tool whose raw name matches `pattern`, or null. */
  private findTool(pattern: RegExp): string | null {
    for (const key of Object.keys(this.mcp.getTools())) {
      const raw = rawToolName(key);
      if (pattern.test(raw)) return raw;
    }
    return null;
  }

  /** True when the connected MCP surface exposes Higgsfield image generation. */
  isAvailable(): boolean {
    return this.findTool(/^generate_image$/) !== null;
  }

  // ---- catalog --------------------------------------------------------------

  /** Fetch + cache the full image+video catalog (list is one call per type). */
  private async catalog(): Promise<HiggsModel[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS) {
      return this.catalogCache.items;
    }
    const items: HiggsModel[] = [];
    for (const type of ["image", "video"]) {
      const raw = await this.mcp.callRaw(SERVER, "models_explore", { action: "list", type, limit: 100 });
      const obj = parseJsonLooseObject(raw);
      const arr = obj && Array.isArray(obj.items) ? obj.items : [];
      for (const m of arr) {
        if (m && typeof m === "object") items.push(m as HiggsModel);
      }
    }
    this.catalogCache = { at: Date.now(), items };
    return items;
  }

  /** One model's catalog detail (cached); null when the model is unknown. */
  private async modelDetail(rawId: string): Promise<HiggsModel | null> {
    const hit = this.detailCache.get(rawId);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.model;
    let model: HiggsModel | null = null;
    try {
      const obj = parseJsonLooseObject(await this.mcp.callRaw(SERVER, "models_explore", { action: "get", model_id: rawId }));
      if (obj && typeof obj.id === "string") model = obj as unknown as HiggsModel;
    } catch {
      model = null;
    }
    // Fall back to the list copy (same shape, minus score fields).
    if (!model) {
      try {
        model = (await this.catalog()).find((m) => m.id === rawId) ?? null;
      } catch {
        model = null;
      }
    }
    this.detailCache.set(rawId, { at: Date.now(), model });
    return model;
  }

  private static imageCapable(m: HiggsModel): boolean {
    return m.output_type === "image";
  }

  private static videoCapable(m: HiggsModel): boolean {
    return m.output_type === "video";
  }

  /** Resolve a stored/selected id to the raw id to submit. "auto"/empty fall
   *  back to the house default (or the first model of that kind). An EXPLICIT
   *  pick that isn't in the vendor's catalog fails loudly instead of silently
   *  substituting another model — a stale cross-vendor pick once billed a
   *  job to the wrong model and hid behind an opaque server 500. */
  private async resolveImageModel(choice: string, items: HiggsModel[]): Promise<string> {
    const trimmed = (choice ?? "").trim();
    const raw = higgsfieldRawId(trimmed);
    const pool = items.filter(HiggsfieldProvider.imageCapable);
    if (raw && pool.some((m) => m.id === raw)) return raw;
    if (trimmed && trimmed !== "auto" && pool.length) {
      throw new Error(`"${trimmed}" isn't a Higgsfield image model (the active media provider is Higgsfield) — re-pick the model and retry; switching media providers can strand a stale pick.`);
    }
    return pool.some((m) => m.id === DEFAULT_IMAGE_MODEL) ? DEFAULT_IMAGE_MODEL : (pool[0]?.id ?? "");
  }

  private async resolveVideoModel(choice: string, items: HiggsModel[], preferEndFrame: boolean): Promise<string> {
    const trimmed = (choice ?? "").trim();
    const raw = higgsfieldRawId(trimmed);
    const pool = items.filter(HiggsfieldProvider.videoCapable);
    if (raw && pool.some((m) => m.id === raw)) return raw;
    if (trimmed && trimmed !== "auto" && pool.length) {
      throw new Error(`"${trimmed}" isn't a Higgsfield video model (the active media provider is Higgsfield) — re-pick the model and retry; switching media providers can strand a stale pick.`);
    }
    if (preferEndFrame) {
      const withEnd = pool.find((m) => HiggsfieldProvider.mediaRoles(m).includes("end_image"));
      if (withEnd?.id) return withEnd.id;
    }
    return pool.some((m) => m.id === DEFAULT_VIDEO_MODEL) ? DEFAULT_VIDEO_MODEL : (pool[0]?.id ?? "");
  }

  /** All media roles a model declares across its media entries. */
  private static mediaRoles(m: HiggsModel): string[] {
    const roles: string[] = [];
    for (const media of m.medias ?? []) {
      for (const r of media.roles ?? []) if (!roles.includes(r)) roles.push(r);
    }
    return roles;
  }

  /** Pick the role for a reference: preferred names first, then anything. */
  private static pickRole(roles: string[], preferred: string[]): string | null {
    for (const p of preferred) if (roles.includes(p)) return p;
    return roles[0] ?? null;
  }

  /** The role a video reference should ride, read from the media
   *  declarations: the first role whose name says video (the live catalog
   *  declares `video_references` on the image-type media entry), else the
   *  first role on a video-type media. Null when the model declares no video
   *  slot — a video reference then has nowhere native to go. */
  private static videoMediaRole(m: HiggsModel | null): string | null {
    if (!m) return null;
    for (const media of m.medias ?? []) {
      for (const r of media.roles ?? []) if (/^video/.test(r)) return r;
    }
    for (const media of m.medias ?? []) {
      if (media.type !== "video") continue;
      return (media.roles ?? [])[0] ?? null;
    }
    return null;
  }

  private static param(m: HiggsModel, name: string): HiggsParam | null {
    return m.parameters?.find((p) => p.name === name) ?? null;
  }

  /** True when a generate_video failure is the backend's "references don't
   *  belong in text-to-video mode" validation (live 2026-09-11: Seedance 2.5
   *  inferred mode 't2v' for an image_references + video_references submission
   *  and 422'd). That shape is retryable with the source frame as the
   *  start-image anchor; anything else must surface as-is. */
  private static isT2VRefsRejection(why: string): boolean {
    return /does not accept reference media/i.test(why)
      || (/t2v/i.test(why) && /reference/i.test(why));
  }

  /** The declared max count for a media role ("roles: image x1" →  1), or
   *  null when the catalog doesn't cap it. Uploading past the cap can get
   *  the whole submission rejected, so callers stop at the limit. */
  private static roleMax(m: HiggsModel | null, role: string | null): number | null {
    if (!m || !role) return null;
    for (const media of m.medias ?? []) {
      if (!(media.roles ?? []).includes(role)) continue;
      return typeof media.max === "number" && media.max > 0 ? Math.floor(media.max) : null;
    }
    return null;
  }

  // ---- model discovery ------------------------------------------------------

  /** Shape the Higgsfield catalog into dropdown choices. */
  private shapeModelChoices(items: HiggsModel[]): OpenArtModelChoice[] {
    const out: OpenArtModelChoice[] = [];
    for (const m of items) {
      const rawId = typeof m.id === "string" ? m.id.trim() : "";
      if (!rawId) continue;
      const name = typeof m.name === "string" && m.name ? m.name : rawId;
      const desc = typeof m.description === "string" ? m.description : "";
      const provider = typeof m.provider_name === "string" && m.provider_name ? ` — ${m.provider_name}` : "";
      out.push({
        id: `${HIGGSFIELD_ID_PREFIX}${rawId}`,
        displayName: name,
        description: `${desc}${provider}`,
        imageInput: HiggsfieldProvider.imageCapable(m) && (m.medias?.length ?? 0) > 0,
        videoInput: HiggsfieldProvider.videoCapable(m),
        cost: null, // per-model cost needs a get_cost preflight; unknown here
      });
    }
    return out;
  }

  /** The Higgsfield model dropdown, resolved from the connected server. */
  async listModelChoices(): Promise<OpenArtModelChoice[]> {
    return this.shapeModelChoices(await this.catalog());
  }

  /** The signed-in Higgsfield account's remaining credit balance, or null.
   *  The reply is prose (`Credits: 1388.74 | Plan: ultimate`). */
  async getCredits(): Promise<number | null> {
    let raw = "";
    try {
      raw = await this.mcp.callRaw(SERVER, "balance", {});
    } catch {
      return null;
    }
    const m = raw.match(/Credits:\s*([\d.]+)/i)?.[1];
    const n = m !== undefined ? Number(m) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  /** Warm the per-model detail cache for every video-capable model.
   *  Fire-and-forget: the caller returns immediately so listing models
   *  never waits on detail lookups. */
  prewarm(models: OpenArtModelChoice[]): void {
    for (const m of models) {
      if (!m.videoInput) continue;
      const raw = higgsfieldRawId(m.id);
      if (!raw || raw === "auto") continue;
      void this.modelDetail(raw).catch(() => {});
    }
  }

  // ---- upload ---------------------------------------------------------------

  /** Parse a media_upload reply into its media_id + presigned PUT URL. */
  private static parseUploadReply(text: string): { mediaId: string; putUrl: string } | null {
    const mediaId = text.match(/media_id "([0-9a-fA-F-]{36})"/i)?.[1];
    const putUrl = text.match(/'(https:[^']+)'/)?.[1];
    return mediaId && putUrl ? { mediaId, putUrl } : null;
  }

  private static mimeToExt(mime: string): string {
    if (/png/i.test(mime)) return "png";
    if (/webp/i.test(mime)) return "webp";
    if (/gif/i.test(mime)) return "gif";
    if (/mp4/i.test(mime)) return "mp4";
    return "jpg";
  }

  /**
   * Upload a data-URL image and return its confirmed media_id, ready for
   * `medias[].value`. Flow: media_upload →  PUT bytes to the presigned URL → 
   * media_confirm. Throws when any step fails (callers decide per-ref
   * whether that is fatal).
   */
  private async uploadDataUrl(dataUrl: string, label: string): Promise<string> {
    const comma = dataUrl.indexOf(",");
    const mime = /^data:([^;,]+)/.exec(dataUrl.slice(0, Math.max(0, comma)))?.[1] ?? "image/jpeg";
    const bytes = dataUrlToBytes(dataUrl);
    if (!bytes) throw new Error("Not a base64 data-URL image.");
    const safe = (label.split("/").pop() ?? "ref").replace(/\.[^.]+$/, "").replace(/[^\w\- ]+/g, "").trim() || "ref";
    const text = await this.mcp.callRaw(SERVER, "media_upload", {
      filename: `${safe}.${HiggsfieldProvider.mimeToExt(mime)}`,
      content_type: mime,
    });
    const parsed = HiggsfieldProvider.parseUploadReply(text);
    if (!parsed) throw new Error(`Higgsfield did not return an upload URL: ${text.slice(0, 200)}`);
    const put = await fetch(parsed.putUrl, {
      method: "PUT",
      headers: { "Content-Type": mime },
      body: Buffer.from(bytes),
    });
    if (!put.ok) throw new Error(`upload to Higgsfield failed (HTTP ${put.status})`);
    const type = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "image";
    const confirmed = await this.mcp.callRaw(SERVER, "media_confirm", { type, media_id: parsed.mediaId });
    if (!/Confirmed/i.test(confirmed)) throw new Error(`Higgsfield did not confirm the upload: ${confirmed.slice(0, 200)}`);
    return parsed.mediaId;
  }

  // ---- submit + poll ----------------------------------------------------------

  /** Pull the job UUID out of a generate submit reply. Only the
   *  `- <uuid> "<prompt>"` job lines count — other replies (notably the
   *  preset-matcher notice) also carry UUIDs (preset ids) that must never be
   *  polled as jobs. */
  private static submitJobId(text: string): string | null {
    return text.match(new RegExp(`^-\\s*(${UUID_RX.source})\\s+"`, "m"))?.[1] ?? null;
  }

  /** A preset-matcher notice ("This prompt looks like the Higgsfield preset
   *  …") submits no job — it offers a preset id plus a `declined_preset_id`
   *  bypass for literal generation. Returns the preset name + id when the
   *  reply carries a notice and no job line, else null. */
  private static presetNotice(text: string): { name: string; id: string } | null {
    if (HiggsfieldProvider.submitJobId(text)) return null;
    const id = text.match(new RegExp(`preset[_ ]id:\\s*"(${UUID_RX.source})"`, "i"))?.[1]
      ?? text.match(new RegExp(`preset[_ ]id:\\s*(${UUID_RX.source})\\b`, "i"))?.[1];
    if (!id) return null;
    const name = text.match(/preset\s+"([^"]+)"/i)?.[1] ?? "preset";
    return { name, id };
  }

  /** One attempt to fetch bytes from a URL; null when not fetchable. */
  private async fetchBytes(url: string): Promise<Buffer | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length ? buf : null;
    } catch {
      return null;
    }
  }

  /**
   * Poll job_status (sync:true long-polls ~25s server-side) until the job
   * leaves its non-terminal states, then return the result text + content
   * URIs. Throws on FAILED/CANCELLED; throws a timeout error past the
   * deadline (the job keeps rendering server-side — the caller's pending
   * record carries the job id for a later recheck).
   */
  private async waitJob(
    jobId: string,
    deadlineMs: number,
    onStatus?: (status: string) => void
  ): Promise<{ text: string; uris: string[] }> {
    const deadline = Date.now() + deadlineMs;
    let lastStatus = "";
    for (let i = 0; i < 200 && Date.now() < deadline; i++) {
      const res = await this.mcp.callRawContent(SERVER, "job_status", { jobId, sync: true });
      const failed = res.text.match(FAILED_RX)?.[1];
      if (failed) throw new Error(`Higgsfield generation ${failed.toLowerCase()} (${jobId.slice(0, 8)}⬦).`);
      if (!NON_TERMINAL_RX.test(res.text)) return { text: res.text, uris: res.uris };
      const status = res.text.match(/—\s*([a-z_]+)/i)?.[1] ?? "";
      if (status && status !== lastStatus) {
        lastStatus = status;
        onStatus?.(status);
      }
    }
    throw new Error(`Higgsfield generation timed out (${jobId.slice(0, 8)}⬦).`);
  }

  /** Extract the finished-asset URL out of a terminal job reply. */
  private static resultUrl(text: string, uris: string[], video: boolean): string | null {
    const rx = video ? VIDEO_URL_RX : IMAGE_URL_RX;
    return text.match(rx)?.[0] ?? uris.find((u) => (video ? /\.(mp4|webm|mov|m4v)(\?|$)/i : /\.(png|jpe?g|webp|gif)(\?|$)/i).test(u)) ?? null;
  }

  // ---- video options ----------------------------------------------------------

  /** The resolution / length options a video model accepts (from its catalog
   *  parameters). Null when the model is foreign or unknown. */
  async videoModelOptions(modelId: string, withImage: boolean): Promise<VideoModelOptions | null> {
    const raw = higgsfieldRawId(modelId);
    if (!raw || raw === "auto") return null;
    const detail = await this.modelDetail(raw).catch(() => null);
    if (!detail || !HiggsfieldProvider.videoCapable(detail)) return null;
    if (withImage && HiggsfieldProvider.mediaRoles(detail).length === 0) return null;
    const out: VideoModelOptions = { resolutions: [], durations: [] };
    const resParam = HiggsfieldProvider.param(detail, "resolution");
    if (resParam && Array.isArray(resParam.options)) {
      for (const v of resParam.options) {
        const s = String(v).trim();
        if (s) out.resolutions.push(s);
      }
    }
    const durParam = HiggsfieldProvider.param(detail, "duration");
    if (durParam) {
      if (Array.isArray(durParam.options)) {
        for (const v of durParam.options) {
          const n = Number(String(v).replace(/[^0-9.]/g, ""));
          if (Number.isFinite(n) && n > 0 && n <= 120) out.durations.push(Math.round(n));
        }
      } else {
        const min = Number(durParam.min) > 0 ? Math.ceil(Number(durParam.min)) : 1;
        const max = Number(durParam.max) > 0 ? Math.floor(Number(durParam.max)) : min;
        for (let n = min; n <= max && out.durations.length < 60; n++) out.durations.push(n);
      }
    }
    out.resolutions = Array.from(new Set(out.resolutions));
    out.durations = Array.from(new Set(out.durations)).sort((a, b) => a - b);
    return out;
  }

  /** The quality tier an image model accepts, read from its catalog detail
   *  (a `quality`-named parameter with string options, e.g. Seedream's
   *  basic/high). Null for foreign ids, unknown models, and models declaring
   *  no quality options — the caller then hides the quality dropdown and the
   *  vendor default applies. */
  async imageModelOptions(modelId: string): Promise<ImageModelOptions | null> {
    const raw = higgsfieldRawId(modelId);
    if (!raw || raw === "auto") return null;
    const detail = await this.modelDetail(raw).catch(() => null);
    if (!detail || !HiggsfieldProvider.imageCapable(detail)) return null;
    const quality = (detail.parameters ?? []).find((qp) => /^quality$/i.test(qp.name ?? ""));
    if (!quality || !Array.isArray(quality.options)) return null;
    const qualities = Array.from(
      new Set(
        quality.options
          .map((v) => String(v).trim())
          .filter((s) => s && !/^(auto|default)$/i.test(s))
      )
    );
    if (!qualities.length) return null;
    const def = String(quality.default ?? "").trim();
    return {
      qualities,
      defaultQuality: def && qualities.some((q) => q.toLowerCase() === def.toLowerCase()) ? def : null,
    };
  }

  /** The full normalized option schema for a model (dev customizer probe),
   *  built from the catalog detail's `parameters` + `medias`. Null for
   *  foreign ids and unknown models. */
  async modelOptions(modelId: string): Promise<CliModelSchema | null> {
    const raw = higgsfieldRawId(modelId);
    if (!raw || raw === "auto") return null;
    const detail = await this.modelDetail(raw).catch(() => null);
    if (!detail) return null;
    const params: RawModelParam[] = [];
    const seen = new Set<string>();
    const fold = (s: string) => s.toLowerCase().replace(/[_-]+/g, "");
    const push = (p: RawModelParam): void => {
      const key = fold(p.name);
      if (!key || seen.has(key)) return;
      seen.add(key);
      params.push(p);
    };
    for (const p of detail.parameters ?? []) {
      push({
        name: p.name ?? "",
        type: p.type,
        options: Array.isArray(p.options) ? p.options.map((v) => String(v)) : undefined,
        default: p.default,
        min: p.min,
        max: p.max,
      });
    }
    for (const m of detail.medias ?? []) {
      push({ name: m.name ?? "", type: m.type, media: true, maxItems: m.max });
    }
    return buildModelSchema({
      jobType: raw,
      params,
      roles: HiggsfieldProvider.mediaRoles(detail),
      aspectRatios: detail.aspect_ratios ?? [],
    });
  }

  /** Ids (namespaced) of the video-capable models declaring a dedicated
   *  end-frame role. Empty when none is proven — the caller unions this with
   *  the user's manual allowlist before the tween dropdown offers anything. */
  async videoEndFrameModels(): Promise<string[]> {
    let items: HiggsModel[] = [];
    try {
      items = await this.catalog();
    } catch {
      return [];
    }
    return items
      .filter((m) => HiggsfieldProvider.videoCapable(m) && m.id && HiggsfieldProvider.mediaRoles(m).includes("end_image"))
      .map((m) => `${HIGGSFIELD_ID_PREFIX}${m.id}`);
  }

  /** No project concept on Higgsfield — generations always land in the
   *  account/workspace default, so there is nothing to resolve. */
  async resolveProject(_p: Production, _onNotice?: (msg: string) => void): Promise<string | null> {
    return null;
  }

  // ---- generation ---------------------------------------------------------------

  /** Read a production file into a data URL (for source frames). */
  private static fileDataUrl(p: Production, rel: string, label: string): { name: string; dataUrl: string } {
    const buf = fs.readFileSync(assetPath(p, rel));
    const ext = (path.extname(rel).slice(1).toLowerCase() || "jpg").replace("jpeg", "jpg");
    const mime = ext === "jpg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : "image/jpeg";
    return { name: label, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
  }

  /**
   * Resolve the Step 3 image generator, or null when Higgsfield isn't
   * connected. Mirrors the OpenArt imageGenFn contract (same ImageGenFn
   * shape) so pipeline callers never know which vendor served the frame.
   */
  imageGenFn(
    p: Production,
    modelOverride?: string,
    resolutionOverride?: string,
    onNotice?: (msg: string) => void,
    aspectRatio: ImageGenAspectRatio = "16:9"
  ): ImageGenFn | null {
    if (!this.findTool(/^generate_image$/)) return null;

    return async (prompt: string, refs: { name: string; dataUrl: string }[], shot?: ProductionShot): Promise<Buffer> => {
      if (shot?.pendingImageGen) delete shot.pendingImageGen;

      let items: HiggsModel[] = [];
      try {
        items = await this.catalog();
      } catch {
        items = [];
      }
      const choice = modelOverride ?? p.openArt?.model ?? "auto";
      const modelId = await this.resolveImageModel(choice, items);
      if (!modelId) throw new Error("Higgsfield MCP isn't connected (no image model found), so frames can't be generated in-app.");
      const detail = await this.modelDetail(modelId).catch(() => null);

      // Upload reference art; every ref becomes a medias entry under the
      // model's image role (failures fall back to text-only, as on OpenArt).
      // `uploaded` mirrors `refs` (media_id per success, null per failure),
      // which the prompt citation below uses for positional anchoring.
      const roles = detail ? HiggsfieldProvider.mediaRoles(detail) : [];
      const role = HiggsfieldProvider.pickRole(roles, ["image", "image_references"]);
      const roleCap = HiggsfieldProvider.roleMax(detail, role);
      const medias: { value: string; role: string }[] = [];
      const uploaded: (string | null)[] = [];
      if (role) {
        for (const r of refs) {
          if (roleCap !== null && medias.length >= roleCap) {
            uploaded.push(null);
            continue;
          }
          try {
            const id = await this.uploadDataUrl(r.dataUrl, r.name);
            medias.push({ value: id, role });
            uploaded.push(id);
          } catch {
            uploaded.push(null); /* non-fatal: ref falls back to text-only */
          }
        }
      } else {
        for (let i = 0; i < refs.length; i++) uploaded.push(null);
      }
      const fullPrompt = citePrompt(prompt, refs, uploaded, styleRefNames(p));

      const params: Record<string, unknown> = { model: modelId, prompt: fullPrompt, count: 1 };
      const aspects = detail?.aspect_ratios ?? [];
      if (aspects.includes(aspectRatio)) params.aspect_ratio = aspectRatio;
      const resolution = resolutionOverride ?? p.openArt?.resolution ?? "1k";
      const resParam = detail ? HiggsfieldProvider.param(detail, "resolution") : null;
      if (resParam && Array.isArray(resParam.options)) {
        const want = String(resolution).toLowerCase();
        const match = resParam.options.find((v) => String(v).toLowerCase() === want);
        if (match !== undefined) params.resolution = match;
      }
      // Quality tier (Seedream basic/high, Hazel low/medium/high, …): sent
      // ONLY when the production config names a tier the model's catalog
      // actually declares — never guessed, so models without a quality param
      // keep their vendor default.
      const qualityParam = detail ? (detail.parameters ?? []).find((qp) => /^quality$/i.test(qp.name ?? "")) : null;
      const wantQuality = (p.openArt?.quality ?? "").trim();
      if (qualityParam && Array.isArray(qualityParam.options) && wantQuality) {
        const match = qualityParam.options.find((v) => String(v).trim().toLowerCase() === wantQuality.toLowerCase());
        if (match !== undefined) params.quality = match;
      }
      if (medias.length) params.medias = medias;

      // Diagnostics: surface exactly what reaches Higgsfield (mirrors the
      // video path's paramDump) so a wrong-model suspicion can be settled
      // from the log instead of the website's history view.
      onNotice?.(
        `Submitting image job via ${modelId} ` +
          `(${[
            `resolution=${JSON.stringify(params.resolution ?? resolution)}`,
            params.quality !== undefined ? `quality=${JSON.stringify(params.quality)}` : "",
            params.aspect_ratio !== undefined ? `aspect_ratio=${JSON.stringify(params.aspect_ratio)}` : "",
            medias.length ? `medias[${medias.map((m) => m.role).join("|")}] x${medias.length}` : "no medias",
          ]
            .filter(Boolean)
            .join(" ")})`
      );

      let text = await this.mcp.callRaw(SERVER, "generate_image", { params });
      // The prompt can match a Higgsfield preset ("IN THE DARK", …) — the
      // server then returns a notice instead of a job. Decline it once and
      // generate the prompt literally; a bare preset id must never reach the
      // job parser (polling it 500s with "Something went wrong").
      const preset = HiggsfieldProvider.presetNotice(text);
      if (preset) {
        onNotice?.(`Higgsfield matched the "${preset.name}" preset — declining it and generating your prompt literally…`);
        text = await this.mcp.callRaw(SERVER, "generate_image", { params: { ...params, declined_preset_id: preset.id } });
      }
      const genMeta: LedgerGenMeta = {
        kind: "image",
        model: `${HIGGSFIELD_ID_PREFIX}${modelId}`,
        resolution,
        aspectRatio,
        at: Date.now(),
        productionId: p.meta.id,
        shotId: shot?.id,
      };

      const jobId = HiggsfieldProvider.submitJobId(text);
      if (jobId) {
        let done: { text: string; uris: string[] };
        try {
          done = await this.waitJob(jobId, IMAGE_POLL_DEADLINE_MS);
        } catch (e) {
          // The job keeps rendering server-side — record it as pending so the
          // finished frame can be reclaimed instead of re-paid.
          if (shot && e instanceof Error && /timed out/.test(e.message)) {
            shot.pendingImageGen = { historyId: jobId, prompt, model: `${HIGGSFIELD_ID_PREFIX}${modelId}`, resolution, aspectRatio, at: new Date().toISOString() };
          }
          throw e;
        }
        const url = HiggsfieldProvider.resultUrl(done.text, done.uris, false);
        if (url) {
          const buf = await this.fetchBytes(url);
          if (buf) {
            this.fireGeneration(genMeta);
            return buf;
          }
          if (shot) shot.pendingImageGen = { url, prompt, model: `${HIGGSFIELD_ID_PREFIX}${modelId}`, resolution, aspectRatio, at: new Date().toISOString() };
          throw new Error("Couldn't download the generated image.");
        }
        throw new Error(`Higgsfield returned no image (${done.text.slice(0, 120) || "empty reply"})`);
      }

      // Synchronous result (no job id): scan for a direct image URL.
      const url = text.match(IMAGE_URL_RX)?.[0];
      if (!url) throw new Error(`Higgsfield returned no image (${text.slice(0, 120) || "empty reply"})`);
      const buf = await this.fetchBytes(url);
      if (!buf) {
        if (shot) shot.pendingImageGen = { url, prompt, model: `${HIGGSFIELD_ID_PREFIX}${modelId}`, resolution, aspectRatio, at: new Date().toISOString() };
        throw new Error("Couldn't download the generated image.");
      }
      this.fireGeneration(genMeta);
      return buf;
    };
  }

  /**
   * Recheck a pending image job and return the finished bytes, or null when
   * it's still rendering (or the result URL still can't be fetched). The
   * pending record's historyId carries the Higgsfield job UUID. Throws when
   * the job reports FAILED/CANCELLED (nothing left to reclaim).
   */
  async recheckPendingImage(rec: PendingImageGen): Promise<Buffer | null> {
    if (rec.historyId) {
      if (!this.findTool(/^job_status$/)) return null;
      let done: { text: string; uris: string[] };
      try {
        done = await this.waitJob(rec.historyId, 60_000);
      } catch (e) {
        // A recheck is a quick probe, not a fresh wait — a timeout means
        // "still rendering", not failure. Only FAILED/CANCELLED throws.
        if (e instanceof Error && /timed out/.test(e.message)) return null;
        throw e;
      }
      const url = HiggsfieldProvider.resultUrl(done.text, done.uris, false);
      return url ? this.fetchBytes(url) : null;
    }
    if (rec.url) return this.fetchBytes(rec.url);
    return null;
  }

  /**
   * Generate one video clip for a shot. Mirrors the OpenArt generateVideoClip
   * contract (same args, same { rel } result). Role binding: in-betweener
   * submissions (frameRefs) put the start/end keyframes in the model's
   * start_image/end_image slots; ordinary node-graph/modaless submissions ride
   * the generic reference path — the source frame lands in the image-reference
   * role and dropped video clips land in the model's video element role,
   * downscaled to 720p first (mirroring OpenArt's video-ref resize) so a
   * capped model doesn't reject the submission. When the backend answers that
   * references don't belong in the inferred text-to-video mode (Seedance 2.5
   * 422), ordinary submissions retry ONCE with the source frame rebound to
   * start_image — the image-to-video anchor — reusing the uploaded media ids.
   */
  async generateVideoClip(
    p: Production,
    shot: ProductionShot,
    opts: VideoGenOptions,
    emit: ProviderEmit,
    sourcePathOverride?: string,
    extraRefs?: { name: string; dataUrl: string }[],
    frameRefs?: { start: { name: string; dataUrl: string }; end?: { name: string; dataUrl: string } }
  ): Promise<{ rel: string }> {
    if (!this.findTool(/^generate_video$/)) {
      throw new Error("Higgsfield MCP isn't connected (no video-generation tool found), so videos can't be generated in-app.");
    }

    let items: HiggsModel[] = [];
    try {
      items = await this.catalog();
    } catch {
      items = [];
    }

    // References: the source frame(s) first, then extras, then @[name] tags —
    // the same assembly order OpenArt uses (tokens are @image1-based).
    const refs: { name: string; dataUrl: string }[] = [];
    if (frameRefs) {
      refs.push(frameRefs.start);
      if (frameRefs.end) refs.push(frameRefs.end);
    } else {
      const sourceRel = sourcePathOverride?.trim() || shot.artwork;
      if (!sourceRel) throw new Error("No source frame — pipe a frame into the video node or generate one first.");
      refs.push(HiggsfieldProvider.fileDataUrl(p, sourceRel, `Shot ${shot.number} frame`));
    }
    refs.push(...(extraRefs ?? []));
    // includeVideo: a @[name] tag can cite a dropped video reference, whose
    // bytes live in mediaPath (no artwork) — same as the OpenArt path.
    const { resolved, extras } = resolvePromptRefs(p, opts.prompt, refs.length, true);
    refs.push(...extras);

    const modelId = await this.resolveVideoModel(opts.model, items, Boolean(frameRefs?.end));
    if (!modelId) throw new Error("Higgsfield MCP isn't connected (no video model found), so videos can't be generated in-app.");
    const detail = await this.modelDetail(modelId).catch(() => null);
    const roles = detail ? HiggsfieldProvider.mediaRoles(detail) : [];
    const startRole = HiggsfieldProvider.pickRole(roles, ["start_image", "image", "image_references"]);
    const refRole = HiggsfieldProvider.pickRole(roles, ["image_references", "image"]);
    const videoRole = HiggsfieldProvider.videoMediaRole(detail);
    const endRole = detail && roles.includes("end_image")
      ? "end_image"
      : (refRole ?? startRole);

    // `uploaded` mirrors `refs` (media_id per success, null per failure) so
    // the prompt citation can anchor tokens to submitted positions.
    // `boundRoles` mirrors `refs` with the role each ref was submitted under
    // (null when it had nowhere to go), so a t2v-rejection retry can rebind
    // the source frame without re-uploading anything.
    const medias: { value: string; role: string }[] = [];
    const uploaded: (string | null)[] = [];
    const boundRoles: (string | null)[] = [];
    for (const [i, r] of refs.entries()) {
      // In-betweener submissions bind keyframes to their slots (start → start,
      // end → end). Everything else rides the reference path: image refs —
      // including the source frame — go to the generic image-reference role
      // (never the start-image slot, so no dropped reference can be mistaken
      // for a keyframe), and video references go to the model's video-element
      // role when it declares one.
      const isVideoRef = /^data:video\//i.test(r.dataUrl);
      const wantRole = frameRefs?.end && i === 1
        ? endRole
        : (frameRefs && i === 0)
          ? startRole
          : isVideoRef
            ? (videoRole ?? refRole ?? startRole)
            : (refRole ?? startRole);
      if (!wantRole) {
        uploaded.push(null);
        boundRoles.push(null);
        emit(`Reference "${r.name}" has nowhere to go on ${modelId} — continuing without it.`, "error");
        continue;
      }
      try {
        let dataUrl = r.dataUrl;
        if (isVideoRef) {
          const resized = await resizeVideoRef(dataUrl);
          if (resized !== dataUrl) {
            dataUrl = resized;
            emit(`Shot ${shot.number}: resized video reference "${r.name}" to ${VIDEO_REF_MAX_HEIGHT}p for this model.`);
          }
        }
        const id = await this.uploadDataUrl(dataUrl, r.name);
        medias.push({ value: id, role: wantRole });
        uploaded.push(id);
        boundRoles.push(wantRole);
      } catch (e) {
        uploaded.push(null);
        boundRoles.push(wantRole);
        const why = e instanceof Error ? e.message : String(e);
        emit(`Reference "${r.name}" couldn't be uploaded (${why}) — continuing without it.`, "error");
      }
    }
    const fullPrompt = citePrompt(resolved, refs, uploaded, styleRefNames(p));

    const params: Record<string, unknown> = { model: modelId, prompt: fullPrompt, count: 1 };
    const durParam = detail ? HiggsfieldProvider.param(detail, "duration") : null;
    // Fail loudly when the catalog proves the model can't do the requested
    // length — silently clamping to the model's min once turned a 2s tween
    // block into a longer clip with no warning. Unknown options (no duration
    // param on the model detail) still pass the request through unchecked.
    const durationSec = Math.round(opts.durationSec) || 5;
    if (durParam) {
      if (Array.isArray(durParam.options)) {
        const nums = durParam.options
          .map((v) => Math.round(Number(String(v).replace(/[^0-9.]/g, ""))))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (nums.length && !nums.includes(durationSec)) {
          const sorted = [...new Set(nums)].sort((a, b) => a - b);
          throw new Error(`"${modelId}" doesn't support a ${durationSec}s clip (supports ${sorted.join(", ")}s) — retime the block or pick another model.`);
        }
      } else {
        const min = Number(durParam.min) > 0 ? Math.ceil(Number(durParam.min)) : 1;
        const max = Number(durParam.max) > 0 ? Math.floor(Number(durParam.max)) : durationSec;
        if (durationSec < min || durationSec > max) {
          throw new Error(`"${modelId}" doesn't support a ${durationSec}s clip (supports ${min}–${max}s) — retime the block or pick another model.`);
        }
      }
      params.duration = durationSec;
    } else {
      params.duration = durationSec;
    }
    const resParam = detail ? HiggsfieldProvider.param(detail, "resolution") : null;
    if (resParam && Array.isArray(resParam.options) && opts.resolution) {
      const want = String(opts.resolution).replace(/\s+/g, "").toLowerCase();
      const match = resParam.options.find((v) => String(v).replace(/\s+/g, "").toLowerCase() === want);
      if (match !== undefined) params.resolution = match;
    }
    const aspects = detail?.aspect_ratios ?? [];
    if (aspects.includes("16:9")) params.aspect_ratio = "16:9";
    if (medias.length) params.medias = medias;

    // Diagnostics: surface exactly what reaches Higgsfield so a server-side
    // rejection (the opaque "Something went wrong" 500) can be mirrored by a
    // probe and attached to a support ticket. Prompt text is shown truncated;
    // the params carry nothing sensitive.
    const dumpParams = (ms: { value: string; role: string }[]): string =>
      [
        `model=${modelId}`,
        `duration=${JSON.stringify(params.duration)}`,
        params.resolution !== undefined ? `resolution=${JSON.stringify(params.resolution)}` : "",
        params.aspect_ratio !== undefined ? `aspect_ratio=${JSON.stringify(params.aspect_ratio)}` : "",
        `count=${JSON.stringify(params.count)}`,
        ms.length ? `medias[${ms.map((m) => m.role).join("|")}] x${ms.length}` : "no medias",
        `prompt=${JSON.stringify(String(params.prompt ?? "").slice(0, 140))}`,
      ].filter(Boolean).join(" ");
    let paramDump = dumpParams(medias);
    emit(`Shot ${shot.number}: submitting video job via ${modelId}⬦ (${paramDump})`);
    let text: string;
    try {
      text = await this.mcp.callRaw(SERVER, "generate_video", { params });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      // The backend inferred text-to-video mode and rejected the references.
      // Retry once with the source frame as the start-image anchor (the
      // image-to-video trigger), reusing the uploaded media ids — no
      // re-upload, no prompt change. Tween submissions already bind keyframe
      // slots, so there is nothing to rebind there.
      const canReanchor = !frameRefs
        && medias.length > 0
        && uploaded[0] != null
        && boundRoles[0] !== "start_image"
        && roles.includes("start_image");
      if (!canReanchor || !HiggsfieldProvider.isT2VRefsRejection(why)) {
        throw new Error(`${why} — submitted: ${paramDump}`);
      }
      emit(`Shot ${shot.number}: ${modelId} rejected references in text-to-video mode — retrying with the source frame as the start image…`);
      const reanchored: { value: string; role: string }[] = [];
      for (const [i, id] of uploaded.entries()) {
        if (id == null) continue;
        const role = i === 0 ? "start_image" : boundRoles[i];
        if (!role) continue;
        reanchored.push({ value: id, role });
      }
      if (!reanchored.length || !reanchored.some((m) => m.role === "start_image")) {
        throw new Error(`${why} — submitted: ${paramDump}`);
      }
      params.medias = reanchored;
      paramDump = dumpParams(reanchored);
      emit(`Shot ${shot.number}: retrying video job via ${modelId}⬦ (${paramDump})`);
      try {
        text = await this.mcp.callRaw(SERVER, "generate_video", { params });
      } catch (e2) {
        const why2 = e2 instanceof Error ? e2.message : String(e2);
        throw new Error(`${why2} — submitted: ${paramDump} (first attempt: ${why})`);
      }
    }
    // The prompt can match a Higgsfield preset ("IN THE DARK", …) — the
    // server then returns a notice instead of a job. Decline it once and
    // generate the prompt literally; a bare preset id must never reach the
    // job parser (polling it 500s with "Something went wrong").
    const preset = HiggsfieldProvider.presetNotice(text);
    if (preset) {
      emit(`Shot ${shot.number}: Higgsfield matched the "${preset.name}" preset — declining it and generating your prompt literally…`);
      text = await this.mcp.callRaw(SERVER, "generate_video", { params: { ...params, declined_preset_id: preset.id } });
    }

    const done = await (async (): Promise<{ buf: Buffer; ext: string }> => {
      const jobId = HiggsfieldProvider.submitJobId(text);
      if (jobId) {
        const waited = await this.waitJob(jobId, VIDEO_POLL_DEADLINE_MS, (status) =>
          emit(`Shot ${shot.number}: video ${status.toLowerCase()}⬦ still rendering.`, "info")
        );
        const url = HiggsfieldProvider.resultUrl(waited.text, waited.uris, true);
        if (url) {
          const buf = await this.fetchBytes(url);
          if (buf) {
            const ext = (path.extname(new URL(url).pathname) || ".mp4").replace(/^\./, "").toLowerCase() || "mp4";
            return { buf, ext };
          }
        }
      }
      const url = text.match(VIDEO_URL_RX)?.[0];
      if (!url) throw new Error(`Higgsfield returned no video (${text.slice(0, 120) || "empty reply"})`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't download the generated video (HTTP ${res.status})`);
      const ext = (path.extname(new URL(url).pathname) || ".mp4").replace(/^\./, "").toLowerCase() || "mp4";
      return { buf: Buffer.from(await res.arrayBuffer()), ext };
    })();

    const safeExt = /^[a-z0-9]{2,4}$/i.test(done.ext) ? done.ext : "mp4";
    const rel = writeShotVideo(p, shot, done.buf, safeExt);

    this.fireGeneration({
      kind: "video",
      model: `${HIGGSFIELD_ID_PREFIX}${modelId}`,
      resolution: opts.resolution || "",
      durationSec,
      at: Date.now(),
      productionId: p.meta.id,
      shotId: shot.id,
    });

    return { rel };
  }
}
