/**
 * model-schema — the provider-neutral option-schema grammar.
 *
 * Every media vendor describes its model parameters differently (the
 * Higgsfield CLI's `model get --json`, Higgsfield MCP's catalog `parameters`,
 * OpenArt's form-schema properties). They all normalize into one
 * `RawModelParam` list here, and `buildModelSchema` turns that into the typed
 * `CliModelSchema` the options form renders and the CLI arg builder emits.
 *
 * Grouping rules live here (one concept, one module): media roles → reference;
 * a control set → control; an advanced set → advanced; everything else core.
 * The GPT Image 2.5 `--variant` submodel is the one name-based promotion.
 */
import type {
  CliModelSchema,
  CliOptionEmit,
  CliOptionField,
  CliOptionGroup,
  CliOptionKind,
} from "../../shared/ipc.js";

/** One provider parameter in the neutral shape. */
export interface RawModelParam {
  /** Flag/name as the provider prints it (`aspect_ratio`, `--variant`). */
  name: string;
  /** Declared type string ("integer", "array", "object|null", …). */
  type?: string;
  /** Closed value set, when the provider publishes one. */
  options?: Array<string | number | boolean>;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  /** True when the provider marks the slot as a media role. */
  media?: boolean;
  /** Known reference-array cap for this provider/model. */
  maxItems?: number;
}

export interface BuildModelSchemaInput {
  jobType: string;
  cliVersion?: string | null;
  params: RawModelParam[];
  roles?: string[];
  aspectRatios?: string[];
  durations?: number[];
  raw?: unknown;
}

/** Lowercase, separator-folded name (`end-image` ≡ `end_image`). */
export function foldName(s: string): string {
  return s.toLowerCase().replace(/[_-]+/g, "");
}

/** Param names that carry media (never emitted generically — the reference
 *  router owns them). Folded, separator-free. */
export const MEDIA_PARAM_RX = /^(startimage|endimage|image|video|audio|(image|video|audio)references?)$/;

/** Param names in the "control" form group (folded). */
const CONTROL_PARAMS = new Set([
  "camera_style", "camerastyle",
  "color_grading", "colorgrading",
  "light_scheme", "lightscheme",
  "style_prompt", "styleprompt",
  "speedramp", "slow_motion", "slowmotion",
  "genre", "mode",
  "multi_shot_mode", "multishotmode",
  "multi_shots", "multishots",
  "multi_prompt", "multiprompt",
  "cfg_scale", "cfgscale",
  "sound", "generate_audio", "generateaudio",
  "background",
]);

/** Param names in the "advanced" form group (folded). */
const ADVANCED_PARAMS = new Set([
  "batch_size", "batchsize",
  "seed", "enhance_prompt", "enhanceprompt",
  "prompt_language", "promptlanguage",
  "preset_id", "presetid",
  "bitrate_mode", "bitratemode",
]);

/** Flags the image/video emission blocks already own (dedicated controls). */
export const OWNED_FLAGS = new Set([
  "prompt", "resolution", "res", "quality",
  "duration", "length", "seconds",
  "aspect_ratio", "aspectratio",
]);

/** Known reference-array caps by job type. Unknown models leave it undefined. */
export function modelOptionMaxItems(jobType: string, foldedName: string): number | undefined {
  const jt = foldName(jobType);
  if (/references?$/.test(foldedName)) {
    if (jt.includes("gptimage")) return 16;
    if (jt.includes("cinematicstudio")) return 15;
  }
  return undefined;
}

/** Classify a parameter into its option kind. Closed sets are enums; the
 *  declared type decides otherwise; unknown shapes fall through to "string"
 *  (never throws — provider schema drift guard). */
export function modelOptionKind(
  foldedName: string,
  type: string | undefined,
  hasValues: boolean,
  isMedia: boolean
): CliOptionKind {
  if (hasValues) return "enum";
  if (isMedia || MEDIA_PARAM_RX.test(foldedName)) return "array";
  const t = (type ?? "").toLowerCase();
  if (/int/.test(t)) return "integer";
  if (/float|double|number|decimal/.test(t)) return "number";
  if (/bool/.test(t)) return "boolean";
  if (/array|list/.test(t)) return "array";
  if (/object|json|dict/.test(t)) return "json";
  return "string";
}

/** The form group a parameter belongs to. */
export function modelOptionGroup(foldedName: string): CliOptionGroup {
  if (MEDIA_PARAM_RX.test(foldedName)) return "reference";
  if (CONTROL_PARAMS.has(foldedName)) return "control";
  if (ADVANCED_PARAMS.has(foldedName)) return "advanced";
  return "core";
}

export function modelOptionEmit(kind: CliOptionKind): CliOptionEmit {
  if (kind === "boolean") return "boolean-flag";
  if (kind === "array") return "repeat";
  if (kind === "json") return "json-file";
  return "value";
}

