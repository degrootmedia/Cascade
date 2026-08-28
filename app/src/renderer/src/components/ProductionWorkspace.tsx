/**
 * Production Assistant workspace: production picker/creator on first entry,
 * then a 5-step pipeline view. Step 1 (script ingestion + shot table) is live;
 * later steps show their planned surface and keep persisted state (style).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Production, ProductionMeta, ProductionShot, OpenArtModelChoice, SuggestedReference, ReferenceCategory, CustomRef, AudioModelInfo, VideoGenOptions, VideoModelOptions } from "../../../shared/ipc.js";
import { ShotTable } from "./ShotTable.js";

/** Hard cap on the Step 2 style set. */
const MAX_STYLES = 5;

/** Animatic timeline: max simultaneously-mounted pooled preview <video>s. */
const VIDEO_POOL_MAX = 12;
/** Animatic timeline: max wheel-zoom multiplier over the fit-to-width scale. */
const ANIMATIC_MAX_ZOOM = 24;

const STEPS: { n: 1 | 2 | 3 | 4 | 5; title: string; desc: string }[] = [
  { n: 1, title: "Script", desc: "PDF / DOCX / Google Doc → two-column shot breakdown" },
  { n: 2, title: "Design", desc: "Master style + character consistency keys" },
  { n: 3, title: "Storyboard", desc: "Board frames per shot" },
  { n: 4, title: "Animatic", desc: "Timed pre-viz timeline" },
  { n: 5, title: "Assembly", desc: "Audio + final render + manifest" },
];

/** Renderer-side stable id for user-created characters/products/references. */
function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Normalize an entered/pasted hex on blur: allow shorthand, fill to 6 hex. */
function normalizeHex(v: string): string {
  const t = String(v).trim().replace(/^#/, "");
  if (!t) return "";
  if (/^[0-9a-fA-F]{3}$/.test(t)) return `#${t.split("").map((c) => c + c).join("").toUpperCase()}`;
  if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t.toUpperCase()}`;
  return String(v).trim(); // not a full color yet — keep what they typed
}

/** True when the text is a complete hex color (3 or 6 digits, optional #). */
function isCompleteHex(v: string): boolean {
  const t = String(v).trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{3}$/.test(t) || /^[0-9a-fA-F]{6}$/.test(t);
}

/** #RGB / #RRGGBB → normalized "#RRGGBB" for the chip preview; "" when invalid. */
function previewHex(v: string): string {
  const t = String(v).trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(t)) return `#${t.split("").map((c) => c + c).join("").toUpperCase()}`;
  return "";
}

