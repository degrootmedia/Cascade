/**
 * Image Generation & Editing Suite — the Production Assistant's dedicated
 * generate/edit workspace, rendered in place of the step content (like the
 * Expenses panel).
 *
 * It owns one production's suite session (history + draft, persisted per
 * project under userData/suites/<prodId>.json) and wires the three panes:
 * history rail | canvas (+compare) | prompt panel. Every submit rides the
 * vendor-blind `suite:generate` IPC.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CliModelSchema,
  OpenArtModelChoice,
  Production,
  SuiteSeed,
} from "../../../../shared/ipc.js";
import {
  emptySuiteSession,
  normalizeSuiteSession,
  type SuiteGenerateRequest,
  type SuiteSession,
} from "../../../../shared/ipc.js";
import { allPromptRefs } from "../../components/production/references.js";
import { cascadeMedia } from "../../components/production/animatic.js";
import { primeModelParamDefaults, seedModelOptionValues } from "../../components/production/model-param-defaults.js";
import { pruneModelOptionValues } from "../../components/ModelOptionsForm.js";
import { isQuotableCostModel, useGenerationCost } from "../../components/production/generation-cost.js";
import { SuiteHistoryRail } from "./SuiteHistoryRail.js";
import { SuiteCanvas } from "./SuiteCanvas.js";
import { SuitePromptPanel } from "./SuitePromptPanel.js";
import { resolveSuiteCompare, seedSourceFrame } from "./suite-compare.js";
import { resolveSuiteModel, resolveSuiteSurfacePool } from "./suite-models.js";
import { openImageSuite } from "./suite-handoff.js";

/** Debounce before persisting the session document to disk. */
const SAVE_DEBOUNCE_MS = 400;

