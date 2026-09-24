/**
 * HiggsfieldCliProvider — the official `higgsfield` CLI binary's
 * MediaProvider adapter (https://github.com/higgsfield-ai/cli, `higgsfield`
 * / `higgs` / `hf`; also distributed as npm `@higgsfield/cli`).
 *
 * Command mapping (probed from CLI v1.1.24 `--help` + MODELS.md + the
 * official higgsfield-generate skill):
 * - catalog:  `model list --image/--video --json` →  model items (job_type
 *               ids are the SAME raw ids the Higgsfield MCP catalog uses)
 * - detail:   `model get <job_type> --json` →  `{aspect_ratios, durations,
 *               parameters, medias}` (same vocabulary as the MCP
 *               models_explore detail: parameters with options/min/max,
 *               medias with roles)
 * - submit:   `generate create <job_type> --prompt … [--start-image …]
 *               [--end-image …] [--image-references …] [--video-references …]
 *               [--duration N] [--resolution …] [--aspect_ratio …] --json`
 *               (no --wait) →  job id(s)
 * - poll:     `generate wait <id> --timeout … --interval … --json` →  final
 *               job object(s) with result URLs; `generate get <id> --json`
 *               for rechecks
 * - credits:  `account status --json`
 *
 * Feature notes vs the MCP adapter: end frames ride `--end-image`
 * (in-betweener fully supported on seedance/kling/cinematic-studio/…);
 * extra image/video refs ride repeatable `--image-references` /
 * `--video-references`; `seedance_2_5` needs `--mode omni_reference`
 * whenever media is attached (its `t2v` mode accepts none). There is no
 * project concept (resolveProject returns null, like the MCP adapter).
 *
 * The subprocess is injected via the constructor — the seam. A fake `run`
 * substitutes for the live binary in tests, so the module's interface IS
 * the test surface. This module never imports the MCP manager or Electron.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultCliRun,
  resolveCliOnPath,
  writeCliTempRefs,
  type CliRun,
  type CliRunResult,
} from "./cli-run.js";
import { assetPath, writeShotVideo, type ImageGenFn } from "../pipeline.js";
import {
  dataUrlToBytes,
  IMAGE_URL_RX,
  parseJsonLooseArray,
  parseJsonLooseObject,
  VIDEO_URL_RX,
} from "../../shared/prompt-grammar.js";
import {
  resolveAspectRatio,
  type CliModelSchema,
  type CliOptionField,
  type ImageGenAspectRatio,
  type ImageModelOptions,
  type GenerationCostRequest,
  type LedgerGenMeta,
  type ModelParamOption,
  type OpenArtBoardConfig,
  type OpenArtModelChoice,
  type PendingImageGen,
  type PendingVideoGen,
  type Production,
  type ProductionShot,
  type VideoGenOptions,
  type VideoModelOptions,
} from "../../shared/ipc.js";
import type { GenerationRecorder, MediaProvider, ProviderEmit } from "./types.js";
import { citePrompt, resolvePromptRefs, styleRefNames } from "./refs.js";
import { resizeVideoRef } from "../video-ref.js";
import { buildModelSchema, OWNED_FLAGS, type RawModelParam } from "./model-schema.js";
import { imagePixelSize } from "./image-size.js";

/** Prefix marking model ids that belong to this provider (see types.ts).
 *  The raw id is the CLI job_type (`seedance_2_5`); the legacy MCP prefix
 *  `higgsfield:` is accepted as an alias (same vendor id space) so saved
 *  MCP-era picks keep submitting. */
export const HIGGSFIELD_CLI_ID_PREFIX = "higgsfield-cli:";

/** Strip the CLI prefix; foreign ids come back unchanged. */
export function higgsfieldCliRawId(modelId: string): string {
  return modelId.startsWith(HIGGSFIELD_CLI_ID_PREFIX)
    ? modelId.slice(HIGGSFIELD_CLI_ID_PREFIX.length)
    : modelId;
}

/** Raw job_type for an id this transport serves: strips our prefix, the
 *  legacy MCP transport's `higgsfield:` prefix (same vendor id space, removed),
 *  or nothing for unprefixed picks. Anything else namespaced is foreign. */
function rawJobType(modelId: string): string {
  const t = modelId.trim();
  if (t.startsWith(HIGGSFIELD_CLI_ID_PREFIX)) return t.slice(HIGGSFIELD_CLI_ID_PREFIX.length);
  if (t.startsWith("higgsfield:")) return t.slice("higgsfield:".length);
  return t;
}

/** True when the id names a foreign provider (an explicit namespace that is
 *  neither this transport's nor the legacy MCP `higgsfield:` alias). */
function isForeignId(modelId: string): boolean {
  const t = modelId.trim();
  return t.includes(":") && !t.startsWith(HIGGSFIELD_CLI_ID_PREFIX) && !t.startsWith("higgsfield:");
}

/** House defaults, preferred when present in the catalog (verified live
 *  2026-09-11; the official skill recommends the same pair). */
const DEFAULT_IMAGE_MODEL = "gpt_image_2_5";
const DEFAULT_VIDEO_MODEL = "seedance_2_5";

const CATALOG_TTL_MS = 10 * 60_000;
/** Schema-cache TTL (10 min) + cap; last-good schemas survive past expiry. */
const SCHEMA_TTL_MS = 10 * 60_000;
const SCHEMA_CACHE_CAP = 64;
/** Cost-quote cache TTL (5 min) + cap. Quotes price the live catalog, so a
 *  shorter TTL than options; failures are cached too (briefly) so a bad
 *  config can't hammer the CLI on every keystroke. */
const COST_TTL_MS = 5 * 60_000;
const COST_CACHE_CAP = 64;
/** Placeholder prompt for cost preflights. Verified live (2026-09-16):
 *  prompt text never moves the price, but the flag is required — the real
 *  prompt never travels, and the first probe sends no media flags (zero
 *  uploads in the common case; refs don't move the price either —
 *  seedance_2_5 5s/720p quotes 32.5 with and without a start frame). A
 *  media-requiring `mode` falls back to a placeholder start frame (see
 *  `costProbe`). */
const COST_PROBE_PROMPT = "cost probe";
/** 1×1 transparent PNG used only as a fallback cost-probe start frame: a
 *  media-requiring `mode` (`omni_reference`, `image-to-video`, …) can't be
 *  priced without a media item, but the real submit always carries the source
 *  frame. References don't move the price, so the retry prices the same
 *  config instead of hiding the quote. */
const COST_PROBE_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
/** A cost-probe rejection caused by missing media (a media-requiring `mode`
 *  or a required start frame) — the one case the placeholder retry can fix. */
const COST_MEDIA_REJECT_RX = /media|reference|start[_-]?image|end[_-]?image/i;
const IMAGE_WAIT_TIMEOUT_MS = 150_000;
const IMAGE_RECHECK_TIMEOUT_MS = 60_000;
const VIDEO_WAIT_TIMEOUT_MS = 20 * 60_000;
const VIDEO_RECHECK_TIMEOUT_MS = 60_000;
const WAIT_INTERVAL_S = 5;

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- subprocess seam ---------------------------------------------------------

export type { CliRun, CliRunResult };

/** True when the path is directly spawnable shell-free. On Windows that
 *  means a real PE binary (MZ header): `.cmd`/`.bat`/`.ps1` shims and the
 *  extensionless `#!` shell scripts npm drops in `.bin` are not. On posix
 *  any file spawns (shebang/ELF handled by the OS). */
function isRealExecutable(p: string): boolean {
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return false;
  } catch {
    return false;
  }
  const lower = p.toLowerCase();
  // Windows launcher shims never spawn shell-free, on any platform.
  if (lower.endsWith(".cmd") || lower.endsWith(".bat") || lower.endsWith(".ps1")) return false;
  if (process.platform !== "win32") return true;
  if (lower.endsWith(".exe")) return true;
  try {
    const fd = fs.openSync(p, "r");
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    return head[0] === 0x4d && head[1] === 0x5a;
  } catch {
    return false;
  }
}

/** The npm layout's real binary for a shim: local installs keep shims in
 *  `<prefix>/node_modules/.bin` (vendor at `<prefix>/node_modules/...`),
 *  global installs keep them directly in `<prefix>` (vendor at
 *  `<prefix>/node_modules/...`). Returns null when neither matches. */
function npmVendorBinary(fromDir: string): string | null {
  const bin = process.platform === "win32" ? "hf.exe" : "hf";
  const cands = [
    path.join(fromDir, "..", "@higgsfield", "cli", "vendor", bin),
    path.join(fromDir, "node_modules", "@higgsfield", "cli", "vendor", bin),
  ];
  for (const vendor of cands) {
    try {
      if (fs.existsSync(vendor) && fs.statSync(vendor).isFile()) return vendor;
    } catch { /* try the next layout */ }
  }
  return null;
}

/** Map a launcher shim to the real executable, or pass a real file through.
 *  Returns null when there is nothing spawnable — the caller then reports
 *  "not installed" instead of a cryptic spawn failure. */
function resolveRealBinary(p: string): string | null {
  if (isRealExecutable(p)) return p;
  return npmVendorBinary(path.dirname(p));
}

/** Resolve the `higgsfield` binary: an explicit custom path first, then the
 *  `higgsfield` / `higgs` / `hf` names on PATH (npm `.cmd` shims resolve to
 *  their vendor binary). Null when nothing spawnable resolves. */
export async function resolveHiggsfieldCliBinary(customPath?: string | null): Promise<string | null> {
  const custom = typeof customPath === "string" ? customPath.trim() : "";
  if (custom) return resolveRealBinary(custom);
  for (const name of ["higgsfield", "higgs", "hf"]) {
    try {
      const found = await resolveCliOnPath([name]);
      if (!found) continue;
      const real = resolveRealBinary(found);
      if (real) return real;
    } catch { /* try the next name */ }
  }
  return null;
}

// ---- loose CLI JSON ------------------------------------------------------------

/** One `model list --json` entry (exact keys vary; every accessor below
 *  probes the known spellings). */
type CliListItem = Record<string, unknown>;

/** Collect list items out of a `model list --json` reply: a bare array, an
 *  `{items|data|models|list|results}` envelope, or a `{id: {...}}` map. */
function parseCliList(stdout: string): CliListItem[] {
  const arr = parseJsonLooseArray(stdout);
  if (arr) return arr.filter((m) => m && typeof m === "object") as CliListItem[];
  const obj = parseJsonLooseObject(stdout);
  if (obj) {
    for (const key of ["items", "data", "models", "list", "results"]) {
      const v = obj[key];
      if (Array.isArray(v)) return v.filter((m) => m && typeof m === "object") as CliListItem[];
    }
    const vals = Object.values(obj);
    if (vals.length && vals.every((v) => v && typeof v === "object")) return vals as CliListItem[];
  }
  return [];
}

const strField = (o: CliListItem, ...keys: string[]): string => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

/** One normalized model parameter: the accepted values plus the default.
 *  Rich metadata (raw spelling, declared type, bounds) is retained so the
 *  schema normalizer below can classify fields without re-parsing. */