/** #RGB / #RRGGBB → { h: 0..360, s: 0..1, v: 0..1 }; null when not valid hex. */
function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
  const t = String(hex).trim().replace(/^#/, "");
  const full = /^[0-9a-fA-F]{6}$/.test(t) ? t
    : /^[0-9a-fA-F]{3}$/.test(t) ? t.split("").map((c) => c + c).join("")
    : null;
  if (!full) return null;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** { h: 0..360, s: 0..1, v: 0..1 } → "#RRGGBB". */
function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const x = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(255 * x).toString(16).padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`.toUpperCase();
}

interface LogLine {
  id: string;
  at: string;
  message: string;
  level: "info" | "error" | "done";
}

export function ProductionWorkspace({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [list, setList] = useState<ProductionMeta[]>([]);
  const [prod, setProd] = useState<Production | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
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
  // Regeneration batches are dispatched via `regenerateBoards` (one shared
  // production → parallel workers → a single save). Overlapping batches would
  // each load/save the whole production and clobber each other, so batches run
  // strictly one at a time; clicks during a run join the next batch.
  const regenRunningRef = useRef(false);
  const regenPendingRef = useRef<string[]>([]);
  const [boardBust, setBoardBust] = useState(0); // cache-buster after (re)generation
  const [importBusy, setImportBusy] = useState(false);
  const [openArtOk, setOpenArtOk] = useState<boolean | null>(null);
  const [openArtModels, setOpenArtModels] = useState<OpenArtModelChoice[]>([]);
  const [audioModels, setAudioModels] = useState<AudioModelInfo[]>([]);
  const [voBusy, setVoBusy] = useState(false);
  const [voUrl, setVoUrl] = useState<string | null>(null);
  const [voDuration, setVoDuration] = useState<number | null>(null);
  const [musicUrl, setMusicUrl] = useState<string | null>(null);
  const [musicBusy, setMusicBusy] = useState(false);
  const [musicPrompt, setMusicPrompt] = useState("");
  const [musicModel, setMusicModel] = useState("auto");
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
  const [promptShotId, setPromptShotId] = useState<string | null>(null);
  const [focusedPrompt, setFocusedPrompt] = useState("");
  const promptSaveQueue = useRef(Promise.resolve());
  const latestPromptRef = useRef<Record<string, string>>({});
  const promptCacheRef = useRef<Record<string, string>>({});

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

  // Keep the rename draft in sync when switching productions.
  useEffect(() => { setNameDraft(prod?.meta.name ?? ""); setSource(prod?.scriptSource ?? null); }, [prod?.meta.id]);

  // Step 3: is the OpenArt MCP server connected (in-app generation possible)?
  useEffect(() => {
    if (prod?.currentStep !== 3) return;
    let live = true;
    window.cascade.getMcpStatus()
      .then((st) => { if (live) setOpenArtOk(st.some((s) => s.name === "openart" && s.status === "connected")); })
      .catch(() => { if (live) setOpenArtOk(null); });
    window.cascade.listOpenArtModels()
      .then((m) => { if (live) setOpenArtModels(m); })
      .catch(() => { if (live) setOpenArtModels([]); });
    return () => { live = false; };
  }, [prod?.meta.id, prod?.currentStep]);

  // Step 4: fetch TTS-capable audio models for the voiceover picker.
  useEffect(() => {
    if (prod?.currentStep !== 4) return;
    let live = true;
    window.cascade.listAudioModels()
      .then((m) => { if (live) setAudioModels(m); })
      .catch(() => { if (live) setAudioModels([]); });
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

  useEffect(() => {
    if (!promptShotId) return;
    let live = true;
    void promptSaveQueue.current.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const next = await window.cascade.getBoardPrompt(prod?.meta.id ?? "", promptShotId);
        if (next != null) {
          if (live) { promptCacheRef.current[promptShotId] = next; setFocusedPrompt(next); }
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
    }).catch(() => {});
    return () => { live = false; };
  }, [boardBust, promptShotId, prod?.meta.id]);

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
    if (!prod || prod.currentStep === n) return;
    const next = { ...prod, currentStep: n };
    setProd(next);
    void window.cascade.saveProduction(next).then(() => refreshList()).catch(() => {});
  }

  function saveField(patch: Partial<Production>) {
    if (!prod) return;
    const next = { ...prod, ...patch };
    setProd(next);
    void window.cascade.saveProduction(next).then(() => refreshList()).catch(() => {});
  }

  /** Mark the current step done and advance to the next one. */
  function goNext() {
    if (!prod) return;
    const n = prod.currentStep;
    const next: Production = { ...prod, status: { ...prod.status, [n]: "done" } };
    if (n < 5) next.currentStep = (n + 1) as Production["currentStep"];
    setProd(next);
    void window.cascade.saveProduction(next).then(() => refreshList()).catch(() => {});
  }

  /** Attach/remove a reference image on a character or product. */
  async function attachArtwork(kind: "characters" | "products", id: string) {
    if (!prod) return;
    const dataUrl = await window.cascade.pickReferenceImage();
    if (!dataUrl) return;
    saveField({ [kind]: prod[kind].map((c) => (c.id === id ? { ...c, artwork: dataUrl } : c)) } as Partial<Production>);
  }
  function removeArtwork(kind: "characters" | "products", id: string) {
    if (!prod) return;
    saveField({ [kind]: prod[kind].map((c) => (c.id === id ? { ...c, artwork: undefined } : c)) } as Partial<Production>);
  }

  /** Add a brand-new custom reference (materials, textures, hero props). */
  function addRef(name: string, categoryId?: string, artwork?: string) {
    if (!prod || !name.trim()) return;
    saveField({ references: [...(prod.references ?? []), { id: uid("ref"), name: name.trim(), categoryId, artwork, shotIds: [] }] });
  }
  function removeRef(id: string) {
    if (!prod) return;
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
    saveField({ references: (prod.references ?? []).map((r) => (r.id === id ? { ...r, artwork: dataUrl } : r)) });
  }
  function removeRefArtwork(id: string) {
    if (!prod) return;
    saveField({ references: (prod.references ?? []).map((r) => (r.id === id ? { ...r, artwork: undefined } : r)) });
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
      const [s, models] = await Promise.all([window.cascade.getSettings(), window.cascade.listModels()]);
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

  /** Step 2: paste an image from the clipboard (Ctrl+V) to generate a style. */
  async function styleFromPastedImage(file: File) {
    if (!prod || styleImgBusy) return;
    if (file.size > 15 * 1024 * 1024) {
      setErr("That image is larger than 15 MB — use a smaller one.");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    await styleFromImageDataUrl(dataUrl);
  }

  // Step 2: while the Design panel is open, Ctrl+V with an image in the
  // clipboard generates a style from it. Text pastes are untouched.
  useEffect(() => {
    if (prod?.currentStep !== 2) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      let file: File | null = null;
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) { file = item.getAsFile(); break; }
      }
      if (!file) return;
      e.preventDefault();
      void styleFromPastedImage(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [prod, styleImgBusy]);

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

  async function deleteBoard(shotId: string) {
    if (!prod) return;
    try {
      const next = await window.cascade.deleteBoardImage(prod.meta.id, shotId);
      setProd(next);
      setBoardBust((b) => b + 1);
      void refreshList();
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, "")); }
  }

  /** Step 4: synthesize one voiceover clip for the whole production. */
  async function generateVo() {
    if (!prod || voBusy) return;
    setVoBusy(true); setErr(null);
    try {
      const next = await window.cascade.generateVoiceover(prod.meta.id);
      setProd(next);
      setAudioBust((n) => n + 1);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setVoBusy(false);
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

  /** Step 4: change the VO model; if the current voice isn't in the new
   *  model's set, fall back to the first available voice. */
  function setVoiceoverModel(model: string) {
    if (!prod) return;
    const m = audioModels.find((am) => am.id === model);
    const allowed = m?.voices ?? [];
    const cur = prod.voiceover;
    const voice = cur && allowed.includes(cur.voice) ? cur.voice : (allowed[0] ?? "alloy");
    saveField({ voiceover: { model, voice } });
  }

  function setVoiceoverConfig(patch: Partial<NonNullable<Production["voiceover"]>>) {
    if (!prod) return;
    const cur = prod.voiceover ?? { model: "auto", voice: audioModels[0]?.voices[0] ?? "alloy" };
    saveField({ voiceover: { ...cur, ...patch } });
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

  /** Step 4: synthesize a background music clip from a text prompt. */
  async function generateMusic() {
    if (!prod || musicBusy) return;
    setMusicBusy(true); setErr(null);
    try {
      const next = await window.cascade.generateMusic(prod.meta.id, { model: musicModel, prompt: musicPrompt });
      setProd(next);
      setMusicUrl(null);
      setAudioBust((n) => n + 1);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setMusicBusy(false);
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
    const styleText = (prod.styles ?? []).find((st) => st.id === styleId)?.prompt.trim() ?? "";
    const next: Production = { ...prod, scenes: prod.scenes.map((sc) => ({
      ...sc,
      shots: sc.shots.map((s) => {
        if (s.id !== shotId) return s;
        if (!(s.promptManual && s.prompt?.trim())) return { ...s, style: styleId || undefined };
        const para = styleText ? `Style: ${styleText}.` : "";
        const rest = s.prompt.replace(/(?:^|\n\n)Style:[\s\S]*?(?=\n\n|$)/, "").trim();
        return { ...s, style: styleId || undefined, prompt: para ? (rest ? `${para}\n\n${rest}` : para) : s.prompt };
      }),
    })) };
    setProd(next);
    if (promptShotId === shotId) {
      const changed = next.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
      setFocusedPrompt(changed?.prompt ?? "");
    }
    void window.cascade.saveProduction(next).then(async () => {
      await refreshList();
      if (promptShotId === shotId) {
        const updated = await window.cascade.getBoardPrompt(next.meta.id, shotId);
        if (updated != null) setFocusedPrompt(updated);
      }
    }).catch(() => {});
  }


  /** Step 3: a completed frame dragged onto another frame becomes a reference
   *  and is tagged at the end of the destination prompt. */
  async function dropFrameAsReference(shotId: string, source: { prodId: string; shotId: string; number: number }) {
    if (!prod) return;
    setErr(null);
    try {
      const dataUrl = await window.cascade.boardImage(source.prodId, source.shotId);
      if (!dataUrl) { setErr("Couldn't load the dropped frame."); return; }
      const num = String(source.number).padStart(4, "0");
      const name = `Frame ${num}`;
      const target = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId);
      if (!target) { setErr("Couldn't find the destination frame."); return; }
      const currentPrompt = target.prompt?.trim() || await window.cascade.getBoardPrompt(prod.meta.id, shotId) || "";
      const existing = (prod.references ?? []).find((r) => r.name.trim().toLowerCase() === name.toLowerCase());
      const tag = `@[${name}]`;
      const prompt = currentPrompt.includes(tag) ? currentPrompt : `${currentPrompt.trim()}\n\n${tag}`.trim();
      if (promptShotId === shotId) setFocusedPrompt(prompt);
      saveField({
        references: existing
          ? (prod.references ?? []).map((r) => r.id === existing.id ? { ...r, artwork: r.artwork ?? dataUrl, shotIds: Array.from(new Set([...(r.shotIds ?? []), shotId])) } : r)
          : [...(prod.references ?? []), { id: uid("ref"), name, artwork: dataUrl, shotIds: [shotId] }],
        scenes: prod.scenes.map((sc) => ({ ...sc, shots: sc.shots.map((s) => s.id === shotId ? { ...s, prompt, promptManual: true } : s) })),
      });
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

  async function setBrandForShot(shotId: string, include: boolean) {
    if (!prod) return;
    const next: Production = { ...prod, scenes: prod.scenes.map((sc) => ({ ...sc, shots: sc.shots.map((s) => s.id === shotId ? { ...s, includeBrandIdentity: include } : s) })) };
    setProd(next);
    try {
      await window.cascade.saveProduction(next);
      const prompt = await window.cascade.getBoardPrompt(next.meta.id, shotId);
      setFocusedPrompt(prompt ?? "");
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
  const boardsDone = prod.scenes.flatMap((s) => s.shots).filter((s) => s.artwork).length;
  const imageModels = openArtModels.filter((m) => m.imageInput);
  const anyTimed = prod.scenes.some((s) => s.shots.some((sh) => sh.durationSec != null));
  const totalRuntime = prod.scenes.flatMap((s) => s.shots).reduce((n, s) => n + (s.durationSec ?? 3), 0);
  // Split the audio model registry by family: VO picker shows TTS models,
  // the music picker shows music models.
  // Voiceover picker shows TTS + sound-effects (Gab's ElevenLabs offering is
  // elevenlabs-sound-effects-v2); the music picker shows music + sound-effects.
  const ttsModels = audioModels.filter((m) => m.kind === "tts" || m.kind === "sfx");
  const musicModels = audioModels.filter((m) => m.kind === "music" || m.kind === "sfx");
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
        {STEPS.map(({ n, title, desc }) => {
          const st = prod.status[n] ?? "todo";
          return (
            <button
              key={n}
              className={"prod-step" + (prod.currentStep === n ? " active" : "") + (st === "done" ? " done" : "")}
              onClick={() => setStep(n)}
              title={desc}
            >
              <span className={"prod-step-dot " + st} />
              <span className="prod-step-num">{n}</span>
              <span className="prod-step-title">{title}</span>
            </button>
          );
        })}
      </nav>

      <div className="prod-body">
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
            <label className="prod-label">Visual styles — up to {MAX_STYLES}</label>
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
                title="Generate a style prompt from an image that captures the look you're after"
              >
                {styleImgBusy ? "Reading image…" : "🖼 From image…"}
              </button>
            </div>
            <p className="hint">You can also paste an image (Ctrl+V) straight into this page while it's open.</p>

            <div className="prod-brand">
              <label className="prod-label">Brand identity — global</label>
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
            </div>

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
              categories={prod.referenceCategories ?? []}
              items={prod.references ?? []}
              onAddCategory={addCategory}
              onRenameCategory={renameCategory}
              onAddReference={addRef}
              onAttach={(id) => void attachRefArtwork(id)}
              onRemove={removeRef}
              onRename={(id, name) => updateRef(id, { name })}
              onMove={moveReference}
            />

            <StepFooter prod={prod} onNext={goNext} />
          </section>
        )}

        {prod.currentStep === 3 && (
          <section className="prod-panel prod-storyboard-panel">
            <h3>3 · Storyboard</h3>
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
              <div className="prod-boards-grid">
                {prod.scenes.flatMap((sc) => sc.shots).map((shot) => (
                  <BoardCard
                    key={shot.id}
                    prod={prod}
                    shot={shot}
                    bust={boardBust}
                    regenerating={regenIds.has(shot.id) || editBusyIds.includes(shot.id)}
                    videoBusy={videoBusyIds.includes(shot.id)}
                    onRegenerate={() => void regenBoard(shot.id)}
                    onImport={() => void importFrames(shot.id)}
                    onEdit={() => setEditShotId(shot.id)}
                    onVideo={() => setVideoShotId(shot.id)}
                    onStyleChange={(style) => updateShotStyle(shot.id, style)}
                    onPromptFocus={focusPrompt}
                    selected={promptShotId === shot.id}
                    onDropFrame={(source) => void dropFrameAsReference(shot.id, source)}
                    onPromoteHistory={(index) => void promoteHistory(shot.id, index)}
                    onDelete={() => void deleteBoard(shot.id)}
                  />
                ))}
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
              />
              </div>
            )}
            {shotCount > 0 && <label className="prod-frame-zoom">Frame size <input type="range" min={180} max={440} step={10} value={frameZoom} onChange={(e) => setFrameZoom(Number(e.target.value))} /><span>{frameZoom}px</span></label>}
            {visibleLog.length > 0 && <ProdLog lines={visibleLog} />}
            {editShotId && (() => {
              const es = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === editShotId);
              return es ? (
                <EditBoardModal
                  shotNumber={es.number}
                  models={openArtModels}
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
              Generate or import one voiceover clip for the whole production, optionally add a music track, then
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
                        <label className="prod-openart-label">Model
                          <select
                            className="prod-openart-select"
                            value={prod.voiceover?.model ?? "auto"}
                            onChange={(e) => setVoiceoverModel(e.target.value)}
                            title="Audio model for the voiceover"
                          >
                            <option value="auto">Auto</option>
                            {ttsModels.map((m) => (
                              <option key={m.id} value={m.id} title={m.cost != null ? `Base cost: ${m.cost} credits` : undefined}>
                                {m.displayName}{m.cost != null ? ` ◎${m.cost}` : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="prod-openart-label">Voice
                          <select
                            className="prod-openart-select"
                            value={(() => {
                              const m = ttsModels.find((am) => am.id === prod.voiceover?.model);
                              const allowed = m?.voices ?? [];
                              return prod.voiceover && allowed.includes(prod.voiceover.voice)
                                ? prod.voiceover.voice
                                : (allowed[0] ?? "");
                            })()}
                            onChange={(e) => setVoiceoverConfig({ voice: e.target.value })}
                            title="Voice id passed to the audio model"
                          >
                            {(() => {
                              const m = ttsModels.find((am) => am.id === prod.voiceover?.model);
                              const allowed = m?.voices ?? [];
                              return allowed.map((v) => <option key={v} value={v}>{v}</option>);
                            })()}
                          </select>
                        </label>
                        <div className="prod-audio-buttons">
                          <button
                            className="primary"
                            disabled={voBusy || !prod.scenes.some((sc) => sc.shots.some((s) => s.audio.trim()))}
                            onClick={() => void generateVo()}
                            title="Synthesize one voiceover clip for the whole production"
                          >
                            {voBusy ? "Generating…" : "Generate"}
                          </button>
                        </div>
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
                        <label className="prod-openart-label">Model
                          <select
                            className="prod-openart-select"
                            value={musicModels.some((m) => m.id === musicModel) ? musicModel : "auto"}
                            onChange={(e) => setMusicModel(e.target.value)}
                            title="Audio model for music generation"
                          >
                            <option value="auto">Auto</option>
                            {musicModels.map((m) => (
                              <option key={m.id} value={m.id} title={m.cost != null ? `Base cost: ${m.cost} credits` : undefined}>
                                {m.displayName}{m.cost != null ? ` ◎${m.cost}` : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                        <input
                          className="prod-music-prompt"
                          value={musicPrompt}
                          onChange={(e) => setMusicPrompt(e.target.value)}
                          placeholder="Describe the music… e.g. warm lofi loop, gentle piano, ~30s"
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void generateMusic(); } }}
                        />
                        <div className="prod-audio-buttons">
                          <button
                            className="primary"
                            disabled={musicBusy || !musicPrompt.trim()}
                            onClick={() => void generateMusic()}
                            title="Synthesize a background music clip from the description"
                          >
                            {musicBusy ? "Generating…" : "Generate"}
                          </button>
                        </div>
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
          <section className="prod-panel">
            <h3>{prod.currentStep} · {STEPS[prod.currentStep - 1].title}</h3>
            <p className="hint">{STEPS[prod.currentStep - 1].desc} — coming in the next milestone. Your shot list and style carry forward automatically.</p>
            <StepFooter prod={prod} onNext={goNext} />
          </section>
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
const animaticThumbCache = new Map<string, string>();
function AnimaticThumb({ prodId, shotId, artwork }: { prodId: string; shotId: string; artwork?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const key = `${prodId}:${shotId}:${artwork ?? ""}`;
    const cached = animaticThumbCache.get(key);
    if (cached) { setSrc(cached); return () => { live = false; }; }
    setSrc(null);
    if (artwork) {
      window.cascade.boardThumbnail(prodId, shotId).then((d) => {
        if (!live) return;
        if (d) {
          // Bounded memory: after enough distinct thumbs, drop the whole map
          // (entries are cheap to refetch and rarely thrash during editing).
          if (animaticThumbCache.size > 200) animaticThumbCache.clear();
          animaticThumbCache.set(key, d);
        }
        setSrc(d);
      }).catch(() => {});
    }
    return () => { live = false; };
  }, [prodId, shotId, artwork]);
  if (!src) return <span className="prod-timeline-thumb blank" title="No frame yet — generate one in Storyboard" />;
  return <img className="prod-timeline-thumb" src={src} alt="Shot frame" title="Primary frame for this shot" />;
}

/** Flatten scenes to a single ordered shot list with a global timeline cursor. */
function flatShots(scenes: Production["scenes"]): ProductionShot[] {
  return scenes.flatMap((s) => s.shots);
}

/** Sum of all shot durations (clamped to >=0.1 so the strip always has a width). */
function totalDuration(scenes: Production["scenes"]): number {
  const t = flatShots(scenes).reduce((n, s) => n + (s.durationSec ?? 3), 0);
  return t > 0 ? t : 0.1;
}

/** Convert a data URL into an ArrayBuffer for AudioContext decoding. The VO
 *  / music IPCs prefer streamable cascade-media:// URLs, but legacy builds
 *  fall back to data URLs — decode those without a fetch (and in chunks so
 *  multi-MB base64 never hits a single-string limit). */
function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const clean = base64.replace(/\s/g, "");
    const chunkSize = 32768; // multiple of 4 so chunk padding stays valid
    const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    const totalLen = Math.ceil((clean.length * 3) / 4) - padding;
    const bytes = new Uint8Array(totalLen);
    let offset = 0;
    for (let i = 0; i < clean.length; i += chunkSize) {
      const slice = clean.slice(i, i + chunkSize);
      const bin = atob(slice);
      for (let j = 0; j < bin.length; j++) bytes[offset++] = bin.charCodeAt(j);
    }
    return offset === bytes.length ? bytes : bytes.slice(0, offset);
  } catch {
    return null;
  }
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer | null {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  const bytes = base64ToBytes(dataUrl.slice(comma + 1));
  return bytes ? (bytes.buffer as ArrayBuffer) : null;
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  if (url.startsWith("data:")) {
    const ab = dataUrlToArrayBuffer(url);
    if (!ab || !ab.byteLength) throw new Error("empty data URL");
    return ab;
  }
  const resp = await fetch(url);
  const ab = await resp.arrayBuffer();
  if (!ab.byteLength) throw new Error("empty");
  return ab;
}

/** Compact design-language preview player for the VO / Music import rows.
 *  Replaces the native `<audio controls>` (whose Chromium chrome clashes with
 *  the dark theme): play/pause + click-to-seek progress bar + elapsed/total.
 *  Reports the loaded duration via `onDurationKnown` (used by the VO row to
 *  feed the Fit-to-VO math). */
/** Mutable audio-element ref (React 18's RefObject.current is readonly, but
 *  MiniAudioPlayer / VolumeSlider need to write `.current`). */
type AudioElRef = { current: HTMLAudioElement | null };

function MiniAudioPlayer({ src, onDurationKnown, audioRef }: {
  src: string | null;
  onDurationKnown?: (sec: number) => void;
  /** Optional external ref — lets a sibling volume slider set the audio
   *  element's volume live while dragging. */
  audioRef?: AudioElRef;
}) {
  const internalRef = useRef<HTMLAudioElement | null>(null) as AudioElRef;
  const barRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    // Reset the transport when the clip changes (re-import / replace).
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
  }, [src]);

  const toggle = () => {
    const el = internalRef.current;
    if (!el || !src) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = internalRef.current;
    const bar = barRef.current;
    if (!el || !bar || !Number.isFinite(el.duration) || el.duration <= 0) return;
    const r = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    el.currentTime = ratio * el.duration;
    setCurrent(el.currentTime);
  };

  const pct = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <div className="prod-mini-player">
      <button
        className="prod-mini-play"
        onClick={toggle}
        title={playing ? "Pause preview" : "Play preview"}
        disabled={!src}
        aria-label={playing ? "Pause preview" : "Play preview"}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <div className="prod-mini-bar" ref={barRef} onClick={seek} title="Click to seek">
        <div className="prod-mini-fill" style={{ width: `${pct}%` }} />
        <div className="prod-mini-head" style={{ left: `${pct}%` }} />
      </div>
      <span className="prod-mini-time">
        {formatRuntime(current)} / {duration > 0 ? formatRuntime(duration) : "–:––"}
      </span>
      <audio
        ref={(el) => {
          internalRef.current = el;
          if (audioRef) audioRef.current = el;
        }}
        src={src ?? undefined}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) { setDuration(d); onDurationKnown?.(d); }
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrent(0); }}
      />
    </div>
  );
}

/** Volume slider that stays responsive during a drag: the thumb moves and the
 *  audio element's volume updates immediately (local state + direct ref write),
 *  but the expensive production save only happens when the user lets go. The
 *  old onChange→saveField-per-tick path was noticeably sluggish. */
function VolumeSlider({ value, onCommit, audioRef, title }: {
  value: number;
  onCommit: (v: number) => void;
  /** Optional audio element to adjust live while dragging. */
  audioRef?: AudioElRef;
  title?: string;
}) {
  const [live, setLive] = useState(value);
  const timerRef = useRef<number | null>(null);

  useEffect(() => { setLive(value); }, [value]);
  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);

  const apply = (v: number) => {
    setLive(v);
    if (audioRef?.current) audioRef.current.volume = v;
    // Safety net: persist shortly after the last change even if a pointerup
    // is missed (e.g. release outside the input).
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => onCommit(v), 250);
  };

  const commitNow = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    onCommit(live);
  };

  return (
    <label className="prod-music-vol" title={title}>
      Vol
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={live}
        onChange={(e) => apply(Number(e.target.value))}
        onPointerUp={commitNow}
        onKeyUp={commitNow}
        onBlur={commitNow}
      />
    </label>
  );
}

/** Real-time playback preview + draggable cut points. The voiceover clip
 *  (one file for the whole production) drives the timeline total when it
 *  exists; otherwise the total is the sum of per-shot durations. Each block
 *  is a shot, width is proportional to durationSec, and dragging the right
 *  edge sets that shot's duration. The playhead can be drag-scrubbed; the
 *  preview pane's height can be dragged from its bottom border. Both VO and
 *  music are decoded to AudioBuffers and mixed via GainNodes so the sliders
 *  affect live playback. The voiceover waveform is drawn on a canvas behind
 *  the semi-transparent shot blocks. */
function AnimaticTimeline({
  prodId, scenes, voUrl, voDuration, onVoDurationKnown, musicUrl, musicVolume, voiceoverVolume,
  onUpdateDurations, onFitToVo, onUpdateTotal, onRemoveVideo, onToggleMute,
}: {
  prodId: string;
  scenes: Production["scenes"];
  voUrl: string | null;
  voDuration: number | null;
  onVoDurationKnown: (sec: number) => void;
  musicUrl: string | null;
  musicVolume: number;
  voiceoverVolume: number;
  onUpdateDurations: (updates: { shotId: string; durationSec: number }[]) => void;
  onFitToVo: () => void;
  onUpdateTotal: (sec: number) => void;
  /** Remove a shot's generated video (the preview falls back to the still). */
  onRemoveVideo: (shotId: string) => void;
  /** Toggle whether a shot's own embedded audio plays in the preview. */
  onToggleMute: (shotId: string) => void;
}) {
  const shots = flatShots(scenes);
  const sumDur = totalDuration(scenes);
  // Total is always the sum of shot durations — the user can edit it freely
  // (and "Fit to VO" rescales the shots to match the voiceover). The VO's
  // own length is overlaid on the strip as a waveform at its true scale.
  const total = sumDur;
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [editingTotal, setEditingTotal] = useState(false);
  const [totalDraft, setTotalDraft] = useState("");
  const stripRef = useRef<HTMLDivElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [previewHeight, setPreviewHeight] = useState(440);

  // ---- Zoomable strip + per-shot video pool (state) ----------------------
  // The strip scales from a "fit" baseline (whole runtime at 1x). Wheel-zooming
  // pins the playhead to its current screen X; the wrapper scrolls horizontally
  // once the content outgrows it. The preview pane keeps one <video> element
  // MOUNTED PER SHOT (LRU-capped): cutting between clips toggles visibility
  // instead of swapping src, which is what removes the black reload flash.
  const [zoom, setZoom] = useState(1);
  const [stripW, setStripW] = useState(0);
  const scrollWrapRef = useRef<HTMLDivElement>(null);
  const pendingScrollRef = useRef<number | null>(null);
  // Mirrors of render-time values read by stable closures (wheel handler).
  const playheadRef = useRef(0);
  const ppsRef = useRef(0);
  const zoomRef = useRef(1);
  // Pooled video elements + LRU bookkeeping, keyed by shot id.
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const poolLruRef = useRef<Map<string, number>>(new Map());
  const poolTickRef = useRef(0);
  const [mountedVideos, setMountedVideos] = useState<string[]>([]);

  /** Parse a user-entered total: "1:30", "0:42", "90", "1m30s", "45s". */
  function parseTotalInput(s: string): number | null {
    const t = s.trim();
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    let m = t.match(/^(\d+)m(\d+(?:\.\d+)?)?s?$/);
    if (m) return Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0);
    m = t.match(/^(\d+(?:\.\d+)?)s$/);
    if (m) return Number(m[1]);
    m = t.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    m = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    return null;
  }

  function startEditTotal() {
    setTotalDraft(formatRuntime(total));
    setEditingTotal(true);
  }

  function commitTotal() {
    const next = parseTotalInput(totalDraft);
    if (next != null && next > 0) onUpdateTotal(next);
    setEditingTotal(false);
  }

  // Decode VO and music once into AudioBuffers (cached for playback + waveform).
  // The decoded duration is the primary source for the waveform, but the
  // <audio> element's metadata is the source of truth for playback length.
  // If decode fails (e.g. codec supported by <audio> but not by
  // AudioContext), we must NOT clobber a valid duration already reported
  // by onLoadedMetadata — otherwise the UI sticks at 0:00 even though the
  // file plays.
  const [voBuffer, setVoBuffer] = useState<AudioBuffer | null>(null);
  const [musicBuffer, setMusicBuffer] = useState<AudioBuffer | null>(null);
  useEffect(() => {
    if (!voUrl) { setVoBuffer(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const ab = await fetchArrayBuffer(voUrl);
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        const buf = await ctx.decodeAudioData(ab.slice(0));
        await ctx.close().catch(() => {});
        if (cancelled) return;
        setVoBuffer(buf);
        onVoDurationKnown(buf.duration);
      } catch (e) {
        if (!cancelled) {
          setVoBuffer(null);
          // Do NOT call onVoDurationKnown(0) here — the hidden <audio>
          // element's onLoadedMetadata will provide the real duration even
          // when AudioContext can't decode this file (e.g. some mp3s).
          console.warn("VO AudioContext decode failed, falling back to <audio> metadata:", e);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voUrl]);

  useEffect(() => {
    if (!musicUrl) { setMusicBuffer(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const ab = await fetchArrayBuffer(musicUrl);
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        const buf = await ctx.decodeAudioData(ab.slice(0));
        await ctx.close().catch(() => {});
        if (cancelled) return;
        setMusicBuffer(buf);
      } catch {
        if (!cancelled) setMusicBuffer(null);
      }
    })();
    return () => { cancelled = true; };
  }, [musicUrl]);

  /** Cumulative start time of each shot in seconds. */
  const starts = useMemo(() => {
    const acc: number[] = [];
    let t = 0;
    for (const s of shots) { acc.push(t); t += s.durationSec ?? 3; }
    return acc;
  }, [shots]);

  /** Index of the shot the playhead is currently inside. */
  const activeIdx = useMemo(() => {
    if (playhead < 0 || !shots.length) return -1;
    for (let i = 0; i < shots.length; i++) {
      const end = starts[i] + (shots[i].durationSec ?? 3);
      if (playhead < end) return i;
    }
    return shots.length - 1;
  }, [playhead, shots, starts]);

  // Timeline playback uses hidden <audio> elements (more reliable codec support
  // than AudioContext decoding). Both are mixed via volume props so sliders take
  // effect live; the visual playhead follows wall-clock time synced to the
  // audio currentTime when possible.
  const voAudioRef = useRef<HTMLAudioElement | null>(null);
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const stopFlagRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const startedHeadRef = useRef(0);

  // Keep hidden players in sync with slider volumes and src changes.
  useEffect(() => { if (voAudioRef.current) voAudioRef.current.volume = Math.max(0, Math.min(1, voiceoverVolume)); }, [voiceoverVolume, voUrl]);
  useEffect(() => { if (musicAudioRef.current) musicAudioRef.current.volume = Math.max(0, Math.min(1, musicVolume)); }, [musicVolume, musicUrl]);
  useEffect(() => {
    if (voAudioRef.current) voAudioRef.current.src = voUrl ?? "";
    if (voAudioRef.current && !voUrl) { try { voAudioRef.current.pause(); } catch {} }
  }, [voUrl]);
  useEffect(() => {
    if (musicAudioRef.current) musicAudioRef.current.src = musicUrl ?? "";
    if (musicAudioRef.current) musicAudioRef.current.loop = true;
    if (musicAudioRef.current && !musicUrl) { try { musicAudioRef.current.pause(); } catch {} }
  }, [musicUrl]);

  const stop = useCallback(() => {
    stopFlagRef.current++;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    try { voAudioRef.current?.pause(); } catch {}
    try { musicAudioRef.current?.pause(); } catch {}
    setPlaying(false);
  }, []);

  const play = useCallback(async () => {
    if (playing) { stop(); return; }
    const flag = ++stopFlagRef.current;
    const voEl = voAudioRef.current;
    const muEl = musicAudioRef.current;
    const head = playhead;
    startedHeadRef.current = head;
    startedAtRef.current = performance.now() / 1000;
    // Wait until each element can play. Only force a load when it hasn't
    // loaded yet; the seek below is applied AFTER this settles so a deferred
    // load() can't reset currentTime back to 0 (which would restart playback
    // from the top regardless of the playhead).
    const waitUntilReady = (el: HTMLAudioElement | null): Promise<void> => {
      if (!el || el.readyState >= 2) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => resolve();
        el.addEventListener("canplay", done, { once: true });
        el.addEventListener("error", done, { once: true });
        window.setTimeout(done, 3000);
        el.load();
      });
    };
    await Promise.all([waitUntilReady(voEl), waitUntilReady(muEl)]);
    // Seek both players to the playhead (music loops by its own length).
    const toPlay: Promise<void>[] = [];
    if (voEl && voUrl) {
      const elDur = Number.isFinite(voEl.duration) && voEl.duration > 0 ? voEl.duration : 0;
      const voDur = voBuffer ? voBuffer.duration : elDur; // 0 = unknown length
      const pastEnd = voDur > 0 && head >= voDur;
      if (!pastEnd) {
        // Known duration: clamp to the playhead; unknown: best-effort seek and play anyway.
        try { voEl.currentTime = voDur > 0 ? Math.max(0, Math.min(head, voDur)) : Math.max(0, head); } catch {}
        voEl.volume = Math.max(0, Math.min(1, voiceoverVolume));
        toPlay.push(voEl.play().catch(() => {}));
      } else {
        // Playhead is past the end of the voiceover — keep it silent and let
        // the wall clock run the visuals (music may still be looping).
        try { voEl.pause(); } catch {}
      }
    }
    if (muEl && musicUrl) {
      try {
        const d = muEl.duration;
        muEl.currentTime = Number.isFinite(d) && d > 0 ? head % d : head;
      } catch { try { muEl.currentTime = head; } catch {} }
      muEl.volume = Math.max(0, Math.min(1, musicVolume));
      muEl.loop = true;
      toPlay.push(muEl.play().catch(() => {}));
    }
    // Even with no audio, we still run the visual clock.
    await Promise.all(toPlay);
    // Re-anchor wall clock after play() resolves (play may be async).
    startedAtRef.current = performance.now() / 1000;
    setPlaying(true);
    const tick = () => {
      if (flag !== stopFlagRef.current) return;
      // Prefer audio clock when VO is playing for sample-accurate sync.
      let head: number;
      if (voEl && !voEl.paused && voEl.currentTime > 0 && voBuffer && voEl.currentTime < voBuffer.duration) {
        head = startedHeadRef.current + (voEl.currentTime - Math.min(startedHeadRef.current, voBuffer.duration));
        // Fallback to wall clock if audio time stalls
        const wallHead = startedHeadRef.current + (performance.now() / 1000 - startedAtRef.current);
        if (Math.abs(head - wallHead) > 0.5) head = wallHead;
      } else {
        head = startedHeadRef.current + (performance.now() / 1000 - startedAtRef.current);
      }
      if (head >= total) { stop(); setPlayhead(0); return; }
      setPlayhead(head);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [playing, playhead, voUrl, musicUrl, voBuffer, total, stop, voiceoverVolume, musicVolume]);

  useEffect(() => () => stop(), [stop]);

  // ---- Zoomable strip + per-shot video pool (behavior) -------------------

  /** Pixels per second at the current zoom (fit scale × zoom). */
  const fitPps = stripW > 0 ? stripW / total : 0;
  const pps = fitPps * zoom;
  const contentW = Math.max(stripW, Math.ceil(total * pps));
  const activeId = activeIdx >= 0 && shots[activeIdx] ? shots[activeIdx].id : null;
  /** Playhead's local time within the shot it sits in. */
  const offsetInShot = activeIdx >= 0 ? Math.max(0, playhead - (starts[activeIdx] ?? 0)) : 0;

  playheadRef.current = playhead;
  ppsRef.current = pps;
  zoomRef.current = zoom;

  // Zoom is a per-session view of this production; refit when switching.
  useEffect(() => { setZoom(1); }, [prodId]);

  // Track the scroll viewport's width so blocks stay pixel-accurate.
  useEffect(() => {
    const el = scrollWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setStripW(el.clientWidth));
    ro.observe(el);
    setStripW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // A wheel-zoom computes the scroll position that pins the playhead to its
  // current screen X; apply it AFTER React lays out the resized content.
  useLayoutEffect(() => {
    const wrap = scrollWrapRef.current;
    if (!wrap || pendingScrollRef.current == null) return;
    wrap.scrollLeft = pendingScrollRef.current;
    pendingScrollRef.current = null;
  }, [zoom, pps]);

  // Wheel zoom anchored on the playhead. This listener must be native
  // (non-passive) — React's delegated wheel handler cannot preventDefault,
  // so the page would scroll while zooming without it.
  useEffect(() => {
    const wrap = scrollWrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      // Horizontal deltas pan natively; zoom only on vertical wheels/pinch.
      if (!e.deltaY || e.deltaX) return;
      e.preventDefault();
      const viewport = wrap.clientWidth;
      if (viewport <= 0 || total <= 0) return;
      const fit = viewport / total;
      const cur = zoomRef.current;
      const next = Math.max(1, Math.min(ANIMATIC_MAX_ZOOM, cur * Math.exp(-e.deltaY * 0.0016)));
      if (next === cur) return;
      const headT = Math.min(Math.max(playheadRef.current, 0), total);
      // Keep the playhead under its current screen position across the rescale.
      const headScreenX = headT * fit * cur - wrap.scrollLeft;
      const maxScroll = Math.max(0, total * fit * next - viewport);
      pendingScrollRef.current = Math.max(0, Math.min(maxScroll, headT * fit * next - headScreenX));
      zoomRef.current = next;
      setZoom(next);
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [total]);

  // Keep the playhead visible: auto-follow during playback (centered), and
  // reveal it right after a manual seek when the strip has been zoomed in.
  // Skipped while the user is drag-scrubbing so the strip never slides under
  // a stationary cursor.
  useEffect(() => {
    if (headDragRef.current) return;
    const wrap = scrollWrapRef.current;
    if (!wrap || pps <= 0 || stripW <= 0) return;
    const maxScroll = Math.max(0, contentW - stripW);
    const x = playhead * pps;
    const left = wrap.scrollLeft;
    if (x < left + 8 || x > left + stripW - 8) {
      wrap.scrollLeft = Math.max(0, Math.min(maxScroll, x - stripW / 2));
    }
  }, [playhead, playing, pps, stripW, contentW]);

  // Mount <video> elements for the active shot and its neighbours ahead of
  // time so approaching cuts never reload; evict least-recently-active ones
  // beyond VIDEO_POOL_MAX so long timelines don't hold every clip open.
  useEffect(() => {
    if (activeIdx < 0) return;
    const tick = ++poolTickRef.current;
    for (let i = Math.max(0, activeIdx - 2); i <= Math.min(shots.length - 1, activeIdx + 2); i++) {
      if (shots[i]?.videoPath) poolLruRef.current.set(shots[i].id, tick);
    }
    const valid = new Set<string>();
    shots.forEach((s) => { if (s.videoPath) valid.add(s.id); });
    const next = [...poolLruRef.current.entries()]
      .filter(([id]) => valid.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, VIDEO_POOL_MAX)
      .map(([id]) => id);
    setMountedVideos((prev) => (
      prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next
    ));
  }, [activeIdx, shots]);

  // Pool transport: pause everything except the active shot. The active one
  // snaps to the playhead's local time, then plays or pauses with the clock.
  useEffect(() => {
    videoElsRef.current.forEach((v, id) => {
      if (id === activeId) return;
      try { if (!v.paused) v.pause(); } catch {}
    });
    if (!activeId) return;
    const v = videoElsRef.current.get(activeId);
    if (!v) return;
    try {
      if (v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0)
        v.currentTime = Math.min(offsetInShot, v.duration);
    } catch {}
    if (playing) void v.play().catch(() => {});
    else { try { v.pause(); } catch {} }
    // offsetInShot intentionally omitted: mid-playback offsets advance every
    // frame while the video free-runs against the wall clock between cuts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, activeIdx, activeId]);

  // Paused / scrubbing: pin the active clip to the frame under the playhead.
  useEffect(() => {
    if (playing || !activeId) return;
    const v = videoElsRef.current.get(activeId);
    if (!v) return;
    try {
      if (v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0)
        v.currentTime = Math.min(Math.max(0, offsetInShot), v.duration);
    } catch {}
  }, [playhead, playing, activeIdx, activeId]);

  // ---- Waveform ----------------------------------------------------------
  // The canvas covers the visible window only: time t maps to x = t*pps −
  // scrollLeft. Peaks are downsampled once per decode into fixed ~6ms buckets
  // so a zoom-follow playback loop can redraw every frame without rescanning
  // raw PCM; redraws themselves stay event-driven.

  const voPeaks = useMemo(() => {
    if (!voBuffer || !total) return null;
    const ch = voBuffer.getChannelData(0);
    // Cap the bucket count: enough resolution to stay smooth at max zoom,
    // small enough that the one-time scan is instant.
    const targetBuckets = Math.min(32768, Math.max(64, Math.ceil(total * 640)));
    const per = Math.max(1, Math.floor(ch.length / targetBuckets));
    const n = Math.ceil(ch.length / per);
    const mins = new Float32Array(n);
    const maxs = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      let lo = 1, hi = -1;
      const s0 = b * per;
      const s1 = Math.min(ch.length, s0 + per);
      for (let j = s0; j < s1; j++) {
        const v = ch[j];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      mins[b] = lo;
      maxs[b] = hi;
    }
    return { mins, maxs, bucketSec: per / voBuffer.sampleRate };
  }, [voBuffer]);

  const drawWaveform = useCallback(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cvs.clientWidth, h = cvs.clientHeight;
    if (w <= 0 || h <= 0) return;
    cvs.width = Math.max(1, Math.floor(w * dpr));
    cvs.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!voPeaks || total <= 0 || pps <= 0 || voPeaks.bucketSec <= 0) return;
    const scrollLeft = scrollWrapRef.current?.scrollLeft ?? 0;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4f8ef7";
    // Columns of ~2 CSS px across the visible window only.
    const cols = Math.max(1, Math.floor(w / 2));
    const secondsPerCol = 2 / pps;
    const tStart = scrollLeft / pps;
    const { mins, maxs, bucketSec } = voPeaks;
    const voSecs = voBuffer?.duration ?? 0;
    for (let i = 0; i < cols; i++) {
      const t0 = tStart + i * secondsPerCol;
      if (t0 >= total || t0 >= voSecs) break;
      let b0 = Math.floor(t0 / bucketSec);
      let b1 = Math.floor((t0 + secondsPerCol) / bucketSec);
      b0 = Math.max(0, Math.min(mins.length - 1, b0));
      b1 = Math.max(b0, Math.min(mins.length - 1, b1));
      let min = 1, max = -1;
      for (let b = b0; b <= b1; b++) {
        if (mins[b] < min) min = mins[b];
        if (maxs[b] > max) max = maxs[b];
      }
      const x = (i / cols) * w;
      const y1 = ((1 - max) / 2) * h;
      const y2 = ((1 - min) / 2) * h;
      const barH = Math.max(1, y2 - y1);
      if (barH < 1.5) ctx.fillRect(x, (h - barH) / 2, Math.max(1, w / cols - 0.5), barH);
      else ctx.fillRect(x, y1, Math.max(1, w / cols - 0.5), barH);
    }
  }, [voPeaks, voBuffer, total, pps]);

  useEffect(() => { drawWaveform(); }, [drawWaveform, previewHeight, shots.length]);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => drawWaveform());
    ro.observe(el);
    return () => ro.disconnect();
  }, [drawWaveform]);
  // Also redraw after fonts/style settle
  useEffect(() => {
    const id = window.setTimeout(drawWaveform, 100);
    return () => window.clearTimeout(id);
  }, [drawWaveform]);
  // Redraw as the strip scrolls under the waveform row (rAF-throttled).
  useEffect(() => {
    const wrap = scrollWrapRef.current;
    if (!wrap) return;
    let queued = false;
    let queuedRaf = 0;
    const schedule = () => {
      if (queued) return;
      queued = true;
      queuedRaf = window.requestAnimationFrame(() => { queued = false; drawWaveform(); });
    };
    wrap.addEventListener("scroll", schedule, { passive: true });
    return () => {
      wrap.removeEventListener("scroll", schedule);
      window.cancelAnimationFrame(queuedRaf);
    };
  }, [drawWaveform]);
  // Page zoom (Ctrl+/-/0) rescales content without resizing the waveform's CSS
  // box, so the ResizeObserver never fires; devicePixelRatio also updates late.
  // Redraw on zoom notification and window resize, with retries to catch the
  // late dpr change.
  useEffect(() => {
    let timers: number[] = [];
    const schedule = () => {
      for (const t of timers) window.clearTimeout(t);
      timers = [0, 150, 600].map((d) => window.setTimeout(drawWaveform, d));
    };
    window.addEventListener("resize", schedule);
    const offZoom = window.cascade.onZoomChanged(schedule);
    return () => {
      for (const t of timers) window.clearTimeout(t);
      window.removeEventListener("resize", schedule);
      offZoom();
    };
  }, [drawWaveform]);

  // ---- Interactions -----------------------------------------------------

  /** Drag a block's right edge to set its duration. This is a roll edit: the
   *  dragged shot trades time with the following shot, so the total stays put
   *  and every later edit point is untouched. */
  const dragRef = useRef<{
    shotId: string;
    startX: number;
    startDur: number;
    pxPerSec: number;
    nextShot: { id: string; dur: number } | null;
  } | null>(null);
  const onHandleDown = (e: React.PointerEvent, shotId: string) => {
    if (pps <= 0) return;
    const idx = shots.findIndex((s) => s.id === shotId);
    if (idx < 0) return;
    dragRef.current = {
      shotId,
      startX: e.clientX,
      startDur: shots[idx].durationSec ?? 3,
      pxPerSec: pps,
      nextShot: idx + 1 < shots.length
        ? { id: shots[idx + 1].id, dur: shots[idx + 1].durationSec ?? 3 }
        : null,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    stop();
    e.preventDefault();
    e.stopPropagation();
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    let next = Math.max(0.5, Math.min(20, d.startDur + dx / d.pxPerSec));
    const updates: { shotId: string; durationSec: number }[] = [{ shotId: d.shotId, durationSec: next }];
    if (d.nextShot) {
      // Keep the boundary after the next shot fixed: shot i+1 absorbs the delta.
      let nextDur = d.nextShot.dur - (next - d.startDur);
      if (nextDur < 0.5) { nextDur = 0.5; next = d.startDur + (d.nextShot.dur - 0.5); }
      if (nextDur > 20) { nextDur = 20; next = d.startDur - (20 - d.nextShot.dur); }
      next = Math.max(0.5, Math.min(20, next));
      updates[0].durationSec = next;
      updates.push({ shotId: d.nextShot.id, durationSec: nextDur });
    }
    onUpdateDurations(updates.map((u) => ({ ...u, durationSec: Math.round(u.durationSec * 10) / 10 })));
  };
  const onHandleUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };

  /** Drag the preview's bottom border to resize. */
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const onResizeDown = (e: React.PointerEvent) => {
    resizeRef.current = { startY: e.clientY, startH: previewHeight };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    const dy = e.clientY - r.startY;
    setPreviewHeight(Math.max(80, Math.min(640, r.startH + dy)));
  };
  const onResizeUp = (e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    resizeRef.current = null;
  };

  /** Seek by pointer position. `ref` is the element whose rect defines the
   *  coordinate system: the zoomed strip maps px→s via the current scale plus
   *  its scroll offset, while the narrower transport scrubber stays a fixed
   *  full-range overview. */
  const seekFromEvent = (ref: React.RefObject<HTMLElement>, clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (ref === stripRef) {
      if (pps <= 0) return;
      const scrolled = scrollWrapRef.current?.scrollLeft ?? 0;
      const next = (clientX - r.left + scrolled) / pps;
      setPlayhead(Math.max(0, Math.min(total, next)));
      return;
    }
    const x = clientX - r.left;
    const next = Math.max(0, Math.min(total, (x / r.width) * total));
    setPlayhead(next);
  };
  const headDragRef = useRef<{ ref: React.RefObject<HTMLElement> } | null>(null);
  const onSeekDown = (ref: React.RefObject<HTMLElement>) => (e: React.PointerEvent) => {
    headDragRef.current = { ref };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    stop();
    seekFromEvent(ref, e.clientX);
    e.preventDefault();
  };
  const onSeekMove = (e: React.PointerEvent) => {
    const d = headDragRef.current;
    if (!d) return;
    seekFromEvent(d.ref, e.clientX);
  };
  const onSeekUp = (e: React.PointerEvent) => {
    if (!headDragRef.current) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    headDragRef.current = null;
  };

  if (!shots.length) {
    return <p className="hint">Add shots in Step 1 to start building the timeline.</p>;
  }

  const activeShot = activeIdx >= 0 ? shots[activeIdx] : null;
  const activeThumb = activeShot?.artwork;
  const headX = total > 0 ? (playhead / total) * 100 : 0;

  return (
    <div className="prod-animatic-body">
      <div
        className="prod-animatic-preview"
        ref={previewRef}
        style={{ height: `${previewHeight}px` }}
      >
        {/* One mounted <video> per recently-active shot (LRU-capped); only the
            active clip is visible, so cuts swap pixels instead of reloading
            media — no black flash between clips. The wall clock drives which
            clip shows; a video longer than its shot is cut at the boundary and
            a shorter one loops. */}
        {mountedVideos.map((vidId) => {
          const s = shots.find((q) => q.id === vidId);
          if (!s?.videoPath) return null;
          const isActive = vidId === activeShot?.id;
          return (
            <video
              key={vidId}
              ref={(el) => {
                if (el) videoElsRef.current.set(vidId, el);
                else videoElsRef.current.delete(vidId);
              }}
              className={"prod-animatic-video" + (isActive ? " live" : "")}
              src={`cascade-media://${prodId}/${encodeURIComponent(s.videoPath)}`}
              muted={!!s.muted}
              loop
              preload="auto"
              playsInline
              onLoadedMetadata={() => {
                if (!isActive) return; // it will be aligned when promoted
                const v = videoElsRef.current.get(vidId);
                if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
                try { v.currentTime = Math.min(offsetInShot, v.duration); } catch {}
                if (playing) void v.play().catch(() => {});
              }}
            />
          );
        })}
        {activeShot && activeShot.videoPath && (
          <button
            className="prod-animatic-video-remove"
            title="Remove this shot's video (back to a still frame)"
            onClick={(e) => { e.stopPropagation(); onRemoveVideo(activeShot.id); }}
          >
            ×
          </button>
        )}
        {activeShot && !activeShot.videoPath && activeThumb ? (
          <AnimaticThumb prodId={prodId} shotId={activeShot.id} artwork={activeThumb} />
        ) : null}
        {activeShot && !activeThumb ? (
          <div className="prod-animatic-preview-slate">
            <span>SLATE</span>
            <strong>{activeShot.number}</strong>
          </div>
        ) : null}
        {!activeShot && <div className="prod-animatic-preview-slate"><span>No shots yet</span></div>}
        <div
          className="prod-animatic-preview-resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          title="Drag to resize the preview"
        />
      </div>

      <div className="prod-animatic-transport">
        <button
          className="primary"
          onClick={() => void play()}
          disabled={!shots.length}
          title={playing ? "Pause playback" : "Play from playhead"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button onClick={() => { stop(); setPlayhead(0); }} title="Stop and rewind">■</button>
        <div
          className="prod-animatic-scrub"
          ref={scrubRef}
          onPointerDown={onSeekDown(scrubRef)}
          onPointerMove={onSeekMove}
          onPointerUp={onSeekUp}
          onPointerCancel={onSeekUp}
          title="Drag the playhead, or click to seek"
        >
          <div className="prod-animatic-scrub-fill" style={{ width: `${headX}%` }} />
          <div className="prod-animatic-scrub-head" style={{ left: `${headX}%` }} />
        </div>
        <span className="prod-animatic-time">
          {formatRuntime(playhead)} / {editingTotal ? (
            <input
              className="prod-animatic-total-input"
              autoFocus
              value={totalDraft}
              onChange={(e) => setTotalDraft(e.target.value)}
              onBlur={commitTotal}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitTotal(); }
                if (e.key === "Escape") { e.preventDefault(); setEditingTotal(false); }
              }}
              onFocus={(e) => e.currentTarget.select()}
              title="hh:mm:ss, mm:ss, or seconds"
            />
          ) : (
            <button
              className="prod-animatic-total-btn"
              onClick={startEditTotal}
              title="Click to set the total runtime"
            >
              {formatRuntime(total)}
            </button>
          )}
        </span>
        {voDuration && Math.abs(voDuration - sumDur) > 0.1 && (
          <button
            className="prod-btn"
            onClick={onFitToVo}
            title="Rescale every shot's length so the total matches the voiceover"
          >
            Fit to VO
          </button>
        )}
      </div>

      <div className="prod-animatic-strip-wrap">
        {/* Horizontal scroll frame: the wheel-zoomed strip lives inside. The
            transport scrubber above stays a fixed full-range overview. */}
        <div className="prod-animatic-scroll" ref={scrollWrapRef}>
          <div
            className="prod-animatic-strip"
            ref={stripRef}
            style={{ width: `${contentW}px`, minWidth: "100%" }}
            onPointerDown={onSeekDown(stripRef)}
            onPointerMove={onSeekMove}
            onPointerUp={onSeekUp}
            onPointerCancel={onSeekUp}
            title="Click or drag to seek · Mouse wheel zooms around the playhead"
          >
            {shots.map((s, i) => {
              const dur = s.durationSec ?? 3;
              return (
                <div
                  key={s.id}
                  className={"prod-animatic-block" + (i === activeIdx ? " active" : "")}
                  style={{ left: `${starts[i] * pps}px`, width: `${dur * pps}px` }}
                  title={`${s.number} · ${dur.toFixed(1)}s`}
                >
                  {s.artwork
                    ? <AnimaticThumb prodId={prodId} shotId={s.id} artwork={s.artwork} />
                    : <div className="prod-animatic-block-slate">SLATE<br /><strong>{s.number}</strong></div>}
                  {s.videoPath && (
                    <button
                      className={"prod-animatic-block-mute" + (s.muted ? " muted" : "")}
                      title={s.muted ? "Unmute this clip's audio" : "Mute this clip's audio"}
                      aria-label={s.muted ? "Unmute this clip's audio" : "Mute this clip's audio"}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onToggleMute(s.id); }}
                    >
                      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                        <path d="M2 6h3l4-3.5v11L5 10H2z" fill="currentColor" />
                        {s.muted ? (
                          <path d="M10.7 5.7l4 4M14.7 5.7l-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
                        ) : (
                          <>
                            <path d="M10.8 5.8a3.1 3.1 0 010 4.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
                            <path d="M12.9 3.9a5.9 5.9 0 010 8.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
                          </>
                        )}
                      </svg>
                    </button>
                  )}
                  <span className="prod-animatic-block-num">{s.number}</span>
                  <span className="prod-animatic-block-dur">{dur.toFixed(1)}s</span>
                  <div
                    className="prod-animatic-block-handle"
                    onPointerDown={(e) => onHandleDown(e, s.id)}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                    onPointerCancel={onHandleUp}
                    title="Drag to set the length of this clip"
                  />
                </div>
              );
            })}
            <div className="prod-animatic-playhead" style={{ left: `${playhead * pps}px` }} />
          </div>
        </div>
        {voUrl && (
          <div className="prod-animatic-wave-row" aria-label="Voiceover waveform">
            <canvas ref={canvasRef} className="prod-animatic-waveform" />
          </div>
        )}
      </div>

      {/* Hidden playback elements — the animatic transport plays these; they
          have no visible chrome (the volume sliders live next to the import
          buttons, the waveform lives under the image strip). */}
      <audio ref={voAudioRef} src={voUrl ?? ""} preload="auto" hidden onLoadedMetadata={(e) => {
        const duration = e.currentTarget.duration;
        if (Number.isFinite(duration) && duration > 0) onVoDurationKnown(duration);
      }} />
      <audio ref={musicAudioRef} src={musicUrl ?? ""} preload="auto" loop hidden />
    </div>
  );
}

