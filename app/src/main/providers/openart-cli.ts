/**
 * OpenArtCliProvider — the official `openart` CLI binary's MediaProvider
 * adapter (https://github.com/OpenArt-AI/cli, single-file binary, OAuth via
 * `openart login`, no API key).
 *
 * Command mapping (probed from CLI v0.1.1 `--help` + `--dry-run` JSON):
 * - catalog:  `model list --json` →  model items (the SAME vocabulary as
 *               the MCP `openart_model_list`: shaped via openart-core)
 * - detail:   `model form <id> <mode> --json` →  JSON Schema of accepted
 *               params (read via openart-core's form parser)
 * - costs:    `model cost --json` →  per-model credit quotes (background
 *               overlay onto choices; absent when unreadable)
 * - submit:   `generate image <prompt> --model … [--image …] --async`
 *               / `generate video … [--image …] [--duration …]
 *               [--resolution …] [--aspect-ratio …] --async` →  history id
 * - poll:     `creation wait <id> --timeout … --json` →  result URLs;
 *               `creation get <id> --json` for rechecks
 * - credits:  `account --json`
 * - projects: `project list/create --json` (production-named project, like
 *               the MCP transport; `--project` routes generations into it)
 *
 * Capability notes (v0.1.1 limits, enforced fail-loudly):
 * - Images take repeatable `--image` (full multi-reference support) but
 *   expose NO aspect/resolution flags — model defaults apply; each
 *   generation logs that so a 4k pick is never silently misread.
 * - Video takes a SINGLE `--image` (start frame) only: no end frame, no
 *   extra image references, no video references. End-frame/multi-ref
 *   requests throw a clear error redirecting to the OpenArt MCP transport
 *   (or Higgsfield) instead of burning credits on the wrong output.
 *
 * The subprocess is injected via the constructor — the seam. A fake `run`
 * substitutes for the live binary in tests, so the module's interface IS
 * the test surface. This module never imports the MCP manager or Electron.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { assetPath, writeShotVideo, type ImageGenFn } from "../pipeline.js";
import {
  IMAGE_URL_RX,
  parseJsonLooseArray,
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
import {
  defaultCliRun,
  resolveCliOnPath,
  writeCliTempRefs,
  type CliRun,
} from "./cli-run.js";
import {
  OPENART_JOB_DONE_RX,
  describeOpenArtDurations,
  extractOpenArtVideoOptions,
  openArtCreationResultUrls,
  openArtCreationStatus,
  openArtSchemaFromProps,
  parseOpenArtFormProperties,
  shapeOpenArtModelChoices,
} from "./openart-core.js";

/** Prefix marking model ids that belong to this provider (see types.ts).
 *  The raw id is the shared OpenArt model id; the prefix keeps the two
 *  OpenArt transports from colliding in price rules and dropdowns. */
export const OPENART_CLI_ID_PREFIX = "openart-cli:";

/** Strip the CLI prefix; foreign ids come back unchanged. */
export function openArtCliRawId(modelId: string): string {
  return modelId.startsWith(OPENART_CLI_ID_PREFIX)
    ? modelId.slice(OPENART_CLI_ID_PREFIX.length)
    : modelId;
}

/** True when the id names a foreign (non-OpenArt) provider. */
function isForeignId(modelId: string): boolean {
  const t = modelId.trim();
  return t.includes(":") && !t.startsWith(OPENART_CLI_ID_PREFIX);
}

const FORM_TTL_MS = 10 * 60_000;
const IMAGE_WAIT_TIMEOUT_MS = 150_000;
const IMAGE_RECHECK_TIMEOUT_MS = 60_000;
const VIDEO_WAIT_TIMEOUT_MS = 20 * 60_000;

const IMAGE_MODES = ["image2image", "text2image"];
const VIDEO_IMAGE_MODES = ["image2video", "image_to_video", "img2video", "element2video"];
const VIDEO_TEXT_MODES = ["text2video", "text_to_video"];
/** Broad mode list for a provider-agnostic option probe (dev customizer). */
const ALL_MODES = [...IMAGE_MODES, ...VIDEO_IMAGE_MODES, ...VIDEO_TEXT_MODES];

