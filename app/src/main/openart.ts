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
import { assetPath, type ImageGenFn, type GenerationRef } from "./pipeline.js";
import { citePrompt, resolvePromptRefs } from "./providers/refs.js";
import type { MediaProvider, ProviderEmit } from "./providers/types.js";
import { uploadDataUrlReference } from "./openart-upload.js";
import { resizeVideoRef as defaultResizeVideoRef, VIDEO_REF_MAX_HEIGHT } from "./video-ref.js";
import {
  describeOpenArtDurations,
  extractOpenArtVideoOptions,
  openArtDurationNumber as durationNumber,
  openArtLooksLikeResolution,
  parseOpenArtFormProperties,
  parseOpenArtModels,
  shapeOpenArtModelChoices,
} from "./providers/openart-core.js";
import {
  IMAGE_URI_EXT_RX,
  IMAGE_URL_RX,
  parseJsonLooseArray,
  parseJsonLooseObject,
  VIDEO_URI_EXT_RX,
  VIDEO_URL_RX,
} from "../shared/prompt-grammar.js";
import type {
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
} from "../shared/ipc.js";

const SERVER = "openart";

/** Strip the MCP namespace prefix (`openart__…`) from a tool key. */
const rawToolName = (n: string) => n.replace(/^openart__/, "");

/** The log-line callback generation flows emit through (mirrors productionEmit). */
export type OpenArtEmit = ProviderEmit;

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

/** Single-image start-frame field names in a video model's form schema. */
export const START_FRAME_KEY_RX = /^(startFrame|firstFrame|startImage|sourceImage|inputImage|referenceImage|imageRef|image)$/i;
/** Dedicated end-frame (in-betweening) field names in a video model's form
 *  schema. A model declaring one of these gets the end keyframe in its own
 *  slot; every other model still receives both frames via the array fallback. */
export const END_FRAME_KEY_RX = /^(endFrame|lastFrame|endImage|targetImage|outputImage)$/i;

/** A form key that looks like an array of reference media — the field every
 *  uploaded reference (images and dropped clips) is bound to. Covers the
 *  vendor's common spellings (`visualReferences`, `referenceImages`,
 *  `refImages`, `media`, `inputImages`, …); the start/end frame slots are
 *  excluded so a single-frame object field is never mistaken for the array. */
export const REFERENCE_ARRAY_KEY_RX = /reference|refs?|medias?|inputs?|image_?refs?|video_?refs?|images?|videos?|elements?/i;

/** The model form's array-shaped reference field key, or null when it declares
 *  none. Shared by the binder and the mode picker so a ref-carrying submission
 *  never lands on a form that would silently drop the references. */
export function referenceArrayKey(props: Record<string, unknown>): string | null {
  for (const key of Object.keys(props)) {
    if (!REFERENCE_ARRAY_KEY_RX.test(key)) continue;
    // `elementTypes`/`mediaTypes` list the accepted kinds, not the media.
    if (/type/i.test(key)) continue;
    if (START_FRAME_KEY_RX.test(key) || END_FRAME_KEY_RX.test(key)) continue;
    const p = props[key] as { type?: string; items?: unknown } | undefined;
    if (!p) continue;
    if (p.type === "array" || p.items) return key;
  }
  return null;
}

/** The form key `videoRefsAssign` would fill with the end keyframe (first
 *  non-array match), or null when the schema declares no dedicated end-frame
 *  slot. Shared by the submit path and the capability probe so the two can
 *  never disagree about what "accepts an end frame" means. */
export function endFrameSlotKey(props: Record<string, unknown>): string | null {
  for (const key of Object.keys(props)) {
    if (!END_FRAME_KEY_RX.test(key)) continue;
    const p = props[key] as { type?: string; items?: unknown } | undefined;
    if (!p) continue;
    if (p.type === "array" || p.items) continue;
    return key;
  }
  return null;
}