/** "Next" bar shown at the bottom of every step panel — completes the step
 *  and moves to the next one. */
function StepFooter({ prod, onNext }: { prod: Production; onNext: () => void }) {
  if (prod.currentStep >= 5) return null;
  const nextTitle = STEPS[prod.currentStep].title; // STEPS is 0-indexed, steps are 1-indexed
  return (
    <div className="prod-next">
      <button className="prod-next-btn" onClick={onNext}>
        Next: {nextTitle} →
      </button>
    </div>
  );
}

interface RefItem {
  id: string;
  name: string;
  artwork?: string;
}

/** Grid of named reference slots: pick a name (populated from the script) and
 *  attach an image via the native file picker. With `onAdd`, also offers a
 *  form to create a brand-new character/product the script missed. */
function RefSection({ title, items, emptyHint, onAttach, onRemove, onAdd, addKind }: {
  title: string;
  items: RefItem[];
  emptyHint: string;
  onAttach: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (name: string, key: string) => void;
  addKind: string;
}) {
  const [picked, setPicked] = useState("");
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState("");
  const [addKey, setAddKey] = useState("");
  const withArt = items.filter((i) => i.artwork);
  const withoutArt = items.filter((i) => !i.artwork);
  const submit = () => {
    if (!addName.trim()) return;
    onAdd(addName, addKey);
    setAddName(""); setAddKey(""); setAdding(false);
  };
  return (
    <div className="prod-refs">
      <label className="prod-label">{title}</label>
      {withArt.length > 0 && (
        <div className="prod-ref-grid">
          {withArt.map((i) => (
            <figure key={i.id} className="prod-ref">
              <img src={i.artwork} alt={i.name} />
              <figcaption>{i.name}</figcaption>
              <button className="prod-ref-remove" title="Remove this reference" onClick={() => onRemove(i.id)}>×</button>
            </figure>
          ))}
        </div>
      )}
      {items.length === 0 ? (
        <p className="hint">{emptyHint}</p>
      ) : withoutArt.length === 0 ? (
        <p className="hint">All {items.length} have reference images.</p>
      ) : (
        <div className="prod-ref-add">
          <select value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">Choose a name…</option>
            {withoutArt.map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </select>
          <button disabled={!picked} onClick={() => { onAttach(picked); setPicked(""); }}>
            Add image…
          </button>
        </div>
      )}
      <div className="prod-ref-new">
          {adding ? (
            <>
              <input className="prod-ref-new-name" placeholder={`${addKind} name`} value={addName} onChange={(e) => setAddName(e.target.value)} autoFocus />
              {addKind === "character" && (
                <input className="prod-ref-new-key" placeholder="Visual descriptor (optional)" value={addKey} onChange={(e) => setAddKey(e.target.value)} />
              )}
              <button className="prod-btn" disabled={!addName.trim()} onClick={submit}>Add {addKind}</button>
              <button className="prod-btn ghost" onClick={() => { setAdding(false); setAddName(""); setAddKey(""); }}>Cancel</button>
            </>
          ) : (
            <button className="prod-btn" onClick={() => setAdding(true)}>＋ Add {addKind}…</button>
          )}
        </div>
    </div>
  );
}

/** Step 2: user-created references. Each reference is just a name and image;
 * any direction belongs in the storyboard frame prompt. */
function CustomRefSection({ items, onAdd, onAttach, onRemoveImage, onRemove, onUpdate }: {
  items: RefItem[];
  onAdd: (name: string) => void;
  onAttach: (id: string) => void;
  onRemoveImage: (id: string) => void;
  onRemove: (id: string) => void;
  /** Rename a reference in place. */
  onUpdate: (id: string, patch: Partial<{ name: string }>) => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    onAdd(name);
    setName(""); setPicked("");
  };
  return (
    <div className="prod-refs">
      <label className="prod-label">Custom references</label>
      <p className="hint">Materials, textures, mood shots, hero props — associate each to shots in Storyboard.</p>
      <div className="prod-ref-grid">
        {items.map((i) => (
          <figure key={i.id} className="prod-ref">
            {i.artwork ? <img src={i.artwork} alt={i.name} /> : <div className="prod-ref-blank">…</div>}
            <figcaption>
              <input
                className="prod-ref-name prod-ref-edit-name"
                value={i.name}
                placeholder="Reference name"
                onChange={(e) => onUpdate(i.id, { name: e.target.value })}
                title="Rename this reference"
              />
            </figcaption>
            {i.artwork
              ? <button className="prod-ref-remove" title="Remove reference image" onClick={() => onRemoveImage(i.id)}>×</button>
              : <button className="prod-ref-addimg" title="Attach a reference image" onClick={() => void onAttach(i.id)}>＋</button>}
            <button className="prod-ref-del" title="Delete this reference" onClick={() => onRemove(i.id)}>🗑</button>
          </figure>
        ))}
      </div>
      <div className="prod-ref-new form">
        <input className="prod-ref-new-name" placeholder="Reference name (e.g. Gondola Interior)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="prod-btn" disabled={!name.trim()} onClick={submit}>＋ Add reference…</button>
      </div>
    </div>
  );
}

function ReferenceCategorySection({ categories, items, onAddCategory, onRenameCategory, onAddReference, onAttach, onRemove, onRename, onMove }: {
  categories: ReferenceCategory[];
  items: CustomRef[];
  onAddCategory: (name: string) => void;
  onRenameCategory: (id: string, name: string) => void;
  onAddReference: (name: string, categoryId?: string, artwork?: string) => void;
  onAttach: (id: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, categoryId?: string) => void;
}) {
  const [categoryName, setCategoryName] = useState("");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const add = () => { if (name.trim()) { onAddReference(name, categoryId || undefined); setName(""); } };
  const groups = [{ id: "", name: "Uncategorized" }, ...categories];
  return (
    <div className="prod-refs">
      <label className="prod-label">Reference images</label>
      <p className="hint">Create categories for your references, then drag images between them.</p>
      <div className="prod-category-new">
        <input className="prod-ref-new-name" value={categoryName} placeholder="New category name" onChange={(e) => setCategoryName(e.target.value)} />
        <button className="prod-btn" disabled={!categoryName.trim()} onClick={() => { onAddCategory(categoryName); setCategoryName(""); }}>＋ Add category</button>
      </div>
      <div className="prod-category-list">
        {groups.map((category) => {
          const groupItems = items.filter((r) => (r.categoryId ?? "") === category.id);
          return (
            <section key={category.id || "uncategorized"} className="prod-category" onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("dragover"); }} onDragLeave={(e) => e.currentTarget.classList.remove("dragover")} onDrop={(e) => {
              e.preventDefault(); e.currentTarget.classList.remove("dragover");
              const id = e.dataTransfer.getData("application/x-cascade-reference");
              if (id) { onMove(id, category.id || undefined); return; }
              for (const file of Array.from(e.dataTransfer.files)) {
                if (!file.type.startsWith("image/")) continue;
                const reader = new FileReader();
                reader.onload = () => { if (typeof reader.result === "string") onAddReference(file.name.replace(/\.[^.]+$/, ""), category.id || undefined, reader.result); };
                reader.readAsDataURL(file);
              }
            }}>
              <div className="prod-category-head"><input className="prod-category-name" value={category.name} disabled={!category.id} onChange={(e) => onRenameCategory(category.id, e.target.value)} /><span className="hint">{groupItems.length}</span></div>
              <div className="prod-ref-grid">
                {groupItems.map((r) => (
                    <figure key={r.id} className="prod-ref">
                    {r.artwork ? <img src={r.artwork} alt={r.name} draggable onDragStart={(e) => { e.dataTransfer.setData("application/x-cascade-reference", r.id); e.dataTransfer.effectAllowed = "move"; }} /> : <div className="prod-ref-blank">＋</div>}
                    <figcaption><input className="prod-ref-name prod-ref-edit-name" value={r.name} onChange={(e) => onRename(r.id, e.target.value)} /></figcaption>
                    {!r.artwork && <button className="prod-ref-addimg" title="Attach a reference image" onClick={() => void onAttach(r.id)}>＋</button>}
                    <button className="prod-ref-del" title="Delete this reference" onClick={() => onRemove(r.id)}>×</button>
                  </figure>
                ))}
                {!groupItems.length && <span className="hint">Drop references here.</span>}
              </div>
            </section>
          );
        })}
      </div>
      <div className="prod-ref-new form">
        <input className="prod-ref-new-name" placeholder="Reference name" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="prod-openart-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">Uncategorized</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className="prod-btn" disabled={!name.trim()} onClick={add}>＋ Add reference</button>
      </div>
    </div>
  );
}