/** Pull the history/creation id out of a `--async` submit reply: a bare id
 *  string, a `{historyId|id|…}` object, or a UUID buried in prose. */
function extractHistoryId(stdout: string): string | null {
  const text = stdout.trim();
  if (!text) return null;
  const arr = parseJsonLooseArray(text);
  if (arr && arr.length) {
    const first = arr[0];
    if (typeof first === "string" && first.trim()) return first.trim();
    if (first && typeof first === "object") {
      const id = String(
        (first as Record<string, unknown>).historyId ??
        (first as Record<string, unknown>).id ??
        (first as Record<string, unknown>).creation_id ??
        (first as Record<string, unknown>).job_id ??
        ""
      ).trim();
      if (id) return id;
    }
  }
  const obj = parseJsonLooseObject(text);
  if (obj) {
    const id = String(obj.historyId ?? obj.id ?? obj.creation_id ?? obj.creationId ?? obj.job_id ?? obj.jobId ?? "").trim();
    if (id) return id;
  }
  if (/^[\w-]{4,128}$/.test(text) && !/\s/.test(text)) return text;
  return text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)?.[0] ?? null;
}

// Creation status + result-URL extraction live in openart-core: the MCP
// transport reads the same creation replies, so the grammar has one home.

/** Thrown when a CLI wait cap passes with the job still rendering. The job
 *  is NOT dead — it keeps rendering server-side — so image callers record
 *  the historyId as pending and reclaim it with `creation get` later. */
export class OpenArtCliPendingError extends Error {
  constructor(readonly historyId: string) {
    super(`OpenArt generation timed out (${historyId.slice(0, 8)}…).`);
    this.name = "OpenArtCliPendingError";
  }
}

/** Resolve the `openart` binary: an explicit custom path first, then PATH.
 *  The official installers drop a real binary — no shim mapping needed. */
export async function resolveOpenArtCliBinary(customPath?: string | null): Promise<string | null> {
  const custom = typeof customPath === "string" ? customPath.trim() : "";
  if (custom) {
    try {
      if (fs.existsSync(custom) && fs.statSync(custom).isFile()) return custom;
    } catch { /* fall through to PATH */ }
  }
  return resolveCliOnPath(["openart"]);
}

export class OpenArtCliProvider implements MediaProvider {
  readonly id = "openart-cli" as const;
  readonly displayName = "OpenArt CLI";

  private listCache: { at: number; choices: OpenArtModelChoice[] } | null = null;
  private formCache = new Map<string, { at: number; props: Record<string, unknown> | null }>();
  private costCache: { at: number; costs: Map<string, number> } | null = null;

  /** `binary` resolves the CLI path lazily (Settings override → PATH probe
   *  cached by the caller) so a path change applies without a restart.
   *  `run` defaults to spawning the resolved binary; tests inject a fake. */
  constructor(
    private readonly opts: {
      binary: () => string | null;
      run?: CliRun;
      recorder?: GenerationRecorder;
    }
  ) {}

  /** Drop cached catalog/form/cost probes (dev customizer refresh). */
  refreshProbes(): void {
    this.listCache = null;
    this.formCache.clear();
    this.costCache = null;
  }

  /** True when an `openart` binary resolves (PATH or Settings override).
   *  Auth is NOT checked here — a signed-out CLI fails loudly with a
   *  login hint on the first real call, like an unconnected MCP server. */
  isAvailable(): boolean {
    try {
      return this.opts.binary() !== null;
    } catch {
      return false;
    }
  }

  private fireGeneration(meta: LedgerGenMeta): void {
    try {
      this.opts.recorder?.onGeneration(meta);
    } catch {
      /* ignored */
    }
  }

