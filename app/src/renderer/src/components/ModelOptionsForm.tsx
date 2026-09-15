import { useMemo, useState } from "react";
import {
  DEFAULT_ASPECT_RATIO,
  resolveAspectRatio,
  type CliModelSchema,
  type CliOptionField,
  type CliOptionGroup,
  type ImageModelOptions,
  type ModelParamOption,
  type VideoModelOptions,
} from "../../../shared/ipc.js";
import { usePersistedCollapsed } from "./production/persisted-state.js";

/** Schema-driven option values, keyed by canonical flag name. Matches
 *  `OpenArtBoardConfig.params` / `VideoGenOptions.params`. */
export type ModelOptionValues = Record<string, string | number | boolean | string[]>;

interface ModelOptionsFormProps {
  /** Full provider schema (Higgsfield CLI). Preferred when present. */
  schema?: CliModelSchema | null;
  /** A pre-built field list (used by surfaces that derive fields from the
   *  provider's `imageModelOptions`/`videoModelOptions`). */
  fields?: CliOptionField[];
  value: ModelOptionValues;
  onChange: (next: ModelOptionValues) => void;
  /** Compact variant for modals (tighter groups, no section headers). */
  compact?: boolean;
  /** Field flags the caller renders with its own dedicated control
   *  (e.g. resolution/quality/duration) — skipped here so a value is never
   *  editable in two places. Compared case-insensitively, separators folded. */
  exclude?: string[];
  /** localStorage key persisting the Advanced panel's collapsed state. */
  persistKey?: string;
  /** Which section(s) to render. The default renders both; a caller that wants
   *  exposed controls on one row and the Advanced panel on the next mounts two
   *  instances (same controlled `value`) with `"exposed"` and `"advanced"`. */
  render?: "all" | "exposed" | "advanced";
}

/** Fold a flag for exclusion/identity comparisons (`aspect_ratio` ≡ `aspectRatio`). */
const foldKey = (s: string): string => s.toLowerCase().replace(/[_-]+/g, "");

/** True when an aspect-ratio field (either spelling). */
const isAspectField = (f: CliOptionField): boolean => foldKey(f.flag) === "aspectratio";

/** Build the exposed/advanced field list from a provider's ladder options
 *  (the OpenArt path and any surface without a full schema). Exposed fields
 *  are aspect ratio, resolution, quality, and the model's submodel; every
 *  `ModelParamOption` follows its own `exposure`. */
export function optionFieldsFromModelOptions(
  opts: (ImageModelOptions | VideoModelOptions) | null,
  kind: "image" | "video"
): CliOptionField[] {
  if (!opts) return [];
  const img = opts as ImageModelOptions;
  const fields: CliOptionField[] = [];
  const pk = (name: string) => ({ name: foldKey(name), flag: name, aliases: [foldKey(name)] });
  const ratios = opts.aspectRatios ?? [];
  if (ratios.length) {
    fields.push({
      ...pk("aspect_ratio"), kind: "enum", group: "core", values: ratios,
      default: ratios.includes(DEFAULT_ASPECT_RATIO) ? DEFAULT_ASPECT_RATIO : undefined,
      emit: "value", source: "parameters", constraint: "Default 16:9.",
    });
  }
  const resolutions = opts.resolutions ?? [];
  if (resolutions.length) {
    fields.push({
      ...pk("resolution"), kind: "enum", group: "core", values: resolutions,
      default: img.defaultResolution, emit: "value", source: "parameters",
    });
  }
  const qualities = opts.qualities ?? [];
  if (qualities.length) {
    fields.push({
      ...pk("quality"), kind: "enum", group: "core", values: qualities,
      default: opts.defaultQuality ?? undefined, emit: "value", source: "parameters",
    });
  }
  const submodels = kind === "image" ? (img.submodels ?? []) : [];
  if (submodels.length) {
    fields.push({
      ...pk("variant"), kind: "enum", group: "core", values: submodels,
      default: img.defaultSubmodel, emit: "value", source: "parameters",
    });
  }
  for (const p of (opts.params ?? []) as ModelParamOption[]) {
    fields.push({
      name: foldKey(p.key), flag: p.flag.replace(/^--/, ""), aliases: [foldKey(p.key)],
      kind: "enum", group: p.exposure === "advanced" ? "advanced" : "core",
      values: p.values, default: p.defaultValue, emit: "value", source: "parameters",
    });
  }
  return fields;
}

