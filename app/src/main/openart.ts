/**
 * OpenArtClient — the OpenArt MCP server's domain module.
 *
 * Owns the whole OpenArt vertical slice that previously lived inside
 * index.ts's registerIpc() closure: model discovery, live form-schema
 * introspection, per-model option assignment, async image/video generation
 * (including the PENDING-submission → wait/poll loop), project resolution, and
 * the per-model video-options cache. index.ts only wires IPC channels to this
 * module — nothing here touches Electron.
 *
 * The McpManager is injected via the constructor, which is the seam: a fake
 * manager substitutes for the live server in tests, so the module's interface
 * IS the test surface.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { McpManager } from "./mcp.js";
import { assetPath, refToken, refArtworkDataUrl, type ImageGenFn, type GenerationRef } from "./pipeline.js";
import { uploadDataUrlReference } from "./openart-upload.js";
import {
  IMAGE_URI_EXT_RX,
  IMAGE_URL_RX,
  parseJsonLooseArray,
  parseJsonLooseObject,
  refTagMatches,
  VIDEO_URI_EXT_RX,
  VIDEO_URL_RX,
} from "../shared/prompt-grammar.js";
import type {
  ImageGenAspectRatio,
  LedgerGenMeta,
  OpenArtBoardConfig,
  OpenArtModelChoice,
  PendingImageGen,
  Production,
  ProductionEvent,
  ProductionShot,
  VideoGenOptions,
  VideoModelOptions,
} from "../shared/ipc.js";

const SERVER = "openart";

/** Strip the MCP namespace prefix (`openart__…`) from a tool key. */
const rawToolName = (n: string) => n.replace(/^openart__/, "");

/** The log-line callback generation flows emit through (mirrors productionEmit). */
export type OpenArtEmit = (m: string, l?: ProductionEvent["level"]) => void;

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long to keep polling a video job before giving up. Video generation
 *  routinely takes several minutes, so this is far beyond the MCP per-call
 *  timeout (120 s) — a slow render must never look like a "connection
 *  timed out" error, and the finished clip must still be downloaded. */
const VIDEO_WAIT_DEADLINE_MS = 20 * 60_000;

/** The image wait cap per frame (~2.5 min). The OpenArt job keeps rendering
 *  server-side past this cap, so the historyId is recorded as pending and can
 *  be reclaimed by a recheck instead of paying for a second generation. */
const IMAGE_WAIT_DEADLINE_MS = 150_000;

/** How long one recheck probes a pending image job before reporting it as
 *  still rendering. A quick probe, not a fresh generation — if the frame
 *  isn't ready yet the user can recheck again later. */
const IMAGE_RECHECK_DEADLINE_MS = 60_000;

/** Thrown when an async OpenArt image job outlives the wait cap. The job is
 *  NOT dead — it keeps rendering server-side — so callers can record the
 *  historyId as pending and reclaim the finished image later. FAILED/CANCELLED
 *  completions throw a plain Error instead (the job is dead; nothing to
 *  reclaim). */
export class OpenArtImagePendingError extends Error {
  constructor(readonly historyId: string) {
    super(`OpenArt image generation timed out (${historyId.slice(0, 8)}…).`);
    this.name = "OpenArtImagePendingError";
  }
}

/** Minimal shape of an OpenArt project (from list or create). */
interface RawProject { id?: unknown; name?: unknown; canGenerate?: unknown }

/** Fit the uploaded visual references into the video model's reference field.
 *  The workflow is always "text prompt + start frame" (image2video): the frame
 *  is a single image, so single-image object fields (startFrame, inputImage, …)
 *  are preferred over array-style fields (visualReferences). Returns null when
 *  no reference field is found — the caller then falls back to
 *  `params.visualReferences`.
 *
 *  For an object-shaped start-frame field, EVERY schema sub-property is filled
 *  from the uploaded reference (exact field name first, then the conventional
 *  aliases). Schemas like Grok's `startFrame {type,label,url,id}` require
 *  `type` and `label`; mapping only url/id dropped them and the server rejected
 *  the frame with `startFrame.type: expected "image"`. */
export function videoRefsAssign(refs: Record<string, unknown>[], props: Record<string, unknown>): Record<string, unknown> | null {
  if (!refs.length) return null;
  const keys = Object.keys(props);
  // Pass 1: single start-frame object fields (the common image2video shape).
  for (const key of keys) {
    if (!/^(startFrame|firstFrame|startImage|sourceImage|inputImage|referenceImage|imageRef|image)$/i.test(key)) continue;
    const p = props[key] as { type?: string; items?: unknown; properties?: Record<string, unknown> } | undefined;
    if (!p) continue;
    if (p.type === "array" || p.items) { /* array-shaped — handle in pass 2 */ continue; }
    if (p.properties && typeof p.properties === "object") {
      const ref = refs[0] as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const pk of Object.keys(p.properties)) {
        const name = pk.toLowerCase().replace(/[_-]/g, "");
        if (name === "type" || name === "kind") out[pk] = ref.type ?? "image";
        else if (name === "label" || name === "name" || name === "title") out[pk] = String(ref.label ?? ref.name ?? "");
        else if (/imageurl|image|url|src|uri|path/.test(name)) out[pk] = String(ref.url ?? ref.accessURL ?? "");
        else if (/referenceid|refid|^id$/.test(name)) out[pk] = String(ref.id ?? "");
        else if (ref[pk] !== undefined) out[pk] = ref[pk];
      }
      return { [key]: Object.keys(out).length ? out : ref };
    }
    return { [key]: refs[0] };
  }
  // Pass 2: array-style reference fields.
  for (const key of keys) {
    if (!/visualReference|references/i.test(key)) continue;
    const p = props[key] as { type?: string; items?: unknown } | undefined;
    if (!p) continue;
    if (p.type === "array" || p.items) return { [key]: refs };
  }
  return null;
}

export class OpenArtClient {
  private readonly videoOptionsCache = new Map<string, { o: VideoModelOptions | null; at: number }>();
  private readonly VIDEO_OPTIONS_NULL_TTL_MS = 2 * 60_000;

  /** A recorder (the expenses ledger) that observes every successful
   *  generation with its resolved metadata. Injected so the tally is testable
   *  at the same seam as the McpManager fake. */
  constructor(
    private readonly mcp: McpManager,
    private readonly recorder?: { onGeneration: (meta: LedgerGenMeta) => void }
  ) {}

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

