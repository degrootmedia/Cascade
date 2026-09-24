/**
 * MediaProvider — the abstraction layer over image/video generation
 * (MCP servers and local CLI binaries).
 *
 * OpenArt was originally hardcoded through the whole main process
 * (`const SERVER = "openart"` + `findTool(/^openart_…/)` inside OpenArtClient).
 * The second vendor (Higgsfield) makes the seam real: every generation flow
 * in index.ts resolves the active provider through the registry and talks to
 * this interface, never to a vendor class directly.
 *
 * Model ids are provider-namespaced where they leave the provider
 * (`higgsfield-cli:<id>`, `openart-cli:<id>`): price rules, stored configs,
 * and the renderer treat them opaquely, and each provider maps
 * foreign/unknown ids back to "auto" instead of submitting a cross-vendor
 * id to its server.
 */
import type { McpManager } from "../mcp.js";
import type { ImageGenFn } from "../pipeline.js";
import type {
  CliModelSchema,
  ImageGenAspectRatio,
  ImageModelOptions,
  GenerationCostRequest,
  LedgerGenMeta,
  MediaProviderId,
  OpenArtBoardConfig,
  OpenArtModelChoice,
  PendingImageGen,
  PendingVideoGen,
  Production,
  ProductionEvent,
  ProductionShot,
  VideoGenOptions,
  VideoModelOptions,
} from "../../shared/ipc.js";

/** A recorder (the expenses ledger) observing every successful generation. */
export interface GenerationRecorder {
  onGeneration: (meta: LedgerGenMeta) => void;
}

/** The log-line callback generation flows emit through (mirrors productionEmit). */
export type ProviderEmit = (m: string, l?: ProductionEvent["level"]) => void;

export interface MediaProvider {
  readonly id: MediaProviderId;
  readonly displayName: string;

  /** Sync best-effort check: does the connected MCP surface expose this
   *  vendor's generation tools? (No network — reads McpManager.getTools().) */
  isAvailable(): boolean;

  /** The model dropdown. Ids leaving the provider are namespaced (see
   *  above); no synthetic "auto" entry — callers pick explicitly. */
  listModelChoices(): Promise<OpenArtModelChoice[]>;

  /** Remaining credit balance, or null when it can't be read. */
  getCredits(): Promise<number | null>;

  /**
   * Resolve the Step 3 image generator, or null when the vendor isn't
   * connected. `modelOverride` forces a specific model id (per-frame edit
   * runs); "auto"/undefined uses the production config. `aspectRatio`
   * selects the generated image's shape.
   */
  imageGenFn(
    p: Production,
    modelOverride?: string,
    resolutionOverride?: string,
    onNotice?: (msg: string) => void,
    aspectRatio?: ImageGenAspectRatio
  ): ImageGenFn | null;

  /**
   * Generate one video clip for a shot. The shot's current frame (full
   * resolution) is always the first visual reference unless a node-graph
   * pipe or explicit frameRefs supply other frames; @[name] tags and
   * extraRefs add more. Writes the finished clip into the shot's board folder
   * under `video/` and returns its workspace-relative path.
   */
  generateVideoClip(
    p: Production,
    shot: ProductionShot,
    opts: VideoGenOptions,
    emit: ProviderEmit,
    sourcePathOverride?: string,
    extraRefs?: { name: string; dataUrl: string }[],
    frameRefs?: { start: { name: string; dataUrl: string }; end?: { name: string; dataUrl: string } }
  ): Promise<{ rel: string }>;

  /**
   * Recheck a pending image job and return the finished bytes, or null when
   * it's still rendering (or the result still can't be fetched). Throws when
   * the job is dead (FAILED/CANCELLED — nothing left to reclaim).
   */
  recheckPendingImage(rec: PendingImageGen): Promise<Buffer | null>;