/** Field labels read better than raw flags (`aspect_ratio` → "Aspect ratio"). */
function fieldLabel(f: CliOptionField): string {
  return f.flag
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The effective value for a field: explicit pick, else the schema default,
 *  else unset ("Default" — the vendor default applies). Aspect ratio uses the
 *  shared 16:9 default instead of the vendor's (usually 1:1). */
function fieldValue(f: CliOptionField, values: ModelOptionValues): string {
  const keys = [f.flag, f.name, ...f.aliases];
  for (const k of keys) {
    const v = values[k];
    if (v !== undefined && v !== null && v !== "") {
      return Array.isArray(v) ? v.join(", ") : String(v);
    }
  }
  if (isAspectField(f)) return resolveAspectRatio(undefined);
  if (f.default !== undefined && f.default !== null && f.default !== "") {
    return Array.isArray(f.default) ? f.default.join(", ") : String(f.default);
  }
  return "";
}

/** Drop keys the new schema doesn't declare (model switch) so stale
 *  selections never ride into the next submission. The generic arg builder
 *  also ignores them — this just keeps the persisted map clean. */
export function pruneModelOptionValues(
  schema: CliModelSchema | null,
  values: ModelOptionValues
): ModelOptionValues {
  if (!schema) return values;
  const known = new Set<string>();
  for (const f of schema.fields) {
    known.add(f.flag.toLowerCase());
    known.add(f.name.toLowerCase());
    for (const a of f.aliases) known.add(a.toLowerCase());
  }
  const out: ModelOptionValues = {};
  for (const [k, v] of Object.entries(values)) {
    if (known.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function setField(
  f: CliOptionField,
  raw: string,
  values: ModelOptionValues,
  onChange: (next: ModelOptionValues) => void
): void {
  const next: ModelOptionValues = { ...values };
  // Clearing a control removes the key so the vendor default applies.
  if (!raw.trim() && f.kind !== "boolean") {
    delete next[f.flag];
    delete next[f.name];
    for (const a of f.aliases) delete next[a];
    onChange(next);
    return;
  }
  let parsed: string | number | boolean | string[] = raw;
  if (f.kind === "integer" || f.kind === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return; // keep the last good value
    parsed = f.kind === "integer" ? Math.round(n) : n;
  } else if (f.kind === "array") {
    parsed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  next[f.flag] = parsed;
  onChange(next);
}

function FieldControl({
  f,
  values,
  onChange,
}: {
  f: CliOptionField;
  values: ModelOptionValues;
  onChange: (next: ModelOptionValues) => void;
}) {
  const current = fieldValue(f, values);
  const title = f.constraint ?? (f.default !== undefined && f.default !== null && f.default !== ""
    ? `Default: ${Array.isArray(f.default) ? f.default.join(", ") : String(f.default)}`
    : fieldLabel(f));

  if (f.kind === "enum" || f.kind === "boolean") {
    const options = f.kind === "boolean" ? ["true", "false"] : (f.values ?? []);
    const matched = options.find((o) => o.toLowerCase() === current.toLowerCase());
    return (
      <label className="prod-openart-label" title={title}>
        {fieldLabel(f)}
        <select
          className="prod-openart-select prod-model-option-select"
          value={matched ?? ""}
          onChange={(e) => setField(f, e.target.value, values, onChange)}
        >
          <option value="">Default{current && !matched ? ` (${current})` : ""}</option>
          {options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </label>
    );
  }

  if (f.kind === "integer" || f.kind === "number") {
    return (
      <label className="prod-openart-label" title={title}>
        {fieldLabel(f)}
        <input
          className="prod-openart-select prod-model-option-input"
          type="number"
          value={current}
          placeholder={f.default !== undefined && f.default !== null ? String(f.default) : ""}
          min={f.min}
          max={f.max}
          step={f.step ?? (f.kind === "integer" ? 1 : "any")}
          onChange={(e) => setField(f, e.target.value, values, onChange)}
        />
      </label>
    );
  }

  if (f.kind === "json") {
    return (
      <label className="prod-openart-label prod-model-option-wide" title={title}>
        {fieldLabel(f)}
        <textarea
          className="prod-openart-select prod-model-option-json"
          rows={2}
          value={current}
          placeholder='JSON, e.g. {"key": "value"}'
          onChange={(e) => setField(f, e.target.value, values, onChange)}
        />
      </label>
    );
  }

  // string + array (comma-separated) share the text control.
  return (
    <label className="prod-openart-label" title={title}>
      {fieldLabel(f)}
      <input
        className="prod-openart-select prod-model-option-input"
        type="text"
        value={current}
        placeholder={f.kind === "array" ? "comma-separated" : (f.default !== undefined && f.default !== null ? String(f.default) : "")}
        onChange={(e) => setField(f, e.target.value, values, onChange)}
      />
    </label>
  );
}

/**
 * Renders one model's live option surface: exposed controls (resolution,
 * aspect ratio, quality, GPT Image 2.5 submodel) at the top level, with every
 * remaining param behind a collapsible, persisted "Advanced" panel. Reference
 * fields (media roles) are skipped — the existing reference pickers and
 * submit-path routing own them. A null/empty surface renders nothing.
 */
export function ModelOptionsForm({
  schema,
  fields,
  value,
  onChange,
  compact,
  exclude,
  persistKey,
  render = "all",
}: ModelOptionsFormProps) {
  const excludeKeys = useMemo(() => new Set((exclude ?? []).map(foldKey)), [exclude]);
  const all = useMemo(() => {
    const source = fields ?? schema?.fields ?? [];
    return source.filter((f) => {
      if (f.mediaRole) return false;
      if (f.name === "prompt") return false;
      if (excludeKeys.has(foldKey(f.flag)) || excludeKeys.has(foldKey(f.name))) return false;
      return true;
    });
  }, [schema, fields, excludeKeys]);
  const exposed = useMemo(() => all.filter((f) => f.group === "core"), [all]);
  const advanced = useMemo(
    () => all.filter((f) => f.group === "control" || f.group === "advanced"),
    [all]
  );
  const [advancedCollapsed, setAdvancedCollapsed] = usePersistedCollapsed(
    persistKey ?? "cascade.modelOptions.advanced",
    true
  );
  // Without a persist key the shelf still collapses by default, but locally.
  const [localCollapsed, setLocalCollapsed] = useState(true);
  const collapsed = persistKey ? advancedCollapsed : localCollapsed;
  const toggleAdvanced = () => (persistKey ? setAdvancedCollapsed(!collapsed) : setLocalCollapsed((v) => !v));

  if (all.length === 0) return null;
  const showExposed = render !== "advanced" && exposed.length > 0;
  const showAdvanced = render !== "exposed" && advanced.length > 0;
  if (!showExposed && !showAdvanced) return null;
  const panelId = `model-options-advanced-${(persistKey ?? "local").replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  return (
    <div className={`prod-model-options${compact ? " prod-model-options-compact" : ""}`}>
      {showExposed && (
        <div className="prod-model-options-fields">
          {exposed.map((f) => (
            <FieldControl key={f.flag} f={f} values={value} onChange={onChange} />
          ))}
        </div>
      )}
      {showAdvanced && (
        <div className="prod-model-options-advanced">
          <button
            type="button"
            className="prod-model-options-advanced-head"
            aria-expanded={!collapsed}
            aria-controls={panelId}
            title={collapsed ? "Show advanced model options" : "Hide advanced model options"}
            onClick={toggleAdvanced}
          >
            <svg className={"prod-model-options-caret" + (collapsed ? " collapsed" : "")} viewBox="0 0 16 16" width="9" height="9" aria-hidden="true"><path d="M5 3l6 5-6 5V3z" fill="currentColor" /></svg>
            <span>Advanced</span>
          </button>
          <div id={panelId} className="prod-model-options-fields" hidden={collapsed}>
            {!collapsed && advanced.map((f) => (
              <FieldControl key={f.flag} f={f} values={value} onChange={onChange} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
