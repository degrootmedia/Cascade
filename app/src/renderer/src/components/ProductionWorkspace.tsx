/**
 * Production Assistant workspace: production picker/creator on first entry,
 * then a 5-step pipeline view. Step 1 (script ingestion + shot table) is live;
 * later steps show their planned surface and keep persisted state (style).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Production, ProductionMeta, ProductionShot, OpenArtModelChoice, SuggestedReference, ReferenceCategory, CustomRef, VideoGenOptions, VideoModelOptions, GraphLayout, ReferenceImageGenOptions, CharacterSheetGenOptions } from "../../../shared/ipc.js";
import { addRefTag, addStyleParagraph, composePromptBoxes, hasBrandParagraph, insertBrandParagraph, parsePromptBoxes, refTagNames, removeStyleParagraph, stripBrandParagraph } from "../../../shared/prompt-grammar.js";
import { ShotTable } from "./ShotTable.js";
import { NodeGraphModal, VIDEO_PROMPT_DEFAULT } from "./NodeGraphModal.js";
import { TriplePrompt, type PromptContentHandle } from "./TriplePrompt.js";
import { AnimaticTimeline, cascadeMedia, MiniAudioPlayer, ProdLog, StepFooter, VolumeSlider, type LogLine, formatRuntime, STEPS } from "./production/animatic.js";
import { ReferenceCategorySection, RefGenModal, CharacterBuilderSection, allPromptRefs, brandClause, promptRefsForShot, shotStyleSelectValue } from "./production/references.js";
import { PromptSidePanel } from "./production/prompt-panel.js";
import { BoardCard, EditBoardModal, VideoGenModal } from "./production/boards.js";
import { AssemblyPanel } from "./production/assembly.js";
import { ExpensesPanel } from "./production/expenses.js";
import { BrandSwatchRow } from "./production/brand.js";
import { uid } from "./production/hex.js";
import { usePersistedCollapsed } from "./production/persisted-state.js";

/** Hard cap on the Step 2 style set. */
const MAX_STYLES = 5;

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
  // step 1 form
  const [gdocUrl, setGdocUrl] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  // step 2: per-style refinement (tracks which style card is refining)
  const [refiningStyleId, setRefiningStyleId] = useState<string | null>(null);
  // step 2: generating a style from an imported/pasted image (spinner on buttons)
  const [styleImgBusy, setStyleImgBusy] = useState(false);
  // step 2: set when the active chat model can't see images (shows a popup)
  const [visionWarnModel, setVisionWarnModel] = useState<string | null>(null);
  // step 3: board generation
  const [boardCap, setBoardCap] = useState(50);
  const [frameZoom, setFrameZoom] = useState(250);
  const [boardsBusy, setBoardsBusy] = useState(false);
  /** Shot ids currently regenerating (a Set so several frames can run in parallel). */
  const [regenIds, setRegenIds] = useState<Set<string>>(new Set());
  /** Shot ids whose pending OpenArt job is being rechecked. */
  const [recheckIds, setRecheckIds] = useState<Set<string>>(new Set());
  // Regeneration batches are dispatched via `regenerateBoards` (one shared
  // production → parallel workers → a single save). Overlapping batches would
  // each load/save the whole production and clobber each other, so batches run
  // strictly one at a time; clicks during a run join the next batch.
  const regenRunningRef = useRef(false);
  const regenPendingRef = useRef<string[]>([]);
  const [boardBust, setBoardBust] = useState(0); // cache-buster after (re)generation
  const [boardDragId, setBoardDragId] = useState<string | null>(null);
  const [boardDropTarget, setBoardDropTarget] = useState<string | null>(null);
  const boardDragRef = useRef<string | null>(null);
  const [magicBusy, setMagicBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [openArtOk, setOpenArtOk] = useState<boolean | null>(null);
  const [openArtModels, setOpenArtModels] = useState<OpenArtModelChoice[]>([]);
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
  // Latest production kept in a ref (updated every render) so effect-registered
  // listeners — the Ctrl+V paste handlers — never write stale field state back
  // over newer saves (e.g. dismissing a suggestion, then pasting an image used
  // to resurrect the dismissed suggestion from the stale closure).
  const prodRef = useRef<Production | null>(prod);
  prodRef.current = prod;

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
  // the board cache-buster and reload the production so the updated frame shows.
  useEffect(() => {
    const off = window.cascade.onBoardExternalUpdate(async (e) => {
      if (prod?.meta.id && e.productionId !== prod.meta.id) return;
      setBoardBust((b) => b + 1);
      try {
        const next = await window.cascade.loadProduction(e.productionId);
        if (next) setProd(next);
      } catch {}
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
  }, [prod?.meta.id, refreshList]);

  // Keep the rename draft in sync when switching productions.
  useEffect(() => { setNameDraft(prod?.meta.name ?? ""); setSource(prod?.scriptSource ?? null); }, [prod?.meta.id]);

  // Step 2 (reference-image generation) + Step 3 (in-app board generation):
  // is the OpenArt MCP server connected, and which models does it expose?
  useEffect(() => {
    if (prod?.currentStep !== 2 && prod?.currentStep !== 3) return;
    let live = true;
    if (prod.currentStep === 3) {
      window.cascade.getMcpStatus()
        .then((st) => { if (live) setOpenArtOk(st.some((s) => s.name === "openart" && s.status === "connected")); })
        .catch(() => { if (live) setOpenArtOk(null); });
    }
    window.cascade.listOpenArtModels()
      .then((m) => { if (live) setOpenArtModels(m); })
      .catch(() => { if (live) setOpenArtModels([]); });
    return () => { live = false; };
  }, [prod?.meta.id, prod?.currentStep]);

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
  // boardBust/promptShotId deps alone miss it).
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
  useEffect(() => {
    if (!promptShotId) return;
    let live = true;
    void promptSaveQueue.current.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const next = await window.cascade.getBoardPrompt(prod?.meta.id ?? "", promptShotId);
        if (next != null) {
          if (live) {
            // While the user is typing in this shot's editor, never clobber the
            // live value: a just-fired save changes focusedSig, re-runs this
            // effect, and a round-tripped (normalized) string would reset the
            // textarea's DOM value and yank the caret to the end.
            const el = document.activeElement;
            if (el instanceof HTMLTextAreaElement
              && (el.classList.contains("prod-board-prompt") || el.classList.contains("prod-prompt-drawer-text"))) return;
            promptCacheRef.current[promptShotId] = next; setFocusedPrompt(next);
          }
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
    }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardBust, promptShotId, prod?.meta.id, focusedSig]);

  async function pickFolder() {
    const dir = await window.cascade.pickProductionFolder();
    if (dir) {
      setNewFolder(dir);
      if (!newName.trim()) setNewName(dir.split(/[\\/]/).filter(Boolean).pop() ?? "");
    }
  }

  async function create() {
    if (!newFolder) { setErr("Choose a production folder first."); return; }
    setCreating(true); setErr(null);
    try {
      const p = await window.cascade.createProduction(newName, newFolder);
      setProd(p);
      setNewName(""); setNewFolder(null);
      await refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setCreating(false);
    }
  }

  async function open(id: string) {
    setErr(null);
    try {
      const p = await window.cascade.loadProduction(id);
      if (p) { setProd(p); setLog([]); await refreshList(); }
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  async function remove(id: string) {
    try { await window.cascade.removeProduction(id, "delete"); } catch { return; }
    if (prod?.meta.id === id) setProd(null);
    await refreshList();
  }

  function close() {
    setProd(null);
    void refreshList();
  }

  /** Apply a mutation promise coming back from main with fresh state. */
  const apply = useCallback((p: Promise<Production>) => {
    setBusy(true); setErr(null);
    p.then((next) => { setProd(next); void refreshList(); })
      .catch((e) => setErr(String(e).replace(/^Error:\s*/, "")))
      .finally(() => setBusy(false));
  }, [refreshList]);

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
   *  saved into the production's referencesDir on disk (imagePath), not inline. */
  async function attachArtwork(kind: "characters" | "products", id: string) {
    if (!prod) return;
    const dataUrl = await window.cascade.pickReferenceImage();
    if (!dataUrl) return;
    const item = prod[kind].find((c) => c.id === id);
    const imagePath = await persistRefImage(dataUrl, item?.name ?? kind);
    saveField({ [kind]: prod[kind].map((c) => (c.id === id ? { ...c, imagePath, artwork: undefined } : c)) } as Partial<Production>);
  }
  function removeArtwork(kind: "characters" | "products", id: string) {
    if (!prod) return;
    const item = prod[kind].find((c) => c.id === id);
    if (item?.imagePath) void window.cascade.removeReferenceFile(prod.meta.id, item.imagePath).catch(() => {});
    saveField({ [kind]: prod[kind].map((c) => (c.id === id ? { ...c, artwork: undefined, imagePath: undefined } : c)) } as Partial<Production>);
  }

  /** Add a brand-new custom reference (materials, textures, hero props). */
  async function addRef(name: string, categoryId?: string, artwork?: string) {
    if (!prod || !name.trim()) return;
    const imagePath = artwork ? await persistRefImage(artwork, name) : undefined;
    saveField({ references: [...(prod.references ?? []), { id: uid("ref"), name: name.trim(), categoryId, imagePath, shotIds: [] }] });
  }
  function removeRef(id: string) {
    if (!prod) return;
    const ref = (prod.references ?? []).find((r) => r.id === id);
    if (ref?.imagePath) void window.cascade.removeReferenceFile(prod.meta.id, ref.imagePath).catch(() => {});
    if (ref?.mediaPath) void window.cascade.removeReferenceFile(prod.meta.id, ref.mediaPath).catch(() => {});
    saveField({ references: (prod.references ?? []).filter((r) => r.id !== id) });
  }
  /** Rename a custom reference in place. */
  function updateRef(id: string, patch: Partial<{ name: string }>) {
    if (!prod) return;
    saveField({ references: (prod.references ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  }
  async function attachRefArtwork(id: string) {
    if (!prod) return;
    const dataUrl = await window.cascade.pickReferenceImage();
    if (!dataUrl) return;
    const ref = (prod.references ?? []).find((r) => r.id === id);
    const imagePath = await persistRefImage(dataUrl, ref?.name ?? "reference");
    saveField({ references: (prod.references ?? []).map((r) => (r.id === id ? { ...r, imagePath, artwork: undefined } : r)) });
  }
  function removeRefArtwork(id: string) {
    if (!prod) return;
    const ref = (prod.references ?? []).find((r) => r.id === id);
    if (ref?.imagePath) void window.cascade.removeReferenceFile(prod.meta.id, ref.imagePath).catch(() => {});
    saveField({ references: (prod.references ?? []).map((r) => (r.id === id ? { ...r, artwork: undefined, imagePath: undefined } : r)) });
  }

  /** Step 2: generate or AI-edit a reference image via OpenArt. The modal
   *  stays open (and shows errors) until the call succeeds. */
  async function runRefGen(opts: ReferenceImageGenOptions) {
    if (!prod) return;
    setErr(null);
    const next = await window.cascade.generateReferenceImage(prod.meta.id, opts);
    setProd(next);
    void refreshList();
  }
  /** Step 2: generate a character-sheet reference via OpenArt (the character
   *  is created/updated with the finished sheet). */
  async function runCharacterGen(opts: CharacterSheetGenOptions) {
    if (!prod) return;
    setErr(null);
    const next = await window.cascade.generateCharacterSheet(prod.meta.id, opts);
    setProd(next);
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
  function setStyle(idx: number, patch: Partial<{ name: string; prompt: string; index: number }>) {
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
        styles: [...(prod.styles ?? []), { id: uid("style"), index: (prod.styles?.length ?? 0) + 1, name: style.name, prompt: style.prompt }],
      });
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setStyleImgBusy(false);
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

  /** Create a pasted image as a new reference with an auto-generated name (Ref-001…). */
  async function createReferenceFromFile(file: File, forcedName?: string) {
    if (!prodRef.current) return;
    if (file.size > 15 * 1024 * 1024) {
      setErr("That image is larger than 15 MB — use a smaller one.");
      return;
    }
    if (!file.type.startsWith("image/")) {
      setErr(`${file.name}: not an image file.`);
      return;
    }
    const name = forcedName ?? nextRefName();
    let dataUrl: string;
    try {
      dataUrl = await fileToDataUrl(file);
    } catch {
      setErr("Couldn't read the pasted image.");
      return;
    }
    const imagePath = await persistRefImage(dataUrl, name);
    if (!imagePath) { setErr("Couldn't save the pasted image."); return; }
    saveField({ references: [...(prodRef.current?.references ?? []), { id: uid("ref"), name, imagePath, shotIds: [] }] });
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

  // Node graph: Ctrl+V with an image creates a reference (Ref-001…), same as the Design page.
  useEffect(() => {
    if (!graphShotId) return;
    const onPaste = (e: ClipboardEvent) => {
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
  }, [graphShotId, prod?.references, prod?.meta.id]);

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

  /** Step 3: generate boards for shots missing artwork (or regenerate all). */
  async function genBoards(regenerateAll = false) {
    if (!prod || boardsBusy) return;
    setBoardsBusy(true); setErr(null);
    try {
      const next = await window.cascade.generateBoards(prod.meta.id, { maxShots: boardCap, regenerateAll });
      setProd(next);
      setBoardBust((b) => b + 1);
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
      setBoardBust((b) => b + 1);
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

  /** Step 3: reclaim a shot's frame from an OpenArt job that outlived the
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
      setBoardBust((b) => b + 1);
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
      setBoardBust((b) => b + 1);
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
      setBoardBust((b) => b + 1);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setImportBusy(false);
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

  /** Step 3: pick one shot's render style (stores the style's stable id).
   *  Only the style section of the prompt may change: on an auto-derived
   *  prompt that happens naturally; on a manually edited prompt we swap just
   *  its leading "Style:" paragraph and keep every other edit intact. */
  async function updateShotStyle(shotId: string, styleId: string) {
    if (!prod) return;
    // "None": strip the style section entirely. On an auto-derived prompt we
    // manualize it (with the Style paragraph removed) so the master style
    // doesn't sneak back on the next derive — the equivalent of dragging the
    // style link off in the node graph.
    if (!styleId) {
      const target = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
      if (!target) return;
      const base = target.promptManual && target.prompt?.trim()
        ? target.prompt
        : await window.cascade.getBoardPrompt(prod.meta.id, shotId).then((p) => p ?? "").catch(() => "");
      const stripped = base.replace(/(?:^|\n\n)Style:[\s\S]*?(?=\n\n|$)/, "").replace(/\n{3,}/g, "\n\n").trim();
      const next: Production = { ...prod, scenes: prod.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((s) => s.id === shotId ? { ...s, style: undefined, styleNone: true, prompt: stripped, promptManual: true } : s),
      })) };
      setProd(next);
      // Keep the prompt cache in sync so the focused side panel / node graph
      // can't resurrect the removed Style section from a stale cache entry.
      promptCacheRef.current[shotId] = stripped;
      if (promptShotId === shotId) setFocusedPrompt(stripped);
      void window.cascade.saveProduction(next).then(() => refreshList()).catch(() => {});
      return;
    }
    const styleText = (prod.styles ?? []).find((st) => st.id === styleId)?.prompt.trim() ?? "";
    const next: Production = { ...prod, scenes: prod.scenes.map((sc) => ({
      ...sc,
      shots: sc.shots.map((s) => {
        if (s.id !== shotId) return s;
        if (!(s.promptManual && s.prompt?.trim())) return { ...s, style: styleId || undefined, styleNone: false };
        const para = styleText ? `Style: ${styleText}` : "";
        const rest = s.prompt.replace(/(?:^|\n\n)Style:[\s\S]*?(?=\n\n|$)/, "").trim();
        return { ...s, style: styleId || undefined, styleNone: false, prompt: para ? (rest ? `${para}\n\n${rest}` : para) : s.prompt };
      }),
    })) };
    setProd(next);
    const changed = next.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (changed?.prompt != null) promptCacheRef.current[shotId] = changed.prompt;
    if (promptShotId === shotId) setFocusedPrompt(changed?.prompt ?? "");
    void window.cascade.saveProduction(next).then(async () => {
      await refreshList();
      if (promptShotId === shotId) {
        const updated = await window.cascade.getBoardPrompt(next.meta.id, shotId);
        if (updated != null) setFocusedPrompt(updated);
      }
    }).catch(() => {});
  }

  /** Node-graph style picker: updates the shot's style field and, like the
   *  classic board's style dropdown, rewrites the Style paragraph in any prompt
   *  that is currently plugged — the connection itself is unchanged, only the
   *  text is refreshed. Plugged state is tracked via graphStyleConnected flags
   *  so switching to "None" removes the paragraph but keeps the edge. */
  function setGraphStyle(shotId: string, styleId: string) {
    if (!prod) return;
    const styleText = (prod.styles ?? []).find((st) => st.id === styleId)?.prompt.trim() ?? "";
    const target = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!target) return;
    // Use the latest prompt string (including unsaved tag drags) as the
    // base, not the stale on-disk `target.prompt`. The prompt cache holds
    // the most recent composed prompt for the focused shot (side panel or
    // graph), and focusedPrompt is the live value for that shot.
    const basePrompt = promptCacheRef.current[shotId] ?? target.prompt;
    const isPlugged = (flag: boolean | undefined, cur: string | undefined) => flag ?? /^Style:/m.test(cur ?? "");
    // Choosing a style rewrites the paragraph only when the edge is plugged;
    // "None" strips it from any prompt that carries one, plugged or not — a
    // leftover/detached edge must never keep the paragraph alive.
    const rewritePlugged = (cur: string | undefined, plugged: boolean | undefined): string | undefined => {
      if (cur == null) return cur;
      if (!styleText) return /^Style:/m.test(cur) ? removeStyleParagraph(cur) : cur;
      if (!isPlugged(plugged, cur)) return cur;
      return addStyleParagraph(cur, styleText);
    };
    // For the image prompt we preserve the classic manual/auto distinction
    let nextPrompt: string | undefined = basePrompt;
    let nextManual = target.promptManual;
    // If the base came from the cache (which is always a full prompt string
    // with Style/Content/Brand), treat it as manual for the purpose of
    // rewriting — otherwise a cached auto-derived prompt would be mistaken
    // for non-manual and we'd create a prompt with only Style and no content.
    const baseIsManual = target.promptManual || !!promptCacheRef.current[shotId];
    if (baseIsManual && basePrompt?.trim() && (isPlugged(target.graphStyleConnected, basePrompt) || !styleText)) {
      nextPrompt = styleText ? addStyleParagraph(basePrompt, styleText) : removeStyleParagraph(basePrompt);
      nextManual = true;
    } else if (!target.promptManual && target.graphStyleConnected && styleText) {
      if (!/^Style:/m.test(basePrompt ?? "")) nextPrompt = addStyleParagraph(basePrompt ?? "", styleText);
    }
    const nextVideo = rewritePlugged(target.graphVideoPrompt, target.graphVideoStyleConnected);
    const nextEdit = rewritePlugged(target.graphEditPrompt, target.graphEditStyleConnected);
    const patch: Partial<ProductionShot> = { style: styleId || undefined, styleNone: !styleId };
    if (nextPrompt !== target.prompt) { patch.prompt = nextPrompt; patch.promptManual = nextManual; }
    if (nextVideo !== target.graphVideoPrompt) patch.graphVideoPrompt = nextVideo;
    if (nextEdit !== target.graphEditPrompt) patch.graphEditPrompt = nextEdit;
    saveField({
      scenes: prod.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((s) => s.id === shotId ? { ...s, ...patch } : s),
      })),
    });
    if (nextPrompt !== basePrompt) {
      // Keep both side-panel and graph prompt caches in sync — the graph's
      // prompt is also `focusedPrompt` (shared), so either shot being
      // focused should update the live prompt.
      if (promptShotId === shotId || graphShotId === shotId) {
        setFocusedPrompt(nextPrompt ?? "");
      }
      if (nextPrompt != null) promptCacheRef.current[shotId] = nextPrompt;
    }
  }


  /** Create/reuse a reference, optionally recording its shot association.
 *  Returns the new references array (undefined when the production is gone). */
  function upsertReference(name: string, ref: { artwork?: string; imagePath?: string; media?: "video" | "audio"; mediaPath?: string }, shotId?: string): Production["references"] | undefined {
    if (!prod) return undefined;
    const existing = (prod.references ?? []).find((r) => r.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) {
      return (prod.references ?? []).map((r) => r.id === existing.id ? {
        ...r,
        artwork: r.artwork ?? ref.artwork,
        imagePath: r.imagePath ?? ref.imagePath,
        media: r.media ?? ref.media,
        mediaPath: r.mediaPath ?? ref.mediaPath,
        ...(shotId ? { shotIds: Array.from(new Set([...(r.shotIds ?? []), shotId])) } : {}),
      } : r);
    }
    return [...(prod.references ?? []), { id: uid("ref"), name, artwork: ref.artwork, imagePath: ref.imagePath, media: ref.media, mediaPath: ref.mediaPath, ...(shotId ? { shotIds: [shotId] } : {}) }];
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
      // board-refresh effect (boardBust) may not have fired yet.
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
   *  explicit socket action. */
  function saveRefOnly(name: string, ref: { artwork?: string; imagePath?: string; media?: "video" | "audio"; mediaPath?: string }): void {
    if (!prod) return;
    const references = upsertReference(name, ref);
    if (references) saveField({ references });
  }

  /** Save a dropped/picked reference image (inline data URL) into the
   *  production's referencesDir on disk and return its workspace-relative
   *  path — image references live as files, not JSON data URLs. */
  async function persistRefImage(dataUrl: string, baseName: string): Promise<string | undefined> {
    if (!prod) return undefined;
    try {
      const res = await window.cascade.addReferenceImage(prod.meta.id, `${baseName}.png`, dataUrl);
      return res?.path;
    } catch {
      return undefined;
    }
  }

  /** Step 3: a completed frame dragged onto another frame becomes a reference
   *  and is tagged at the end of the destination prompt. */
  async function dropFrameAsReference(shotId: string, source: { prodId: string; shotId: string; number: number }) {
    if (!prod) return;
    try {
      const dataUrl = await window.cascade.boardImage(source.prodId, source.shotId);
      if (!dataUrl) { setErr("Couldn't load the dropped frame."); return; }
      const imagePath = await persistRefImage(dataUrl, `Frame ${String(source.number).padStart(4, "0")}`);
      await attachReferenceToPrompt(shotId, `Frame ${String(source.number).padStart(4, "0")}`, { imagePath });
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  /** Step 3: any image/video/audio dropped into the node graph automatically
   *  becomes a reference: all files are written into the production's
   *  referencesDir on disk. The reference is NOT tagged into the prompt —
   *  connecting it to the prompt node is an explicit socket action. */
  async function addFileReference(shotId: string, file: File) {
    if (!prod) return;
    const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : null;
    if (!kind) { setErr(`${file.name}: not an image, video, or audio file.`); return; }
    const name = file.name.trim().replace(/\.[^.]+$/, "").replace(/\s+/g, " ").slice(0, 60) || "Dropped reference";
    try {
      if (kind === "image") {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => { if (typeof reader.result === "string") resolve(reader.result); else reject(reader.error ?? new Error("Couldn't read the file.")); };
          reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."));
          reader.readAsDataURL(file);
        });
        const imagePath = await persistRefImage(dataUrl, name);
        if (!imagePath) { setErr("Couldn't save the dropped image."); return; }
        saveRefOnly(name, { imagePath });
      } else {
        const saved = await window.cascade.addReferenceMedia(prod.meta.id, file.name, file.type, await file.arrayBuffer());
        if (!saved) { setErr("Couldn't save the dropped media file."); return; }
        saveRefOnly(name, { media: saved.kind, mediaPath: saved.path });
      }
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
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
        if (latestPromptRef.current[shotId] === prompt) setProd(next);
      } catch (e) {
        setErr(String(e).replace(/^Error:\s*/, ""));
      }
    });
    await promptSaveQueue.current;
  }

  function focusPrompt(shotId: string, _prompt: string) {
    setPromptShotId(shotId);
    setFocusedPrompt(promptCacheRef.current[shotId] ?? "");
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
    if (!prod) return;
    saveField({ scenes: prod.scenes.map((sc) => ({ ...sc, shots: sc.shots.map((s) => s.id === shotId ? { ...s, ...patch } : s) })) });
  }

  /** Step 3 node graph: make a generation node's selected output the shot's
   *  primary output (artwork / videoPath). */
  async function applyGraphOutput(shotId: string, kind: "image" | "video", path: string) {
    if (!prod) return;
    try {
      const next = await window.cascade.applyGraphOutput(prod.meta.id, shotId, { kind, path });
      setProd(next);
      setBoardBust((b) => b + 1);
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
  }

  /** Step 3 node graph: pipe the image node's output into the video node's
   *  image input. Independent of the output feed — both can be wired at once. */
  function pipeImageToVideo(shotId: string) {
    if (!prod) return;
    saveGraphShotFields(shotId, { graphImageToVideo: true });
  }

  /** Step 3 node graph: unpin the image node from the video node's image
   *  input (the output feed, if any, is untouched). */
  function unpipeImageToVideo(shotId: string) {
    if (!prod) return;
    saveGraphShotFields(shotId, { graphImageToVideo: undefined });
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
      ...(path ? {} : { artwork: undefined }),
    });
    if (path) void applyGraphOutput(shotId, "image", path);
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
      setBoardBust((b) => b + 1);
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
    saveGraphShotFields(shotId, {
      graphImageToVideo: undefined,
      graphEditImageSource: undefined,
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

  /** Step 3 node graph: pipe the edit-image node's output into the output —
   *  binds it as the feed and applies its currently selected edit. The
   *  storyboard mirrors the output node: a leftover video path is cleared, and
   *  an empty edit node leaves the frame blank. */
  function pipeEditToOutput(shotId: string) {
    if (!prod) return;
    const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    const path = shot.graphEditGens?.[shot.graphEditGenIndex ?? 0]?.path;
    saveGraphShotFields(shotId, {
      graphOutputSource: "editgen",
      graphOutputRefId: undefined,
      videoPath: undefined,
      ...(path ? {} : { artwork: undefined }),
    });
    if (path) void applyGraphOutput(shotId, "image", path);
  }

  /** Step 3 node graph: unbind the edit-image node's output feed (the edited
   *  frame lives in the node's history; the storyboard goes blank until a
   *  generation is piped back in). */
  function unpipeEditGen(shotId: string) {
    if (!prod) return;
    const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    if (shot.graphOutputSource === "editgen") saveGraphShotFields(shotId, { graphOutputSource: undefined, artwork: undefined });
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
  async function runImageGenNode(shotId: string, model: string, resolution: string) {
    if (!prod) return;
    setErr(null);
    try {
      const next = await window.cascade.generateFrameNode(prod.meta.id, shotId, { prompt: focusedPrompt, model, resolution });
      setProd(next);
      setBoardBust((b) => b + 1);
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
  }

  /** Step 3 node graph: run the video generation node (prompt = the
   *  video-prompt node; source = piped frame or the shot's frame). */
  async function runVideoGenNode(shotId: string, model: string, resolution: string, durationSec: number) {
    if (!prod) return;
    setErr(null);
    try {
      const cur = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
      const sourcePath = cur?.graphImageToVideo ? cur.graphImageGens?.[cur.graphImageGenIndex ?? 0]?.path : undefined;
      const next = await window.cascade.generateVideoNode(prod.meta.id, shotId, { prompt: cur?.graphVideoPrompt ?? VIDEO_PROMPT_DEFAULT, model, resolution, durationSec, sourcePath, refIds: cur?.graphVideoRefIds ?? [] });
      setProd(next);
      setBoardBust((b) => b + 1);
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
  }

  /** Step 3 node graph: AI-edit an image for the edit-image node (prompt = the
   *  edit-prompt node; source = piped frame/ref or the shot's frame). */
  async function runEditGenNode(shotId: string, model: string, resolution: string) {
    if (!prod) return;
    setErr(null);
    try {
      const cur = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
      const next = await window.cascade.generateEditNode(prod.meta.id, shotId, { prompt: cur?.graphEditPrompt ?? "", model, resolution });
      setProd(next);
      setBoardBust((b) => b + 1);
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
  }

  /** Step 3 node graph: select a generation node's stored output by index;
   *  the piped node's selection becomes the shot's primary output. */
  function selectGraphGen(shotId: string, kind: "image" | "video" | "edit", index: number) {
    if (!prod) return;
    const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    const items = kind === "image" ? shot.graphImageGens : kind === "video" ? shot.graphVideoGens : shot.graphEditGens;
    if (!items || !items[index]) return;
    saveGraphShotFields(shotId, kind === "image" ? { graphImageGenIndex: index } : kind === "video" ? { graphVideoGenIndex: index } : { graphEditGenIndex: index });
    const bound = kind === "image" ? shot.graphOutputSource === "imagegen" : kind === "video" ? shot.graphOutputSource === "videogen" : shot.graphOutputSource === "editgen";
    if (bound) void applyGraphOutput(shotId, kind === "video" ? "video" : "image", items[index].path);
  }

  /** Step 3 node graph: cycle a generation node's stored outputs; the piped
   *  node's selection becomes the shot's primary output. */
  function cycleGraphGen(shotId: string, kind: "image" | "video" | "edit", dir: 1 | -1) {
    if (!prod) return;
    const shot = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!shot) return;
    const items = kind === "image" ? shot.graphImageGens : kind === "video" ? shot.graphVideoGens : shot.graphEditGens;
    if (!items || items.length === 0) return;
    const cur = (kind === "image" ? shot.graphImageGenIndex : kind === "video" ? shot.graphVideoGenIndex : shot.graphEditGenIndex) ?? 0;
    selectGraphGen(shotId, kind, (cur + dir + items.length) % items.length);
  }

  /** Step 3: persist the node graph's canvas state for a shot (node positions
   *  and/or viewport), merged into whatever was saved before. */
  function saveGraphLayout(shotId: string, layout: GraphLayout) {
    if (!prod) return;
    saveField({
      scenes: prod.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((s) => s.id === shotId ? { ...s, graphLayout: { ...s.graphLayout, ...layout } } : s),
      })),
    });
  }

  async function setBrandForShot(shotId: string, include: boolean) {
    if (!prod) return;
    const target = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
    if (!target) return;
    const basePrompt = promptCacheRef.current[shotId] ?? target.prompt;
    let prompt = basePrompt?.trim() ?? "";
    // Manual prompts carry their own Brand paragraph: physically add/remove
    // it so the toggle is real — OFF strips it, ON inserts the freshly
    // generated clause (picking up current wording). Auto-derived prompts
    // handle the flag at derive time.
    if (target.promptManual && prompt) {
      if (!include) {
        prompt = stripBrandParagraph(prompt);
      } else if (!hasBrandParagraph(prompt)) {
        const clause = brandClause(prod);
        if (clause) prompt = insertBrandParagraph(prompt, clause);
      }
    }
    const next: Production = { ...prod, scenes: prod.scenes.map((sc) => ({ ...sc, shots: sc.shots.map((s) => s.id === shotId ? { ...s, includeBrandIdentity: include, ...(target.promptManual ? { prompt } : {}) } : s) })) };
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
  async function runBoardEdit(shotId: string, model: string, prompt: string) {
    if (!prod || editBusyIds.includes(shotId)) return;
    setEditBusyIds((ids) => [...ids, shotId]);
    setErr(null);
    try {
      const next = await window.cascade.editBoard(prod.meta.id, shotId, model, prompt);
      setProd(next);
      setBoardBust((b) => b + 1);
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
      const next = await window.cascade.generateVideo(prod.meta.id, shotId, opts);
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
  async function promoteHistory(shotId: string, index: number) {
    if (!prod) return;
    setErr(null);
    try {
      const next = await window.cascade.promoteBoardHistory(prod.meta.id, shotId, index);
      setProd(next);
      setBoardBust((b) => b + 1);
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
    setBoardBust((b) => b + 1);
    setBoardDragId(null);
    setBoardDropTarget(null);
    boardDragRef.current = null;
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
            {newFolder && <span className="prod-folder-hint" title={newFolder}>{newFolder}</span>}
            <button className="primary" disabled={creating || !newFolder} onClick={() => void create()}>
              {creating ? "Creating…" : "Create"}
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
                <button className="prod-card-remove" title="Remove from Cascade (files on disk are untouched)" onClick={() => void remove(m.id)}>×</button>
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
  const imageModels = openArtModels.filter((m) => m.imageInput);
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
          <span className="prod-step-title">Expenses</span>
        </button>
      </nav>

      <div className="prod-body">
        {showExpenses ? (
          <ExpensesPanel />
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
                      </div>
                      <button
                        className="prod-style-wand"
                        title="Refine this style's prompt via the model"
                        disabled={refiningStyleId !== null || !s.prompt.trim()}
                        onClick={() => void refineStyle(s.id)}
                      >
                        {refiningStyleId === s.id ? "…" : "✨"}
                      </button>
                      <button className="prod-style-remove" title="Remove this style" onClick={() => removeStyle(i)}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="prod-style-actions">
                <button className="prod-btn" disabled={(prod.styles?.length ?? 0) >= MAX_STYLES} onClick={addStyle}>
                  ＋ Add style
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
                  {styleImgBusy ? "Reading image…" : "🖼 From image…"}
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
                  <button className="prod-brand-add" title="Add a palette swatch" onClick={() => setBrandColor(brandColors.length, "#1A2B3C")}>＋</button>
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
                models={openArtModels}
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
                          <button className="prod-suggestion-remove" title="Dismiss this suggestion" onClick={() => dismissSuggestion(s)}>×</button>
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
                onRename={(id, name) => updateRef(id, { name })}
                onMove={moveReference}
                onGenerate={(categoryId) => setRefGen({ categoryId })}
                onEditRef={(ref) => setRefGen({ refId: ref.id })}
              />
            </DesignSection>

            {refGen && (
              <RefGenModal
                prodId={prod.meta.id}
                models={openArtModels}
                categories={prod.referenceCategories ?? []}
                references={prod.references ?? []}
                promptRefs={allPromptRefs(prod)}
                defaultCategoryId={refGen.categoryId}
                initialRefId={refGen.refId}
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
                  onClick={() => {
                    if (!prod) return;
                    if (prod.magicEnabled) {
                      setMagicBusy(true); setErr(null);
                      void window.cascade.setMagicEnabled(prod.meta.id, false).then((next) => {
                        setProd(next); setBoardBust((b) => b + 1); void refreshList();
                        if (promptShotId) void window.cascade.getBoardPrompt(next.meta.id, promptShotId).then((p) => { if (p != null) { promptCacheRef.current[promptShotId] = p; setFocusedPrompt(p); } });
                      }).catch((e) => setErr(String(e).replace(/^Error:\s*/, ""))).finally(() => setMagicBusy(false));
                    } else if (prod.magicPrompts && Object.keys(prod.magicPrompts).length) {
                      setMagicBusy(true); setErr(null);
                      void window.cascade.setMagicEnabled(prod.meta.id, true).then((next) => {
                        setProd(next); setBoardBust((b) => b + 1); void refreshList();
                        if (promptShotId) void window.cascade.getBoardPrompt(next.meta.id, promptShotId).then((p) => { if (p != null) { promptCacheRef.current[promptShotId] = p; setFocusedPrompt(p); } });
                      }).catch((e) => setErr(String(e).replace(/^Error:\s*/, ""))).finally(() => setMagicBusy(false));
                    } else {
                      setMagicBusy(true); setErr(null);
                      void window.cascade.generateMagicPrompts(prod.meta.id).then((next) => {
                        setProd(next); setBoardBust((b) => b + 1); void refreshList();
                        if (promptShotId) void window.cascade.getBoardPrompt(next.meta.id, promptShotId).then((p) => { if (p != null) { promptCacheRef.current[promptShotId] = p; setFocusedPrompt(p); } });
                      }).catch((e) => setErr(String(e).replace(/^Error:\s*/, ""))).finally(() => setMagicBusy(false));
                    }
                  }}
                  title={prod.magicEnabled ? "Disable Magic Prompt — restore original prompts" : "Enable Magic Prompt — AI generates content-only prompts for all shots"}
                >
                  {magicBusy ? "…" : prod.magicEnabled ? "✨ Magic On" : "✨ Magic Prompt"}
                </button>
                {prod.magicEnabled && (
                  <button
                    className="prod-btn prod-magic-refresh"
                    disabled={magicBusy}
                    onClick={() => {
                      if (!prod) return;
                      setMagicBusy(true); setErr(null);
                      void window.cascade.generateMagicPrompts(prod.meta.id).then((next) => {
                        setProd(next); setBoardBust((b) => b + 1); void refreshList();
                        if (promptShotId) void window.cascade.getBoardPrompt(next.meta.id, promptShotId).then((p) => { if (p != null) { promptCacheRef.current[promptShotId] = p; setFocusedPrompt(p); } });
                      }).catch((e) => setErr(String(e).replace(/^Error:\s*/, ""))).finally(() => setMagicBusy(false));
                    }}
                    title="Regenerate Magic Prompts (AI will re-generate all content prompts)"
                  >
                    ↻
                  </button>
                )}
              </div>
            </div>
            <p className="hint">
              One frame per shot — the master style and character keys from Step 2 are baked into every prompt.
              Frames are saved to <code>{prod.assets.boardsDir}/</code> in the production folder.
              {openArtOk === true && " In-app generation uses the connected OpenArt MCP server."}
              {openArtOk === false && (
                <> OpenArt MCP isn't connected, so use <strong>Export prompts</strong> to generate frames externally.</>
              )}
            </p>
            <div className="prod-boards-controls">
              <label className="prod-openart-label">Model
                <select
                  className="prod-openart-select"
                   value={imageModels.some((m) => m.id === prod.openArt?.model) ? prod.openArt?.model : "auto"}
                  onChange={(e) => saveField({ openArt: { model: e.target.value, resolution: prod.openArt?.resolution ?? "1k" } })}
                  title="OpenArt model for in-app generation (Auto lets Cascade choose)"
                >
                  <option value="auto">Auto</option>
                  {imageModels.map((m) => (
                    <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>
                  ))}
                </select>
              </label>
              <label className="prod-openart-label">Resolution
                <select
                  className="prod-openart-select"
                  value={prod.openArt?.resolution ?? "1k"}
                  onChange={(e) => saveField({ openArt: { model: prod.openArt?.model ?? "auto", resolution: e.target.value as "1k" | "2k" | "4k" } })}
                  title="Output resolution for image generation"
                >
                  <option value="1k">1k</option>
                  <option value="2k">2k</option>
                  <option value="4k">4k</option>
                </select>
              </label>
              <button className="primary" disabled={boardsBusy || importBusy || !shotCount} onClick={() => void genBoards(false)}>
                {boardsBusy ? "Generating…" : boardsDone ? "Generate missing frames" : "Generate Storyboard"}
              </button>
              {boardsDone > 0 && (
                <button disabled={boardsBusy || importBusy} onClick={() => void genBoards(true)}>
                  Regenerate all
                </button>
              )}
              <label className="prod-boards-cap">
                Cap
                <input
                  type="number" min={1} max={200} value={boardCap}
                  onChange={(e) => setBoardCap(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
                  title="Max frames per run (image generation is expensive)"
                />
              </label>
              <span className="prod-boards-sep" />
              <button disabled={boardsBusy || importBusy || !shotCount} onClick={() => void exportPrompts()} title={`Write every shot's prompt to ${prod.assets.boardsDir}/prompts.md`}>
                Export prompts
              </button>
              <span className="hint">{boardsDone}/{shotCount} shots have frames</span>
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
                {prod.scenes.flatMap((sc) => sc.shots).map((shot) => (
                  <BoardCard
                    key={shot.id}
                    prod={prod}
                    shot={shot}
                    bust={boardBust}
                    regenerating={regenIds.has(shot.id) || editBusyIds.includes(shot.id)}
                    videoBusy={videoBusyIds.includes(shot.id)}
                    pending={!!shot.pendingImageGen}
                    rechecking={recheckIds.has(shot.id)}
                    onRegenerate={() => void regenBoard(shot.id)}
                    onRecheck={() => void recheckBoard(shot.id)}
                    onImport={() => void importFrames(shot.id)}
                    onEdit={() => setEditShotId(shot.id)}
                    onVideo={() => setVideoShotId(shot.id)}
                    onStyleChange={(style) => updateShotStyle(shot.id, style)}
                    onPromptFocus={focusPrompt}
                    selected={promptShotId === shot.id}
                    onDropFrame={(source) => void dropFrameAsReference(shot.id, source)}
                    onPromoteHistory={(index) => void promoteHistory(shot.id, index)}
                    draggable
                    isDragging={boardDragId === shot.id}
                    isReorderTarget={boardDropTarget === shot.id}
                    onReorderDragStart={(id, e) => {
                      boardDragRef.current = id;
                      setBoardDragId(id);
                      e.dataTransfer.setData("application/x-cascade-shot-order", id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onReorderDragOver={(id) => {
                      if (boardDropTarget !== id) setBoardDropTarget(id);
                    }}
                    onReorderDragEnd={() => {
                      setBoardDropTarget(null);
                      setTimeout(() => {
                        if (boardDragRef.current) {
                          setBoardDragId(null);
                          boardDragRef.current = null;
                        }
                      }, 0);
                    }}
                    onReorderDrop={(targetId) => {
                      const src = boardDragRef.current;
                      setBoardDropTarget(null);
                      setBoardDragId(null);
                      boardDragRef.current = null;
                      if (!src || src === targetId) return;
                      reorderShot(src, targetId);
                    }}
                  />
                ))}
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
                shotNumber={prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === promptShotId)?.number}
                value={focusedPrompt}
                includeBrand={prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === promptShotId)?.includeBrandIdentity !== false}
                scriptVisual={prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === promptShotId)?.visual}
                scriptAudio={prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === promptShotId)?.audio}
                references={promptShotId ? promptRefsForShot(prod, promptShotId) : []}
                onChange={(value) => { setFocusedPrompt(value); if (promptShotId) { promptCacheRef.current[promptShotId] = value; void saveShotPrompt(promptShotId, value); } }}
                onToggleBrand={(include) => { if (promptShotId) void setBrandForShot(promptShotId, include); }}
                onSubmit={() => { if (promptShotId) void regenBoard(promptShotId); }}
                submitting={!!promptShotId && regenIds.has(promptShotId)}
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
                  bust={boardBust}
                  prompt={focusedPrompt}
                  references={promptRefsForShot(prod, graphShotId)}
                  styles={prod.styles ?? []}
                  styleValue={shotStyleSelectValue(gs, prod)}
                  includeBrand={gs.includeBrandIdentity !== false}
                  initialLayout={gs.graphLayout}
                  onPromptChange={(value) => { setFocusedPrompt(value); if (graphShotId) { promptCacheRef.current[graphShotId] = value; void saveShotPrompt(graphShotId, value); } }}
                  onStyleChange={(style) => setGraphStyle(graphShotId!, style)}
                  onToggleBrand={(include) => { if (graphShotId) void setBrandForShot(graphShotId, include); }}
                  onDropFile={(file) => { if (graphShotId) void addFileReference(graphShotId, file); }}
                  onStyleDetached={() => { if (graphShotId) detachGraphStyle(graphShotId); }}
                  imageModels={imageModels}
                  videoModels={openArtModels.filter((m) => m.videoInput)}
                  defaultImageModel={prod.openArt?.model ?? "auto"}
                  defaultImageResolution={prod.openArt?.resolution ?? "1k"}
                  onRunImageGen={(model, resolution) => graphShotId ? runImageGenNode(graphShotId, model, resolution) : Promise.resolve()}
                  onRunVideoGen={(model, resolution, durationSec) => graphShotId ? runVideoGenNode(graphShotId, model, resolution, durationSec) : Promise.resolve()}
                  onRunEditGen={(model, resolution) => graphShotId ? runEditGenNode(graphShotId, model, resolution) : Promise.resolve()}
                  onSelectGraphGen={(kind, index) => { if (graphShotId) selectGraphGen(graphShotId, kind, index); }}
                  onCycleGraphGen={(kind, dir) => { if (graphShotId) cycleGraphGen(graphShotId, kind, dir); }}
                  onGraphField={(patch) => { if (graphShotId) saveGraphShotFields(graphShotId, patch); }}
                  onPipeImageToVideo={() => { if (graphShotId) pipeImageToVideo(graphShotId); }}
                  onPipeImageToOutput={() => { if (graphShotId) pipeImageToOutput(graphShotId); }}
                  onPipeVideoToOutput={() => { if (graphShotId) pipeVideoToOutput(graphShotId); }}
                  onPipeEditToOutput={() => { if (graphShotId) pipeEditToOutput(graphShotId); }}
                  onPipeRefToOutput={(refId) => { if (graphShotId) void pipeRefToOutput(graphShotId, refId); }}
                  onUnpipeImageGen={() => { if (graphShotId) unpipeImageGen(graphShotId); }}
                  onUnpipeImageToVideo={() => { if (graphShotId) unpipeImageToVideo(graphShotId); }}
                  onUnpipeVideoGen={() => { if (graphShotId) unpipeVideoGen(graphShotId); }}
                  onUnpipeEditGen={() => { if (graphShotId) unpipeEditGen(graphShotId); }}
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
                  models={openArtModels}
                  prompt={es.graphEditPrompt ?? ""}
                  onPromptChange={(text) => saveGraphShotFields(es.id, { graphEditPrompt: text })}
                  onSubmit={(model, prompt) => {
                    const id = editShotId;
                    setEditShotId(null); // close immediately; edit runs in background
                    if (id) void runBoardEdit(id, model, prompt);
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
                  models={openArtModels}
                  prompt={vs.graphVideoPrompt ?? VIDEO_PROMPT_DEFAULT}
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
                            <button className="prod-suggestion-remove" title="Remove the voiceover" onClick={() => void removeVo()}>×</button>
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
                            <button className="prod-suggestion-remove" title="Remove the music track" onClick={() => void removeMusic()}>×</button>
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
              <button className="prod-btn" onClick={() => setVisionWarnModel(null)}>×</button>
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
