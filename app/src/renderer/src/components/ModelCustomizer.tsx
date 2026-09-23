/**
 * Dev Model Customizer — a full-window page (visible in Dev Mode only) that
 * probes every media vendor (MCP + CLI), lists its models grouped by
 * image/video, and lets the user hide whole models, correct their kind, drag
 * them into order, mark end-frame support, and place each individual
 * parameter in the Core list, the Advanced panel, or hide it entirely.
 *
 * All customization is written to the existing global settings stores, so the
 * generation dropdowns and options forms follow it everywhere. Probes are
 * read-only and cached vendor-side; "Refresh" drops the caches. The model
 * list pane is resizable (persisted) to read long model names.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CliModelSchema,
  CliOptionField,
  ExpensePriceRule,
  MediaModelLadder,
  MediaProviderId,
  MediaProviderInfo,
  ModelParamDefaultValue,
  ModelParamExposure,
  ModelProbeEntry,
  ModelProbeResult,
  ModelSurface,
} from "../../../shared/ipc.js";
import { isImageModel, isVideoModel } from "../../../shared/ipc.js";
import { EyeIcon, EyeOffIcon, ImportIcon, XIcon } from "./icons.js";
import { paramDefaultKey, primeModelParamDefaults, rememberModelParamDefault } from "./production/model-param-defaults.js";

/** Dedicated flags the options form renders with its own control; the dev
 *  page shows them read-only ("dedicated"). Mirrors OWNED_FLAGS main-side. */
const DEDICATED = new Set([
  "prompt", "resolution", "res", "quality", "duration", "length", "seconds", "aspect_ratio", "aspectratio",
]);

type Placement = "default" | "core" | "advanced" | "hidden";
type Kind = "image" | "video" | "other";

const PANEL_MIN = 260;
const PANEL_MAX = 900;
const PANEL_KEY = "cascade.modelCustomizer.panelWidth";

/** Surface checkboxes, per modality. Pickers that share a model pool share a
 *  surface, so each is a single checkbox. */
const IMAGE_SURFACES: [ModelSurface, string][] = [
  ["image:generate", "Generation"],
  ["image:edit", "Edit"],
  ["image:upscale", "Upscale"],
];
const VIDEO_SURFACES: [ModelSurface, string][] = [
  ["video:generate", "Generation"],
  ["video:tween", "Tween"],
  ["video:editnode", "Edit"],
];

