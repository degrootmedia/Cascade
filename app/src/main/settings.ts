/**
 * Settings persistence. The API key is encrypted with Electron safeStorage
 * (OS keychain-backed) and stored base64-encoded; it is never written in
 * plain text and never sent to the renderer. Keys and models are stored per
 * LLM API provider (see shared/providers.ts) — switching providers in
 * Settings keeps each one's key and model choice intact.
 */
import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProvider } from "../shared/providers.js";
import { normalizeModelSurfaces, resolveAspectRatio, type ModelParamDefaultValue, type ModelSurface } from "../shared/ipc.js";

interface SettingsFile {
  /** Selected LLM API provider id (see shared/providers.ts). */
  provider: string;
  /** base64-encrypted API keys, one per provider id. */
  encryptedApiKeys: Record<string, string>;
  /** Last chosen model per provider id. */
  models: Record<string, string>;
  /**
   * Cheap background model per provider id (compaction, chat titles),
   * auto-recorded from each models:list response as the cheapest usable
   * model. Falls back to the selected model when unknown.
   */
  helpers: Record<string, string>;
  workspace: string | null;
  /** Most recently used folders, most-recent first. */
  recentWorkspaces: string[];
  /** Most recently opened production folders, most-recent first (max 10). */
  recentProductions: string[];
  /**
   * MCP server names whose tools are attached only on user request (not sent
   * in the default model payload). OpenArt defaults to on-demand because its
   * schema set is large and rarely needed.
   */
  mcpOnDemand: string[];
  /** Which MCP vendor serves image/video generation (global setting). */
  mediaProvider: string;
  /** Custom path to the `higgsfield` CLI binary (null = resolve from PATH). */
  higgsfieldCliBinary: string | null;
  /** Custom path to the `openart` CLI binary (null = resolve from PATH). */
  openartCliBinary: string | null;
  /** Dollar value of one Higgsfield credit for the Expenses total (null =
   *  unset — credit rows show their credits and contribute $0 until set).
   *  Edited in the dev Model Customizer; saving re-prices history. */
  higgsfieldCreditUsd: number | null;
  /** UI accent color (hex), applied to the --accent CSS variable. */
  accent: string;
  /** Absolute path to the external image editor executable (e.g. Photoshop). */
  externalEditor: string | null;
  /** base64-encrypted 3D AI Studio API key (separate from the LLM keys). */
  encrypted3daiApiKey: string | null;
  /**
   * Media model ids the user hides from the generation model dropdowns
   * (Settings → Models & expenses toggles). Filtered main-side so every
   * dropdown — boards, video modal, node graph, tween, references — excludes
   * them without the renderer knowing the list.
   */
  hiddenMediaModels: string[];
  /**
   * Manual per-model kind assignments from the Models & expenses
   * drag-and-drop (model id → "image" | "video"). Applied main-side to the
   * model choices so every generation dropdown respects the user's
   * classification over the provider's auto-detected flags.
   */
  modelKindOverrides: Record<string, "image" | "video">;
  /**
   * Per-generation-dropdown remembered last choices (see MediaDefaultCtx in
   * shared/ipc.ts): each model dropdown starts where the user last left it,
   * globally across productions. Written by every dropdown's onChange.
   */
  mediaDefaults: Record<string, MediaDefaultChoice>;
  /**
   * The user's preferred media model arrangement (Settings → Models &
   * expenses drag-to-reorder). Sorted into every generation dropdown
   * main-side; models missing from the list keep discovery order after it.
   */
  mediaModelOrder: string[];
  /**
   * Per-parameter placement from the dev Model Customizer, keyed by
   * `<namespaced model id>::<flag>` → core/advanced/hidden. Applied main-side
   * to `production:modelOptions` so every options form follows it. Dedicated
   * (owned) flags are never overridable. Absent = the schema's default group.
   */
  modelOptionExposure: Record<string, "core" | "advanced" | "hidden">;
  /**
   * Per-model surface assignments from the dev Model Customizer: which
   * pickers (master image picker, generate/edit nodes, video modal, tween,
   * edit-video node, …) offer a model. Absent/empty = every applicable
   * surface (the default).
   */
  modelSurfaces: Record<string, ModelSurface[]>;
  /**
   * Per-surface parameter defaults from the dev Model Customizer, keyed by
   * `<namespaced model id>::<surface>::<flag>` → value. Seeded into a surface's
   * params when that model loads (the user's saved per-shot/per-node value
   * always wins). Absent = no default (the vendor's own default applies).
   */
  modelParamDefaults: Record<string, ModelParamDefaultValue>;
  /** Dev Mode: when true, every generation submission is logged. */
  devMode: boolean;
  /** Credit-free dry run: build + log the real request, throw before vendor call. */
  submissionDryRun: boolean;
  /** Last main-window bounds + maximized flag, restored on launch. */
  windowState: WindowState | null;
}