interface CliParam {
  values: string[];
  default: string;
  /** Original spelling from `model get` (the emitted flag). */
  rawName?: string;
  /** Declared type string, e.g. "integer", "string", "array", "object|null". */
  rawType?: string;
  /** Whether the CLI marks the parameter required. */
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
}

/** Normalize a `model get --json` reply into a param map keyed by
 *  lowercased, separator-folded name (`end-image` ≡ `end_image`). Values
 *  come from the `parameters`/`params` array (options/enum/values), with
 *  top-level `durations`/`resolutions`/`aspect_ratios` folded in. Media
 *  roles are collected from `medias[].roles` (the MCP catalog vocabulary). */
interface CliModelDetail {
  params: Map<string, CliParam>;
  roles: string[];
}

function foldName(s: string): string {
  return s.toLowerCase().replace(/[_-]+/g, "");
}

// ---- model family labels ---------------------------------------------------------

/** A catalogue family: same-named CLI entries are distinct catalogue items
 *  (not quality tiers of one model), so the dropdown annotates each row with
 *  its family + capability instead of showing bare duplicates. */
export interface HiggsfieldCliModelFamily {
  label: string;
  kind: "image" | "video" | "upscale";
  note: string;
}

/** Classify a raw CLI job_type into its model family (case-insensitive,
 *  separator-folded). Null when unrecognized — the row keeps its bare label
 *  and the raw-id dedupe below still keeps it distinguishable. */
export function classifyFamily(rawId: string): HiggsfieldCliModelFamily | null {
  const id = foldName(rawId);
  if (id.includes("topaz") || id.includes("upscale")) {
    return { label: "Upscale", kind: "upscale", note: "enhances an existing image — does not generate from a prompt" };
  }
  if (id.includes("nano") && id.includes("banana")) {
    return { label: "Nano Banana (Google)", kind: "image", note: "text-to-image generator" };
  }
  if (id.includes("grok") && id.includes("image")) {
    return { label: "Grok Image", kind: "image", note: "text-to-image generator" };
  }
  if (id.includes("grok") && (id.includes("video") || id.includes("imagine"))) {
    return { label: "Grok Imagine", kind: "video", note: "text-to-video generator" };
  }
  return null;
}

/** Variant tokens that distinguish same-family catalogue rows, read from the
 *  list item's own fields (data-driven — new models label themselves). */
function variantTokens(m: CliListItem, label: string): string[] {
  const out: string[] = [];
  const lower = label.toLowerCase();
  for (const key of ["resolution", "resolutions", "quality", "mode", "variant", "version", "tier", "speed", "size", "tag"]) {
    const v = m[key];
    const cands = Array.isArray(v) ? v : [v];
    for (const c of cands) {
      if (typeof c !== "string" && typeof c !== "number") continue;
      const s = String(c).trim();
      if (!s || s.length > 24) continue;
      if (/^(auto|default|none)$/i.test(s)) continue;
      if (lower.includes(s.toLowerCase())) continue;
      if (out.some((o) => o.toLowerCase() === s.toLowerCase())) continue;
      out.push(s);
      if (out.length >= 2) return out;
    }
  }
  return out;
}

/** Pure catalogue shaping (exported for tests): ids are untouched
 *  (`higgsfield-cli:` + raw id — generation routing depends on them); only
 *  `displayName`/`description` gain family + variant annotations, and no two
 *  distinct ids ever share a label (raw-id fallback as a last resort). */
export function shapeHiggsfieldCliChoices(items: CliListItem[], kind: "image" | "video"): OpenArtModelChoice[] {
  const out: OpenArtModelChoice[] = [];
  const seenLabel = new Map<string, string>();
  for (const m of items) {
    const rawId = strField(m, "job_type", "jobType", "job_set_type", "id", "model", "name");
    if (!rawId || rawId === "auto") continue;
    const displayName = strField(m, "display_name", "displayName", "title", "label") || strField(m, "name") || rawId;
    const name = strField(m, "name");
    const base = name && name !== rawId && name !== displayName ? `${displayName} — ${name}` : displayName;
    const family = classifyFamily(rawId);
    const suffixParts: string[] = [];
    if (family) suffixParts.push(family.label);
    suffixParts.push(...variantTokens(m, base));
    let label = suffixParts.length ? `${base} — ${suffixParts.join(" · ")}` : base;
    const firstId = seenLabel.get(label);
    if (firstId !== undefined && firstId !== rawId) {
      // Two distinct ids still render identically — disambiguate with the raw id.
      label = `${label} (${rawId})`;
    }
    seenLabel.set(label, rawId);
    const description = strField(m, "description", "summary", "recommendedFor");
    const provider = strField(m, "provider_name", "provider", "vendor");
    let fullDescription = provider ? `${description}${description ? " " : ""}— ${provider}` : description;
    if (family) {
      if (!fullDescription) fullDescription = family.note;
      else if (!fullDescription.toLowerCase().includes(family.note.toLowerCase())) {
        fullDescription = `${fullDescription} — ${family.note}`;
      }
    }
    out.push({
      id: `${HIGGSFIELD_CLI_ID_PREFIX}${rawId}`,
      displayName: label,
      description: fullDescription,
      imageInput: kind === "image",
      videoInput: kind === "video",
      cost: null, // per-model cost needs a `generate cost` preflight; unknown here
    });
  }
  return out;
}

function parseCliModelDetail(stdout: string): CliModelDetail | null {
  const obj = parseJsonLooseObject(stdout);
  if (!obj) return null;
  const params = new Map<string, CliParam>();
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const take = (name: string, values: unknown, def: unknown, rec?: Record<string, unknown>) => {
    const key = foldName(name);
    if (!key || params.has(key)) return;
    const list = Array.isArray(values)
      ? values.map((v) => String(v).trim()).filter(Boolean)
      : [];
    const entry: CliParam = {
      values: Array.from(new Set(list)),
      default: typeof def === "string" ? def.trim() : String(def ?? ""),
    };
    if (rec) {
      if (typeof rec.name === "string" || typeof rec.flag === "string" || typeof rec.key === "string" || typeof rec.param === "string") {
        entry.rawName = strField(rec, "name", "flag", "key", "param") || undefined;
      }
      const t = strField(rec, "type", "valueType", "kind");
      if (t) entry.rawType = t;
      if (rec.required === true) entry.required = true;
      const lo = num(rec.min ?? rec.minimum ?? rec.minValue);
      const hi = num(rec.max ?? rec.maximum ?? rec.maxValue);
      const st = num(rec.step);
      if (lo !== undefined) entry.min = lo;
      if (hi !== undefined) entry.max = hi;
      if (st !== undefined) entry.step = st;
    }
    if (!entry.rawName) entry.rawName = name.trim() || undefined;
    params.set(key, entry);
  };
  const rawParams = obj.parameters ?? obj.params;
  if (Array.isArray(rawParams)) {
    for (const p of rawParams) {
      if (!p || typeof p !== "object") continue;
      const rec = p as Record<string, unknown>;
      const name = strField(rec, "name", "flag", "key", "param");
      if (!name) continue;
      take(name, rec.options ?? rec.enum ?? rec.values ?? rec.allowed, rec.default ?? rec.defaultValue, rec);
    }
  }
  // Top-level option ladders some replies carry outside `parameters`.
  if (obj.durations !== undefined) take("duration", obj.durations, undefined);
  if (obj.resolutions !== undefined) take("resolution", obj.resolutions, undefined);
  if (obj.resolution !== undefined && !params.has("resolution")) take("resolution", obj.resolution, undefined);
  if (obj.aspect_ratios !== undefined) take("aspect_ratio", obj.aspect_ratios, undefined);
  if (obj.aspect_ratios !== undefined) take("aspectratio", obj.aspect_ratios, undefined);
  const roles: string[] = [];
  if (Array.isArray(obj.medias)) {
    for (const m of obj.medias) {
      if (!m || typeof m !== "object") continue;
      const rs = (m as { roles?: unknown }).roles;
      if (Array.isArray(rs)) {
        for (const r of rs) {
          const s = String(r ?? "").trim();
          if (s && !roles.includes(s)) roles.push(s);
        }
      }
    }
  }
  return { params, roles };
}

// ---- schema normalization ---------------------------------------------------------

/**
 * Normalize a parsed `model get` detail into the ordered, typed schema the
 * options form renders and the generic arg builder emits. Delegates the
 * grouping/classification grammar to `model-schema.ts` (shared by every
 * provider); total — never throws on unrecognized shapes.
 * Exported for tests.
 */
export function normalizeCliModelDetail(
  detail: CliModelDetail,
  raw: unknown,
  jobType: string,
  cliVersion: string | null
): CliModelSchema {
  const params: RawModelParam[] = [];
  for (const [, p] of detail.params) {
    params.push({
      name: p.rawName ?? "",
      type: p.rawType,
      options: p.values,
      default: p.default || undefined,
      min: p.min,
      max: p.max,
      step: p.step,
      required: p.required,
    });
  }
  return buildModelSchema({
    jobType,
    cliVersion,
    params,
    roles: HiggsfieldCliProvider.roles(detail),
    aspectRatios: HiggsfieldCliProvider.aspectRatios(detail),
    durations: HiggsfieldCliProvider.numericOptions(
      HiggsfieldCliProvider.param(detail, "duration", "length", "seconds")
    ),
    raw,
  });
}

/** Look a user value up by flag, canonical name, then aliases. */
function pickParamValue(
  field: CliOptionField,
  values: Record<string, string | number | boolean | string[]>
): string | number | boolean | string[] | undefined {
  const keys = [field.flag, field.name, ...field.aliases];
  for (const k of keys) {
    if (k in values) return values[k];
  }
  const lower = new Map(Object.keys(values).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const hit = lower.get(k.toLowerCase());
    if (hit !== undefined) return values[hit];
  }
  return undefined;
}

/**
 * Emit one schema field's value into argv. Returns false when the value is
 * absent or not allowed by the schema (never emits an unlisted enum value or
 * non-finite number). Exported for tests.
 */
export function emitSchemaField(
  field: CliOptionField,
  value: string | number | boolean | string[],
  args: string[]
): boolean {
  switch (field.kind) {
    case "enum":
    case "string": {
      const s = String(value).trim();
      if (!s) return false;
      if (field.kind === "enum" && field.values?.length) {
        const match = field.values.find((v) => v.toLowerCase() === s.toLowerCase());
        if (!match) return false;
        args.push(`--${field.flag}`, match);
        return true;
      }
      args.push(`--${field.flag}`, s);
      return true;
    }
    case "integer":
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) return false;
      let out = field.kind === "integer" ? Math.round(n) : n;
      if (field.min !== undefined) out = Math.max(field.min, out);
      if (field.max !== undefined) out = Math.min(field.max, out);
      args.push(`--${field.flag}`, String(out));
      return true;
    }
    case "boolean": {
      const truthy = value === true || value === "true" || value === 1 || value === "1";
      args.push(`--${field.flag}`, truthy ? "true" : "false");
      return true;
    }
    case "array": {
      const items = (Array.isArray(value) ? value : [value])
        .map((v) => String(v).trim())
        .filter(Boolean)
        .slice(0, field.maxItems ?? Infinity);
      if (!items.length) return false;
      for (const item of items) args.push(`--${field.flag}`, item);
      return true;
    }
    case "json": {
      const s = typeof value === "string" ? value.trim() : JSON.stringify(value);
      if (!s) return false;
      try {
        JSON.parse(s);
      } catch {
        return false;
      }
      args.push(`--${field.flag}`, s);
      return true;
    }
    default:
      return false;
  }
}

