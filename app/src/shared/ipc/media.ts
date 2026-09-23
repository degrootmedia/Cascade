/**
 * Media provider + model-option types (master plan step 06 T1).
 *
 * Domain module of `shared/ipc.ts`; the barrel re-exports everything, so
 * `../shared/ipc.js` import paths are unchanged.
 */

/** Which vendor serves image/video generation (global setting).
 *  `higgsfield-cli` is the Higgsfield account driven through the local
 *  `higgsfield` CLI binary; its model ids are namespaced
 *  `higgsfield-cli:<job_type>`. Legacy `higgsfield:…` picks (removed MCP
 *  transport) route to the CLI, which accepts the old prefix as an alias.
 *  `openart-cli` is likewise the OpenArt account via the local `openart`
 *  CLI binary (`openart-cli:<id>`); it cannot send end frames or multiple
 *  video references, so those requests fail loudly with an MCP redirect. */
export type MediaProviderId = "openart" | "higgsfield-cli" | "openart-cli";

/** Which transport the media-provider pickers show: MCP servers or CLI binaries. */
export type ProviderTransportMode = "mcp" | "cli";

/** Single shared predicate for the transport toggle: the `-cli` suffix is the
 *  source of truth — CLI ids show in "cli" mode, the rest in "mcp" mode. */
export function isProviderVisible(id: MediaProviderId, mode: ProviderTransportMode): boolean {
  return mode === "cli" ? id.endsWith("-cli") : !id.endsWith("-cli");
}

/** Whether the active provider offers an image-upscale path. Only the
 *  Higgsfield CLI probes upscale families; the OpenArt MCP transport has none,
 *  so the upscale node and the Image Suite's Upscale mode are disabled for it. */
export function providerSupportsUpscale(id: MediaProviderId): boolean {
  return id !== "openart";
}

/** Tooltip shown wherever the upscale path is disabled for the active provider. */
export const UPSCALE_UNAVAILABLE_HINT = "Not available when using OpenArt MCP";

/** Canonicalize a per-style model/resolution override for generation:
 *  absent, blank, or "auto" inherits the production default (sent as
 *  undefined — the provider treats undefined and "auto" alike). */
export function styleFrameOverride(value: string | undefined): string | undefined {
  return value && value !== "auto" ? value : undefined;
}

/** One generation vendor for the Settings picker. */
export interface MediaProviderInfo {
  id: MediaProviderId;
  displayName: string;
  /** Whether the vendor's generation tools are currently connected. */
  available: boolean;
}

/** The Higgsfield CLI transport status (Settings → Media generation). */
export interface HiggsfieldCliStatus {
  /** Resolved binary path, or null when no `higgsfield` binary was found. */
  binary: string | null;
  /** `higgsfield version` output, or null when the binary is missing. */
  version: string | null;
  /** Whether `account status` succeeds (signed in with a workspace). */
  authenticated: boolean;
  /** The signed-in account email, when known. */
  account: string | null;
}

/** The OpenArt CLI transport status (Settings → Media generation). */
export interface OpenArtCliStatus {
  /** Resolved binary path, or null when no `openart` binary was found. */
  binary: string | null;
  /** `openart version` output, or null when the binary is missing. */
  version: string | null;
  /** Whether `account` succeeds (signed in). */
  authenticated: boolean;
  /** The signed-in account email, when known. */
  account: string | null;
}

export type ModelSurface =
  | "image:generate" // image generation: master board / node / references / characters / style frames
  | "image:edit"     // image editing: classic edit popup + edit-image node
  | "image:upscale"  // image upscaling: the upscale node + the Image Suite's Upscale mode
  | "video:generate" // video generation: classic video modal + video node
  | "video:tween"    // in-betweener timeline
  | "video:editnode"; // node-graph edit-video node

/** Every surface key, in display order. */
export const MODEL_SURFACES: readonly ModelSurface[] = [
  "image:generate", "image:edit", "image:upscale", "video:generate", "video:tween", "video:editnode",
];

/** Legacy surface keys from before surfaces were collapsed into pools. Each
 *  maps to the single surface that now owns its pickers. */