/** A dropdown context's remembered last choice (see shared/ipc.ts). */
interface MediaDefaultChoice {
  model?: string;
  resolution?: string;
  durationSec?: number;
  aspectRatio?: string;
}

/** Persisted main-window geometry. x/y are null when never positioned. */
export interface WindowState {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  isMaximized: boolean;
}

const DEFAULTS: SettingsFile = {
  provider: "gab",
  encryptedApiKeys: {},
  models: {},
  helpers: {},
  workspace: null,
  recentWorkspaces: [],
  recentProductions: [],
  mcpOnDemand: ["openart"],
  mediaProvider: "openart",
  higgsfieldCliBinary: null,
  openartCliBinary: null,
  higgsfieldCreditUsd: null,
  accent: "#4f8ef7",
  externalEditor: null,
  encrypted3daiApiKey: null,
  hiddenMediaModels: [],
  modelKindOverrides: {},
  mediaDefaults: {},
  mediaModelOrder: [],
  modelOptionExposure: {},
  modelSurfaces: {},
  modelParamDefaults: {},
  devMode: false,
  submissionDryRun: false,
  windowState: null,
};
const MAX_RECENT_WORKSPACES = 10;
const MAX_RECENT_PRODUCTIONS = 10;

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

let cache: SettingsFile | null = null;