/** Fit the uploaded visual references into the video model's reference field.
 *
 *  Two shapes, chosen by `opts.frames`:
 *   - Normal image/text-to-video (default): the source frame fills the
 *     start-frame slot (image2video forms mark it required — a submission
 *     without it is rejected) and every reference — the frame, @[name]
 *     artwork, and any dropped video clips — also rides the array-style
 *     visualReferences field. The END-frame slot is never touched, so a second
 *     reference can't be mistaken for an end keyframe.
 *   - In-betweener (`frames: true`): the start/end keyframe pair binds to the
 *     model's dedicated startFrame/endFrame object slots (falling back to the
 *     array when a slot is absent), since a start→end interpolation is exactly
 *     what those slots are for.
 *
 *  Returns null when no reference field is found — the caller then falls back
 *  to `params.visualReferences`.
 *
 *  For an object-shaped frame field, EVERY schema sub-property is filled
 *  from the uploaded reference (exact field name first, then the conventional
 *  aliases). Schemas like Grok's `startFrame {type,label,url,id}` require
 *  `type` and `label`; mapping only url/id dropped them and the server rejected
 *  the frame with `startFrame.type: expected "image"`. */
export function videoRefsAssign(
  refs: Record<string, unknown>[],
  props: Record<string, unknown>,
  opts?: { frames?: boolean }
): Record<string, unknown> | null {
  if (!refs.length) return null;
  const keys = Object.keys(props);
  const fillObject = (ref: Record<string, unknown>, properties: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const pk of Object.keys(properties)) {
      const name = pk.toLowerCase().replace(/[_-]/g, "");
      if (name === "type" || name === "kind") out[pk] = ref.type ?? "image";
      else if (name === "label" || name === "name" || name === "title") out[pk] = String(ref.label ?? ref.name ?? "");
      else if (/imageurl|image|url|src|uri|path/.test(name)) out[pk] = String(ref.url ?? ref.accessURL ?? "");
      else if (/referenceid|refid|^id$/.test(name)) out[pk] = String(ref.id ?? "");
      else if (ref[pk] !== undefined) out[pk] = ref[pk];
    }
    return out;
  };
  const out: Record<string, unknown> = {};
  // Pass 1a: the single start-frame object field (the common image2video shape)
  // — the source frame, required by image2video forms in every mode.
  for (const key of keys) {
    if (!START_FRAME_KEY_RX.test(key)) continue;
    const p = props[key] as { type?: string; items?: unknown; properties?: Record<string, unknown> } | undefined;
    if (!p) continue;
    if (p.type === "array" || p.items) { /* array-shaped — handle in pass 2 */ continue; }
    if (p.properties && typeof p.properties === "object") {
      const filled = fillObject(refs[0] as Record<string, unknown>, p.properties);
      out[key] = Object.keys(filled).length ? filled : refs[0];
    } else {
      out[key] = refs[0];
    }
    break;
  }
  // Pass 1b: end-frame object field — in-betweening ONLY. Normal generation must
  // never set it, else a second reference becomes an accidental end keyframe.
  // Models without this slot still get both frames through the pass-2 fallback.
  let endFilled = false;
  if (opts?.frames === true && refs.length > 1) {
    const endKey = endFrameSlotKey(props);
    if (endKey) {
      const p = props[endKey] as { properties?: Record<string, unknown> } | undefined;
      if (p?.properties && typeof p.properties === "object") {
        const filled = fillObject(refs[1] as Record<string, unknown>, p.properties);
        out[endKey] = Object.keys(filled).length ? filled : refs[1];
      } else {
        out[endKey] = refs[1];
      }
      endFilled = true;
    }
  }
  if (opts?.frames === true && Object.keys(out).length && (refs.length < 2 || endFilled)) return out;
  // Pass 2: array-style reference fields — every ref (the source frame plus
  // extras) so positional citation stays aligned and video clips upload. The
  // field name varies by vendor (`visualReferences`, `referenceImages`, …),
  // so scan for any array-shaped reference field.
  const refKey = referenceArrayKey(props);
  if (refKey) return { ...out, [refKey]: refs };
  return Object.keys(out).length ? out : null;
}

export class OpenArtClient implements MediaProvider {
  readonly id = "openart" as const;
  readonly displayName = "OpenArt";

  /** True when the connected MCP surface exposes OpenArt image generation. */
  isAvailable(): boolean {
    return this.findTool(/^openart_.*generate.*image$/i) !== null;
  }
  private readonly videoOptionsCache = new Map<string, { o: VideoModelOptions | null; at: number }>();
  private readonly VIDEO_OPTIONS_NULL_TTL_MS = 2 * 60_000;