  /** The first connected OpenArt tool whose raw name matches `pattern`, or null. */
  private findTool(pattern: RegExp): string | null {
    for (const key of Object.keys(this.mcp.getTools())) {
      const raw = rawToolName(key);
      if (pattern.test(raw)) return raw;
    }
    return null;
  }

  // ---- model discovery ------------------------------------------------------

  /** Parse the OpenArt model-list reply into dropdown choices (Auto prepended). */
  private parseOpenArtModels(raw: string): Array<Record<string, unknown>> {
    const arr = parseJsonLooseArray(raw);
    if (arr) {
      return arr.filter((m) => m && typeof m === "object") as Array<Record<string, unknown>>;
    }
    const obj = parseJsonLooseObject(raw);
    if (obj) {
      // OpenAI-style / list envelopes: { data: [...] }, { items: [...] },
      // { models: [...] }, { list: [...] }, { results: [...] }.
      for (const key of ["data", "items", "models", "list", "results"]) {
        const v = obj[key];
        if (Array.isArray(v)) return v.filter((m) => m && typeof m === "object") as Array<Record<string, unknown>>;
      }
      // Some servers return a plain map { modelId: {…}, … }. Only trust it when
      // EVERY value is an object (so an { error: "…" } envelope isn't misread).
      const vals = Object.values(obj);
      if (vals.length && vals.every((v) => v && typeof v === "object")) {
        return vals as Array<Record<string, unknown>>;
      }
    }
    return [];
  }

  /** Shape the OpenArt model list into dropdown choices, prepending "Auto". */
  private shapeModelChoices(raw: string): OpenArtModelChoice[] {
    const out: OpenArtModelChoice[] = [
      { id: "auto", displayName: "Auto", description: "Cascade picks the best model for each run.", imageInput: false, videoInput: false, cost: null },
    ];
    for (const m of this.parseOpenArtModels(raw)) {
      const id = String(m.model ?? m.id ?? m.model_id ?? m.name ?? "").trim();
      if (!id) continue;
      const displayName = String(m.displayName ?? m.display_name ?? m.name ?? id);
      const description = String(m.description ?? m.summary ?? m.recommendedFor ?? "");
      const media = Array.isArray(m.media) ? String((m.media as unknown[]).join(" ")) : String(m.media ?? "");
      const modes = Array.isArray(m.modes) ? String((m.modes as unknown[]).join(" ")) : "";
      const blob = `${media} ${modes} ${description}`.toLowerCase();
      // Credit cost: OpenArt sometimes reports it on the model entry — take the
      // first plausible number; otherwise null (unknown).
      const costRaw = m.cost ?? m.price ?? m.credit_cost ?? m.base_cost;
      let cost: number | null = null;
      if (typeof costRaw === "number" && Number.isFinite(costRaw)) cost = costRaw;
      else if (costRaw && typeof costRaw === "object") {
        const v = (costRaw as Record<string, unknown>).base_cost ?? (costRaw as Record<string, unknown>).amount;
        if (typeof v === "number" && Number.isFinite(v)) cost = v;
      }
      out.push({ id, displayName, description, imageInput: /image/i.test(blob), videoInput: /video/i.test(blob), cost });
    }
    return out;
  }

  /** The OpenArt model dropdown, resolved from the connected server. */
  async listModelChoices(): Promise<OpenArtModelChoice[]> {
    const raw = await this.mcp.callRaw(SERVER, "openart_model_list", {});
    return this.shapeModelChoices(raw);
  }

  /** The signed-in OpenArt account's remaining credit balance, or null. */
  async getCredits(): Promise<number | null> {
    const obj = parseJsonLooseObject(await this.mcp.callRaw(SERVER, "openart_account_get", {}));
    const credits = obj?.credits;
    return typeof credits === "number" && Number.isFinite(credits) ? Math.round(credits) : null;
  }

  /** Turn "auto" (or any OpenArt model id) into the id to actually call. */
  private resolveOpenArtModel(choice: string, refsPresent: boolean, models: OpenArtModelChoice[]): string {
    if (choice && choice !== "auto") return choice;
    const eligible = models.slice(1); // everything but the synthetic Auto
    if (!eligible.length) return "";
    // This is the IMAGE tool, so prefer a model that accepts image input when
    // one is available (even without refs, image-capable models are the right
    // default for storyboards). Falls back to the first listed otherwise.
    const withInput = eligible.filter((m) => m.imageInput);
    const pool = withInput.length ? withInput : eligible;
    return pool[0]?.id ?? eligible[0]?.id ?? "";
  }

  // ---- video-options cache --------------------------------------------------

  /** Does a form enum label look like a video resolution? Accepts "4K"/"2K"/
   *  "8K" (incl. "4K Ultra HD"), "480p"/"1080p"/"2160p", "1920x1080", bare
   *  numbers like "1080", and "HD"/"FHD"/"QHD"/"UHD"/"Full HD" — plus annotated
   *  labels like "4K Ultra HD (3840x2160)" that contain a resolution token. */
  private looksLikeResolution(s: string): boolean {
    const t = s.trim();
    if (/\d+(?:\.\d+)?\s*k|\d{3,4}\s*p|\d+\s*[x×]\s*\d+/i.test(t)) return true;
    if (/^\d{3,4}$/.test(t)) return true;
    return /^(?:full\s+hd|fhd|qhd|uhd|hd)$/i.test(t);
  }

  /** Extract the field map out of an OpenArt open_model_form_get reply. */
  private parseModelFormProperties(raw: string): Record<string, unknown> | null {
    const j = parseJsonLooseObject(raw);
    if (!j) return null;
    const schema = j.jsonSchema as Record<string, unknown> | undefined;
    const allOf = Array.isArray(schema?.allOf) ? (schema.allOf as Record<string, unknown>[]) : [];
    const first = allOf[0];
    const props = first?.properties ?? schema?.properties;
    return props && typeof props === "object" ? (props as Record<string, unknown>) : null;
  }

/** Pull the resolution/duration options out of a model form's props map. */
  private extractVideoOptions(props: Record<string, unknown>): VideoModelOptions {
    const out: VideoModelOptions = { resolutions: [], durations: [] };
    for (const key of Object.keys(props)) {
      const p = props[key] as { type?: string; enum?: unknown[]; minimum?: unknown; maximum?: unknown } | undefined;
      if (!p) continue;
      if (/resolution|quality|definition|size/i.test(key) && Array.isArray(p.enum)) {
        for (const v of p.enum) {
          const s = String(v).trim();
          if (this.looksLikeResolution(s)) out.resolutions.push(s);
        }
      }
      if (/duration|length|seconds|clip|frames|time/i.test(key)) {
        if (Array.isArray(p.enum)) {
          for (const v of p.enum) {
            const n = Number(String(v).replace(/[^0-9.]/g, ""));
            if (Number.isFinite(n) && n > 0 && n <= 120) out.durations.push(Math.round(n));
          }
        } else if (p.type === "integer" || p.type === "number") {
          const min = Number(p.minimum) > 0 ? Number(p.minimum) : 1;
          const max = Number(p.maximum) > 0 ? Number(p.maximum) : min + 15;
          for (let n = Math.ceil(min); n <= Math.floor(max) && n <= 120; n++) out.durations.push(n);
        }
      }
    }
    out.resolutions = Array.from(new Set(out.resolutions));
    out.durations = Array.from(new Set(out.durations)).sort((a, b) => a - b);
    return out;
  }

