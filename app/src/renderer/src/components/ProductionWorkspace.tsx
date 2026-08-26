/**
 * Production Assistant workspace: production picker/creator on first entry,
 * then a 5-step pipeline view. Step 1 (script ingestion + shot table) is live;
 * later steps show their planned surface and keep persisted state (style).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Production, ProductionMeta, ProductionShot, OpenArtModelChoice, SuggestedReference, ReferenceCategory, CustomRef } from "../../../shared/ipc.js";
import { ShotTable } from "./ShotTable.js";

/** Hard cap on the Step 2 style set. */
const MAX_STYLES = 5;

const STEPS: { n: 1 | 2 | 3 | 4 | 5; title: string; desc: string }[] = [
  { n: 1, title: "Script", desc: "PDF / DOCX / Google Doc → two-column shot breakdown" },
  { n: 2, title: "Design", desc: "Master style + character consistency keys" },
  { n: 3, title: "Storyboards", desc: "Board frames per shot" },
  { n: 4, title: "Animatic", desc: "Timed pre-viz timeline" },
  { n: 5, title: "Assembly", desc: "Audio + final render + manifest" },
];

/** Renderer-side stable id for user-created characters/products/references. */
function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Coerce a color value for a native <input type="color"> value attribute. */
function colorInputValue(v: string): string {
  const t = String(v).trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(t)) return `#${t.split("").map((c) => c + c).join("").toLowerCase()}`;
  return "#000000";
}