  /** Run the CLI, throwing a readable error (stderr + login hint) on failure. */
  private async cli(args: string[], timeoutMs: number): Promise<string> {
    const binary = this.opts.binary();
    if (!binary) {
      throw new Error(
        "The OpenArt CLI isn't installed (no `openart` binary on PATH and no custom path in Settings → Media generation) — install it from https://github.com/OpenArt-AI/cli or pick another media provider."
      );
    }
    const run = this.opts.run ?? defaultCliRun(binary);
    const res = await run(args, { timeoutMs });
    if (res.code !== 0) {
      const err = `${res.stderr.trim() || res.stdout.trim() || `exit code ${res.code}`}`.slice(0, 600);
      const authHint = /not logged in|not authenticated|session expired|auth login|login/i.test(err)
        ? " Run `openart login` in a terminal, then retry."
        : "";
      throw new Error(`openart ${args.slice(0, 2).join(" ")} failed: ${err}.${authHint}`);
    }
    return res.stdout;
  }

  private json(args: string[], timeoutMs = 60_000): Promise<string> {
    return this.cli([...args, "--json"], timeoutMs);
  }

  // ---- catalog --------------------------------------------------------------------

  /** The model dropdown, resolved from the CLI. Ids leave namespaced
   *  (`openart-cli:…`) so the two OpenArt transports never collide in price
   *  rules or ladder rows. Costs overlay from `model cost` when readable
   *  (background-warmed, never blocking). */
  async listModelChoices(): Promise<OpenArtModelChoice[]> {
    const now = Date.now();
    if (!this.listCache || now - this.listCache.at >= FORM_TTL_MS) {
      const choices = shapeOpenArtModelChoices(await this.json(["model", "list"]));
      for (const c of choices) c.id = `${OPENART_CLI_ID_PREFIX}${c.id}`;
      this.listCache = { at: now, choices };
      void this.warmCosts().catch(() => {});
    }
    // Costs arrive in the background — overlay whatever is cached so far on
    // every call (a later listing picks up warmed quotes without refetching).
    const costs = this.costCache && now - this.costCache.at < FORM_TTL_MS ? this.costCache.costs : null;
    if (costs) {
      for (const c of this.listCache.choices) {
        if (c.cost === null) {
          const q = costs.get(openArtCliRawId(c.id));
          if (q !== undefined) c.cost = q;
        }
      }
    }
    return this.listCache.choices;
  }