function load(): SettingsFile {
  if (cache) return cache;
  let s: SettingsFile = { ...DEFAULTS };
  try {
    s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
  } catch {
    // no settings file yet — use defaults
  }
  // Migration from pre-provider settings: a single key + model belonged to gab.
  const legacy = s as unknown as { encryptedApiKey?: string; model?: string };
  if (legacy.encryptedApiKey && !s.encryptedApiKeys["gab"]) {
    s.encryptedApiKeys["gab"] = legacy.encryptedApiKey;
  }
  if (legacy.model && !s.models["gab"]) {
    s.models["gab"] = legacy.model;
  }
  delete legacy.encryptedApiKey;
  delete legacy.model;
  if (!getProvider(s.provider)) s.provider = "gab";
  // Higgsfield MCP transport removed — the CLI is the successor. Drop the
  // server name from the on-demand list and migrate a stored `higgsfield`
  // global pick to `higgsfield-cli` so existing profiles keep generating.
  if (s.mcpOnDemand.includes("higgsfield")) s.mcpOnDemand = s.mcpOnDemand.filter((n) => n !== "higgsfield");
  if ((s.mediaProvider as string) === "higgsfield") s.mediaProvider = "higgsfield-cli";
  if (s.mediaProvider !== "higgsfield-cli" && s.mediaProvider !== "openart-cli" && s.mediaProvider !== "openart") s.mediaProvider = "openart";
  // Prune orphaned `higgsfield:*` per-model keys (MCP-namespaced ids no
  // longer list); `higgsfield-cli:` rows are untouched. Media-default model
  // values with the legacy prefix are rewritten to the CLI prefix so
  // dropdown seeding survives (the CLI also accepts the old prefix).
  if (Array.isArray(s.hiddenMediaModels) && s.hiddenMediaModels.some((id) => typeof id === "string" && id.startsWith("higgsfield:"))) {
    s.hiddenMediaModels = s.hiddenMediaModels.filter((id) => typeof id === "string" && !id.startsWith("higgsfield:"));
  }
  if (s.modelKindOverrides) {
    for (const id of Object.keys(s.modelKindOverrides)) {
      if (id.startsWith("higgsfield:")) delete s.modelKindOverrides[id];
    }
  }
  if (Array.isArray(s.mediaModelOrder) && s.mediaModelOrder.some((id) => typeof id === "string" && id.startsWith("higgsfield:"))) {
    s.mediaModelOrder = s.mediaModelOrder.filter((id) => typeof id === "string" && !id.startsWith("higgsfield:"));
  }
  if (s.modelOptionExposure) {
    for (const k of Object.keys(s.modelOptionExposure)) {
      if (k.startsWith("higgsfield:")) delete s.modelOptionExposure[k];
    }
  }
  if (s.modelSurfaces) {
    for (const id of Object.keys(s.modelSurfaces)) {
      if (id.startsWith("higgsfield:")) delete (s.modelSurfaces as Record<string, unknown>)[id];
    }
  }
  if (s.modelParamDefaults) {
    for (const k of Object.keys(s.modelParamDefaults)) {
      if (k.startsWith("higgsfield:")) delete s.modelParamDefaults[k];
    }
  }
  if (s.mediaDefaults) {
    for (const ctx of Object.keys(s.mediaDefaults)) {
      const m = (s.mediaDefaults as Record<string, { model?: unknown }>)[ctx]?.model;
      if (typeof m === "string" && m.startsWith("higgsfield:")) {
        (s.mediaDefaults as Record<string, { model?: string }>)[ctx].model = `higgsfield-cli:${m.slice("higgsfield:".length)}`;
      }
    }
  }
  cache = s;
  return cache!;
}

function save(): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(load(), null, 2), "utf8");
}

function currentProvider(): string {
  const p = load().provider;
  return getProvider(p) ? p : "gab";
}

/** Base URL of the selected provider (e.g. "https://gab.ai/v1"). */
export function getBaseUrl(): string {
  return getProvider(currentProvider())?.baseUrl ?? "";
}

export function getProviderId(): string {
  return currentProvider();
}

export function setProvider(id: string): void {
  if (!getProvider(id)) return;
  load().provider = id;
  save();
}

export function getApiKey(provider?: string): string | null {
  const s = load();
  const enc = s.encryptedApiKeys[provider ?? currentProvider()];
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    return null;
  }
}

export function hasApiKey(provider?: string): boolean {
  return getApiKey(provider) !== null;
}

export function setApiKey(key: string, provider?: string): void {
  const s = load();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS encryption unavailable; refusing to store API key in plain text");
  }
  s.encryptedApiKeys[provider ?? currentProvider()] = safeStorage.encryptString(key).toString("base64");
  save();
}

export function getModel(provider?: string): string {
  const s = load();
  const id = provider ?? currentProvider();
  const model = s.models[id];
  if (model) return model;
  return getProvider(id)?.defaultModel ?? "";
}

export function setModel(model: string, provider?: string): void {
  load().models[provider ?? currentProvider()] = model;
  save();
}

/**
 * Cheap background model for the provider (compaction, chat titles): the
 * auto-recorded cheapest usable model, falling back to the selected model.
 */
export function getHelperModel(provider?: string): string {
  const id = provider ?? currentProvider();
  return load().helpers?.[id] || getModel(id);
}

/** Record the provider's background model (called from models:list). */
export function setHelperModel(model: string, provider?: string): void {
  if (!model) return;
  load().helpers[provider ?? currentProvider()] = model;
  save();
}

export function getWorkspace(): string | null {
  return load().workspace;
}

export function setWorkspace(dir: string | null): void {
  load().workspace = dir;
  save();
}