function ProdLog({ lines }: { lines: LogLine[] }) {  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [lines.length]);
  return (
    <div className="prod-log" ref={ref}>
      {lines.map((l, i) => (
        <div key={i} className={"prod-log-line " + l.level}>
          <span className="prod-log-time">{l.at}</span> {l.message}
        </div>
      ))}
    </div>
  );
}

interface PromptReference {
  id: string;
  name: string;
  artwork: string;
}

/** Textarea with human-readable reference tags and an @ autocomplete menu. */
function ReferencePromptEditor({ value, onChange, references, className, rows, autoFocus, placeholder, onKeyDown, onFocus }: {
  value: string;
  onChange: (value: string) => void;
  references: PromptReference[];
  className: string;
  rows: number;
  autoFocus?: boolean;
  placeholder: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });
  const matches = query === null ? [] : references.filter((r) => r.name.toLowerCase().includes(query.toLowerCase()));
  const tags = Array.from(value.matchAll(/@\[([^\]]+)\]/g)).map((m) => m[1]);

  function update(valueNext: string, caret = inputRef.current?.selectionStart ?? valueNext.length) {
    onChange(valueNext);
    const before = valueNext.slice(0, caret);
    const open = before.lastIndexOf("@");
    const tail = open >= 0 ? before.slice(open + 1) : "";
    const nextQuery = open >= 0 && !/[\s\[\]]/.test(tail) ? tail : null;
    setQuery(nextQuery);
    if (nextQuery !== null && inputRef.current) {
      const rect = inputRef.current.getBoundingClientRect();
      const line = before.slice(0, open).split("\n").length - 1;
      const column = before.slice(before.lastIndexOf("\n") + 1).length;
      const left = Math.min(rect.left + column * 8, window.innerWidth - 220);
      const cursorBottom = rect.top + Math.min(rect.height - 4, 8 + line * 21 + 21);
      setMenuPos({ left: Math.max(8, left), top: Math.min(cursorBottom, window.innerHeight - 220) });
    }
    setSelected(0);
  }
  function choose(ref: PromptReference) {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = value.slice(0, caret);
    const open = before.lastIndexOf("@");
    const next = `${value.slice(0, open)}@[${ref.name}]${value.slice(caret)}`;
    const nextCaret = open + ref.name.length + 3;
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(nextCaret, nextCaret); });
  }
  function keyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (query !== null && matches.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((n) => (n + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelected((n) => (n + matches.length - 1) % matches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(matches[selected]); return; }
      if (e.key === "Escape") { e.preventDefault(); setQuery(null); return; }
    }
    onKeyDown?.(e);
  }
  return (
    <div className="prod-ref-prompt-editor">
      <textarea
        ref={inputRef}
        className={className}
        rows={rows}
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(e) => update(e.target.value, e.target.selectionStart)}
        onKeyDown={keyDown}
        onFocus={onFocus}
        onBlur={() => window.setTimeout(() => {
          if (document.activeElement === inputRef.current || query === null) return;
          const caret = inputRef.current?.selectionStart ?? value.length;
          const before = value.slice(0, caret);
          const open = before.lastIndexOf("@");
          const tail = open >= 0 ? before.slice(open + 1) : "";
          if (open >= 0 && !/[\s\[\]]/.test(tail)) onChange(value.slice(0, open) + value.slice(caret));
          setQuery(null);
        }, 120)}
      />
      {query !== null && matches.length > 0 && (
        <div className="prod-ref-autocomplete" style={{ left: menuPos.left, top: menuPos.top }}>
          {matches.map((r, i) => (
            <button key={r.id} className={i === selected ? "selected" : ""} onMouseDown={(e) => { e.preventDefault(); choose(r); }}>
              <img src={r.artwork} alt="" /><span>@[{r.name}]</span>
            </button>
          ))}
        </div>
      )}
      {tags.length > 0 && (
        <div className="prod-ref-tag-previews">
          {tags.map((tag, i) => {
            const ref = references.find((r) => r.name.toLowerCase() === tag.toLowerCase());
            return ref ? <span key={`${ref.id}-${i}`} title={`Reference @[${ref.name}]`}><img src={ref.artwork} alt={ref.name} />@[{ref.name}]</span> : null;
          })}
        </div>
      )}
    </div>
  );
}