/**
 * Generic extra-params emission shared by the image and video submit paths.
 * Iterates the model's schema and emits `--flag <value>` for each present
 * `params` entry, skipping media roles (the reference router owns them) and
 * flags the caller already emitted (resolution/quality/duration/aspect/mode).
 * Unknown keys for the active model are ignored — switching models never
 * carries stale selections into the next submission.
 */
function emitExtraParams(
  schema: CliModelSchema | null,
  values: Record<string, string | number | boolean | string[]> | undefined,
  args: string[]
): void {
  if (!schema || !values) return;
  for (const field of schema.fields) {
    if (field.mediaRole) continue;
    if (OWNED_FLAGS.has(foldName(field.flag)) || OWNED_FLAGS.has(field.name)) continue;
    const v = pickParamValue(field, values);
    if (v === undefined || v === null || v === "") continue;
    emitSchemaField(field, v, args);
  }
}

/** The job id out of a `generate create --json` reply (no --wait): the CLI
 *  prints job IDs — a bare id, an array, or an object carrying one. */
function extractCliJobId(stdout: string): string | null {
  const text = stdout.trim();
  if (!text) return null;
  const arr = parseJsonLooseArray(text);
  if (arr && arr.length) {
    const first = arr[0];
    if (typeof first === "string" && first.trim()) return first.trim();
    if (first && typeof first === "object") {
      const id = strField(first as CliListItem, "job_id", "jobId", "id", "job");
      if (id) return id;
    }
  }
  const obj = parseJsonLooseObject(text);
  if (obj) {
    const id = strField(obj as CliListItem, "job_id", "jobId", "id", "job");
    if (id) return id;
    for (const key of ["jobs", "ids", "job_ids", "data", "results"]) {
      const v = (obj as Record<string, unknown>)[key];
      if (Array.isArray(v) && v.length) {
        const f = v[0];
        if (typeof f === "string" && f.trim()) return f.trim();
        if (f && typeof f === "object") {
          const nested = strField(f as CliListItem, "job_id", "jobId", "id", "job");
          if (nested) return nested;
        }
      }
    }
  }
  // Last resort: a bare UUID on stdout.
  return text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)?.[0] ?? null;
}

/** Terminal-state words for a CLI job object. Anything unrecognized keeps
 *  polling (the wait timeout, not a guess, ends the loop). */
const JOB_FAILED_RX = /fail|cancel|error/i;
const JOB_DONE_RX = /complet|success|done|finish|ready/i;

/** Read `{status, failed, reason}` out of a `generate wait/get --json` reply.
 *  The reason fields are best-effort — the CLI's terminal "failed" status
 *  usually carries the vendor's error text alongside it. */
function cliJobStatus(stdout: string): { status: string; failed: boolean; reason: string } {
  const statusOf = (o: Record<string, unknown>): string => {
    const s = strField(o as CliListItem, "status", "state");
    if (s) return s;
    for (const key of ["job", "data", "result"]) {
      const v = o[key];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const nested = strField(v as CliListItem, "status", "state");
        if (nested) return nested;
      }
    }
    return "";
  };
  const reasonOf = (o: Record<string, unknown>): string => {
    const direct = strField(
      o as CliListItem,
      "error", "error_message", "errorMessage", "error_code", "message",
      "fail_reason", "failure_reason", "failureReason", "failure", "failed_reason",
      "reason", "detail", "status_message", "statusMessage",
    );
    if (direct) return direct;
    for (const key of ["job", "data", "result", "error", "failure"]) {
      const v = o[key];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const nested = strField(
          v as CliListItem,
          "error", "error_message", "error_code", "message", "fail_reason", "failure_reason", "failure", "reason", "detail",
        );
        if (nested) return nested;
      } else if (typeof v === "string" && v.trim()) {
        return v.trim();
      }
    }
    return "";
  };
  const read = (o: Record<string, unknown>): { status: string; failed: boolean; reason: string } | null => {
    const status = statusOf(o);
    if (!status && !reasonOf(o)) return null;
    return { status, failed: JOB_FAILED_RX.test(status), reason: reasonOf(o) };
  };
  const arr = parseJsonLooseArray(stdout);
  const first = arr && arr.length && arr[0] && typeof arr[0] === "object" ? (arr[0] as Record<string, unknown>) : null;
  const fromArr = first ? read(first) : null;
  if (fromArr) return fromArr;
  const obj = parseJsonLooseObject(stdout);
  const fromObj = obj ? read(obj as Record<string, unknown>) : null;
  if (fromObj) return fromObj;
  return { status: "", failed: false, reason: "" };
}

/** Human-readable terminal job failure, including the vendor's reason when the
 *  CLI surfaces one. */
function jobFailureMessage(jobId: string, status: string, reason: string): string {
  const head = `Higgsfield generation ${(status || "failed").toLowerCase()} (job ${jobId.slice(0, 8)}…).`;
  return reason ? `${head} ${reason.slice(0, 800)}` : head;
}

/** Collect http(s) media URLs out of a job reply, preferred-field first,
 *  then any URL with a matching extension anywhere in the payload. */
function cliResultUrls(stdout: string, video: boolean): string[] {
  const extRx = video ? /\.(mp4|webm|mov|m4v)(\?|$)/i : /\.(png|jpe?g|webp|gif)(\?|$)/i;
  const urlRx = /https?:\/\/[^\s"'\\]+/g;
  const out: string[] = [];
  const push = (u: string) => {
    const clean = u.replace(/[),.\]}>]+$/, "");
    if (clean && !out.includes(clean)) out.push(clean);
  };
  const fromValue = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.match(urlRx) ?? []) if (extRx.test(m)) push(m);
    } else if (Array.isArray(v)) {
      for (const e of v) fromValue(e);
    } else if (v && typeof v === "object") {
      for (const e of Object.values(v as Record<string, unknown>)) fromValue(e);
    }
  };
  const preferred = (o: Record<string, unknown>): void => {
    for (const key of ["result_url", "result_urls", "min_result_url", "url", "urls",
      "result", "results", "output", "outputs", "video_url", "image_url",
      "download_url", "file_url", "file", "files", "assets", "media"]) {
      if (o[key] !== undefined) fromValue(o[key]);
    }
  };
  const arr = parseJsonLooseArray(stdout);
  if (arr) {
    for (const e of arr) {
      if (e && typeof e === "object") preferred(e as Record<string, unknown>);
    }
    if (out.length) return out;
    for (const e of arr) fromValue(e);
    if (out.length) return out;
  }
  const obj = parseJsonLooseObject(stdout);
  if (obj) {
    preferred(obj as Record<string, unknown>);
    if (out.length) return out;
    fromValue(obj);
    if (out.length) return out;
  }
  // Plain-text fallback (non-JSON progress lines can still carry the URL).
  for (const m of stdout.match(urlRx) ?? []) if (extRx.test(m)) push(m);
  return out;
}

/** The credit quote out of a `generate cost --json` reply. Live shape
 *  (v1.1.25) is a flat `{credits: N}` (fractional allowed — 32.5 for
 *  seedance_2_5 5s/720p); envelope/nested spellings and numeric strings are
 *  accepted defensively. Null when unreadable. Exported for tests. */
export function parseCostCredits(stdout: string): number | null {
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v.trim());
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
  };
  const search = (o: Record<string, unknown>): number | null => {
    for (const key of ["credits", "total_credits", "totalCredits", "cost", "price", "amount"]) {
      const n = num(o[key]);
      if (n !== null) return n;
    }
    for (const key of ["data", "account", "job", "result", "estimate"]) {
      const v = o[key];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const n = search(v as Record<string, unknown>);
        if (n !== null) return n;
      }
    }
    return null;
  };
  const obj = parseJsonLooseObject(stdout);
  if (obj) return search(obj as Record<string, unknown>);
  const arr = parseJsonLooseArray(stdout);
  if (arr) {
    for (const e of arr) {
      if (e && typeof e === "object") {
        const n = search(e as Record<string, unknown>);
        if (n !== null) return n;
      }
    }
  }
  return null;
}

/** Stable cache key for a cost request: sorted params so key order never
 *  splits the cache. Exported for tests. */
export function costCacheKey(req: GenerationCostRequest): string {
  const params = req.params
    ? Object.keys(req.params).sort().map((k) => `${k}=${JSON.stringify(req.params?.[k])}`)
    : [];
  return [req.model.trim(), req.kind, req.resolution ?? "", req.durationSec ?? "",
    req.aspectRatio ?? "", req.quality ?? "", ...params].join("|");
}

/** The credit balance out of an `account status --json` reply. */
function parseCliCredits(stdout: string): number | null {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const search = (o: Record<string, unknown>): number | null => {
    for (const key of ["credits", "balance", "available_credits", "subscription_balance", "remaining", "remaining_credits"]) {
      const n = num(o[key]);
      if (n !== null) return n;
    }
    for (const key of ["data", "account", "subscription", "wallet"]) {
      const v = o[key];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const n = search(v as Record<string, unknown>);
        if (n !== null) return n;
      }
    }
    return null;
  };
  const obj = parseJsonLooseObject(stdout);
  if (obj) return search(obj as Record<string, unknown>);
  const arr = parseJsonLooseArray(stdout);
  if (arr) {
    for (const e of arr) {
      if (e && typeof e === "object") {
        const n = search(e as Record<string, unknown>);
        if (n !== null) return n;
      }
    }
  }
  return null;
}

// ---- the provider ---------------------------------------------------------------

export class HiggsfieldCliProvider implements MediaProvider {
  readonly id = "higgsfield-cli" as const;
  readonly displayName = "Higgsfield CLI";

  private listCache: { at: number; image: CliListItem[]; video: CliListItem[] } | null = null;
  private detailCache = new Map<string, { at: number; detail: CliModelDetail | null }>();
  /** Normalized per-model schemas (TTL + LRU cap). Last-good entries are
   *  kept past expiry so a transient `model get` failure degrades to
   *  stale-but-usable instead of the old hardcoded path. */
  private schemaCache = new Map<string, { at: number; schema: CliModelSchema | null }>();
  /** Per-config credit quotes (TTL + cap). Keyed by costCacheKey — prompt
   *  text and media never participate (they don't move the price). */
  private costCache = new Map<string, { at: number; cost: number | null }>();

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