/** Most recently used folders, most-recent first (deduped, capped). */
export function getRecentWorkspaces(): string[] {
  return load().recentWorkspaces ?? [];
}

/** Push a folder onto the recent list. Called whenever a folder is used. */
export function addRecentWorkspace(dir: string): void {
  const s = load();
  const rest = (s.recentWorkspaces ?? []).filter((p) => p !== dir);
  s.recentWorkspaces = [dir, ...rest].slice(0, MAX_RECENT_WORKSPACES);
  save();
}

/** Production folders MRU (last 10), most-recent first. */
export function getRecentProductions(): string[] {
  return load().recentProductions ?? [];
}

/** Push a production folder onto the production MRU list. */
export function addRecentProduction(dir: string): void {
  const s = load();
  const rest = (s.recentProductions ?? []).filter((p) => p !== dir);
  s.recentProductions = [dir, ...rest].slice(0, MAX_RECENT_PRODUCTIONS);
  save();
}

/** MCP server names whose tools attach only on user request. */
export function getMcpOnDemand(): string[] {
  return load().mcpOnDemand ?? [];
}

export function setMcpOnDemand(names: string[]): void {
  load().mcpOnDemand = names;
  save();
}

/** Which vendor serves image/video generation ("openart" default). */
export function getMediaProvider(): string {
  const v = load().mediaProvider;
  // Legacy `higgsfield` (MCP, removed) reads as its CLI successor.
  if (v === "higgsfield") return "higgsfield-cli";
  return v === "higgsfield-cli" || v === "openart-cli" ? v : "openart";
}

export function setMediaProvider(id: string): void {
  // Accept legacy `higgsfield` writes as the CLI successor.
  const norm = id === "higgsfield" ? "higgsfield-cli" : id;
  load().mediaProvider = norm === "higgsfield-cli" || norm === "openart-cli" ? norm : "openart";
  save();
}

/** Custom path to the `higgsfield` CLI binary, or null to resolve from PATH. */
export function getHiggsfieldCliBinary(): string | null {
  const v = load().higgsfieldCliBinary;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function setHiggsfieldCliBinary(p: string | null): void {
  load().higgsfieldCliBinary = typeof p === "string" && p.trim() ? p.trim() : null;
  save();
}

/** Custom path to the `openart` CLI binary, or null to resolve from PATH. */
export function getOpenArtCliBinary(): string | null {
  const v = load().openartCliBinary;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function setOpenArtCliBinary(p: string | null): void {
  load().openartCliBinary = typeof p === "string" && p.trim() ? p.trim() : null;
  save();
}

/** Dollar value of one Higgsfield credit (Expenses total), or null when unset. */
export function getHiggsfieldCreditUsd(): number | null {
  const v = load().higgsfieldCreditUsd;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Set (or clear, with null) the Higgsfield credit value. Returns normalized. */
export function setHiggsfieldCreditUsd(v: number | null): number | null {
  const next = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  load().higgsfieldCreditUsd = next;
  save();
  return next;
}

/** UI accent color (hex string). */
export function getAccent(): string {
  return load().accent ?? DEFAULTS.accent;
}

export function setAccent(color: string): void {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return; // hex only — it's injected into CSS
  load().accent = color;
  save();
}

export function getExternalEditor(): string | null {
  return load().externalEditor ?? null;
}

export function setExternalEditor(p: string | null): void {
  const next = typeof p === "string" && p.trim() ? p.trim() : null;
  load().externalEditor = next;
  save();
}

/** The 3D AI Studio API key (decrypted), or null when not set. */
export function get3daiApiKey(): string | null {
  const enc = load().encrypted3daiApiKey;
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    return null;
  }
}

export function has3daiApiKey(): boolean {
  return get3daiApiKey() !== null;
}

export function set3daiApiKey(key: string): void {
  const s = load();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS encryption unavailable; refusing to store API key in plain text");
  }
  s.encrypted3daiApiKey = key ? safeStorage.encryptString(key).toString("base64") : null;
  save();
}

/** Media model ids hidden from the generation dropdowns (see hiddenMediaModels). */
export function getHiddenMediaModels(): string[] {
  return load().hiddenMediaModels ?? [];
}

export function setHiddenMediaModels(ids: string[]): void {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
  }
  load().hiddenMediaModels = clean.slice(0, 500);
  save();
}