function promptRefsForShot(prod: Production, shotId: string): PromptReference[] {
  return [
    ...prod.characters.filter((r) => r.name && r.artwork).map((r) => ({ id: r.id, name: r.name, artwork: r.artwork! })),
    ...prod.products.filter((r) => r.name && r.artwork).map((r) => ({ id: r.id, name: r.name, artwork: r.artwork! })),
    ...(prod.references ?? []).filter((r) => r.name && r.artwork).map((r) => ({ id: r.id, name: r.name, artwork: r.artwork! })),
  ];
}

function PromptSidePanel({ shotNumber, value, includeBrand, scriptVisual, scriptAudio, references, onChange, onToggleBrand, onSubmit, submitting }: { shotNumber?: string; value: string; includeBrand: boolean; scriptVisual?: string; scriptAudio?: string; references: PromptReference[]; onChange: (value: string) => void; onToggleBrand: (include: boolean) => void; onSubmit: () => void; submitting: boolean }) {
  return (
    <aside className="prod-prompt-sidepanel">
      <div className="prod-prompt-drawer-head">
        <span className="prod-prompt-drawer-title">{shotNumber ? `Shot ${shotNumber} prompt` : "Frame prompt"}</span>
        {shotNumber && <label className="prod-brand-toggle"><input type="checkbox" checked={includeBrand} onChange={(e) => onToggleBrand(e.target.checked)} /> Include Brand Identity</label>}
      </div>
      {shotNumber ? <>
        <ReferencePromptEditor className="prod-prompt-drawer-text" rows={12} value={value} references={references} placeholder="Generation prompt — type @ to add a reference" onChange={onChange} />
        <div className="prod-prompt-script"><span className="prod-prompt-script-title">Visual direction from the script</span><div className="prod-prompt-script-body">{scriptVisual || <em>No visual direction recorded for this shot.</em>}{scriptAudio && <p className="prod-prompt-script-audio">Audio: {scriptAudio}</p>}</div></div>
        <button className="prod-btn prod-prompt-submit" disabled={submitting} onClick={onSubmit}>{submitting ? "Generating…" : "Submit frame"}</button>
      </> : <p className="hint">Click a storyboard prompt to edit it here.</p>}
    </aside>
  );
}