  /** True when a `higgsfield` binary resolves (PATH or Settings override).
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

  /** Run the CLI, throwing a readable error (stderr + auth hint) on failure. */
  private async cli(args: string[], timeoutMs: number): Promise<string> {
    const binary = this.opts.binary();
    if (!binary) {
      throw new Error(
        "The Higgsfield CLI isn't installed (no spawnable `higgsfield` binary on PATH and no custom path in Settings → Media generation) — install it (`npm i -g @higgsfield/cli`, or the official installer for a real binary) or pick another media provider."
      );
    }
    const run = this.opts.run ?? defaultCliRun(binary);
    const res = await run(args, { timeoutMs });
    if (res.code !== 0) {
      const err = `${res.stderr.trim() || res.stdout.trim() || `exit code ${res.code}`}`.slice(0, 600);
      const authHint = /not authenticated|session expired|no workspace selected|auth login/i.test(err)
        ? " Run `higgsfield auth login` in a terminal (and `higgsfield workspace set <id>` if it asks for a workspace), then retry."
        : "";
      throw new Error(`higgsfield ${args.slice(0, 2).join(" ")} failed: ${err}.${authHint}`);
    }
    return res.stdout;
  }

  private json(args: string[], timeoutMs = 60_000): Promise<string> {
    return this.cli([...args, "--json", "--no-color"], timeoutMs);
  }

  /** Run the CLI without throwing, returning the raw result (used for
   *  best-effort diagnostics on a job that already failed). Null when the
   *  binary is missing or the process can't be spawned. */
  private async tryRun(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string } | null> {
    const binary = this.opts.binary();
    if (!binary) return null;
    const run = this.opts.run ?? defaultCliRun(binary);
    try {
      return await run([...args, "--json", "--no-color"], { timeoutMs });
    } catch {
      return null;
    }
  }

  /** Enrich a non-zero `generate wait` failure with the job's terminal status +
   *  vendor reason (a single `generate get`). Falls back to the original error
   *  when the job can't be re-read. */
  private async describeJobFailure(jobId: string, cause: unknown): Promise<string> {
    const res = await this.tryRun(["generate", "get", jobId], 60_000);
    if (res) {
      const combined = `${res.stdout}\n${res.stderr}`;
      const { status, reason } = cliJobStatus(combined);
      if (reason) return jobFailureMessage(jobId, status, reason);
      // No recognizable reason field — surface the raw job reply so the cause
      // is visible instead of a bare "failed".
      const raw = (res.stdout.trim() || res.stderr.trim()).slice(0, 800);
      if (raw) return jobFailureMessage(jobId, status || "failed", raw);
    }
    return cause instanceof Error ? cause.message : String(cause);
  }

  // ---- catalog --------------------------------------------------------------------

  private async listRaw(kind: "image" | "video"): Promise<CliListItem[]> {
    const now = Date.now();
    if (this.listCache && now - this.listCache.at < CATALOG_TTL_MS) {
      return kind === "image" ? this.listCache.image : this.listCache.video;
    }
    // The --image/--video filters classify reliably, so the item shape only
    // needs id + display fields (no media-type sniffing).
    const [image, video] = await Promise.all([
      this.json(["model", "list", "--image"]).then(parseCliList, () => [] as CliListItem[]),
      this.json(["model", "list", "--video"]).then(parseCliList, () => [] as CliListItem[]),
    ]);
    this.listCache = { at: now, image, video };
    return kind === "image" ? image : video;
  }

  private shapeChoices(items: CliListItem[], kind: "image" | "video"): OpenArtModelChoice[] {
    return shapeHiggsfieldCliChoices(items, kind);
  }

  /** The model dropdowns. Image and video lists are fetched separately so
   *  classification never depends on a media-type field. */
  async listModelChoices(): Promise<OpenArtModelChoice[]> {
    const [image, video] = await Promise.all([this.listRaw("image"), this.listRaw("video")]);
    return [...this.shapeChoices(image, "image"), ...this.shapeChoices(video, "video")];
  }

  /** The signed-in account's remaining credit balance, or null. */
  async getCredits(): Promise<number | null> {
    let stdout = "";
    try {
      stdout = await this.json(["account", "status"]);
    } catch {
      return null;
    }
    return parseCliCredits(stdout);
  }

  /** Live per-config credit quote via `generate cost` (no job submitted).
   *  Never throws — any failure (unknown model, unreadable reply, invalid
   *  flag combo such as a media-requiring `mode` with no media attached)
   *  resolves null so the UI hides the quote instead of blocking submit.
   *  Arg emission mirrors the submit paths (exact-match resolution/quality,
   *  listed aspects only, schema extras via the same normalizer) so the
   *  quote prices what the submit would send — minus prompt and media. In
   *  particular a per-surface `params.quality` pick beats the top-level
   *  quality, exactly like the submit. */
  async getGenerationCost(req: GenerationCostRequest): Promise<number | null> {
    const raw = rawJobType(req.model);
    if (!raw || raw === "auto" || isForeignId(req.model)) return null;
    const key = costCacheKey({ ...req, model: raw });
    const hit = this.costCache.get(key);
    if (hit && Date.now() - hit.at < COST_TTL_MS) return hit.cost;
    const remember = (cost: number | null): number | null => {
      this.costCache.set(key, { at: Date.now(), cost });
      if (this.costCache.size > COST_CACHE_CAP) {
        const oldest = this.costCache.keys().next();
        if (!oldest.done) this.costCache.delete(oldest.value);
      }
      return cost;
    };
    try {
      const detail = await this.modelDetail(raw).catch(() => null);
      const args = [raw, "--prompt", COST_PROBE_PROMPT];
      if (req.kind === "video") {
        args.push("--duration", String(Math.round(req.durationSec ?? 0) || 5));
      }
      if (req.resolution) {
        const resValues = detail ? (HiggsfieldCliProvider.param(detail, "resolution")?.values ?? []) : [];
        const resMatch = resValues.find((v) => v.toLowerCase() === String(req.resolution).toLowerCase());
        if (resMatch) args.push("--resolution", resMatch);
      }
      // Nearest explicit pick wins (see the submit path): a per-surface
      // params pick beats the top-level quality.
      const paramsQuality = typeof req.params?.quality === "string" && req.params.quality.trim()
        ? req.params.quality.trim()
        : undefined;
      const quality = paramsQuality ?? req.quality;
      if (quality) {
        const qualities = detail ? (HiggsfieldCliProvider.param(detail, "quality")?.values ?? []) : [];
        const qMatch = qualities.find((v) => v.toLowerCase() === String(quality).toLowerCase());
        if (qMatch) args.push("--quality", qMatch);
      }
      if (req.aspectRatio) {
        const aspects = detail ? HiggsfieldCliProvider.aspectRatios(detail) : [];
        if (aspects.includes(req.aspectRatio)) args.push("--aspect_ratio", req.aspectRatio);
      }
      if (detail && req.params) {
        emitExtraParams(normalizeCliModelDetail(detail, null, raw, null), req.params, args);
      }
      const stdout = await this.costProbe(args, detail, req.kind);
      return remember(parseCostCredits(stdout));
    } catch {
      return remember(null);
    }
  }

  /** Run one `generate cost` preflight, retrying once with a placeholder in
   *  the model's start-image slot when the first attempt is rejected for a
   *  media-requiring `mode` (`omni_reference`, `image-to-video`, …). The real
   *  submit always carries a source frame, and references don't move the
   *  price, so the retry prices the same config instead of hiding the quote.
   *  The retry only fires on failure, so the common media-free config still
   *  probes with zero uploads. */
  private async costProbe(
    args: string[],
    detail: CliModelDetail | null,
    kind: "image" | "video"
  ): Promise<string> {
    try {
      return await this.json(["generate", "cost", ...args], 30_000);
    } catch (e) {
      // Only a media/reference rejection is worth the placeholder retry — an
      // invalid flag combo or an unknown model would just fail again.
      if (kind !== "video" || !COST_MEDIA_REJECT_RX.test(String(e))) throw e;
      const roles = detail ? HiggsfieldCliProvider.roles(detail) : [];
      const flag = !roles.length || roles.includes("startimage")
        ? "--start-image"
        : roles.includes("image") ? "--image" : null;
      if (!flag) throw e;
      const { paths, cleanup } = writeCliTempRefs([{ name: "cost-probe", dataUrl: COST_PROBE_IMAGE_DATA_URL }]);
      try {
        const path = paths[0];
        if (!path) throw e;
        return await this.json(["generate", "cost", ...args, flag, path], 30_000);
      } finally {
        cleanup();
      }
    }
  }

  /** One model's normalized detail (cached); null when unknown/unreadable. */
  private async modelDetail(rawId: string): Promise<CliModelDetail | null> {
    const hit = this.detailCache.get(rawId);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.detail;
    let detail: CliModelDetail | null = null;
    try {
      detail = parseCliModelDetail(await this.json(["model", "get", rawId]));
      // A reply with neither params nor roles carries no usable schema.
      if (detail && !detail.params.size && !detail.roles.length) detail = null;
    } catch {
      detail = null;
    }
    this.detailCache.set(rawId, { at: Date.now(), detail });
    return detail;
  }

  /** Drop every cached catalog/detail/schema probe (dev customizer refresh). */
  refreshProbes(): void {
    this.listCache = null;
    this.detailCache.clear();
    this.schemaCache.clear();
    this.costCache.clear();
  }

  /** Warm the per-model detail cache for every video-capable model.
   *  Fire-and-forget: the caller returns immediately so listing models
   *  never waits on detail lookups. */
  prewarm(models: OpenArtModelChoice[]): void {
    for (const m of models) {
      if (!m.videoInput) continue;
      const raw = higgsfieldCliRawId(m.id);
      if (!raw || raw === "auto") continue;
      void this.modelDetail(raw).catch(() => {});
    }
  }

  /** Internal (module-level normalizer shares it): first matching param. */
  static param(detail: CliModelDetail, ...names: string[]): CliParam | null {
    for (const n of names) {
      const p = detail.params.get(foldName(n));
      if (p) return p;
    }
    return null;
  }

  /** Media roles a detail declares (lowercased, separator-folded). The live
   *  `model get` carries no `medias` block — start/end frames and reference
   *  arrays arrive as `params` (`start_image`, `end_image`,
   *  `image_references`, …), so those param names count as accepted roles.
   *  Internal (module-level normalizer shares it). */
  static roles(detail: CliModelDetail): string[] {
    const out: string[] = [];
    for (const r of detail.roles) {
      const f = foldName(r);
      if (f && !out.includes(f)) out.push(f);
    }
    for (const key of detail.params.keys()) {
      if (
        key === "startimage" || key === "endimage" ||
        key === "image" || key === "video" || key === "audio" ||
        // Some models (nano_banana_pro) name the base slot `input_image` and
        // the reference array `input_images` instead of `image`/`image_references`.
        key === "inputimage" || key === "inputimages" ||
        /references?$/.test(key)
      ) {
        if (!out.includes(key)) out.push(key);
      }
    }
    return out;
  }

  /** The single-image flag a model's base image rides, or null when it has no
   *  single slot. `--image` is the CLI's legacy single-image flag for image
   *  models (it fills `input_image`/`image`). */
  private static singleImageFlag(roles: string[]): string | null {
    const has = (names: string[]) => roles.some((r) => names.includes(r));
    if (has(["inputimage", "startimage", "image"])) return "--image";
    // Unknown schema (detail unreadable): best-effort legacy single image.
    return roles.length === 0 ? "--image" : null;
  }

