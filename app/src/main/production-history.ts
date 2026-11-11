/**
 * App-wide undo/redo — the main-process document history service.
 *
 * One snapshot history per production, fed by the ONE write funnel every
 * document mutation already passes through (`productions.saveProduction`,
 * via the hook registered in `installProductionHistory`): renderer
 * whole-document saves, narrow commands (graph fields/layout, prompts),
 * structural commands (insert/delete/reorder/rename), agent production
 * tools, and rebased generation commits all land here exactly once per
 * persisted write. That funnel is the Item 3 audit answer: a mutation
 * path cannot bypass history without bypassing persistence itself.
 *
 * History is in-memory and session-scoped (v1, flagged judgment call 2).
 * Restores write the snapshot back through `saveProduction` (suppressed,
 * so a restore is not itself a step) after reconciling board folders on
 * disk, and never touch generated files, credits, or the job ledger
 * (Item 4): undo only re-registers/unregisters media in the document,
 * and files a deletion parked in the undo trash move back with their
 * registration.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Production, ProductionShot } from "../shared/ipc.js";
import {
  createDocumentHistory,
  projectForHistory,
  mergeRestoredProduction,
  type DocumentHistory,
  type HistoryCommitMeta,
  type ProductionHistoryState,
} from "../shared/production-history.js";
import {
  loadProduction,
  saveProduction,
  setProductionHistoryHook,
  type ProductionFile,
} from "./productions.js";
import {
  assetPath,
  deleteShotBoards,
  mediaFiles,
  moveShotMediaDir,
  outdatedRemovedDir,
  productionMediaRefs,
  relocateBoardsForRenumber,
  restoreBoardOriginalFromTrash,
  scriptMarkdown,
  shotMediaRefs,
  undoTrashDir,
} from "./pipeline.js";

export type { ProductionHistoryState } from "../shared/production-history.js";

interface PerProduction {
  hist: DocumentHistory<Production>;
  /** The disk `rev` the current snapshot was taken at. Repairs never
   *  bump `rev`; every persisted write does — that is how a load-time
   *  repair (sync, no step) is told from an external rewrite (reset). */
  lastRev: number;
  restoring: boolean;
}

const states = new Map<string, PerProduction>();

/** One-shot commit meta for the NEXT save of a production, for call
 *  sites whose save goes through a shared helper (`mutateShots`, the
 *  graph commands) that cannot thread a parameter to the write. The
 *  setters run synchronously immediately before that save. */
const pendingMeta = new Map<string, HistoryCommitMeta>();

export function setNextHistoryMeta(id: string, meta?: HistoryCommitMeta): void {
  if (meta) pendingMeta.set(id, meta);
}
let stateListener: ((id: string, state: ProductionHistoryState) => void) | null = null;
let installed = false;

function proj(p: Production): Production {
  return projectForHistory(structuredClone(p) as Production);
}

function emit(id: string): void {
  if (!stateListener) return;
  try {
    stateListener(id, historyState(id));
  } catch { /* a listener must never break a save */ }
}

/** First touch of a production this session: nothing on disk that a
 *  previous session parked for undo (trashed media files, removed
 *  outdated folders) is reachable by this session's fresh history, so
 *  the deferred deletions complete here. */
function purgeDeferredDeletions(p: Production): void {
  mediaFiles.purgeTrash(p, undoTrashDir(p));
  try {
    fs.rmSync(assetPath(p, `${p.assets.boardsDir}/outdated-removed`), { recursive: true, force: true });
  } catch { /* nothing parked */ }
}

function seed(id: string, doc: ProductionFile): PerProduction {
  const st: PerProduction = {
    hist: createDocumentHistory<Production>(),
    lastRev: typeof doc.rev === "number" ? doc.rev : 0,
    restoring: false,
  };
  st.hist.init(proj(doc));
  states.set(id, st);
  purgeDeferredDeletions(doc);
  return st;
}

/** Register the save/load hook. Idempotent; called once from main
 *  startup (and by tests that drive the real persistence funnel). */
