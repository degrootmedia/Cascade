import { Fragment, useEffect, useMemo, useState } from "react";
import { sortByModelOrder, type ExpensePriceRule, type MediaProviderInfo, type ModelInfo, type SettingsView } from "../../../shared/ipc.js";
import { API_PROVIDERS } from "../../../shared/providers.js";
import { McpSection } from "./McpSection.js";
import { applyAccent } from "../theme.js";
import { uid } from "./production/hex.js";
import { DragHandleIcon, EyeIcon, EyeOffIcon, ExpensesIcon, ImportIcon } from "./icons.js";

const ACCENT_PRESETS = [
  { name: "Blue", value: "#4f8ef7" },
  { name: "Violet", value: "#a371f7" },
  { name: "Teal", value: "#2ea89a" },
  { name: "Green", value: "#57ab5a" },
  { name: "Orange", value: "#e0823d" },
  { name: "Pink", value: "#f778ba" },
];

/** Editable model-price row draft for Settings → Models & expenses. One row
 *  per (provider, kind, model), auto-populated from both media vendors; the
 *  min→max price range interpolates by resolution/video length against the
 *  model's baked ladder (text fields so number inputs don't fight the user
 *  mid-keystroke). */
interface ModelPriceDraft {
  id: string;
  /** Which media vendor surfaced the model ("openart" | "higgsfield"). */
  provider: string;
  kind: "image" | "video";
  /** Provider-namespaced model id ("" = "Any model" wildcard). */
  model: string;
  displayName: string;
  /** Whether the model is hidden from the generation dropdowns. */
  hidden: boolean;
  minText: string;
  maxText: string;
  /** Resolution ladder baked when the model was probed (low → high). */
  resolutions: string[];
  /** Video length range baked when the model was probed (null for images). */
  durMin: number | null;
  durMax: number | null;
}

/** Default image ladder (mirrors the main-process fallback in ledger.ts). */
const IMAGE_RESOLUTIONS = ["1k", "2k", "4k"];
/** Default video ladder for the optimistic drag preview (mirrors ledger.ts). */
const FALLBACK_VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"];
const FALLBACK_VIDEO_DURATIONS = [5, 10, 15, 20];

/** Sub-panel display names, one per media vendor (matches PROVIDER_META). */
const PROVIDER_LABELS: Record<string, string> = { openart: "OpenArt", higgsfield: "Higgsfield", "higgsfield-cli": "Higgsfield CLI", "openart-cli": "OpenArt CLI" };
const PROVIDER_ORDER = ["openart", "higgsfield", "higgsfield-cli", "openart-cli"];

/** The vendor a model id belongs to. Provider ids are namespaced where they
 *  leave the provider (higgsfield:<id>, higgsfield-cli:<id>,
 *  openart-cli:<id>); everything else is OpenArt. */
const providerOf = (id: string): string =>
  id.startsWith("higgsfield-cli:") ? "higgsfield-cli"
  : id.startsWith("higgsfield:") ? "higgsfield"
  : id.startsWith("openart-cli:") ? "openart-cli"
  : "openart";

/** The ladder a rule interpolates over, as a short human label. */
const ladderLabel = (d: ModelPriceDraft): string => {
  const res =
    d.resolutions.length > 1
      ? `${d.resolutions[0]}→${d.resolutions[d.resolutions.length - 1]}`
      : d.resolutions[0] ?? "";
  if (d.kind === "video" && d.durMin != null && d.durMax != null) return `${res} · ${d.durMin}s–${d.durMax}s`;
  return res;
};

/** Persisted rules → editable draft rows (used after an import). */
const rulesToDrafts = (rules: ExpensePriceRule[]): ModelPriceDraft[] =>
  rules.map((r) => ({
    id: r.id,
    provider: providerOf(r.model),
    kind: r.kind,
    model: r.model,
    displayName: r.model || "Any model",
    hidden: false,
    minText: String(r.minPrice),
    maxText: String(r.maxPrice),
    resolutions: [...r.resolutions],
    durMin: r.durMin,
    durMax: r.durMax,
  }));

/** Settings → Models & expenses: every model discovered across both media
 *  vendors with its min→max price range and a hide-from-dropdowns toggle.
 *  Prices are saved together (re-pricing all existing expenses); the hidden
 *  toggle applies immediately. */