function aliasesFor(foldedName: string, rawName: string | undefined): string[] {
  const out = new Set<string>([foldedName]);
  if (rawName) {
    const lower = rawName.toLowerCase();
    out.add(lower);
    out.add(foldName(rawName));
    out.add(lower.replace(/_/g, "-"));
    out.add(lower.replace(/-/g, "_"));
  }
  return [...out].filter(Boolean);
}

const GROUP_ORDER: CliOptionGroup[] = ["core", "reference", "control", "advanced"];

/** Whether an option name is the GPT Image 2.5 exposed submodel. */
function isGptImageVariant(jobType: string, foldedName: string): boolean {
  return foldedName === "variant" && /gptimage/.test(foldName(jobType));
}

/**
 * Build the normalized, ordered schema from neutral params. Total — never
 * throws on unrecognized shapes (unknowns become free-text strings).
 */
export function buildModelSchema(input: BuildModelSchemaInput): CliModelSchema {
  const { jobType, cliVersion = null, params, roles = [], aspectRatios = [], durations = [], raw } = input;
  const fields: CliOptionField[] = [];
  for (const p of params) {
    const rawName = (p.name ?? "").trim();
    if (!rawName) continue;
    const foldedName = foldName(rawName);
    // "prompt" is the positional generation text, not an option.
    if (foldedName === "prompt") continue;
    const hasValues = Array.isArray(p.options) && p.options.length > 0;
    const isMedia = p.media === true || MEDIA_PARAM_RX.test(foldedName);
    const values = hasValues
      ? Array.from(new Set((p.options ?? []).map((v) => String(v).trim()).filter(Boolean)))
      : [];
    const kind = modelOptionKind(foldedName, p.type, values.length > 0, isMedia);
    const flag = rawName.replace(/^--/, "").replace(/\s+/g, "_") || foldedName;
    const repeatable = isMedia
      ? /s$|references?/.test(foldedName) || /array|list/.test((p.type ?? "").toLowerCase())
      : kind === "array";
    const defRaw = p.default === undefined || p.default === null ? "" : String(p.default).trim();
    let def: string | number | boolean | string[] | null = null;
    if (defRaw) {
      if (kind === "integer" || kind === "number") {
        const n = Number(defRaw);
        def = Number.isFinite(n) ? n : defRaw;
      } else if (kind === "boolean") {
        def = /^(true|1|yes|on)$/i.test(defRaw) ? true : /^(false|0|no|off)$/i.test(defRaw) ? false : defRaw;
      } else {
        def = defRaw;
      }
    }
    let group = modelOptionGroup(foldedName);
    // `--variant` is the exposed submodel for GPT Image 2.5 only; on every
    // other model (e.g. flux_2) it is an occasional advanced knob.
    if (foldedName === "variant" && group === "core" && !isGptImageVariant(jobType, foldedName)) {
      group = "advanced";
    }
    const field: CliOptionField = {
      name: foldedName,
      flag,
      aliases: aliasesFor(foldedName, rawName),
      kind,
      group,
      values: values.length ? values : undefined,
      default: def,
      min: p.min,
      max: p.max,
      step: p.step,
      required: p.required ? true : false,
      mediaRole: isMedia ? flag : undefined,
      repeatable,
      maxItems: p.maxItems ?? modelOptionMaxItems(jobType, foldedName),
      emit: modelOptionEmit(kind),
      source: "parameters",
    };
    // Seedance's media rule is structural knowledge worth surfacing inline.
    if (foldName(jobType) === "seedance25" && foldedName === "mode") {
      field.constraint = "Media attachments require omni_reference mode (t2v accepts none).";
    }
    fields.push(field);
  }
  fields.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  return {
    jobType,
    cliVersion,
    fetchedAt: Date.now(),
    fields,
    aspectRatios,
    durations,
    roles,
    raw,
  };
}

/** Key one parameter's placement override (`<model id>::<flag>`). */
export function exposureKey(modelId: string, flag: string): string {
  return `${modelId}::${flag}`;
}

/**
 * Apply the dev customizer's per-parameter placements to a schema: hidden
 * fields drop out; core/advanced move a field between the exposed list and
 * the Advanced panel. Dedicated (owned) and media/reference fields are
 * locked — their dedicated controls own them. Never throws.
 */
export function applyOptionExposure(
  schema: CliModelSchema,
  modelId: string,
  exposure: Record<string, "core" | "advanced" | "hidden">
): CliModelSchema {
  if (!exposure || !Object.keys(exposure).length) return schema;
  const fields: CliOptionField[] = [];
  for (const f of schema.fields) {
    if (f.mediaRole || f.group === "reference" || OWNED_FLAGS.has(foldName(f.flag)) || OWNED_FLAGS.has(f.name)) {
      fields.push(f);
      continue;
    }
    const override = exposure[exposureKey(modelId, f.flag)] ?? exposure[exposureKey(modelId, f.name)];
    if (override === "hidden") continue;
    if (override === "core" || override === "advanced") fields.push({ ...f, group: override });
    else fields.push(f);
  }
  fields.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  return { ...schema, fields };
}