const LEGACY_MODEL_SURFACES: Record<string, ModelSurface> = {
  "image:master": "image:generate",
  "image:node": "image:generate",
  "image:reference": "image:generate",
  "image:character": "image:generate",
  "image:edit": "image:edit",
  "image:editnode": "image:edit",
  "video:modal": "video:generate",
  "video:node": "video:generate",
  "video:tween": "video:tween",
  "video:editnode": "video:editnode",
};

/** Coerce a stored/legacy surface list to the current keys, dropping unknowns.
 *  The single home for surface-key migration (settings read/write and the
 *  main-side surface application both go through here). */
export function normalizeModelSurfaces(list: unknown): ModelSurface[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<ModelSurface>();
  for (const raw of list) {
    const key = String(raw);
    const mapped = LEGACY_MODEL_SURFACES[key] ?? (MODEL_SURFACES.includes(key as ModelSurface) ? (key as ModelSurface) : null);
    if (mapped) out.add(mapped);
  }
  return [...out];
}

/** Whether a model is offered on a surface. Undefined/absent `surfaces`, or an
 *  empty list, means "everywhere it can go" (the default until the user
 *  restricts it) — an empty array must never hide a model from every picker. */
export function modelOnSurface(
  m: Pick<OpenArtModelChoice, "surfaces">,
  surface: ModelSurface
): boolean {
  return !m.surfaces || m.surfaces.length === 0 || m.surfaces.includes(surface);
}

/** An OpenArt model surfaced in the Step 3 model dropdown. */
export interface OpenArtModelChoice {
  id: string;
  displayName: string;
  description: string;
  /** Whether the model accepts reference images (extra meta for Auto). */
  imageInput: boolean;
  /** Whether the model generates video (surfaced in the video-generation modal). */
  videoInput: boolean;
  /** Base credit cost for one job (may be null for metadata). */
  cost: number | null;
  /** Advertised video-mode spellings from the model list (e.g. `image2video`,
   *  `element2video`). Used to submit in the mode that actually carries
   *  references; absent for non-video models. */
  videoModes?: string[];
  /** Surfaces this model is allowed on, applied main-side from settings. */
  surfaces?: ModelSurface[];
}

/** The one kind classification every dropdown follows: a model is IMAGE only
 *  when it outputs images and is not a video generator — video models accept
 *  an input image (image-to-video), so the imageInput flag alone can't
 *  classify. Matches the auto-detected kind in Models & expenses and what an
 *  "image" manual override bakes (videoInput cleared). */
export const isImageModel = (m: Pick<OpenArtModelChoice, "imageInput" | "videoInput">): boolean =>
  m.imageInput && !m.videoInput;
/** A model the video dropdowns offer — any video-capable generator. */
export const isVideoModel = (m: Pick<OpenArtModelChoice, "videoInput">): boolean => m.videoInput;

/** One generation dropdown's remembered last choice (Settings-backed, global
 *  per context): each dropdown starts where the user last left it. */
export interface MediaDefaultChoice {
  model?: string;
  resolution?: string;
  durationSec?: number;
  aspectRatio?: string;
}
/** The dropdown contexts a media default is remembered for. */
export type MediaDefaultCtx = "image" | "video" | "edit" | "reference" | "character" | "tween" | "upscale";

/** The one aspect-ratio default every generation surface shares. The vendor
 *  image default is 1:1; Cascade deliberately forces 16:9 unless the user
 *  picks another ratio the model lists. Never send "16x9" — the wire value
 *  is "16:9". */
export const DEFAULT_ASPECT_RATIO = "16:9";

/** Normalize a chosen aspect ratio to the shared default. Empty/whitespace
 *  falls back to 16:9; otherwise the caller's value is returned verbatim
 *  (only values the model lists is ever submitted). */
export function resolveAspectRatio(chosen?: string | null): string {
  return chosen && chosen.trim() ? chosen : DEFAULT_ASPECT_RATIO;
}

/** Keep only CLI-safe scalar option values (string/number/boolean/string[])
 *  from an untrusted params bag. Providers ignore unknown keys for the active
 *  model, but non-scalar shapes (objects from a corrupt doc or a raw IPC
 *  payload) must never reach argv or persisted state. Undefined for
 *  absent/empty bags so callers can omit the field. */
export function sanitizeGenParams(params: unknown): Record<string, string | number | boolean | string[]> | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v) && v.every((e) => typeof e === "string")) out[k] = [...v];
  }
  return Object.keys(out).length ? out : undefined;
}