export function installProductionHistory(
  onState?: (id: string, state: ProductionHistoryState) => void
): void {
  if (onState) stateListener = onState;
  if (installed) return;
  installed = true;
  setProductionHistoryHook({
    onLoaded(cached) {
      const id = cached.meta.id;
      const rev = typeof cached.rev === "number" ? cached.rev : 0;
      const st = states.get(id);
      if (st?.restoring) return;
      if (!st) {
        seed(id, cached);
        emit(id);
        return;
      }
      if (rev === st.lastRev) {
        // Read-repair only (media bootstrap, graph ensure): fold into
        // the current snapshot — never a step, never a reset.
        st.hist.syncCurrent(proj(cached));
      } else {
        // The file moved outside `saveProduction` (schema migration's
        // direct store write, or an external JSON edit): prior snapshots
        // no longer describe this document's lineage — start over.
        st.hist.reset(proj(cached));
        st.lastRev = rev;
        emit(id);
      }
    },
    onSaved(after, meta?: HistoryCommitMeta) {
      const id = after.meta.id;
      const pending = pendingMeta.get(id);
      pendingMeta.delete(id);
      meta = meta ?? pending;
      const rev = typeof after.rev === "number" ? after.rev : 0;
      const st = states.get(id);
      if (!st) {
        // First write ever seen (creation/import): seed, no entry.
        seed(id, after);
        emit(id);
        return;
      }
      if (st.restoring || meta?.suppress) {
        st.lastRev = rev;
        return;
      }
      if (rev !== st.lastRev + 1) {
        // A writer persisted from a stale base (its rev did not advance
        // ours by one): the lineage is uncertain — reset rather than
        // stack a snapshot that might not restore cleanly.
        st.hist.reset(proj(after));
        st.lastRev = rev;
        emit(id);
        return;
      }
      st.hist.record(proj(after), meta);
      st.lastRev = rev;
      emit(id);
    },
    onRemoved(id) {
      states.delete(id);
      emit(id);
    },
  });
}

/** Test seam: forget all session history (the hook stays installed). */
export function resetProductionHistoryForTests(): void {
  states.clear();
}

export function historyState(id: string): ProductionHistoryState {
  const st = states.get(id);
  return {
    canUndo: st?.hist.canUndo() ?? false,
    canRedo: st?.hist.canRedo() ?? false,
    depth: st?.hist.size ?? 0,
  };
}

// ---- restore: board-folder reconciliation ---------------------------------
//
// A snapshot restore must leave document and disk agreeing, using the
// same folder machinery the forward operations use:
// - a shot leaving the storyboard archives its folder exactly like a
//   delete (`deleteShotBoards` → `boards/outdated/<id>/`, recoverable);
// - a shot (re)entering the storyboard moves its archived folder back
//   to `boards/<number>/`;
// - a permanently removed outdated panel parks under
//   `boards/outdated-removed/<id>/` (and returns from there);
// - number changes ride `relocateBoardsForRenumber` (journaled, with
//   its own rollback), so inner `shot-<number>-` filenames and the
//   media registry follow.
// Undo is LIFO, so at restore time the disk is in the post-operation
// state of the step being undone — destinations are free unless an
// external actor moved files, in which case the restore throws and
// history is left untouched.

type Place = "scene" | "outdated";

function shotIndex(p: Production): Map<string, { shot: ProductionShot; place: Place }> {
  const out = new Map<string, { shot: ProductionShot; place: Place }>();
  for (const sc of p.scenes ?? []) for (const s of sc.shots ?? []) out.set(s.id, { shot: s, place: "scene" });
  for (const s of p.outdatedShots ?? []) out.set(s.id, { shot: s, place: "outdated" });
  return out;
}

function reconcileBoardFolders(work: Production, cur: Production): void {
  const boardsDir = work.assets.boardsDir;
  const curIdx = shotIndex(cur);
  const workIdx = shotIndex(work);
  const exists = (rel: string): boolean => {
    try { return fs.existsSync(assetPath(work, rel)); } catch { return false; }
  };

  // 1. Shots leaving the storyboard (deleted again on redo, archived to
  //    the outdated bucket, or un-inserted on undo): archive the folder.
  for (const [id, c] of curIdx) {
    if (c.place !== "scene") continue;
    if (workIdx.get(id)?.place === "scene") continue;
    deleteShotBoards(work, c.shot);
  }
  // 1b. Outdated panels leaving the document entirely (redo of a
  //     permanent removal): park the folder like the forward removal.
  for (const [id, c] of curIdx) {
    if (c.place !== "outdated" || workIdx.has(id)) continue;
    const parkedRel = outdatedRemovedDir(work, id);
    try { fs.rmSync(assetPath(work, parkedRel), { recursive: true, force: true }); } catch { /* stale park */ }
    moveShotMediaDir(work, c.shot, `${boardsDir}/outdated/${id}`, parkedRel, c.shot.number, c.shot.number);
  }
  // 2. Shots (re)entering the storyboard: bring the archived folder
  //    back to the shot's numbered home. Snapshot paths already point
  //    there (archive moves keep number + inner filenames), so the move
  //    makes disk match document; the registry remaps with it.
  for (const [id, w] of workIdx) {
    if (w.place !== "scene") continue;
    if (curIdx.get(id)?.place === "scene") continue;
    const dest = `${boardsDir}/${w.shot.number}`;
    const candidates = [
      `${boardsDir}/outdated/${id}`,
      ...[2, 3, 4, 5].map((n) => `${boardsDir}/outdated/${id}-${n}`),
      outdatedRemovedDir(work, id),
    ];
    const from = candidates.find((rel) => rel !== dest && exists(rel));
    if (!from) continue; // text-only shot: nothing on disk to bring back
    if (exists(dest)) {
      throw new Error(
        `Can't restore shot ${w.shot.number}: its board folder ${dest} is occupied. Move it aside and try again.`
      );
    }
    moveShotMediaDir(work, w.shot, from, dest, w.shot.number, w.shot.number);
  }
  // 3. Outdated panels returning from a permanent removal: un-park.
  for (const [id, w] of workIdx) {
    if (w.place !== "outdated" || curIdx.has(id)) continue;
    const from = outdatedRemovedDir(work, id);
    const dest = `${boardsDir}/outdated/${id}`;
    if (!exists(from) || exists(dest)) continue;
    moveShotMediaDir(work, w.shot, from, dest, w.shot.number, w.shot.number);
  }
  // 4. Renumbers among shots active on both sides. `promptOverrides` in
  //    the snapshot is already keyed by the target numbers, so it steps
  //    aside while relocate remaps folders/registry from current→target.
  const oldNumbers = new Map<string, string>();
  for (const [id, w] of workIdx) {
    if (w.place !== "scene") continue;
    const c = curIdx.get(id);
    if (c?.place === "scene") oldNumbers.set(id, c.shot.number);
  }
  const overrides = work.promptOverrides;
  relocateBoardsForRenumber(work, oldNumbers);
  work.promptOverrides = overrides;
}