  /** Resolve a video model's accepted resolutions/lengths from its live form
   *  schema. Mode-aware: image-to-video and text-to-video forms declare
   *  different option sets, so the caller says which one it needs.
   *
   *  Mode selection mirrors generateVideoClip exactly — the FIRST mode whose
   *  form parses wins — so the dropdown always shows what the submitted mode
   *  accepts, never a different mode's resolutions (a text2video enum must not
   *  leak 1080p into an image2video node that the site limits to 480p/720p). */
  private async fetchVideoModelOptions(modelId: string, withImage: boolean): Promise<VideoModelOptions | null> {
    const formRaw = this.findTool(/^openart_model_form_get$/);
    if (!formRaw) return null;
    if (typeof modelId !== "string" || !modelId || modelId === "auto") return null;
    const modes = withImage
      ? ["image2video", "image_to_video", "img2video", "video2video"]
      : ["text2video", "text_to_video", "video2video"];
    for (const mode of modes) {
      let props: Record<string, unknown> | null = null;
      try {
        props = this.parseModelFormProperties(await this.mcp.callRaw(SERVER, formRaw, { model: modelId, mode }));
      } catch { continue; }
      if (!props) continue;
      return this.extractVideoOptions(props);
    }
    return null;
  }

  /** Cached options for a model+mode, honoring the null-result TTL. */
  private cachedVideoOptions(modelId: string, withImage: boolean): VideoModelOptions | null | undefined {
    const key = `${modelId}|${withImage ? 1 : 0}`;
    const hit = this.videoOptionsCache.get(key);
    if (!hit) return undefined;
    if (hit.o !== null || Date.now() - hit.at < this.VIDEO_OPTIONS_NULL_TTL_MS) return hit.o;
    return undefined;
  }

  /** Resolve (from cache when fresh) + store options for a model+mode. */
  private async resolveVideoOptions(modelId: string, withImage: boolean): Promise<VideoModelOptions | null> {
    const cached = this.cachedVideoOptions(modelId, withImage);
    if (cached !== undefined) return cached;
    const o = await this.fetchVideoModelOptions(modelId, withImage);
    this.videoOptionsCache.set(`${modelId}|${withImage ? 1 : 0}`, { o, at: Date.now() });
    return o;
  }

  /** The resolution / length options a video model accepts (from its live form
   *  schema). Null when the model form can't be read. Cached per model+mode. */
  videoModelOptions(modelId: string, withImage: boolean): Promise<VideoModelOptions | null> {
    return this.resolveVideoOptions(modelId, withImage);
  }