/** mm:ss label for the Step 4 runtime. */
function formatRuntime(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** One storyboard frame in the Step 3 contact sheet. The PNG lives in the
 *  production folder; the thumbnail is fetched on demand as a data URL. */
function BoardCard({ prod, shot, bust, regenerating, videoBusy, onRegenerate, onImport, onEdit, onVideo, onStyleChange, onPromptFocus, selected, onDropFrame, onPromoteHistory, onDelete }: {
  prod: Production;
  shot: ProductionShot;
  bust: number;
  regenerating: boolean;
  videoBusy: boolean;
  onRegenerate: () => void;
  onImport: () => void;
  /** Open the AI edit dialog for this frame. */
  onEdit: () => void;
  /** Open the video-generation modal for this frame. */
  onVideo: () => void;
  onStyleChange: (style: string) => void;
  onPromptFocus: (shotId: string, prompt: string) => void;
  selected: boolean;
  /** Attach a frame dragged from another card as a reference on this shot. */
  onDropFrame: (source: { prodId: string; shotId: string; number: number }) => void;
  /** Promote the browsed history frame (by artworkHistory index) to primary. */
  onPromoteHistory: (index: number) => void;
  onDelete: () => void;
}) {
  const [img, setImg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [expandedImg, setExpandedImg] = useState<string | null>(null);
  const [expandedVideo, setExpandedVideo] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string>("");
  // Hover-preview video for the shot's generated clip (muted, looping). Falls
  // back to the still image if the clip can't be loaded.
  const boardVideoRef = useRef<HTMLVideoElement | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  // Frame history browsing: null = current frame; otherwise an index into
  // shot.artworkHistory (0 = most recent previous frame). Thumbnails are
  // fetched lazily and cached per index.
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [histCache, setHistCache] = useState<Record<string, string>>({});
  const histLen = shot.artworkHistory?.length ?? 0;
  useEffect(() => {
    let live = true;
    setImg(null);
    setHistIdx(null);
    setHistCache({});
    setVideoFailed(false);
    if (shot.artwork) {
      window.cascade.boardThumbnail(prod.meta.id, shot.id).then((d) => { if (live) setImg(d); }).catch(() => {});
    }
    return () => { live = false; };
  }, [prod.meta.id, shot.id, shot.artwork, bust]);

  // Lazily load the history frame being viewed.
  useEffect(() => {
    if (histIdx === null) return;
    let live = true;
    const key = String(histIdx);
    if (!histCache[key]) {
        window.cascade.boardThumbnail(prod.meta.id, shot.id, histIdx)
        .then((d) => { if (live && d) setHistCache((c) => ({ ...c, [key]: d })); })
        .catch(() => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histIdx, prod.meta.id, shot.id]);

  const shownImg = histIdx === null ? img : histCache[String(histIdx)] ?? null;

  // Load the effective prompt into the editor when this shot OR the design
  // it derives from changes (styles, brand, references, shot text) — so
  // editing the master style in Step 2 is reflected here immediately. The
  // override (shot.prompt) still wins over the auto-derived prompt.
  const designSig = JSON.stringify([
    prod.styles ?? [],
    prod.brand ?? {},
    prod.characters.map((c) => [c.id, c.name, c.key, !!c.artwork]),
    prod.products.map((pr) => [pr.id, pr.name, !!pr.artwork]),
    (prod.references ?? []).map((r) => [(r.shotIds ?? []).includes(shot.id), r.name, !!r.artwork]),
    shot.refIds ?? [],
    shot.audio,
    shot.visual,
  ]);
  useEffect(() => {
    let live = true;
    window.cascade.getBoardPrompt(prod.meta.id, shot.id).then((p) => {
      if (!live) return;
      // While the user is typing in this card's editor, never replace the
      // value: the debounced save changes shot.prompt, re-runs this effect,
      // and a round-tripped (normalized) string would reset the textarea's
      // DOM value and yank the caret to the end.
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement
        && (el.classList.contains("prod-board-prompt") || el.classList.contains("prod-prompt-drawer-text"))) return;
      setPrompt(p ?? shot.prompt ?? "");
    }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prod.meta.id, shot.id, shot.prompt, shot.style, designSig]);

  return (
    <figure className={"prod-board" + (selected ? " selected" : "")}>
      <div
        className="prod-board-frame"
        onClick={() => onPromptFocus(shot.id, prompt)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-cascade-frame")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; e.currentTarget.classList.add("dragover"); }
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove("dragover")}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.classList.remove("dragover");
          const raw = e.dataTransfer.getData("application/x-cascade-frame");
          if (!raw) return;
          try { const src = JSON.parse(raw) as { prodId: string; shotId: string; number: number }; if (src.shotId !== shot.id) void onDropFrame(src); } catch { /* ignore malformed drag payload */ }
        }}
      >
        {histLen > 0 && histIdx === null && (
          <button
            className="prod-board-hist prev"
            title={`Previous frame (${histLen} in history)`}
            onClick={() => setHistIdx(0)}
          >
            ‹
          </button>
        )}
        {histIdx !== null && (
          <>
            <button
              className="prod-board-hist prev"
              title={histIdx + 1 < histLen ? "Older frame" : "Start of history"}
              disabled={histIdx + 1 >= histLen}
              onClick={() => setHistIdx((i) => Math.min((i ?? 0) + 1, histLen - 1))}
            >
              ‹
            </button>
            <button
              className={"prod-board-hist next" + (histIdx === 0 ? " to-current" : "")}
              title={histIdx === 0 ? "Back to current frame" : "Newer frame"}
              onClick={() => setHistIdx((i) => ((i ?? 0) - 1 < 0 ? null : (i ?? 0) - 1))}
            >
              ›
            </button>
            <span
              className={"prod-board-hist-tag" + (histIdx === 0 ? " old" : "")}
              title={histIdx === 0 ? "Most recent previous frame" : `History frame ${histIdx + 1} of ${histLen}`}
            >
              {histIdx === 0 ? "prev" : `−${histIdx}`}
            </span>
          </>
        )}
        {histIdx !== null && shownImg && (
          <button
            className="prod-board-promote"
            title="Set this history frame as the primary frame for this shot (the current frame moves into history)"
            onClick={() => onPromoteHistory(histIdx)}
          >
            Set as primary
          </button>
        )}
        {shownImg && histIdx === null && shot.videoPath && !videoFailed ? (
          <video
            ref={boardVideoRef}
            className="prod-board-frame-video"
            src={`cascade-media://${prod.meta.id}/${encodeURIComponent(shot.videoPath)}`}
            muted
            loop
            playsInline
            preload="metadata"
            onLoadedMetadata={(e) => {
              // Nudge past 0 so the first frame renders while paused.
              try { if (e.currentTarget.currentTime < 0.05) e.currentTarget.currentTime = 0.05; } catch {}
            }}
            onMouseEnter={() => { try { boardVideoRef.current?.play(); } catch {} }}
            onMouseLeave={() => { try { boardVideoRef.current?.pause(); } catch {} }}
            onError={() => setVideoFailed(true)}
            onClick={(e) => { e.stopPropagation(); onPromptFocus(shot.id, prompt); }}
            onDragStart={(e) => {
              // Carry this frame's identity so another frame can accept it as a reference.
              e.dataTransfer.setData(
                "application/x-cascade-frame",
                JSON.stringify({ prodId: prod.meta.id, shotId: shot.id, number: shot.number }),
              );
              e.dataTransfer.effectAllowed = "copy";
            }}
            title="Hover to preview this shot's video — click to edit its prompt, or drag onto another frame as a reference"
          />
        ) : shownImg ? (
          <img
            src={shownImg}
            alt={`Shot ${shot.number}`}
            className="prod-board-frame-img"
            onClick={(e) => { e.stopPropagation(); onPromptFocus(shot.id, prompt); }}
            onDragStart={(e) => {
              // Carry this frame's identity so another frame can accept it as a reference.
              e.dataTransfer.setData(
                "application/x-cascade-frame",
                JSON.stringify({ prodId: prod.meta.id, shotId: shot.id, number: shot.number }),
              );
              e.dataTransfer.effectAllowed = "copy";
            }}
            title="Click to edit this shot's prompt — or drag onto another frame to use it as a reference"
          />
        ) : (
          <span className="prod-board-empty">{shot.artwork ? "…" : "no frame"}</span>
        )}
        <button
          className="prod-board-zoom"
          title={shot.videoPath ? "Play this shot's video" : "Enlarge this frame"}
          disabled={!img}
          onClick={(e) => {
            e.stopPropagation();
            if (shot.videoPath) {
              setExpandedImg(null);
              setExpandedVideo(`cascade-media://${prod.meta.id}/${encodeURIComponent(shot.videoPath)}`);
              setExpanded(true);
            } else {
              setExpandedVideo(null);
              void window.cascade.boardImageFull(prod.meta.id, shot.id).then((full) => { if (full) { setExpandedImg(full); setExpanded(true); } });
            }
          }}
        >⌕</button>
        <button
          className="prod-board-video"
          title={shot.videoPath ? "Replace this shot's video" : "Generate a video from this frame"}
          disabled={regenerating || !img}
          onClick={(e) => { e.stopPropagation(); onVideo(); }}
        >
          {videoBusy ? "…" : "▶"}
        </button>
        <button className="prod-board-import" title="Import a frame for this shot" disabled={regenerating} onClick={(e) => { e.stopPropagation(); onImport(); }}>⤒</button>
        <button
          className="prod-board-edit"
          title="Edit this frame with AI (image-input model + prompt)"
          disabled={regenerating || !img}
          onClick={onEdit}
        >
          ✎
        </button>
        <button
          className="prod-board-regen"
          title="Regenerate this frame"
          disabled={regenerating}
          onClick={onRegenerate}
        >
          {regenerating ? "…" : "↻"}
        </button>
        <button className="prod-board-delete" title="Delete this frame" disabled={regenerating || !shot.artwork} onClick={(e) => { e.stopPropagation(); onDelete(); }}>×</button>
      </div>
      <div className="prod-board-style-row">
        <select
          className="prod-board-style"
          value={shot.style ?? prod.styles?.[0]?.id ?? ""}
          onChange={(e) => onStyleChange(e.target.value)}
          title="Render style for this frame (from the styles created in Design, Step 2)"
        >
          {(prod.styles ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.index}. {s.name || `Style ${s.index}`}</option>
          ))}
        </select>
      </div>
      {expanded && (expandedImg || expandedVideo) && (
        <div className="prod-ref-lightbox" onClick={() => setExpanded(false)}>
          <figure className="prod-ref-lightbox-card">
            {expandedVideo ? (
              <video
                className="prod-ref-lightbox-video"
                src={expandedVideo}
                controls
                autoPlay
                playsInline
              />
            ) : expandedImg ? (
              <img src={expandedImg} alt={`Shot ${shot.number}`} />
            ) : null}
            <figcaption>Shot {shot.number} — click anywhere to close</figcaption>
          </figure>
        </div>
      )}
    </figure>
  );
}

