/**
 * Production Assistant workspace: production picker/creator on first entry,
 * then a 5-step pipeline view. Step 1 (script ingestion + shot table) is live;
 * later steps show their planned surface and keep persisted state (style).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TWEEN_KEY_IMGGEN, TWEEN_KEY_EDITGEN, TWEEN_KEY_EDITGEN_PREFIX, isImageModel, isVideoModel, modelOnSurface, styleFrameOverride, type Production, type ProductionMeta, type ProductionShot, type OpenArtModelChoice, type SuggestedReference, type ReferenceCategory, type CustomRef, type VideoGenOptions, type VideoModelOptions, type CliModelSchema, type GenerationCostRequest, type GraphLayout, type GraphEditNode, type ReferenceImageGenOptions, type CharacterSheetGenOptions } from "../../../shared/ipc.js";
import { addRefTag, composePromptBoxes, parsePromptBoxes, refTagNames } from "../../../shared/prompt-grammar.js";
import { isFresh, revOf } from "../../../shared/snapshot-freshness.js";
import { findGeneration, generationInUse, generationInUseMessage } from "../../../shared/generations.js";
import { ShotTable } from "./ShotTable.js";
import { NodeGraphModal, VIDEO_PROMPT_DEFAULT, type GraphRef } from "./NodeGraphModal.js";
import { filterTweenModels } from "./TweenTimelineModal.js";
import { TriplePrompt, type PromptContentHandle } from "./TriplePrompt.js";
import { AnimaticTimeline, cascadeMedia, MiniAudioPlayer, ProdLog, StepFooter, VolumeSlider, type LogLine, formatRuntime, STEPS } from "./production/animatic.js";
import { ReferenceCategorySection, RefGenModal, CharacterBuilderSection, allPromptRefs, referenceNamesById, promptRefsForShot, shotStyleSelectValue, reorderRefs, uniqueRefName } from "./production/references.js";
import { PromptSidePanel } from "./production/prompt-panel.js";
import { BoardCard, EditBoardModal, StoryboardPdfModal, VideoGenModal } from "./production/boards.js";
import { ModelOptionsForm, pruneModelOptionValues, type ModelOptionValues } from "./ModelOptionsForm.js";
import { AssemblyPanel } from "./production/assembly.js";
import { ExpensesPanel } from "./production/expenses.js";
import { BrandSwatchRow } from "./production/brand.js";
import { ModelGenSection } from "./production/modelgen.js";
import { uid } from "./production/hex.js";
import { usePersistedCollapsed } from "./production/persisted-state.js";
import { getMediaDefault, primeMediaDefaults, rememberMediaDefault, rememberedModel } from "./production/media-defaults.js";
import { StyleParamsForm } from "./production/style-params.js";
import { GenerationCostSuffix } from "./production/generation-cost-label.js";
import { isQuotableCostModel } from "./production/generation-cost.js";
import { primeModelParamDefaults, seedModelOptionValues } from "./production/model-param-defaults.js";
import { renderShotPrompt, renderPromptText, promptRefsFor } from "../../../shared/graph/render.js";
import { setBrandEdge, setStyleEdge } from "../../../shared/graph/connect.js";
import { EditIcon, ExpensesIcon, ImageIcon, MagicIcon, MagnifyIcon, PlusIcon, RegenerateIcon, XIcon } from "./icons.js";

/** Hard cap on the Step 2 style set. */
const MAX_STYLES = 5;

/** The one warning shown before any generation is deleted. */
const DELETE_GENERATION_WARNING =
  "Are you sure you want to delete this generation? This permanently removes it from your disk, but you can always access it again on your Higgsfield/OpenArt account.";

/** Collapsible Step 2 panel — one per Design section (Visual styles / Brand
 * identity / References) so each reads as its own block. Collapse state is
 * persisted per production so it survives step switches and app restarts. */