export function ImageSuite({
  prod,
  onProdChange,
  models,
  providerName,
  providerAvailable,
  upscaleUnavailable = false,
  seed,
  onSeedConsumed,
}: {
  prod: Production;
  /** Adopt a production changed by an export (a new reference). */
  onProdChange: (p: Production) => void;
  models: OpenArtModelChoice[];
  providerName: string;
  providerAvailable: boolean;
  /** The active provider has no upscale path (OpenArt MCP) — Upscale mode is
   *  disabled with an explanatory hint. */
  upscaleUnavailable?: boolean;
  /** A one-shot "Open in Suite" handoff; consumed via onSeedConsumed. */
  seed: SuiteSeed | null;
  onSeedConsumed: () => void;
}) {
  const prodId = prod.meta.id;
  const [session, setSession] = useState<SuiteSession>(() => emptySuiteSession());
  const [schema, setSchema] = useState<CliModelSchema | null>(null);
  /** Upscale-capable model ids (provider probe ∪ `image:upscale` assignments). */
  const [upscaleModelIds, setUpscaleModelIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchParentId, setBranchParentId] = useState<string | null>(null);
  /** True once the on-disk session for the current production has loaded —
   *  persistence stays off until then so a handoff can't clobber stored
   *  entries with the pre-load draft. */
  const [loaded, setLoaded] = useState(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  /** A handoff seed waiting to be merged into the freshly-loaded session. */
  const seedRef = useRef<SuiteSeed | null>(null);
  const lastSeedRef = useRef<SuiteSeed | null>(null);
  const prodIdRef = useRef(prodId);
  prodIdRef.current = prodId;
  const loadedRef = useRef(false);
  loadedRef.current = loaded;

  // Flush the pending debounced save when the suite closes, so switching away
  // right after an edit never loses it.
  useEffect(() => () => {
    if (prodIdRef.current && loadedRef.current) {
      void window.cascade.saveSuiteSession(prodIdRef.current, sessionRef.current).catch(() => {});
    }
  }, []);

  // Prime the per-model param-default cache once.
  useEffect(() => { void primeModelParamDefaults(); }, []);

  // The upscale capability list (probe ∪ `image:upscale` surface assignments),
  // refreshed when the Model Customizer changes provider/surfaces.
  useEffect(() => {
    let live = true;
    const api = window.cascade as { imageUpscaleModels?: () => Promise<string[]> };
    if (typeof api.imageUpscaleModels !== "function") return () => { live = false; };
    const load = () => {
      void api.imageUpscaleModels!()
        .then((ids) => { if (live) setUpscaleModelIds(ids ?? []); })
        .catch(() => { if (live) setUpscaleModelIds([]); });
    };
    load();
    window.addEventListener("cascade:media-provider-changed", load);
    return () => { live = false; window.removeEventListener("cascade:media-provider-changed", load); };
  }, [prodId]);

  // Load the production's session whenever the project changes.
  useEffect(() => {
    let live = true;
    setError(null);
    setSchema(null);
    setBranchParentId(null);
    setLoaded(false);
    void window.cascade.loadSuiteSession(prodId).then((s) => {
      if (!live) return;
      const normalized = normalizeSuiteSession(s);
      // A pending handoff seed overlays the persisted draft once.
      const pending = seedRef.current;
      seedRef.current = null;
      setSession({ ...normalized, draft: pending ? { ...normalized.draft, ...pending } : normalized.draft });
      setBranchParentId(normalized.selectedId);
      setLoaded(true);
    });
    return () => { live = false; };
  }, [prodId]);

  // Apply a handoff seed (a popup's "Open in Suite"). Identity changes per
  // handoff, so re-opening with a different setup re-seeds the draft. An edit
  // handoff also clears the selection so the canvas reveals the source image as
  // the "Before edit" frame until the first edit lands.
  useEffect(() => {
    if (!seed || seed === lastSeedRef.current) return;
    lastSeedRef.current = seed;
    seedRef.current = seed;
    const isSourceHandoff = seed.mode !== "generate" && !!(seed.sourceRefId || seed.sourcePath);
    setSession((s) => ({
      ...s,
      ...(isSourceHandoff ? { selectedId: null } : {}),
      draft: { ...s.draft, ...seed },
    }));
    if (isSourceHandoff) {
      setBranchParentId(null);
    }
    onSeedConsumed();
  }, [seed, onSeedConsumed]);

  // Schema for the picked model (advanced options).
  const draft = session.draft;
  useEffect(() => {
    let live = true;
    setSchema(null);
    if (!draft.model) return () => { live = false; };
    void window.cascade.modelOptions(draft.model).then((s) => {
      if (!live) return;
      setSchema(s);
      setSession((prev) => ({
        ...prev,
        draft: {
          ...prev.draft,
          params: seedModelOptionValues(
            s,
            prev.draft.model,
            prev.draft.mode === "edit" ? "image:edit" : prev.draft.mode === "upscale" ? "image:upscale" : "image:generate",
            pruneModelOptionValues(s, prev.draft.params ?? {})
          ) as SuiteSession["draft"]["params"],
        },
      }));
    }).catch(() => { if (live) setSchema(null); });
    return () => { live = false; };
  }, [draft.model, draft.mode]);

  // Debounced session persistence (only after the initial load).
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      void window.cascade.saveSuiteSession(prodId, sessionRef.current).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [session, prodId, loaded]);

  const entries = session.entries;
  const selected = useMemo(() => entries.find((e) => e.id === session.selectedId) ?? null, [entries, session.selectedId]);
  const branchParent = useMemo(() => entries.find((e) => e.id === branchParentId) ?? null, [entries, branchParentId]);
  const promptRefs = useMemo(() => allPromptRefs(prod), [prod]);
  const media = useCallback((rel: string) => cascadeMedia(prodId, rel), [prodId]);
  // The canvas wipe pair: a selected edit's resolved source vs its result.
  const compare = useMemo(
    () => resolveSuiteCompare({ entries, selectedId: session.selectedId, prod, media }),
    [entries, session.selectedId, prod, media]
  );
  // With nothing selected, an edit draft reveals its resolved source as the
  // "Before edit" frame (the reveal a handoff produces).
  const before = useMemo(
    () => (!compare && !selected && draft.mode !== "generate" ? seedSourceFrame(draft, prod, media) : null),
    [compare, selected, draft, prod, media]
  );
  // Right-click a suite result → start a new edit seeded with that result.
  const editInSuite = useCallback(
    (rel: string) => openImageSuite(prodId, { mode: "edit", sourcePath: rel }),
    [prodId]
  );

  // The models the current mode offers (the same pool the panel's dropdown
  // shows). The suite resolves its effective model through it so submit always
  // sends the model that's displayed.
  const surfacePool = useMemo(
    () => resolveSuiteSurfacePool(models, draft.mode, upscaleModelIds),
    [models, draft.mode, upscaleModelIds]
  );

  // Live quote captured at submit time.
  const effectiveModel = resolveSuiteModel(draft.model, surfacePool);
  const costReq = isQuotableCostModel(effectiveModel)
    ? {
        model: effectiveModel,
        kind: "image" as const,
        resolution: draft.resolution,
        aspectRatio: draft.aspectRatio,
        ...(draft.params && Object.keys(draft.params).length ? { params: { ...draft.params } } : {}),
      }
    : null;
  const { cost: quotedCredits } = useGenerationCost(costReq);

  const patchDraft = useCallback((patch: Partial<SuiteSession["draft"]>) => {
    setSession((s) => ({ ...s, draft: { ...s.draft, ...patch } }));
  }, []);

  // Keep the draft's model a real pick from the active provider's current pool.
  // When the draft is empty or holds a stale cross-vendor pick (a session or
  // handoff from before a provider switch), the form displays the pool's first
  // model — reconcile the draft to it so submit sends that same model instead
  // of an empty value that falls through to the production's Step-3 model.
  useEffect(() => {
    if (!surfacePool.length) return;
    const resolved = resolveSuiteModel(draft.model, surfacePool);
    if (resolved && resolved !== draft.model) patchDraft({ model: resolved });
  }, [surfacePool, draft.model, patchDraft]);

  // If the provider switches to one without an upscale path while Upscale mode
  // is active, fall back to Generate so the panel never sits on a dead mode.
  useEffect(() => {
    if (upscaleUnavailable && session.draft.mode === "upscale") patchDraft({ mode: "generate" });
  }, [upscaleUnavailable, session.draft.mode, patchDraft]);

  const submit = useCallback(async () => {
    if (busy) return;
    const d = sessionRef.current.draft;
    if (d.mode !== "upscale" && !d.prompt.trim()) { setError("Describe what to generate or edit first."); return; }
    if (d.mode !== "generate" && !d.sourceRefId && !d.sourcePath) { setError(`Pick a reference or frame to ${d.mode}.`); return; }
    setBusy(true);
    setError(null);
    try {
      // Submit the model the dropdown shows, never a stale/empty draft: an
      // empty value would let the provider fall back to the production's
      // Step-3 model (a different surface, possibly a foreign vendor id).
      const model = resolveSuiteModel(d.model, resolveSuiteSurfacePool(models, d.mode, upscaleModelIds));
      const req: SuiteGenerateRequest = {
        kind: d.mode,
        parentId: branchParentId,
        model,
        resolution: d.resolution,
        prompt: d.mode === "upscale" ? "" : d.prompt.trim(),
        ...(d.aspectRatio ? { aspectRatio: d.aspectRatio } : {}),
        ...(d.mode !== "generate" && d.sourceRefId ? { sourceRefId: d.sourceRefId } : {}),
        ...(d.mode !== "generate" && !d.sourceRefId && d.sourcePath ? { sourcePath: d.sourcePath } : {}),
        ...(d.mode !== "upscale" && d.refIds.length ? { refIds: d.refIds } : {}),
        ...(d.params && Object.keys(d.params).length ? { params: d.params } : {}),
        ...(quotedCredits != null ? { quotedCredits } : {}),
      };
      const entry = await window.cascade.generateSuiteImage(prodId, req);
      setSession((s) => ({ ...s, entries: [...s.entries, entry], selectedId: entry.id }));
      setBranchParentId(entry.id);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }, [prodId, busy, branchParentId, quotedCredits, models, upscaleModelIds]);

  const selectEntry = useCallback((id: string) => {
    setSession((s) => ({ ...s, selectedId: id }));
    setBranchParentId(id);
    const entry = sessionRef.current.entries.find((e) => e.id === id);
    if (entry) {
      patchDraft({
        mode: entry.kind,
        prompt: entry.prompt,
        model: entry.model,
        resolution: entry.resolution,
        ...(entry.aspectRatio ? { aspectRatio: entry.aspectRatio } : {}),
        ...(entry.sourceRefId ? { sourceRefId: entry.sourceRefId } : {}),
        ...(!entry.sourceRefId && entry.sourcePath ? { sourcePath: entry.sourcePath } : {}),
        ...(entry.params ? { params: entry.params } : {}),
      });
    }
  }, [patchDraft]);

  const deleteEntry = useCallback(async (id: string) => {
    try {
      const next = await window.cascade.deleteSuiteEntry(prodId, id);
      setSession(next);
      setBranchParentId((b) => (b === id ? null : b));
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
  }, [prodId]);

  const exportEntry = useCallback(async (target: "references" | "boards") => {
    if (!selected) return;
    try {
      const res = await window.cascade.exportSuiteEntry(prodId, selected.id, target);
      if (res.production) onProdChange(res.production);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
  }, [prodId, selected, onProdChange]);

  return (
    <div className="suite">
      <SuiteHistoryRail
        prodId={prodId}
        entries={entries}
        selectedId={session.selectedId}
        busy={busy}
        onSelect={selectEntry}
        onDelete={(id) => void deleteEntry(id)}
        onEditInSuite={editInSuite}
      />
      <SuiteCanvas
        prodId={prodId}
        entry={selected}
        compare={compare}
        before={before}
        busy={busy}
        onExport={(t) => void exportEntry(t)}
        onDelete={() => selected && void deleteEntry(selected.id)}
        onEditInSuite={editInSuite}
      />
      <SuitePromptPanel
        prod={prod}
        draft={draft}
        onDraftChange={patchDraft}
        models={models}
        upscaleModelIds={upscaleModelIds}
        promptRefs={promptRefs}
        schema={schema}
        submitting={busy}
        error={error}
        providerName={providerName}
        providerAvailable={providerAvailable}
        upscaleUnavailable={upscaleUnavailable}
        branchParent={branchParent}
        onRunAsRoot={() => setBranchParentId(null)}
        quotedCredits={quotedCredits}
        onSubmit={() => void submit()}
      />
    </div>
  );
}