function priceId(): string {
  return `expense-rule-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Search synonyms so natural terms find the CLI's flag spellings
 *  (e.g. "end frame" → `end_image`, "start frame" → `start_image`). */
const SEARCH_SYNONYMS: Record<string, string[]> = {
  frame: ["image", "picture"],
  image: ["frame", "picture"],
  picture: ["image", "frame"],
  audio: ["sound"],
  sound: ["audio"],
};

/** Fold a string for search: lowercase, non-alphanumerics → spaces. */
const searchFold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** True when `needle` appears in `hay` as a subsequence (typo tolerance). */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Fuzzy match: every query token must hit the haystack as a contiguous
 * substring (spaces stripped, so "end frame" ≡ "endframe") or a token
 * subsequence. Synonyms let natural words find CLI flag spellings. Exported
 * for tests.
 */
export function fuzzyMatch(query: string, haystack: string): boolean {
  const q = searchFold(query);
  if (!q) return true;
  const hay = searchFold(haystack);
  const hayCompact = hay.replace(/ /g, "");
  if (hayCompact.includes(q.replace(/ /g, ""))) return true;
  const hayTokens = hay.split(" ").filter(Boolean);
  return q.split(" ").filter(Boolean).every((token) => {
    const variants = new Set<string>([token, ...(SEARCH_SYNONYMS[token] ?? [])]);
    // Compound tokens: "endframe" → substitute the synonym inside the token.
    for (const [word, syns] of Object.entries(SEARCH_SYNONYMS)) {
      if (token.includes(word)) for (const syn of syns) variants.add(token.replace(word, syn));
    }
    return [...variants].some(
      (v) =>
        v.length >= 2 &&
        (hayCompact.includes(v) ||
          hayTokens.some((ht) => ht.startsWith(v)) ||
          (v.length >= 3 && isSubsequence(v, hayCompact)))
    );
  });
}

/** Run async work over items with a bounded concurrency pool. */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]).catch(() => {});
    }
  });
  await Promise.all(workers);
}

function placementOf(
  fieldName: string,
  flag: string,
  schemaGroup: string,
  exposure: Record<string, ModelParamExposure>,
  modelId: string
): Placement {
  const key = exposure[`${modelId}::${flag}`] ?? exposure[`${modelId}::${fieldName}`];
  if (key) return key;
  if (schemaGroup === "reference") return "default";
  return schemaGroup === "core" ? "core" : "advanced";
}

/** The effective kind of a probed model, honoring a manual override. */
function effKind(m: ModelProbeEntry, override: "image" | "video" | undefined): Kind {
  if (override) return override;
  if (isVideoModel(m.choice)) return "video";
  if (isImageModel(m.choice)) return "image";
  return "other";
}

/** A blank value clears the default (the vendor default then applies). */
const blankDefault = (v: ModelParamDefaultValue | null | undefined): boolean =>
  v === null || v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);

/** The per-surface default editor for one parameter: typed to match the
 *  field so an invalid enum value or non-finite number can never be stored. */
function DefaultControl({ field: f, value, onChange }: {
  field: CliOptionField;
  value: ModelParamDefaultValue | undefined;
  onChange: (next: ModelParamDefaultValue | null) => void;
}) {
  const raw = value === undefined || value === null ? "" : Array.isArray(value) ? value.join(", ") : String(value);
  const placeholder = f.default !== undefined && f.default !== null && f.default !== ""
    ? String(f.default)
    : undefined;
  if (f.kind === "enum" || f.kind === "boolean") {
    const options = f.kind === "boolean" ? ["true", "false"] : (f.values ?? []);
    const matched = options.find((o) => o.toLowerCase() === raw.toLowerCase()) ?? "";
    return (
      <select
        className="mc-default-input"
        value={matched}
        title={placeholder ? `Vendor default: ${placeholder}` : undefined}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">—</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (f.kind === "integer" || f.kind === "number") {
    return (
      <input
        className="mc-default-input"
        type="number"
        value={raw}
        placeholder={placeholder}
        min={f.min}
        max={f.max}
        step={f.step ?? (f.kind === "integer" ? 1 : "any")}
        onChange={(e) => {
          const t = e.target.value;
          if (!t.trim()) return onChange(null);
          const n = Number(t);
          if (Number.isFinite(n)) onChange(f.kind === "integer" ? Math.round(n) : n);
        }}
      />
    );
  }
  if (f.kind === "array") {
    return (
      <input
        className="mc-default-input"
        type="text"
        value={raw}
        placeholder="comma-separated"
        onChange={(e) => {
          const items = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
          onChange(items.length ? items : null);
        }}
      />
    );
  }
  return (
    <input
      className="mc-default-input"
      type="text"
      value={raw}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value.trim() ? e.target.value : null)}
    />
  );
}

export function ModelCustomizer({ onClose }: { onClose: () => void }) {
  const [providers, setProviders] = useState<MediaProviderInfo[]>([]);
  const [providerId, setProviderId] = useState<MediaProviderId>("higgsfield-cli");
  const [probe, setProbe] = useState<ModelProbeResult | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [search, setSearch] = useState("");
  /** Lowercased parameter surface per model id, indexed lazily for search. */
  const [paramIndex, setParamIndex] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [schema, setSchema] = useState<CliModelSchema | null>(null);
  const [schemaBusy, setSchemaBusy] = useState(false);
  const [exposure, setExposure] = useState<Record<string, ModelParamExposure>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [kinds, setKinds] = useState<Record<string, "image" | "video">>({});
  const [order, setOrder] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** Conceal hidden models from the side list (display only). */
  const [concealHidden, setConcealHidden] = useState(false);
  /** Per-model surface assignments (whole map, written wholesale). */
  const [surfacesMap, setSurfacesMap] = useState<Record<string, ModelSurface[]>>({});
  /** Per-surface parameter defaults, keyed `<model>::<surface>::<flag>`. */
  const [paramDefaults, setParamDefaults] = useState<Record<string, ModelParamDefaultValue>>({});
  /** Price drafts keyed by model id + the baked ladders used to build rules. */
  const [priceDraft, setPriceDraft] = useState<Record<string, { min: string; max: string }>>({});
  const [ladders, setLadders] = useState<Map<string, MediaModelLadder>>(new Map());
  const [priceNote, setPriceNote] = useState<string | null>(null);
  /** Higgsfield $/credit draft for the Expenses total (global, not per-model). */
  const [rateDraft, setRateDraft] = useState("");
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const v = Number(window.localStorage.getItem(PANEL_KEY));
      if (Number.isFinite(v) && v >= PANEL_MIN && v <= PANEL_MAX) return v;
    } catch { /* ignore */ }
    return 380;
  });

  // Load the persisted customization state once.
  useEffect(() => {
    window.cascade.listMediaProviders().then(setProviders).catch(() => {});
    void window.cascade.getModelOptionExposure().then((m) => setExposure(m ?? {})).catch(() => {});
    void window.cascade.getHiddenMediaModels().then((ids) => setHidden(new Set(ids))).catch(() => {});
    void window.cascade.getModelKindOverrides().then((m) => setKinds(m ?? {})).catch(() => {});
    void window.cascade.getMediaModelOrder().then((ids) => setOrder(ids ?? [])).catch(() => {});
    void window.cascade.getModelSurfaces().then((m) => setSurfacesMap(m ?? {})).catch(() => {});
    void window.cascade.getModelParamDefaults().then((m) => setParamDefaults(m ?? {})).catch(() => {});
    // Guarded (not assumed like the older calls): mixed-version bundles may
    // carry a preload without the rate channel yet.
    if (typeof window.cascade.getHiggsfieldCreditRate === "function") {
      void window.cascade.getHiggsfieldCreditRate().then((r) => {
        if (r != null) setRateDraft(String(r));
      }).catch(() => {});
    }
    void window.cascade.getExpensePriceRules().then((rules) => {
      const d: Record<string, { min: string; max: string }> = {};
      for (const r of rules) if (r.model) d[r.model] = { min: String(r.minPrice), max: String(r.maxPrice) };
      setPriceDraft(d);
    }).catch(() => {});
    void window.cascade.listAllMediaModels().then((ls) => {
      setLadders(new Map(ls.map((l) => [l.choice.id, l])));
    }).catch(() => {});
  }, []);

  const runProbe = useCallback(async (id: MediaProviderId, refresh = false) => {
    setProbeBusy(true);
    setError(null);
    try {
      if (refresh) await window.cascade.refreshModelProbe(id).catch(() => {});
      const r = await window.cascade.probeModels(id);
      setProbe(r);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setProbeBusy(false);
    }
  }, []);

  useEffect(() => {
    void runProbe(providerId);
  }, [providerId, runProbe]);

  const loadSchema = useCallback(async (id: MediaProviderId, modelId: string) => {
    setSchemaBusy(true);
    setSchema(null);
    try {
      const s = await window.cascade.probeModelOptions(id, modelId);
      setSchema(s);
    } catch {
      setSchema(null);
    } finally {
      setSchemaBusy(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadSchema(providerId, selectedId);
    else setSchema(null);
  }, [selectedId, providerId, loadSchema]);

  const models = probe?.models ?? [];

  // Display order is the persisted order first (models not in it append in
  // discovery order), so a drag re-renders immediately without a re-probe.
  const orderedModels = useMemo(() => {
    const ids = models.map((m) => m.choice.id);
    const known = order.filter((id) => ids.includes(id));
    const rest = ids.filter((id) => !known.includes(id));
    const rank = new Map([...known, ...rest].map((id, i) => [id, i]));
    return [...models].sort((a, b) => (rank.get(a.choice.id) ?? Infinity) - (rank.get(b.choice.id) ?? Infinity));
  }, [models, order]);

  const filtered = useMemo(() => {
    const q = search.trim();
    if (!q) return orderedModels;
    return orderedModels.filter((m) => {
      const hay = `${m.choice.displayName} ${m.choice.id} ${paramIndex[m.choice.id] ?? ""}`;
      return fuzzyMatch(q, hay);
    });
  }, [orderedModels, search, paramIndex]);

  const linked = useMemo(
    () => (concealHidden ? filtered.filter((m) => !hidden.has(m.choice.id)) : filtered),
    [filtered, concealHidden, hidden]
  );

  const groups = useMemo(() => {
    const img: ModelProbeEntry[] = [];
    const vid: ModelProbeEntry[] = [];
    const other: ModelProbeEntry[] = [];
    for (const m of linked) {
      const k = effKind(m, kinds[m.choice.id]);
      (k === "image" ? img : k === "video" ? vid : other).push(m);
    }
    return [
      { key: "image", title: "Image models", rows: img },
      { key: "video", title: "Video models", rows: vid },
      { key: "other", title: "Other", rows: other },
    ].filter((g) => g.rows.length > 0);
  }, [linked, kinds]);

  // Index each model's parameter surface lazily (bounded concurrency) so the
  // search can match parameters, not just names — e.g. "end frame" finds the
  // models declaring `end_image`. Runs in the background; the list renders
  // immediately and matches strengthen as the index fills.
  useEffect(() => {
    const ids = (probe?.models ?? []).map((m) => m.choice.id);
    if (!ids.length) return;
    let live = true;
    setParamIndex({});
    void runPool(ids, 6, async (id) => {
      try {
        const s = await window.cascade.probeModelOptions(providerId, id);
        if (!live || !s) return;
        const text = s.fields
          .map((f) => `${f.flag} ${f.name} ${f.mediaRole ?? ""} ${(f.values ?? []).join(" ")}`)
          .join(" ");
        setParamIndex((prev) => (prev[id] === text ? prev : { ...prev, [id]: text }));
      } catch { /* best-effort index */ }
    });
    return () => { live = false; };
  }, [probe, providerId]);

  const notifyPickers = () => window.dispatchEvent(new Event("cascade:media-provider-changed"));

  // ---- persistence helpers -------------------------------------------------

  /** The full ordering over the current provider's models. */
  const fullOrder = (): string[] => {
    const ids = models.map((m) => m.choice.id);
    const known = order.filter((id) => ids.includes(id));
    return [...known, ...ids.filter((id) => !known.includes(id))];
  };

  const persistOrder = (next: string[]) => {
    setOrder(next);
    void window.cascade.setMediaModelOrder(next).catch(() => {});
    notifyPickers();
  };

  /** Move the dragged model directly before the target (same kind only). */
  const dropOn = (targetId: string) => {
    setDropTarget(null);
    const dragId = draggingId;
    setDraggingId(null);
    if (!dragId || dragId === targetId) return;
    const dragEntry = models.find((m) => m.choice.id === dragId);
    const targetEntry = models.find((m) => m.choice.id === targetId);
    if (!dragEntry || !targetEntry) return;
    if (effKind(dragEntry, kinds[dragId]) !== effKind(targetEntry, kinds[targetId])) return;
    const full = fullOrder();
    const from = full.indexOf(dragId);
    const at = full.indexOf(targetId);
    if (from < 0 || at < 0) return;
    const next = [...full];
    next.splice(from, 1);
    next.splice(at - (from < at ? 1 : 0), 0, dragId);
    persistOrder(next);
  };

  const toggleHidden = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id); else next.add(id);
    setHidden(next);
    void window.cascade.setHiddenMediaModels([...next]).catch(() => {});
    notifyPickers();
  };

  const setKind = (id: string, kind: "image" | "video" | "") => {
    const next = { ...kinds };
    if (kind) next[id] = kind; else delete next[id];
    setKinds(next);
    void window.cascade.setModelKindOverrides(next).catch(() => {});
    notifyPickers();
  };

  const setPlacement = (modelId: string, flag: string, name: string, next: Placement) => {
    const map = { ...exposure };
    // Both spellings (raw flag and folded name) are candidate keys — clear
    // both before writing, since for single-word params they're identical and
    // a naive "set then delete the alias" would wipe the value.
    const key = `${modelId}::${flag}`;
    const altKey = `${modelId}::${name}`;
    delete map[key];
    delete map[altKey];
    if (next !== "default") map[key] = next;
    setExposure(map);
    void window.cascade.setModelOptionExposure(key, next === "default" ? null : next).catch(() => {});
    if (altKey !== key) void window.cascade.setModelOptionExposure(altKey, null).catch(() => {});
  };

  // ---- pricing -------------------------------------------------------------

  const priceLabel = (id: string): string => {
    // Higgsfield rows track credits, not dollars — one global rate prices
    // them (edited in the model details), so no per-model range applies.
    if (id.startsWith("higgsfield-cli:") || id.startsWith("higgsfield:")) return "credits";
    const d = priceDraft[id];
    if (!d || (!d.min && !d.max)) return "—";
    const min = Number(d.min) || 0;
    const max = Number(d.max) || 0;
    if (min === max) return `$${min.toFixed(2)}`;
    return `$${min.toFixed(2)}–$${max.toFixed(2)}`;
  };

  /** Save the global Higgsfield $/credit rate (re-prices history). Blank clears it. */
  const saveCreditRate = async () => {
    setPriceNote(null);
    try {
      const trimmed = rateDraft.trim();
      const v = trimmed === "" ? null : Number(trimmed);
      if (v !== null && (!Number.isFinite(v) || v < 0)) {
        setPriceNote("Enter a non-negative dollar amount (or blank to clear).");
        return;
      }
      const saved = await window.cascade.setHiggsfieldCreditRate(v);
      setRateDraft(saved == null ? "" : String(saved));
      setPriceNote(saved == null
        ? "Cleared — Higgsfield rows show credits and contribute $0."
        : "Saved — existing expenses re-priced.");
    } catch (e) {
      setPriceNote(String(e).replace(/^Error:\s*/, ""));
    }
  };
  /** Save the selected model's price range, preserving every other rule. */
  const saveModelPrice = async (id: string) => {
    setPriceNote(null);
    try {
      const all = await window.cascade.getExpensePriceRules();
      const ladder = ladders.get(id);
      const d = priceDraft[id] ?? { min: "", max: "" };
      const min = Number(d.min) || 0;
      const max = Number(d.max) || 0;
      const kind: "image" | "video" = ladder?.choice.videoInput ? "video" : "image";
      const existing = all.find((r) => r.model === id);
      const rest = all.filter((r) => r.model !== id);
      if (min || max) {
        const rule: ExpensePriceRule = {
          id: existing?.id ?? priceId(),
          kind,
          model: id,
          minPrice: min,
          maxPrice: max,
          resolutions: ladder?.resolutions ?? existing?.resolutions ?? [],
          durMin: ladder?.durMin ?? existing?.durMin ?? null,
          durMax: ladder?.durMax ?? existing?.durMax ?? null,
        };
        rest.push(rule);
      }
      await window.cascade.setExpensePriceRules(rest);
      setPriceNote("Saved — existing expenses re-priced.");
    } catch (e) {
      setPriceNote(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const exportPrices = async () => {
    try {
      const path = await window.cascade.exportExpensePriceRules();
      setPriceNote(path ? `Exported to ${path}` : null);
    } catch (e) {
      setPriceNote(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const importPrices = async () => {
    try {
      const res = await window.cascade.importExpensePriceRules();
      if (!res) return;
      const d: Record<string, { min: string; max: string }> = {};
      for (const r of res.rules) if (r.model) d[r.model] = { min: String(r.minPrice), max: String(r.maxPrice) };
      setPriceDraft(d);
      setPriceNote("Imported price rules.");
    } catch (e) {
      setPriceNote(String(e).replace(/^Error:\s*/, ""));
    }
  };

  // ---- surfaces ------------------------------------------------------------

  /** The surface checkboxes that apply to a model's modality. */
  const surfaceListFor = (m: ModelProbeEntry | undefined): [ModelSurface, string][] => {
    if (!m) return [];
    const k = effKind(m, kinds[m.choice.id]);
    return k === "video" ? VIDEO_SURFACES : k === "image" ? IMAGE_SURFACES : [];
  };

  /** Default on-state for an unassigned model: `video:tween` and
   *  `image:upscale` are opt-in — the assignment itself is the capability
   *  declaration (end-frame support / upscale support). */
  const surfaceDefaultOn = (surface: ModelSurface): boolean =>
    surface !== "video:tween" && surface !== "image:upscale";

  /** Whether a model is allowed on a surface (default until restricted). */
  const surfaceOn = (id: string, surface: ModelSurface): boolean => {
    const explicit = surfacesMap[id];
    if (explicit && explicit.length) return explicit.includes(surface);
    return surfaceDefaultOn(surface);
  };

  const toggleSurface = (m: ModelProbeEntry, surface: ModelSurface) => {
    const id = m.choice.id;
    const applicable = surfaceListFor(m).map(([s]) => s);
    const current = applicable.filter((s) => surfaceOn(id, s));
    const next = current.includes(surface) ? current.filter((s) => s !== surface) : [...current, surface];
    const defaults = applicable.filter(surfaceDefaultOn);
    const map = { ...surfacesMap };
    const sameAsDefault = next.length === defaults.length && next.every((s) => defaults.includes(s));
    if (sameAsDefault) delete map[id];
    else map[id] = next;
    setSurfacesMap(map);
    void window.cascade.setModelSurfaces(map).catch(() => {});
    notifyPickers();
  };

  const resetSurfaces = () => {
    setSurfacesMap({});
    void window.cascade.resetModelSurfaces().catch(() => {});
    notifyPickers();
  };

  // ---- parameter defaults --------------------------------------------------

  const paramDefault = (modelId: string, surface: ModelSurface, flag: string): ModelParamDefaultValue | undefined =>
    paramDefaults[paramDefaultKey(modelId, surface, flag)];

  const setParamDefault = (modelId: string, surface: ModelSurface, flag: string, value: ModelParamDefaultValue | null) => {
    const key = paramDefaultKey(modelId, surface, flag);
    const next = { ...paramDefaults };
    if (blankDefault(value)) delete next[key];
    else next[key] = value as ModelParamDefaultValue;
    setParamDefaults(next);
    rememberModelParamDefault(key, blankDefault(value) ? null : value);
  };

  const resetParamDefaults = () => {
    setParamDefaults({});
    void window.cascade.resetModelParamDefaults().catch(() => {});
    void primeModelParamDefaults();
  };

  // ---- resizable list pane -------------------------------------------------

  const clampWidth = (w: number) => Math.max(PANEL_MIN, Math.min(PANEL_MAX, w));
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const onMove = (ev: PointerEvent) => setPanelWidth(clampWidth(startW + (ev.clientX - startX)));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setPanelWidth((w) => {
        try { window.localStorage.setItem(PANEL_KEY, String(w)); } catch { /* ignore */ }
        return w;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const providerInfo = providers.find((p) => p.id === providerId);
  const hiddenCount = models.filter((m) => hidden.has(m.choice.id)).length;
  const indexedCount = Object.keys(paramIndex).length;

  return (
    <div className="prod-model-customizer" role="dialog" aria-label="Model customization">
      <div className="mc-head">
        <span className="mc-title">Model customization</span>
        <span className="mc-sub">Dev Mode · probes are read-only; nothing is generated</span>
        <button className="prod-btn" onClick={onClose} title="Close"><XIcon size={12} /> Close</button>
      </div>

      <div className="mc-providers">
        {providers.map((p) => (
          <button
            key={p.id}
            className={"mc-provider" + (p.id === providerId ? " active" : "")}
            onClick={() => { setSelectedId(null); setProviderId(p.id); }}
            title={`${p.displayName}${p.available ? "" : " (unavailable)"}`}
          >
            <span className={"mc-dot" + (p.available ? " on" : "")} />
            {p.displayName}
          </button>
        ))}
        <span className="mc-spacer" />
        <button className="prod-btn" disabled={probeBusy} onClick={() => void runProbe(providerId, true)}>
          {probeBusy ? "Probing…" : "Refresh probe"}
        </button>
      </div>

      {error && <p className="error-text mc-error">{error}</p>}
      {probe?.error && <p className="hint mc-error">{probe.error}</p>}

      <div className="mc-body">
        <div className="mc-models" style={{ width: panelWidth }}>
          <div className="mc-models-head">
            <input
              className="mc-search"
              placeholder={`Search ${models.length} ${providerInfo?.displayName ?? ""} models & parameters…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              className={"mc-conceal" + (concealHidden ? " active" : "")}
              aria-pressed={concealHidden}
              onClick={() => setConcealHidden((v) => !v)}
              title={concealHidden ? "Show hidden models again" : "Conceal hidden models from this list"}
            >
              {concealHidden ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
              {concealHidden ? "Concealed" : "Conceal"}
              {hiddenCount ? ` (${hiddenCount})` : ""}
            </button>
          </div>
          <p className="mc-hint">
            Click the eye to hide a model from every picker. Drag the grip to reorder within a group.
            {search.trim() && indexedCount < models.length ? ` Indexing parameters… ${indexedCount}/${models.length}` : ""}
          </p>
          <div className="mc-model-list">
            {groups.map((g) => (
              <div key={g.key} className="mc-group">
                <div className="mc-group-head">{g.title} <span className="mc-count">{g.rows.length}</span></div>
                {g.rows.map((m) => {
                  const id = m.choice.id;
                  const isHidden = hidden.has(id);
                  return (
                    <div
                      key={id}
                      className={
                        "mc-model-row" +
                        (id === selectedId ? " selected" : "") +
                        (isHidden ? " hidden-model" : "") +
                        (dropTarget === id ? " drop-target" : "")
                      }
                      onClick={() => setSelectedId(id)}
                      onDragOver={(e) => {
                        if (!draggingId || draggingId === id) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setDropTarget(id);
                      }}
                      onDragLeave={() => setDropTarget((t) => (t === id ? null : t))}
                      onDrop={(e) => { e.preventDefault(); dropOn(id); }}
                    >
                      <span
                        className="mc-grip"
                        draggable
                        title="Drag to reorder"
                        onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = "move"; setDraggingId(id); }}
                        onDragEnd={() => { setDraggingId(null); setDropTarget(null); }}
                      >
                        ⠿
                      </span>
                      <button
                        className={"mc-eye" + (isHidden ? " off" : "")}
                        title={isHidden ? "Hidden — click to show in every picker" : "Hide from every model picker"}
                        onClick={(e) => { e.stopPropagation(); toggleHidden(id); }}
                      >
                        {isHidden ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                      </button>
                      <span className="mc-model-name" title={`${m.choice.displayName}\n${m.choice.id}`}>{m.choice.displayName}</span>
                      {isHidden && <span className="mc-hidden-badge">hidden</span>}
                      <select
                        className="mc-kind"
                        value={kinds[id] ?? ""}
                        onChange={(e) => { e.stopPropagation(); setKind(id, e.target.value as "image" | "video" | ""); }}
                        title="Model kind override"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <option value="">auto</option>
                        <option value="image">image</option>
                        <option value="video">video</option>
                      </select>
                      <span className="mc-price" title={id.startsWith("higgsfield-cli:") || id.startsWith("higgsfield:") ? "Tracked in credits — set the dollar value in the model details" : "Price range — edit in the model details"}>{priceLabel(id)}</span>
                    </div>
                  );
                })}
              </div>
            ))}
            {probeBusy && <p className="hint">Probing {providerInfo?.displayName}…</p>}
            {!probeBusy && linked.length === 0 && (
              <p className="hint">
                {filtered.length === 0 ? "No models reported." : "All matching models are hidden — turn off “Conceal” to see them."}
              </p>
            )}
          </div>
        </div>

        <div
          className="mc-resizer"
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize the model list"
          onPointerDown={startResize}
        />

        <div className="mc-params">
          {!selectedId && <p className="hint">Select a model to inspect and place its parameters.</p>}
          {selectedId && schemaBusy && <p className="hint">Probing parameters…</p>}
          {selectedId && !schemaBusy && !schema && (
            <p className="hint">This model reports no inspectable parameters (or the provider can't introspect it).</p>
          )}
          {selectedId && (() => {
            const entry = models.find((m) => m.choice.id === selectedId);
            const surfaces = surfaceListFor(entry);
            const draft = priceDraft[selectedId] ?? { min: "", max: "" };
            return (
              <div className="mc-meta">
                {surfaces.length > 0 && (
                  <div className="mc-meta-block">
                    <div className="mc-meta-title">Where this model appears</div>
                    <div className="mc-surface-grid">
                      {surfaces.map(([s, label]) => (
                        <label key={s} className="mc-surface">
                          <input type="checkbox" checked={surfaceOn(selectedId, s)} onChange={() => entry && toggleSurface(entry, s)} />
                          {label}
                        </label>
                      ))}
                    </div>
                    <button className="mc-link" onClick={resetSurfaces} title="Offer this model on every applicable surface again">Reset all to “everywhere”</button>
                  </div>
                )}
                {(selectedId.startsWith("higgsfield-cli:") || selectedId.startsWith("higgsfield:")) ? (
                  <div className="mc-meta-block">
                    <div className="mc-meta-title">Credit value (Higgsfield)</div>
                    <div className="mc-price-edit">
                      <label>$ per credit<input type="number" min="0" step="0.0001" placeholder="e.g. 0.039" value={rateDraft} onChange={(e) => setRateDraft(e.target.value)} /></label>
                      <button className="prod-btn primary" onClick={() => void saveCreditRate()}>Save rate</button>
                    </div>
                    <p className="hint">Higgsfield generations track credits, not dollars — the Expenses total converts at this rate. Blank clears it (credit rows then show credits and contribute $0). Per-model ranges don't apply here.</p>
                    {priceNote && <span className="hint">{priceNote}</span>}
                  </div>
                ) : (
                <div className="mc-meta-block">
                  <div className="mc-meta-title">Price range {ladders.get(selectedId)?.choice.videoInput ? "(video)" : "(image)"}</div>
                  <div className="mc-price-edit">
                    <label>Min $<input type="number" min="0" step="0.01" placeholder="0.00" value={draft.min} onChange={(e) => setPriceDraft((p) => ({ ...p, [selectedId]: { ...draft, min: e.target.value } }))} /></label>
                    <label>Max $<input type="number" min="0" step="0.01" placeholder="0.00" value={draft.max} onChange={(e) => setPriceDraft((p) => ({ ...p, [selectedId]: { ...draft, max: e.target.value } }))} /></label>
                    <button className="prod-btn primary" onClick={() => void saveModelPrice(selectedId)}>Save price</button>
                    <button className="prod-btn" onClick={() => void exportPrices()} title="Export every price rule to a CSV">Export CSV</button>
                    <button className="prod-btn" onClick={() => void importPrices()} title="Import price rules from a CSV" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><ImportIcon size={12} /> Import CSV</button>
                  </div>
                  {priceNote && <span className="hint">{priceNote}</span>}
                </div>
                )}
              </div>
            );
          })()}
          {selectedId && schema && (
            <>
              <div className="mc-params-head">
                <span className="mc-params-title">{models.find((m) => m.choice.id === selectedId)?.choice.displayName ?? selectedId}</span>
                <span className="mc-sub">{schema.fields.length} parameters</span>
              </div>
              <table className="mc-table">
                <thead>
                  <tr>
                    <th>Parameter</th>
                    <th>Flag</th>
                    <th>Type</th>
                    <th>Values</th>
                    <th>Menu</th>
                  </tr>
                </thead>
                <tbody>
                  {schema.fields.map((f) => {
                    const dedicated = f.group === "reference" || DEDICATED.has(f.name) || DEDICATED.has(f.flag);
                    const current = placementOf(f.name, f.flag, f.group, exposure, selectedId);
                    return (
                      <tr key={f.flag} className={dedicated ? "dedicated" : ""}>
                        <td title={f.constraint ?? undefined}>{f.flag.replace(/[_-]+/g, " ")}</td>
                        <td><code>{f.flag}</code></td>
                        <td>{f.kind}</td>
                        <td className="mc-values" title={(f.values ?? []).join(", ")}>{(f.values ?? []).join(", ") || (f.default !== undefined && f.default !== null ? String(f.default) : "—")}</td>
                        <td>
                          {dedicated ? (
                            <span className="mc-badge" title="Rendered by a dedicated control; not movable here">dedicated</span>
                          ) : (
                            <span className="mc-placement">
                              {(["core", "advanced", "hidden"] as Placement[]).map((p) => (
                                <button
                                  key={p}
                                  className={"mc-place" + (current === p ? " active" : "")}
                                  onClick={() => setPlacement(selectedId, f.flag, f.name, p)}
                                  title={`Place in ${p}`}
                                >
                                  {p}
                                </button>
                              ))}
                              <button
                                className={"mc-place mc-place-default" + (current === "default" ? " active" : "")}
                                onClick={() => setPlacement(selectedId, f.flag, f.name, "default")}
                                title="Use the schema default"
                              >
                                auto
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
          {selectedId && schema && (() => {
            const entry = models.find((m) => m.choice.id === selectedId);
            // Only the surfaces this model is actually offered on get a
            // defaults column — untick a picker above and its column goes away.
            const defaultsSurfaces = surfaceListFor(entry).filter(([s]) => surfaceOn(selectedId, s));
            const defaultFields = schema.fields.filter((f) =>
              f.group !== "reference" && !f.mediaRole && !DEDICATED.has(f.name) && !DEDICATED.has(f.flag)
            );
            if (!defaultsSurfaces.length || !defaultFields.length) return null;
            return (
              <div className="mc-defaults">
                <div className="mc-params-head">
                  <span className="mc-params-title">Parameter defaults</span>
                  <span className="mc-sub">Applied when this model loads — a saved per-shot value wins</span>
                  <button className="mc-link mc-defaults-reset" onClick={resetParamDefaults} title="Clear every parameter default">Reset all defaults</button>
                </div>
                <table className="mc-table mc-defaults-table">
                  <thead>
                    <tr>
                      <th>Parameter</th>
                      {defaultsSurfaces.map(([s, label]) => <th key={s}>{label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {defaultFields.map((f) => (
                      <tr key={f.flag}>
                        <td title={`${f.flag}${f.constraint ? ` — ${f.constraint}` : ""}`}>{f.flag.replace(/[_-]+/g, " ")}</td>
                        {defaultsSurfaces.map(([s]) => (
                          <td key={s}>
                            <DefaultControl
                              field={f}
                              value={paramDefault(selectedId, s, f.flag)}
                              onChange={(v) => setParamDefault(selectedId, s, f.flag, v)}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mc-hint">Blank uses the vendor's own default. One value per surface (column).</p>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