/** Step 3: video-generation dialog for one frame. The shot's current frame is
 *  always used as the reference; pick a video model, resolution and length,
 *  and write a motion prompt (with @[name] references, like the side panel).
 *  Shows the estimated credit cost before submitting. */
function VideoGenModal({ shot, prod, models, onClose, onSubmit }: {
  shot: ProductionShot;
  prod: Production;
  models: OpenArtModelChoice[];
  onClose: () => void;
  onSubmit: (opts: VideoGenOptions) => void;
}) {
  const videoModels = models.filter((m) => m.videoInput);
  const [model, setModel] = useState(videoModels[0]?.id ?? "auto");
  const [resolution, setResolution] = useState("1080p");
  const [durationSec, setDurationSec] = useState(5);
  const [prompt, setPrompt] = useState("Animate this reference image with smooth, cinematic motion.");
  const [credits, setCredits] = useState<number | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  // Resolution / length options are model-specific — fetch them from the
  // model's live form schema whenever the model changes.
  const [modelOpts, setModelOpts] = useState<VideoModelOptions | null>(null);
  useEffect(() => {
    let live = true;
    setModelOpts(null);
    if (model && model !== "auto") {
      window.cascade.videoModelOptions(model)
        .then((o) => { if (live) setModelOpts(o); })
        .catch(() => {});
    }
    return () => { live = false; };
  }, [model]);
  const resolutions = modelOpts?.resolutions?.length ? modelOpts.resolutions : ["480p", "720p", "1080p"];
  const durations = modelOpts?.durations?.length ? modelOpts.durations : [5, 10, 15, 20];
  // Keep the current selection valid when the model's options arrive.
  useEffect(() => {
    if (resolutions.length && !resolutions.includes(resolution)) setResolution(resolutions[0]);
    if (durations.length && !durations.includes(durationSec)) setDurationSec(durations[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelOpts]);
  useEffect(() => {
    void window.cascade.getOpenArtCredits().then((c) => setCredits(c)).catch(() => {});
    window.cascade.boardThumbnail(prod.meta.id, shot.id).then((d) => setFrame(d)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prod.meta.id, shot.id]);
  const selected = videoModels.find((m) => m.id === model);
  const cost = selected && typeof selected.cost === "number" ? selected.cost : null;
  const references = promptRefsForShot(prod, shot.id);
  return (
    <div className="prod-edit-overlay" onClick={onClose}>
      <div className="prod-edit-panel prod-video-panel" onClick={(e) => e.stopPropagation()}>
        <div className="prod-edit-head">
          <span className="prod-edit-title">Shot {shot.number} — generate video</span>
          <button className="prod-btn" onClick={onClose}>Cancel</button>
        </div>
        <div className="prod-video-frame-row">
          <div className="prod-video-frame">
            {frame ? <img src={frame} alt={`Shot ${shot.number}`} /> : <span>no frame</span>}
          </div>
          <span className="prod-video-frame-label">
            Source frame — the full-resolution version is sent as the video's primary reference.
            {shot.videoPath ? " This shot already has a video; generating replaces it." : ""}
          </span>
        </div>
        <label className="prod-label">Model</label>
        <select
          className="prod-openart-select"
          value={videoModels.some((m) => m.id === model) ? model : "auto"}
          onChange={(e) => setModel(e.target.value)}
          title="OpenArt video model (Auto lets Cascade pick)"
        >
          {videoModels.length === 0 && <option value="auto">Auto</option>}
          {videoModels.map((m) => (
            <option key={m.id} value={m.id} title={m.description}>
              {m.displayName}{typeof m.cost === "number" ? ` ◎${m.cost}` : ""}
            </option>
          ))}
        </select>
        <div className="prod-video-row">
          <label className="prod-label">Resolution
            <select className="prod-openart-select" value={resolution} onChange={(e) => setResolution(e.target.value)}>
              {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="prod-label">Length
            <select className="prod-openart-select" value={durationSec} onChange={(e) => setDurationSec(Number(e.target.value))}>
              {durations.map((s) => <option key={s} value={s}>{s}s</option>)}
            </select>
          </label>
        </div>
        <label className="prod-label">Prompt</label>
        <ReferencePromptEditor
          className="prod-video-prompt"
          rows={4}
          value={prompt}
          references={references}
          placeholder="Motion prompt — type @ to add a reference"
          onChange={setPrompt}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && prompt.trim()) onSubmit({ model, resolution, durationSec, prompt: prompt.trim() });
            if (e.key === "Escape") onClose();
          }}
        />
        {(cost != null || credits != null) && (
          <p className="prod-video-cost">
            {cost != null && <>This clip costs about <strong>◎{cost} credits</strong>.</>}
            {credits != null ? ` You have ~${credits.toLocaleString()} OpenArt credits available.` : ""}
          </p>
        )}
        <button className="prod-btn prod-edit-go" disabled={!prompt.trim()} onClick={() => onSubmit({ model, resolution, durationSec, prompt: prompt.trim() })}>
          Generate video
        </button>
      </div>
    </div>
  );
}

/** Step 3: AI edit dialog for one board frame - pick an image-input model and
 *  describe the change; the current frame is sent as the visual reference and
 *  the result becomes the new frame (previous one kept in history). */
function EditBoardModal({ shotNumber, models, onSubmit, onClose }: {
  shotNumber: string;
  models: OpenArtModelChoice[];
  onSubmit: (model: string, prompt: string) => void;
  onClose: () => void;
}) {
  const imageModels = models.filter((m) => m.imageInput);
  const [model, setModel] = useState(imageModels[0]?.id ?? "auto");
  const [prompt, setPrompt] = useState("");
  return (
    <div className="prod-edit-overlay" onClick={onClose}>
      <div className="prod-edit-panel" onClick={(e) => e.stopPropagation()}>
        <div className="prod-edit-head">
          <span className="prod-edit-title">Shot {shotNumber} - edit frame with AI</span>
          <button className="prod-btn" onClick={onClose}>Cancel</button>
        </div>
        <label className="prod-label">Model</label>
        <select
          className="prod-openart-select"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          title="Image model that accepts a reference image"
        >
          {imageModels.length === 0 && <option value="auto">Auto</option>}
          {imageModels.map((m) => (
            <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>
          ))}
        </select>
        {imageModels.length === 0 && (
          <p className="hint">No image-input model reported by OpenArt - Auto will pick one that accepts references.</p>
        )}
        <label className="prod-label">Edit prompt</label>
        <textarea
          className="prod-edit-prompt"
          autoFocus
          rows={4}
          value={prompt}
          placeholder='Describe the edit, e.g. "make it night time, add warm window light, light rain"'
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && prompt.trim()) onSubmit(model, prompt);
            if (e.key === "Escape") onClose();
          }}
        />
        <p className="hint">
          The current frame is sent as the reference image. Ctrl+Enter to submit.
          The edit runs in the background &mdash; you can close this and queue more.
          The previous version stays in this frame's history (use the arrows on the card).
        </p>
        <button
          className="prod-btn prod-edit-go"
          disabled={!prompt.trim()}
          onClick={() => onSubmit(model, prompt)}
        >
          Edit frame
        </button>
      </div>
    </div>
  );
}