/** Normalize an entered/pasted hex on blur: allow shorthand, fill to 6 hex. */
function normalizeHex(v: string): string {
  const t = String(v).trim().replace(/^#/, "");
  if (!t) return "";
  if (/^[0-9a-fA-F]{3}$/.test(t)) return `#${t.split("").map((c) => c + c).join("").toUpperCase()}`;
  if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t.toUpperCase()}`;
  return String(v).trim(); // not a full color yet — keep what they typed
}

interface LogLine {
  id: string;
  at: string;
  message: string;
  level: "info" | "error" | "done";
}

export function ProductionWorkspace() {
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
  // step 4: animatic timing
  const [timingBusy, setTimingBusy] = useState(false);
  // step 3: per-frame AI edit (modal open on this shot id); edits run in the
  // background so more can be queued while others generate.
  const [editShotId, setEditShotId] = useState<string | null>(null);
  const [editBusyIds, setEditBusyIds] = useState<string[]>([]);
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
    while (colors.length < 5) colors.push("");
    colors[idx] = value;
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

  /** Step 4: auto-time the animatic via one LLM call. */
  async function autoTime() {
    if (!prod || timingBusy) return;
    setTimingBusy(true); setErr(null);
    try {
      const next = await window.cascade.planAnimatic(prod.meta.id);
      setProd(next);
      void refreshList();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setTimingBusy(false);
    }
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

  /** Step 4: edit one shot's duration/transition in place (renderer-owned state). */
  function updateTiming(shotId: string, patch: Partial<Pick<ProductionShot, "durationSec" | "transition">>) {
    if (!prod) return;
    saveField({
      scenes: prod.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((s) => (s.id === shotId ? { ...s, ...patch } : s)),
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
              style in <em> Storyboards</em>. Style <strong>1</strong> is the default look for every frame.
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
                          title={`Style ${s.index} — shown in the Storyboards dropdown`}
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
            <button className="prod-btn" disabled={(prod.styles?.length ?? 0) >= MAX_STYLES} onClick={addStyle}>
              ＋ Add style
            </button>

            <div className="prod-brand">
              <label className="prod-label">Brand identity — global</label>
              <p className="hint">
                A palette (up to 5 swatches) and optional font appended to <strong>every</strong> style's prompt,
                so the brand look stays consistent across all frames.
              </p>
              <div className="prod-brand-swatches">
                {(prod.brand?.colors ?? []).slice(0, 5).map((c, i) => (
                  <div key={i} className="prod-brand-swatch" title={`Palette color ${i + 1} — pick or paste a hex value`}>
                    <input
                      type="color"
                      value={colorInputValue(c)}
                      onChange={(e) => setBrandColor(i, e.target.value)}
                      aria-label={`Palette color ${i + 1} picker`}
                    />
                    <input
                      className="prod-brand-hex"
                      value={c}
                      placeholder="#1A2B3C"
                      spellCheck={false}
                      onChange={(e) => setBrandColor(i, e.target.value)}
                      onBlur={(e) => setBrandColor(i, normalizeHex(e.target.value))}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      aria-label={`Palette color ${i + 1} hex`}
                    />
                    <button className="prod-brand-remove" title="Remove this swatch" onClick={() => removeBrandColor(i)}>×</button>
                  </div>
                ))}
                {(prod.brand?.colors ?? []).length < 5 && (
                  <button className="prod-brand-add" title="Add a palette swatch" onClick={() => setBrandColor((prod.brand?.colors ?? []).length, "#1A2B3C")}>＋</button>
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
            <h3>3 · Storyboards</h3>
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
                {boardsBusy ? "Generating…" : boardsDone ? "Generate missing frames" : "Generate storyboards"}
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
                    onRegenerate={() => void regenBoard(shot.id)}
                    onImport={() => void importFrames(shot.id)}
                    onEdit={() => setEditShotId(shot.id)}
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
            <StepFooter prod={prod} onNext={goNext} />
          </section>
        )}

        {prod.currentStep === 4 && (
          <section className="prod-panel">
            <h3>4 · Animatic</h3>
            <p className="hint">
              Per-shot screen time and transitions for the pre-viz timeline. Auto-time uses one model call;
              tweak any value by hand afterwards. The plan is written to <code>{prod.assets.outDir}/animatic.md</code>.
            </p>
            <div className="prod-boards-controls">
              <button className="primary" disabled={timingBusy || !shotCount} onClick={() => void autoTime()}>
                {timingBusy ? "Timing…" : anyTimed ? "Re-time via model" : "Auto-time via model"}
              </button>
              {anyTimed && <span className="hint">Total runtime ≈ {formatRuntime(totalRuntime)}</span>}
            </div>
            {err && <p className="error-text">{err}</p>}
            {visibleLog.length > 0 && <ProdLog lines={visibleLog} />}
            {shotCount > 0 && (
              <div className="prod-timeline">
                <div className="prod-timeline-row head">
                  <span>Shot</span>
                  <span>Audio / Visual</span>
                  <span>Seconds</span>
                  <span>Transition →</span>
                </div>
                {prod.scenes.flatMap((sc) => sc.shots).map((shot) => (
                  <div key={shot.id} className="prod-timeline-row">
                    <span className="prod-timeline-shotcell">
                      <AnimaticThumb prodId={prod.meta.id} shotId={shot.id} artwork={shot.artwork} />
                      <span className="shot-number" title={shot.id}>{shot.number}</span>
                    </span>
                    <span className="prod-timeline-desc" title={shot.visual}>{shot.audio || shot.visual || "—"}</span>
                    <span>
                      <input
                        className="prod-timeline-dur"
                        type="number" min={1.5} max={12} step={0.5}
                        value={shot.durationSec ?? 3}
                        onChange={(e) => updateTiming(shot.id, { durationSec: Math.max(1.5, Math.min(12, Number(e.target.value) || 3)) })}
                      />
                    </span>
                    <span>
                      <select
                        className="prod-timeline-tr"
                        value={shot.transition ?? "cut"}
                        onChange={(e) => updateTiming(shot.id, { transition: e.target.value as ProductionShot["transition"] })}
                      >
                        <option value="cut">Cut</option>
                        <option value="dissolve">Dissolve</option>
                        <option value="fade">Fade</option>
                        <option value="wipe">Wipe</option>
                      </select>
                    </span>
                  </div>
                ))}
              </div>
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
    </div>
  );
}

/** Step 4: small thumbnail of a shot's primary frame for the animatic
 *  timeline. Fetched on demand as a data URL, like the Step 3 contact sheet. */
function AnimaticThumb({ prodId, shotId, artwork }: { prodId: string; shotId: string; artwork?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    if (artwork) {
      window.cascade.boardThumbnail(prodId, shotId).then((d) => { if (live) setSrc(d); }).catch(() => {});
    }
    return () => { live = false; };
  }, [prodId, shotId, artwork]);
  if (!src) return <span className="prod-timeline-thumb blank" title="No frame yet — generate one in Storyboards" />;
  return <img className="prod-timeline-thumb" src={src} alt="Shot frame" title="Primary frame for this shot" />;
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
      <p className="hint">Materials, textures, mood shots, hero props — associate each to shots in Storyboards.</p>
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
function BoardCard({ prod, shot, bust, regenerating, onRegenerate, onImport, onEdit, onStyleChange, onPromptFocus, selected, onDropFrame, onPromoteHistory, onDelete }: {
  prod: Production;
  shot: ProductionShot;
  bust: number;
  regenerating: boolean;
  onRegenerate: () => void;
  onImport: () => void;
  /** Open the AI edit dialog for this frame. */
  onEdit: () => void;
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
  const [prompt, setPrompt] = useState<string>("");
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
        {shownImg ? (
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
        <button className="prod-board-zoom" title="Enlarge this frame" disabled={!img} onClick={(e) => { e.stopPropagation(); void window.cascade.boardImage(prod.meta.id, shot.id).then((full) => { if (full) { setExpandedImg(full); setExpanded(true); } }); }}>⌕</button>
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
      {expanded && expandedImg && (
        <div className="prod-ref-lightbox" onClick={() => setExpanded(false)}>
          <figure className="prod-ref-lightbox-card"><img src={expandedImg} alt={`Shot ${shot.number}`} /><figcaption>Shot {shot.number} — click anywhere to close</figcaption></figure>
        </div>
      )}
    </figure>
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
