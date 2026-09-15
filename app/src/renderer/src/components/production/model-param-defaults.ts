/**
 * Per-surface media-model parameter defaults (dev Model Customizer): each
 * model can carry default values for its parameters per surface
 * (`image:generate`, `video:generate`, …, see `ModelSurface`). Generation
 * surfaces seed their params from here when a model loads — the user's saved
 * per-shot/per-node value always wins, and only keys the model's live schema
 * declares (non-media) are seeded, so a stale default from another model or
 * vendor never leaks in.
 *
 * Settings-backed and cached like `media-defaults.ts`: the workspace primes the
 * cache on mount; the customizer writes through optimistically so a default
 * just set seeds the next surface immediately.
 */
import type {
  CascadeApi,
  CliModelSchema,
  ModelParamDefaultValue,
  ModelSurface,
} from "../../../../shared/ipc.js";
import type { ModelOptionValues } from "../ModelOptionsForm.js";

export type ModelParamDefaults = Record<string, ModelParamDefaultValue>;

let cache: ModelParamDefaults = {};
let primed = false;

/** The IPC surface, when it exists (test harnesses stub a subset — the
 *  helpers degrade to cache-only instead of throwing). Reads both the global
 *  and `window.cascade`, since jsdom tests stub the latter while the real
 *  renderer's `globalThis` IS `window`. */
function cascade(): Pick<CascadeApi, "getModelParamDefaults" | "setModelParamDefault"> | null {
  const g = globalThis as { cascade?: unknown; window?: { cascade?: unknown } };
  const c = (g.cascade ?? g.window?.cascade) as CascadeApi | undefined;
  return c && typeof c.getModelParamDefaults === "function" ? c : null;
}

/** The storage key one default lives under. `modelId` is namespaced (its
 *  single `:`s are fine); `::` is the separator, as in `exposureKey`. */
export function paramDefaultKey(modelId: string, surface: ModelSurface, flag: string): string {
  return `${modelId}::${surface}::${flag}`;
}

/** Warm the cache from settings. Idempotent; safe to call on every mount and
 *  provider switch. Resolves once the cache is populated. */
export function primeModelParamDefaults(): Promise<void> {
  const c = cascade();
  if (!c) {
    primed = true;
    return Promise.resolve();
  }
  return c
    .getModelParamDefaults()
    .then((d) => {
      cache = d ?? {};
      primed = true;
    })
    .catch(() => {
      primed = true;
    });
}

/** One model's configured defaults for one surface, keyed by flag. */
export function getParamDefaults(modelId: string, surface: ModelSurface): ModelParamDefaults {
  if (!primed) void primeModelParamDefaults();
  const prefix = `${modelId}::${surface}::`;
  const out: ModelParamDefaults = {};
  for (const [k, v] of Object.entries(cache)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

/** Optimistic cache write for the customizer + fire-and-forget persist. */
export function rememberModelParamDefault(key: string, value: ModelParamDefaultValue | null): void {
  cache = { ...cache };
  if (value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length)) {
    delete cache[key];
  } else {
    cache[key] = value;
  }
  const c = cascade();
  if (c) void Promise.resolve(c.setModelParamDefault(key, value)).catch(() => {});
}

const hasValue = (v: ModelOptionValues[string] | undefined): boolean =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

/**
 * Seed a params map with the model's per-surface defaults: the user's stored
 * values always win, and only fields the schema declares (skipping media roles
 * and references, which the reference router owns) are seeded. Returns the
 * input unchanged when the model has no configured defaults.
 */
export function seedModelOptionValues(
  schema: CliModelSchema | null | undefined,
  modelId: string,
  surface: ModelSurface,
  values: ModelOptionValues
): ModelOptionValues {
  if (!schema || !modelId) return values;
  const defaults = getParamDefaults(modelId, surface);
  if (!Object.keys(defaults).length) return values;
  let changed = false;
  const out: ModelOptionValues = { ...values };
  for (const f of schema.fields) {
    if (f.mediaRole || f.group === "reference") continue;
    const keys = [f.flag, f.name, ...f.aliases];
    if (keys.some((k) => hasValue(out[k]))) continue;
    const key = keys.find((k) => k in defaults);
    if (key) {
      out[f.flag] = defaults[key];
      changed = true;
    }
  }
  return changed ? out : values;
}