  /** The array-reference flag a model's extra references ride, or null. */
  private static arrayImageFlag(roles: string[]): string | null {
    const has = (names: string[]) => roles.some((r) => names.includes(r));
    if (has(["imagereferences", "inputimages"]) || roles.some((r) => /reference/.test(r))) return "--image-references";
    return null;
  }

  /** Resolve a stored/selected id to the raw job_type to submit: foreign or
   *  unknown ids fall back to the house default (or the first model of that
   *  kind). The legacy `higgsfield:` (MCP, removed) prefix is accepted too —
   *  same vendor, same id space — so a pick made under the MCP transport
   *  still submits. */
  private async resolveImageModel(choice: string, items: CliListItem[]): Promise<string> {
    const raw = rawJobType(choice);
    const ids = items.map((m) => strField(m, "job_type", "jobType", "job_set_type", "id", "model", "name")).filter(Boolean);
    if (raw && ids.includes(raw)) return raw;
    if (ids.includes(DEFAULT_IMAGE_MODEL)) return DEFAULT_IMAGE_MODEL;
    return ids[0] ?? "";
  }

  private async resolveVideoModel(choice: string, items: CliListItem[], preferEndFrame: boolean): Promise<string> {
    const raw = rawJobType(choice);
    const ids = items.map((m) => strField(m, "job_type", "jobType", "job_set_type", "id", "model", "name")).filter(Boolean);
    if (raw && ids.includes(raw)) return raw;
    if (preferEndFrame) {
      for (const id of ids) {
        const d = await this.modelDetail(id).catch(() => null);
        if (d && HiggsfieldCliProvider.roles(d).includes("endimage")) return id;
      }
    }
    if (ids.includes(DEFAULT_VIDEO_MODEL)) return DEFAULT_VIDEO_MODEL;
    return ids[0] ?? "";
  }

  // ---- options ----------------------------------------------------------------------