function ExpensePricingSection() {
  const [drafts, setDrafts] = useState<ModelPriceDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** Collapsed provider sub-panels (session-only). */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** The draft id being dragged (dims the row), and the group (provider+kind)
   *  under the pointer for the drop highlight. */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ provider: string; kind: ModelPriceDraft["kind"] } | null>(null);
  /** The same-group row under the pointer — the reorder insert indicator. */
  const [overModel, setOverModel] = useState<string | null>(null);
  /** Eyeball toggle: conceal the hidden models in this list (visual only —
   *  they're excluded from the generation dropdowns either way). */
  const [showHidden, setShowHidden] = useState(true);

  const toggleProvider = (p: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const update = (i: number, patch: Partial<ModelPriceDraft>) => {
    setNote(null);
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  };

  /** Merge the discovered models + persisted rules into draft rows: one row
   *  per (provider, kind, model). Keeps persisted rows whose model a vendor no
   *  longer lists, and re-bakes ladders from the live probe for everything it
   *  does. */
  const loadAll = async () => {
    const [ladders, rules, hidden, orderIds] = await Promise.all([
      window.cascade.listAllMediaModels(),
      window.cascade.getExpensePriceRules(),
      window.cascade.getHiddenMediaModels(),
      window.cascade.getMediaModelOrder(),
    ]);
    const hiddenSet = new Set(hidden);
    const byKey = new Map<string, ModelPriceDraft>();
    // Discovered model → which sections it belongs to. OpenArt's imageInput
    // flag means "accepts image references", so a video model usually flags it
    // too — a model is an IMAGE model only when it isn't a video model.
    const sections = new Map<string, { image: boolean; video: boolean }>();
    const upsert = (
      provider: string,
      kind: ModelPriceDraft["kind"],
      model: string,
      displayName: string,
      resolutions: string[],
      durMin: number | null,
      durMax: number | null
    ) => {
      const key = `${provider}\u0000${kind}\u0000${model}`;
      if (byKey.has(key)) return;
      // Prefer the row's kind, but carry the price from any existing rule for
      // the model (e.g. after a manual re-classification) so it survives a
      // refresh instead of resetting to $0.
      const rule =
        rules.find((r) => r.kind === kind && r.model === model) ??
        rules.find((r) => r.model === model);
      byKey.set(key, {
        id: rule?.id ?? uid("expense-rule"),
        provider,
        kind,
        model,
        displayName,
        hidden: hiddenSet.has(model),
        minText: rule ? String(rule.minPrice) : "",
        maxText: rule ? String(rule.maxPrice) : "",
        resolutions,
        durMin,
        durMax,
      });
    };
    for (const l of ladders) {
      const c = l.choice;
      sections.set(c.id, { image: c.imageInput && !c.videoInput, video: c.videoInput });
      if (c.imageInput && !c.videoInput) upsert(l.provider, "image", c.id, c.displayName, [...IMAGE_RESOLUTIONS], null, null);
      if (c.videoInput) upsert(l.provider, "video", c.id, c.displayName, l.resolutions, l.durMin, l.durMax);
    }
    // Preserve persisted rules whose model isn't currently discovered — but
    // drop a rule whose kind no longer matches the model's live capability
    // (e.g. a stale image rule left over for a video model).
    for (const r of rules) {
      const cap = sections.get(r.model);
      if (cap && ((r.kind === "image" && !cap.image) || (r.kind === "video" && !cap.video))) continue;
      upsert(providerOf(r.model), r.kind, r.model, r.model, r.resolutions, r.durMin, r.durMax);
    }
    // The list renders in the user's saved drag-to-reorder arrangement —
    // models not in it (fresh discoveries) append in discovery order.
    setDrafts(sortByModelOrder([...byKey.values()], orderIds, (d) => d.model));
  };

  useEffect(() => {
    void loadAll().catch((e) => setError(String(e)));
  }, []);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await loadAll();
      setNote("Model list refreshed from both providers.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleHidden = async (i: number) => {
    setNote(null);
    const d = drafts[i];
    const nextHidden = !d.hidden;
    setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, hidden: nextHidden } : x)));
    const ids = new Set(drafts.filter((x, j) => j !== i && x.hidden).map((x) => x.model).filter(Boolean));
    if (nextHidden) ids.add(d.model);
    else ids.delete(d.model);
    await window.cascade.setHiddenMediaModels([...ids]).catch(() => {});
    // Re-read the active vendor so the generation dropdowns pick up the filter
    // (same event MediaProviderSection dispatches; keep the string in sync).
    window.dispatchEvent(new Event("cascade:media-provider-changed"));
  };

  /** Manually re-classify a model by dragging it between the Image/Video
   *  groups: persist the kind override (every model dropdown respects it
   *  main-side), flip the row optimistically, then reconcile prices + ladders
   *  against the override via a reload. */
  const moveModel = async (
    targetProvider: string,
    targetKind: ModelPriceDraft["kind"],
    payload: { provider: string; model: string }
  ) => {
    setDropTarget(null);
    setDraggingId(null);
    if (payload.provider !== targetProvider) {
      setNote("Models stay with their own provider — drop into the same vendor's group.");
      return;
    }
    const d = drafts.find((x) => x.model === payload.model);
    if (!d || d.kind === targetKind) return;
    setNote(null);
    setBusy(true);
    setError(null);
    try {
      // Optimistic: flip the kind with a kind-default ladder so the row jumps
      // immediately; loadAll re-bakes the true ladder below.
      const ladder =
        targetKind === "video"
          ? {
              resolutions: [...FALLBACK_VIDEO_RESOLUTIONS],
              durMin: Math.min(...FALLBACK_VIDEO_DURATIONS),
              durMax: Math.max(...FALLBACK_VIDEO_DURATIONS),
            }
          : { resolutions: [...IMAGE_RESOLUTIONS], durMin: null, durMax: null };
      setDrafts((ds) => ds.map((x) => (x.model === payload.model ? { ...x, kind: targetKind, ...ladder } : x)));
      const current = await window.cascade.getModelKindOverrides();
      await window.cascade.setModelKindOverrides({ ...current, [payload.model]: targetKind });
      await loadAll();
      setNote(`Moved to ${targetKind === "video" ? "Video" : "Image"} models — all dropdowns updated.`);
      // Re-read the active vendor so the generation dropdowns pick up the
      // re-classification (same event the hidden toggle dispatches).
      window.dispatchEvent(new Event("cascade:media-provider-changed"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Re-order within a provider+kind group: move the dragged row directly
   *  before the target row and persist the arrangement — the generation
   *  dropdowns re-sort main-side from the same saved order. */
  const reorder = (targetModel: string) => {
    setOverModel(null);
    setDraggingId(null);
    setDropTarget(null);
    const from = drafts.findIndex((d) => d.id === draggingId);
    const at = drafts.findIndex((d) => d.model === targetModel);
    if (from < 0 || at < 0 || from === at) return;
    const next = [...drafts];
    const [row] = next.splice(from, 1);
    // After removing the dragged row, the target's index shifts down by one
    // when it sat after the source — inserting at the shifted index lands
    // directly before the target.
    next.splice(at - (from < at ? 1 : 0), 0, row);
    setDrafts(next);
    const ids = next.map((d) => d.model).filter(Boolean);
    void window.cascade.setMediaModelOrder(ids).catch(() => {});
    // Re-read the active vendor so the generation dropdowns pick up the new
    // order (same event the kind move dispatches; keep the string in sync).
    window.dispatchEvent(new Event("cascade:media-provider-changed"));
  };

  const toRules = (): ExpensePriceRule[] =>
    drafts.map((d) => ({
      id: d.id,
      kind: d.kind,
      model: d.model.trim(),
      minPrice: Number(d.minText) || 0,
      maxPrice: Number(d.maxText) || 0,
      resolutions: [...d.resolutions],
      durMin: d.kind === "video" ? d.durMin : null,
      durMax: d.kind === "video" ? d.durMax : null,
    }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.cascade.setExpensePriceRules(toRules());
      setNote("Prices saved — existing expenses re-priced.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportRules = async () => {
    setBusy(true);
    setError(null);
    try {
      const file = await window.cascade.exportExpensePriceRules();
      setNote(file ? `Exported ${drafts.length} rules to ${file}.` : null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const importRules = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.cascade.importExpensePriceRules();
      if (res) {
        setDrafts(rulesToDrafts(res.rules));
        setNote(`Imported ${res.rules.length} rules from ${res.path}.`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const renderRow = (d: ModelPriceDraft, i: number) => {
    const dragged = draggingId != null ? drafts.find((x) => x.id === draggingId) : undefined;
    const sameGroup = !!dragged && dragged.provider === d.provider && dragged.kind === d.kind;
    return (
      <div
        className={
          "expense-rule" +
          (draggingId === d.id ? " expense-dragging" : "") +
          (overModel === d.model && draggingId !== d.id ? " expense-reorder-before" : "")
        }
        key={d.id}
        draggable
        onDragStart={(e) => {
          setDraggingId(d.id);
          e.dataTransfer.setData("application/json", JSON.stringify({ provider: d.provider, model: d.model }));
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          setDraggingId(null);
          setDropTarget(null);
          setOverModel(null);
        }}
        onDragOver={(e) => {
          // Same-group rows take the reorder insert indicator; cross-kind
          // rows let the event bubble so the group's kind-move highlight
          // (and drop) applies.
          if (!sameGroup) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          if (overModel !== d.model) setOverModel(d.model);
        }}
        onDrop={(e) => {
          if (!sameGroup) return; // falls through to the group's kind move
          e.preventDefault();
          e.stopPropagation();
          reorder(d.model);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setOverModel((cur) => (cur === d.model ? null : cur));
          }
        }}
        title="Drag to reorder (the dropdowns follow this order), or between Image and Video to re-classify."
      >
        <span className="expense-grip"><DragHandleIcon size={13} /></span>
        <input
          type="checkbox"
          checked={!d.hidden}
          onChange={() => void toggleHidden(i)}
          title={
            d.hidden
              ? "Hidden from generation dropdowns — check to show it again."
              : "Uncheck to hide this model from the generation dropdowns."
          }
        />
        <span className="expense-model" title={d.model}>
          {d.displayName || "Any model"}
          {d.hidden && <span className="expense-hidden-tag">hidden</span>}
        </span>
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder="$0.00"
          value={d.minText}
          onChange={(e) => update(i, { minText: e.target.value })}
        />
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder="$0.00"
          value={d.maxText}
          onChange={(e) => update(i, { maxText: e.target.value })}
        />
        <span className="hint" title={`The model's available resolution and video-length ladder this range interpolates over.`}>
          {ladderLabel(d)}
        </span>
      </div>
    );
  };

  const group = (provider: string, kind: ModelPriceDraft["kind"], title: string, empty: string) => {
    const isTarget = dropTarget?.provider === provider && dropTarget?.kind === kind;
    const rows = drafts
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.provider === provider && d.kind === kind && (showHidden || !d.hidden));
    return (
      <div
        key={`${provider}-${kind}`}
        className={"expense-group" + (isTarget ? " expense-drop-hover" : "")}
        onDragOver={(e) => {
          if (draggingId == null) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropTarget((t) => (t?.provider === provider && t?.kind === kind ? t : { provider, kind }));
        }}
        onDragLeave={() =>
          setDropTarget((t) => (t?.provider === provider && t?.kind === kind ? null : t))
        }
        onDrop={(e) => {
          e.preventDefault();
          try {
            const payload = JSON.parse(e.dataTransfer.getData("application/json") ?? "{}");
            if (payload && typeof payload.model === "string") void moveModel(provider, kind, payload);
          } catch {
            // ignore malformed drops
          }
        }}
      >
        <div className="expense-group-title">{title}</div>
        {rows.length ? (
          rows.map(({ d, i }) => renderRow(d, i))
        ) : (
          <p className="hint">{empty}</p>
        )}
      </div>
    );
  };

  return (
    <>
      <label>Models &amp; expenses</label>
      <p className="hint">
        Every model discovered across both media providers, grouped by vendor, with a min→max price range each:
        the cheapest configuration (lowest resolution, shortest video) up to the most expensive. A generation's
        price is interpolated by its resolution and length along the model's range. Saving <strong>re-prices all
        existing expenses</strong>. Unchecking a model's toggle hides it from the generation dropdowns immediately.
        Drag a row between Image and Video to override a mis-classified model — every model dropdown follows
        the manual assignment. Drag a row up or down its group to set the order every dropdown lists models in.
      </p>
      <div className="expense-pricing">
        {PROVIDER_ORDER.some((p) => drafts.some((d) => d.provider === p)) ? (
          PROVIDER_ORDER.map((p) => {
            if (!drafts.some((d) => d.provider === p)) return null;
            const isCollapsed = collapsed.has(p);
            return (
              <Fragment key={p}>
                <button
                  className="expense-provider-title"
                  onClick={() => toggleProvider(p)}
                  title={isCollapsed ? `Expand ${PROVIDER_LABELS[p] ?? p} models` : `Collapse ${PROVIDER_LABELS[p] ?? p} models`}
                >
                  <span className="expense-chevron">{isCollapsed ? "▸" : "▾"}</span>
                  {PROVIDER_LABELS[p] ?? p}
                </button>
                {!isCollapsed && (
                  <>
                    <div className="expense-rule expense-rule-head">
                      <span />
                      <span>Show</span>
                      <span>Model</span>
                      <span>Min $</span>
                      <span>Max $</span>
                      <span>Range</span>
                    </div>
                    {group(p, "image", "Image models", "No image models discovered.")}
                    <hr className="expense-divider" />
                    {group(p, "video", "Video models", "No video models discovered.")}
                  </>
                )}
              </Fragment>
            );
          })
        ) : (
          <p className="hint">No models discovered — is a media provider connected?</p>
        )}
        <div className="expense-pricing-actions">
          <button
            className="expense-eye"
            onClick={() => setShowHidden((v) => !v)}
            title={showHidden ? "Conceal the models hidden from the generation dropdowns (visual only — the list comes back next time you open Settings)." : "Show the models hidden from the generation dropdowns."}
          >
            {showHidden ? <EyeIcon size={14} /> : <EyeOffIcon size={14} />}
            {showHidden ? "Conceal hidden" : "Show hidden"}
          </button>
          <button
            onClick={() => void refresh()}
            disabled={busy}
            title="Re-probe all media providers for every available image and video model"
          >
            Refresh models
          </button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Working…" : "Save prices"}
          </button>
          <button onClick={() => void exportRules()} disabled={busy} title="Save the price ranges above to a CSV file">
            Export CSV
          </button>
          <button onClick={() => void importRules()} disabled={busy} title="Load price ranges from a CSV file" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ImportIcon size={13} /> Import CSV
          </button>
          {!showHidden && (
            <span className="hint">
              {drafts.filter((d) => d.hidden).length} hidden model{drafts.filter((d) => d.hidden).length === 1 ? "" : "s"} concealed
            </span>
          )}
          {note && <span className="hint" title={note}>{note.length > 90 ? `${note.slice(0, 90)}…` : note}</span>}
        </div>
      </div>
      {error && <p className="error-text">{error}</p>}
    </>
  );
}

/** Settings → Media generation: which MCP vendor serves image/video
 *  generation (global for all productions), plus the manual end-frame model
 *  allowlist for the in-betweener (merged with the providers' live probe).
 *  Model ids from the other vendor are treated as unknown until the user
 *  picks explicitly. */
function MediaProviderSection() {
  const [providers, setProviders] = useState<MediaProviderInfo[]>([]);
  const [active, setActive] = useState<string>("openart");
  const [error, setError] = useState<string | null>(null);
  /** Dev Mode: submission logging + dry run. */
  const [devMode, setDevMode] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  /** Manual end-frame allowlist, edited one id per line. */
  const [endFrameText, setEndFrameText] = useState("");
  const [endFrameSaved, setEndFrameSaved] = useState(false);
  /** Higgsfield CLI transport: custom binary path + live status. */
  const [cliBinary, setCliBinary] = useState("");
  const [cliBinarySaved, setCliBinarySaved] = useState(false);
  const [cliStatus, setCliStatus] = useState<{ binary: string | null; version: string | null; authenticated: boolean; account: string | null } | null>(null);
  /** OpenArt CLI transport: custom binary path + live status. */
  const [oaCliBinary, setOaCliBinary] = useState("");
  const [oaCliBinarySaved, setOaCliBinarySaved] = useState(false);
  const [oaCliStatus, setOaCliStatus] = useState<{ binary: string | null; version: string | null; authenticated: boolean; account: string | null } | null>(null);

  const refreshCli = () => {
    void window.cascade.getHiggsfieldCliBinary().then((p) => setCliBinary(p ?? "")).catch(() => {});
    void window.cascade.getHiggsfieldCliStatus().then(setCliStatus).catch(() => setCliStatus(null));
  };

  const refreshOaCli = () => {
    void window.cascade.getOpenArtCliBinary().then((p) => setOaCliBinary(p ?? "")).catch(() => {});
    void window.cascade.getOpenArtCliStatus().then(setOaCliStatus).catch(() => setOaCliStatus(null));
  };

  useEffect(() => {
    void window.cascade.listMediaProviders().then(setProviders).catch(() => {});
    void window.cascade.getMediaProvider().then(setActive).catch(() => {});
    void window.cascade.getEndFrameModels().then((ids) => setEndFrameText(ids.join("\n"))).catch(() => {});
    void window.cascade.getDevMode().then(setDevMode).catch(() => {});
    void window.cascade.getSubmissionDryRun().then(setDryRun).catch(() => {});
    refreshCli();
    refreshOaCli();
  }, []);

  const saveEndFrame = async () => {
    setEndFrameSaved(false);
    try {
      const ids = endFrameText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      await window.cascade.setEndFrameModels(ids);
      setEndFrameSaved(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const saveCliBinary = async () => {
    setCliBinarySaved(false);
    try {
      await window.cascade.setHiggsfieldCliBinary(cliBinary.trim() ? cliBinary.trim() : null);
      setCliBinarySaved(true);
      refreshCli();
      void window.cascade.listMediaProviders().then(setProviders).catch(() => {});
      window.dispatchEvent(new Event("cascade:media-provider-changed"));
    } catch (e) {
      setError(String(e));
    }
  };

  const saveOaCliBinary = async () => {
    setOaCliBinarySaved(false);
    try {
      await window.cascade.setOpenArtCliBinary(oaCliBinary.trim() ? oaCliBinary.trim() : null);
      setOaCliBinarySaved(true);
      refreshOaCli();
      void window.cascade.listMediaProviders().then(setProviders).catch(() => {});
      window.dispatchEvent(new Event("cascade:media-provider-changed"));
    } catch (e) {
      setError(String(e));
    }
  };

  const change = async (id: string) => {
    setActive(id);
    setError(null);
    try {
      await window.cascade.setMediaProvider(id as MediaProviderInfo["id"]);
      // ProductionWorkspace listens for this to re-read the provider and
      // repopulate its model dropdowns (same string there — keep in sync).
      window.dispatchEvent(new Event("cascade:media-provider-changed"));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <>
      <label>Media generation</label>
      {providers.map((p) => (
        <div className="row" key={p.id}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input type="radio" name="media-provider" checked={active === p.id} onChange={() => void change(p.id)} />
            {p.displayName}
          </label>
          <span className="hint">{p.available ? "connected" : p.id === "higgsfield-cli"
            ? "not found — install the higgsfield CLI (`npm i -g @higgsfield/cli`) or set a custom binary path below"
            : p.id === "openart-cli"
            ? "not found — install the openart CLI (https://github.com/OpenArt-AI/cli) or set a custom binary path below"
            : "not connected — add its MCP server below"}</span>
        </div>
      ))}
      <p className="hint">Which service generates storyboard frames, clips, and reference images. Applies to every production.</p>
      <label style={{ marginTop: 8 }}>Higgsfield CLI binary <span className="hint">(optional — blank resolves `higgsfield` from PATH)</span></label>
      <div className="row">
        <input
          type="text"
          value={cliBinary}
          onChange={(e) => { setCliBinary(e.target.value); setCliBinarySaved(false); }}
          placeholder="C:\Users\you\AppData\Roaming\npm\higgsfield.cmd"
          title="Full path to the higgsfield CLI binary. Leave blank to use the one on PATH."
          style={{ flex: 1 }}
        />
        <button onClick={() => void saveCliBinary()}>Save path</button>
        <button onClick={() => void refreshCli()} title="Re-check the binary, version, and login">Check status</button>
        {cliBinarySaved && <span className="hint">saved</span>}
      </div>
      {cliStatus && (
        <p className="hint">
          {cliStatus.binary ? `Binary: ${cliStatus.binary}` : "Binary: not found"}
          {cliStatus.version ? ` · ${cliStatus.version}` : ""}
          {` · ${cliStatus.authenticated ? `signed in${cliStatus.account ? ` as ${cliStatus.account}` : ""}` : "not signed in — run `higgsfield auth login` in a terminal"}`}
        </p>
      )}
      <label style={{ marginTop: 8 }}>OpenArt CLI binary <span className="hint">(optional — blank resolves `openart` from PATH)</span></label>
      <div className="row">
        <input
          type="text"
          value={oaCliBinary}
          onChange={(e) => { setOaCliBinary(e.target.value); setOaCliBinarySaved(false); }}
          placeholder="C:\Users\you\AppData\Local\Programs\openart\bin\openart.exe"
          title="Full path to the openart CLI binary. Leave blank to use the one on PATH."
          style={{ flex: 1 }}
        />
        <button onClick={() => void saveOaCliBinary()}>Save path</button>
        <button onClick={() => void refreshOaCli()} title="Re-check the binary, version, and login">Check status</button>
        {oaCliBinarySaved && <span className="hint">saved</span>}
      </div>
      {oaCliStatus && (
        <p className="hint">
          {oaCliStatus.binary ? `Binary: ${oaCliStatus.binary}` : "Binary: not found"}
          {oaCliStatus.version ? ` · ${oaCliStatus.version}` : ""}
          {` · ${oaCliStatus.authenticated ? `signed in${oaCliStatus.account ? ` as ${oaCliStatus.account}` : ""}` : "not signed in — run `openart login` in a terminal"}`}
        </p>
      )}
      <p className="hint">OpenArt CLI video takes a single start-frame image — no end frames or extra references. In-betweening and multi-reference video need the OpenArt MCP transport.</p>
      <label style={{ marginTop: 8 }}>In-betweener end-frame models</label>
      <textarea
        rows={3}
        value={endFrameText}
        onChange={(e) => { setEndFrameText(e.target.value); setEndFrameSaved(false); }}
        placeholder={"One video model id per line, e.g.\nseedance_2_5"}
        title="Video models that accept a start AND end frame. Merged with the live capability probe — anything listed here becomes selectable in the in-betweener node."
      />
      <div className="row">
        <button onClick={() => void saveEndFrame()}>Save end-frame models</button>
        {endFrameSaved && <span className="hint">saved</span>}
      </div>
      <p className="hint">The in-betweener only offers video models with a dedicated end-frame slot (probed live, or listed above).</p>
      <label style={{ marginTop: 8, display: "inline-flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={devMode}
          onChange={(e) => {
            const v = e.target.checked;
            setDevMode(v);
            void window.cascade.setDevMode(v).catch((err) => setError(String(err)));
          }}
        />
        Dev Mode (log every generation submission)
      </label>
      {devMode && (
        <>
          <p className="hint">Submissions append to &lt;userData&gt;/logs/submissions.md (+ submissions.jsonl). Secrets are redacted.</p>
          <div className="row">
            <button onClick={() => void window.cascade.openSubmissionLog().catch((err) => setError(String(err)))}>Open submission log</button>
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => {
                const v = e.target.checked;
                setDryRun(v);
                void window.cascade.setSubmissionDryRun(v).catch((err) => setError(String(err)));
              }}
            />
            Dry run (build + log submissions, spend no credits)
          </label>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </>
  );
}

export function SettingsPanel({ settings, onClose, onOpenAgents }: { settings: SettingsView; onClose: () => void; onOpenAgents?: () => void }) {
  const [provider, setProvider] = useState(settings.provider);
  const [apiKey, setApiKeyInput] = useState("");
  const [workspace, setWorkspace] = useState(settings.workspace);
  const [model, setModel] = useState(settings.model);
  const [accent, setAccent] = useState(settings.accent);
  const [externalEditor, setExternalEditor] = useState(settings.externalEditor);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [hasKey, setHasKey] = useState(settings.hasApiKey);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Why the model list is empty (real HTTP/API message, shown inline). */
  const [modelError, setModelError] = useState<string | null>(null);
  /** Which settings tab is open. */
  const [tab, setTab] = useState<"general" | "expenses">("general");
  /** 3D AI Studio API key (design-page 3D model generator). */
  const [has3daiKey, setHas3daiKey] = useState(settings.has3daiApiKey);
  const [apiKey3dai, setApiKey3daiInput] = useState("");
  /** Reference-thumbnail cache regeneration (Settings → General). */
  const [thumbsBusy, setThumbsBusy] = useState(false);
  const [thumbResult, setThumbResult] = useState<string | null>(null);

  const providerLabel = API_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;

  // Cheapest first; stable by id for ties.
  const sortedModels = useMemo(
    () => [...models].sort((a, b) => a.baseCost - b.baseCost || a.id.localeCompare(b.id)),
    [models]
  );

  useEffect(() => {
    if (hasKey) void loadModels();
  }, [hasKey]);

  // A provider may have no stored model yet (or its saved model is gone) —
  // fall back to its first listed model so we never send an empty model.
  useEffect(() => {
    if (sortedModels.length === 0) return;
    if (!sortedModels.some((m) => m.id === model)) {
      void changeModel(sortedModels[0].id);
    }
  }, [sortedModels, model]);

  /** Fetch the current provider's models; surfaces the real failure reason. */
  async function loadModels(): Promise<ModelInfo[]> {
    const res = await window.cascade.listModels();
    if (!res.ok) {
      setModelError(res.error);
      return [];
    }
    setModelError(null);
    return res.models;
  }

  async function changeProvider(id: string) {
    setProvider(id);
    setError(null);
    try {
      await window.cascade.setProvider(id);
      const s = await window.cascade.getSettings();
      setHasKey(s.hasApiKey);
      setModel(s.model);
      setApiKeyInput("");
      setModels(s.hasApiKey ? await loadModels() : []);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveKey() {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await window.cascade.setApiKey(apiKey.trim());
      setApiKeyInput("");
      setHasKey(true);
      // Refresh the model list for the current provider immediately — the
      // key just changed, so stale models (or an empty list) would be wrong.
      setModels(await loadModels());
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function save3daiKey() {
    if (!apiKey3dai.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await window.cascade.set3daiApiKey(apiKey3dai.trim());
      setApiKey3daiInput("");
      setHas3daiKey(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function pickWorkspace() {
    const dir = await window.cascade.pickWorkspace();
    if (dir) setWorkspace(dir);
  }

  /** Pre-generate the compressed reference thumbnails for every production. */
  async function regenerateThumbs() {
    if (thumbsBusy) return;
    setThumbsBusy(true);
    setThumbResult(null);
    try {
      const r = await window.cascade.regenerateThumbnails();
      setThumbResult(`${r.projects} project${r.projects === 1 ? "" : "s"} · ${r.generated} created · ${r.fromDisk} reused${r.failed ? ` · ${r.failed} skipped` : ""}`);
    } catch (e) {
      setThumbResult(`Failed: ${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setThumbsBusy(false);
    }
  }

  async function changeModel(id: string) {
    setModel(id);
    await window.cascade.setModel(id);
  }

  async function refreshModels() {
    setError(null);
    setModels(await loadModels());
  }

  /** Persist + live-apply a new accent color. */
  function changeAccent(color: string) {
    setAccent(color);
    applyAccent(color);
    void window.cascade.setAccent(color);
  }

  async function pickExternalEditor() {
    try {
      const picked = await window.cascade.pickExternalEditor();
      if (picked) setExternalEditor(picked);
    } catch (e) {
      setError(String(e));
    }
  }

  async function clearExternalEditor() {
    try {
      await window.cascade.setExternalEditor(null);
      setExternalEditor(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveExternalEditor(path: string | null) {
    const trimmed = path?.trim() ? path.trim() : null;
    // Allow WindowsApps even though it may not pass exists check — we bake elevation for it.
    try {
      await window.cascade.setExternalEditor(trimmed);
      setExternalEditor(trimmed);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  const ready = hasKey;

  return (
    <div className="modal-backdrop">
      <div className="modal settings">
        <h3>Settings</h3>

        <div className="settings-tabs" role="tablist">
          <button role="tab" className={"settings-tab" + (tab === "general" ? " active" : "")} onClick={() => setTab("general")}>General</button>
          <button role="tab" className={"settings-tab" + (tab === "expenses" ? " active" : "")} onClick={() => setTab("expenses")}><ExpensesIcon size={13} /> Models &amp; expenses</button>
        </div>

        {tab === "general" && (
          <>
        <label>API provider</label>
        <select value={provider} onChange={(e) => void changeProvider(e.target.value)}>
          {API_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <p className="hint">Which API powers chat, auto-titles, and the production pipeline's LLM steps. Each provider keeps its own key and model.</p>

        <label>{providerLabel} API key</label>
        {hasKey ? (
          <p className="hint">
            Key saved (encrypted). <button className="link" onClick={() => setHasKey(false)}>Replace</button>
          </p>
        ) : (
          <div className="row">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
            <button onClick={() => void saveKey()} disabled={saving || !apiKey.trim()}>
              Save
            </button>
          </div>
        )}

        <label>Default folder for new chats</label>
        <div className="row">
          <span className="path">{workspace ?? "None — pure chat"}</span>
          <button onClick={() => void pickWorkspace()}>Choose…</button>
          <button
            onClick={() => {
              setWorkspace(null);
              void window.cascade.clearDefaultWorkspace();
            }}
          >
            None
          </button>
        </div>
        <p className="hint">
          "None" makes new chats plain chat (no file access). Each chat can use its own folder — click the chip above
          the conversation to change it. Cascade can only read and change files inside the chat's folder.
        </p>

        <label>Model</label>
        <div className="row">
          <select value={model} onChange={(e) => void changeModel(e.target.value)} disabled={!hasKey} style={{ flex: 1 }}>
            {sortedModels.length === 0 && <option value={model}>{model}</option>}
            {sortedModels.map((m) => (
              <option key={m.id} value={m.id} title={m.costTitle}>
                {m.costLabel.startsWith("$") ? `${m.id} (${m.costLabel})` : m.id}
              </option>
            ))}
          </select>
          <button onClick={() => void refreshModels()} disabled={!hasKey} title="Re-fetch the model list from this provider">
            Refresh models
          </button>
        </div>
        {hasKey && models.length === 0 && modelError && <p className="error-text">{modelError}</p>}
        <p className="hint">Models are listed cheapest first. Hover a cost badge in the header picker for details.</p>

        <label>Accent color</label>
        <div className="accent-row">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.value}
              className={`accent-swatch${accent.toLowerCase() === p.value ? " selected" : ""}`}
              style={{ background: p.value }}
              title={p.name}
              aria-label={`Accent color: ${p.name}`}
              onClick={() => changeAccent(p.value)}
            />
          ))}
          <input
            type="color"
            className="accent-custom"
            value={accent}
            title="Custom accent color"
            onChange={(e) => changeAccent(e.target.value)}
          />
        </div>
        <p className="hint">Highlights, links, and selection outlines. Applied immediately.</p>

        <label>External image editor</label>
        <div className="row">
          <input
            value={externalEditor ?? ""}
            placeholder="System default — paste path e.g. ...\WindowsApps\Affinity.exe"
            onChange={(e) => setExternalEditor(e.target.value || null)}
            onBlur={(e) => void saveExternalEditor(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setExternalEditor(settings.externalEditor); }}
            style={{ flex: 1, minWidth: 220 }}
            title={externalEditor ?? "System default"}
          />
          <button onClick={() => void pickExternalEditor()}>Choose…</button>
          {externalEditor && <button onClick={() => void clearExternalEditor()}>Clear</button>}
        </div>
        <p className="hint">
          Photoshop, Affinity, etc. Right-click any reference or generated frame and choose “Edit externally” to open it here.
          Windows Store apps (e.g. <code>...\WindowsApps\Affinity.exe</code>) are ACL-locked — the file picker can't enter that folder, so paste the full path above. It will be launched elevated (UAC) automatically.
        </p>

        <label>3D AI Studio API key</label>
        {has3daiKey ? (
          <p className="hint">
            Key saved (encrypted). <button className="link" onClick={() => setHas3daiKey(false)}>Replace</button>
          </p>
        ) : (
          <div className="row">
            <input
              type="password"
              value={apiKey3dai}
              placeholder="3D AI Studio API key"
              onChange={(e) => setApiKey3daiInput(e.target.value)}
            />
            <button onClick={() => void save3daiKey()} disabled={saving || !apiKey3dai.trim()}>
              Save
            </button>
          </div>
        )}
        <p className="hint">
          Powers the 3D model generator on the Design page (Tencent Hunyuan Pro via 3dai.studio). Get a key and buy
          credits in the{" "}
          <a href="https://www.3daistudio.com/Platform/API" target="_blank" rel="noreferrer">3D AI Studio API dashboard</a>.
        </p>

        <label>Agents</label>
        <p className="hint">
          Custom personas with their own prompt, model, avatar, and tools.
          {onOpenAgents && <> <button className="link" onClick={onOpenAgents}>Manage agents</button></>}
        </p>

        <label>Skills</label>
        <p className="hint">
          Markdown files that teach Cascade repeatable workflows. Drop .md files in the skills folder; Cascade
          reads them when relevant.{" "}
          <button className="link" onClick={() => void window.cascade.openSkillsFolder()}>
            Open skills folder
          </button>
        </p>

        <label>Reference thumbnails</label>
        <p className="hint">
          The node graph shows small compressed JPEGs of your references so large projects load fast. Pre-generate
          them here for every project (re-running is cheap — valid thumbnails are reused, stale ones pruned).
        </p>
        <div className="row">
          <button disabled={thumbsBusy} onClick={() => void regenerateThumbs()}>
            {thumbsBusy ? "Generating…" : "Regenerate thumbnail cache"}
          </button>
          {thumbResult && <span className="hint" style={{ flex: 1 }}>{thumbResult}</span>}
        </div>

        {error && <p className="error-text">{error}</p>}

        <MediaProviderSection />
        <McpSection />
          </>
        )}

        {tab === "expenses" && (
          <ExpensePricingSection />
        )}

        <div className="modal-actions">
          <button className="primary" onClick={onClose} disabled={!ready}>
            {ready ? "Done" : "Add your API key to continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