/**
 * One brand-palette swatch row: color chip (opens the in-app picker) + a hex
 * text field that accepts pastes with or without the leading "#" and commits
 * live once the text is a complete color.
 */
function BrandSwatchRow({ index, value, onChange, onRemove }: {
  index: number;
  value: string;
  onChange: (hex: string) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Local edit draft so partial/untagged text can be typed freely; committed
  // to the production only once it forms a valid hex color.
  const [draft, setDraft] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const shown = draft ?? value;
  const chip = previewHex(shown) || previewHex(value);

  return (
    <div ref={rowRef} className="prod-brand-swatch" title={`Palette color ${index + 1} — pick or paste a hex value`}>
      <button
        type="button"
        className={"prod-brand-chip" + (chip ? "" : " empty")}
        style={chip ? { background: chip } : undefined}
        aria-label={`Palette color ${index + 1} picker`}
        onClick={() => setOpen((o) => !o)}
      />
      <input
        className="prod-brand-hex"
        value={shown}
        placeholder="#1A2B3C"
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          if (isCompleteHex(v)) onChange(normalizeHex(v));
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        aria-label={`Palette color ${index + 1} hex`}
      />
      <button className="prod-brand-remove" title="Remove this swatch" onClick={onRemove}>×</button>
      {open && (
        <BrandColorPicker
          value={value}
          onPick={(hex) => { onChange(hex); setDraft(null); }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * In-app color popover (matches the app's dark UI, unlike the native dialog):
 * a hex field (autofocused — hex is the default mode) above a saturation/
 * value square and hue slider. Drag commits on release; hex commits live.
 */
function BrandColorPicker({ value, onPick, onClose }: {
  value: string;
  onPick: (hex: string) => void;
  onClose: () => void;
}) {
  const initial = hexToHsv(value) ?? { h: 210, s: 0.57, v: 0.24 };
  const [hsv, setHsv] = useState(initial);
  const squareRef = useRef<HTMLDivElement>(null);
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;
  const draggingRef = useRef(false);

  const hex = hsvToHex(hsv.h, hsv.s, hsv.v);
  const commit = () => onPick(hsvToHex(hsvRef.current.h, hsvRef.current.s, hsvRef.current.v));

  const setFromSquare = (clientX: number, clientY: number) => {
    const el = squareRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const v = 1 - Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    setHsv((p) => ({ ...p, s, v }));
  };

  return (
    <div className="prod-color-pop">
      <input
        className="prod-color-hex"
        autoFocus
        defaultValue={hsvToHex(initial.h, initial.s, initial.v)}
        placeholder="1A2B3C or #1A2B3C"
        spellCheck={false}
        onChange={(e) => {
          if (isCompleteHex(e.target.value)) {
            const next = hexToHsv(e.target.value);
            if (next) setHsv(next);
          }
        }}
        onBlur={(e) => {
          const t = e.target.value;
          if (isCompleteHex(t)) onPick(normalizeHex(t));
          e.target.value = isCompleteHex(t) ? normalizeHex(t) : hex; // snap back when incomplete
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && isCompleteHex((e.target as HTMLInputElement).value)) {
            onPick(normalizeHex((e.target as HTMLInputElement).value));
          }
        }}
        aria-label="Hex color"
      />
      <div
        ref={squareRef}
        className="prod-color-sv"
        style={{ background: `linear-gradient(to top, #000, rgba(0, 0, 0, 0)), linear-gradient(to right, #fff, hsl(${Math.round(hsv.h)} 100% 50%))` }}
        onPointerDown={(e) => {
          e.preventDefault();
          draggingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          setFromSquare(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => { if (draggingRef.current) setFromSquare(e.clientX, e.clientY); }}
        onPointerUp={() => { draggingRef.current = false; commit(); }}
        onPointerCancel={() => { draggingRef.current = false; }}
        role="presentation"
      >
        <span
          className="prod-color-cursor"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
        />
      </div>
      <input
        type="range"
        className="prod-color-hue"
        min={0}
        max={359}
        value={Math.round(hsv.h)}
        onChange={(e) => setHsv((p) => ({ ...p, h: Number(e.target.value) }))}
        onPointerUp={commit}
        onKeyUp={commit}
        aria-label="Hue"
      />
      <div className="prod-color-row">
        <span className="prod-color-chip" style={{ background: hex }} />
        <span className="prod-color-value">{hex}</span>
        <button type="button" className="prod-color-done" onClick={() => { commit(); onClose(); }}>
          Done
        </button>
      </div>
    </div>
  );
}