  /** Numeric values from a param's option list ("8s"/"8 sec" → 8).
   *  Internal (module-level normalizer shares it). */
  static numericOptions(p: CliParam | null): number[] {
    if (!p) return [];
    const out: number[] = [];
    for (const v of p.values) {
      const n = Number(String(v).replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n) && n > 0 && n <= 600) out.push(Math.round(n));
    }
    return out;
  }

  /** The full normalized option schema for a model, derived live from
   *  `model get <job_type> --json` (cached, TTL + LRU cap, last-good
   *  fallback on transient failures). Null for foreign ids, unknown models,
   *  and unreadable details — callers fall back to the ladder adapters.
   *  `cliVersion` is null: this transport doesn't probe `version` per
   *  lookup (the header documents the probed v1.1.24 vocabulary). */
  async modelOptions(modelId: string): Promise<CliModelSchema | null> {
    const raw = rawJobType(modelId);
    if (!raw || raw === "auto" || isForeignId(modelId)) return null;
    const hit = this.schemaCache.get(raw);
    if (hit?.schema && Date.now() - hit.at < SCHEMA_TTL_MS) return hit.schema;
    let stdout: string;
    try {
      stdout = await this.json(["model", "get", raw]);
    } catch {
      return hit?.schema ?? null;
    }
    const detail = parseCliModelDetail(stdout);
    if (!detail || (!detail.params.size && !detail.roles.length)) {
      return hit?.schema ?? null;
    }
    // Keep the detail cache warm from the same fetch (adapters read it).
    this.detailCache.set(raw, { at: Date.now(), detail });
    const schema = normalizeCliModelDetail(detail, stdout, raw, null);
    this.schemaCache.set(raw, { at: Date.now(), schema });
    if (this.schemaCache.size > SCHEMA_CACHE_CAP) {
      const oldest = this.schemaCache.keys().next();
      if (!oldest.done) this.schemaCache.delete(oldest.value);
    }
    return schema;
  }

  /** Project a schema's remaining enum params into the UI's
   *  `ModelParamOption` shape (the advanced/variant knobs). Owned flags
   *  (resolution/aspect/quality/duration) are handled by dedicated controls
   *  and skipped; an exposed `variant` (GPT Image 2.5 submodel) is skipped
   *  when `variantExposed`. */
  static paramOptionsFromSchema(schema: CliModelSchema, opts: { variantExposed: boolean }): ModelParamOption[] {
    const out: ModelParamOption[] = [];
    for (const f of schema.fields) {
      if (f.mediaRole || f.kind !== "enum" || !f.values?.length) continue;
      if (OWNED_FLAGS.has(foldName(f.flag)) || OWNED_FLAGS.has(f.name)) continue;
      if (f.name === "variant" && opts.variantExposed) continue;
      out.push({
        flag: `--${f.flag}`,
        key: f.flag,
        values: [...f.values],
        ...(typeof f.default === "string" && f.default ? { defaultValue: f.default } : {}),
        exposure: f.group === "core" ? "exposed" : "advanced",
        label: f.flag.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      });
    }
    return out;
  }

  /** The resolution / length options a video model accepts (from `model
   *  get`). Null for foreign ids, unknown models, and image-only callers.
   *  Deprecated: prefer `modelOptions()` (the full schema); this ladder
   *  projection stays for one release for existing consumers. */
  async videoModelOptions(modelId: string, withImage: boolean): Promise<VideoModelOptions | null> {
    const raw = rawJobType(modelId);
    if (!raw || raw === "auto" || isForeignId(modelId)) return null;
    const detail = await this.modelDetail(raw).catch(() => null);
    if (!detail) return null;
    const roles = HiggsfieldCliProvider.roles(detail);
    if (withImage && !roles.some((r) => /startimage|^image|imagereferences|endimage|video|videoreferences/.test(r))) return null;
    const out: VideoModelOptions = { resolutions: [], durations: [] };
    const resParam = HiggsfieldCliProvider.param(detail, "resolution", "quality", "res");
    // `quality` doubles as the resolution ladder on some video models
    // (Wan 2.6 `quality: 720p/1080p`); duration alone never qualifies.
    if (resParam) {
      for (const v of resParam.values) {
        const s = String(v).trim();
        if (s && /p$|k$|^\d+x\d+$/i.test(s)) out.resolutions.push(s);
      }
    }
    const durParam = HiggsfieldCliProvider.param(detail, "duration", "length", "seconds");
    out.durations.push(...HiggsfieldCliProvider.numericOptions(durParam));
    out.resolutions = Array.from(new Set(out.resolutions));
    out.durations = Array.from(new Set(out.durations)).sort((a, b) => a - b);
    // Extended surface: aspect ratios + advanced params, projected from the
    // same detail. Additive — old consumers only read resolutions/durations.
    const schema = normalizeCliModelDetail(detail, null, raw, null);
    if (schema.aspectRatios.length) out.aspectRatios = schema.aspectRatios;
    const advanced = HiggsfieldCliProvider.paramOptionsFromSchema(schema, { variantExposed: false });
    if (advanced.length) out.params = advanced;
    return out;
  }

  /** The quality tier an image model accepts, from `model get` (a
   *  `quality`-named parameter with options, e.g. Seedream's basic/high).
   *  Null when the model declares none — the caller hides the quality
   *  dropdown and the vendor default applies.
   *  Deprecated: prefer `modelOptions()` (the full schema); this ladder
   *  projection stays for one release for existing consumers. */
  async imageModelOptions(modelId: string): Promise<ImageModelOptions | null> {
    const raw = rawJobType(modelId);
    if (!raw || raw === "auto" || isForeignId(modelId)) return null;
    const detail = await this.modelDetail(raw).catch(() => null);
    if (!detail) return null;
    const quality = HiggsfieldCliProvider.param(detail, "quality");
    if (!quality || !quality.values.length) return null;
    const qualities = Array.from(
      new Set(quality.values.map((v) => String(v).trim()).filter((s) => s && !/^(auto|default)$/i.test(s)))
    );
    if (!qualities.length) return null;
    const def = quality.default.trim();
    const schema = normalizeCliModelDetail(detail, null, raw, null);
    const variantField = schema.fields.find((f) => f.name === "variant" && f.group === "core");
    const resField = schema.fields.find((f) => f.name === "resolution" || f.name === "res");
    const out: ImageModelOptions = {
      qualities,
      defaultQuality: def && qualities.some((q) => q.toLowerCase() === def.toLowerCase()) ? def : null,
    };
    if (schema.aspectRatios.length) out.aspectRatios = schema.aspectRatios;
    if (resField?.values?.length) {
      out.resolutions = [...resField.values];
      if (typeof resField.default === "string" && resField.default) out.defaultResolution = resField.default;
    }
    if (variantField?.values?.length) {
      out.submodels = [...variantField.values];
      if (typeof variantField.default === "string" && variantField.default) out.defaultSubmodel = variantField.default;
    }
    const advanced = HiggsfieldCliProvider.paramOptionsFromSchema(schema, { variantExposed: !!out.submodels });
    if (advanced.length) out.params = advanced;
    return out;
  }

  /** Ids (namespaced) of the video-capable models declaring an end-image
   *  slot. Empty when none is proven — the caller unions this with the
   *  user's manual allowlist before the tween dropdown offers anything. */
  async videoEndFrameModels(): Promise<string[]> {
    let items: CliListItem[] = [];
    try {
      items = await this.listRaw("video");
    } catch {
      return [];
    }
    const ids = items
      .map((m) => strField(m, "job_type", "jobType", "job_set_type", "id", "model", "name"))
      .filter(Boolean);
    const out: string[] = [];
    await Promise.all(
      ids.map(async (id) => {
        const d = await this.modelDetail(id).catch(() => null);
        if (d && HiggsfieldCliProvider.roles(d).includes("endimage")) out.push(`${HIGGSFIELD_CLI_ID_PREFIX}${id}`);
      })
    );
    return out.sort();
  }

  /** Ids (namespaced) of the video models declaring a video input role — the
   *  edit-video node's capability probe. Empty when none is proven. */
  async videoEditModels(): Promise<string[]> {
    let items: CliListItem[] = [];
    try {
      items = await this.listRaw("video");
    } catch {
      return [];
    }
    const ids = items
      .map((m) => strField(m, "job_type", "jobType", "job_set_type", "id", "model", "name"))
      .filter(Boolean);
    const out: string[] = [];
    await Promise.all(
      ids.map(async (id) => {
        const d = await this.modelDetail(id).catch(() => null);
        if (d && HiggsfieldCliProvider.roles(d).some((r) => r === "video" || r === "videoreferences")) {
          out.push(`${HIGGSFIELD_CLI_ID_PREFIX}${id}`);
        }
      })
    );
    return out.sort();
  }

  /** Ids (namespaced) of the image models the catalog classifies as
   *  upscalers — they enhance an existing image rather than generate from a
   *  prompt (Topaz, Bytedance Image Upscale). The upscale node and the Image
   *  Suite's Upscale mode union this with the user's `image:upscale` surface
   *  assignments. Empty when the catalog can't be read. */
  async imageUpscaleModels(): Promise<string[]> {
    let items: CliListItem[] = [];
    try {
      items = await this.listRaw("image");
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const m of items) {
      const id = strField(m, "job_type", "jobType", "job_set_type", "id", "model", "name");
      if (id && classifyFamily(id)?.kind === "upscale") out.push(`${HIGGSFIELD_CLI_ID_PREFIX}${id}`);
    }
    return out.sort();
  }

  /** No project concept on Higgsfield — generations always land in the
   *  account/workspace default, so there is nothing to resolve. */
  async resolveProject(_p: Production, _onNotice?: (msg: string) => void): Promise<string | null> {
    return null;
  }

  // ---- temp refs ----------------------------------------------------------------------

  private static fileDataUrl(p: Production, rel: string, label: string): { name: string; dataUrl: string } {
    const buf = fs.readFileSync(assetPath(p, rel));
    const ext = (path.extname(rel).slice(1).toLowerCase() || "jpg").replace("jpeg", "jpg");
    const mime =
      ext === "jpg" ? "image/jpeg"
      : ext === "webp" ? "image/webp"
      : ext === "gif" ? "image/gif"
      : ext === "mp4" ? "video/mp4"
      : ext === "webm" ? "video/webm"
      : ext === "mov" ? "video/quicktime"
      : ext === "m4v" ? "video/x-m4v"
      : "image/png";
    return { name: label, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
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
   * Submit (`generate create`, no --wait) then rejoin (`generate wait`) and
   * return the finished asset bytes. Throws on FAILED/CANCELLED; throws a
   * timeout error past the deadline (image callers record the job id as
   * pending for a later recheck; video callers surface it).
   */
  private async createAndWait(
    createArgs: string[],
    video: boolean,
    timeoutMs: number,
    onStatus?: (status: string) => void
  ): Promise<{ buf: Buffer; ext: string; jobId: string }> {
    const createOut = await this.cli(["generate", "create", ...createArgs], 120_000);
    const jobId = extractCliJobId(createOut);
    if (!jobId) {
      throw new Error(
        `The Higgsfield CLI returned no job id (${createOut.slice(0, 200) || "empty reply"}) — the submission may not have gone through and no credits should have been spent.`
      );
    }
    let waitOut: string;
    try {
      waitOut = await this.cli(
        ["generate", "wait", jobId, "--timeout", `${Math.round(timeoutMs / 60000)}m`, "--interval", `${WAIT_INTERVAL_S}s`],
        timeoutMs + 60_000
      );
    } catch (e) {
      // `generate wait` exits non-zero on a terminal failure — ask the job for
      // its status + vendor reason so the caller sees why, not just "failed".
      throw new Error(await this.describeJobFailure(jobId, e));
    }
    const { status, failed, reason } = cliJobStatus(waitOut);
    if (failed) throw new Error(jobFailureMessage(jobId, status, reason));
    const urls = cliResultUrls(waitOut, video);
    // A wait that times out server-side can still print progress without a
    // terminal status — fall back to `generate get` once before giving up.
    if (!urls.length && !JOB_DONE_RX.test(status)) {
      await sleepMs(2000);
      try {
        const getOut = await this.cli(["generate", "get", jobId], 60_000);
        const gs = cliJobStatus(getOut);
        if (gs.failed) throw new Error(jobFailureMessage(jobId, gs.status, gs.reason));
        urls.push(...cliResultUrls(getOut, video));
      } catch (e) {
        if (e instanceof Error && /failed|cancel/i.test(e.message)) throw e;
      }
    }
    const url = urls[0];
    if (!url) {
      // No result URL and no terminal status = still rendering past the wait
      // cap. Signal it distinctly so callers can record the job id.
      throw new HiggsfieldCliPendingError(jobId);
    }
    const buf = await this.fetchBytes(url);
    // The job finished but its result couldn't be downloaded — keep the job id
    // + URL on the pending error so a recheck can retry the fetch.
    if (!buf) throw new HiggsfieldCliPendingError(jobId, url);
    const ext = (path.extname(new URL(url).pathname) || (video ? ".mp4" : ".png")).replace(/^\./, "").toLowerCase() || (video ? "mp4" : "png");
    if (onStatus && status) onStatus(status);
    return { buf, ext, jobId };
  }

  // ---- generation -----------------------------------------------------------------------

  /**
   * Resolve the Step 3 image generator, or null when the CLI binary doesn't
   * resolve. Mirrors the MCP imageGenFn contract (same ImageGenFn shape) so
   * pipeline callers never know which transport served the frame.
   */
  imageGenFn(
    p: Production,
    modelOverride?: string,
    resolutionOverride?: string,
    onNotice?: (msg: string) => void,
    aspectRatio: ImageGenAspectRatio = "16:9"
  ): ImageGenFn | null {
    if (!this.isAvailable()) return null;

    return async (prompt: string, refs: { name: string; dataUrl: string }[], shot?: ProductionShot, genParams?: Record<string, string | number | boolean | string[]>, onPending?: (rec: PendingImageGen) => void): Promise<Buffer> => {
      if (shot?.pendingImageGen) delete shot.pendingImageGen;

      let items: CliListItem[] = [];
      try {
        items = await this.listRaw("image");
      } catch {
        items = [];
      }
      const choice = modelOverride ?? p.openArt?.model ?? "auto";
      const modelId = await this.resolveImageModel(choice, items);
      if (!modelId) throw new Error("The Higgsfield CLI listed no image models — sign in (`higgsfield auth login`) and retry.");
      const detail = await this.modelDetail(modelId).catch(() => null);
      const roles = detail ? HiggsfieldCliProvider.roles(detail) : [];

      // Reference art rides the flags the model declares: the base/source image
      // fills the model's single slot (`input_image`/`image` via `--image`),
      // extra references the repeatable array (`input_images`/`image_references`
      // via `--image-references`). A model with only the array gets everything
      // there; a model with only the single slot takes just the first. Sending
      // the source into the array left `input_image` null and failed the job.
      const singleFlag = HiggsfieldCliProvider.singleImageFlag(roles);
      const arrayFlag = HiggsfieldCliProvider.arrayImageFlag(roles);
      const { paths, cleanup } = writeCliTempRefs(refs);
      /** The flag a reference at `i` rides, or null when it has nowhere to go. */
      const refFlag = (i: number): string | null => {
        if (i === 0 && singleFlag) return singleFlag;
        return arrayFlag;
      };
      const uploaded: (string | null)[] = paths.map((p, i) => (p && refFlag(i) ? p : null));
      const fullPrompt = citePrompt(prompt, refs, uploaded, styleRefNames(p));
      // Models whose schema declares no `prompt` param (upscalers, background
      // removers) reject `--prompt` outright. Emit it only when the model
      // accepts one; an unreadable schema keeps the legacy prompt so plain
      // text-to-image generation is unchanged.
      const acceptsPrompt = !detail || !!HiggsfieldCliProvider.param(detail, "prompt");
      try {
        const args = acceptsPrompt ? [modelId, "--prompt", fullPrompt] : [modelId];
        paths.forEach((p, i) => {
          const flag = refFlag(i);
          if (p && flag) args.push(flag, p);
        });
        // Aspect ratio: an explicit schema-driven pick (params.aspect_ratio)
        // wins over the request default, but only when the model lists it.
        const extraParams = genParams ?? p.openArt?.params;
        const paramAspect = extraParams?.aspect_ratio;
        const wantAspect = resolveAspectRatio(typeof paramAspect === "string" ? paramAspect : aspectRatio);
        const aspects = detail ? HiggsfieldCliProvider.aspectRatios(detail) : [];
        if (aspects.includes(wantAspect)) args.push("--aspect_ratio", wantAspect);
        const resolution = resolutionOverride ?? p.openArt?.resolution ?? "1k";
        const resValues = detail ? (HiggsfieldCliProvider.param(detail, "resolution")?.values ?? []) : [];
        const resMatch = resValues.find((v) => v.toLowerCase() === String(resolution).toLowerCase());
        if (resMatch) args.push("--resolution", resMatch);
        // Quality: the nearest explicit pick wins — a per-surface params pick
        // (node/ref option forms render it) beats the production default, so a
        // quality set on the node actually submits instead of silently billing
        // the storyboard default. Cleared/absent falls back to production.
        const paramsQuality = typeof extraParams?.quality === "string" && extraParams.quality.trim()
          ? extraParams.quality.trim()
          : undefined;
        const quality = paramsQuality ?? p.openArt?.quality?.trim();
        const qualities = detail ? (HiggsfieldCliProvider.param(detail, "quality")?.values ?? []) : [];
        if (quality) {
          const qMatch = qualities.find((v) => v.toLowerCase() === quality.toLowerCase());
          if (qMatch) args.push("--quality", qMatch);
        }
        // Some models (Higgsfield's Topaz upscalers) declare required
        // `output_width`/`output_height` with no default. When the caller
        // hasn't supplied them, derive a 2× target from the source image's own
        // pixels so an upscale submits without manual sizing. A user-supplied
        // side always wins; a single supplied side scales the other by the
        // source aspect. Unreadable source pixels leave the field untouched
        // (the user can set it in the node's Advanced options).
        if (detail) {
          const reqW = HiggsfieldCliProvider.param(detail, "output_width")?.required === true;
          const reqH = HiggsfieldCliProvider.param(detail, "output_height")?.required === true;
          if (reqW || reqH) {
            const providedNum = (key: string): number | undefined => {
              const v = extraParams?.[key];
              const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
              return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
            };
            const userW = providedNum("output_width");
            const userH = providedNum("output_height");
            const size = refs[0] ? imagePixelSize(dataUrlToBytes(refs[0].dataUrl)) : null;
            const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
            let w = userW;
            let h = userH;
            if (size && (!w || !h)) {
              const scale = 2;
              if (!w && !h) { w = even(size.width * scale); h = even(size.height * scale); }
              else if (!h) h = even((w! * size.height) / size.width);
              else w = even((h! * size.width) / size.height);
            }
            if (w && !userW) args.push("--output_width", String(w));
            if (h && !userH) args.push("--output_height", String(h));
          }
        }
        // Schema-driven extras (variant, background, seed, mode, …) from
        // the persisted params map (or the caller-supplied override, e.g. a
        // reference-generation modal). Owned flags and media roles are
        // skipped; unknown keys for this model are ignored.
        if (detail && extraParams) {
          emitExtraParams(normalizeCliModelDetail(detail, null, modelId, null), extraParams, args);
        }
        // Diagnostics: name the resolved model and the shape of the submission
        // so a failed job can be traced from the production log.
        const refCount = uploaded.filter(Boolean).length;
        onNotice?.(
          `Submitting image job via ${modelId} (resolution=${resMatch ?? resolution}, aspect_ratio=${wantAspect}, ` +
          `refs=${refCount}${refCount ? "" : " (text-only)"}, prompt=${fullPrompt.length} chars)`
        );
        const genMeta: LedgerGenMeta = {
          kind: "image",
          model: `${HIGGSFIELD_CLI_ID_PREFIX}${modelId}`,
          resolution,
          aspectRatio,
          // Best-effort submit-time credit quote for the ledger (usually a
          // cache hit — the renderer pre-probes this exact config for the
          // Generate button). Null when unreadable; the row then prices $0
          // like an unmatched rule instead of blocking the submit.
          credits: (await this.getGenerationCost({
            model: `${HIGGSFIELD_CLI_ID_PREFIX}${modelId}`, kind: "image",
            ...(resolution ? { resolution } : {}),
            aspectRatio: wantAspect,
            ...(quality ? { quality } : {}),
            ...(extraParams && Object.keys(extraParams).length ? { params: { ...extraParams } } : {}),
          })) ?? undefined,
          at: Date.now(),
          productionId: p.meta.id,
          shotId: shot?.id,
        };
        let done: { buf: Buffer; ext: string; jobId: string };
        try {
          done = await this.createAndWait(args, false, IMAGE_WAIT_TIMEOUT_MS);
        } catch (e) {
          // The job keeps rendering server-side — record it as pending so
          // the finished frame can be reclaimed instead of re-paid. Quality
          // and params ride along so the reclaim bills like the submit.
          if (e instanceof HiggsfieldCliPendingError) {
            const rec: PendingImageGen = {
              historyId: e.jobId, prompt, model: `${HIGGSFIELD_CLI_ID_PREFIX}${modelId}`,
              resolution, aspectRatio,
              ...(quality ? { quality } : {}),
              ...(extraParams && Object.keys(extraParams).length ? { params: { ...extraParams } } : {}),
              at: new Date().toISOString(),
            };
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

  /** Aspect ratios a detail declares (aspect_ratios list or aspect_ratio param).
   *  Internal (module-level normalizer shares it). */
  static aspectRatios(detail: CliModelDetail): string[] {
    const p = HiggsfieldCliProvider.param(detail, "aspect_ratio", "aspectratio");
    return p ? p.values : [];
  }

  /**
   * Recheck a pending image job and return the finished bytes, or null when
   * it's still rendering (or the result URL still can't be fetched). The
   * pending record's historyId carries the CLI job id. Throws when the job
   * reports FAILED/CANCELLED (nothing left to reclaim).
   */
  async recheckPendingImage(rec: PendingImageGen): Promise<Buffer | null> {
    if (rec.historyId) {
      if (!this.isAvailable()) return null;
      let out = "";
      try {
        out = await this.cli(["generate", "get", rec.historyId], IMAGE_RECHECK_TIMEOUT_MS);
      } catch {
        return null;
      }
      const { failed, status } = cliJobStatus(out);
      if (failed) throw new Error(`Higgsfield generation ${status.toLowerCase() || "failed"} (${rec.historyId.slice(0, 8)}…).`);
      const urls = cliResultUrls(out, false);
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

  /** The file extension to store a fetched clip under, from its source URL. */
  private videoExtFromUrl(url?: string): string {
    if (!url) return "mp4";
    try {
      return (path.extname(new URL(url).pathname) || ".mp4").replace(/^\./, "").toLowerCase() || "mp4";
    } catch {
      return "mp4";
    }
  }

  /**
   * Recheck a pending video job and return the finished clip bytes + extension,
   * or null when it's still rendering (or the result still can't be fetched).
   * With a `historyId` it re-asks `generate get`; with just a `url` it
   * re-fetches that. Throws when the job reports FAILED/CANCELLED.
   */
  async recheckPendingVideo(rec: PendingVideoGen): Promise<{ buf: Buffer; ext: string } | null> {
    if (rec.historyId) {
      if (!this.isAvailable()) return null;
      let out = "";
      try {
        out = await this.cli(["generate", "get", rec.historyId], VIDEO_RECHECK_TIMEOUT_MS);
      } catch {
        return null;
      }
      const { failed, status } = cliJobStatus(out);
      if (failed) throw new Error(`Higgsfield generation ${status.toLowerCase() || "failed"} (${rec.historyId.slice(0, 8)}…).`);
      const urls = cliResultUrls(out, true);
      const url = urls[0] ?? out.match(VIDEO_URL_RX)?.[0];
      if (!url) return null;
      const buf = await this.fetchBytes(url);
      return buf ? { buf, ext: this.videoExtFromUrl(url) } : null;
    }
    if (rec.url) {
      const buf = await this.fetchBytes(rec.url);
      return buf ? { buf, ext: this.videoExtFromUrl(rec.url) } : null;
    }
    return null;
  }

  /**
   * Generate one video clip for a shot. Mirrors the MCP generateVideoClip
   * contract (same args, same { rel } result): the source frame fills
   * `--start-image`, a tween end keyframe fills `--end-image`, and extra
   * image/video refs ride the repeatable `--image-references` /
   * `--video-references` flags the model accepts.
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
      throw new Error("The Higgsfield CLI isn't installed (no `higgsfield` binary found), so videos can't be generated through it.");
    }

    let items: CliListItem[] = [];
    try {
      items = await this.listRaw("video");
    } catch {
      items = [];
    }

    // References: the source frame(s) first, then extras, then @[name] tags —
    // the same assembly order the MCP transports use (tokens are @image1-based).
    const refs: { name: string; dataUrl: string }[] = [];
    if (frameRefs) {
      refs.push(frameRefs.start);
      if (frameRefs.end) refs.push(frameRefs.end);
    } else {
      const sourceRel = sourcePathOverride?.trim() || shot.artwork;
      if (!sourceRel) throw new Error("No source frame — pipe a frame into the video node or generate one first.");
      refs.push(HiggsfieldCliProvider.fileDataUrl(p, sourceRel, `Shot ${shot.number} frame`));
    }
    refs.push(...(extraRefs ?? []));
    const { resolved, extras } = resolvePromptRefs(p, opts.prompt, refs.length, true);
    refs.push(...extras);

    // Every video reference is downscaled to max 720p before upload (mirrors
    // the MCP transports) — including the start/end frames when they are video.
    for (const r of refs) {
      if (/^data:video\//i.test(r.dataUrl)) {
        try {
          r.dataUrl = await resizeVideoRef(r.dataUrl);
        } catch { /* fallback: original, logged as downscaled:false via wrapper */ }
      }
    }

    const modelId = await this.resolveVideoModel(opts.model, items, Boolean(frameRefs?.end));
    if (!modelId) throw new Error("The Higgsfield CLI listed no video models — sign in (`higgsfield auth login`) and retry.");
    const detail = await this.modelDetail(modelId).catch(() => null);
    const roles = detail ? HiggsfieldCliProvider.roles(detail) : [];
    const accepts = (cands: string[]): boolean =>
      !roles.length || roles.some((r) => cands.includes(r));

    const { paths, cleanup } = writeCliTempRefs(refs);
    const uploaded: (string | null)[] = [...paths];
    const fullPrompt = citePrompt(resolved, refs, uploaded, styleRefNames(p));
    try {
      const args = [modelId, "--prompt", fullPrompt];
      // Start frame: `--start-image`, falling back to `--image` on models
      // that only declare the legacy `image` role.
      const startPath = paths[0];
      if (startPath) {
        if (accepts(["startimage"])) args.push("--start-image", startPath);
        else if (accepts(["image"])) args.push("--image", startPath);
        else {
          uploaded[0] = null;
          emit(`Reference "${refs[0].name}" has nowhere to go on ${modelId} — continuing without it.`, "error");
        }
      }
      // End keyframe: `--end-image` ONLY for a real tween end frame. Models
      // without the slot still get both frames through the array fallback.
      // Every other ref rides the reference arrays, never the end slot.
      const endIsTween = Boolean(frameRefs?.end) && paths.length > 1 && paths[1];
      refs.forEach((r, i) => {
        if (i === 0) return;
        const f = paths[i];
        if (!f) return;
        const isVideo = /^data:video\//i.test(r.dataUrl);
        if (endIsTween && i === 1) {
          if (accepts(["endimage"])) {
            args.push("--end-image", f);
            return;
          }
          // Array fallback: the end frame rides the image references.
          if (accepts(["imagereferences", "image"])) {
            args.push("--image-references", f);
            return;
          }
          uploaded[i] = null;
          emit(`Reference "${r.name}" has nowhere to go on ${modelId} — continuing without it.`, "error");
          return;
        }
        if (isVideo) {
          if (accepts(["videoreferences", "video"])) {
            args.push("--video-references", f);
            return;
          }
          uploaded[i] = null;
          emit(`Video reference "${r.name}" isn't accepted by ${modelId} — continuing without it.`, "error");
          return;
        }
        if (accepts(["imagereferences", "image"])) {
          args.push("--image-references", f);
          return;
        }
        uploaded[i] = null;
        emit(`Reference "${r.name}" has nowhere to go on ${modelId} — continuing without it.`, "error");
      });

      // Schema-driven extras (genre, speedramp, batch_size, an explicit
      // mode, …) from the caller's params map. Runs before the seedance
      // guard so an explicit `mode` is already on argv when it is checked.
      if (detail && opts.params) {
        emitExtraParams(normalizeCliModelDetail(detail, null, modelId, null), opts.params, args);
      }

      // seedance_2_5 only carries media in `omni_reference` mode (`t2v`
      // accepts none) — select it whenever a media flag was attached,
      // unless the caller explicitly chose a mode.
      const hasMedia = args.some((a) =>
        ["--start-image", "--end-image", "--image", "--image-references", "--video", "--video-references", "--audio", "--audio-references"].includes(a)
      );
      if (modelId === "seedance_2_5" && hasMedia && !args.includes("--mode")) args.push("--mode", "omni_reference");

      // Fail loudly when the detail proves the model can't do the requested
      // length — silently coercing once turned a 2s tween block into a
      // longer clip with no warning. Unknown options still pass through.
      const durationSec = Math.round(opts.durationSec) || 5;
      const durParam = detail ? HiggsfieldCliProvider.param(detail, "duration", "length", "seconds") : null;
      if (durParam && durParam.values.length) {
        const nums = durParam.values
          .map((v) => Math.round(Number(String(v).replace(/[^0-9.]/g, ""))))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (nums.length && !nums.includes(durationSec)) {
          const sorted = [...new Set(nums)].sort((a, b) => a - b);
          throw new Error(`"${modelId}" doesn't support a ${durationSec}s clip (supports ${sorted.join(", ")}s) — retime the block or pick another model.`);
        }
      }
      args.push("--duration", String(durationSec));
      const resValues = detail ? (HiggsfieldCliProvider.param(detail, "resolution")?.values ?? []) : [];
      if (opts.resolution) {
        const want = String(opts.resolution).replace(/\s+/g, "").toLowerCase();
        const match = resValues.find((v) => String(v).replace(/\s+/g, "").toLowerCase() === want);
        if (match) args.push("--resolution", match);
      }
      const aspects = detail ? HiggsfieldCliProvider.aspectRatios(detail) : [];
      const paramAspect = opts.params?.aspect_ratio;
      const wantAspect = resolveAspectRatio(typeof paramAspect === "string" ? paramAspect : undefined);
      if (aspects.includes(wantAspect)) args.push("--aspect_ratio", wantAspect);

      // A fresh submission supersedes any earlier pending job.
      if (shot.pendingVideoGen) delete shot.pendingVideoGen;
      emit(`Shot ${shot.number}: submitting video job via ${modelId} (Higgsfield CLI)…`);
      let done: { buf: Buffer; ext: string; jobId: string };
      try {
        done = await this.createAndWait(args, true, VIDEO_WAIT_TIMEOUT_MS, (status) =>
          emit(`Shot ${shot.number}: video ${status.toLowerCase()}… still rendering.`, "info")
        );
      } catch (e) {
        // The job keeps rendering (or finished but couldn't be downloaded) —
        // record it as pending so the clip can be fetched instead of re-paid.
        if (e instanceof HiggsfieldCliPendingError) {
          shot.pendingVideoGen = {
            historyId: e.jobId,
            ...(e.url ? { url: e.url } : {}),
            prompt: opts.prompt,
            model: `${HIGGSFIELD_CLI_ID_PREFIX}${modelId}`,
            resolution: opts.resolution || "",
            durationSec,
            ...(opts.params && Object.keys(opts.params).length ? { params: { ...opts.params } } : {}),
            ...(sourcePathOverride?.trim() ? { sourcePath: sourcePathOverride.trim() } : {}),
            at: new Date().toISOString(),
          };
        }
        throw e;
      }

      const safeExt = /^[a-z0-9]{2,4}$/i.test(done.ext) ? done.ext : "mp4";
      const rel = writeShotVideo(p, shot, done.buf, safeExt);

      this.fireGeneration({
        kind: "video",
        model: `${HIGGSFIELD_CLI_ID_PREFIX}${modelId}`,
        resolution: opts.resolution || "",
        durationSec,
        // Best-effort submit-time credit quote (see the image path — usually
        // a cache hit from the renderer's pre-submit probe).
        credits: (await this.getGenerationCost({
          model: `${HIGGSFIELD_CLI_ID_PREFIX}${modelId}`, kind: "video",
          ...(opts.resolution ? { resolution: opts.resolution } : {}),
          durationSec,
          aspectRatio: wantAspect,
          ...(opts.params && Object.keys(opts.params).length ? { params: { ...opts.params } } : {}),
        })) ?? undefined,
        at: Date.now(),
        productionId: p.meta.id,
        shotId: shot.id,
      });

      return { rel };
    } finally {
      cleanup();
    }
  }

  /**
   * Edit one video: the source clip is mandatory and binds to the model's
   * video role; image/video references ride their arrays. Mirrors
   * `generateVideoClip`'s wait/save/record flow, but there is no start/end
   * frame pair and no duration (an edit keeps the source's timing).
   */
  async generateVideoEdit(
    p: Production,
    shot: ProductionShot,
    opts: VideoGenOptions,
    emit: ProviderEmit,
    sourceVideoPath: string,
    extraRefs?: { name: string; dataUrl: string }[]
  ): Promise<{ rel: string }> {
    if (!this.isAvailable()) {
      throw new Error("The Higgsfield CLI isn't installed (no `higgsfield` binary found), so videos can't be edited through it.");
    }
    const sourceRel = sourceVideoPath?.trim();
    if (!sourceRel) throw new Error("The edit-video node needs a source video — pipe a clip in, pick a video reference, or generate a clip first.");

    let items: CliListItem[] = [];
    try {
      items = await this.listRaw("video");
    } catch {
      items = [];
    }

    // The source video leads the reference array (cited as @video1), then the
    // caller's extra refs, then any @[name] tags in the prompt.
    const refs: { name: string; dataUrl: string }[] = [
      HiggsfieldCliProvider.fileDataUrl(p, sourceRel, `Shot ${shot.number} source video`),
    ];
    refs.push(...(extraRefs ?? []));
    const { resolved, extras } = resolvePromptRefs(p, opts.prompt, refs.length, true);
    refs.push(...extras);

    // Every video reference (including the source) is downscaled to max 720p
    // before upload, the same ceiling the generate path uses.
    for (const r of refs) {
      if (/^data:video\//i.test(r.dataUrl)) {
        try {
          r.dataUrl = await resizeVideoRef(r.dataUrl);
        } catch { /* fallback: original */ }
      }
    }

    const modelId = await this.resolveVideoModel(opts.model, items, false);
    if (!modelId) throw new Error("The Higgsfield CLI listed no video models — sign in (`higgsfield auth login`) and retry.");
    const detail = await this.modelDetail(modelId).catch(() => null);
    const roles = detail ? HiggsfieldCliProvider.roles(detail) : [];
    const accepts = (cands: string[]): boolean => !roles.length || roles.some((r) => cands.includes(r));

    const { paths, cleanup } = writeCliTempRefs(refs);
    const uploaded: (string | null)[] = [...paths];
    const fullPrompt = citePrompt(resolved, refs, uploaded, styleRefNames(p));
    try {
      const args = [modelId, "--prompt", fullPrompt];
      const srcPath = paths[0];
      if (!srcPath) throw new Error("Couldn't load the source video.");
      if (accepts(["videoreferences", "video"])) args.push("--video-references", srcPath);
      else throw new Error(`"${modelId}" doesn't accept a video input — pick an edit-video model.`);

      refs.forEach((r, i) => {
        if (i === 0) return;
        const f = paths[i];
        if (!f) return;
        const isVideo = /^data:video\//i.test(r.dataUrl);
        if (isVideo && accepts(["videoreferences", "video"])) args.push("--video-references", f);
        else if (!isVideo && accepts(["imagereferences", "image"])) args.push("--image-references", f);
        else {
          uploaded[i] = null;
          emit(`Reference "${r.name}" has nowhere to go on ${modelId} — continuing without it.`, "error");
        }
      });

      if (detail && opts.params) {
        emitExtraParams(normalizeCliModelDetail(detail, null, modelId, null), opts.params, args);
      }

      const durationSec = Math.round(opts.durationSec) || 0;
      const durParam = detail ? HiggsfieldCliProvider.param(detail, "duration", "length", "seconds") : null;
      if (durParam && durParam.values.length && durationSec > 0) {
        const nums = durParam.values
          .map((v) => Math.round(Number(String(v).replace(/[^0-9.]/g, ""))))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (nums.length && !nums.includes(durationSec)) {
          const sorted = [...new Set(nums)].sort((a, b) => a - b);
          throw new Error(`"${modelId}" doesn't support a ${durationSec}s clip (supports ${sorted.join(", ")}s).`);
        }
        args.push("--duration", String(durationSec));
      }
      const resValues = detail ? (HiggsfieldCliProvider.param(detail, "resolution")?.values ?? []) : [];
      if (opts.resolution) {
        const want = String(opts.resolution).replace(/\s+/g, "").toLowerCase();
        const match = resValues.find((v) => String(v).replace(/\s+/g, "").toLowerCase() === want);
        if (match) args.push("--resolution", match);
      }
      const aspects = detail ? HiggsfieldCliProvider.aspectRatios(detail) : [];
      const paramAspect = opts.params?.aspect_ratio;
      const wantAspect = resolveAspectRatio(typeof paramAspect === "string" ? paramAspect : undefined);
      if (aspects.includes(wantAspect)) args.push("--aspect_ratio", wantAspect);

      // A fresh submission supersedes any earlier pending job.
      if (shot.pendingVideoGen) delete shot.pendingVideoGen;
      emit(`Shot ${shot.number}: submitting video-edit job via ${modelId} (Higgsfield CLI)…`);
      let done: { buf: Buffer; ext: string; jobId: string };
      try {
        done = await this.createAndWait(args, true, VIDEO_WAIT_TIMEOUT_MS, (status) =>
          emit(`Shot ${shot.number}: video edit ${status.toLowerCase()}… still rendering.`, "info")
        );
      } catch (e) {
        // Same contingency as the generate path — keep the job for a fetch.
        if (e instanceof HiggsfieldCliPendingError) {
          shot.pendingVideoGen = {
            historyId: e.jobId,
            ...(e.url ? { url: e.url } : {}),
            prompt: opts.prompt,
            model: `${HIGGSFIELD_CLI_ID_PREFIX}${modelId}`,
            resolution: opts.resolution || "",
            ...(durationSec > 0 ? { durationSec } : {}),
            ...(opts.params && Object.keys(opts.params).length ? { params: { ...opts.params } } : {}),
            sourcePath: sourceRel,
            at: new Date().toISOString(),
          };
        }
        throw e;
      }

      const safeExt = /^[a-z0-9]{2,4}$/i.test(done.ext) ? done.ext : "mp4";
      const rel = writeShotVideo(p, shot, done.buf, safeExt, "edit");

      this.fireGeneration({
        kind: "video",
        model: `${HIGGSFIELD_CLI_ID_PREFIX}${modelId}`,
        resolution: opts.resolution || "",
        durationSec: durationSec || undefined,
        // Best-effort submit-time credit quote (see the image path). An edit
        // keeps the source's timing, so no duration travels when the submit
        // sends none — the quote prices the same flag set.
        credits: (await this.getGenerationCost({
          model: `${HIGGSFIELD_CLI_ID_PREFIX}${modelId}`, kind: "video",
          ...(opts.resolution ? { resolution: opts.resolution } : {}),
          ...(durationSec > 0 ? { durationSec } : {}),
          aspectRatio: wantAspect,
          ...(opts.params && Object.keys(opts.params).length ? { params: { ...opts.params } } : {}),
        })) ?? undefined,
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

/** Thrown when a CLI wait cap passes with the job still rendering, or when a
 *  finished job's result URL couldn't be downloaded. The work is NOT dead — it
 *  keeps rendering (or stays published) server-side — so callers record the
 *  jobId (and URL) as pending and reclaim it with `generate get`/a re-fetch
 *  later. */
export class HiggsfieldCliPendingError extends Error {
  constructor(readonly jobId: string, readonly url?: string) {
    super(`Higgsfield generation timed out (${jobId.slice(0, 8)}…).`);
    this.name = "HiggsfieldCliPendingError";
  }
}

/** The CLI transport status for Settings (binary, version, auth). Read-only:
 *  `version` never needs auth; `account status` proves the login. */
export interface HiggsfieldCliStatusInfo {
  binary: string | null;
  version: string | null;
  authenticated: boolean;
  account: string | null;
}

export async function getHiggsfieldCliStatus(binary: string | null, run?: CliRun): Promise<HiggsfieldCliStatusInfo> {
  if (!binary) return { binary: null, version: null, authenticated: false, account: null };
  const runCli = run ?? defaultCliRun(binary);
  let version: string | null = null;
  try {
    const v = await runCli(["version"], { timeoutMs: 15_000 });
    if (v.code === 0) version = v.stdout.trim().split(/\r?\n/)[0]?.slice(0, 120) || null;
  } catch { /* leave null */ }
  try {
    const a = await runCli(["account", "status", "--json", "--no-color"], { timeoutMs: 30_000 });
    if (a.code === 0) {
      const obj = parseJsonLooseObject(a.stdout);
      const account = obj
        ? strField(obj as Record<string, unknown>, "email", "account", "user") || null
        : null;
      return { binary, version, authenticated: true, account };
    }
  } catch { /* not authenticated */ }
  return { binary, version, authenticated: false, account: null };
}