  /** A recorder (the expenses ledger) that observes every successful
   *  generation with its resolved metadata. Injected so the tally is testable
   *  at the same seam as the McpManager fake. `resizeVideoRef` downscales a
   *  video reference to the universal 720p ceiling; injected so
   *  the ffmpeg-backed implementation stays out of unit tests. */
  constructor(
    private readonly mcp: McpManager,
    private readonly recorder?: { onGeneration: (meta: LedgerGenMeta) => void },
    private readonly resizeVideoRef: (dataUrl: string) => Promise<string> = defaultResizeVideoRef
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

  /** Parse the OpenArt model-list reply into dropdown choices. */
  private parseOpenArtModels(raw: string): Array<Record<string, unknown>> {
    return parseOpenArtModels(raw);
  }

  /** Shape the OpenArt model list into dropdown choices. */
  private shapeModelChoices(raw: string): OpenArtModelChoice[] {
    return shapeOpenArtModelChoices(raw);
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

  /** Turn a stored choice into the id to actually call. "auto" (or empty)
   *  resolves to the first eligible model. An EXPLICIT pick that isn't in the
   *  vendor's list fails loudly instead of silently generating on a different
   *  model — a stale pick left over from a media-provider switch once billed
   *  a job to the wrong model. */
  private resolveOpenArtModel(choice: string, refsPresent: boolean, models: OpenArtModelChoice[]): string {
    void refsPresent;
    const trimmed = (choice ?? "").trim();
    if (trimmed && models.some((m) => m.id === trimmed)) return trimmed;
    if (trimmed && trimmed !== "auto" && models.length) {
      throw new Error(`"${trimmed}" isn't an OpenArt model (the active media provider is OpenArt) — re-pick the model and retry; switching media providers can strand a stale pick.`);
    }
    const withInput = models.filter((m) => m.imageInput);
    const pool = withInput.length ? withInput : models;
    return pool[0]?.id ?? "";
  }

  // ---- video-options cache --------------------------------------------------

  /** Does a form enum label look like a video resolution? Accepts "4K"/"2K"/
   *  "8K" (incl. "4K Ultra HD"), "480p"/"1080p"/"2160p", "1920x1080", bare
   *  numbers like "1080", and "HD"/"FHD"/"QHD"/"UHD"/"Full HD" — plus annotated
   *  labels like "4K Ultra HD (3840x2160)" that contain a resolution token. */
  private looksLikeResolution(s: string): boolean {
    return openArtLooksLikeResolution(s);
  }

  /** Extract the field map out of an OpenArt open_model_form_get reply. */
  private parseModelFormProperties(raw: string): Record<string, unknown> | null {
    return parseOpenArtFormProperties(raw);
  }

  /** Pull the resolution/duration options out of a model form's props map. */
  private extractVideoOptions(props: Record<string, unknown>): VideoModelOptions {
    return extractOpenArtVideoOptions(props);
  }

  /** Human-readable summary of accepted clip lengths ("4–15s" for a
   *  contiguous range, "5, 10s" for discrete picks) for validation errors. */
  private static describeDurations(durations: number[]): string {
    return describeOpenArtDurations(durations);
  }

  /** Resolve a video model's live form props (first image2video or
   *  text2video mode whose form parses, mirroring generateVideoClip's mode
   *  selection). Null when the form tool is missing or no mode parses. */
  private async fetchVideoFormProps(modelId: string, withImage: boolean): Promise<Record<string, unknown> | null> {
    const formRaw = this.findTool(/^openart_model_form_get$/);
    if (!formRaw) return null;
    if (typeof modelId !== "string" || !modelId || modelId === "auto") return null;
    const modes = withImage
      ? ["image2video", "image_to_video", "img2video", "video2video"]
      : ["text2video", "text_to_video", "video2video"];
    for (const mode of modes) {
      try {
        const props = this.parseModelFormProperties(await this.mcp.callRaw(SERVER, formRaw, { model: modelId, mode }));
        if (props) return props;
      } catch { /* try the next mode spelling */ }
    }
    return null;
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
    const props = await this.fetchVideoFormProps(modelId, withImage);
    return props ? this.extractVideoOptions(props) : null;
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
   *  schema). Null when the model form can't be read — including foreign
   *  (`higgsfield:…`) ids, which this vendor must never introspect. Cached
   *  per model+mode. */
  videoModelOptions(modelId: string, withImage: boolean): Promise<VideoModelOptions | null> {
    if (modelId.startsWith("higgsfield:")) return Promise.resolve(null);
    return this.resolveVideoOptions(modelId, withImage);
  }

  /** Image models expose no standalone quality selector on OpenArt: quality
   *  already rides the resolution tier (resolutionAssign maps 1k/2k/4k onto
   *  the model's sizing/quality fields). Always null so the storyboard
   *  quality dropdown stays hidden for this vendor. */
  imageModelOptions(_modelId: string): Promise<ImageModelOptions | null> {
    return Promise.resolve(null);
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
      // The in-betweener filters its model list to end-frame-capable models,
      // so their capability rides the same warm-up pass (same fetched schemas).
      void this.resolveVideoEndFrame(m.id).catch(() => {});
    }
  }

  /** Whether a video model's image-to-video form declares a dedicated
   *  end-frame slot (the in-betweener's start→end submit path fills it).
   *  Tri-state: true/false when the form parses, null when the form can't be
   *  read (unknown — the caller decides whether unknowns qualify). Cached
   *  with the same null-result TTL as the options cache. */
  async videoEndFrameSupport(modelId: string): Promise<boolean | null> {
    return this.resolveVideoEndFrame(modelId);
  }

  private readonly videoEndFrameCache = new Map<string, { v: boolean | null; at: number }>();

  /** Resolve (from cache when fresh) + store one model's end-frame support. */
  private async resolveVideoEndFrame(modelId: string): Promise<boolean | null> {
    if (typeof modelId !== "string" || !modelId || modelId === "auto") return null;
    const hit = this.videoEndFrameCache.get(modelId);
    if (hit && (hit.v !== null || Date.now() - hit.at < this.VIDEO_OPTIONS_NULL_TTL_MS)) return hit.v;
    let v: boolean | null = null;
    try {
      const props = await this.fetchVideoFormProps(modelId, true);
      if (props) v = endFrameSlotKey(props) !== null;
    } catch { /* unknown — leave null */ }
    this.videoEndFrameCache.set(modelId, { v, at: Date.now() });
    return v;
  }

  /** Ids of the video-capable models whose forms declare a dedicated
   *  end-frame slot. Empty when none is proven — the caller unions this with
   *  the user's manual allowlist before the tween dropdown offers anything.
   *  Capability lookups run concurrently off the warm cache. */
  async videoEndFrameModels(): Promise<string[]> {
    let models: OpenArtModelChoice[] = [];
    try {
      models = await this.listModelChoices();
    } catch { return []; }
    const video = models.filter((m) => m.videoInput && m.id && m.id !== "auto");
    const support = await Promise.all(video.map(async (m) => ({ id: m.id, v: await this.resolveVideoEndFrame(m.id).catch(() => null) })));
    return support.filter((s) => s.v === true).map((s) => s.id);
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
   *  schema declares. Tries, in order: an exact/positive enum label, an
   *  exact-positive numeric match (label variants like "2s"/"2 sec" → 2), a
   *  bare integer/number, a numeric field with min/max bounds (clamped), a
   *  free-form string (the "Ns" format OpenArt forms use), then an
   *  exact-positive oneOf/anyOf const. Sentinel values (-1/0/auto — OpenArt's
   *  "let the model pick" length) are NEVER chosen, and a non-exact request
   *  is never silently coerced: both produced a wrong-length clip (5s default
   *  when the field was dropped, and an auto-length clip when a -1 sentinel
   *  won a nearest-pick tie). The caller's validation (extractVideoOptions)
   *  rejects lengths the form can't do before this runs. */
  private videoDurationAssign(durationSec: number, props: Record<string, unknown>): Record<string, unknown> | null {
    const want = Math.round(durationSec);
    const wantStr = String(want);
    const exactPositive = (v: unknown): boolean => {
      const n = durationNumber(v);
      return Number.isFinite(n) && n > 0 && Math.round(n) === want;
    };
    for (const key of Object.keys(props)) {
      const p = props[key] as {
        type?: string; enum?: unknown[]; minimum?: unknown; maximum?: unknown;
        oneOf?: unknown[]; anyOf?: unknown[];
      } | undefined;
      if (!p || !/duration|length|seconds|clip|frames|time/i.test(key)) continue;
      if (Array.isArray(p.enum) && p.enum.length) {
        const exact = p.enum.find((v) => String(v).replace(/\s+/g, "").toLowerCase() === wantStr);
        if (exact !== undefined) return { [key]: exact };
        const num = p.enum.find(exactPositive);
        if (num !== undefined) return { [key]: num };
      }
      if (p.type === "integer" || p.type === "number") return { [key]: want };
      if ((p.minimum !== undefined || p.maximum !== undefined) &&
          (p.type === undefined || p.type === "integer" || p.type === "number")) {
        const min = Number(p.minimum) > 0 ? Number(p.minimum) : 1;
        const max = Number(p.maximum) > 0 ? Number(p.maximum) : min + 15;
        return { [key]: Math.max(min, Math.min(max, want)) };
      }
      if (p.type === "string") return { [key]: `${want}s` };
      const union = [...(p.oneOf ?? []), ...(p.anyOf ?? [])] as Array<{ const?: unknown } | null | undefined>;
      const exactConst = union.find((c) => c && exactPositive(c.const));
      if (exactConst && exactConst.const !== undefined) return { [key]: exactConst.const };
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
   *  Normal generation binds them as an array; the in-betweener passes
   *  `frames: true` to reach the dedicated start/end slots. See the free
   *  function for the exact rules. */
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
    // every frame for a production lands in a project named after the production.
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
    formProps: Record<string, unknown> | null,
    frames: boolean
  ): Record<string, unknown> {
    const props = formProps ?? {};
    const params: Record<string, unknown> = { prompt };
    const res = this.videoResolutionAssign(opts.resolution, props);
    if (res) Object.assign(params, res);
    const dur = this.videoDurationAssign(opts.durationSec, props);
    if (dur) Object.assign(params, dur);
    if (refs.length) {
      const refAssign = this.videoRefsAssign(refs, props, { frames });
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
   * project named after the production. Reuses an existing project
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
    const projectName = (p.meta.name || "").trim();
    if (!projectName) return null;
    if (!listRaw) {
      onNotice?.(`No OpenArt project tool is connected — frames will land in the account's default project instead of "${projectName}".`);
      return null;
    }
    const target = projectName.toLowerCase();
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
        onNotice?.(`No OpenArt project named "${projectName}" exists yet and the create tool isn't connected — generating into the account's default project.`);
        return null;
      }
      const createdText = await this.mcp.callRaw(SERVER, createRaw, { name: projectName });
      const created = this.parseOpenArtProjects(createdText)[0];
      const id = created && typeof created.id === "string" ? created.id : null;
      if (!id) {
        onNotice?.(`Couldn't read the id of the OpenArt project created for "${projectName}" — generating into the account's default project instead.`);
      }
      return id;
    } catch (e) {
      onNotice?.(`Couldn't resolve the OpenArt project "${projectName}" (${e instanceof Error ? e.message : String(e)}) — generating into the account's default project.`);
      return null;
    }
  }

  // ---- generation -----------------------------------------------------------

  /**
   * Resolve the Step 3 image generator. First (and only in-app) choice is the
   * OpenArt MCP server; returns null when it isn't connected or exposes no
   * image-generation tool, in which case the caller falls back to exporting
   * prompts for manual generation + import. `modelOverride` forces a specific
   * OpenArt model id (per-frame edit runs); "auto"/undefined uses the config.
   * `onNotice` reports a project-resolution fallback (frames landing in the
   * account default project instead of the production-named one) to the caller's
   * log so it's never silent. `aspectRatio` selects the generated image's
   * shape (16:9 by default; reference generation passes the modal's choice).
   */
  imageGenFn(p: Production, modelOverride?: string, resolutionOverride?: string, onNotice?: (msg: string) => void, aspectRatio: ImageGenAspectRatio = "16:9"): ImageGenFn | null {
    const toolName = this.findTool(/^openart_.*generate.*image$/i);
    if (!toolName) return null;

// Resolved lazily on the first shot (cache the production-named project id for
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
      // reference field), so their presence picks the mode below. Binding is
      // positional (probed live: visualReferences + "reference image N" prose
      // with no ids) — citations are anchored by citePrompt below.
      const uploaded: Record<string, unknown>[] = [];
      const submitted: (string | null)[] = [];
      for (const [i, r] of refs.entries()) {
        try {
          const vr = await uploadDataUrlReference(this.mcp, r.dataUrl, r.name);
          uploaded.push(vr);
          submitted[i] = String((vr as { id?: unknown }).id ?? (vr as { url?: unknown }).url ?? "").trim() || "";
        } catch { /* non-fatal: ref falls back to text-only */ }
      }
      const fullPrompt = citePrompt(prompt, refs, submitted);
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
      // Diagnostics: name the resolved model + mode so a wrong-model
      // suspicion can be settled from the log (mirrors Higgsfield's submit line).
      onNotice?.(`Submitting image job via ${modelId || "(model resolution failed)"} (mode=${mode}${hasRefs ? ` refs x${uploaded.length}` : " no refs"})`);
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
    extraRefs?: { name: string; dataUrl: string }[],
    frameRefs?: { start: { name: string; dataUrl: string }; end?: { name: string; dataUrl: string } }
  ): Promise<{ rel: string }> {
    const toolName = this.findTool(/^openart_.*generate.*video$/i);
    if (!toolName) throw new Error("OpenArt MCP isn't connected (no video-generation tool found), so videos can't be generated in-app.");

    let models: OpenArtModelChoice[] = [];
    try {
      models = await this.listModelChoices();
    } catch { models = []; }

    // References: the source frame(s) first (occupying @image1, and @image2
    // for an in-betweening end frame) — the shot's own artwork unless a
    // node-graph pipe supplies another frame (or the caller passes keyframe
    // data URLs directly) — then any extra references, then the @[name] tags
    // in the prompt, each uploaded as a visualReference.
    const refs: { name: string; dataUrl: string }[] = [];
    if (frameRefs) {
      refs.push(frameRefs.start);
      if (frameRefs.end) refs.push(frameRefs.end);
    } else {
      const sourceRel = sourcePathOverride?.trim() || shot.artwork;
      if (!sourceRel) throw new Error("No source frame — pipe a frame into the video node or generate one first.");
      {
        const buf = fs.readFileSync(assetPath(p, sourceRel));
        const ext = (path.extname(sourceRel).slice(1).toLowerCase() || "jpg").replace("jpeg", "jpg");
        const mime = ext === "jpg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
        refs.push({ name: `Shot ${shot.number} frame`, dataUrl: `data:${mime};base64,${buf.toString("base64")}` });
      }
    }
    refs.push(...(extraRefs ?? []));
    const { resolved, extras } = resolvePromptRefs(p, opts.prompt, refs.length, true);
    refs.push(...extras);

    // Resolve the model id ("auto" → first video-capable model), then discover
    // the mode the model's form accepts: image-to-video when references are
    // present, text-to-video otherwise. Try the common OpenArt mode spellings
    // so a slow/failed form lookup for one spelling doesn't drop the refs.
    // In-betweening ("auto" + an end keyframe) prefers a model with a
    // dedicated end-frame slot; anything else falls back to the first video
    // model (both frames still ride the array fallback). An explicit pick
    // that isn't in the vendor's list fails loudly — silently substituting a
    // different model once billed a stale cross-vendor pick to the wrong
    // model. (An empty list proves nothing, so it still falls through.)
    const picked = (opts.model ?? "").trim();
    if (picked && picked !== "auto" && models.length && !models.some((m) => m.id === picked)) {
      throw new Error(`"${picked}" isn't an OpenArt model (the active media provider is OpenArt) — re-pick the model and retry; switching media providers can strand a stale pick.`);
    }
    let modelId = picked && picked !== "auto" && !picked.startsWith("higgsfield:") ? picked : "";
    if (!modelId) {
      const video = models.filter((m) => m.videoInput);
      if (frameRefs?.end && video.length > 1) {
        const support = await Promise.all(video.map(async (m) => this.resolveVideoEndFrame(m.id).catch(() => null)));
        modelId = video.find((_, i) => support[i] === true)?.id ?? "";
      }
      modelId = modelId || video[0]?.id || "";
    }
    // Mode choice. The model list advertises the exact video-mode spellings
    // (OpenArt rejects a model+media combination it doesn't know), so prefer
    // those over guesses. When references are present, mode spellings that
    // carry references (`element2video`, `*reference*`, `omni`) go first —
    // image2video only animates the frame as a literal first frame and
    // exposes no reference array.
    const isRefyMode = (m: string) => /element|reference|ref2|omni/i.test(m);
    const advertised = models.find((mm) => mm.id === modelId)?.videoModes ?? [];
    const staticRefModes = ["element2video", "image2video", "image_to_video", "img2video", "reference2video", "reference_to_video", "ref2video", "reference_video", "omni2video", "omni", "multimodal2video", "video2video", "video"];
    const staticTextModes = ["text2video", "text_to_video", "video"];
    const modeCandidates = refs.length
      ? [...advertised.filter(isRefyMode), ...advertised.filter((m) => !isRefyMode(m)), ...staticRefModes]
      : [...advertised.filter((m) => !isRefyMode(m)), ...advertised.filter(isRefyMode), ...staticTextModes];
    // De-dupe while preserving order.
    const seenModes = new Set<string>();
    const orderedModes = modeCandidates.filter((m) => (seenModes.has(m) ? false : (seenModes.add(m), true)));
    let mode = orderedModes[0] ?? (refs.length ? "element2video" : "text2video");
    let formProps: Record<string, unknown> | null = null;
    let formRawReply = "";
    if (modelId) {
      const formRaw = this.findTool(/^openart_model_form_get$/);
      if (formRaw) {
        // Prefer a mode whose form actually declares an array reference field
        // when references were uploaded. Fall back to the first parsing mode
        // when no mode advertises a reference array.
        //
        // In-betweening overrides that: the first refy mode's form may carry
        // only the visualReferences array — with no startFrame/endFrame object
        // slots — so the keyframe pair would ride the array as plain
        // references and the interpolation would be wrong. When the caller
        // supplies an end keyframe, keep probing and prefer a mode whose form
        // declares BOTH frame slots (the startFrame slot is what fills pass
        // 1a; `endFrameSlotKey` is the same probe the submit path and the
        // capability test share).
        const wantFrames = !!frameRefs?.end;
        let refMode: { mode: string; props: Record<string, unknown> } | null = null;
        let frameMode: { mode: string; props: Record<string, unknown> } | null = null;
        for (const m of orderedModes) {
          let raw = "";
          try {
            raw = await this.mcp.callRaw(SERVER, formRaw, { model: modelId, mode: m });
          } catch { /* try the next mode spelling */ continue; }
          const props = this.parseModelFormProperties(raw);
          if (!props) {
            if (!formRawReply) formRawReply = String(raw ?? "");
            continue;
          }
          if (formProps === null) { formProps = props; mode = m; }
          if (!refs.length) break;
          if (wantFrames) {
            const hasStart = Object.keys(props).some((k) => {
              if (!START_FRAME_KEY_RX.test(k)) return false;
              const fld = props[k] as { type?: string; items?: unknown } | undefined;
              return !!fld && fld.type !== "array" && !fld.items;
            });
            if (hasStart && endFrameSlotKey(props)) { frameMode = { mode: m, props }; break; }
            // A ref-array-only mode is still a fallback — keep probing for a
            // frame-slot mode before settling on it.
            if (referenceArrayKey(props) && !refMode) refMode = { mode: m, props };
            continue;
          }
          if (referenceArrayKey(props)) { refMode = { mode: m, props }; break; }
        }
        const chosen = frameMode ?? refMode;
        if (chosen) { formProps = chosen.props; mode = chosen.mode; }
      }
    }

    // Uploads ride the same positional binding as images (probed live); the
    // sign request uses purpose "create-video" — using the image purpose can
    // make OpenArt reject the upload and silently drop the reference. Every
    // video reference is downscaled to the 720p ceiling first, regardless of
    // model, so an oversized clip doesn't fail the whole submission.
    const uploaded: Record<string, unknown>[] = [];
    const submitted: (string | null)[] = [];
    for (const [i, r] of refs.entries()) {
      try {
        let dataUrl = r.dataUrl;
        if (/^data:video\//i.test(dataUrl)) {
          const resized = await this.resizeVideoRef(dataUrl);
          if (resized !== dataUrl) {
            dataUrl = resized;
            emit(`Shot ${shot.number}: resized video reference "${r.name}" to ${VIDEO_REF_MAX_HEIGHT}p for this model.`);
          }
        }
        const vr = await uploadDataUrlReference(this.mcp, dataUrl, r.name, "create-video");
        uploaded.push(vr);
        submitted[i] = String((vr as { id?: unknown }).id ?? (vr as { url?: unknown }).url ?? "").trim() || "";
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        emit(`Reference "${r.name}" couldn't be uploaded (${why}) — continuing without it.`, "error");
      }
    }
    const fullPrompt = citePrompt(resolved, refs, submitted);

    const projectId = await this.resolveProject(p, (m) => emit(m)).catch(() => null);

    // Fail loudly when the model's live form proves it can't do the requested
    // length. Silently coercing here (nearest-enum pick in videoDurationAssign,
    // or omitting the field so the service falls back to its default) once
    // turned a 2s tween block into a 5s clip. Unknown options (unreadable
    // form, or no duration field at all) still pass through unchecked.
    if (formProps && Number.isFinite(opts.durationSec)) {
      const supported = this.extractVideoOptions(formProps).durations;
      const want = Math.round(opts.durationSec);
      if (supported.length && !supported.includes(want)) {
        throw new Error(
          `"${modelId || "the video model"}" doesn't support a ${want}s clip (supports ${OpenArtClient.describeDurations(supported)}) — retime the block or pick another model.`
        );
      }
    }

    const args = this.videoGenArgs(fullPrompt, uploaded, opts, modelId, projectId, mode, formProps, !!frameRefs);
    // Diagnostics: surface exactly what reaches OpenArt so a silently-ignored
    // length (the recurring "asked 2s, got the 5s default" bug) is visible in
    // the job log instead of a mystery. The params carry no secrets.
    const paramsObj = (args.params as Record<string, unknown>) ?? {};
    const durationKeys = Object.keys(paramsObj).filter((k) => /duration|length|seconds|clip|frames|time/i.test(k));
    // Reference binding diagnostic: which array field the uploaded refs landed
    // in, or a warning when they didn't (the "video reference isn't uploading"
    // failure mode). `paramsObj[k] === uploaded` identifies the field the
    // binder assigned, since `videoGenArgs` passes that exact array.
    const refArrayKey = uploaded.length
      ? Object.keys(paramsObj).find((k) => Array.isArray(paramsObj[k]) && paramsObj[k] === uploaded)
      : undefined;
    // When the refs couldn't be bound, dump the chosen mode's form fields
    // (array-shaped ones marked `[]`) so the real reference field name is
    // visible instead of a mystery.
    const formFieldDump = formProps
      ? Object.keys(formProps)
          .map((k) => {
            const p = formProps[k] as { type?: unknown; items?: unknown } | undefined;
            return `${k}${p?.type === "array" || p?.items ? "[]" : ""}`;
          })
          .join(", ")
      : "";
    const refInfo = refs.length
      ? ` refs ${uploaded.length}/${refs.length}` +
        (refArrayKey
          ? ` → ${refArrayKey}`
          : uploaded.length
            ? ` ⚠ no reference array field in the ${mode} form${formFieldDump ? ` — fields: [${formFieldDump}]` : ""}`
            : "")
      : "";
    const formKeys = formProps ? Object.keys(formProps) : [];
    const formDurationish = formKeys.filter((k) => /duration|length|seconds|clip|frames|time|time_?span|video/i.test(k));
    const formReplyInfo = formProps
      ? ""
      : formRawReply
        ? ` form reply (no props parsed): ${formRawReply.replace(/\s+/g, " ").slice(0, 600)}`
        : " no model form was returned";
    // Compact schema dump for the video-ish fields (types/enum/min/max only) so
    // a mismatched duration/resolution shape is visible in the job log.
    const schemaDump = formProps
      ? Object.entries(formProps)
          .filter(([k]) => /duration|length|seconds|resolution|quality|definition|size|clip|frames|time/i.test(k))
          .map(([k, v]) => {
            const p = (v ?? {}) as { type?: unknown; enum?: unknown; minimum?: unknown; maximum?: unknown; default?: unknown; oneOf?: unknown; anyOf?: unknown };
            const parts = [`"${k}"`];
            if (p.type !== undefined) parts.push(`type=${String(p.type)}`);
            if (Array.isArray(p.enum)) parts.push(`enum=[${p.enum.map((e) => JSON.stringify(e)).join(",")}]`);
            if (p.minimum !== undefined) parts.push(`min=${String(p.minimum)}`);
            if (p.maximum !== undefined) parts.push(`max=${String(p.maximum)}`);
            if (p.default !== undefined) parts.push(`default=${JSON.stringify(p.default)}`);
            if (Array.isArray(p.oneOf)) parts.push(`oneOf=${JSON.stringify(p.oneOf).slice(0, 220)}`);
            if (Array.isArray(p.anyOf)) parts.push(`anyOf=${JSON.stringify(p.anyOf).slice(0, 220)}`);
            return parts.join(" ");
          })
          .join(" | ")
      : "";
    emit(
      `Shot ${shot.number}: submitting video job${modelId ? ` via ${modelId}` : ""}…${refInfo} ` +
      (durationKeys.length
        ? `params ${durationKeys.map((k) => `${k}=${JSON.stringify(paramsObj[k])}`).join(", ")}`
        : `⚠ no duration/length param was set (OpenArt may default to 5s). Model form fields: [${formKeys.join(", ")}]${formDurationish.length ? ` — duration-ish: [${formDurationish.join(", ")}]` : ""}${schemaDump ? ` — ${schemaDump}` : ""}${formReplyInfo}`)
    );
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