  /** Warm the per-model option cache for every video-capable model in both
   *  modes. Fire-and-forget: the caller returns immediately so listing models
   *  never waits on form lookups. */
  prewarm(models: OpenArtModelChoice[]): void {
    const seen = new Set<string>();
    for (const m of models) {
      if (!m.videoInput) continue;
      for (const withImage of [true, false]) {
        const key = `${m.id}|${withImage ? 1 : 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        void this.resolveVideoOptions(m.id, withImage).catch(() => {});
      }
    }
  }

// ---- option assignment ----------------------------------------------------

  /** Map a requested aspect ratio onto whatever sizing param the model's
   *  schema declares. Only sets a value when the schema accepts it: either an
   *  enum carrying a matching "16:9"/"4:3"/"1:1" string, or a boolean
   *  cinematic/landscape toggle (16:9 → on, 1:1 → off; 4:3 has no boolean
   *  representation so it falls back to the model default). Returns null when
   *  the model has no supported option — its default then applies rather than
   *  us guessing a malformed value. Defaults to 16:9 so storyboards stay
   *  widescreen unless a caller (reference generation) picks another ratio. */
  private aspectRatioAssign(props: Record<string, unknown>, aspectRatio: ImageGenAspectRatio = "16:9"): Record<string, unknown> | null {
    const ratioRx = aspectRatio === "16:9" ? /^16[:xX]9$/ : aspectRatio === "4:3" ? /^4[:xX]3$/ : /^1[:xX]1$/;
    for (const key of Object.keys(props)) {
      if (!/aspect|orient|format/i.test(key)) continue;
      const p = props[key] as { type?: string; enum?: unknown[] } | undefined;
      if (!p) continue;
      if (Array.isArray(p.enum)) {
        const want = p.enum.find((v) => ratioRx.test(String(v)));
        if (want !== undefined) return { [key]: want };
        continue; // has an aspect option but no matching literal — don't guess
      }
      if (p.type === "boolean" && /cinema|widescreen|wide|landscape/i.test(key)) {
        if (aspectRatio === "16:9") return { [key]: true };
        if (aspectRatio === "1:1") return { [key]: false };
        continue;
      }
    }
    return null;
  }

  /** Map the 1k/2k/4k bucket onto whatever sizing param the model's schema declares. */
  private resolutionAssign(resolution: string, props: Record<string, unknown>): Record<string, unknown> | null {
    const tier = resolution === "4k" ? 4 : resolution === "2k" ? 2 : 1;
    const label = `${tier}k`; // "1k" | "2k" | "4k" (matched case-insensitively)
    for (const key of Object.keys(props)) {
      const p = props[key] as { type?: string; enum?: unknown[] } | undefined;
      if (!p) continue;
      // Quadruple/HD/quality boolean toggles: enabled at 2k+, off at 1k.
      if (p.type === "boolean" && /upscale|hd|high|super|quality/i.test(key)) {
        return { [key]: tier > 1 };
      }
      // Explicit pixel width/height (numeric models like GPT Image 2).
      if (/^(size|width|height|image_width|image_height)/i.test(key) && (p.type === "integer" || p.type === "number")) {
        return { [key]: tier === 4 ? 4096 : tier === 2 ? 2048 : 1024 };
      }
      // Enum with "1K/2K/4K"-style tiers — pick the exact tier label.
      if (Array.isArray(p.enum)) {
        const exact = p.enum.find((v) => String(v).replace(/\s/g, "").toLowerCase() === label);
        if (exact !== undefined) return { [key]: exact };
        if (tier === 1) {
          const low = p.enum.find((v) => /^(standard|base|normal|low|1)$/i.test(String(v).trim()));
          if (low !== undefined) return { [key]: low };
        }
        continue;
      }
    }
    return null; // unknown shape — omit, model default applies
  }

  /** Force exactly one frame per shot when the model exposes an image-count field. */
  private imageCountAssign(props: Record<string, unknown>): Record<string, unknown> | null {
    for (const key of Object.keys(props)) {
      const p = props[key] as { type?: string } | undefined;
      if (!p) continue;
      if ((p.type === "integer" || p.type === "number") && /imageCount|image_count|^count$/i.test(key)) {
        return { [key]: 1 };
      }
    }
    return null;
  }

  /** Map the chosen duration onto whatever length param the video model's
   *  schema declares (integer seconds, or an enum of second-ish labels). */
  private videoDurationAssign(durationSec: number, props: Record<string, unknown>): Record<string, unknown> | null {
    for (const key of Object.keys(props)) {
      const p = props[key] as { type?: string; enum?: unknown[] } | undefined;
      if (!p || !/duration|length|seconds|clip|frames|time/i.test(key)) continue;
      if (p.type === "integer" || p.type === "number") return { [key]: Math.round(durationSec) };
      if (Array.isArray(p.enum)) {
        const want = String(durationSec);
        const exact = p.enum.find((v) => String(v).replace(/\s+/g, "").toLowerCase() === want);
        if (exact !== undefined) return { [key]: exact };
        let best: unknown;
        let bestDiff = Infinity;
        for (const v of p.enum) {
          const n = Number(String(v).replace(/[^0-9.]/g, ""));
          if (Number.isFinite(n)) {
            const diff = Math.abs(n - durationSec);
            if (diff < bestDiff) { bestDiff = diff; best = v; }
          }
        }
        if (best !== undefined) return { [key]: best };
        continue;
      }
    }
    return null;
  }

  /** Map a resolution label ("480p"/"720p"/"1080p") onto the video model's
   *  sizing param; falls back to the model default when nothing matches. */
  private videoResolutionAssign(resolution: string, props: Record<string, unknown>): Record<string, unknown> | null {
    const label = String(resolution).replace(/\s+/g, "").toLowerCase();
    for (const key of Object.keys(props)) {
      const p = props[key] as { type?: string; enum?: unknown[] } | undefined;
      if (!p || !/resolution|quality|definition|size/i.test(key)) continue;
      if (Array.isArray(p.enum)) {
        const exact = p.enum.find((v) => String(v).replace(/\s+/g, "").toLowerCase() === label);
        if (exact !== undefined) return { [key]: exact };
        continue;
      }
      if (p.type === "boolean" && /hd|high|quality|upscale|super/i.test(key)) {
        return { [key]: label !== "480p" && label !== "720p" };
      }
    }
    return null;
  }

/** Fit the uploaded visual references into the video model's reference field.
   *  The workflow is always "text prompt + start frame" (image2video): the
   *  frame is a single image, so single-image object fields (startFrame,
   *  inputImage, …) are preferred over array-style fields (visualReferences).
   *  Returns null when no reference field is found — the caller then falls back
   *  to `params.visualReferences`. */
private videoRefsAssign = videoRefsAssign;

  /** Build the OpenArt generate-tool arguments for one board.
   *
   *  The generate tool takes a nested `{ model, mode, params, projectId }`
   *  shape; `params` must match the resolved model's form schema. The canonical
   *  field map comes from the live model form (fetched per run) — the static
   *  tool schema doesn't carry per-model field names, so we never rely on it for
   *  more than confirming the nested `params` wrapper. We fill the known keys:
   *   - prompt          (the shot prompt)
   *   - aspectRatio     → the requested ratio (16:9 by default — storyboards
   *                       are widescreen; reference generation picks 1:1/4:3/16:9)
   *   - resolution / resolutionTier per the 1k/2k/4k dropdown
   *   - imageCount      → 1 (exactly one frame per shot)
   *   - visualReferences → uploaded reference art (image2image mode only)
   */
  private imageGenArgs(
    prompt: string,
    refs: Record<string, unknown>[],
    cfg: OpenArtBoardConfig,
    models: OpenArtModelChoice[],
    projectId: string | null,
    mode: string,
    formProps: Record<string, unknown> | null,
    aspectRatio: ImageGenAspectRatio = "16:9"
  ): Record<string, unknown> {
    const props = formProps ?? {};
    const params: Record<string, unknown> = { prompt };

    // Storyboards stay widescreen by default; reference generation passes the
    // ratio the user picked in the modal.
    const asp = this.aspectRatioAssign(props, aspectRatio);
    if (asp) Object.assign(params, asp);
    // Resolution bucket → the model's resolution/resolutionTier label.
    const res = this.resolutionAssign(cfg.resolution, props);
    if (res) Object.assign(params, res);
    // Exactly one frame per shot.
    const count = this.imageCountAssign(props);
    if (count) Object.assign(params, count);
    // Reference art — accepted only under image2image (text2image has no
    // reference field), so `mode` is "image2image" whenever refs exist.
    if (refs.length) {
      const vk = Object.keys(props).find((k) => /visualReference|references/i.test(k));
      if (vk) params[vk] = refs;
    }

    const args: Record<string, unknown> = { mode, params };
    // model is REQUIRED by the OpenArt tool (minLength 1); guard against the
    // empty string from a failed model-list so the error stays readable.
    const model = this.resolveOpenArtModel(cfg.model, refs.length > 0, models);
    if (model) args.model = model;
    // Route into the production's own OpenArt project when one is resolved, so
    // every frame for a production lands in a project named after its folder.
    if (projectId) args.projectId = projectId;
    return args;
  }

  /** Build the OpenArt generate-tool args for one video clip. Mirrors the
   *  image path: nested `{ mode, params, model?, projectId? }`, with params
   *  matched against the resolved model's live form schema. */
  private videoGenArgs(
    prompt: string,
    refs: Record<string, unknown>[],
    opts: VideoGenOptions,
    modelId: string,
    projectId: string | null,
    mode: string,
    formProps: Record<string, unknown> | null
  ): Record<string, unknown> {
    const props = formProps ?? {};
    const params: Record<string, unknown> = { prompt };
    const res = this.videoResolutionAssign(opts.resolution, props);
    if (res) Object.assign(params, res);
    const dur = this.videoDurationAssign(opts.durationSec, props);
    if (dur) Object.assign(params, dur);
    if (refs.length) {
      const refAssign = this.videoRefsAssign(refs, props);
      if (refAssign) Object.assign(params, refAssign);
      else params.visualReferences = refs; // last-resort fallback
    }
    const args: Record<string, unknown> = { mode, params };
    if (modelId) args.model = modelId;
    if (projectId) args.projectId = projectId;
    return args;
  }

// ---- reply parsing --------------------------------------------------------

  /**
   * The OpenArt generate tool is asynchronous: the submission reply is a
   * `{"status":"PENDING","historyId":"…","pollAfterSeconds":N}` object and the
   * finished image arrives later on a creation_* tool. Pull the historyId out
   * of that submission reply (tolerating trailing prose).
   */
  private openArtHistoryId(text: string): string | null {
    const obj = parseJsonLooseObject(text);
    if (obj && typeof obj.historyId === "string" && obj.historyId) return obj.historyId;
    return text.match(/"historyId"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  }

  /** One attempt to fetch an image from a URL/as-image Buffer; null if not an image. */
  private async fetchImageBuffer(url: string): Promise<Buffer | null> {
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
   * One poll pass over an async OpenArt image job. Returns the finished bytes
   * (`buf`), or `{ failed }` when the server reports FAILED/CANCELLED. When
   * both are empty the job is still rendering — or the deadline passed.
   * Transient per-call errors surface as a normal rejection (the caller's
   * wait/recheck decides whether that is fatal).
   */
  private async pollOpenArtImage(
    historyId: string,
    deadlineMs: number
  ): Promise<{ buf: Buffer | null; failed?: string }> {
    const waitRaw = this.findTool(/^openart_creation_wait$/);
    const getRaw = this.findTool(/^openart_creation_get$/);
    if (!waitRaw && !getRaw) return { buf: null };

    const deadline = Date.now() + deadlineMs;
    const finalize = async (res: { text: string; images: Buffer[]; uris: string[] }): Promise<Buffer | null> => {
      if (res.images.length) return res.images[0];
      const imgUrl =
        res.text.match(IMAGE_URL_RX)?.[0] ??
        res.uris.find((u) => IMAGE_URI_EXT_RX.test(u));
      return imgUrl ? this.fetchImageBuffer(imgUrl) : null;
    };

    const pollWith = waitRaw
      ? async () =>
          this.mcp.callRawContent(SERVER, waitRaw!, { historyId, timeoutSeconds: 60 })
      : async () => this.mcp.callRawContent(SERVER, getRaw!, { historyId });

    while (Date.now() < deadline) {
      const res = await pollWith();
      const got = await finalize(res);
      if (got) return { buf: got };
      const obj = parseJsonLooseObject(res.text);
      const status = typeof obj?.status === "string" ? obj.status : "";
      if (status === "FAILED" || status === "CANCELLED") {
        return { buf: null, failed: status };
      }
      await sleepMs(Math.max(1, Number(obj?.pollAfterSeconds ?? 4)) * 1000);
    }
    return { buf: null };
  }

  /**
   * Wait for an async OpenArt image generation to finish, then return the
   * pixels. Uses the server's blocking `openart_creation_wait` where present
   * (looping on STILL_RUNNING); falls back to polling `openart_creation_get`.
   * Returns null if no wait/get tool exists or completion surfaces no
   * fetchable image (caller then errors); throws OpenArtImagePendingError
   * when the wait cap passes with the job still running; throws a plain Error
   * on FAILED/CANCELLED.
   */
  private async waitOpenArtImage(historyId: string, deadlineMs = IMAGE_WAIT_DEADLINE_MS): Promise<Buffer | null> {
    if (!this.findTool(/^openart_creation_wait$/) && !this.findTool(/^openart_creation_get$/)) return null;
    const { buf, failed } = await this.pollOpenArtImage(historyId, deadlineMs);
    if (buf) return buf;
    if (failed) throw new Error(`OpenArt generation ${failed.toLowerCase()} (${historyId.slice(0, 8)}…).`);
    throw new OpenArtImagePendingError(historyId);
  }

  /** Record an OpenArt image job that outlived the generating call on the shot,
   *  so the finished frame can be reclaimed later instead of re-paid. A fresh
   *  submission or a successful recheck clears it. */
  private recordPendingImage(
    shot: ProductionShot | undefined,
    rec: { historyId?: string; url?: string; prompt: string; model: string }
  ): void {
    if (!shot) return;
    shot.pendingImageGen = { ...rec, at: new Date().toISOString() };
  }

  /**
   * Recheck a pending image job and return the finished bytes, or null when
   * it's still rendering (or the result URL still can't be fetched). With a
   * `historyId` this re-polls `openart_creation_get`/`wait` and downloads the
   * image like the original wait; with just a `url` it re-fetches that. Throws
   * when the server reports the job FAILED/CANCELLED (nothing left to reclaim).
   */
  async recheckPendingImage(rec: PendingImageGen): Promise<Buffer | null> {
    if (rec.historyId) {
      if (!this.findTool(/^openart_creation_wait$/) && !this.findTool(/^openart_creation_get$/)) return null;
      const { buf, failed } = await this.pollOpenArtImage(rec.historyId, IMAGE_RECHECK_DEADLINE_MS);
      if (buf) return buf;
      if (failed) throw new Error(`OpenArt generation ${failed.toLowerCase()} (${rec.historyId.slice(0, 8)}…).`);
      return null;
    }
    if (rec.url) return this.fetchImageBuffer(rec.url);
    return null;
  }

  /**
   * Wait for an async OpenArt video generation, returning the bytes + the
   * file extension to store under. Polls with the non-blocking
   * openart_creation_get (the blocking openart_creation_wait can exceed the
   * MCP client's per-call timeout on long jobs, so it's only a fallback).
   * A transient per-call timeout is ignored and polling continues — the
   * server-side job isn't cancelled by the client giving up on a response.
   */
  private async waitOpenArtVideo(
    historyId: string,
    onStatus?: (status: string) => void
  ): Promise<{ buf: Buffer; ext: string } | null> {
    const waitRaw = this.findTool(/^openart_creation_wait$/);
    const getRaw = this.findTool(/^openart_creation_get$/);
    if (!getRaw && !waitRaw) return null;

    const deadline = Date.now() + VIDEO_WAIT_DEADLINE_MS;
    const finalize = async (res: { text: string; images: Buffer[]; uris: string[] }): Promise<{ buf: Buffer; ext: string } | null> => {
      if (res.images.length) return { buf: res.images[0], ext: "mp4" };
      const videoUrl =
        res.text.match(VIDEO_URL_RX)?.[0] ??
        res.uris.find((u) => VIDEO_URI_EXT_RX.test(u));
      if (videoUrl) {
        const buf = await this.fetchImageBuffer(videoUrl);
        if (buf) {
          const ext = (path.extname(new URL(videoUrl).pathname) || ".mp4").replace(/^\./, "").toLowerCase() || "mp4";
          return { buf, ext };
        }
      }
      return null;
    };

    const pollOnce = async (): Promise<{ text: string; images: Buffer[]; uris: string[] } | null> => {
      try {
        if (getRaw) return await this.mcp.callRawContent(SERVER, getRaw, { historyId });
        if (waitRaw) return await this.mcp.callRawContent(SERVER, waitRaw, { historyId, timeoutSeconds: 30 });
      } catch {
        // Transient timeout (e.g. the blocking wait exceeding the MCP client's
        // call timeout). The creation keeps running server-side, so we just
        // sleep and poll again instead of treating this as a failure.
        return null;
      }
      return null;
    };

    let lastStatus = "";
    while (Date.now() < deadline) {
      const res = await pollOnce();
      if (res) {
        const got = await finalize(res);
        if (got) return got;
        const obj = parseJsonLooseObject(res.text);
        const status = typeof obj?.status === "string" ? obj.status : "";
        if (status === "FAILED" || status === "CANCELLED") {
          throw new Error(`OpenArt video generation ${status.toLowerCase()} (${historyId.slice(0, 8)}…).`);
        }
        if (status && status !== lastStatus) {
          lastStatus = status;
          onStatus?.(status);
        }
      }
      await sleepMs(5000);
    }
    throw new Error(`OpenArt video generation timed out after ${VIDEO_WAIT_DEADLINE_MS / 60_000} minutes (${historyId.slice(0, 8)}…).`);
  }

  // ---- projects -------------------------------------------------------------

/** Parse the OpenArt project-list/create reply into project objects. */
  private parseOpenArtProjects(text: string): RawProject[] {
    const scan = (arr: unknown[]): RawProject[] => arr.filter((x) => x && typeof x === "object") as RawProject[];
    const arr = parseJsonLooseArray(text);
    if (arr) return scan(arr);
    const o = parseJsonLooseObject(text);
    if (o) {
      if (o.id !== undefined) return [o as unknown as RawProject]; // single created/found project
      for (const key of ["items", "projects", "data", "list", "results"]) {
        const v = o[key];
        if (Array.isArray(v)) return scan(v);
        // Nested envelopes: { data: { projects: [...] } } or { data: { id, … } }.
        if (v && typeof v === "object") {
          const rec = v as RawProject;
          if (rec.id !== undefined) return [rec];
          for (const k2 of ["items", "projects", "data", "list", "results"]) {
            const v2 = (v as Record<string, unknown>)[k2];
            if (Array.isArray(v2)) return scan(v2);
          }
        }
      }
    }
    return [];
  }

  /**
   * Resolve the OpenArt project a production's frames should land in: the
   * project named after the production's folder. Reuses an existing project
   * with that name (only ones Cascade can generate into), or creates it.
   * Returns the project id, or null when OpenArt's project tools aren't
   * available / an error occurs — generation then falls back to the account
   * default project rather than blocking. `onNotice` (when given) reports the
   * exact reason for a fallback so a silent wrong-project generation can't
   * happen again.
   */
  async resolveProject(p: Production, onNotice?: (msg: string) => void): Promise<string | null> {
    const listRaw = this.findTool(/^openart_project_list$/);
    const createRaw = this.findTool(/^openart_project_create$/);
    const folderName = (path.basename(p.meta.folder) || p.meta.name).trim();
    if (!folderName) return null;
    if (!listRaw) {
      onNotice?.(`No OpenArt project tool is connected — frames will land in the account's default project instead of "${folderName}".`);
      return null;
    }
    const target = folderName.toLowerCase();
    try {
      const listText = await this.mcp.callRaw(SERVER, listRaw, {});
      const existing = this.parseOpenArtProjects(listText);
      const byName = existing.filter(
        (pr) => typeof pr.id === "string" && typeof pr.name === "string" &&
          pr.name.trim().toLowerCase() === target
      );
      // Prefer a project Cascade can generate into; a same-named project that
      // merely lacks the canGenerate flag is still better than a duplicate —
      // a failed generate surfaces a readable error instead.
      const match = byName.find((pr) => pr.canGenerate) ?? byName[0];
      if (match && typeof match.id === "string") return match.id;
      if (!createRaw) {
        onNotice?.(`No OpenArt project named "${folderName}" exists yet and the create tool isn't connected — generating into the account's default project.`);
        return null;
      }
      const createdText = await this.mcp.callRaw(SERVER, createRaw, { name: folderName });
      const created = this.parseOpenArtProjects(createdText)[0];
      const id = created && typeof created.id === "string" ? created.id : null;
      if (!id) {
        onNotice?.(`Couldn't read the id of the OpenArt project created for "${folderName}" — generating into the account's default project instead.`);
      }
      return id;
    } catch (e) {
      onNotice?.(`Couldn't resolve the OpenArt project "${folderName}" (${e instanceof Error ? e.message : String(e)}) — generating into the account's default project.`);
      return null;
    }
  }

  // ---- generation -----------------------------------------------------------

  /**
   * Resolve @[name] tags in a prompt against the production's artwork
   * references. Returns the prompt with tags replaced by portable tokens
   * (@imageN) plus the referenced images, ready to upload alongside the
   * shot's frame. `startToken` is the token index to begin at — the shot's
   * own frame always occupies @image1.
   */
  resolvePromptRefs(p: Production, prompt: string, startToken: number): { resolved: string; extras: { name: string; dataUrl: string }[] } {
    const candidates = [
      ...p.characters.map((c) => ({ name: c.name, artwork: refArtworkDataUrl(p, c) })),
      ...p.products.map((pr) => ({ name: pr.name, artwork: refArtworkDataUrl(p, pr) })),
      ...(p.references ?? []).map((r) => ({ name: r.name, artwork: refArtworkDataUrl(p, r) })),
    ].filter((r): r is { name: string; artwork: string } => Boolean(r.name && r.artwork));
    const extras: { name: string; dataUrl: string }[] = [];
    const nameToken = new Map<string, string>();
    let resolved = prompt;
    let token = startToken;
for (const { tag, name } of refTagMatches(prompt)) {
      const c = candidates.find((r) => r.name.toLowerCase() === name.toLowerCase());
      if (!c) continue;
      if (!extras.some((e) => e.name === c.name)) extras.push({ name: c.name, dataUrl: c.artwork });
      if (!nameToken.has(c.name)) nameToken.set(c.name, refToken(token++));
      resolved = resolved.replace(tag, nameToken.get(c.name)!);
    }
    return { resolved, extras };
  }

  /**
   * Resolve the Step 3 image generator. First (and only in-app) choice is the
   * OpenArt MCP server; returns null when it isn't connected or exposes no
   * image-generation tool, in which case the caller falls back to exporting
   * prompts for manual generation + import. `modelOverride` forces a specific
   * OpenArt model id (per-frame edit runs); "auto"/undefined uses the config.
   * `onNotice` reports a project-resolution fallback (frames landing in the
   * account default project instead of the folder-named one) to the caller's
   * log so it's never silent. `aspectRatio` selects the generated image's
   * shape (16:9 by default; reference generation passes the modal's choice).
   */
  imageGenFn(p: Production, modelOverride?: string, resolutionOverride?: string, onNotice?: (msg: string) => void, aspectRatio: ImageGenAspectRatio = "16:9"): ImageGenFn | null {
    const toolName = this.findTool(/^openart_.*generate.*image$/i);
    if (!toolName) return null;

// Resolved lazily on the first shot (cache the folder-named project id for
    // the rest of the run); null when the lookup/create fails.
    let projectId: string | null | undefined;

    return async (prompt: string, refs: GenerationRef[], shot?: ProductionShot): Promise<Buffer> => {
      // A fresh submission supersedes any earlier pending job — the new
      // historyId is the one a future recheck must poll.
      if (shot?.pendingImageGen) delete shot.pendingImageGen;

      // Resolve the dropdown choice (incl. "auto") fresh per run, so edits to
      // the model dropdown are honored without an app restart.
      let models: OpenArtModelChoice[] = [];
      try {
        models = await this.listModelChoices();
      } catch { models = []; }
      const cfgUsed: OpenArtBoardConfig = {
        ...(p.openArt ?? { model: "auto", resolution: "1k" }),
        ...(modelOverride ? { model: modelOverride } : {}),
        ...(resolutionOverride ? { resolution: resolutionOverride } as Partial<OpenArtBoardConfig> : {}),
      };

      // Upload reference art (deduped) so image-capable models can use it.
      // References are only meaningful under image2image (text2image exposes no
      // reference field), so their presence picks the mode below.
      // Each uploaded reference carries a unique string id (OpenArt's
      // visualReference id, falling back to its URL). The prompt already cites
      // refs by portable token (@image1, …); every token occurrence is
      // swapped for that reference's actual OpenArt id before MCP submission.
      const uploaded: Record<string, unknown>[] = [];
      const tokenToId: { token: string; id: string }[] = [];
      for (const [i, r] of refs.entries()) {
        try {
          const vr = await uploadDataUrlReference(this.mcp, r.dataUrl, r.name);
          uploaded.push(vr);
          const id = String((vr as { id?: unknown }).id ?? (vr as { url?: unknown }).url ?? "").trim();
          if (id) tokenToId.push({ token: refToken(i), id });
        } catch { /* non-fatal: ref falls back to text-only */ }
      }
      let fullPrompt = prompt;
      for (const { token, id } of tokenToId) {
        fullPrompt = fullPrompt.split(token).join(id);
      }
      const hasRefs = refs.length > 0;
      const mode = hasRefs ? "image2image" : "text2image";

      // Fetch the resolved model's actual form so we know the real field names
      // (aspectRatio, resolution/resolutionTier, imageCount, visualReferences).
      // This is what makes 16:9 and references actually reach the generate call.
      const modelId = this.resolveOpenArtModel(cfgUsed.model, hasRefs, models);
      let formProps: Record<string, unknown> | null = null;
      if (modelId) {
        try {
          const formRaw = this.findTool(/^openart_model_form_get$/);
          if (formRaw) {
            formProps = this.parseModelFormProperties(
              await this.mcp.callRaw(SERVER, formRaw, { model: modelId, mode })
            );
          }
        } catch { formProps = null; }
      }

      if (projectId === undefined) {
        projectId = await this.resolveProject(p, onNotice).catch(() => null);
      }
      const args = this.imageGenArgs(fullPrompt, uploaded, cfgUsed, models, projectId, mode, formProps, aspectRatio);
      const { text, images } = await this.mcp.callRawFull(SERVER, toolName, args);

      // Ledger metadata is in scope on every success path below — model and
      // resolution are resolved here, not at the IPC handler call sites.
      const genMeta: LedgerGenMeta = {
        kind: "image",
        model: modelId ?? "",
        resolution: cfgUsed.resolution,
        aspectRatio,
        at: Date.now(),
        productionId: p.meta.id,
        shotId: shot?.id,
      };

      let buffer: Buffer | null = null;
      if (images.length) buffer = images[0];

// OpenArt's generate tool is async — a PENDING submission carries the
      // historyId but no pixels. Wait for the finished image before giving up.
      const historyId = this.openArtHistoryId(text);
      if (!buffer && historyId) {
        try {
          const done = await this.waitOpenArtImage(historyId);
          if (done) buffer = done;
          // no image surfaced despite completion — fall through to URL scan
        } catch (e) {
          if (e instanceof OpenArtImagePendingError) {
            // The wait cap passed but the job keeps rendering server-side —
            // don't lose it. Record the historyId as pending so the finished
            // frame can be rechecked and downloaded without paying twice.
            this.recordPendingImage(shot, { historyId, prompt, model: modelId ?? "auto" });
          }
          throw e;
        }
      }

      // Many MCP image tools return text containing a URL to the result.
      if (!buffer) {
        const url =
text.match(IMAGE_URL_RX)?.[0] ??
          text.match(/https:\/\/[^\s"')\]}>]+/)?.[0];
        if (!url) throw new Error(`OpenArt returned no image (${text.slice(0, 120) || "empty reply"})`);
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Couldn't download the generated image (HTTP ${res.status})`);
          buffer = Buffer.from(await res.arrayBuffer());
        } catch (e) {
          // The image is ready but couldn't be fetched — record the URL so a
          // recheck can retry the download without regenerating.
          this.recordPendingImage(shot, { url, prompt, model: modelId ?? "auto" });
          throw e;
        }
      }

      this.fireGeneration(genMeta);
      return buffer;
    };
  }

  /**
   * Generate one video clip for a shot. The shot's current frame (full
   * resolution) is always the first visual reference; any @[name] tags in the
   * prompt add more. Writes the finished clip into the production's videosDir
   * and returns its workspace-relative path (the caller owns what happens with
   * the clip — the classic flow makes it the shot's videoPath; the node graph
   * stores it on its generation node).
   */
  async generateVideoClip(
    p: Production,
    shot: ProductionShot,
    opts: VideoGenOptions,
    emit: OpenArtEmit,
    sourcePathOverride?: string,
    extraRefs?: { name: string; dataUrl: string }[]
  ): Promise<{ rel: string }> {
    const toolName = this.findTool(/^openart_.*generate.*video$/i);
    if (!toolName) throw new Error("OpenArt MCP isn't connected (no video-generation tool found), so videos can't be generated in-app.");

    let models: OpenArtModelChoice[] = [];
    try {
      models = await this.listModelChoices();
    } catch { models = []; }

    // References: the source frame first (occupies @image1) — the shot's own
    // artwork unless a node-graph pipe supplies another frame — then any extra
    // references wired into the video node's reference sockets, then the
    // @[name] tags in the prompt, each uploaded as a visualReference.
    const sourceRel = sourcePathOverride?.trim() || shot.artwork;
    if (!sourceRel) throw new Error("No source frame — pipe a frame into the video node or generate one first.");
    const refs: { name: string; dataUrl: string }[] = [];
    {
      const buf = fs.readFileSync(assetPath(p, sourceRel));
      const ext = (path.extname(sourceRel).slice(1).toLowerCase() || "jpg").replace("jpeg", "jpg");
      const mime = ext === "jpg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
      refs.push({ name: `Shot ${shot.number} frame`, dataUrl: `data:${mime};base64,${buf.toString("base64")}` });
    }
    refs.push(...(extraRefs ?? []));
    const { resolved, extras } = this.resolvePromptRefs(p, opts.prompt, refs.length);
    refs.push(...extras);

    const uploaded: Record<string, unknown>[] = [];
    const tokenToId: { token: string; id: string }[] = [];
    for (const [i, r] of refs.entries()) {
      try {
        // The frame + prompt references are uploaded for a *video* job, so the
        // sign request uses purpose "create-video" — using the image purpose
        // can make OpenArt reject the upload and silently drop the reference.
        const vr = await uploadDataUrlReference(this.mcp, r.dataUrl, r.name, "create-video");
        uploaded.push(vr);
        const id = String((vr as { id?: unknown }).id ?? (vr as { url?: unknown }).url ?? "").trim();
        if (id) tokenToId.push({ token: refToken(i), id });
      } catch {
        emit(`Reference "${r.name}" couldn't be uploaded — continuing without it.`, "error");
      }
    }
    let fullPrompt = resolved;
    for (const { token, id } of tokenToId) fullPrompt = fullPrompt.split(token).join(id);

    // Resolve the model id ("auto" → first video-capable model), then discover
    // the mode the model's form accepts: image-to-video when references are
    // present, text-to-video otherwise. Try the common OpenArt mode spellings
    // so a slow/failed form lookup for one spelling doesn't drop the refs.
    const modelId = opts.model && opts.model !== "auto"
      ? opts.model
      : (models.find((m) => m.videoInput)?.id ?? "");
    const modeCandidates = refs.length
      ? ["image2video", "image_to_video", "img2video", "video2video", "video"]
      : ["text2video", "text_to_video", "video"];
    let mode = modeCandidates[0];
    let formProps: Record<string, unknown> | null = null;
    if (modelId) {
      const formRaw = this.findTool(/^openart_model_form_get$/);
      if (formRaw) {
        for (const m of modeCandidates) {
          try {
            formProps = this.parseModelFormProperties(await this.mcp.callRaw(SERVER, formRaw, { model: modelId, mode: m }));
            if (formProps) { mode = m; break; }
          } catch { /* try the next mode spelling */ }
        }
      }
    }
    const projectId = await this.resolveProject(p, (m) => emit(m)).catch(() => null);

    const args = this.videoGenArgs(fullPrompt, uploaded, opts, modelId, projectId, mode, formProps);
    emit(`Shot ${shot.number}: submitting video job${modelId ? ` via ${modelId}` : ""}…`);
    const { text, images } = await this.mcp.callRawFull(SERVER, toolName, args);

    const done = await (async (): Promise<{ buf: Buffer; ext: string }> => {
      if (images.length) return { buf: images[0], ext: "mp4" };
      const historyId = this.openArtHistoryId(text);
      if (historyId) {
        const v = await this.waitOpenArtVideo(historyId, (status) =>
          emit(`Shot ${shot.number}: video ${status.toLowerCase()}… still rendering.`, "info")
        );
        if (v) return v;
      }
      const url = text.match(VIDEO_URL_RX)?.[0];
      if (!url) throw new Error(`OpenArt returned no video (${text.slice(0, 120) || "empty reply"})`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't download the generated video (HTTP ${res.status})`);
      const ext = (path.extname(new URL(url).pathname) || ".mp4").replace(/^\./, "").toLowerCase() || "mp4";
      return { buf: Buffer.from(await res.arrayBuffer()), ext };
    })();

    const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const safeExt = /^[a-z0-9]{2,4}$/i.test(done.ext) ? done.ext : "mp4";
    const rel = `${p.assets.videosDir}/shot-${shot.number}-${tag}.${safeExt}`;
    fs.mkdirSync(assetPath(p, p.assets.videosDir), { recursive: true });
    fs.writeFileSync(assetPath(p, rel), done.buf);

    this.fireGeneration({
      kind: "video",
      model: modelId ?? "",
      resolution: opts.resolution || "",
      durationSec: opts.durationSec,
      at: Date.now(),
      productionId: p.meta.id,
      shotId: shot.id,
    });

    return { rel };
  }
}