  /**
   * Recheck a pending video job and return the finished bytes + file
   * extension, or null when it's still rendering (or the result still can't be
   * fetched). Throws when the job is dead (FAILED/CANCELLED — nothing left to
   * reclaim).
   */
  recheckPendingVideo(rec: PendingVideoGen): Promise<{ buf: Buffer; ext: string } | null>;

  /**
   * Resolve the vendor-side project/collection a production's frames should
   * land in, or null when the vendor has no such concept (or resolution
   * fails — generation then falls back to the account default rather than
   * blocking). `onNotice` reports a fallback so it is never silent.
   */
  resolveProject(p: Production, onNotice?: (msg: string) => void): Promise<string | null>;

  /** The resolution / length options a video model accepts. Null when the
   *  model (or its options) can't be read. */
  videoModelOptions(modelId: string, withImage: boolean): Promise<VideoModelOptions | null>;

  /** The quality options an image model accepts. Null when the model
   *  declares none or can't be read (the caller hides the quality
   *  dropdown and the vendor default applies). */
  imageModelOptions(modelId: string): Promise<ImageModelOptions | null>;

  /** The full normalized option schema for a model. Optional — providers
   *  without a schema surface (OpenArt, MCP Higgsfield) omit it and
   *  callers fall back to the ladder methods. */
  modelOptions?(modelId: string): Promise<CliModelSchema | null>;

  /** Live per-config credit quote for one generation (no job submitted).
   *  Optional — providers without a cost surface omit it and callers treat
   *  the quote as unknown (null). Never throws: unreadable quotes resolve
   *  null so the UI hides the price instead of blocking submit. */
  getGenerationCost?(req: GenerationCostRequest): Promise<number | null>;

  /** Ids of the video-capable models that accept a dedicated end frame
   *  (the in-betweener's start→end submit path). Empty when none is proven —
   *  the caller unions this with the user's manual allowlist before the
   *  tween dropdown shows anything. */
  videoEndFrameModels(): Promise<string[]>;

  /** Ids (namespaced) of models that accept a video input (the edit-video
   *  node's capability probe). Optional — providers without video-edit
   *  models omit it and the caller offers nothing. */
  videoEditModels?(): Promise<string[]>;

  /** Ids (namespaced) of models that upscale an existing image (the upscale
   *  node + Image Suite Upscale mode capability probe). Optional — providers
   *  without an upscale path omit it and the caller unions nothing, falling
   *  back to the user's `image:upscale` surface assignments alone. */
  imageUpscaleModels?(): Promise<string[]>;

  /** Edit one video: the source video is mandatory; image/video references
   *  ride along. Optional — callers surface a clear error when the active
   *  provider doesn't implement it. */
  generateVideoEdit?(
    p: Production,
    shot: ProductionShot,
    opts: VideoGenOptions,
    emit: ProviderEmit,
    sourceVideoPath: string,
    extraRefs?: { name: string; dataUrl: string }[]
  ): Promise<{ rel: string }>;

  /** Warm any per-model caches after a successful model list.
   *  Fire-and-forget: never blocks the caller. */
  prewarm?(models: OpenArtModelChoice[]): void;

  /** Drop cached catalog/option probes so the next probe refetches from the
   *  vendor (dev Model Customizer "Refresh"). Fire-and-forget. */
  refreshProbes?(): void;
}

/** The dependencies every provider is constructed with (the seam). */
export interface ProviderDeps {
  mcp: McpManager;
  recorder?: GenerationRecorder;
}

// Re-exported so vendor modules and tests share one vocabulary.
export type {
  CliModelSchema,
  ImageGenAspectRatio,
  ImageModelOptions,
  GenerationCostRequest,
  LedgerGenMeta,
  MediaProviderId,
  OpenArtBoardConfig,
  OpenArtModelChoice,
  PendingImageGen,
  PendingVideoGen,
  Production,
  ProductionShot,
  VideoGenOptions,
  VideoModelOptions,
};