  /** Quote every model + mode cheapest-first; map each model id to its
   *  cheapest quoted credits. Best-effort: any shape failure leaves costs
   *  unknown (null) rather than blocking the dropdown. */
  private async warmCosts(): Promise<void> {
    const now = Date.now();
    if (this.costCache && now - this.costCache.at < FORM_TTL_MS) return;
    const costs = new Map<string, number>();
    try {
      const stdout = await this.json(["model", "cost"], 120_000);
      const items = parseJsonLooseArray(stdout) ?? [];
      const arr = items.length ? items : (() => {
        const obj = parseJsonLooseObject(stdout);
        if (!obj) return [];
        for (const key of ["items", "data", "models", "costs", "results"]) {
          const v = obj[key];
          if (Array.isArray(v)) return v;
        }
        return [];
      })();
      for (const e of arr) {
        if (!e || typeof e !== "object") continue;
        const rec = e as Record<string, unknown>;
        const id = String(rec.model ?? rec.id ?? rec.model_id ?? rec.name ?? "").trim();
        if (!id) continue;
        const raw = rec.totalCredits ?? rec.total_credits ?? rec.credits ?? rec.cost ?? rec.price;
        const n = typeof raw === "number" && Number.isFinite(raw) ? raw
          : typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw)) ? Number(raw) : null;
        if (n === null) continue;
        const prev = costs.get(id);
        if (prev === undefined || n < prev) costs.set(id, n);
      }
    } catch { /* costs stay unknown */ }
    this.costCache = { at: now, costs };
  }

  /** The signed-in OpenArt account's remaining credit balance, or null. */
  async getCredits(): Promise<number | null> {
    let stdout = "";
    try {
      stdout = await this.json(["account"]);
    } catch {
      return null;
    }
    const obj = parseJsonLooseObject(stdout);
    if (!obj) return null;
    const search = (o: Record<string, unknown>): number | null => {
      for (const key of ["credits", "balance", "remaining_credits", "available_credits"]) {
        const v = o[key];
        if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
      }
      for (const key of ["data", "account", "user"]) {
        const v = o[key];
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const n = search(v as Record<string, unknown>);
          if (n !== null) return n;
        }
      }
      return null;
    };
    return search(obj as Record<string, unknown>);
  }

  /** Turn a stored choice into the raw id to submit. "auto" (or empty)
   *  resolves to the first eligible model. A foreign (Higgsfield) or
   *  unknown explicit pick fails loudly instead of billing the wrong model. */
  private resolveModel(choice: string, models: OpenArtModelChoice[], video: boolean): string {
    const trimmed = (choice ?? "").trim();
    if (trimmed && (trimmed.startsWith("higgsfield:") || trimmed.startsWith("higgsfield-cli:"))) {
      throw new Error(`"${trimmed}" is a Higgsfield pick — switch the media provider to Higgsfield CLI to use it, or re-pick an OpenArt model.`);
    }
    const raw = trimmed.startsWith(OPENART_CLI_ID_PREFIX) ? trimmed.slice(OPENART_CLI_ID_PREFIX.length) : trimmed;
    if (raw && models.some((m) => openArtCliRawId(m.id) === raw)) return raw;
    if (raw && raw !== "auto" && models.length) {
      throw new Error(`"${raw}" isn't an OpenArt model (the active media provider is OpenArt CLI) — re-pick the model and retry; switching media providers can strand a stale pick.`);
    }
    const pool = video ? models.filter((m) => m.videoInput) : models.filter((m) => m.imageInput);
    return (pool.length ? pool : models)[0]?.id ?? "";
  }

  // ---- forms ------------------------------------------------------------------------

  /** A model's live form props for the given modes (first parsing mode
   *  wins). Null when no mode parses. Cached per model+mode-set. */
  private async formProps(modelId: string, modes: string[]): Promise<Record<string, unknown> | null> {
    const key = `${modelId}|${modes[0] ?? ""}`;
    const hit = this.formCache.get(key);
    if (hit && Date.now() - hit.at < FORM_TTL_MS) return hit.props;
    let props: Record<string, unknown> | null = null;
    for (const mode of modes) {
      try {
        const raw = await this.json(["model", "form", modelId, mode]);
        props = parseOpenArtFormProperties(raw);
        if (props) break;
        // Fallback: the CLI may print the bare schema (no jsonSchema wrapper).
        const obj = parseJsonLooseObject(raw);
        const bare = obj && typeof obj === "object"
          ? ((obj.properties && typeof obj.properties === "object"
              ? obj.properties as Record<string, unknown> : null) ?? null)
          : null;
        if (bare && Object.keys(bare).length) {
          props = bare;
          break;
        }
      } catch { /* try the next mode spelling */ }
    }
    this.formCache.set(key, { at: Date.now(), props });
    return props;
  }

  /** The resolution / length options a video model accepts. Null for
   *  foreign ids and when the form can't be read. */
  async videoModelOptions(modelId: string, withImage: boolean): Promise<VideoModelOptions | null> {
    const raw = openArtCliRawId(modelId);
    if (!raw || raw === "auto" || isForeignId(modelId)) return null;
    const props = await this.formProps(raw, withImage ? VIDEO_IMAGE_MODES : VIDEO_TEXT_MODES).catch(() => null);
    return props ? extractOpenArtVideoOptions(props) : null;
  }

  /** OpenArt declares no image quality tiers — always null (the caller
   *  hides the quality dropdown and the vendor default applies). */
  async imageModelOptions(_modelId: string): Promise<ImageModelOptions | null> {
    return null;
  }

  /** The full normalized option schema for a model (dev customizer probe).
   *  Tries every known form mode and takes the first that parses. */
  async modelOptions(modelId: string): Promise<CliModelSchema | null> {
    const raw = openArtCliRawId(modelId);
    if (!raw || raw === "auto" || isForeignId(modelId)) return null;
    const props = await this.formProps(raw, ALL_MODES).catch(() => null);
    return props ? openArtSchemaFromProps(raw, props) : null;
  }

  /** The CLI (v0.1.1) exposes no end-frame slot on any video model, so the
   *  probe is always empty — the caller unions it with the user's manual
   *  allowlist, and any tween submit through this transport fails loudly
   *  with an MCP redirect (see generateVideoClip). */
  async videoEndFrameModels(): Promise<string[]> {
    return [];
  }

  /** Warm the per-model form cache for every video-capable model.
   *  Fire-and-forget: the caller returns immediately so listing models
   *  never waits on form lookups. */
  prewarm(models: OpenArtModelChoice[]): void {
    for (const m of models) {
      if (!m.videoInput) continue;
      const raw = openArtCliRawId(m.id);
      if (!raw || raw === "auto") continue;
      void this.formProps(raw, VIDEO_IMAGE_MODES).catch(() => {});
    }
    void this.warmCosts().catch(() => {});
  }

  /** No project concept differences from MCP: generations route into the
   *  production-named OpenArt project when resolvable, else the account
   *  default (with an onNotice line, never silent). */
  async resolveProject(p: Production, onNotice?: (msg: string) => void): Promise<string | null> {
    const projectName = (p.meta.name || "").trim();
    if (!projectName) return null;
    const target = projectName.toLowerCase();
    try {
      const listOut = await this.json(["project", "list"]);
      const arr = parseJsonLooseArray(listOut) ?? [];
      const items = arr.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
      const match = items.find(
        (pr) => typeof pr.id === "string" && typeof pr.name === "string" &&
          (pr.name as string).trim().toLowerCase() === target
      );
      if (match) return match.id as string;
      const createdOut = await this.json(["project", "create", "--name", projectName]);
      const created = parseJsonLooseObject(createdOut);
      const id = created && typeof created.id === "string" ? created.id : null;
      if (!id) onNotice?.(`Couldn't read the id of the OpenArt project created for "${projectName}" — generating into the account's default project instead.`);
      return id;
    } catch (e) {
      onNotice?.(`Couldn't resolve the OpenArt project "${projectName}" (${e instanceof Error ? e.message : String(e)}) — generating into the account's default project.`);
      return null;
    }
  }

  // ---- submit + poll ------------------------------------------------------------------

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
   * Submit (`--async`) then rejoin (`creation wait`) and return the finished
   * asset bytes. Throws on FAILED/CANCELLED; throws OpenArtCliPendingError
   * past the deadline (image callers record the historyId as pending for a
   * later recheck; video callers surface it).
   */
  private async createAndWait(
    createArgs: string[],
    video: boolean,
    timeoutMs: number,
    onStatus?: (status: string) => void
  ): Promise<{ buf: Buffer; ext: string; historyId: string }> {
    const createOut = await this.cli(createArgs, 120_000);
    const historyId = extractHistoryId(createOut);
    if (!historyId) {
      throw new Error(
        `The OpenArt CLI returned no creation id (${createOut.slice(0, 200) || "empty reply"}) — the submission may not have gone through and no credits should have been spent.`
      );
    }
    const waitOut = await this.cli(
      ["creation", "wait", historyId, "--timeout", `${Math.max(30, Math.round(timeoutMs / 1000))}s`],
      timeoutMs + 60_000
    );
    const { status, failed } = openArtCreationStatus(waitOut);
    if (failed) throw new Error(`OpenArt generation ${status.toLowerCase() || "failed"} (${historyId.slice(0, 8)}…).`);
    if (status && !OPENART_JOB_DONE_RX.test(status)) {
      // No terminal status yet — one `creation get` before calling it pending.
      try {
        const getOut = await this.cli(["creation", "get", historyId], 60_000);
        const gs = openArtCreationStatus(getOut);
        if (gs.failed) throw new Error(`OpenArt generation ${gs.status.toLowerCase() || "failed"} (${historyId.slice(0, 8)}…).`);
        const urls = openArtCreationResultUrls(getOut, video);
        if (urls.length) {
          const buf = await this.fetchBytes(urls[0]);
          if (buf) return { buf, ext: OpenArtCliProvider.extOf(urls[0], video), historyId };
        }
      } catch (e) {
        if (e instanceof Error && /failed|cancel/i.test(e.message)) throw e;
      }
      throw new OpenArtCliPendingError(historyId);
    }
    if (status && onStatus) onStatus(status);
    const urls = openArtCreationResultUrls(waitOut, video);
    // A completed creation without a fetchable URL can still surface it in
    // plain text (non-JSON progress lines).
    if (!urls.length) {
      const direct = (video ? waitOut.match(VIDEO_URL_RX)?.[0] : waitOut.match(IMAGE_URL_RX)?.[0]);
      if (direct) urls.push(direct);
    }
    const url = urls[0];
    if (!url) throw new OpenArtCliPendingError(historyId);
    const buf = await this.fetchBytes(url);
    if (!buf) throw new Error(`Couldn't download the generated ${video ? "video" : "image"}.`);
    return { buf, ext: OpenArtCliProvider.extOf(url, video), historyId };
  }

  private static extOf(url: string, video: boolean): string {
    try {
      const ext = (path.extname(new URL(url).pathname) || (video ? ".mp4" : ".png")).replace(/^\./, "").toLowerCase();
      return ext || (video ? "mp4" : "png");
    } catch {
      return video ? "mp4" : "png";
    }
  }

  private static fileDataUrl(p: Production, rel: string, label: string): { name: string; dataUrl: string } {
    const buf = fs.readFileSync(assetPath(p, rel));
    const ext = (path.extname(rel).slice(1).toLowerCase() || "jpg").replace("jpeg", "jpg");
    const mime = ext === "jpg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    return { name: label, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
  }

  // ---- generation -----------------------------------------------------------------------

  /**
   * Resolve the Step 3 image generator, or null when the CLI binary doesn't
   * resolve. Mirrors the MCP imageGenFn contract (same ImageGenFn shape) so
   * pipeline callers never know which transport served the frame. Reference
   * art rides repeatable `--image` (image2image); aspect/resolution have no
   * CLI flags, so model defaults apply (logged per generation).
   */
  imageGenFn(
    p: Production,
    modelOverride?: string,
    resolutionOverride?: string,
    onNotice?: (msg: string) => void,
    aspectRatio: ImageGenAspectRatio = "16:9"
  ): ImageGenFn | null {
    if (!this.isAvailable()) return null;

    let projectId: string | null | undefined;

    return async (prompt: string, refs: { name: string; dataUrl: string }[], shot?: ProductionShot, _params?: Record<string, string | number | boolean | string[]>, onPending?: (rec: PendingImageGen) => void): Promise<Buffer> => {
      if (shot?.pendingImageGen) delete shot.pendingImageGen;

      let models: OpenArtModelChoice[] = [];
      try {
        models = await this.listModelChoices();
      } catch { models = []; }
      const cfgUsed: OpenArtBoardConfig = {
        ...(p.openArt ?? { model: "auto", resolution: "1k" }),
        ...(modelOverride ? { model: modelOverride } : {}),
        ...(resolutionOverride ? { resolution: resolutionOverride } as Partial<OpenArtBoardConfig> : {}),
      };
      const modelId = this.resolveModel(cfgUsed.model, refs.length ? models.filter((m) => m.imageInput) : models, false);
      if (!modelId) throw new Error("The OpenArt CLI listed no image models — sign in (`openart login`) and retry.");

      // Reference art (images only — the CLI has no video/image-edit input
      // on image generation beyond --image files).
      const imageRefs = refs.filter((r) => !/^data:video\//i.test(r.dataUrl));
      if (imageRefs.length < refs.length) {
        onNotice?.(`Skipping ${refs.length - imageRefs.length} video reference(s) — the OpenArt CLI only takes image files.`);
      }
      const { paths, cleanup } = writeCliTempRefs(imageRefs);
      const uploaded: (string | null)[] = [...paths];
      const fullPrompt = citePrompt(prompt, imageRefs, uploaded, styleRefNames(p));
      try {
        if (projectId === undefined) {
          projectId = await this.resolveProject(p, onNotice).catch(() => null);
        }
        const args = ["generate", "image", fullPrompt, "--model", modelId, "--async"];
        for (const f of paths) if (f) args.push("--image", f);
        if (projectId) args.push("--project", projectId);

        onNotice?.(
          `Submitting image job via ${modelId} (OpenArt CLI uses the model's default size and shape — the resolution/aspect dropdowns don't apply to this transport).`
        );

        const genMeta: LedgerGenMeta = {
          kind: "image",
          model: `${OPENART_CLI_ID_PREFIX}${modelId}`,
          resolution: cfgUsed.resolution,
          aspectRatio,
          at: Date.now(),
          productionId: p.meta.id,
          shotId: shot?.id,
        };
        let done: { buf: Buffer; ext: string; historyId: string };
        try {
          done = await this.createAndWait(args, false, IMAGE_WAIT_TIMEOUT_MS);
        } catch (e) {
          if (e instanceof OpenArtCliPendingError) {
            const rec: PendingImageGen = { historyId: e.historyId, prompt, model: `${OPENART_CLI_ID_PREFIX}${modelId}`, resolution: cfgUsed.resolution, aspectRatio, at: new Date().toISOString() };
            if (shot) shot.pendingImageGen = rec;
            onPending?.(rec);
          }
          throw e;
        }
        this.fireGeneration(genMeta);
        return done.buf;
      } finally {
        cleanup();
      }
    };
  }

  /**
   * Recheck a pending image job and return the finished bytes, or null when
   * it's still rendering (or the result URL still can't be fetched). Throws
   * when the job reports FAILED/CANCELLED (nothing left to reclaim).
   */
  async recheckPendingImage(rec: PendingImageGen): Promise<Buffer | null> {
    if (rec.historyId) {
      if (!this.isAvailable()) return null;
      let out = "";
      try {
        out = await this.cli(["creation", "get", rec.historyId], IMAGE_RECHECK_TIMEOUT_MS);
      } catch {
        return null;
      }
      const { failed, status } = openArtCreationStatus(out);
      if (failed) throw new Error(`OpenArt generation ${status.toLowerCase() || "failed"} (${rec.historyId.slice(0, 8)}…).`);
      const urls = openArtCreationResultUrls(out, false);
      if (!urls.length) {
        const direct = out.match(IMAGE_URL_RX)?.[0];
        if (!direct) return null;
        return this.fetchBytes(direct);
      }
      return this.fetchBytes(urls[0]);
    }
    if (rec.url) return this.fetchBytes(rec.url);
    return null;
  }

  /**
   * Generate one video clip for a shot: text2video, or single-start-frame
   * image2video via `--image`. The CLI exposes no end-frame slot and no
   * reference arrays, so tween end frames, extra image references, and video
   * references fail loudly with an MCP redirect instead of burning credits
   * on reference-less output.
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
    if (!this.isAvailable()) {
      throw new Error("The OpenArt CLI isn't installed (no `openart` binary found), so videos can't be generated through it.");
    }
    if (frameRefs?.end) {
      throw new Error(
        "The OpenArt CLI can't send an end frame — in-betweening needs the OpenArt MCP transport (or Higgsfield). Switch the media provider and retry."
      );
    }

    let models: OpenArtModelChoice[] = [];
    try {
      models = await this.listModelChoices();
    } catch { models = []; }

    // References: at most ONE image (the source frame). Anything more the
    // CLI cannot carry — fail loudly before spending credits.
    const refs: { name: string; dataUrl: string }[] = [];
    if (frameRefs) {
      refs.push(frameRefs.start);
    } else {
      const sourceRel = sourcePathOverride?.trim() || shot.artwork;
      if (!sourceRel) throw new Error("No source frame — pipe a frame into the video node or generate one first.");
      refs.push(OpenArtCliProvider.fileDataUrl(p, sourceRel, `Shot ${shot.number} frame`));
    }
    refs.push(...(extraRefs ?? []));
    const { resolved, extras } = resolvePromptRefs(p, opts.prompt, refs.length, true);
    refs.push(...extras);
    const videoRefs = refs.filter((r) => /^data:video\//i.test(r.dataUrl));
    if (videoRefs.length) {
      throw new Error(
        `The OpenArt CLI can't send video references (${videoRefs.map((r) => `"${r.name}"`).join(", ")}) — switch to the OpenArt MCP transport for reference-carrying video.`
      );
    }
    if (refs.length > 1) {
      throw new Error(
        `The OpenArt CLI video takes a single start-frame image, but ${refs.length} references were supplied (${refs.slice(1).map((r) => `"${r.name}"`).join(", ")} would be silently dropped) — switch to the OpenArt MCP transport for multi-reference video.`
      );
    }

    const modelId = this.resolveModel(opts.model, models, true);
    if (!modelId) throw new Error("The OpenArt CLI listed no video models — sign in (`openart login`) and retry.");

    // Fail loudly when the live form proves the model can't do the
    // requested length (mirrors the MCP transport — never coerce).
    const formProps = await this.formProps(modelId, refs.length ? VIDEO_IMAGE_MODES : VIDEO_TEXT_MODES).catch(() => null);
    if (formProps && Number.isFinite(opts.durationSec)) {
      const supported = extractOpenArtVideoOptions(formProps).durations;
      const want = Math.round(opts.durationSec);
      if (supported.length && !supported.includes(want)) {
        throw new Error(
          `"${modelId}" doesn't support a ${want}s clip (supports ${describeOpenArtDurations(supported)}) — retime the block or pick another model.`
        );
      }
    }

    const { paths, cleanup } = writeCliTempRefs(refs);
    const uploaded: (string | null)[] = [...paths];
    const fullPrompt = citePrompt(resolved, refs, uploaded, styleRefNames(p));
    try {
      const projectId = await this.resolveProject(p, (m) => emit(m)).catch(() => null);
      const args = ["generate", "video", fullPrompt, "--model", modelId, "--async"];
      if (paths[0]) args.push("--image", paths[0]);
      args.push("--duration", String(Math.round(opts.durationSec) || 5));
      if (opts.resolution) args.push("--resolution", opts.resolution);
      args.push("--aspect-ratio", "16:9");
      if (projectId) args.push("--project", projectId);

      emit(`Shot ${shot.number}: submitting video job via ${modelId} (OpenArt CLI)…`);
      const done = await this.createAndWait(args, true, VIDEO_WAIT_TIMEOUT_MS, (status) =>
        emit(`Shot ${shot.number}: video ${status.toLowerCase()}… still rendering.`, "info")
      );

      const safeExt = /^[a-z0-9]{2,4}$/i.test(done.ext) ? done.ext : "mp4";
      const rel = writeShotVideo(p, shot, done.buf, safeExt);

      this.fireGeneration({
        kind: "video",
        model: `${OPENART_CLI_ID_PREFIX}${modelId}`,
        resolution: opts.resolution || "",
        durationSec: Math.round(opts.durationSec) || 5,
        at: Date.now(),
        productionId: p.meta.id,
        shotId: shot.id,
      });

      return { rel };
    } finally {
      cleanup();
    }
  }
}

/** The CLI transport status for Settings (binary, version, auth). Read-only:
 *  `version` never needs auth; `account` proves the login. */
export interface OpenArtCliStatusInfo {
  binary: string | null;
  version: string | null;
  authenticated: boolean;
  account: string | null;
}

export async function getOpenArtCliStatus(binary: string | null, run?: CliRun): Promise<OpenArtCliStatusInfo> {
  if (!binary) return { binary: null, version: null, authenticated: false, account: null };
  const runCli = run ?? defaultCliRun(binary);
  let version: string | null = null;
  try {
    const v = await runCli(["version"], { timeoutMs: 15_000 });
    if (v.code === 0) version = v.stdout.trim().split(/\r?\n/)[0]?.slice(0, 120) || null;
  } catch { /* leave null */ }
  try {
    const a = await runCli(["account", "--json"], { timeoutMs: 30_000 });
    if (a.code === 0) {
      const obj = parseJsonLooseObject(a.stdout);
      const account = obj
        ? String(
            (obj as Record<string, unknown>).email ??
            (obj as Record<string, unknown>).account ??
            (obj as Record<string, unknown>).user ?? ""
          ).trim() || null
        : null;
      return { binary, version, authenticated: true, account };
    }
  } catch { /* not authenticated */ }
  return { binary, version, authenticated: false, account: null };
}