function DesignSection({ title, prodId, children }: {
  title: string;
  prodId: string;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = usePersistedCollapsed(`cascade.prod.${prodId}.design.${title}`);
  const open = !collapsed;
  return (
    <div className="prod-design-section">
      <button className="prod-design-head" onClick={() => setCollapsed(!collapsed)} aria-expanded={open}>
        <span className={"prod-caret" + (open ? " open" : "")}>▸</span>
        <span className="prod-design-title">{title}</span>
      </button>
      {open && <div className="prod-design-body">{children}</div>}
    </div>
  );
}


export function ProductionWorkspace({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [list, setList] = useState<ProductionMeta[]>([]);
  const [prod, setProd] = useState<Production | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // expenses page (far-right tab) replaces the step content while open
  const [showExpenses, setShowExpenses] = useState(false);
  // creation form
  const [newName, setNewName] = useState("");
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  // step 1 form
  const [gdocUrl, setGdocUrl] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  // step 2: per-style refinement (tracks which style card is refining)
  const [refiningStyleId, setRefiningStyleId] = useState<string | null>(null);
  // step 2: generating a style from an imported/pasted image (spinner on buttons)
  const [styleImgBusy, setStyleImgBusy] = useState(false);
  // step 2: which style card is generating/uploading its frame (look anchor)
  const [styleFrameBusy, setStyleFrameBusy] = useState<string | null>(null);
  // step 2: enlarged style-frame image (lightbox), or null when closed
  const [styleZoom, setStyleZoom] = useState<string | null>(null);
  // step 2: set when the active chat model can't see images (shows a popup)
  const [visionWarnModel, setVisionWarnModel] = useState<string | null>(null);
  // step 3: board generation
  const [frameZoom, setFrameZoom] = useState(250);
  const [boardsBusy, setBoardsBusy] = useState(false);
  // Step 3: whether the Audio/Visual direction boxes render under each frame.
  const [showBoardText, setShowBoardText] = useState(true);
  /** Shot ids currently regenerating (a Set so several frames can run in parallel). */
  const [regenIds, setRegenIds] = useState<Set<string>>(new Set());
  /** Shot ids whose pending generation job is being rechecked. */
  const [recheckIds, setRecheckIds] = useState<Set<string>>(new Set());
  // Regeneration batches are dispatched via `regenerateBoards` (one shared
  // production → parallel workers → a single save). Overlapping batches would
  // each load/save the whole production and clobber each other, so batches run
  // strictly one at a time; clicks during a run join the next batch.
  const regenRunningRef = useRef(false);
  const regenPendingRef = useRef<string[]>([]);
  // Per-shot thumbnail cache-busters: bumping one shot reloads only that
  // card's thumbnail (BoardCard's effect depends on its own bust value).
  // `boardBustAll` is the global epoch for bulk changes (generate-all,
  // reorder, import-scan) that genuinely touch every frame.
  const [boardBustMap, setBoardBustMap] = useState<Record<string, number>>({});
  const [boardBustAll, setBoardBustAll] = useState(0);
  const bustOne = useCallback((shotId: string) => {
    setBoardBustMap((prev) => ({ ...prev, [shotId]: (prev[shotId] ?? 0) + 1 }));
  }, []);
  const bustMany = useCallback((ids: string[]) => {
    setBoardBustMap((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = (next[id] ?? 0) + 1;
      return next;
    });
  }, []);
  const bustAll = useCallback(() => { setBoardBustAll((b) => b + 1); }, []);
  const boardBustFor = useCallback((shotId: string) => (boardBustMap[shotId] ?? 0) + boardBustAll * 1_000_000, [boardBustMap, boardBustAll]);
  const [boardDragId, setBoardDragId] = useState<string | null>(null);
  const [boardDropTarget, setBoardDropTarget] = useState<string | null>(null);
  const boardDragRef = useRef<string | null>(null);
  const [magicBusy, setMagicBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  /** Reference ids with a delete in flight — guards double-clicks while the
   *  atomic main-side delete runs. */
  const [removingRefIds, setRemovingRefIds] = useState<Set<string>>(new Set());
  const [mediaOk, setMediaOk] = useState<boolean | null>(null);
  const [mediaModels, setMediaModels] = useState<OpenArtModelChoice[]>([]);
  /** The dropdowns' remembered last choices are async-loaded once — the
   *  prod.openArt seed below waits for them so a fresh production starts at
   *  the last chosen model, not whatever loaded first. */
  const [mediaDefaultsReady, setMediaDefaultsReady] = useState(false);
  /** Active media provider display name (global setting). */
  const [mediaProviderName, setMediaProviderName] = useState<string>("OpenArt");
  /** Active media provider id — tracked so model lists refetch when the
   *  provider is switched in Settings while the workspace is open. */
  const [mediaProviderId, setMediaProviderId] = useState<string>("openart");
  const [voUrl, setVoUrl] = useState<string | null>(null);
  const [voDuration, setVoDuration] = useState<number | null>(null);
  const [musicUrl, setMusicUrl] = useState<string | null>(null);
  const [audioBust, setAudioBust] = useState(0);
  // Live volume targets for the inline preview players (so the sliders can
  // adjust playback volume during the drag, not just after release).
  const voPreviewRef = useRef<HTMLAudioElement | null>(null);
  const musicPreviewRef = useRef<HTMLAudioElement | null>(null);
  // step 3: per-frame AI edit (modal open on this shot id); edits run in the
  // background so more can be queued while others generate.
  const [editShotId, setEditShotId] = useState<string | null>(null);
  const [editBusyIds, setEditBusyIds] = useState<string[]>([]);
  // Per-shot video generation: modal opens on this shot id; generation runs in
  // the background (videoBusyIds tracks in-flight shots for button spinners).
  const [videoShotId, setVideoShotId] = useState<string | null>(null);
  const [videoBusyIds, setVideoBusyIds] = useState<string[]>([]);
  // Step 3 node graph generations also run in the background: the graph modal
  // (and its node views) unmount when the user moves elsewhere, so in-flight
  // state lives here — keyed per shot — so reopening the graph still shows
  // "Generating…". Sets survive step switches and shot switches.
  const [nodeImageBusyIds, setNodeImageBusyIds] = useState<Set<string>>(new Set());
  const [nodeVideoBusyIds, setNodeVideoBusyIds] = useState<Set<string>>(new Set());
  const [nodeEditVideoBusyIds, setNodeEditVideoBusyIds] = useState<Set<string>>(new Set());
  const [nodeEditBusyIds, setNodeEditBusyIds] = useState<Set<string>>(new Set());
  /** In-betweener block currently generating, keyed by shot id → block id. */
  const [tweenBusyByShot, setTweenBusyByShot] = useState<Record<string, string>>({});
  /** Shot ids with a stitch/unstitch in flight. */
  const [tweenStitchingIds, setTweenStitchingIds] = useState<Set<string>>(new Set());
  // Step 3 storyboard-PDF export dialog (layout + version + logo options).
  const [pdfOpen, setPdfOpen] = useState(false);
  // Step 2 reference-image generation/edit modal. `refId` preselects edit mode
  // (that reference becomes the AI source); `categoryId` defaults the generate
  // mode's target category.
  const [refGen, setRefGen] = useState<{ categoryId?: string; refId?: string } | null>(null);
  const [promptShotId, setPromptShotId] = useState<string | null>(null);
  const [focusedPrompt, setFocusedPrompt] = useState("");
  // Step 3 node graph: opens for the focused shot; overlays the storyboard.
  const [graphShotId, setGraphShotId] = useState<string | null>(null);
  const promptSaveQueue = useRef(Promise.resolve());
  const latestPromptRef = useRef<Record<string, string>>({});
  const promptCacheRef = useRef<Record<string, string>>({});
  /** Newest Production.rev applied so far. Whole-object IPC snapshots with an
   *  older rev are stale (e.g. a prompt save produced before an insert/delete
   *  resolving after it) and must not overwrite newer structural state — that
   *  stale overwrite resurrected deleted "ghost" shots and broke prompt editing
   *  until restart. */
  const prodRevRef = useRef(0);
  /** Consecutive prompt-refetch failures per shot (Fix D retry cap). Reset on
   *  success so a persistently-missing shot can't bust in a tight loop. */
  const promptRetryRef = useRef<Record<string, number>>({});
  // Latest production kept in a ref (updated every render) so effect-registered
  // listeners — the Ctrl+V paste handlers — never write stale field state back
  // over newer saves (e.g. dismissing a suggestion, then pasting an image used
  // to resurrect the dismissed suggestion from the stale closure).
  const prodRef = useRef<Production | null>(prod);
  prodRef.current = prod;

  // Board cards are memoized, so their callback props must keep a stable
  // identity — otherwise every card re-renders on unrelated state changes
  // (opening the node graph, shelf updates, etc.), which is the bulk of the
  // cost on large productions. These delegates read the current render's
  // closures through a ref, so they are stable AND never stale.
  const boardHandlerRef = useRef<{
    regenerate: (id: string) => void;
    recheck: (id: string) => void;
    importFrame: (id: string) => void;
    edit: (id: string) => void;
    video: (id: string) => void;
    textChange: (id: string, patch: { audio: string; visual: string }) => void;
    promptFocus: (id: string, prompt: string) => void;
    dropFrame: (id: string, source: { prodId: string; shotId: string; number: number }) => void;
    dropFiles: (id: string, files: FileList | File[]) => void;
    promoteHistory: (id: string, framePath: string) => void;
    deleteGeneration: (id: string, rel: string) => void;
    saveAsReference: (id: string, rel: string) => void;
    reorderDragStart: (id: string, e: React.DragEvent) => void;
    reorderDrop: (id: string, e: React.DragEvent) => void;
    reorderDragOver: (id: string) => void;
    reorderDragEnd: () => void;
    insertAfter: (id: string) => void;
    remove: (id: string) => void;
  }>(null as never);
  boardHandlerRef.current = {
    regenerate: (id) => void regenBoard(id),
    recheck: (id) => void recheckBoard(id),
    importFrame: (id) => void importFrames(id),
    edit: (id) => setEditShotId(id),
    video: (id) => setVideoShotId(id),
    textChange: (id, patch) => void saveShotText(id, patch),
    promptFocus: (id, prompt) => focusPrompt(id, prompt),
    dropFrame: (id, source) => void dropFrameAsReference(id, source),
    dropFiles: (id, files) => void dropBoardFiles(id, files),
    promoteHistory: (id, framePath) => void promoteHistory(id, framePath),
    deleteGeneration: (id, rel) => deleteGeneration(id, rel),
    saveAsReference: (id, rel) => saveAsReference(id, rel),
    reorderDragStart: (id, e) => {
      boardDragRef.current = id;
      setBoardDragId(id);
      e.dataTransfer.setData("application/x-cascade-shot-order", id);
      e.dataTransfer.effectAllowed = "move";
    },
    reorderDrop: (targetId) => {
      const src = boardDragRef.current;
      setBoardDropTarget(null);
      setBoardDragId(null);
      boardDragRef.current = null;
      if (!src || src === targetId) return;
      reorderShot(src, targetId);
    },
    reorderDragOver: (id) => { if (boardDropTarget !== id) setBoardDropTarget(id); },
    reorderDragEnd: () => {
      setBoardDropTarget(null);
      setTimeout(() => {
        if (boardDragRef.current) { setBoardDragId(null); boardDragRef.current = null; }
      }, 0);
    },
    insertAfter: (id) => {
      const current = prodRef.current;
      if (!current) return;
      const flat = current.scenes.flatMap((sc) => sc.shots.map((shot) => ({ sc, shot })));
      const i = flat.findIndex(({ shot }) => shot.id === id);
      if (i >= 0) insertBlankShot(flat, i);
    },
    remove: (id) => deleteBoardShot(id),
  };
  const boardActions = useMemo(() => ({
    onRegenerate: (id: string) => boardHandlerRef.current.regenerate(id),
    onRecheck: (id: string) => boardHandlerRef.current.recheck(id),
    onImport: (id: string) => boardHandlerRef.current.importFrame(id),
    onEdit: (id: string) => boardHandlerRef.current.edit(id),
    onVideo: (id: string) => boardHandlerRef.current.video(id),
    onTextChange: (id: string, patch: { audio: string; visual: string }) => boardHandlerRef.current.textChange(id, patch),
    onPromptFocus: (id: string, prompt: string) => boardHandlerRef.current.promptFocus(id, prompt),
    onDropFrame: (id: string, source: { prodId: string; shotId: string; number: number }) => boardHandlerRef.current.dropFrame(id, source),
    onDropFiles: (id: string, files: FileList | File[]) => boardHandlerRef.current.dropFiles(id, files),
    onPromoteHistory: (id: string, framePath: string) => boardHandlerRef.current.promoteHistory(id, framePath),
    onDeleteGeneration: (id: string, rel: string) => boardHandlerRef.current.deleteGeneration(id, rel),
    onSaveAsReference: (id: string, rel: string) => boardHandlerRef.current.saveAsReference(id, rel),
    onReorderDragStart: (id: string, e: React.DragEvent) => boardHandlerRef.current.reorderDragStart(id, e),
    onReorderDrop: (id: string, e: React.DragEvent) => boardHandlerRef.current.reorderDrop(id, e),
    onReorderDragOver: (id: string) => boardHandlerRef.current.reorderDragOver(id),
    onReorderDragEnd: () => boardHandlerRef.current.reorderDragEnd(),
    onInsertAfter: (id: string) => boardHandlerRef.current.insertAfter(id),
    onDelete: (id: string) => boardHandlerRef.current.remove(id),
  }), []);

  const refreshList = useCallback(async () => {
    try { setList(await window.cascade.listProductions()); } catch {}
  }, []);

  useEffect(() => {
    void refreshList();
    const off = window.cascade.onProductionEvent((e) => {
      setLog((prev) => [...prev.slice(-200), { id: e.id, at: new Date().toLocaleTimeString(), message: e.message, level: e.level }]);
    });
    return off;
  }, [refreshList]);

  // External edit: when the high-quality original is edited in Photoshop etc.,
  // main re-encodes the JPEG preview on window focus and notifies here — bump
  // only that frame's cache-buster and reload the production so it shows.
  useEffect(() => {
    const off = window.cascade.onBoardExternalUpdate(async (e) => {
      if (prod?.meta.id && e.productionId !== prod.meta.id) return;
      try {
        const next = await window.cascade.loadProduction(e.productionId);
        if (next) {
          const hit = next.scenes.flatMap((sc) => sc.shots).find((s) => s.artwork === e.jpegRel);
          if (hit) bustOne(hit.id);
          else bustAll();
          prodRevRef.current = Math.max(prodRevRef.current, revOf(next));
          setProd(next);
        } else {
          bustAll();
        }
      } catch { bustAll(); }
      void refreshList();
    });
    const onWindowFocus = () => {
      void window.cascade.checkExternalEdits().catch(() => {});
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      off();
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [prod?.meta.id, refreshList, bustOne, bustAll]);

  // Keep the rename draft in sync when switching productions.
  useEffect(() => { setNameDraft(prod?.meta.name ?? ""); setSource(prod?.scriptSource ?? null); }, [prod?.meta.id]);

  // Warm the dropdowns' remembered last choices once (media-defaults.ts) and
  // the per-surface parameter defaults (model-param-defaults.ts).
  useEffect(() => {
    void primeMediaDefaults().then(() => setMediaDefaultsReady(true));
    void primeModelParamDefaults();
  }, []);

  // The Step-3 image dropdown starts at the user's last chosen model: a
  // production without a saved model of its own (fresh, or its saved model
  // no longer exists) inherits the remembered choice — so the dropdown and
  // the Generate Storyboard button always agree.
  const imageModelIdsKey = mediaModels.filter(isImageModel).map((m) => m.id).join(",");
  useEffect(() => {
    if (!mediaDefaultsReady || !prod || !imageModelIdsKey) return;
    const ids = imageModelIdsKey.split(",");
    if (prod.openArt?.model && ids.includes(prod.openArt.model)) return;
    // Keep an explicit cross-vendor pick (e.g. `higgsfield-cli:…` while the
    // active vendor is OpenArt): it routes to its own vendor at submit time,
    // so overwriting it here would silently lose the user's choice.
    if (prod.openArt?.model && (prod.openArt.model.startsWith("higgsfield-cli:") || prod.openArt.model.startsWith("higgsfield:"))) return;
    const model = rememberedModel("image", ids, prod.openArt?.model ?? "") || ids[0];
    if (model === prod.openArt?.model) return;
    saveField({ openArt: { model, resolution: (prod.openArt?.resolution ?? getMediaDefault("image")?.resolution ?? "1k") as "1k" | "2k" | "4k", ...(prod.openArt?.quality ? { quality: prod.openArt.quality } : {}), ...(prod.openArt?.params ? { params: prod.openArt.params } : {}) } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prod?.meta.id, imageModelIdsKey, mediaDefaultsReady]);

  // Step 2 (reference-image generation) + Step 3 (in-app board generation):
  // is the active media provider connected, and which models does it expose?
  // Settings can switch the active media provider at any moment (Settings →
  // Media generation dispatches "cascade:media-provider-changed" — same string
  // in SettingsPanel). Re-read it so the refetch below runs with the new
  // vendor's models. The event also carries hidden-model, kind-override, and
  // drag-reorder changes — refetch the model list directly, since a same-id
  // provider "change" wouldn't retrigger the effect below.
  useEffect(() => {
    const refetchModels = () => {
      void window.cascade.listOpenArtModels()
        .then((m) => setMediaModels(m))
        .catch(() => setMediaModels([]));
    };
    const onChange = () => {
      void window.cascade.getMediaProvider().then(setMediaProviderId);
      refetchModels();
    };
    window.addEventListener("cascade:media-provider-changed", onChange);
    return () => window.removeEventListener("cascade:media-provider-changed", onChange);
  }, []);

  useEffect(() => {
    if (prod?.currentStep !== 2 && prod?.currentStep !== 3) return;
    let live = true;
    const step = prod.currentStep;
    window.cascade.getMediaProvider()
      .then((id) => {
        if (!live) return;
        setMediaProviderId(id);
        return window.cascade.listMediaProviders().then((ps) => {
          if (!live) return;
          const active = ps.find((p) => p.id === id) ?? ps[0];
          if (active) {
            setMediaProviderName(active.displayName);
            if (step === 3) setMediaOk(active.available);
          }
        });
      })
      .catch(() => { if (live) setMediaOk(null); });
    window.cascade.listOpenArtModels()
      .then((m) => { if (live) setMediaModels(m); })
      .catch(() => { if (live) setMediaModels([]); });
    return () => { live = false; };
  }, [prod?.meta.id, prod?.currentStep, mediaProviderId]);

  // Step 4: fetch the imported music file as a streamable cascade-media:// URL
  // (served from disk by main — no base64 / data-URL size limits). Falls back
  // to the legacy data-URL IPC for older builds.
  useEffect(() => {
    if (prod?.currentStep !== 4) return;
    if (!prod?.musicPath) { setMusicUrl(null); return; }
    let live = true;
    const maybeUrl = (window.cascade as unknown as { musicUrl?: (id: string) => Promise<string | null> }).musicUrl;
    (async () => {
      if (maybeUrl) {
        try {
          const u = await maybeUrl(prod.meta.id);
          if (live) { setMusicUrl(u); return; }
        } catch {}
      }
      const d = await window.cascade.musicFile(prod.meta.id).catch(() => null);
      if (live) setMusicUrl(d);
    })();
    return () => { live = false; };
  }, [prod?.meta.id, prod?.currentStep, prod?.musicPath, audioBust]);

  // Step 4: fetch the voiceover clip as a streamable cascade-media:// URL.
  useEffect(() => {
    if (prod?.currentStep !== 4) return;
    if (!prod?.voiceoverPath) { setVoUrl(null); setVoDuration(null); return; }
    let live = true;
    const maybeUrl = (window.cascade as unknown as { voiceoverUrl?: (id: string) => Promise<string | null> }).voiceoverUrl;
    (async () => {
      if (maybeUrl) {
        try {
          const u = await maybeUrl(prod.meta.id);
          if (live) { setVoUrl(u); return; }
        } catch {}
      }
      const d = await window.cascade.voiceoverFile(prod.meta.id).catch(() => null);
      if (live) setVoUrl(d);
    })();
    return () => { live = false; };
  }, [prod?.meta.id, prod?.currentStep, prod?.voiceoverPath, audioBust]);

  // The URLs are streamable cascade-media:// (or blob:) URLs served from disk,
  // so <audio> and AudioContext can load them directly — no blob conversion
  // needed at this boundary.
  const voObjectUrl = voUrl;
  const musicObjectUrl = musicUrl;

  // Re-fetch the focused shot's effective prompt whenever the data it derives
  // from changes (manual override, style, references, characters/products,
  // brand, magic prompts). Without this, a reference drop that mutates prod
  // wouldn't refresh the side panel if the shot was already focused (the
  // focused-bust/promptShotId deps alone miss it).
  const focusedShot = promptShotId ? prod?.scenes.flatMap((s) => s.shots).find((s) => s.id === promptShotId) : undefined;
  const focusedSig = promptShotId ? JSON.stringify([
    promptShotId,
    prod?.magicEnabled,
    prod?.magicPrompts?.[promptShotId],
    focusedShot?.prompt,
    focusedShot?.style,
    focusedShot?.styleNone,
    focusedShot?.includeBrandIdentity,
    focusedShot?.refIds,
    focusedShot?.refExcluded,
    prod?.styles ?? [],
    prod?.brand ?? {},
    (prod?.characters ?? []).map((c) => [c.id, c.name, c.key, !!(c.artwork || c.imagePath)]),
    (prod?.products ?? []).map((p) => [p.id, p.name, !!(p.artwork || p.imagePath)]),
    (prod?.references ?? []).map((r) => [r.name, !!(r.artwork || r.imagePath || r.media)]),
  ]) : "";
  // Only the focused shot's bust (plus bulk epochs) should refetch its prompt —
  // an unrelated shot's frame change must not touch this editor.
  const focusedBust = promptShotId ? (boardBustMap[promptShotId] ?? 0) + boardBustAll * 1_000_000 : 0;
  useEffect(() => {
    if (!promptShotId) return;
    let live = true;
    const shotId = promptShotId;
    void promptSaveQueue.current.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const next = await window.cascade.getBoardPrompt(prod?.meta.id ?? "", shotId);
        if (next != null) {
          delete promptRetryRef.current[shotId];
          if (live) {
            // While the user is typing in this shot's editor, never clobber the
            // live value: a just-fired save changes focusedSig, re-runs this
            // effect, and a round-tripped (normalized) string would reset the
            // textarea's DOM value and yank the caret to the end.
            const el = document.activeElement;
            if (el instanceof HTMLTextAreaElement
              && (el.classList.contains("prod-board-prompt") || el.classList.contains("prod-prompt-drawer-text"))) return;
            promptCacheRef.current[shotId] = next; setFocusedPrompt(next);
          }
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
      // Fix D: don't give up permanently. A null after 3 tries can be a
      // transient race (structural snapshot still in flight) rather than a
      // ghost id — schedule one more refetch via the bust map when the shot
      // is still present. Capped so a genuinely-missing shot can't loop: the
      // dangling-focus cleanup above clears focus for ids absent from prod,
      // which unmounts this effect and ends the chain.
      if (!live) return;
      const failures = (promptRetryRef.current[shotId] ?? 0) + 1;
      promptRetryRef.current[shotId] = failures;
      if (failures > 3) { delete promptRetryRef.current[shotId]; return; }
      const stillThere = prodRef.current?.scenes.flatMap((s) => s.shots).some((s) => s.id === shotId);
      if (stillThere) {
        window.setTimeout(() => {
          if (prodRef.current?.scenes.flatMap((s) => s.shots).some((s) => s.id === shotId)) bustOne(shotId);
        }, 500);
      } else {
        delete promptRetryRef.current[shotId];
      }
    }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedBust, promptShotId, prod?.meta.id, focusedSig]);

  async function pickFolder() {
    const dir = await window.cascade.pickProductionFolder();
    if (dir) {
      setNewFolder(dir);
      if (!newName.trim()) setNewName(dir.split(/[\\/]/).filter(Boolean).pop() ?? "");
    }
  }

  async function create() {
    if (!newFolder) { setErr("Choose a production folder first."); return; }
    if (!newName.trim()) { setErr("Enter a production name first."); return; }
    setCreating(true); setErr(null);
    try {
      const p = await window.cascade.createProduction(newName, newFolder);
      prodRevRef.current = revOf(p);
      setProd(p);
      setNewName(""); setNewFolder(null);
      await refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setCreating(false);
    }
  }

  async function importExisting() {
    const dir = await window.cascade.pickProductionFolder();
    if (!dir) return;
    setImporting(true); setErr(null);
    try {
      const p = await window.cascade.importProduction(dir);
      prodRevRef.current = revOf(p);
      setProd(p);
      setNewName(""); setNewFolder(null);
      await refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setImporting(false);
    }
  }

  async function open(id: string) {
    setErr(null);
    try {
      const p = await window.cascade.loadProduction(id);
      if (p) { prodRevRef.current = revOf(p); setProd(p); setLog([]); await refreshList(); }
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  async function remove(id: string) {
    try { await window.cascade.removeProduction(id, "delete"); } catch { return; }
    if (prod?.meta.id === id) { prodRevRef.current = 0; setProd(null); }
    await refreshList();
  }

  function close() {
    prodRevRef.current = 0;
    setProd(null);
    void refreshList();
  }

  /** Guarded whole-snapshot apply: rejects stale IPC snapshots (Fix A) and
   *  drops dangling focus + dead prompt cache entries (Fix C). Returns true
   *  when the snapshot was applied. */
  const applySnapshot = useCallback((next: Production): boolean => {
    const rev = revOf(next);
    if (!isFresh(rev, prodRevRef.current)) return false;
    prodRevRef.current = rev;
    prodRef.current = next;
    setProd(next);
    const ids = new Set(next.scenes.flatMap((s) => s.shots).map((s) => s.id));
    for (const k of Object.keys(promptCacheRef.current)) {
      if (!ids.has(k)) delete promptCacheRef.current[k];
    }
    return true;
  }, []);

  // Dangling-focus cleanup (Fix C): whenever the production's shot set changes,
  // clear sidebar/graph focus that points at a shot id no longer present and
  // prune its cache entry — otherwise the sidebar keeps a dead editor whose
  // boardPrompt lookup returns null forever.
  useEffect(() => {
    if (!prod) return;
    const ids = new Set(prod.scenes.flatMap((s) => s.shots).map((s) => s.id));
    if (promptShotId && !ids.has(promptShotId)) {
      setPromptShotId(null);
      setFocusedPrompt("");
      delete promptCacheRef.current[promptShotId];
      delete latestPromptRef.current[promptShotId];
    }
    if (graphShotId && !ids.has(graphShotId)) setGraphShotId(null);
    for (const k of Object.keys(promptCacheRef.current)) {
      if (!ids.has(k)) delete promptCacheRef.current[k];
    }
  }, [prod, promptShotId, graphShotId]);

  /** Apply a mutation promise coming back from main with fresh state. */
  const apply = useCallback((p: Promise<Production>) => {
    setBusy(true); setErr(null);
    p.then((next) => { applySnapshot(next); void refreshList(); })
      .catch((e) => setErr(String(e).replace(/^Error:\s*/, "")))
      .finally(() => setBusy(false));
  }, [refreshList, applySnapshot]);

  function setStep(n: 1 | 2 | 3 | 4 | 5) {
    if (showExpenses) setShowExpenses(false);
    if (!prod || prod.currentStep === n) return;
    const next = { ...prod, currentStep: n };
    setProd(next);
    void window.cascade.saveProduction(next).then(() => refreshList()).catch(() => {});
  }

  function saveField(patch: Partial<Production>) {
    const current = prodRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    prodRef.current = next;
    setProd(next);
    void window.cascade.saveProduction(next).then(() => refreshList()).catch(() => {});
  }

  /** Mark the current step done and advance to the next one. */
  function goNext() {
    if (!prod) return;
    const n = prod.currentStep;
    const next: Production = { ...prod };
    if (n < 5) next.currentStep = (n + 1) as Production["currentStep"];
    setProd(next);
    void window.cascade.saveProduction(next).then(() => refreshList()).catch(() => {});
  }

  /** Attach/remove a reference image on a character or product. Images are
   *  saved into the production's referencesDir on disk (imagePath), not inline.
   *  Lists are read from prodRef (never the render-scope prod): tiles are
   *  memoized past membership changes, so a stale closure must not resurrect
   *  or clobber entries. */
  async function attachArtwork(kind: "characters" | "products", id: string) {
    const dataUrl = await window.cascade.pickReferenceImage();
    if (!dataUrl) return;
    const current = prodRef.current;
    if (!current) return;
    const item = current[kind].find((c) => c.id === id);
    const imagePath = await persistRefImage(dataUrl, item?.name ?? kind);
    const latest = prodRef.current;
    if (!latest) return;
    saveField({ [kind]: latest[kind].map((c) => (c.id === id ? { ...c, imagePath, artwork: undefined } : c)) } as Partial<Production>);
  }
  function removeArtwork(kind: "characters" | "products", id: string) {
    const current = prodRef.current;
    if (!current) return;
    const item = current[kind].find((c) => c.id === id);
    if (item?.imagePath) void window.cascade.removeReferenceFile(current.meta.id, item.imagePath).catch(() => {});
    saveField({ [kind]: current[kind].map((c) => (c.id === id ? { ...c, artwork: undefined, imagePath: undefined } : c)) } as Partial<Production>);
  }

  /** Add a brand-new custom reference (materials, textures, hero props). A
   *  dragged-in name that already exists gets a two-digit suffix so the drop
   *  never silently merges into (or collides with) the existing reference. */
  async function addRef(name: string, categoryId?: string, artwork?: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const imagePath = artwork ? await persistRefImage(artwork, trimmed) : undefined;
    const current = prodRef.current;
    if (!current) return;
    const finalName = uniqueRefName((current.references ?? []).map((r) => r.name), trimmed);
    saveField({ references: [...(current.references ?? []), { id: uid("ref"), name: finalName, categoryId, imagePath, shotIds: [] }] });
  }
  /** Delete a custom reference entirely — entry, files, and every node +
   *  connection it had — via one atomic main-side op. The returned snapshot
   *  is authoritative: never filter locally, so a memoized tile holding a
   *  stale callback can't resurrect a deleted entry (zombie broken tile). */
  async function removeRef(id: string) {
    const current = prodRef.current;
    if (!current || removingRefIds.has(id)) return;
    setRemovingRefIds((prev) => new Set(prev).add(id));
    setErr(null);
    try {
      const next = await window.cascade.deleteReference(current.meta.id, id);
      applySnapshot(next);
      bustAll();
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setRemovingRefIds((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    }
  }
  /** Rename a custom reference in place. Main rewrites the reference's
   *  `@[name]` tags across every prompt store in the same atomic op, so its
   *  node graph follows the new name instead of disconnecting. */
  async function updateRef(id: string, name: string) {
    const current = prodRef.current;
    if (!current) return;
    const ref = (current.references ?? []).find((r) => r.id === id);
    if (!ref || ref.name === name) return;
    setErr(null);
    try {
      const next = await window.cascade.renameReference(current.meta.id, id, name);
      applySnapshot(next);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }
  async function attachRefArtwork(id: string) {
    const dataUrl = await window.cascade.pickReferenceImage();
    if (!dataUrl) return;
    const current = prodRef.current;
    if (!current) return;
    const ref = (current.references ?? []).find((r) => r.id === id);
    const imagePath = await persistRefImage(dataUrl, ref?.name ?? "reference");
    const latest = prodRef.current;
    if (!latest) return;
    saveField({ references: (latest.references ?? []).map((r) => (r.id === id ? { ...r, imagePath, artwork: undefined } : r)) });
  }
  function removeRefArtwork(id: string) {
    const current = prodRef.current;
    if (!current) return;
    const ref = (current.references ?? []).find((r) => r.id === id);
    if (ref?.imagePath) void window.cascade.removeReferenceFile(current.meta.id, ref.imagePath).catch(() => {});
    saveField({ references: (current.references ?? []).map((r) => (r.id === id ? { ...r, artwork: undefined, imagePath: undefined } : r)) });
  }

  /** Step 2: rescan the production's references folder — images added externally
   *  (dropped straight into references/) are adopted as references. */
  async function rescanRefFolder() {
    if (!prod) return;
    setErr(null);
    try {
      const next = await window.cascade.scanReferencesFolder(prod.meta.id);
      applySnapshot(next);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }
  /** Step 2: generate or AI-edit a reference image via the media provider. The modal
   *  stays open (and shows errors) until the call succeeds. */
  async function runRefGen(opts: ReferenceImageGenOptions) {
    if (!prod) return;
    setErr(null);
    const next = await window.cascade.generateReferenceImage(prod.meta.id, opts);
    applySnapshot(next);
    void refreshList();
  }
  /** Step 2: generate a character-sheet reference via the media provider (the character
   *  is created/updated with the finished sheet). */
  async function runCharacterGen(opts: CharacterSheetGenOptions) {
    if (!prod) return;
    setErr(null);
    const next = await window.cascade.generateCharacterSheet(prod.meta.id, opts);
    applySnapshot(next);
    void refreshList();
  }
  /** Add a person/product the script-detection missed. */
  function addPerson(name: string, key: string) {
    if (!prod || !name.trim()) return;
    saveField({ characters: [...prod.characters, { id: uid("char"), name: name.trim(), key: key.trim() }] });
  }
  function addProduct(name: string) {
    if (!prod || !name.trim()) return;
    saveField({ products: [...prod.products, { id: uid("prod"), name: name.trim() }] });
  }

  function addCategory(name: string) {
    if (!prod || !name.trim()) return;
    saveField({ referenceCategories: [...(prod.referenceCategories ?? []), { id: uid("cat"), name: name.trim() }] });
  }

  function renameCategory(id: string, name: string) {
    if (!prod || !name.trim()) return;
    saveField({ referenceCategories: (prod.referenceCategories ?? []).map((c) => c.id === id ? { ...c, name: name.trim() } : c) });
  }

  function moveReference(id: string, categoryId?: string) {
    if (!prod) return;
    saveField({ references: (prod.references ?? []).map((r) => r.id === id ? { ...r, categoryId } : r) });
  }

  /** Drag one reference tile onto another to reorder it. The saved array order
   *  is what both the Design grid and the node editor's shelf render from; the
   *  dragged ref also adopts the target's category, so dropping across
   *  categories both moves and positions it. */
  function reorderReference(draggedId: string, targetId: string, after: boolean) {
    const current = prodRef.current;
    if (!current) return;
    const refs = current.references ?? [];
    const reordered = reorderRefs(refs, draggedId, targetId, after);
    if (reordered === refs) return;
    const target = refs.find((r) => r.id === targetId);
    const next = reordered.map((r) => (r.id === draggedId ? { ...r, categoryId: target?.categoryId } : r));
    saveField({ references: next });
  }

  function approveSuggestion(suggestion: SuggestedReference) {
    if (!prod) return;
    saveField({
      references: [...(prod.references ?? []), { id: uid("ref"), name: suggestion.name, shotIds: [] }],
      suggestedReferences: (prod.suggestedReferences ?? []).filter((s) => s.id !== suggestion.id),
    });
  }

  function dismissSuggestion(suggestion: SuggestedReference) {
    if (!prod) return;
    saveField({
      suggestedReferences: (prod.suggestedReferences ?? []).filter((s) => s.id !== suggestion.id),
    });
  }

  /** Step 2: magic-wand refine one style's prompt in place (one LLM call). */
  async function refineStyle(id: string) {
    if (!prod || refiningStyleId) return;
    const s = (prod.styles ?? []).find((st) => st.id === id);
    if (!s || !s.prompt.trim()) return;
    setRefiningStyleId(id); setErr(null);
    try {
      const refined = await window.cascade.refineStylePrompt(prod.meta.id, s.prompt);
      saveField({ styles: (prod.styles ?? []).map((st) => (st.id === id ? { ...st, prompt: refined } : st)) });
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setRefiningStyleId(null);
    }
  }

  /** Step 2: edit one style's field (persisted immediately). */
  function setStyle(idx: number, patch: Partial<{ name: string; prompt: string; index: number; imagePath?: string; frameSource?: "upload" | "generated" | "reference" | "anchor"; model?: string; resolution?: "1k" | "2k" | "4k"; params?: Record<string, string | number | boolean | string[]> }>) {
    if (!prod) return;
    saveField({
      styles: (prod.styles ?? []).map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    });
  }

  /** Step 2: append an empty style slot (up to 5). */
  function addStyle() {
    if (!prod || (prod.styles?.length ?? 0) >= MAX_STYLES) return;
    saveField({
      styles: [...(prod.styles ?? []), { id: uid("style"), index: (prod.styles?.length ?? 0) + 1, name: "", prompt: "" }],
    });
  }

  /**
   * Step 2: distill a style (name + prompt) from an image the user imported or
   * pasted. Refuses up front — with a popup — when the active chat model can't
   * see images.
   */
  async function styleFromImageDataUrl(dataUrl: string) {
    if (!prod || styleImgBusy) return;
    if ((prod.styles?.length ?? 0) >= MAX_STYLES) {
      setErr(`Style list is full — remove a style before adding one from an image.`);
      return;
    }
    setErr(null);
    // Vision check against the live model list; if it can't be verified we let
    // the request run and surface whatever the API reports.
    try {
      const [s, res] = await Promise.all([window.cascade.getSettings(), window.cascade.listModels()]);
      const models = res.ok ? res.models : [];
      const info = models.find((m) => m.id === s.model);
      if (info && !info.vision) {
        setVisionWarnModel(info.id);
        return;
      }
    } catch { /* fall through — the generation call reports its own errors */ }
    setStyleImgBusy(true);
    try {
      const style = await window.cascade.styleFromImage(prod.meta.id, dataUrl);
      saveField({
        styles: [...(prod.styles ?? []), { id: uid("style"), index: (prod.styles?.length ?? 0) + 1, name: style.name, prompt: style.prompt, ...(style.imagePath ? { imagePath: style.imagePath, frameSource: "reference" as const } : {}) }],
      });
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setStyleImgBusy(false);
    }
  }

  /** Step 2: generate a style frame (look plate) for one style via IPC,
   *  forwarding its per-style model/resolution/params overrides ("auto"/
   *  absent = inherit the production default). */
  function generateStyleFrame(styleId: string) {
    if (!prod || styleFrameBusy) return;
    const style = (prod.styles ?? []).find((s) => s.id === styleId);
    // A stored pick missing from the active vendor's list falls back to the
    // production default instead of billing (or failing on) a stale slug.
    const liveModel = style?.model && style.model !== "auto" && imageMasterModels.some((m) => m.id === style.model)
      ? style.model
      : undefined;
    const model = styleFrameOverride(liveModel);
    const resolution = styleFrameOverride(style?.resolution);
    const params = style?.params && Object.keys(style.params).length ? { ...style.params } : undefined;
    setStyleFrameBusy(styleId);
    setErr(null);
    apply(window.cascade.generateStyleFrame(prod.meta.id, styleId, model, resolution, params).finally(() => setStyleFrameBusy(null)));
  }

  /** Step 2: attach a picked file as one style's frame. */
  async function uploadStyleFrame(styleId: string) {
    if (!prod || styleFrameBusy) return;
    const dataUrl = await window.cascade.pickReferenceImage();
    if (!dataUrl) return;
    setStyleFrameBusy(styleId);
    setErr(null);
    apply(window.cascade.setStyleFrame(prod.meta.id, styleId, dataUrl).finally(() => setStyleFrameBusy(null)));
  }

  /** Step 2: drop files onto a style card to set its frame. */
  async function dropStyleFrame(styleId: string, files: FileList | File[]) {
    if (!prod || styleFrameBusy) return;
    const file = Array.from(files).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { setErr("That image is larger than 15 MB — use a smaller one."); return; }
    setStyleFrameBusy(styleId);
    setErr(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      if (!prodRef.current) { setStyleFrameBusy(null); return; }
      apply(window.cascade.setStyleFrame(prodRef.current.meta.id, styleId, dataUrl).finally(() => setStyleFrameBusy(null)));
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
      setStyleFrameBusy(null);
    }
  }

  /** Step 2: pick an image file and generate a style from it. */
  async function pickStyleImage() {
    if (!prod || styleImgBusy) return;
    const dataUrl = await window.cascade.pickReferenceImage();
    if (!dataUrl) return;
    await styleFromImageDataUrl(dataUrl);
  }

  /** Next auto-generated reference name (Ref-001, Ref-002, …). */
  function nextRefName(): string {
    let max = 0;
    for (const r of prodRef.current?.references ?? []) {
      const m = /^Ref-(\d+)$/.exec(r.name);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `Ref-${String(max + 1).padStart(3, "0")}`;
  }

  /** Shared: read a File as a data URL. */
  function fileToDataUrl(file: File): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  /** Resolve a reference's image to a data URL (legacy inline or on-disk file). */
  async function referenceToDataUrl(refId: string): Promise<string | null> {
    if (!prod) return null;
    const all: Array<{ id: string; artwork?: string; imagePath?: string }> = [
      ...prod.characters,
      ...prod.products,
      ...(prod.references ?? []),
    ];
    const ref = all.find((r) => r.id === refId);
    if (!ref) return null;
    if (ref.artwork) return ref.artwork;
    if (ref.imagePath) {
      try {
        const url = cascadeMedia(prod.meta.id, ref.imagePath);
        const res = await fetch(url);
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result as string);
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Step 2: drag a reference image onto the "From image" button to generate a style from it. */
  async function styleFromReferenceId(refId: string) {
    const dataUrl = await referenceToDataUrl(refId);
    if (!dataUrl) { setErr("Couldn't load that reference image."); return; }
    await styleFromImageDataUrl(dataUrl);
  }

  /** Create a pasted image as a new reference with an auto-generated name (Ref-001…).
   *  Returns the created reference (for the node graph to place it on the canvas). */
  async function createReferenceFromFile(file: File, forcedName?: string): Promise<{ id: string; name: string; artwork: string } | null> {
    if (!prodRef.current) return null;
    if (file.size > 15 * 1024 * 1024) {
      setErr("That image is larger than 15 MB — use a smaller one.");
      return null;
    }
    if (!file.type.startsWith("image/")) {
      setErr(`${file.name}: not an image file.`);
      return null;
    }
    const name = forcedName ?? nextRefName();
    let dataUrl: string;
    try {
      dataUrl = await fileToDataUrl(file);
    } catch {
      setErr("Couldn't read the pasted image.");
      return null;
    }
    const imagePath = await persistRefImage(dataUrl, name);
    if (!imagePath) { setErr("Couldn't save the pasted image."); return null; }
    const prodId = prodRef.current.meta.id;
    const id = uid("ref");
    saveField({ references: [...(prodRef.current?.references ?? []), { id, name, imagePath, shotIds: [] }] });
    return { id, name, artwork: cascadeMedia(prodId, imagePath) };
  }

  function batchRefNames(count: number): string[] {
    let max = 0;
    for (const r of prodRef.current?.references ?? []) {
      const m = /^Ref-(\d+)$/.exec(r.name);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return Array.from({ length: count }, (_, i) => `Ref-${String(max + 1 + i).padStart(3, "0")}`);
  }

  // Step 2: while the Design panel is open, Ctrl+V with an image creates a reference (Ref-001…).
  // Text pastes are untouched. When the node graph is open, it owns paste (see NodeGraphModal).
  useEffect(() => {
    if (prod?.currentStep !== 2) return;
    const onPaste = (e: ClipboardEvent) => {
      // If the node graph modal is open, let it handle paste (creates a ref via its own handler).
      if (document.querySelector(".prod-graph-overlay")) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      const names = batchRefNames(files.length);
      files.forEach((f, i) => void createReferenceFromFile(f, names[i]));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [prod?.currentStep, prod?.references, prod?.meta.id]);

  // Node-graph paste is owned by NodeGraphModal (it creates the reference via
  // onDropFile and places the node on the canvas at the paste point).

  // In-betweener: which video models accept a dedicated end frame (live
  // capability data, warmed when the media models were listed, so this is
  // usually instant), unioned with the user's manual allowlist in main.
  // Null = not loaded yet → the tween lists show every video model until it
  // resolves; once resolved the lists are strictly limited to these ids.
  // Refetched on provider change so the tween list always tracks the global
  // provider's models (the probe is per-vendor, like the model list itself).
  const [endFrameModelIds, setEndFrameModelIds] = useState<string[] | null>(null);
  useEffect(() => {
    if (!graphShotId) return;
    let live = true;
    const load = () => {
      setEndFrameModelIds(null);
      window.cascade.videoEndFrameModels()
        .then((ids) => { if (live) setEndFrameModelIds(ids); })
        .catch(() => { if (live) setEndFrameModelIds([]); });
    };
    load();
    // The dev customizer declares end-frame capability by assigning the
    // `video:tween` surface; refresh so the tween list follows without a reopen.
    window.addEventListener("cascade:media-provider-changed", load);
    return () => { live = false; window.removeEventListener("cascade:media-provider-changed", load); };
  }, [graphShotId, prod?.meta.id, mediaProviderId]);

  /** Step 2: remove a style and renumber the rest. */
  function removeStyle(idx: number) {
    if (!prod) return;
    saveField({
      styles: (prod.styles ?? []).filter((_, i) => i !== idx).map((s, i) => ({ ...s, index: i + 1 })),
    });
  }

  /** Step 2: global brand palette/font (applied to every style's prompts). */
  function setBrandColor(idx: number, value: string) {
    if (!prod) return;
    const colors = [...(prod.brand?.colors ?? [])].slice(0, 5);
    // Grow only as far as the touched slot — never pad the whole palette.
    while (colors.length <= Math.min(idx, 4)) colors.push("");
    colors[Math.min(idx, 4)] = value;
    saveField({ brand: { colors, font: prod.brand?.font ?? "" } });
  }
  function removeBrandColor(idx: number) {
    if (!prod) return;
    const colors = (prod.brand?.colors ?? []).filter((_, i) => i !== idx);
    saveField({ brand: { colors, font: prod.brand?.font ?? "" } });
  }
  function setBrandFont(font: string) {
    if (!prod) return;
    saveField({ brand: { colors: (prod.brand?.colors ?? []).slice(0, 5), font } });
  }

  async function ingest(src: string) {
    if (!prod || !src.trim()) return;
    setBusy(true); setErr(null);
    try {
      const next = await window.cascade.ingestScript(prod.meta.id, src.trim());
      setProd(next);
      setSource(next.scriptSource ?? null);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }

  /** Step 1: skip ingestion entirely — seed one scene with five blank shots. */
  async function startBlank() {
    if (!prod) return;
    setBusy(true); setErr(null);
    try {
      const next = await window.cascade.startBlank(prod.meta.id);
      setProd(next);
      setSource(next.scriptSource ?? null);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }

  /** Step 3: generate frames for shots missing artwork. Uncapped up to the
   *  pipeline's own 200-frame ceiling (the per-run cap field was removed). */
  async function genBoards() {
    if (!prod || boardsBusy) return;
    setBoardsBusy(true); setErr(null);
    try {
      const next = await window.cascade.generateBoards(prod.meta.id, { maxShots: 200 });
      setProd(next);
      bustAll();
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBoardsBusy(false);
    }
  }

  /** Step 3: regenerate shot frames. Clicks are batched into serialised
   * `regenerateBoards` runs — several frames generate in parallel inside one
   * shared production (so their artwork never clobbers each other on save),
   * while batches themselves never overlap. Each shot tracks its own in-flight
   * state in `regenIds`. */
  async function runRegenBatch(batch: string[]) {
    if (!prod) return;
    regenRunningRef.current = true;
    setRegenIds((prev) => new Set([...prev, ...batch]));
    try {
      const next = await window.cascade.regenerateBoards(prod.meta.id, batch);
      setProd(next);
      bustMany(batch);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setRegenIds((prev) => {
        const n = new Set(prev);
        batch.forEach((id) => n.delete(id));
        return n;
      });
      regenRunningRef.current = false;
      // Dispatch anything queued while this batch was running.
      if (regenPendingRef.current.length) {
        const next = regenPendingRef.current.splice(0);
        void runRegenBatch(next);
      }
    }
  }

  async function regenBoard(shotId: string) {
    if (!prod) return;
    await promptSaveQueue.current;
    // Already queued/running — ignore the duplicate click.
    if (regenPendingRef.current.includes(shotId) || regenIds.has(shotId)) return;
    if (regenRunningRef.current) {
      // A batch is in flight; queue this shot for the next one.
      regenPendingRef.current.push(shotId);
      setRegenIds((prev) => new Set(prev).add(shotId)); // show its spinner while queued
    } else {
      void runRegenBatch([shotId]);
    }
  }

  /** Step 3: reclaim a shot's frame from a vendor job that outlived the
   *  generating call (the wait timed out or the download failed). The job keeps
   *  rendering server-side, so rechecking polls it again and downloads the
   *  finished frame when ready. */
  async function recheckBoard(shotId: string) {
    if (!prod || recheckIds.has(shotId)) return;
    setErr(null);
    setRecheckIds((prev) => new Set(prev).add(shotId));
    try {
      const next = await window.cascade.recheckBoard(prod.meta.id, shotId);
      setProd(next);
      bustOne(shotId);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setRecheckIds((prev) => {
        const n = new Set(prev);
        n.delete(shotId);
        return n;
      });
    }
  }

  /** Step 3: export every shot's prompt to boards/prompts.md. */
  async function exportPrompts() {
    if (!prod) return;
    setErr(null);
    try {
      await window.cascade.exportBoardPrompts(prod.meta.id);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  /**
   * Step 3 manual workflow: pick externally generated frames and match them
   * to shots by the 4-digit number in the filename (or one file → one shot
   * when `shotId` is given). No files picked + no shotId = scan the
   * boards/import/ folder instead.
   */
  async function importFrames(shotId?: string) {
    if (!prod || importBusy) return;
    setImportBusy(true); setErr(null);
    try {
      const files = await window.cascade.pickBoardImages();
      if (!files.length) return;
      const next = await window.cascade.importBoards(prod.meta.id, files, shotId);
      setProd(next);
      if (shotId) bustOne(shotId);
      else bustAll();
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setImportBusy(false);
    }
  }

  /** Step 3: import one OS file dropped onto a panel as that shot's frame
   *  (image) or clip (video). Browser File drops carry no disk path: images
   *  are read as a data URL and sent via `importBoardImage` (the picker's
   *  disk-path `importBoards` can't consume them); videos ride raw bytes via
   *  `importBoardVideo`, which saves the clip as a reference video piped to
   *  the frame output. */
  async function dropBoardFiles(shotId: string, files: FileList | File[]) {
    if (!prod || importBusy) return;
    const list = Array.from(files);
    if (!list.length) return;
    const media = list.find((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (!media) { setErr("Only image or video files can be dropped onto panels."); return; }
    if (media.type.startsWith("video/")) {
      setImportBusy(true); setErr(null);
      try {
        const bytes = await media.arrayBuffer();
        const next = await window.cascade.importBoardVideo(prod.meta.id, shotId, media.name, media.type, bytes);
        setProd(next);
        bustOne(shotId);
        void refreshList();
      } catch (e) {
        setErr(String(e).replace(/^Error:\s*/, ""));
      } finally {
        setImportBusy(false);
      }
      return;
    }
    const file = media;
    if (file.size > 15 * 1024 * 1024) { setErr("That image is larger than 15 MB — use a smaller one."); return; }
    setImportBusy(true); setErr(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      const next = await window.cascade.importBoardImage(prod.meta.id, shotId, file.name, dataUrl);
      setProd(next);
      bustOne(shotId);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setImportBusy(false);
    }
  }

  /** Step 3: scan boards/import/ for shot-numbered images dropped there. */
  async function scanImportFolder() {
    if (!prod || importBusy) return;
    setImportBusy(true); setErr(null);
    try {
      const next = await window.cascade.importBoards(prod.meta.id);
      setProd(next);
      bustAll();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setImportBusy(false);
    }
  }

  /** Step 3: re-link broken storyboard image paths — after board files were
   *  moved/renamed externally (or a production folder was re-registered), a
   *  shot's artwork/history/node-graph generation paths can point at files that
   *  no longer exist. Repoints every broken path to the newest frame present in
   *  that shot's board folder. */
  async function refreshBoardLinks() {
    if (!prod) return;
    setErr(null);
    try {
      const next = await window.cascade.refreshBoardLinks(prod.meta.id);
      setProd(next);
      bustAll();
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  /** Step 4: pick a local audio file to use as the voiceover. */
  async function importVo() {
    if (!prod) return;
    setErr(null);
    try {
      const next = await window.cascade.importVoiceover(prod.meta.id);
      if (next) { setProd(next); setVoUrl(null); setVoDuration(null); setAudioBust((n) => n + 1); }
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  /** Step 4: clear the voiceover (file + shot.voiceoverPath). */
  async function removeVo() {
    if (!prod) return;
    setErr(null);
    try {
      const next = await window.cascade.removeVoiceover(prod.meta.id);
      setProd(next);
      setVoUrl(null); setVoDuration(null); setAudioBust((n) => n + 1);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  /** Step 4: open the native picker to import a music track. */
  async function importMusic() {
    if (!prod) return;
    setErr(null);
    try {
      const next = await window.cascade.importMusic(prod.meta.id);
      if (next) { setProd(next); setMusicUrl(null); setAudioBust((n) => n + 1); }
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  /** Step 4: clear the imported music track. */
  async function removeMusic() {
    if (!prod) return;
    setErr(null);
    try {
      const next = await window.cascade.removeMusic(prod.meta.id);
      setProd(next);
      setMusicUrl(null); setAudioBust((n) => n + 1);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  function setMusicVolume(v: number) {
    if (!prod) return;
    saveField({ musicVolume: Math.max(0, Math.min(1, v)) });
  }

  function setVoiceoverVolume(v: number) {
    if (!prod) return;
    saveField({ voiceoverVolume: Math.max(0, Math.min(1, v)) });
  }

  /** Step 4: rescale every shot's durationSec so the total matches `targetSec`.
   *  Used after a VO is added/imported, and by the "Fit to VO" button. */
  function fitShotsToTotal(targetSec: number) {
    if (!prod) return;
    const shots = prod.scenes.flatMap((s) => s.shots);
    if (!shots.length) return;
    const currentTotal = shots.reduce((n, s) => n + (s.durationSec ?? 3), 0);
    if (currentTotal <= 0) {
      // All zeros — distribute evenly.
      const each = Math.max(0.5, targetSec / shots.length);
      saveField({ scenes: prod.scenes.map((sc) => ({ ...sc, shots: sc.shots.map((s) => ({ ...s, durationSec: each })) })) });
      return;
    }
    if (!Number.isFinite(targetSec) || targetSec <= 0) return;
    const scale = targetSec / currentTotal;
    saveField({
      scenes: prod.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((s) => ({ ...s, durationSec: Math.max(0.5, (s.durationSec ?? 3) * scale) })),
      })),
    });
  }

  /** Step 3: pick one shot's render style (stores the style's stable id and
   *  syncs the stored graph's style edge). The prompt itself stays content-only
   *  — the Style section renders from the plugged library entry on read, so
   *  editing the style in Design reaches every consumer with no stored copy. */
  async function updateShotStyle(shotId: string, styleId: string) {
    if (!prod) return;
    const target = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!target) return;
    const patch: Partial<ProductionShot> = { style: styleId || undefined, styleNone: !styleId };
    if (target.graph) patch.graph = setStyleEdge(target.graph, "composer", !!styleId);
    else patch.graphStyleConnected = !!styleId; // pre-graph fallback
    const next: Production = { ...prod, scenes: prod.scenes.map((sc) => ({
      ...sc,
      shots: sc.shots.map((s) => s.id === shotId ? { ...s, ...patch } : s),
    })) };
    setProd(next);
    // Re-derive the focused prompt from the new selection (content-only cache).
    if (promptShotId === shotId) {
      const rerendered = renderShotPrompt(next, next.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId)!, "composer");
      promptCacheRef.current[shotId] = rerendered;
      setFocusedPrompt(rerendered);
    }
    void window.cascade.saveProduction(next).then(async () => {
      await refreshList();
      if (promptShotId === shotId) {
        const updated = await window.cascade.getBoardPrompt(next.meta.id, shotId);
        if (updated != null) setFocusedPrompt(updated);
      }
    }).catch(() => {});
  }

  /** Node-graph style picker: same as the classic dropdown — selection + the
   *  stored graph's style edge, never a pasted paragraph. */
  function setGraphStyle(shotId: string, styleId: string) {
    if (!prod) return;
    const target = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!target) return;
    const patch: Partial<ProductionShot> = { style: styleId || undefined, styleNone: !styleId };
    if (target.graph) patch.graph = setStyleEdge(target.graph, "composer", !!styleId);
    else patch.graphStyleConnected = !!styleId;
    saveField({
      scenes: prod.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((s) => s.id === shotId ? { ...s, ...patch } : s),
      })),
    });
    // Refresh the shared live prompt (the modal reads it as its composer value).
    const nextShot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (nextShot) {
      const rerendered = renderShotPrompt(prod, { ...nextShot, ...patch }, "composer");
      promptCacheRef.current[shotId] = rerendered;
      if (promptShotId === shotId || graphShotId === shotId) setFocusedPrompt(rerendered);
    }
  }


  /** Create/reuse a reference, optionally recording its shot association.
 *  Returns the new references array (undefined when the production is gone). */
  function upsertReference(name: string, ref: { artwork?: string; imagePath?: string; media?: "video" | "audio"; mediaPath?: string }, shotId?: string): Production["references"] | undefined {
    const current = prodRef.current;
    if (!current) return undefined;
    const existing = (current.references ?? []).find((r) => r.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) {
      return (current.references ?? []).map((r) => r.id === existing.id ? {
        ...r,
        artwork: r.artwork ?? ref.artwork,
        imagePath: r.imagePath ?? ref.imagePath,
        media: r.media ?? ref.media,
        mediaPath: r.mediaPath ?? ref.mediaPath,
        ...(shotId ? { shotIds: Array.from(new Set([...(r.shotIds ?? []), shotId])) } : {}),
      } : r);
    }
    return [...(current.references ?? []), { id: uid("ref"), name, artwork: ref.artwork, imagePath: ref.imagePath, media: ref.media, mediaPath: ref.mediaPath, ...(shotId ? { shotIds: [shotId] } : {}) }];
  }

  /** Step 3: attach a reference (image file, or an on-disk video/audio file)
   *  to a shot and tag it at the end of that shot's prompt, reusing an
   *  existing reference of the same name. Used by frame drops. */
  async function attachReferenceToPrompt(shotId: string, name: string, ref: { artwork?: string; imagePath?: string; media?: "video" | "audio"; mediaPath?: string }) {
    if (!prod) return;
    setErr(null);
    try {
      const target = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
      if (!target) { setErr("Couldn't find the destination frame."); return; }
      const currentPrompt = target.prompt?.trim() || await window.cascade.getBoardPrompt(prod.meta.id, shotId) || "";
      const prompt = addRefTag(currentPrompt, name);
      // Keep the prompt cache in sync so a later selection of this shot (via
      // focusPrompt, which reads the cache) shows the tagged prompt — the
      // board-refresh effect (focusedBust) may not have fired yet.
      promptCacheRef.current[shotId] = prompt;
      if (promptShotId === shotId) setFocusedPrompt(prompt);
      const references = upsertReference(name, ref, shotId);
      if (prod.magicEnabled) {
        // Magic prompts keep content-only text in magicPrompts[shotId] — the
        // effective prompt, reference resolution, and the node graph all read
        // magicPrompts first, so a tag written to shot.prompt would be lost.
        // Tag the content box itself and persist the magic store.
        const content = (prod.magicPrompts?.[shotId] ?? parsePromptBoxes(currentPrompt).content ?? "").trim();
        const next = addRefTag(content, name);
        saveField({ references, magicPrompts: { ...(prod.magicPrompts ?? {}), [shotId]: next } });
        return;
      }
      saveField({
        references,
        scenes: prod.scenes.map((sc) => ({ ...sc, shots: sc.shots.map((s) => s.id === shotId ? { ...s, prompt, promptManual: true } : s) })),
      });
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  /** Create/reuse a dropped reference WITHOUT tagging the prompt — node-graph
   *  drops just add the reference node, and connecting it to the prompt is an
   *  explicit socket action. Returns the reference id for canvas placement. */
  function saveRefOnly(name: string, ref: { artwork?: string; imagePath?: string; media?: "video" | "audio"; mediaPath?: string }): string | undefined {
    const current = prodRef.current;
    if (!current) return undefined;
    const existing = (current.references ?? []).find((r) => r.name.trim().toLowerCase() === name.toLowerCase());
    const references = upsertReference(name, ref);
    if (references) saveField({ references });
    if (existing) return existing.id;
    return references?.find((r) => r.name.trim().toLowerCase() === name.toLowerCase())?.id;
  }

  /** Save a dropped/picked reference image (inline data URL) into the
   *  production's referencesDir on disk and return its workspace-relative
   *  path — image references live as files, not JSON data URLs. */
  async function persistRefImage(dataUrl: string, baseName: string): Promise<string | undefined> {
    const current = prodRef.current;
    if (!current) return undefined;
    try {
      const res = await window.cascade.addReferenceImage(current.meta.id, `${baseName}.png`, dataUrl);
      return res?.path;
    } catch {
      return undefined;
    }
  }

  /** Step 3: a completed frame dragged onto another frame becomes a reference
   *  and is tagged at the end of the destination prompt. The reference is the
   *  frame's original file (full resolution), not the board thumbnail. */
  async function dropFrameAsReference(shotId: string, source: { prodId: string; shotId: string; number: number }) {
    if (!prod) return;
    try {
      const name = `Frame ${String(source.number).padStart(4, "0")}`;
      const saved = await window.cascade.addBoardFrameReference(prod.meta.id, source.prodId, source.shotId, name);
      if (!saved?.path) { setErr("Couldn't load the dropped frame."); return; }
      await attachReferenceToPrompt(shotId, name, { imagePath: saved.path });
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  /** Step 3: any image/video/audio dropped into the node graph automatically
   *  becomes a reference: all files are written into the production's
   *  referencesDir on disk. The reference is NOT tagged into the prompt —
   *  connecting it to the prompt node is an explicit socket action.
   *  Returns the created reference so the graph can place its node. */
  async function addFileReference(shotId: string, file: File, forcedName?: string): Promise<GraphRef | null> {
    if (!prod) return null;
    const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : null;
    if (!kind) { setErr(`${file.name}: not an image, video, or audio file.`); return null; }
    const baseName = forcedName ?? (file.name.trim().replace(/\.[^.]+$/, "").replace(/\s+/g, " ").slice(0, 60) || "Dropped reference");
    // A dropped name that already exists becomes "Name 01", "Name 02", … so a
    // fresh drop is always a distinct reference (saveRefOnly would otherwise
    // merge it into the same-named one).
    const name = uniqueRefName((prodRef.current?.references ?? []).map((r) => r.name), baseName);
    try {
      if (kind === "image") {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => { if (typeof reader.result === "string") resolve(reader.result); else reject(reader.error ?? new Error("Couldn't read the file.")); };
          reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."));
          reader.readAsDataURL(file);
        });
        const imagePath = await persistRefImage(dataUrl, name);
        if (!imagePath) { setErr("Couldn't save the dropped image."); return null; }
        const id = saveRefOnly(name, { imagePath });
        if (!id) return null;
        return { id, name, artwork: cascadeMedia(prod.meta.id, imagePath) };
      } else {
        const saved = await window.cascade.addReferenceMedia(prod.meta.id, file.name, file.type, await file.arrayBuffer());
        if (!saved) { setErr("Couldn't save the dropped media file."); return null; }
        const id = saveRefOnly(name, { media: saved.kind, mediaPath: saved.path });
        if (!id) return null;
        return { id, name, artwork: "", media: saved.kind, mediaPath: saved.path };
      }
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
      return null;
    }
  }

  /** Pasted files become auto-numbered references (Ref-001, Ref-002, …) so a
   *  batch of clipboard images never collides on a generic file name — the same
   *  naming the Design page's paste uses. Returns the created refs so the node
   *  graph can place a node for each. */
  async function addPastedReferences(shotId: string, files: File[]): Promise<GraphRef[]> {
    const names = batchRefNames(files.length);
    const refs: GraphRef[] = [];
    for (let i = 0; i < files.length; i++) {
      const ref = await addFileReference(shotId, files[i], names[i]);
      if (ref) refs.push(ref);
    }
    return refs;
  }

  /** Step 3: persist a shot's editable board-prompt override (empty clears it).
   *  The returned production is merged into renderer state immediately —
   *  otherwise the next saveField would write the stale pre-edit prompt back
   *  and silently revert the manual edit (and its refresh button). */
  async function saveShotPrompt(shotId: string, prompt: string) {
    if (!prod) return;
    latestPromptRef.current[shotId] = prompt;
    promptSaveQueue.current = promptSaveQueue.current.then(async () => {
      const latest = latestPromptRef.current[shotId];
      if (latest !== prompt) return;
      try {
        const next = await window.cascade.updateBoardPrompt(prod.meta.id, shotId, prompt);
        if (latestPromptRef.current[shotId] === prompt) applySnapshot(next);
      } catch (e) {
        setErr(String(e).replace(/^Error:\s*/, ""));
      }
    });
    await promptSaveQueue.current;
  }

  function focusPrompt(shotId: string, _prompt: string) {
    setPromptShotId(shotId);
    setFocusedPrompt(promptCacheRef.current[shotId] ?? "");
    // The node graph and the classic side panel mirror the same shot's prompt:
    // focusing another board while the graph is open moves the graph along so
    // the two editors can never show different shots.
    setGraphShotId((cur) => (cur != null && cur !== shotId ? shotId : cur));
  }

  /** After a Magic Prompt state change, both the classic side panel and the
   *  node graph (which share `focusedPrompt`) must show the same effective
   *  prompt: magic content when enabled, the untouched original when disabled.
   *  Magic edits live in `magicPrompts` so the original `shot.prompt` survives;
   *  disabling only flips the flag — this refresh makes both views show it. */
  async function refreshPromptAfterMagic(next: Production) {
    // Classic + node share `focusedPrompt` for the mirrored shot; refresh the
    // cache for both ids but only push the mirrored shot's text live.
    const ids = new Set<string>();
    if (promptShotId) ids.add(promptShotId);
    if (graphShotId) ids.add(graphShotId);
    // The button click already moved focus off any editor, so the composer /
    // side-panel guards won't clobber this wholesale content switch. Blur
    // defensively anyway (e.g. keyboard-invoked toggles while typing).
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    for (const id of ids) {
      try {
        const p = await window.cascade.getBoardPrompt(next.meta.id, id);
        if (p != null) {
          promptCacheRef.current[id] = p;
          if (id === (promptShotId ?? graphShotId)) setFocusedPrompt(p);
        }
      } catch { /* keep the last good prompt on IPC failure */ }
    }
  }

  /** Shared Magic Prompt toggle for the storyboard head + the node graph head.
   *  Disabling restores the original prompts (magic edits stay stored for
   *  re-enable); enabling shows the stored magic content. */
  function toggleMagic() {
    if (!prod || magicBusy) return;
    setMagicBusy(true); setErr(null);
    const run = prod.magicEnabled
      ? window.cascade.setMagicEnabled(prod.meta.id, false)
      : (prod.magicPrompts && Object.keys(prod.magicPrompts).length)
        ? window.cascade.setMagicEnabled(prod.meta.id, true)
        : window.cascade.generateMagicPrompts(prod.meta.id);
    void run.then((next) => {
      applySnapshot(next); void refreshList();
      void refreshPromptAfterMagic(next);
    }).catch((e) => setErr(String(e).replace(/^Error:\s*/, ""))).finally(() => setMagicBusy(false));
  }

  /** Regenerate all Magic content prompts (stays enabled). Both views refresh. */
  function regenMagic() {
    if (!prod || magicBusy) return;
    setMagicBusy(true); setErr(null);
    void window.cascade.generateMagicPrompts(prod.meta.id).then((next) => {
      applySnapshot(next); void refreshList();
      void refreshPromptAfterMagic(next);
    }).catch((e) => setErr(String(e).replace(/^Error:\s*/, ""))).finally(() => setMagicBusy(false));
  }

  /** Step 3: persist a shot's Audio/Visual direction edited on its board card
   *  (Step 1's table edits the same fields). The auto-derived prompt includes
   *  the shot text, so the focused side panel refreshes — unless its editor
   *  holds focus, where a refresh would yank in-flight keystrokes. */
  async function saveShotText(shotId: string, patch: { audio: string; visual: string }) {
    if (!prod) return;
    try {
      const next = await window.cascade.updateShot(prod.meta.id, shotId, patch);
      applySnapshot(next);
      if (promptShotId === shotId) {
        const updated = await window.cascade.getBoardPrompt(next.meta.id, shotId);
        if (updated != null) {
          promptCacheRef.current[shotId] = updated;
          const el = document.activeElement;
          const editing = el instanceof HTMLTextAreaElement && el.classList.contains("prod-prompt-drawer-text");
          if (!editing) setFocusedPrompt(updated);
        }
      }
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  /** Step 3 node graph: the style link was detached — clear the shot's style
   *  flag so the storyboard dropdown shows None. Runs BEFORE the prompt
   *  change so the queued prompt save lands on the cleared disk state. */
  function detachGraphStyle(shotId: string) {
    if (!prod) return;
    saveField({
      scenes: prod.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((s) => s.id === shotId ? { ...s, style: undefined } : s),
      })),
    });
  }

  /** Step 3 node graph: merge shot-level graph fields (video prompt text,
   *  cycle index, pipes). */
  function saveGraphShotFields(shotId: string, patch: Partial<ProductionShot>) {
    const current = prodRef.current;
    if (!current) return;
    saveField({ scenes: current.scenes.map((sc) => ({ ...sc, shots: sc.shots.map((s) => s.id === shotId ? { ...s, ...patch } : s) })) });
  }

  /** Step 3 node graph: make a generation node's selected output the shot's
   *  primary output (artwork / videoPath). */
  async function applyGraphOutput(shotId: string, kind: "image" | "video", path: string) {
    if (!prod) return;
    try {
      const next = await window.cascade.applyGraphOutput(prod.meta.id, shotId, { kind, path });
      setProd(next);
      bustOne(shotId);
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
  }

  /** Step 3 node graph: pipe the image node's output into the video node's
   *  image input. Independent of the output feed — both can be wired at once. */
  function pipeImageToVideo(shotId: string) {
    if (!prod) return;
    saveGraphShotFields(shotId, { graphImageToVideo: true, graphEditToVideo: undefined, graphVideoSourceEditNodeId: undefined, graphVideoSourceRefId: undefined });
  }

  /** Step 3 node graph: pipe an edit-image node's output into the video
   *  node's image input (the frame the clip animates from). The video node's
   *  source input takes one image at a time, so this displaces the image-node
   *  pipe. Independent of the output feed. */
  function pipeEditToVideo(shotId: string, nodeId: string) {
    if (!prod) return;
    saveGraphShotFields(shotId, { graphEditToVideo: true, graphVideoSourceEditNodeId: nodeId, graphImageToVideo: undefined, graphVideoSourceRefId: undefined });
  }

  /** Step 3 node graph: pipe a reference image into the video node's source
   *  input, displacing either generation-node feed. */
  function pipeRefToVideo(shotId: string, refId: string) {
    if (!prod) return;
    saveGraphShotFields(shotId, { graphVideoSourceRefId: refId, graphImageToVideo: undefined, graphEditToVideo: undefined, graphVideoSourceEditNodeId: undefined });
  }

  /** Step 3 node graph: unpin whatever image node feeds the video node's image
   *  input (the output feed, if any, is untouched). */
  function unpipeImageToVideo(shotId: string) {
    if (!prod) return;
    saveGraphShotFields(shotId, { graphImageToVideo: undefined, graphEditToVideo: undefined, graphVideoSourceEditNodeId: undefined, graphVideoSourceRefId: undefined });
  }

  /** Step 3 node graph: pipe the image node's output into the output — binds
   *  it as the feed and applies its currently selected generation. The
   *  storyboard mirrors the output node: a leftover video path is cleared, and
   *  an empty image node leaves the frame blank. */
  function pipeImageToOutput(shotId: string) {
    if (!prod) return;
    const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    const path = shot.graphImageGens?.[shot.graphImageGenIndex ?? 0]?.path;
    saveGraphShotFields(shotId, {
      graphOutputSource: "imagegen",
      graphOutputRefId: undefined,
      videoPath: undefined,
      artwork: path,
    });
  }

  /** Step 3 node graph: pipe a reference node into the output — binds it as
   *  the feed and applies its media to the shot (image → boards, video →
   *  videoPath). The storyboard mirrors the output node: the stale field of
   *  the other kind is cleared. */
  async function pipeRefToOutput(shotId: string, refId: string) {
    if (!prod) return;
    setErr(null);
    const ref = promptRefsForShot(prod, shotId).find((r) => r.id === refId);
    const isVideo = ref?.media === "video";
    saveGraphShotFields(shotId, {
      graphOutputSource: "ref",
      graphOutputRefId: refId,
      ...(isVideo ? { artwork: undefined } : { videoPath: undefined }),
    });
    try {
      const next = await window.cascade.applyGraphRefOutput(prod.meta.id, shotId, refId);
      setProd(next);
      bustOne(shotId);
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
  }

  /** Step 3 node graph: pipe the video node's output into the output — binds
   *  it as the feed and applies its currently selected clip. The storyboard
   *  mirrors the output node: a leftover frame is cleared, and an empty video
   *  node leaves the frame blank. */
  function pipeVideoToOutput(shotId: string) {
    if (!prod) return;
    const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    const path = shot.graphVideoGens?.[shot.graphVideoGenIndex ?? 0]?.path;
    saveGraphShotFields(shotId, {
      graphOutputSource: "videogen",
      graphOutputRefId: undefined,
      artwork: undefined,
      ...(path ? {} : { videoPath: undefined }),
    });
    if (path) void applyGraphOutput(shotId, "video", path);
  }

  /** Step 3 node graph: unbind the image node's output feed (and the output
   *  feed if it was routed there). The storyboard frame comes from the pipe,
   *  so unpiping leaves it blank. */
  function unpipeImageGen(shotId: string) {
    if (!prod) return;
    const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    // The image node's output also feeds any in-betweener keyframe wired to it,
    // and any edit node whose source is the image node.
    const tweenRefIds = (shot.graphTweenRefIds ?? []).filter((id) => id !== TWEEN_KEY_IMGGEN);
    const editNodes = (shot.graphEditNodes ?? []).map((n) => (n.source?.kind === "imagegen" ? { ...n, source: undefined } : n));
    saveGraphShotFields(shotId, {
      graphImageToVideo: undefined,
      ...(editNodes.some((n, i) => n !== (shot.graphEditNodes ?? [])[i]) ? { graphEditNodes: editNodes } : {}),
      ...(tweenRefIds.length !== (shot.graphTweenRefIds ?? []).length ? { graphTweenRefIds: tweenRefIds } : {}),
      ...(shot.graphOutputSource === "imagegen" ? { graphOutputSource: undefined, artwork: undefined } : {}),
    });
  }

  /** Step 3 node graph: unbind the video node's output feed (the animatic
   *  clip goes with it — it lives in the node's history). */
  function unpipeVideoGen(shotId: string) {
    if (!prod) return;
    const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    if (shot.graphOutputSource === "videogen") saveGraphShotFields(shotId, { graphOutputSource: undefined, videoPath: undefined });
  }

  /** Step 3 in-betweener: replace the ordered keyframe ref ids. Blocks are
   *  re-derived main-side on save (prompts/history survive the pair match). */
  function setTweenRefs(shotId: string, refIds: string[]) {
    if (!prod) return;
    saveGraphShotFields(shotId, { graphTweenRefIds: refIds.slice(0, 5) });
  }

  /** Step 3 in-betweener: pipe the stitched continuous clip into the output —
   *  binds the tween as the feed and applies the stitch. The storyboard
   *  mirrors the output node: a leftover frame is cleared, and an unstitched
   *  node leaves the frame blank. */
  function pipeTweenToOutput(shotId: string) {
    if (!prod) return;
    const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    const path = shot.graphTweenOutput;
    saveGraphShotFields(shotId, {
      graphOutputSource: "tween",
      graphOutputRefId: undefined,
      artwork: undefined,
      ...(path ? {} : { videoPath: undefined }),
    });
    if (path) void applyGraphOutput(shotId, "video", path);
  }

  /** Step 3 in-betweener: unbind the tween output feed (the stitched clip and
   *  per-block takes live on in the node's history). */
  function unpipeTweenGen(shotId: string) {
    if (!prod) return;
    const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    if (shot.graphOutputSource === "tween") saveGraphShotFields(shotId, { graphOutputSource: undefined, videoPath: undefined });
  }

  /** Step 3 in-betweener: generate one action block's clip (prompt = the
   *  block's; keyframes resolved main-side). `modelOverride` is the tween
   *  dropdown's current selection, passed explicitly from the timeline modal
   *  so the submission is exactly what the user sees selected — the list is
   *  filtered to the global provider's end-frame models, and a legacy "auto"
   *  (or a pick saved under a different provider) resolves to the first
   *  listed one. durationSec is the block's displayed length (it can be newer
   *  than the last save after a keyframe drag); main clamps it to the 1–15s
   *  grid as a backstop. */
  async function runTweenBlock(shotId: string, blockId: string, durationSec?: number, modelOverride?: string, params?: Record<string, string>) {
    if (!prod) return;
    if (tweenBusyByShot[shotId]) return;
    setTweenBusyByShot((prev) => ({ ...prev, [shotId]: blockId }));
    setErr(null);
    try {
      const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
      const list = filterTweenModels(mediaModels.filter((m) => m.videoInput), endFrameModelIds);
      const saved = (shot?.graphTweenModel ?? "").trim();
      const model = (modelOverride && modelOverride.trim()) ||
        (saved && list.some((m) => m.id === saved) ? saved : (list[0]?.id ?? ""));
      const tweenParams = params ?? shot?.graphTweenParams;
      const next = await window.cascade.generateTweenBlock(prod.meta.id, shotId, blockId, {
        model: model || undefined,
        resolution: shot?.graphTweenResolution,
        ...(Number(durationSec) > 0 ? { durationSec: Number(durationSec) } : {}),
        ...(tweenParams && Object.keys(tweenParams).length ? { params: tweenParams } : {}),
      });
      setProd(next);
      bustOne(shotId);
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
    finally {
      setTweenBusyByShot((prev) => {
        if (prev[shotId] !== blockId) return prev;
        const next = { ...prev };
        delete next[shotId];
        return next;
      });
    }
  }

  /** Step 3 in-betweener: stitch every block's selected clip into the
   *  continuous shot (and apply it when the tween feeds the output). */
  async function stitchTweenShot(shotId: string) {
    if (!prod || tweenStitchingIds.has(shotId)) return;
    setTweenStitchingIds((prev) => new Set(prev).add(shotId));
    setErr(null);
    try {
      const next = await window.cascade.stitchTween(prod.meta.id, shotId);
      setProd(next);
      bustOne(shotId);
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
    finally {
      setTweenStitchingIds((prev) => {
        const n = new Set(prev);
        n.delete(shotId);
        return n;
      });
    }
  }

  /** Step 3 in-betweener: undo the stitch — back to the individual block
   *  clips so the timeline can be viewed/edited and re-stitched. */
  async function unstitchTweenShot(shotId: string) {
    if (!prod || tweenStitchingIds.has(shotId)) return;
    setTweenStitchingIds((prev) => new Set(prev).add(shotId));
    setErr(null);
    try {
      const next = await window.cascade.unstitchTween(prod.meta.id, shotId);
      setProd(next);
      bustOne(shotId);
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
    finally {
      setTweenStitchingIds((prev) => {
        const n = new Set(prev);
        n.delete(shotId);
        return n;
      });
    }
  }

  /** Step 3 node graph: pipe one edit-image node's output into the output —
   *  binds it as the feed and applies its currently selected edit. The
   *  storyboard mirrors the output node: a leftover video path is cleared, and
   *  an empty edit node leaves the frame blank. */
  function pipeEditToOutput(shotId: string, nodeId: string) {
    if (!prod) return;
    const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    const node = (shot.graphEditNodes ?? []).find((n) => n.id === nodeId);
    const path = node?.gens?.[node.genIndex ?? 0]?.path;
    saveGraphShotFields(shotId, {
      graphOutputSource: "editgen",
      graphOutputEditNodeId: nodeId,
      graphOutputRefId: undefined,
      videoPath: undefined,
      artwork: path,
    });
  }

  /** Step 3 node graph: unbind one edit-image node's output feed (the edited
   *  frame lives in the node's history; the storyboard goes blank until a
   *  generation is piped back in). */
  function unpipeEditGen(shotId: string, nodeId: string) {
    if (!prod) return;
    const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    // The edit node's output also feeds any in-betweener keyframe wired to it.
    const keys = new Set([`${TWEEN_KEY_EDITGEN_PREFIX}${nodeId}`, ...(nodeId === "edit0" ? [TWEEN_KEY_EDITGEN] : [])]);
    const tweenRefIds = (shot.graphTweenRefIds ?? []).filter((id) => !keys.has(id));
    saveGraphShotFields(shotId, {
      // The edit node's output may also feed the video node's source input.
      ...(shot.graphEditToVideo && shot.graphVideoSourceEditNodeId === nodeId ? { graphEditToVideo: undefined, graphVideoSourceEditNodeId: undefined } : {}),
      ...(tweenRefIds.length !== (shot.graphTweenRefIds ?? []).length ? { graphTweenRefIds: tweenRefIds } : {}),
      ...(shot.graphOutputSource === "editgen" && shot.graphOutputEditNodeId === nodeId ? { graphOutputSource: undefined, graphOutputEditNodeId: undefined, artwork: undefined } : {}),
    });
  }

  /** Step 3 node graph: unbind whatever currently feeds the output — the
   *  storyboard frame goes blank until a generation is piped back in. Other
   *  pipes (e.g. imagegen → videogen) are untouched. */
  function unpipeOutput(shotId: string) {
    if (!prod) return;
    const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    saveGraphShotFields(shotId, { graphOutputSource: undefined, graphOutputRefId: undefined, artwork: undefined, videoPath: undefined });
  }

  /** Step 3 node graph: run the image generation node (prompt = the
   *  composer's text; result stored on the node, applied when piped). */
  async function runImageGenNode(shotId: string, model: string, resolution: string, params?: Record<string, string>) {
    if (!prod || nodeImageBusyIds.has(shotId)) return;
    setNodeImageBusyIds((prev) => new Set(prev).add(shotId));
    setErr(null);
    try {
      const cur = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
      const frameParams = params ?? cur?.graphImageParams;
      const next = await window.cascade.generateFrameNode(prod.meta.id, shotId, { prompt: focusedPrompt, model, resolution, ...(frameParams && Object.keys(frameParams).length ? { params: frameParams } : {}) });
      setProd(next);
      bustOne(shotId);
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
    finally {
      setNodeImageBusyIds((prev) => {
        const n = new Set(prev);
        n.delete(shotId);
        return n;
      });
    }
  }

  /** Step 3 node graph: run the video generation node (prompt = the
   *  video-prompt node; source = piped frame or the shot's frame). */
  async function runVideoGenNode(shotId: string, model: string, resolution: string, durationSec: number, params?: Record<string, string>) {
    if (!prod || nodeVideoBusyIds.has(shotId)) return;
    setNodeVideoBusyIds((prev) => new Set(prev).add(shotId));
    setErr(null);
    try {
      const cur = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
      // Source frame: the named edit node when it feeds the video source, then
      // the image node, then a reference image (any may be absent — main then
      // falls back to the shot's own frame).
      const refSource = cur?.graphVideoSourceRefId
        ? [...prod.characters, ...prod.products, ...(prod.references ?? [])].find((r) => r.id === cur.graphVideoSourceRefId)
        : undefined;
      const feedEdit = cur?.graphEditToVideo && cur.graphVideoSourceEditNodeId
        ? (cur.graphEditNodes ?? []).find((n) => n.id === cur.graphVideoSourceEditNodeId)
        : undefined;
      const sourcePath = feedEdit
        ? feedEdit.gens?.[feedEdit.genIndex ?? 0]?.path
        : cur?.graphImageToVideo
          ? cur.graphImageGens?.[cur.graphImageGenIndex ?? 0]?.path
          : refSource?.imagePath;
      const videoParams = params ?? cur?.graphVideoParams;
      // Render the video prompt from the plugged references at submit time.
      const videoPrompt = cur
        ? renderPromptText(cur.graphVideoPrompt ?? VIDEO_PROMPT_DEFAULT, promptRefsFor(prod, cur, "videoprompt"))
        : VIDEO_PROMPT_DEFAULT;
      const next = await window.cascade.generateVideoNode(prod.meta.id, shotId, { prompt: videoPrompt, model, resolution, durationSec, sourcePath, refIds: cur?.graphVideoRefIds ?? [], ...(videoParams && Object.keys(videoParams).length ? { params: videoParams } : {}) });
      setProd(next);
      bustOne(shotId);
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
    finally {
      setNodeVideoBusyIds((prev) => {
        const n = new Set(prev);
        n.delete(shotId);
        return n;
      });
    }
  }

  /** Step 3 node graph: run the edit-video node (mandatory source clip +
   *  prompt + references). `sourceKey` names the chosen source. */
  async function runEditVideoNode(shotId: string, model: string, prompt: string, params?: Record<string, string>) {
    if (!prod || nodeEditVideoBusyIds.has(shotId)) return;
    setNodeEditVideoBusyIds((prev) => new Set(prev).add(shotId));
    setErr(null);
    try {
      const cur = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
      // Source: the video node's selected clip, a wired video reference, or
      // the shot's own video (the default when the source socket is empty).
      let sourcePath: string | undefined;
      if (cur?.graphVideoToEditVideo) sourcePath = cur?.graphVideoGens?.[cur?.graphVideoGenIndex ?? 0]?.path;
      else if (cur?.graphEditVideoSourceRefId) {
        const ref = (prod.references ?? []).find((r) => r.id === cur.graphEditVideoSourceRefId);
        sourcePath = ref?.mediaPath ?? ref?.imagePath;
      } else sourcePath = cur?.videoPath;
      if (!sourcePath) { setErr("The edit-video node needs a source video — wire a clip into its source socket or generate one first."); return; }
      const editParams = params ?? cur?.graphEditVideoParams;
      // Render the edit-video prompt from the plugged references at submit time.
      const editVideoPrompt = cur ? renderShotPrompt(prod, cur, "editvideoprompt") : prompt;
      const next = await window.cascade.generateEditVideoNode(prod.meta.id, shotId, {
        prompt: editVideoPrompt,
        model,
        resolution: cur?.graphEditVideoResolution ?? "",
        sourcePath,
        ...(editParams && Object.keys(editParams).length ? { params: editParams } : {}),
      });
      setProd(next);
      bustOne(shotId);
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
    finally {
      setNodeEditVideoBusyIds((prev) => { const n = new Set(prev); n.delete(shotId); return n; });
    }
  }

  /** Pipe the edit-video node's selected clip into the output. */
  function pipeEditVideoToOutput(shotId: string) {
    const cur = prodRef.current?.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    const sel = cur?.graphEditVideoGens?.[cur?.graphEditVideoGenIndex ?? 0];
    if (!sel) return;
    saveGraphShotFields(shotId, { graphOutputSource: "editvideo", videoPath: sel.path });
  }

  /** Step 3 node graph: AI-edit an image for one edit node (prompt = that
   *  node's edit-prompt node; source = its pipe or the shot's frame). */
  async function runEditGenNode(shotId: string, nodeId: string, model: string, resolution: string, params?: Record<string, string>) {
    const key = `${shotId}:${nodeId}`;
    if (!prod || nodeEditBusyIds.has(key)) return;
    setNodeEditBusyIds((prev) => new Set(prev).add(key));
    setErr(null);
    try {
      const cur = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
      const node = (cur?.graphEditNodes ?? []).find((n) => n.id === nodeId);
      const editParams = params ?? node?.params;
      // Render the edit prompt from the plugged references at submit time —
      // the stored node prompt is content-only, so the live style/brand text
      // is always current (no baked copy from connect time).
      const editPrompt = cur ? renderShotPrompt(prod, cur, { editprompt: nodeId }) : (node?.prompt ?? "");
      const next = await window.cascade.generateEditNode(prod.meta.id, shotId, { nodeId, prompt: editPrompt, model, resolution, ...(editParams && Object.keys(editParams).length ? { params: editParams } : {}) });
      setProd(next);
      bustOne(shotId);
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
    finally {
      setNodeEditBusyIds((prev) => {
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
    }
  }

  /** Step 3 node graph: update one edit node's prompt text. */
  function setEditNodePrompt(shotId: string, nodeId: string, text: string) {
    const current = prodRef.current;
    if (!current) return;
    const shot = current.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    saveGraphShotFields(shotId, { graphEditNodes: (shot.graphEditNodes ?? []).map((n) => (n.id === nodeId ? { ...n, prompt: text } : n)) });
  }

  /** Step 3 node graph: select a generation node's stored output by index;
   *  the piped node's selection becomes the shot's primary output. */
  function selectGraphGen(shotId: string, kind: "image" | "video" | "edit" | "editvideo", index: number, nodeId?: string) {
    if (!prod) return;
    const shot = prodRef.current?.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    if (kind === "editvideo") {
      const items = shot.graphEditVideoGens;
      if (!items || !items[index]) return;
      saveGraphShotFields(shotId, {
        graphEditVideoGenIndex: index,
        ...(shot.graphOutputSource === "editvideo" ? { videoPath: items[index].path } : {}),
      });
      return;
    }
    const editNode = kind === "edit" && nodeId ? (shot.graphEditNodes ?? []).find((n) => n.id === nodeId) : undefined;
    const items = kind === "image" ? shot.graphImageGens : kind === "video" ? shot.graphVideoGens : editNode?.gens;
    if (!items || !items[index]) return;
    const bound = kind === "image" ? shot.graphOutputSource === "imagegen" : kind === "video" ? shot.graphOutputSource === "videogen" : (shot.graphOutputSource === "editgen" && shot.graphOutputEditNodeId === nodeId);
    if (kind === "edit" && nodeId) {
      saveGraphShotFields(shotId, {
        graphEditNodes: (shot.graphEditNodes ?? []).map((n) => (n.id === nodeId ? { ...n, genIndex: index } : n)),
        ...(bound ? { artwork: items[index].path, videoPath: undefined } : {}),
      });
    } else {
      saveGraphShotFields(shotId, {
        ...(kind === "image" ? { graphImageGenIndex: index } : { graphVideoGenIndex: index }),
        ...(bound ? kind === "video" ? { videoPath: items[index].path } : { artwork: items[index].path, videoPath: undefined } : {}),
      });
    }
  }

  /** Step 3 node graph: cycle a generation node's stored outputs; the piped
   *  node's selection becomes the shot's primary output. */
  function cycleGraphGen(shotId: string, kind: "image" | "video" | "edit" | "editvideo", dir: 1 | -1, nodeId?: string) {
    if (!prod) return;
    const shot = prodRef.current?.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    if (kind === "editvideo") {
      const items = shot.graphEditVideoGens;
      if (!items || items.length === 0) return;
      selectGraphGen(shotId, "editvideo", ((shot.graphEditVideoGenIndex ?? 0) + dir + items.length) % items.length, nodeId);
      return;
    }
    const editNode = kind === "edit" && nodeId ? (shot.graphEditNodes ?? []).find((n) => n.id === nodeId) : undefined;
    const items = kind === "image" ? shot.graphImageGens : kind === "video" ? shot.graphVideoGens : editNode?.gens;
    if (!items || items.length === 0) return;
    const cur = (kind === "image" ? shot.graphImageGenIndex : kind === "video" ? shot.graphVideoGenIndex : editNode?.genIndex) ?? 0;
    selectGraphGen(shotId, kind, (cur + dir + items.length) % items.length, nodeId);
  }

  /** Step 3: persist the node graph's canvas state for a shot (node positions
   *  and/or viewport), merged into whatever was saved before. Reads
   *  `prodRef.current` (not the render closure) — a graph mutation (adding an
   *  edit node) saves its shot fields just before the layout save, and a stale
   *  `prod` here would clobber the new node. */
  function saveGraphLayout(shotId: string, layout: GraphLayout) {
    const current = prodRef.current;
    if (!current) return;
    saveField({
      scenes: current.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((s) => s.id === shotId ? { ...s, graphLayout: { ...s.graphLayout, ...layout } } : s),
      })),
    });
  }

  async function setBrandForShot(shotId: string, include: boolean) {
    // Read the freshest snapshot (prodRef), not the render closure: this is now
    // also called from a node-graph connect/detach, which saves the graph edge
    // just before it, and a stale `prod` would drop that write.
    const current = prodRef.current;
    if (!current) return;
    const target = current.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!target) return;
    // The plug is the stored graph's brand edge (step 04); the clause renders
    // from the brand set on read, so no paragraph is ever pasted into the
    // prompt. Graph-less shots keep the legacy shot-level flag.
    const patch: Partial<ProductionShot> = { includeBrandIdentity: include };
    if (target.graph) patch.graph = setBrandEdge(target.graph, "composer", include);
    const next: Production = { ...current, scenes: current.scenes.map((sc) => ({ ...sc, shots: sc.shots.map((s) => s.id === shotId ? { ...s, ...patch } : s) })) };
    setProd(next);
    try {
      await window.cascade.saveProduction(next);
      const fresh = await window.cascade.getBoardPrompt(next.meta.id, shotId);
      setFocusedPrompt(fresh ?? "");
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
  }


  /** Step 3: AI-edit a shot's current frame (image-input model + prompt).
   *  Runs in the background: the modal closes immediately so more edits can
   *  be queued; failures surface via err + the production log. */
  async function runBoardEdit(shotId: string, model: string, prompt: string, params?: ModelOptionValues, resolution?: string) {
    if (!prod || editBusyIds.includes(shotId)) return;
    setEditBusyIds((ids) => [...ids, shotId]);
    setErr(null);
    try {
      const next = await window.cascade.editBoard(
        prod.meta.id,
        shotId,
        model,
        prompt,
        params && Object.keys(params).length ? params : undefined,
        resolution || undefined
      );
      setProd(next);
      bustOne(shotId);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setEditBusyIds((ids) => ids.filter((x) => x !== shotId));
    }
  }

  /** Step 3: generate a video clip for one shot, using its frame + the given
   *  opts as references. Runs in the background like board edits; the result
   *  plays in the animatic timeline for the shot's duration window. */
  async function runVideoGen(shotId: string, opts: VideoGenOptions) {
    if (!prod || videoBusyIds.includes(shotId)) return;
    setVideoBusyIds((ids) => [...ids, shotId]);
    setErr(null);
    try {
      // Render style/brand from the plugged references at submit time (the
      // stored prompt is content-only) — slice 04's single renderer.
      const cur = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
      const prompt = cur
        ? renderPromptText(opts.prompt ?? cur.graphVideoPrompt ?? VIDEO_PROMPT_DEFAULT, promptRefsFor(prod, cur, "videoprompt"))
        : opts.prompt;
      const next = await window.cascade.generateVideo(prod.meta.id, shotId, { ...opts, prompt });
      setProd(next);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setVideoBusyIds((ids) => ids.filter((x) => x !== shotId));
    }
  }

  /** Step 4: remove a shot's generated video (the timeline falls back to the still). */
  async function removeShotVideo(shotId: string) {
    if (!prod) return;
    setErr(null);
    try {
      const next = await window.cascade.removeVideo(prod.meta.id, shotId);
      setProd(next);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  /** Step 3: promote a browsed history frame back to primary for one shot.
   *  The current frame swaps into the history (nothing is deleted). */
  async function promoteHistory(shotId: string, framePath: string) {
    if (!prod) return;
    setErr(null);
    try {
      const next = await window.cascade.promoteBoardHistory(prod.meta.id, shotId, framePath);
      prodRef.current = next;
      setProd(next);
      bustOne(shotId);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  /** Step 4: apply several duration changes in one save. Used by the animatic
   *  roll edit, where dragging one edit point trades time with the following
   *  shot so later edit points stay exactly where they are. */
  function updateDurations(updates: { shotId: string; durationSec: number }[]) {
    if (!prod) return;
    const byId = new Map(updates.map((u) => [u.shotId, u.durationSec]));
    saveField({
      scenes: prod.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((s) => (byId.has(s.id) ? { ...s, durationSec: byId.get(s.id)! } : s)),
      })),
    });
  }

  function reorderShot(shotId: string, beforeShotId: string | null) {
    if (!prod || shotId === beforeShotId) return;
    apply(window.cascade.reorderShot(prod.meta.id, shotId, beforeShotId));
    // Bust board thumbnails after reorder (numbers and folders changed)
    bustAll();
    setBoardDragId(null);
    setBoardDropTarget(null);
    boardDragRef.current = null;
  }

  /** Step 3: insert a blank shot between two board cards (or at the very end
   *  after the last one). Uses the same main-side numbering as Step 1. */
  function insertBlankShot(flat: { sc: Production["scenes"][number]; shot: ProductionShot }[], i: number) {
    if (!prod) return;
    const next = flat[i + 1];
    if (next) {
      const idx = next.sc.shots.findIndex((s) => s.id === next.shot.id);
      apply(window.cascade.insertShot(prod.meta.id, next.sc.number, Math.max(0, idx)));
    } else {
      const last = prod.scenes[prod.scenes.length - 1];
      if (!last) return;
      apply(window.cascade.insertShot(prod.meta.id, last.number, last.shots.length));
    }
  }

  /** Step 3: append a blank shot to the end of the last scene. */
  function appendBlankShot() {
    if (!prod) return;
    const last = prod.scenes[prod.scenes.length - 1];
    if (!last) return;
    apply(window.cascade.insertShot(prod.meta.id, last.number, last.shots.length));
  }

  /** Step 3: delete a shot from the storyboard (right-click menu). The
   *  BoardCard confirms first when the shot has content. */
  function deleteBoardShot(shotId: string) {
    if (!prod) return;
    apply(window.cascade.deleteShot(prod.meta.id, shotId));
  }

  /** Step 3: permanently delete one stored generation (right-click on a board
   *  history frame, a node-graph take, or a tween take). Blocks while the take
   *  still feeds the storyboard/animatic/a pipe, then confirms before unlinking. */
  function deleteGeneration(shotId: string, rel: string) {
    const current = prodRef.current;
    if (!current) return;
    const shot = current.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    const gen = findGeneration(shot, rel);
    if (!gen) return;
    const reason = generationInUse(shot, gen);
    if (reason) { setErr(generationInUseMessage(reason)); return; }
    if (!window.confirm(DELETE_GENERATION_WARNING)) return;
    apply(window.cascade.deleteGeneration(current.meta.id, shotId, rel));
  }

  /** Step 3/4: copy any generated image or clip into the production as a new
   *  "Saved Ref_NN" reference (right-click → Save as reference on a board frame,
   *  node-graph take, or tween take). Main does the copy + naming; the updated
   *  production comes back through `apply`. */
  function saveAsReference(shotId: string, rel: string) {
    const current = prodRef.current;
    if (!current || !rel) return;
    apply(window.cascade.saveGenerationAsReference(current.meta.id, shotId, rel));
  }

  /** Same copy as `saveAsReference`, but resolves the created reference so the
   *  node graph can place its node and wire it to the socket it was dropped on. */
  async function saveGenerationAsReferenceRef(shotId: string, rel: string): Promise<GraphRef | null> {
    const current = prodRef.current;
    if (!current || !rel) return null;
    try {
      const next = await window.cascade.saveGenerationAsReference(current.meta.id, shotId, rel);
      applySnapshot(next);
      void refreshList();
      const refs = next.references ?? [];
      const ref = refs[refs.length - 1];
      if (!ref) return null;
      return {
        id: ref.id,
        name: ref.name,
        artwork: ref.imagePath ? cascadeMedia(next.meta.id, ref.imagePath) : ref.artwork ?? "",
        media: ref.media,
        mediaPath: ref.mediaPath,
      };
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
      return null;
    }
  }

  /** Step 4: toggle whether a clip's own embedded audio plays in the animatic
   *  preview (speaker button on its timeline block). Affects only the shot's
   *  video track — the production-wide VO and music keep their sliders. */
  function toggleShotMuted(shotId: string) {
    if (!prod) return;
    saveField({
      scenes: prod.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((s) => (s.id === shotId ? { ...s, muted: !s.muted } : s)),
      })),
    });
  }

  const imageModels = mediaModels.filter(isImageModel);
  const videoModels = mediaModels.filter(isVideoModel);
  // Surface-filtered lists: each picker offers only the models the user
  // assigned to that surface (unassigned = every applicable surface).
  const imageMasterModels = imageModels.filter((m) => modelOnSurface(m, "image:generate"));
  const imageReferenceModels = imageModels.filter((m) => modelOnSurface(m, "image:generate"));
  const imageCharacterModels = imageModels.filter((m) => modelOnSurface(m, "image:generate"));
  const imageEditModels = imageModels.filter((m) => modelOnSurface(m, "image:edit"));
  const videoModalModels = videoModels.filter((m) => modelOnSurface(m, "video:generate"));
  // Storyboard model dropdown: never display a model different from the one
  // that will run. A stored pick missing from the active vendor's list stays
  // selectable as an explicitly-marked stale entry (submitting with it fails
  // loudly with a re-pick message instead of billing another model).
  // (Defined before the !prod early return below — hooks can't live past it.)
  const storedBoardModel = prod?.openArt?.model ?? "";
  const boardModelStale =
    storedBoardModel !== "" &&
    storedBoardModel !== "auto" &&
    !imageMasterModels.some((m) => m.id === storedBoardModel);
  const boardModelOptions: OpenArtModelChoice[] = boardModelStale
    ? [...imageMasterModels, {
      id: storedBoardModel,
      displayName: `${storedBoardModel} (unavailable — re-pick)`,
      description: "This saved pick isn't offered by the active media provider. Pick another model — submitting with this value errors instead of billing a different model.",
      imageInput: true,
      videoInput: false,
      cost: null,
    }]
    : imageMasterModels;
  const boardModelValue =
    (imageMasterModels.some((m) => m.id === storedBoardModel) || boardModelStale) && storedBoardModel
      ? storedBoardModel
      : (imageMasterModels[0]?.id ?? "");
  /** Live per-config quote req for the production-level image config — shared
   *  by the master-model label and the Submit-frame button so both price what
   *  regenBoard submits with. Null for providers without a cost surface. */
  const boardCostReq: GenerationCostRequest | null = (() => {
    const m = prod?.openArt?.model ?? "auto";
    if (!isQuotableCostModel(m)) return null;
    const p = prod?.openArt?.params;
    const aspect = typeof p?.aspect_ratio === "string" && p.aspect_ratio ? p.aspect_ratio : "16:9";
    return {
      model: m, kind: "image" as const,
      ...(prod?.openArt?.resolution ? { resolution: prod.openArt.resolution } : {}),
      ...(prod?.openArt?.quality ? { quality: prod.openArt.quality } : {}),
      aspectRatio: aspect,
      ...(p && Object.keys(p).length ? { params: { ...p } } : {}),
    };
  })();
  // Quality tiers for the model that will run (Higgsfield catalog probe).
  // Null while loading; empty when the model declares none (dropdown hidden,
  // vendor default applies).
  const [boardQualities, setBoardQualities] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    setBoardQualities(null);
    if (!boardModelValue) {
      setBoardQualities([]);
      return () => { live = false; };
    }
    window.cascade.imageModelOptions(boardModelValue)
      .then((o) => { if (live) setBoardQualities(o?.qualities ?? []); })
      .catch(() => { if (live) setBoardQualities([]); });
    return () => { live = false; };
  }, [boardModelValue]);
  // Drop a saved quality the current model doesn't declare (model switch or
  // catalog change) so submits never carry a stale tier.
  useEffect(() => {
    if (boardQualities === null || !prod) return;
    const q = prod.openArt?.quality;
    if (q && !boardQualities.includes(q)) {
      saveField({ openArt: { model: prod.openArt?.model ?? boardModelValue, resolution: prod.openArt?.resolution ?? "1k", ...(prod.openArt?.params ? { params: prod.openArt.params } : {}) } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardQualities]);
  // Full option schema for the model that will run (Higgsfield `model get`
  // detail). Null while loading or when the provider has no schema — the
  // form hides itself and the ladder dropdowns above stay authoritative.
  const [boardSchema, setBoardSchema] = useState<CliModelSchema | null>(null);
  useEffect(() => {
    let live = true;
    setBoardSchema(null);
    if (!boardModelValue) return () => { live = false; };
    window.cascade.modelOptions(boardModelValue)
      .then((s) => { if (live) setBoardSchema(s); })
      .catch(() => { if (live) setBoardSchema(null); });
    return () => { live = false; };
  }, [boardModelValue]);
  // Reconcile the persisted params with the new model's schema: prune keys the
  // model doesn't declare (stale on a model switch) AND seed the configured
  // per-surface defaults for keys the user never set.
  useEffect(() => {
    if (!boardSchema || !prod) return;
    const cur = prod.openArt?.params ?? {};
    const next = seedModelOptionValues(boardSchema, boardModelValue, "image:generate", pruneModelOptionValues(boardSchema, cur));
    const changed = Object.keys(next).length !== Object.keys(cur).length || Object.keys(next).some((k) => next[k] !== cur[k]);
    if (changed) {
      saveField({
        openArt: {
          model: prod.openArt?.model ?? boardModelValue,
          resolution: prod.openArt?.resolution ?? "1k",
          ...(prod.openArt?.quality ? { quality: prod.openArt.quality } : {}),
          ...(Object.keys(next).length ? { params: next } : {}),
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardSchema]);
  /** Persist the board model's advanced option values (used by both the
   *  exposed-controls row and the Advanced panel, which share one value). */
  const setBoardParams = (next: ModelOptionValues) => {
    if (!prod) return;
    saveField({
      openArt: {
        model: boardModelValue,
        resolution: prod.openArt?.resolution ?? "1k",
        ...(prod.openArt?.quality ? { quality: prod.openArt.quality } : {}),
        ...(Object.keys(next).length ? { params: next } : {}),
      },
    });
  };

  if (!prod) {
    return (
      <div className="prod-welcome">
        <div className="prod-welcome-inner">
          <h2>Production Assistant</h2>
          <p className="prod-sub">Turn a script into a designed, numbered shot list — then boards, animatic, and render.</p>
          <div className="prod-create">
            <label>New production</label>
            <input
              value={newName}
              placeholder="Production name"
              onChange={(e) => setNewName(e.target.value)}
            />
            <button onClick={() => void pickFolder()}>{newFolder ? "Change folder…" : "Choose folder…"}</button>
            {newFolder && (
              <span
                className="prod-folder-hint"
                title={newName.trim() ? `${newFolder.replace(/[\\/]+$/, "")}/${newName.trim()}` : newFolder}
              >
                {newName.trim() ? `${newFolder.replace(/[\\/]+$/, "")}/${newName.trim()}` : newFolder}
              </span>
            )}
            <button className="primary" disabled={creating || importing || !newFolder || !newName.trim()} onClick={() => void create()}>
              {creating ? "Creating…" : "Create"}
            </button>
            <button disabled={creating || importing} onClick={() => void importExisting()} title="Re-register a production folder that's already on disk (its files are adopted as-is)">
              {importing ? "Importing…" : "Import existing…"}
            </button>
          </div>
          {err && <p className="error-text">{err}</p>}
          <div className="prod-recents">
            <h3>Saved productions</h3>
            {list.length === 0 && <p className="hint">Nothing yet — create one above.</p>}
            {list.slice(0, 10).map((m) => (
              <div key={m.id} className="prod-card">
                <button className="prod-card-open" onClick={() => void open(m.id)}>
                  <span className="prod-card-name">{m.name}</span>
                  <span className="prod-card-path">{m.folder}</span>
                  <span className="prod-card-meta">
                    {m.shotCount} shots{m.stepDone ? ` · step ${m.stepDone} done` : ""} · {new Date(m.updatedAt).toLocaleDateString()}
                  </span>
                </button>
                <button className="prod-card-remove" title="Remove from Cascade (files on disk are untouched)" onClick={() => void remove(m.id)}><XIcon size={14} /></button>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const shotCount = prod.scenes.reduce((n, s) => n + s.shots.length, 0);
  const visibleLog = log.filter((l) => l.id === prod.meta.id);
  const boardsDone = prod.scenes.flatMap((s) => s.shots).filter((s) => s.artwork || s.graphImageGens?.length).length;
  const anyTimed = prod.scenes.some((s) => s.shots.some((sh) => sh.durationSec != null));
  const totalRuntime = prod.scenes.flatMap((s) => s.shots).reduce((n, s) => n + (s.durationSec ?? 3), 0);
  // Brand swatches actually shown: trailing empty slots (saved by an older
  // version's pad-to-5 bug) are hidden but stay addressable for edits.
  const brandColors = (() => {
    const all = (prod.brand?.colors ?? []).slice(0, 5);
    let last = all.length - 1;
    while (last >= 0 && !String(all[last]).trim()) last--;
    return all.slice(0, last + 1);
  })();

  return (
    <div className="prod-workspace">
      <header className="prod-header">
        <input
          className="prod-name"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => { if (nameDraft.trim() && nameDraft !== prod.meta.name) saveField({ meta: { ...prod.meta, name: nameDraft.trim() } }); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          title="Rename production"
        />
        <span className="prod-folder" title={prod.meta.folder}>{prod.meta.folder}</span>
        <span className="prod-shotcount">{shotCount} shots</span>
        <button className="prod-close" onClick={close}>Close</button>
      </header>

      <nav className="prod-steps">
        {STEPS.map(({ n, title, desc }) => (
          <button
            key={n}
            className={"prod-step" + (prod.currentStep === n && !showExpenses ? " active" : "")}
            onClick={() => setStep(n)}
            title={desc}
          >
            <span className="prod-step-title">{title}</span>
          </button>
        ))}
        <button
          className={"prod-step prod-step-expenses" + (showExpenses ? " active" : "")}
          onClick={() => setShowExpenses(true)}
          title="Running tally of every AI generation and purchased asset"
        >
          <ExpensesIcon size={14} className="prod-step-icon" />
          <span className="prod-step-title">Expenses</span>
        </button>
      </nav>

      <div className="prod-body">
        {showExpenses ? (
          <ExpensesPanel productionId={prod.meta.id} />
        ) : (
          <>
        {prod.currentStep === 1 && (
          <section className="prod-panel">
            <h3>1 · Script ingestion</h3>
            <div className="prod-ingest">
              <button disabled={busy} onClick={async () => { const f = await window.cascade.pickScriptFile(); if (f) setSource(f); }}>
                Pick script file…
              </button>
              <span className="hint">PDF · DOCX · TXT · MD — legacy .doc must be re-saved as .docx</span>
              <div className="prod-ingest-url">
                <input
                  value={gdocUrl}
                  placeholder="…or paste a Google Docs link (shared “Anyone with the link”)"
                  onChange={(e) => setGdocUrl(e.target.value)}
                />
              </div>
              <button
                className="primary"
                disabled={busy || (!source && !gdocUrl.trim())}
                onClick={() => void ingest(source ?? gdocUrl)}
              >
                {busy ? "Working…" : prod.scenes.length ? "Re-ingest" : "Ingest script"}
              </button>
              {!prod.scenes.length && (
                <button disabled={busy} title="No script to ingest? Start from one scene with five blank shots." onClick={() => void startBlank()}>
                  Start blank
                </button>
              )}
              {source && <span className="hint">Source: {source}</span>}
            </div>
            {err && <p className="error-text">{err}</p>}
            {visibleLog.length > 0 && <ProdLog lines={visibleLog} />}
            <ShotTable prod={prod} onMutation={apply} />
            <StepFooter prod={prod} onNext={goNext} />
          </section>
        )}

        {prod.currentStep === 2 && (
          <section className="prod-panel">
            <h3>2 · Design</h3>

            {err && <p className="error-text">{err}</p>}

            <DesignSection title="Visual styles" prodId={prod.meta.id}>
              <p className="hint">
                Add up to {MAX_STYLES} distinct <strong>named</strong> styles one at a time, then assign each shot a
                style in <em> Storyboard</em>. Style <strong>1</strong> is the default look for every frame.
              </p>
              {(prod.styles ?? []).length > 0 && (
                <div className="prod-styles">
                  {(prod.styles ?? []).map((s, i) => (
                    <div key={s.id} className="prod-style-card">
                      <span className="prod-style-index" title={`Style ${s.index} of up to ${MAX_STYLES}`}>{s.index}</span>
                      {s.imagePath ? (
                        <span className="prod-style-frame-wrap" style={{ position: "relative", flexShrink: 0, alignSelf: "center" }}>
                          <img
                            className="prod-style-frame"
                            src={cascadeMedia(prod.meta.id, s.imagePath)}
                            alt={`Style frame for ${s.name || `Style ${s.index}`}`}
                            title={s.frameSource === "generated" ? "Generated look plate — reused on every shot of this style" : s.frameSource === "anchor" ? "Locked look — from an approved frame" : "Style frame — reused on every shot of this style"}
                          />
                          <button
                            className="prod-style-zoom"
                            style={{ position: "absolute", right: 2, bottom: 2, width: 22, height: 22, borderRadius: "50%", border: "1px solid var(--border)", background: "var(--bg-raised)", color: "var(--text-dim)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                            title="Enlarge this style frame"
                            onClick={() => setStyleZoom(s.id)}
                          >
                            <MagnifyIcon size={12} />
                          </button>
                        </span>
                      ) : (
                        <span className="prod-style-frame-empty" title="No style frame — boards generate from text only">no frame</span>
                      )}
                      {styleZoom === s.id && s.imagePath && (
                        <div className="prod-ref-lightbox" onClick={() => setStyleZoom(null)}>
                          <figure className="prod-ref-lightbox-card">
                            <img src={cascadeMedia(prod.meta.id, s.imagePath)} alt={`Style frame for ${s.name || `Style ${s.index}`}`} />
                            <figcaption>{s.name || `Style ${s.index}`} — click anywhere to close</figcaption>
                          </figure>
                        </div>
                      )}
                      <div className="prod-style-fields">
                        <div className="prod-style-head">
                          {i === 0 && <span className="prod-style-master-tag" title="Default style for shots that haven't picked one">default</span>}
                          <input
                            className="prod-style-name"
                            value={s.name}
                            placeholder="Style name (e.g. Heroic 3D)"
                            onChange={(e) => setStyle(i, { name: e.target.value })}
                            title={`Style ${s.index} — shown in the Storyboard dropdown`}
                          />
                        </div>
                        <textarea
                          className="prod-style-prompt"
                          value={s.prompt}
                          placeholder="Full generation prompt for this style"
                          onChange={(e) => setStyle(i, { prompt: e.target.value })}
                        />
                        <div className="prod-style-frame-row">
                          <button
                            className="prod-btn"
                            disabled={styleFrameBusy !== null || !s.prompt.trim()}
                            onClick={() => void generateStyleFrame(s.id)}
                            title="Generate a neutral look plate from this style's prompt (16:9) — reused on every shot"
                          >
                            {styleFrameBusy === s.id ? "Working…" : <>{s.imagePath && s.frameSource === "generated" ? "Regenerate frame" : "Generate frame"}<GenerationCostSuffix req={(() => {
                              const liveModel = s.model && s.model !== "auto" && imageMasterModels.some((m) => m.id === s.model)
                                ? s.model
                                : prod.openArt?.model ?? "auto";
                              const res = s.resolution ?? prod.openArt?.resolution;
                              // Style frames bill the production quality tier
                              // (the submit reads it off the production).
                              const quality = prod.openArt?.quality;
                              const sp = s.params;
                              return isQuotableCostModel(liveModel) ? {
                                model: liveModel, kind: "image" as const,
                                ...(res ? { resolution: res } : {}),
                                ...(quality ? { quality } : {}),
                                aspectRatio: "16:9",
                                ...(sp && Object.keys(sp).length ? { params: { ...sp } } : {}),
                              } : null;
                            })()} /></>}
                          </button>
                          <button
                            className="prod-btn"
                            disabled={styleFrameBusy !== null}
                            onClick={() => void uploadStyleFrame(s.id)}
                            onDragOver={(e) => { if (styleFrameBusy !== null) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
                            onDrop={(e) => { e.preventDefault(); void dropStyleFrame(s.id, e.dataTransfer.files); }}
                            title="Use your own image as this style's frame — kept as the look anchor"
                          >
                            Upload frame
                          </button>
                          {s.imagePath && (
                            <button
                              className="prod-style-remove"
                              disabled={styleFrameBusy !== null}
                              title="Remove this style's frame (boards fall back to text only)"
                              onClick={() => { setStyle(i, { imagePath: undefined, frameSource: undefined }); }}
                            >
                              <XIcon size={12} />
                            </button>
                          )}
                        </div>
                        <div className="prod-style-frame-row">
                          <label className="prod-openart-label">Model
                            <select
                              className="prod-openart-select"
                              value={s.model && (s.model === "auto" || imageMasterModels.some((m) => m.id === s.model)) ? s.model : "auto"}
                              disabled={styleFrameBusy !== null || imageMasterModels.length === 0}
                              onChange={(e) => setStyle(i, { model: e.target.value === "auto" ? undefined : e.target.value })}
                              title="Model for this style's frame — the same image-generation list as the master picker; Auto inherits the production default"
                            >
                              <option value="auto">
                                {s.model && s.model !== "auto" && !imageMasterModels.some((m) => m.id === s.model)
                                  ? "Auto (previously selected model unavailable)"
                                  : "Auto (production default)"}
                              </option>
                              {imageMasterModels.map((m) => (
                                <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>
                              ))}
                            </select>
                          </label>
                          <label className="prod-openart-label">Resolution
                            <select
                              className="prod-openart-select"
                              value={s.resolution ?? "auto"}
                              disabled={styleFrameBusy !== null}
                              onChange={(e) => setStyle(i, { resolution: e.target.value === "auto" ? undefined : (e.target.value as "1k" | "2k" | "4k") })}
                              title="Resolution for this style's frame — Auto inherits the production default"
                            >
                              <option value="auto">Auto ({prod.openArt?.resolution ?? "1k"})</option>
                              <option value="1k">1k</option>
                              <option value="2k">2k</option>
                              <option value="4k">4k</option>
                            </select>
                          </label>
                        </div>
                        <StyleParamsForm
                          modelId={s.model && s.model !== "auto" && imageMasterModels.some((m) => m.id === s.model) ? s.model : (prod.openArt?.model ?? "auto")}
                          value={(s.params ?? {}) as ModelOptionValues}
                          onChange={(next) => setStyle(i, { params: Object.keys(next).length ? { ...next } : undefined })}
                        />
                        {!s.imagePath && (
                          <p className="hint">No frame — add one so every shot shares the same look (text-only otherwise).</p>
                        )}
                      </div>
                      <button
                        className="prod-style-wand"
                        title="Refine this style's prompt via the model"
                        disabled={refiningStyleId !== null || !s.prompt.trim()}
                        onClick={() => void refineStyle(s.id)}
                      >
                        {refiningStyleId === s.id ? "…" : <MagicIcon size={13} />}
                      </button>
                      <button className="prod-style-remove" title="Remove this style" onClick={() => removeStyle(i)}><XIcon size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
              <div className="prod-style-actions">
                <button className="prod-btn" disabled={(prod.styles?.length ?? 0) >= MAX_STYLES} onClick={addStyle}>
                  <PlusIcon size={14} /> Add style
                </button>
                <button
                  className="prod-btn"
                  disabled={styleImgBusy || (prod.styles?.length ?? 0) >= MAX_STYLES}
                  onClick={() => void pickStyleImage()}
                  onDragOver={(e) => { if (styleImgBusy || (prod.styles?.length ?? 0) >= MAX_STYLES) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; e.currentTarget.classList.add("dragover"); }}
                  onDragLeave={(e) => e.currentTarget.classList.remove("dragover")}
                  onDrop={async (e) => {
                    e.preventDefault(); e.currentTarget.classList.remove("dragover");
                    if (styleImgBusy || (prod.styles?.length ?? 0) >= MAX_STYLES) return;
                    const refId = e.dataTransfer.getData("application/x-cascade-reference");
                    if (refId) { void styleFromReferenceId(refId); return; }
                    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
                    if (files.length) {
                      const file = files[0];
                      if (file.size > 15 * 1024 * 1024) { setErr("That image is larger than 15 MB — use a smaller one."); return; }
                      try {
                        const dataUrl = await fileToDataUrl(file);
                        await styleFromImageDataUrl(dataUrl);
                      } catch { setErr("Couldn't read the dropped image."); }
                    }
                  }}
                  title="Generate a style prompt from an image — or drag a reference image here"
                >
                  {styleImgBusy ? "Reading image…" : <><ImageIcon size={14} /> From image…</>}
                </button>
              </div>
            </DesignSection>

            <DesignSection title="Brand identity" prodId={prod.meta.id}>
              <p className="hint">
                A palette (up to 5 swatches) and optional font appended to <strong>every</strong> style's prompt,
                so the brand look stays consistent across all frames.
              </p>
              <div className="prod-brand-swatches">
                {brandColors.map((c, i) => (
                  <BrandSwatchRow
                    key={i}
                    index={i}
                    value={c}
                    onChange={(hex) => setBrandColor(i, hex)}
                    onRemove={() => removeBrandColor(i)}
                  />
                ))}
                {brandColors.length < 5 && (
                  <button className="prod-brand-add" title="Add a palette swatch" onClick={() => setBrandColor(brandColors.length, "#1A2B3C")}><PlusIcon size={14} /></button>
                )}
              </div>
              <label className="prod-brand-font">
                Font
                <input
                  className="prod-brand-font-input"
                  value={prod.brand?.font ?? ""}
                  placeholder='e.g. "Bebas Neue" or leave blank to skip'
                  onChange={(e) => setBrandFont(e.target.value)}
                />
              </label>
            </DesignSection>

            <DesignSection title="Character builder" prodId={prod.meta.id}>
              <CharacterBuilderSection
                prodId={prod.meta.id}
                characters={prod.characters}
                models={imageCharacterModels}
                references={allPromptRefs(prod)}
                refNameById={referenceNamesById(prod)}
                productionQuality={prod.openArt?.quality}
                onGenerate={runCharacterGen}
              />
            </DesignSection>

            <DesignSection title="References" prodId={prod.meta.id}>
              {(prod.suggestedReferences ?? []).length > 0 && (
                <section className="prod-suggestions">
                  <label className="prod-label">Suggested references</label>
                  <p className="hint">Characters and props found in the script. Add them manually and place them in any category.</p>
                  <div className="prod-suggestion-list">
                    {(prod.suggestedReferences ?? []).map((s) => (
                      <div key={s.id} className="prod-suggestion">
                        <span><strong>{s.name}</strong><small>{s.kind === "character" ? "Character suggestion" : "Prop suggestion"}</small></span>
                        <div className="prod-suggestion-actions">
                          <button className="prod-btn" onClick={() => approveSuggestion(s)}>Add reference</button>
                          <button className="prod-suggestion-remove" title="Dismiss this suggestion" onClick={() => dismissSuggestion(s)}><XIcon size={12} /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <ReferenceCategorySection
                prodId={prod.meta.id}
                categories={prod.referenceCategories ?? []}
                items={prod.references ?? []}
                onAddCategory={addCategory}
                onRenameCategory={renameCategory}
                onAddReference={addRef}
                onAttach={(id) => void attachRefArtwork(id)}
                onRemove={removeRef}
                onRename={(id, name) => void updateRef(id, name)}
                onMove={moveReference}
                onReorder={reorderReference}
                onGenerate={(categoryId) => setRefGen({ categoryId })}
                onEditRef={(ref) => setRefGen({ refId: ref.id })}
                onRescan={rescanRefFolder}
              />
            </DesignSection>

            <DesignSection title="3D models" prodId={prod.meta.id}>
              <ModelGenSection prod={prod} onGenerated={(next) => setProd(next)} />
            </DesignSection>

            {refGen && (
              <RefGenModal
                prodId={prod.meta.id}
                models={imageReferenceModels}
                editModels={imageEditModels}
                categories={prod.referenceCategories ?? []}
                references={prod.references ?? []}
                promptRefs={allPromptRefs(prod)}
                defaultCategoryId={refGen.categoryId}
                initialRefId={refGen.refId}
                productionQuality={prod.openArt?.quality}
                onClose={() => setRefGen(null)}
                onSubmit={runRefGen}
              />
            )}

            {visibleLog.length > 0 && <ProdLog lines={visibleLog} />}

            <StepFooter prod={prod} onNext={goNext} />
          </section>
        )}

        {prod.currentStep === 3 && (
          <section className="prod-panel prod-storyboard-panel">
            <div className="prod-storyboard-head">
              <h3>3 · Storyboard</h3>
              <div className="prod-magic-controls">
                <button
                  className={"prod-btn prod-magic-btn" + (prod.magicEnabled ? " active" : "")}
                  disabled={magicBusy || !shotCount}
                  onClick={toggleMagic}
                  title={prod.magicEnabled ? "Disable Magic Prompt — restore original prompts" : "Enable Magic Prompt — AI generates content-only prompts for all shots"}
                >
                  {magicBusy ? "…" : prod.magicEnabled ? <><MagicIcon size={13} /> Magic On</> : <><MagicIcon size={13} /> Magic Prompt</>}
                </button>
                {prod.magicEnabled && (
                  <button
                    className="prod-btn prod-magic-refresh"
                    disabled={magicBusy}
                    onClick={regenMagic}
                    title="Regenerate Magic Prompts (AI will re-generate all content prompts)"
                  >
                    <RegenerateIcon size={13} />
                  </button>
                )}
              </div>
            </div>
            <p className="hint">
              One frame per shot — the master style and character keys from Step 2 are baked into every prompt.
              Frames are saved to <code>{prod.assets.boardsDir}/</code> in the production folder.
              {mediaOk === true && ` In-app generation uses the connected ${mediaProviderName}${mediaProviderId.endsWith("-cli") ? " CLI" : " MCP server"}.`}
              {mediaOk === false && (
                <> {mediaProviderName}{mediaProviderId.endsWith("-cli") ? " CLI isn't set up" : " MCP isn't connected"}, so use <strong>Export prompts</strong> to generate frames externally.</>
              )}
            </p>
            <div className="prod-boards-controls">
              <div className="prod-boards-config-row">
                  <label className="prod-openart-label">Model
                    <span className="prod-boards-model-cost">
                      <GenerationCostSuffix req={boardCostReq} />
                    </span>
                    <select
                      className="prod-openart-select"
                      value={boardModelValue}
                      onChange={(e) => {
                        saveField({ openArt: { model: e.target.value, resolution: prod.openArt?.resolution ?? "1k", ...(prod.openArt?.quality ? { quality: prod.openArt.quality } : {}), ...(prod.openArt?.params ? { params: prod.openArt.params } : {}) } });
                        rememberMediaDefault("image", { model: e.target.value, resolution: prod.openArt?.resolution ?? "1k" });
                      }}
                      title="Model for in-app generation"
                      disabled={boardModelOptions.length === 0}
                    >
                      {boardModelOptions.map((m) => (
                        <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>
                      ))}
                    </select>
                  </label>
                  <label className="prod-openart-label">Resolution
                    <select
                      className="prod-openart-select"
                      value={prod.openArt?.resolution ?? "1k"}
                      onChange={(e) => {
                        saveField({ openArt: { model: boardModelValue, resolution: e.target.value as "1k" | "2k" | "4k", ...(prod.openArt?.quality ? { quality: prod.openArt.quality } : {}), ...(prod.openArt?.params ? { params: prod.openArt.params } : {}) } });
                        rememberMediaDefault("image", { resolution: e.target.value });
                      }}
                      title="Output resolution for image generation"
                    >
                      <option value="1k">1k</option>
                      <option value="2k">2k</option>
                      <option value="4k">4k</option>
                    </select>
                  </label>
                  {boardQualities !== null && boardQualities.length > 0 && (
                    <label className="prod-openart-label">Quality
                      <select
                        className="prod-openart-select"
                        value={boardQualities.includes(prod.openArt?.quality ?? "") ? (prod.openArt?.quality as string) : ""}
                        onChange={(e) => {
                          const quality = e.target.value || undefined;
                          saveField({ openArt: { model: boardModelValue, resolution: prod.openArt?.resolution ?? "1k", ...(quality ? { quality } : {}), ...(prod.openArt?.params ? { params: prod.openArt.params } : {}) } });
                        }}
                        title="Quality tier for this image model (from its live catalog options)"
                      >
                        <option value="">Default</option>
                        {boardQualities.map((q) => (
                          <option key={q} value={q}>{q}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <ModelOptionsForm
                    schema={boardSchema}
                    value={(prod.openArt?.params ?? {}) as ModelOptionValues}
                    exclude={["resolution", "quality"]}
                    persistKey="cascade.modelOptions.advanced.board"
                    render="exposed"
                    onChange={setBoardParams}
                  />
                  <div className="prod-boards-advanced">
                    <ModelOptionsForm
                      schema={boardSchema}
                      value={(prod.openArt?.params ?? {}) as ModelOptionValues}
                      exclude={["resolution", "quality"]}
                      persistKey="cascade.modelOptions.advanced.board"
                      render="advanced"
                      onChange={setBoardParams}
                    />
                  </div>
                </div>
              <div className="prod-boards-actions">
                <button className="primary" disabled={boardsBusy || importBusy || !shotCount} onClick={() => void genBoards()}>
                  {boardsBusy ? "Generating…" : boardsDone ? "Generate missing frames" : "Generate Storyboard"}
                </button>
                <button disabled={boardsBusy || importBusy || !shotCount} onClick={() => setShowBoardText((v) => !v)} title="Show or hide the Audio/Visual direction boxes under each frame">
                  {showBoardText ? "Hide direction" : "Show direction"}
                </button>
                <span className="prod-boards-sep" />
                <button disabled={boardsBusy || importBusy || !shotCount} onClick={() => void exportPrompts()} title={`Write every shot's prompt to ${prod.assets.boardsDir}/prompts.md`}>
                  Export prompts
                </button>
                <button disabled={boardsBusy || importBusy || !shotCount} onClick={() => setPdfOpen(true)} title="Export the storyboard (frames + Audio/Visual) to a landscape PDF">
                  Export storyboard PDF
                </button>
                <span className="prod-boards-sep" />
                <button disabled={boardsBusy || importBusy || !shotCount} onClick={() => void refreshBoardLinks()} title="Re-link broken storyboard frame paths to the newest frame files on disk">
                  Refresh Storyboard Images
                </button>
                <span className="hint">{boardsDone}/{shotCount} shots have frames</span>
              </div>
            </div>
            {err && <p className="error-text">{err}</p>}
            {shotCount > 0 && (
              <div className="prod-storyboard-layout" style={{ "--frame-min-width": `${frameZoom}px` } as React.CSSProperties}>
              <div
                className="prod-boards-grid"
                onDragOver={(e) => {
                  if (boardDragRef.current && e.dataTransfer.types.includes("application/x-cascade-shot-order")) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }
                }}
                onDrop={(e) => {
                  if (!boardDragRef.current) return;
                  if (!e.dataTransfer.types.includes("application/x-cascade-shot-order")) return;
                  // Dropped on grid background = move to end
                  const src = boardDragRef.current;
                  const flat = prod.scenes.flatMap((sc) => sc.shots);
                  const last = flat[flat.length - 1];
                  if (src && last && src !== last.id) {
                    e.preventDefault();
                    reorderShot(src, null);
                  }
                  setBoardDropTarget(null);
                  setBoardDragId(null);
                  boardDragRef.current = null;
                }}
              >
                {prod.scenes.flatMap((sc) => sc.shots.map((shot) => ({ sc, shot }))).map(({ shot }) => (
                  <BoardCard
                    key={shot.id}
                    prod={prod}
                    shot={shot}
                    bust={boardBustFor(shot.id)}
                    regenerating={regenIds.has(shot.id) || editBusyIds.includes(shot.id) || nodeImageBusyIds.has(shot.id) || nodeEditBusyIds.has(shot.id)}
                    videoBusy={videoBusyIds.includes(shot.id) || nodeVideoBusyIds.has(shot.id) || tweenBusyByShot[shot.id] !== undefined || tweenStitchingIds.has(shot.id)}
                    pending={!!shot.pendingImageGen}
                    rechecking={recheckIds.has(shot.id)}
                    onRegenerate={boardActions.onRegenerate}
                    onRecheck={boardActions.onRecheck}
                    onImport={boardActions.onImport}
                    onEdit={boardActions.onEdit}
                    onVideo={boardActions.onVideo}
                    onTextChange={boardActions.onTextChange}
                    showScript={showBoardText}
                    onPromptFocus={boardActions.onPromptFocus}
                    selected={promptShotId === shot.id}
                    onDropFrame={boardActions.onDropFrame}
                    onDropFiles={boardActions.onDropFiles}
                    onPromoteHistory={boardActions.onPromoteHistory}
                    onDeleteGeneration={boardActions.onDeleteGeneration}
                    onSaveAsReference={boardActions.onSaveAsReference}
                    draggable
                    isDragging={boardDragId === shot.id}
                    isReorderTarget={boardDropTarget === shot.id}
                    onReorderDragStart={boardActions.onReorderDragStart}
                    onReorderDragOver={boardActions.onReorderDragOver}
                    onReorderDragEnd={boardActions.onReorderDragEnd}
                    onReorderDrop={boardActions.onReorderDrop}
                    onInsertAfter={boardActions.onInsertAfter}
                    onDelete={boardActions.onDelete}
                  />
                ))}
                <button
                  className="prod-board-add"
                  title="Add a blank shot at the end"
                  onClick={appendBlankShot}
                ><PlusIcon size={16} /></button>
                {boardDragId && (
                  <div
                    className={"prod-board prod-board-end-zone" + (boardDropTarget === "__end__" ? " drop-target" : "")}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes("application/x-cascade-shot-order")) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (boardDropTarget !== "__end__") setBoardDropTarget("__end__");
                      }
                    }}
                    onDragLeave={(e) => {
                      const rt = e.relatedTarget as HTMLElement | null;
                      if (rt && e.currentTarget.contains(rt)) return;
                      if (boardDropTarget === "__end__") setBoardDropTarget(null);
                    }}
                    onDrop={(e) => {
                      if (!e.dataTransfer.types.includes("application/x-cascade-shot-order")) return;
                      e.preventDefault();
                      const src = boardDragRef.current;
                      setBoardDropTarget(null);
                      setBoardDragId(null);
                      boardDragRef.current = null;
                      if (!src) return;
                      const flat = prod.scenes.flatMap((sc) => sc.shots);
                      const last = flat[flat.length - 1];
                      if (src === last?.id) return;
                      reorderShot(src, null);
                    }}
                  >
                    <span className="prod-board-end-label">Drop at end</span>
                  </div>
                )}
              </div>
              <PromptSidePanel
                shotNumber={focusedShot?.number}
                value={focusedPrompt}
                includeBrand={focusedShot?.includeBrandIdentity === true}
                styles={prod.styles ?? []}
                styleValue={focusedShot ? shotStyleSelectValue(focusedShot, prod) : ""}
                references={promptShotId ? promptRefsForShot(prod, promptShotId) : []}
                onChange={(value) => { setFocusedPrompt(value); if (promptShotId) { promptCacheRef.current[promptShotId] = value; void saveShotPrompt(promptShotId, value); } }}
                onToggleBrand={(include) => { if (promptShotId) void setBrandForShot(promptShotId, include); }}
                onStyleChange={(style) => { if (promptShotId) void updateShotStyle(promptShotId, style); }}
                onSubmit={() => { if (promptShotId) void regenBoard(promptShotId); }}
                submitting={!!promptShotId && regenIds.has(promptShotId)}
                submitSuffix={<GenerationCostSuffix req={boardCostReq} />}
                onOpenGraph={() => { if (promptShotId) setGraphShotId(promptShotId); }}
                magicActive={!!prod.magicEnabled}
              />
              </div>
            )}
            {shotCount > 0 && <label className="prod-frame-zoom">Frame size <input type="range" min={180} max={440} step={10} value={frameZoom} onChange={(e) => setFrameZoom(Number(e.target.value))} /><span>{frameZoom}px</span></label>}
            {visibleLog.length > 0 && <ProdLog lines={visibleLog} />}
            {graphShotId && (() => {
              const gs = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === graphShotId);
              return gs ? (
                <NodeGraphModal
                  prod={prod}
                  shot={gs}
                  bust={boardBustFor(gs.id)}
                  prompt={focusedPrompt}
                  references={promptRefsForShot(prod, graphShotId)}
                  styles={prod.styles ?? []}
                  styleValue={shotStyleSelectValue(gs, prod)}
                  includeBrand={gs.includeBrandIdentity === true}
                  magicActive={!!prod.magicEnabled}
                  magicBusy={magicBusy}
                  onToggleMagic={toggleMagic}
                  onRegenMagic={regenMagic}
                  initialLayout={gs.graphLayout}
                  onPromptChange={(value) => { setFocusedPrompt(value); if (graphShotId) { promptCacheRef.current[graphShotId] = value; void saveShotPrompt(graphShotId, value); } }}
                  onStyleChange={(style) => setGraphStyle(graphShotId!, style)}
                  onToggleBrand={(include) => { if (graphShotId) void setBrandForShot(graphShotId, include); }}
                  onDropFile={(file) => graphShotId ? addFileReference(graphShotId, file) : Promise.resolve(null)}
                  onPasteFiles={(files) => graphShotId ? addPastedReferences(graphShotId, files) : Promise.resolve([])}
                  onStyleDetached={() => { if (graphShotId) detachGraphStyle(graphShotId); }}
                  imageModels={imageModels}
                  videoModels={videoModels}
                  endFrameModelIds={endFrameModelIds}
                  defaultImageModel={prod.openArt?.model ?? imageModels[0]?.id ?? ""}
                  defaultImageResolution={prod.openArt?.resolution ?? "1k"}
                  onRunImageGen={(model, resolution, params) => graphShotId ? runImageGenNode(graphShotId, model, resolution, params) : Promise.resolve()}
                  onRunVideoGen={(model, resolution, durationSec, params) => graphShotId ? runVideoGenNode(graphShotId, model, resolution, durationSec, params) : Promise.resolve()}
                  onRunEditGen={(nodeId, model, resolution, params) => graphShotId ? runEditGenNode(graphShotId, nodeId, model, resolution, params) : Promise.resolve()}
                  onRunEditVideo={(model, editPrompt, params) => graphShotId ? runEditVideoNode(graphShotId, model, editPrompt, params) : Promise.resolve()}
                  onPipeEditVideoToOutput={() => { if (graphShotId) pipeEditVideoToOutput(graphShotId); }}
                  onRunTweenBlock={(blockId, durationSec, model, params) => graphShotId ? runTweenBlock(graphShotId, blockId, durationSec, model, params) : Promise.resolve()}
                  onStitchTween={() => graphShotId ? stitchTweenShot(graphShotId) : Promise.resolve()}
                  onUnstitchTween={() => graphShotId ? unstitchTweenShot(graphShotId) : Promise.resolve()}
                  imageGenBusy={graphShotId ? nodeImageBusyIds.has(graphShotId) : false}
                  videoGenBusy={graphShotId ? nodeVideoBusyIds.has(graphShotId) : false}
                  editVideoBusy={graphShotId ? nodeEditVideoBusyIds.has(graphShotId) : false}
                  editBusyNodeIds={graphShotId ? (gs.graphEditNodes ?? []).filter((n) => nodeEditBusyIds.has(`${graphShotId}:${n.id}`)).map((n) => n.id) : []}
                  busyTweenBlock={graphShotId ? tweenBusyByShot[graphShotId] ?? null : null}
                  tweenStitching={graphShotId ? tweenStitchingIds.has(graphShotId) : false}
                  onSelectGraphGen={(kind, index, nodeId) => { if (graphShotId) selectGraphGen(graphShotId, kind, index, nodeId); }}
                  onCycleGraphGen={(kind, dir, nodeId) => { if (graphShotId) cycleGraphGen(graphShotId, kind, dir, nodeId); }}
                  onDeleteGeneration={(rel) => { if (graphShotId) deleteGeneration(graphShotId, rel); }}
                  onSaveAsReference={(rel) => { if (graphShotId) saveAsReference(graphShotId, rel); }}
                  onSaveGenerationAsReference={(rel) => graphShotId ? saveGenerationAsReferenceRef(graphShotId, rel) : Promise.resolve(null)}
                  onEditNodePrompt={(nodeId, text) => { if (graphShotId) setEditNodePrompt(graphShotId, nodeId, text); }}
                  onRenameRef={(id, name) => void updateRef(id, name)}
                  onGraphField={(patch) => { if (graphShotId) saveGraphShotFields(graphShotId, patch); }}
                  onPipeImageToVideo={() => { if (graphShotId) pipeImageToVideo(graphShotId); }}
                  onPipeEditToVideo={(nodeId) => { if (graphShotId) pipeEditToVideo(graphShotId, nodeId); }}
                  onPipeRefToVideo={(refId) => { if (graphShotId) pipeRefToVideo(graphShotId, refId); }}
                  onPipeImageToOutput={() => { if (graphShotId) pipeImageToOutput(graphShotId); }}
                  onPipeVideoToOutput={() => { if (graphShotId) pipeVideoToOutput(graphShotId); }}
                  onPipeTweenToOutput={() => { if (graphShotId) pipeTweenToOutput(graphShotId); }}
                  onPipeEditToOutput={(nodeId) => { if (graphShotId) pipeEditToOutput(graphShotId, nodeId); }}
                  onPipeRefToOutput={(refId) => { if (graphShotId) void pipeRefToOutput(graphShotId, refId); }}
                  onTweenRefs={(refIds) => { if (graphShotId) setTweenRefs(graphShotId, refIds); }}
                  onUnpipeImageGen={() => { if (graphShotId) unpipeImageGen(graphShotId); }}
                  onUnpipeImageToVideo={() => { if (graphShotId) unpipeImageToVideo(graphShotId); }}
                  onUnpipeVideoGen={() => { if (graphShotId) unpipeVideoGen(graphShotId); }}
                  onUnpipeTweenGen={() => { if (graphShotId) unpipeTweenGen(graphShotId); }}
                  onUnpipeEditGen={(nodeId) => { if (graphShotId) unpipeEditGen(graphShotId, nodeId); }}
                  onUnpipeOutput={() => { if (graphShotId) unpipeOutput(graphShotId); }}
                  onSaveLayout={(layout) => { if (graphShotId) saveGraphLayout(graphShotId, layout); }}
                  onClose={() => setGraphShotId(null)}
                />
              ) : null;
            })()}
            {editShotId && (() => {
              const es = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === editShotId);
              return es ? (
                <EditBoardModal
                  shotNumber={es.number}
                  models={imageEditModels}
                  savedModel={es.graphEditNodes?.find((n) => n.id === (es.graphOutputSource === "editgen" ? es.graphOutputEditNodeId : undefined))?.model}
                  savedResolution={es.graphEditNodes?.find((n) => n.id === (es.graphOutputSource === "editgen" ? es.graphOutputEditNodeId : undefined))?.resolution}
                  productionQuality={prod.openArt?.quality}
                  onSavedModelChange={(m) => {
                    if (es.graphOutputSource === "editgen" && es.graphOutputEditNodeId) {
                      saveGraphShotFields(es.id, {
                        graphEditNodes: (es.graphEditNodes ?? []).map((n) => (n.id === es.graphOutputEditNodeId ? { ...n, model: m } : n)),
                      });
                    }
                  }}
                  prompt={es.graphEditPrompt ?? ""}
                  onPromptChange={(text) => saveGraphShotFields(es.id, { graphEditPrompt: text })}
                  onSubmit={(model, prompt, params, resolution) => {
                    const id = editShotId;
                    setEditShotId(null); // close immediately; edit runs in background
                    if (id) void runBoardEdit(id, model, prompt, params, resolution);
                  }}
                  onClose={() => setEditShotId(null)}
                />
              ) : null;
            })()}
            {videoShotId && (() => {
              const vs = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === videoShotId);
              return vs ? (
                <VideoGenModal
                  shot={vs}
                  prod={prod}
                  models={videoModalModels}
                  prompt={vs.graphVideoPrompt ?? VIDEO_PROMPT_DEFAULT}
                  onShotField={(patch) => saveGraphShotFields(vs.id, patch)}
                  onPromptChange={(text) => saveGraphShotFields(vs.id, { graphVideoPrompt: text })}
                  onClose={() => setVideoShotId(null)}
                  onSubmit={(opts) => {
                    const id = videoShotId;
                    setVideoShotId(null); // close immediately; generation runs in background
                    if (id) void runVideoGen(id, opts);
                  }}
                />
              ) : null;
            })()}
            {pdfOpen && (
              <StoryboardPdfModal
                prod={prod}
                onClose={() => setPdfOpen(false)}
                onDone={(next) => setProd(next)}
              />
            )}
            <StepFooter prod={prod} onNext={goNext} />
          </section>
        )}

        {prod.currentStep === 4 && (
          <section className="prod-panel prod-storyboard-panel">
            <h3>4 · Animatic</h3>
            <p className="hint">
              Import one voiceover clip for the whole production, optionally add a music track, then
              drag the cut points on the timeline to set the length of each clip. The plan is written to <code>{prod.assets.outDir}/animatic.md</code>.
            </p>

            {err && <p className="error-text">{err}</p>}
            {visibleLog.length > 0 && <ProdLog lines={visibleLog} />}

            {shotCount > 0 && (
              <>
                <div className="prod-animatic-panels">
                  <section className="prod-audio">
                    <header className="prod-audio-head">
                      <label className="prod-label">Voiceover</label>
                      <div className="prod-audio-controls">
                        {prod.voiceoverPath && (voObjectUrl || voUrl) ? (
                          <div className="prod-audio-file">
                            <MiniAudioPlayer src={voObjectUrl ?? voUrl} onDurationKnown={setVoDuration} audioRef={voPreviewRef} />
                            <span className="prod-music-name" title={prod.voiceoverPath}>
                              {prod.voiceoverPath.split("/").pop()}
                              {voDuration != null ? ` · ${formatRuntime(voDuration)}` : ""}
                            </span>
                            <VolumeSlider
                              value={prod.voiceoverVolume ?? 1}
                              onCommit={setVoiceoverVolume}
                              audioRef={voPreviewRef}
                              title="Voiceover volume"
                            />
                            <button
                              onClick={() => fitShotsToTotal(voDuration ?? totalRuntime)}
                              title="Rescale every shot's length so the total matches the voiceover"
                            >
                              Fit to VO
                            </button>
                            <button
                              onClick={() => void importVo()}
                              title="Pick a local audio file to replace the voiceover"
                            >
                              Replace…
                            </button>
                            <button className="prod-suggestion-remove" title="Remove the voiceover" onClick={() => void removeVo()}><XIcon size={12} /></button>
                          </div>
                        ) : (
                          <div className="prod-audio-file">
                            <button onClick={() => void importVo()} title="Pick a local audio file to use as the voiceover">
                              Import…
                            </button>
                          </div>
                        )}
                      </div>
                    </header>
                  </section>

                  <section className="prod-audio">
                    <header className="prod-audio-head">
                      <label className="prod-label">Music</label>
                      <div className="prod-audio-controls">
                        {prod.musicPath && (musicObjectUrl || musicUrl) ? (
                          <div className="prod-audio-file">
                            <MiniAudioPlayer src={musicObjectUrl ?? musicUrl} audioRef={musicPreviewRef} />
                            <span className="prod-music-name" title={prod.musicPath}>
                              {prod.musicPath.split("/").pop()}
                            </span>
                            <VolumeSlider
                              value={prod.musicVolume ?? 0.5}
                              onCommit={setMusicVolume}
                              audioRef={musicPreviewRef}
                              title="Background music volume"
                            />
                            <button onClick={() => void importMusic()}>Replace…</button>
                            <button className="prod-suggestion-remove" title="Remove the music track" onClick={() => void removeMusic()}><XIcon size={12} /></button>
                          </div>
                        ) : (
                          <div className="prod-audio-file">
                            <button onClick={() => void importMusic()} title="Pick an mp3/wav/m4a/ogg/flac to play under the animatic">
                              Import music…
                            </button>
                          </div>
                        )}
                      </div>
                    </header>
                  </section>
                </div>

                <section className="prod-animatic">
                  <header className="prod-animatic-head">
                    <label className="prod-label">Timeline</label>
                    <div className="prod-animatic-controls">
                      {anyTimed && <span className="hint">Total runtime ≈ {formatRuntime(totalRuntime)}</span>}
                    </div>
                  </header>
                  <AnimaticTimeline
                    prodId={prod.meta.id}
                    scenes={prod.scenes}
                    voUrl={voObjectUrl ?? voUrl}
                    voDuration={voDuration}
                    onVoDurationKnown={setVoDuration}
                    musicUrl={musicObjectUrl ?? musicUrl}
                    musicVolume={prod.musicVolume ?? 0.5}
                    voiceoverVolume={prod.voiceoverVolume ?? 1}
                    onUpdateDurations={(updates) => updateDurations(updates)}
                    onFitToVo={() => fitShotsToTotal(voDuration ?? totalRuntime)}
                    onUpdateTotal={(sec) => fitShotsToTotal(sec)}
                    onRemoveVideo={(shotId) => void removeShotVideo(shotId)}
                    onToggleMute={toggleShotMuted}
                    onSaveAsReference={(shotId, rel) => saveAsReference(shotId, rel)}
                  />
                </section>
              </>
            )}
            <StepFooter prod={prod} onNext={goNext} />
          </section>
        )}

        {prod.currentStep === 5 && (
          <AssemblyPanel prod={prod} onApply={apply} log={visibleLog} />
        )}
          </>
        )}
      </div>

      {visionWarnModel && (
        <div className="prod-edit-overlay" onClick={() => setVisionWarnModel(null)}>
          <div className="prod-edit-panel prod-vision-panel" onClick={(e) => e.stopPropagation()}>
            <div className="prod-edit-head">
              <span className="prod-edit-title">⚠ Vision-capable model needed</span>
              <button className="prod-btn" onClick={() => setVisionWarnModel(null)}><XIcon size={12} /></button>
            </div>
            <p className="prod-vision-text">
              The active model (<strong>{visionWarnModel}</strong>) can't see images. Switch to a
              vision-capable model in Settings, then try generating the style again.
            </p>
            <div className="prod-vision-actions">
              {onOpenSettings && (
                <button
                  className="prod-btn primary"
                  onClick={() => { setVisionWarnModel(null); onOpenSettings(); }}
                >
                  Open Settings
                </button>
              )}
              <button className="prod-btn" onClick={() => setVisionWarnModel(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Step 4: small thumbnail of a shot's primary frame for the animatic
 *  timeline. Fetched on demand as a data URL, like the Step 3 contact sheet.
 *  The IPC re-reads the file from disk and re-encodes a JPEG per call, so
 *  results are memoized by (prod, shot, artwork) — the strip and the preview
 *  pane both mount the same thumb, and every playhead change remounts these. */