/** Manual model kind assignments (see modelKindOverrides). */
export function getModelKindOverrides(): Record<string, "image" | "video"> {
  return load().modelKindOverrides ?? {};
}

export function setModelKindOverrides(overrides: Record<string, unknown>): void {
  const clean: Record<string, "image" | "video"> = {};
  for (const [rawId, rawKind] of Object.entries(overrides ?? {})) {
    const id = String(rawId ?? "").trim();
    if (!id) continue;
    if (rawKind !== "image" && rawKind !== "video") continue;
    if (Object.keys(clean).length >= 500) break;
    clean[id] = rawKind;
  }
  load().modelKindOverrides = clean;
  save();
}

/** The dropdowns' remembered last choices (see mediaDefaults). Aspect ratio
 *  is normalized to the shared 16:9 default so every surface seeds 16:9 even
 *  when the remembered choice is absent or empty. */
export function getMediaDefaults(): Record<string, MediaDefaultChoice> {
  const raw = load().mediaDefaults ?? {};
  const out: Record<string, MediaDefaultChoice> = {};
  for (const [ctx, choice] of Object.entries(raw)) {
    out[ctx] = { ...choice, aspectRatio: resolveAspectRatio(choice?.aspectRatio) };
  }
  return out;
}

const MEDIA_DEFAULT_CTXS = new Set(["image", "video", "edit", "reference", "character", "tween"]);

/** Merge a patch into one dropdown context's remembered choice. Only the six
 *  known contexts are accepted; unknown fields are dropped so a hand-edited
 *  settings.json can't smuggle junk into the renderer. */
export function setMediaDefault(ctx: string, patch: MediaDefaultChoice): void {
  if (!MEDIA_DEFAULT_CTXS.has(ctx) || typeof patch !== "object" || patch === null) return;
  const s = load();
  const cur = s.mediaDefaults?.[ctx] ?? {};
  const next: MediaDefaultChoice = { ...cur };
  if (typeof patch.model === "string") next.model = patch.model;
  if (typeof patch.resolution === "string") next.resolution = patch.resolution;
  if (typeof patch.durationSec === "number" && Number.isFinite(patch.durationSec)) next.durationSec = patch.durationSec;
  if (typeof patch.aspectRatio === "string") next.aspectRatio = patch.aspectRatio;
  s.mediaDefaults = { ...(s.mediaDefaults ?? {}), [ctx]: next };
  save();
}

/** The user's saved media model arrangement (see mediaModelOrder). */
export function getMediaModelOrder(): string[] {
  return load().mediaModelOrder ?? [];
}
export function setMediaModelOrder(ids: string[]): void {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
  }
  load().mediaModelOrder = clean.slice(0, 500);
  save();
}

/** Per-parameter placement from the dev Model Customizer (see
 *  modelOptionExposure). Key: `<namespaced model id>::<flag>`. */
export function getModelOptionExposure(): Record<string, "core" | "advanced" | "hidden"> {
  return load().modelOptionExposure ?? {};
}

/** Set (or clear, with null) one parameter's placement. */
export function setModelOptionExposure(key: string, placement: "core" | "advanced" | "hidden" | null): void {
  const k = typeof key === "string" ? key.trim() : "";
  if (!k || k.length > 512 || k.includes("\0")) return;
  const map = { ...(load().modelOptionExposure ?? {}) };
  if (placement === null) delete map[k];
  else if (placement === "core" || placement === "advanced" || placement === "hidden") map[k] = placement;
  else return;
  load().modelOptionExposure = map;
  save();
}

/** Clear every parameter placement (dev customizer "Reset"). */
export function resetModelOptionExposure(): void {
  load().modelOptionExposure = {};
  save();
}

