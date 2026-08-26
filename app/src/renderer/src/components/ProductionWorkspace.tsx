/**
 * Production Assistant workspace: production picker/creator on first entry,
 * then a 5-step pipeline view. Step 1 (script ingestion + shot table) is live;
 * later steps show their planned surface and keep persisted state (style).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Production, ProductionMeta, ProductionShot, OpenArtModelChoice } from "../../../shared/ipc.js";
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
  function addRef(name: string, description: string) {
    if (!prod || !name.trim()) return;
    saveField({ references: [...(prod.references ?? []), { id: uid("ref"), name: name.trim(), description: description.trim() || undefined, shotIds: [] }] });
  }
  function removeRef(id: string) {
    if (!prod) return;
    saveField({ references: (prod.references ?? []).filter((r) => r.id !== id) });
  }
  /** Edit a custom reference's name/description prompt in place. */
  function updateRef(id: string, patch: Partial<{ name: string; description: string }>) {
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
  /** Associate/clear a custom reference on one shot (Step 3 board-card toggles). */
  function toggleShotRef(shotId: string, refId: string) {
    if (!prod) return;
    saveField({ references: (prod.references ?? []).map((r) => {
      if (r.id !== refId) return r;
      const has = (r.shotIds ?? []).includes(shotId);
      return { ...r, shotIds: has ? (r.shotIds ?? []).filter((id) => id !== shotId) : [...(r.shotIds ?? []), shotId] };
    }) });
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

  function regenBoard(shotId: string) {
    if (!prod) return;
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
  function updateShotStyle(shotId: string, styleId: string) {
    if (!prod) return;
    const styleText = (prod.styles ?? []).find((st) => st.id === styleId)?.prompt.trim() ?? "";
    saveField({
      scenes: prod.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((s) => {
          if (s.id !== shotId) return s;
          if (!(s.promptManual && s.prompt?.trim())) return { ...s, style: styleId || undefined };
          const para = styleText
            ? `Style: ${styleText}. Render consistently with the other shots in this production.`
            : "";
          // Replace the first "Style:" paragraph (up to a blank line); prepend
          // one when the manual prompt has no style section of its own.
          const rest = s.prompt.replace(/^Style:[\s\S]*?(?:\n\n|$)/, "");
          const next = para ? (rest.trim() ? `${para}\n\n${rest.trimEnd()}` : para) : s.prompt;
          return { ...s, style: styleId || undefined, prompt: next };
        }),
      })),
    });
  }

  /** Step 3: attach/detach a detected character/product reference to one shot.
   *  Auto-matched entries stay listed but can be unchecked (excluded) and
   *  re-checked; explicit picks toggle as before. */
  function toggleShotEntityRef(shotId: string, entityId: string) {
    if (!prod) return;
    saveField({
      scenes: prod.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((s) => {
          if (s.id !== shotId) return s;
          const excluded = s.refExcluded ?? [];
          const ids = s.refIds ?? [];
          const hay = `${s.audio} ${s.visual}`.toLowerCase();
          const isAuto = prod.characters.some((c) => c.id === entityId && c.name && hay.includes(c.name.toLowerCase()))
            || prod.products.some((pr) => pr.id === entityId && pr.name && hay.includes(pr.name.toLowerCase()));
          if (isAuto && !ids.includes(entityId)) {
            // Auto entry: toggling adds/removes it from the exclusion list so
            // the row stays visible for easy re-checking.
            return {
              ...s,
              refExcluded: excluded.includes(entityId)
                ? excluded.filter((i) => i !== entityId)
                : [...excluded, entityId],
              refIds: ids.filter((i) => i !== entityId),
            };
          }
          return { ...s, refIds: ids.includes(entityId) ? ids.filter((i) => i !== entityId) : [...ids, entityId] };
        }),
      })),
    });
  }

  /** Step 3: a completed frame dragged onto another frame's Refs button is
   *  attached as a brand-new custom reference associated with that shot. */
  async function dropFrameAsReference(shotId: string, source: { prodId: string; shotId: string; number: number }) {
    if (!prod) return;
    setErr(null);
    try {
      const dataUrl = await window.cascade.boardImage(source.prodId, source.shotId);
      if (!dataUrl) { setErr("Couldn't load the dropped frame."); return; }
      const num = String(source.number).padStart(4, "0");
      saveField({
        references: [...(prod.references ?? []), {
          id: uid("ref"),
          name: `Frame ${num}`,
          description: `Storyboard frame from shot ${source.number} — drop-attached as a reference`,
          artwork: dataUrl,
          shotIds: [shotId],
        }],
      });
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  /** Step 3: an image pasted from the clipboard becomes a brand-new custom
   *  reference associated with that shot. */
  function pasteFrameAsReference(shotId: string, dataUrl: string) {
    if (!prod || !dataUrl.startsWith("data:image/")) return;
    const num = prod.scenes.flatMap((sc) => sc.shots).find((s) => s.id === shotId)?.number;
    saveField({
      references: [...(prod.references ?? []), {
        id: uid("ref"),
        name: "Pasted ref",
        description: `Pasted from clipboard${num ? ` — attached to shot ${num}` : ""}`,
        artwork: dataUrl,
        shotIds: [shotId],
      }],
    });
  }

  /** Step 3: persist a shot's editable board-prompt override (empty clears it).
   *  The returned production is merged into renderer state immediately —
   *  otherwise the next saveField would write the stale pre-edit prompt back
   *  and silently revert the manual edit (and its refresh button). */
  async function saveShotPrompt(shotId: string, prompt: string) {
    if (!prod) return;
    try {
      const next = await window.cascade.updateBoardPrompt(prod.meta.id, shotId, prompt);
      setProd(next);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  /** Step 3: set/clear a per-frame prompt override for one reference on one
   *  shot (edited from the enlarged-reference lightbox). A blank value clears
   *  the override so the Design-page prompt applies again. */
  function setShotRefPrompt(shotId: string, refId: string, value: string) {
    if (!prod) return;
    saveField({
      scenes: prod.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((s) => {
          if (s.id !== shotId) return s;
          const ov = { ...(s.refPromptOverrides ?? {}) };
          if (value.trim()) ov[refId] = value;
          else delete ov[refId];
          return { ...s, refPromptOverrides: ov };
        }),
      })),
    });
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

            <RefSection
              title="Character references"
              items={prod.characters}
              emptyHint="No characters detected in the script yet — re-ingest the script or add a new character below."
              onAttach={(id) => void attachArtwork("characters", id)}
              onRemove={(id) => removeArtwork("characters", id)}
              onAdd={(name, key) => void addPerson(name, key)}
              addKind="character"
            />
            <RefSection
              title="Product references"
              items={prod.products}
              emptyHint="No products detected in the script yet — add a new product below."
              onAttach={(id) => void attachArtwork("products", id)}
              onRemove={(id) => removeArtwork("products", id)}
              onAdd={(name) => void addProduct(name)}
              addKind="product"
            />
            <CustomRefSection
              items={prod.references ?? []}
              onAdd={(name, desc) => void addRef(name, desc)}
              onAttach={(id) => void attachRefArtwork(id)}
              onRemoveImage={(id) => removeRefArtwork(id)}
              onRemove={(id) => removeRef(id)}
              onUpdate={updateRef}
            />

            <StepFooter prod={prod} onNext={goNext} />
          </section>
        )}

        {prod.currentStep === 3 && (
          <section className="prod-panel">
            <h3>3 · Storyboards</h3>
            <p className="hint">
              One frame per shot — the master style and character keys from Step 2 are baked into every prompt.
              Frames are saved to <code>{prod.assets.boardsDir}/</code> in the production folder.
              {openArtOk === true && " In-app generation uses the connected OpenArt MCP server."}
              {openArtOk === false && (
                <> OpenArt MCP isn't connected, so frames are made externally: <strong>Export prompts</strong>, generate an image per shot anywhere, name each file with its shot number (e.g. <code>0100.png</code>), then <strong>Import frames…</strong> (or drop them in <code>{prod.assets.boardsDir}/import/</code> and scan).</>
              )}
            </p>
            <div className="prod-boards-controls">
              <label className="prod-openart-label">Model
                <select
                  className="prod-openart-select"
                  value={prod.openArt?.model ?? "auto"}
                  onChange={(e) => saveField({ openArt: { model: e.target.value, resolution: prod.openArt?.resolution ?? "1k" } })}
                  title="OpenArt model for in-app generation (Auto lets Cascade choose)"
                >
                  {openArtModels.length === 0 && <option value="auto">Auto</option>}
                  {openArtModels.map((m) => (
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
              <button disabled={boardsBusy || importBusy || !shotCount} onClick={() => void importFrames()} title="Pick externally generated frames; filenames must contain the shot number (e.g. 0100.png)">
                {importBusy ? "Importing…" : "Import frames…"}
              </button>
              <button disabled={boardsBusy || importBusy || !shotCount} onClick={() => void scanImportFolder()} title={`Import every shot-numbered image in ${prod.assets.boardsDir}/import/`}>
                Scan import folder
              </button>
              <span className="hint">{boardsDone}/{shotCount} shots have frames</span>
            </div>
            {err && <p className="error-text">{err}</p>}
            {visibleLog.length > 0 && <ProdLog lines={visibleLog} />}
            {shotCount > 0 && (
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
                    onToggleRef={(refId) => toggleShotRef(shot.id, refId)}
                    onToggleEntityRef={(entityId) => toggleShotEntityRef(shot.id, entityId)}
                    onStyleChange={(style) => updateShotStyle(shot.id, style)}
                    onPromptChange={(shotId, prompt) => void saveShotPrompt(shotId, prompt)}
                    onRefPromptChange={(shotId, refId, value) => setShotRefPrompt(shotId, refId, value)}
                    onRefreshPrompt={() =>
                      apply(window.cascade.refreshBoardPrompt(prod.meta.id, shot.id))
                    }
                    onDropFrame={(source) => void dropFrameAsReference(shot.id, source)}
                    onPasteRef={(dataUrl) => pasteFrameAsReference(shot.id, dataUrl)}
                  />
                ))}
              </div>
            )}
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
                    <span className="shot-number" title={shot.id}>{shot.number}</span>
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

/** Step 2: user-created references (materials, textures, mood, hero props),
 *  each with an editable name + description prompt (persisted as you type),
 *  optional artwork, and remove. */
function CustomRefSection({ items, onAdd, onAttach, onRemoveImage, onRemove, onUpdate }: {
  items: (RefItem & { description?: string })[];
  onAdd: (name: string, description: string) => void;
  onAttach: (id: string) => void;
  onRemoveImage: (id: string) => void;
  onRemove: (id: string) => void;
  /** Rename a reference or adjust its description prompt in place. */
  onUpdate: (id: string, patch: Partial<{ name: string; description: string }>) => void;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [picked, setPicked] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    onAdd(name, desc);
    setName(""); setDesc(""); setPicked("");
  };
  return (
    <div className="prod-refs">
      <label className="prod-label">Custom references</label>
      <p className="hint">Materials, textures, mood shots, hero props — associate each to shots in Storyboards.</p>
      <div className="prod-ref-grid">
        {items.map((i) => (
          <figure key={i.id} className="prod-ref">
            {i.artwork ? <img src={i.artwork} alt={i.name} /> : <div className="prod-ref-blank">{i.description ? "ref" : "…"}</div>}
            <figcaption>
              <input
                className="prod-ref-name prod-ref-edit-name"
                value={i.name}
                placeholder="Reference name"
                onChange={(e) => onUpdate(i.id, { name: e.target.value })}
                title="Rename this reference"
              />
              <textarea
                className="prod-ref-desc prod-ref-edit-desc"
                value={i.description ?? ""}
                placeholder="Prompt / description (e.g. Use for material and texture reference)"
                onChange={(e) => onUpdate(i.id, { description: e.target.value })}
                title="Adjust this reference's prompt"
                rows={2}
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
        <input className="prod-ref-new-key" placeholder="Description (e.g. Use for material and texture reference)" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <button className="prod-btn" disabled={!name.trim()} onClick={submit}>＋ Add reference…</button>
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

/** mm:ss label for the Step 4 runtime. */
function formatRuntime(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** One storyboard frame in the Step 3 contact sheet. The PNG lives in the
 *  production folder; the thumbnail is fetched on demand as a data URL. */
function BoardCard({ prod, shot, bust, regenerating, onRegenerate, onImport, onEdit, onToggleRef, onToggleEntityRef, onStyleChange, onPromptChange, onRefPromptChange, onRefreshPrompt, onDropFrame, onPasteRef }: {
  prod: Production;
  shot: ProductionShot;
  bust: number;
  regenerating: boolean;
  onRegenerate: () => void;
  onImport: () => void;
  /** Open the AI edit dialog for this frame. */
  onEdit: () => void;
  onToggleRef: (refId: string) => void;
  /** Attach/detach a detected character/product reference to this frame. */
  onToggleEntityRef: (entityId: string) => void;
  onStyleChange: (style: string) => void;
  onPromptChange: (shotId: string, prompt: string) => void;
  /** Set/clear a per-frame prompt override for one reference on this shot
   *  (blank clears it — the Design-page prompt applies again). */
  onRefPromptChange: (shotId: string, refId: string, value: string) => void;
  /** Discard the manual prompt and re-derive it from the current design. */
  onRefreshPrompt: () => void;
  /** Attach a frame dragged from another card as a reference on this shot. */
  onDropFrame: (source: { prodId: string; shotId: string; number: number }) => void;
  /** Attach an image pasted from the clipboard as a reference on this shot. */
  onPasteRef: (dataUrl: string) => void;
}) {
  const [img, setImg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showRefs, setShowRefs] = useState(false);
  const [expandedRef, setExpandedRef] = useState<{ id: string; name: string; artwork: string; defaultText?: string } | null>(null);
  const [expanded, setExpanded] = useState(false); // enlarged frame lightbox
  const [promptOpen, setPromptOpen] = useState(false); // full editor drawer
  // True while a dragged board frame hovers over this card's Refs button.
  const [refDragOver, setRefDragOver] = useState(false);
  const [prompt, setPrompt] = useState<string>("");
  // Frame history browsing: null = current frame; otherwise an index into
  // shot.artworkHistory (0 = most recent previous frame). Thumbnails are
  // fetched lazily and cached per index.
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [histCache, setHistCache] = useState<Record<string, string>>({});
  const histLen = shot.artworkHistory?.length ?? 0;
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setImg(null);
    setHistIdx(null);
    setHistCache({});
    if (shot.artwork) {
      window.cascade.boardImage(prod.meta.id, shot.id).then((d) => { if (live) setImg(d); }).catch(() => {});
    }
    return () => { live = false; };
  }, [prod.meta.id, shot.id, shot.artwork, bust]);

  // Lazily load the history frame being viewed.
  useEffect(() => {
    if (histIdx === null) return;
    let live = true;
    const key = String(histIdx);
    if (!histCache[key]) {
      window.cascade.boardImage(prod.meta.id, shot.id, histIdx)
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
    (prod.references ?? []).map((r) => [(r.shotIds ?? []).includes(shot.id), r.name, r.description]),
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

  const activeRefs = (prod.references ?? []).filter((r) => (r.shotIds ?? []).includes(shot.id));

  // Paste support: with this card's refs menu open, an image on the clipboard
  // (copied anywhere — browser, editor, screenshot tool) is attached as a new
  // reference for this shot.
  useEffect(() => {
    if (!showRefs) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") onPasteRef(reader.result);
        };
        reader.readAsDataURL(file);
        return;
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRefs]);

  // Detected references for this frame: Step 2 character/product references
  // either auto-matched by name in the shot's text or explicitly attached via
  // the refs menu. All appear as thumbnails; auto-matches are pinned on.
  const hay = `${shot.audio} ${shot.visual}`.toLowerCase();
  const entityRefs = [
    ...prod.characters.map((c) => ({ id: c.id, name: c.name, artwork: c.artwork, defaultText: c.key })),
    ...prod.products.map((pr) => ({ id: pr.id, name: pr.name, artwork: pr.artwork, defaultText: undefined as string | undefined })),
  ]
    .filter((r) => r.name)
    .map((r) => ({
      ...r,
      auto: !!(r.artwork && hay.includes(r.name.toLowerCase())),
      picked: (shot.refIds ?? []).includes(r.id),
      excluded: (shot.refExcluded ?? []).includes(r.id),
    }))
    .filter((r) => r.auto || r.picked || r.excluded);
  const customThumbRefs = activeRefs.filter((r) => r.artwork);
  const activeRefCount = entityRefs.filter((r) => (r.auto && !r.excluded) || r.picked).length + activeRefs.length;
  async function copyPrompt() {
    try {
      const prompt = await window.cascade.getBoardPrompt(prod.meta.id, shot.id);
      if (prompt) {
        await navigator.clipboard.writeText(prompt);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }
    } catch { /* clipboard may be unavailable — fail silently */ }
  }

  /** Update the local editor and persist the override after a short debounce. */
  function handlePromptEdit(value: string) {
    setPrompt(value);
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => onPromptChange(shot.id, value), 450);
  }

  return (
    <figure className="prod-board">
      <div className="prod-board-frame">
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
        {shownImg ? (
          <img
            src={shownImg}
            alt={`Shot ${shot.number}`}
            className="prod-board-frame-img"
            onClick={() => setExpanded(true)}
            onDragStart={(e) => {
              // Carry this frame's identity so another card's Refs button can
              // accept it as a reference (see the drop handler below).
              e.dataTransfer.setData(
                "application/x-cascade-frame",
                JSON.stringify({ prodId: prod.meta.id, shotId: shot.id, number: shot.number }),
              );
              e.dataTransfer.effectAllowed = "copy";
            }}
            title="Click to enlarge — or drag onto another frame's Refs button to use it as a reference"
          />
        ) : (
          <span className="prod-board-empty">{shot.artwork ? "…" : "no frame"}</span>
        )}
        <button
          className="prod-board-copy"
          title="Copy this shot's generation prompt"
          onClick={() => void copyPrompt()}
        >
          {copied ? "✓" : "⧉"}
        </button>
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
        <button
          className="prod-board-import"
          title="Import an externally generated frame for this shot"
          disabled={regenerating}
          onClick={onImport}
        >
          ⤒
        </button>
      </div>
      <figcaption>
        <span className="shot-number">{shot.number}</span>
        {shot.promptManual && (
          <button
            className="prod-board-prompt-refresh"
            title="Manually edited — click to discard this prompt and re-derive it from the current design"
            onClick={onRefreshPrompt}
          >
            ↻ refresh
          </button>
        )}
        <span className="prod-board-prompt-wrap">
          <textarea
            className="prod-board-prompt"
            rows={3}
            value={prompt}
            placeholder="Generation prompt — edit to override; used on regenerate/export"
            onChange={(e) => handlePromptEdit(e.target.value)}
          />
          <button
            className="prod-board-prompt-open"
            title="Open the full prompt in the editor"
            onClick={() => setPromptOpen(true)}
          >⛶</button>
        </span>
      </figcaption>
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
      {(entityRefs.length > 0 || customThumbRefs.length > 0) && (
        <div className="prod-board-autorefs" title="References applied to this frame (auto-matched, attached, or custom)">
          {entityRefs.map((r) => (
            <button key={r.id} className={"prod-board-autoref" + ((r.auto && r.excluded) ? " excluded" : "") + (r.picked && !r.auto ? " picked" : "")} title={`${r.name}${r.auto ? " (auto-matched)" : " (attached)"} — click to enlarge and edit its prompt for this frame`} onClick={() => r.artwork && setExpandedRef({ id: r.id, name: r.name, artwork: r.artwork, defaultText: r.defaultText })}>
              {r.artwork ? <img src={r.artwork} alt={r.name} /> : <span className="prod-board-autoref-blank">?</span>}
            </button>
          ))}
          {customThumbRefs.map((r) => (
            <button key={r.id} className="prod-board-autoref custom" title={`${r.name} (custom reference) — click to enlarge and edit its prompt for this frame`} onClick={() => setExpandedRef({ id: r.id, name: r.name, artwork: r.artwork!, defaultText: r.description })}>
              <img src={r.artwork} alt={r.name} />
            </button>
          ))}
        </div>
      )}
      <div className="prod-board-refs">
        <button
          className={"prod-board-refbtn" + (activeRefCount ? " has" : "") + (refDragOver ? " dragover" : "")}
          onClick={() => setShowRefs((v) => !v)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("application/x-cascade-frame")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setRefDragOver(true);
          }}
          onDragLeave={() => setRefDragOver(false)}
          onDrop={(e) => {
            setRefDragOver(false);
            const raw = e.dataTransfer.getData("application/x-cascade-frame");
            if (!raw) return;
            e.preventDefault();
            try {
              const src = JSON.parse(raw) as { prodId: string; shotId: string; number: number };
              if (src.shotId === shot.id) return; // dropping a frame on itself is a no-op
              void onDropFrame(src);
            } catch { /* malformed drag payload — ignore */ }
          }}
          title="Manage the references applied to this frame — or drop another frame here to use it as a reference"
        >
          Refs{activeRefCount ? ` · ${activeRefCount}` : ""}
        </button>
        {showRefs && (
          <div className="prod-board-refmenu">
            {(() => {
              const withArt = [
                ...prod.characters.filter((c) => c.name).map((c) => ({ id: c.id, name: c.name, auto: !!(c.artwork && hay.includes(c.name.toLowerCase())), excluded: (shot.refExcluded ?? []).includes(c.id) })),
                ...prod.products.filter((pr) => pr.name).map((pr) => ({ id: pr.id, name: pr.name, auto: !!(pr.artwork && hay.includes(pr.name.toLowerCase())), excluded: (shot.refExcluded ?? []).includes(pr.id) })),
              ];
              const withoutArt = [
                ...prod.characters.filter((c) => c.name && !c.artwork).map((c) => c.name),
                ...prod.products.filter((pr) => pr.name && !pr.artwork).map((pr) => pr.name),
              ];
              return (
                <>
                  <div className="prod-board-refgroup">Detected — characters &amp; products</div>
                  {withArt.length === 0 && <div className="hint">None detected yet.</div>}
                  {withArt.map((r) => (
                    <label key={r.id} className="prod-board-refopt" title={r.auto ? `${r.name} — auto-matched by name (always on)` : `Attach ${r.name} as a reference for this frame`}>
                      <input
                        type="checkbox"
                        checked={(r.auto && !(shot.refExcluded ?? []).includes(r.id)) || (shot.refIds ?? []).includes(r.id)}
                        onChange={() => onToggleEntityRef(r.id)}
                      />
                      {r.name}{r.auto ? " ·auto" : ""}
                    </label>
                  ))}
                  {withoutArt.length > 0 && (
                    <div className="hint">No image attached: {withoutArt.join(", ")} — add one in Design.</div>
                  )}
                  <div className="prod-board-refgroup">Custom references</div>
                </>
              );
            })()}
            {(prod.references ?? []).length === 0 && (
              <div className="hint">No custom references yet — add them in Design.</div>
            )}
            {(prod.references ?? []).map((r) => (
              <label key={r.id} className="prod-board-refopt" title={r.description}>
                <input
                  type="checkbox"
                  checked={(r.shotIds ?? []).includes(shot.id)}
                  onChange={() => onToggleRef(r.id)}
                />
                {r.name}
              </label>
            ))}
          </div>
        )}
      </div>
      {expandedRef && (
        <div className="prod-ref-lightbox" onClick={() => setExpandedRef(null)}>
          <figure className="prod-ref-lightbox-card">
            <img src={expandedRef.artwork} alt={expandedRef.name} />
            <figcaption>{expandedRef.name}</figcaption>
            <div className="prod-ref-prompt" onClick={(e) => e.stopPropagation()}>
              <textarea
                className="prod-ref-prompt-input"
                rows={3}
                value={shot.refPromptOverrides?.[expandedRef.id] ?? ""}
                placeholder={expandedRef.defaultText?.trim()
                  ? `Design prompt: ${expandedRef.defaultText.trim()}`
                  : "No prompt set in Design — type one here"}
                title="Prompt for this reference on this frame only — leave blank to use the Design-page prompt"
                onChange={(e) => onRefPromptChange(shot.id, expandedRef.id, e.target.value)}
              />
              <span className="hint">Leave blank to fall back to this reference's Design-page prompt.</span>
            </div>
          </figure>
        </div>
      )}
      {expanded && img && (
        <div className="prod-ref-lightbox" onClick={() => setExpanded(false)}>
          <figure className="prod-ref-lightbox-card">
            <img src={img} alt={`Shot ${shot.number}`} />
            <figcaption>Shot {shot.number} — click anywhere to close</figcaption>
          </figure>
        </div>
      )}
      {promptOpen && (
        <div className="prod-prompt-drawer" onClick={() => setPromptOpen(false)}>
          <div className="prod-prompt-drawer-panel" onClick={(e) => e.stopPropagation()}>
            <div className="prod-prompt-drawer-head">
              <span className="prod-prompt-drawer-title">Shot {shot.number} — generation prompt</span>
              <button className="prod-btn" onClick={() => setPromptOpen(false)}>Done</button>
            </div>
            <textarea
              className="prod-prompt-drawer-text"
              autoFocus
              value={prompt}
              placeholder="Generation prompt — edit to override; used on regenerate/export"
              onChange={(e) => handlePromptEdit(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setPromptOpen(false); }}
            />
            <div className="prod-prompt-script">
              <span className="prod-prompt-script-title">Visual direction from the script</span>
              <div className="prod-prompt-script-body" title="Read-only — extracted from the ingested script">
                {shot.visual || <em>No visual direction recorded for this shot.</em>}
                {shot.audio && <p className="prod-prompt-script-audio">Audio: {shot.audio}</p>}
              </div>
            </div>
            <div className="prod-prompt-drawer-foot">
              <span className="hint">Changes are saved automatically as you edit, and drive this frame's regenerate/export. Press Done (or the Esc key / click outside) to close.</span>
            </div>
          </div>
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