/** Put back media bytes a deletion parked in the undo trash, for every
 *  path the restored document references but disk no longer has. Also
 *  repairs delete-strays: files `deleteShotBoards` gathered into the
 *  archive folder root whose document paths live elsewhere. */
function rehydrateTrashedMedia(work: Production): void {
  const trash = undoTrashDir(work);
  const refs = productionMediaRefs(work);
  // The storyboard-PDF logo is not part of the media registry's ref
  // list, but its clear operation trashes recoverably like the rest.
  if (work.storyboardPdf?.logoRel) refs.push(work.storyboardPdf.logoRel);
  for (const rel of refs) {
    let present = false;
    try { present = fs.existsSync(assetPath(work, rel)); } catch { present = false; }
    if (present) continue;
    if (mediaFiles.restoreTrashedFile(work, rel, trash)) {
      restoreBoardOriginalFromTrash(work, rel);
    }
  }
  const boardsDir = work.assets.boardsDir;
  const shots = [
    ...(work.scenes ?? []).flatMap((s) => s.shots ?? []),
    ...(work.outdatedShots ?? []),
  ];
  for (const shot of shots) {
    const homes = [`${boardsDir}/${shot.number}`, `${boardsDir}/outdated/${shot.id}`];
    for (const rel of shotMediaRefs(shot)) {
      try {
        if (fs.existsSync(assetPath(work, rel))) continue;
      } catch { continue; }
      const base = rel.split("/").pop();
      if (!base) continue;
      for (const home of homes) {
        const candidate = `${home}/${base}`;
        if (candidate === rel) continue;
        try {
          if (!fs.existsSync(assetPath(work, candidate))) continue;
          fs.mkdirSync(path.dirname(assetPath(work, rel)), { recursive: true });
          fs.renameSync(assetPath(work, candidate), assetPath(work, rel));
          break;
        } catch { /* leave it missing; the registry badge will say so */ }
      }
    }
  }
}

function restore(id: string, direction: "undo" | "redo"): ProductionFile | null {
  const st = states.get(id);
  if (!st) return null;
  const target = direction === "undo" ? st.hist.peekUndo() : st.hist.peekRedo();
  if (!target) return null;
  st.restoring = true;
  try {
    const cur = loadProduction(id);
    if (!cur) return null;
    const work = mergeRestoredProduction(target, cur) as ProductionFile;
    reconcileBoardFolders(work, cur);
    rehydrateTrashedMedia(work);
    // Keep the human-readable script in sync, like every structural edit.
    if (work.scenes.some((s) => s.shots.length)) {
      try {
        fs.writeFileSync(assetPath(work, work.assets.scriptMd), scriptMarkdown(work.meta.name, work.scenes), "utf8");
      } catch { /* folder moved — non-fatal */ }
    }
    saveProduction(work, { suppress: true });
    const fresh = loadProduction(id) ?? work;
    if (direction === "undo") st.hist.commitUndo(proj(fresh));
    else st.hist.commitRedo(proj(fresh));
    st.lastRev = typeof fresh.rev === "number" ? fresh.rev : st.lastRev;
    emit(id);
    return fresh;
  } finally {
    st.restoring = false;
  }
}

/** Undo one document step. Returns the restored production, or null
 *  when there is nothing to undo. Throws (history untouched) when the
 *  on-disk folders conflict with the restore. Callers serialize per
 *  production (the IPC handler rides the production queue). */
export function undoProduction(id: string): ProductionFile | null {
  return restore(id, "undo");
}

export function redoProduction(id: string): ProductionFile | null {
  return restore(id, "redo");
}