/** Per-model surface assignments (see modelSurfaces). Legacy surface keys are
 *  migrated to the collapsed pool keys on read, so an old stored map keeps
 *  working without a destructive rewrite. */
export function getModelSurfaces(): Record<string, ModelSurface[]> {
  const raw = load().modelSurfaces ?? {};
  const out: Record<string, ModelSurface[]> = {};
  for (const [id, list] of Object.entries(raw)) {
    const surfaces = normalizeModelSurfaces(list);
    if (surfaces.length) out[id] = surfaces;
  }
  return out;
}

/** Replace the whole surface map (dev customizer writes it wholesale). */
export function setModelSurfaces(map: Record<string, unknown>): void {
  const clean: Record<string, ModelSurface[]> = {};
  if (map && typeof map === "object") {
    for (const [id, list] of Object.entries(map)) {
      if (typeof id !== "string" || !id || id.length > 512 || id.includes("\0")) continue;
      const surfaces = normalizeModelSurfaces(list);
      if (surfaces.length) clean[id] = surfaces;
    }
  }
  load().modelSurfaces = clean;
  save();
}

/** Clear every surface assignment (dev customizer "Reset"). */
export function resetModelSurfaces(): void {
  load().modelSurfaces = {};
  save();
}

/** Coerce a raw default to one of the scalar shapes the options form edits.
 *  Empty/blank values (and unrecognized shapes) clear the default. */
function sanitizeParamDefault(value: unknown): ModelParamDefaultValue | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t ? t : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map((v) => String(v)).filter((s) => s.length > 0).slice(0, 200);
    return items.length ? items : null;
  }
  return null;
}

/** Per-surface parameter defaults (see modelParamDefaults). */
export function getModelParamDefaults(): Record<string, ModelParamDefaultValue> {
  return load().modelParamDefaults ?? {};
}

/** Set (or clear, with null/blank) one `<model>::<surface>::<flag>` default. */
export function setModelParamDefault(key: string, value: ModelParamDefaultValue | null): void {
  const k = typeof key === "string" ? key.trim() : "";
  if (!k || k.length > 512 || k.includes("\0")) return;
  const map = { ...(load().modelParamDefaults ?? {}) };
  const clean = value === null ? null : sanitizeParamDefault(value);
  if (clean === null) delete map[k];
  else if (k in map || Object.keys(map).length < 5000) map[k] = clean;
  load().modelParamDefaults = map;
  save();
}

/** Clear every parameter default (dev customizer "Reset"). */
export function resetModelParamDefaults(): void {
  load().modelParamDefaults = {};
  save();
}

/** Dev Mode: verbose human-readable submission logging (see submission-log). */
export function getDevMode(): boolean {
  return load().devMode === true;
}

export function setDevMode(v: boolean): void {
  load().devMode = v === true;
  save();
}

/** Credit-free dry run: build + log the request, throw DryRunError before spend. */
export function getSubmissionDryRun(): boolean {
  return load().submissionDryRun === true;
}

export function setSubmissionDryRun(v: boolean): void {
  load().submissionDryRun = v === true;
  save();
}

/** Last saved main-window geometry, or null on first run. Validates shape
 *  so a hand-edited settings.json can't create an unsized window. */
export function getWindowState(): WindowState | null {
  const w = load().windowState;
  if (!w || typeof w !== "object") return null;
  const width = Math.floor(Number(w.width));
  const height = Math.floor(Number(w.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 720 || height < 500 || width > 7680 || height > 4320) return null;
  const x = w.x === null || w.x === undefined ? null : Math.floor(Number(w.x));
  const y = w.y === null || w.y === undefined ? null : Math.floor(Number(w.y));
  return {
    x: x !== null && Number.isFinite(x) ? x : null,
    y: y !== null && Number.isFinite(y) ? y : null,
    width,
    height,
    isMaximized: w.isMaximized === true,
  };
}

export function setWindowState(state: WindowState): void {
  load().windowState = { ...state };
  save();
}