/** Where a model parameter renders in the options form. "hidden" removes it
 *  from the UI entirely; core/advanced place it in the exposed list or the
 *  collapsible Advanced panel. */
export type ModelParamExposure = "core" | "advanced" | "hidden";

/** One user-configured parameter default (dev Model Customizer). Kept in the
 *  same scalar shapes the options form edits: enum/string as string, numeric
 *  as number, boolean as boolean, repeatable as string[]. */
export type ModelParamDefaultValue = string | number | boolean | string[];

/** A provider parameter that is not a first-class exposed control. Derived
 *  from the provider's live schema as a projection (see CliOptionField). */
export interface ModelParamOption {
  /** CLI flag as consumed by the provider layer, e.g. "--variant". */
  flag: string;
  /** Stable storage key inside a params map, e.g. "variant". */
  key: string;
  /** Ordered values offered by the UI. */
  values: string[];
  /** Value used when the user has not chosen one. */
  defaultValue?: string;
  /** Presentation class. "advanced" renders inside the collapsible panel. */
  exposure: "exposed" | "advanced";
  /** Human label for the control. */
  label?: string;
}

/** Choices made in the per-shot video-generation modal. */
export interface VideoGenOptions {
  /** OpenArt video model id, or "auto" for Cascade to pick. */
  model: string;
  /** Output resolution label (e.g. "480p", "720p", "1080p"). */
  resolution: string;
  /** Desired clip length in seconds. */
  durationSec: number;
  /** Motion/animation prompt (may contain @[name] reference tags). */
  prompt: string;
  /**
   * Per-model, schema-driven option values keyed by canonical flag name
   * (see `CliModelSchema`). Optional and additive — same semantics as
   * `OpenArtBoardConfig.params` for the video path.
   */
  params?: Record<string, string | number | boolean | string[]>;
}

/** Per-config credit quote for one generation (Higgsfield CLI `generate
 *  cost` preflight — mirrors `generate create` args but submits nothing).
 *  Only structural price drivers travel: prompt text and reference bytes
 *  never affect the price, so the probe sends a constant placeholder prompt
 *  and no media flags (zero uploads). */
export interface GenerationCostRequest {
  /** Provider-namespaced model id (only `higgsfield-cli:*` quotes; anything
   *  else resolves null with zero spawns). */
  model: string;
  /** Whether this is an image or video quote (gates `--duration`). */
  kind: "image" | "video";
  /** Output resolution label (e.g. "720p", "2k"). */
  resolution?: string;
  /** Desired clip length in seconds (video only). */
  durationSec?: number;
  /** Aspect ratio wire value (e.g. "16:9"). */
  aspectRatio?: string;
  /** Quality tier label (image models that declare one). */
  quality?: string;
  /** Schema-driven extras (variant, mode, …) keyed by canonical flag. */
  params?: Record<string, string | number | boolean | string[]>;
}

/** The resolution / length options a video model actually accepts, read from
 *  its live form schema. Used to populate the video modal per model. */
export interface VideoModelOptions {
  /** Resolution labels the model accepts (e.g. ["720p","1080p"]). */
  resolutions: string[];
  /** Clip lengths in seconds the model accepts. */
  durations: number[];
  /** Accepted aspect ratios. The UI default is forced by
   *  `DEFAULT_ASPECT_RATIO` regardless of the vendor default. */
  aspectRatios?: string[];
  /** Accepted quality labels (models that declare a quality/definition enum). */
  qualities?: string[];
  defaultQuality?: string;
  defaultResolution?: string;
  /** Remaining provider params rendered in the Advanced panel. */
  params?: ModelParamOption[];
}

/** The quality options an image model actually accepts, read from its live
 *  catalog detail. Used to populate the storyboard quality dropdown per
 *  model. Null when the model (or its options) can't be read. */
export interface ImageModelOptions {
  /** Quality labels the model accepts (e.g. ["basic","high"]). */
  qualities: string[];
  /** The model's declared default quality, when it names one we recognize. */
  defaultQuality?: string | null;
  /** Accepted aspect ratios. UI default is forced by `DEFAULT_ASPECT_RATIO`. */
  aspectRatios?: string[];
  /** Accepted --resolution values. */
  resolutions?: string[];
  defaultResolution?: string;
  /** GPT Image 2.5 "--variant" values ("submodels" in UI copy). */
  submodels?: string[];
  defaultSubmodel?: string;
  /** Remaining provider params rendered in the Advanced panel. */
  params?: ModelParamOption[];
}

/** How a schema-driven model option value is rendered and emitted. */
export type CliOptionKind =
  | "enum"      // values[] present — a closed pick list
  | "integer"   // whole numbers (duration, seed, batch_size)
  | "number"    // free numeric input
  | "boolean"   // explicit true/false flag
  | "string"    // free text
  | "array"     // repeatable flag / list value (reference arrays)
  | "json";     // structured payload (passed inline or via @file)

/** Display grouping for the schema-driven options form. */
export type CliOptionGroup = "core" | "reference" | "control" | "advanced";

/** How a schema field's value reaches the CLI argv. */
export type CliOptionEmit =
  | "value"        // --flag <value>
  | "boolean-flag" // --flag true | --flag false (always explicit)
  | "repeat"       // --flag <v> repeated per item
  | "json-file";   // JSON written to a temp file, emitted as --flag @<path>

/** One normalized model parameter from `model get <job_type> --json`. */
export interface CliOptionField {
  /** Canonical folded name, e.g. "aspect_ratio". */
  name: string;
  /** Emitted flag without dashes, e.g. "aspect_ratio". */
  flag: string;
  /** Folded aliases for value lookup (["aspectratio", ...]). */
  aliases: string[];
  kind: CliOptionKind;
  group: CliOptionGroup;
  /** Enum member set (kind === "enum" only). */
  values?: string[];
  default?: string | number | boolean | string[] | null;
  min?: number;
  max?: number;
  step?: number;
  /** Whether the CLI requires the flag (or only conditionally). */
  required?: boolean | "conditional";
  /** Raw human constraint text from the CLI, if any. */
  constraint?: string;
  /** Media role for reference fields (e.g. "image_references"). */
  mediaRole?: string;
  repeatable?: boolean;
  /** Max accepted items for repeatable fields (e.g. 16). */
  maxItems?: number;
  emit: CliOptionEmit;
  /** Provenance for debugging. */
  source: "parameters" | "topLevel";
}

/** The normalized per-model option schema, derived live from
 *  `model get <job_type> --json`. Rendered by `<ModelOptionsForm>` and
 *  consumed by the generic arg builder. */
export interface CliModelSchema {
  jobType: string;
  /** CLI version that produced the schema (support-report provenance). */
  cliVersion: string | null;
  /** Epoch ms of the fetch (TTL + staleness display). */
  fetchedAt: number;
  fields: CliOptionField[];
  aspectRatios: string[];
  durations: number[];
  roles: string[];
  /** Last raw `model get --json` payload (for constraint parsing). */
  raw: unknown;
}

/** A discovered media model with its pricing ladder baked — the read model for
 *  the Settings → Models & expenses tab. One entry per model from EITHER
 *  vendor (ids are provider-namespaced, so the union can't collide). */
export interface MediaModelLadder {
  /** Which vendor surfaced this model (the settings tab groups by it). */
  provider: MediaProviderId;
  /** The model choice as surfaced by its vendor (display name, capabilities). */
  choice: OpenArtModelChoice;
  /** Resolution ladder, low → high (image: fixed 1k/2k/4k buckets; video:
   *  read from the model's live form options, kind defaults when unreadable). */
  resolutions: string[];
  /** Cheapest video length in seconds this model accepts (null for images). */
  durMin: number | null;
  /** Most expensive video length in seconds this model accepts (null for images). */
  durMax: number | null;
}

/** One probed model in the dev Model Customizer. */
export interface ModelProbeEntry {
  /** The provider namespaced choice (id, display name, capabilities). */
  choice: OpenArtModelChoice;
  /** Whether the user hides this model from generation dropdowns. */
  hidden: boolean;
  /** Manual kind override, when set. */
  kindOverride?: "image" | "video";
}

/** One provider's probe result for the dev Model Customizer. */
export interface ModelProbeResult {
  provider: MediaProviderId;
  displayName: string;
  available: boolean;
  error?: string;
  models: ModelProbeEntry[];
}
