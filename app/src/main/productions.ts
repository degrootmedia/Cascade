/**
 * Production persistence: one JSON file per production under
 * userData/productions/, mirroring the sessions.ts pattern. The production's
 * own folder (anywhere on disk) holds generated assets; this file holds the
 * pipeline state. The document lifecycle is the shared store; this module owns
 * the normalize-on-read pass and the asset-folder scaffolding.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { CameraGridData, Graph, GraphEditNode, Production, ProductionMeta, ProductionShot, TweenBlock, UpscaleData }
from "../shared/ipc.js";
import { sanitizeGenParams } from "../shared/ipc.js";
import { migrateBoardArtworkToJpeg, migrateEditNodes, migrateGraphGenerations,
relocateBoardLayout, relocateVideoLayout, migrateReferenceArtwork, syncBoardOutputToPipe, syncTweenBlocks, assetPath }
from "./pipeline.js";
import { materializeGraph, type GraphRefView } from "../shared/graph/materialize.js";
import { normalizeGraph } from "../shared/graph/normalize.js";
import { brandEdgePresent, resolveNodeStyleText, styleEdgePresent, type StylePromptTarget } from "../shared/graph/render.js";
import { hasBrandParagraph, parsePromptBoxes, stripBrandParagraph, stripStyleParagraph } from "../shared/prompt-grammar.js";
import { createStore } from "./store.js";
import { archiveSuiteSession, removeSuiteSession } from "./suite.js";

export interface ProductionFile extends Production {}

/** Back-fill fields so older files keep parsing as the schema grows. */
function normalize(p: ProductionFile): ProductionFile {
  if (!p.meta || !p.meta.id || !p.meta.folder) throw new Error("corrupt production file");
  p.scenes ??= [];
  p.characters ??= [];
  p.products ??= [];
  p.references ??= [];
  p.references = p.references.map((r) => {
    const clean = { ...r } as typeof r & { description?: unknown };
    delete clean.description;
    return clean;
  });
  p.referenceCategories ??= [];
  p.openArt ??= { model: "auto", resolution: "1k" };
  p.status ??= {};
  p.visualStyle ??= "";
  p.styles ??= [];
  p.brand ??= { colors: [], font: "" };
  p.currentStep ??= 1;
  // `videosDir` is legacy: clips now live in each shot's board folder under
  // `video/`. It's only read by `relocateVideoLayout` (below) to find old flat
  // files; normalize never recreates it.
  p.assets ??= { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" };
  p.assets.voiceoverDir ??= "voiceover";
  p.assets.musicDir ??= "music";
  p.assets.referencesDir ??= "references";
  p.assets.assemblyDir ??= "assembly";
  p.assets.modelsDir ??= "models";
  p.assembly ??= { fps: 24, width: 1920, height: 1080, exportDir: `${p.assets.outDir}/${p.assets.assemblyDir}` };
  p.magicPrompts ??= {};
  if (typeof p.magicEnabled !== "boolean") p.magicEnabled = false;
  // Clean stale magic entries for deleted shots and non-string values
  if (p.magicPrompts && typeof p.magicPrompts === "object") {
    const ids = new Set(p.scenes.flatMap((sc) => sc.shots.map((s) => s.id)));
    for (const k of Object.keys(p.magicPrompts)) {
      if (!ids.has(k) || typeof p.magicPrompts[k] !== "string") delete p.magicPrompts[k];
      else p.magicPrompts[k] = p.magicPrompts[k].trim().slice(0, 2000);
    }
  }
  if (typeof (p as unknown as { voiceoverVolume?: unknown }).voiceoverVolume !== "number") {
    // Default voiceover volume when a VO exists, otherwise leave undefined for fresh projects.
    if (p.voiceoverPath) (p as ProductionFile).voiceoverVolume = 1;
  }
  if (typeof (p as unknown as { musicVolume?: unknown }).musicVolume !== "number") {
    if (p.musicPath) (p as ProductionFile).musicVolume = 0.5;
  }
  // The moodboard is renderer-normalized on read (`normalizeMoodboardLayout`);
  // main only drops a non-object so a corrupt file can't poison the merge.
  if (p.moodboard !== undefined && (p.moodboard === null || typeof p.moodboard !== "object")) {
    delete (p as { moodboard?: unknown }).moodboard;
  }
  return p;
}

const store = createStore<ProductionFile>({
  dirName: "productions",
  idOf: (p) => p.meta.id,
  decode: normalize,
  sortKey: (p) => p.meta.updatedAt,
  // The image-suite session is a side document of the production — removing or
  // archiving the production removes/archives it in lockstep so no orphan
  // suite timelines accumulate.
  sideFiles: {
    remove: (id) => removeSuiteSession(id),
    archive: (id) => archiveSuiteSession(id),
  },
});

/** List payload: just the meta plus a status peek. */
function summary(p: ProductionFile): ProductionMeta {
  const stepsDone = Object.entries(p.status)
    .filter(([, v]) => v === "done")
    .map(([k]) => Number(k));
  return {
    ...p.meta,
    stepDone: stepsDone.length ? Math.max(...stepsDone) : 0,
    shotCount: p.scenes.reduce((n, s) => n + s.shots.length, 0),
  };
}

export function listProductions(): ProductionMeta[] {
  return store.list().map(summary);
}

/** Current production schema version. Bump when adding a one-time migration
 *  to migrateBoardArtwork; loads with >= this value skip the board walk. */
export const PRODUCTION_SCHEMA_VERSION = 2;

/** Oldest production schema the loader can migrate. Data below this cannot be
 *  brought forward safely, so it fails loudly with the version named instead
 *  of silently dropping fields. (v1 and unversioned legacy docs migrate.) */
export const MIN_PRODUCTION_SCHEMA_VERSION = 1;

export function loadProduction(id: string): ProductionFile | null {
  const p = store.load(id);
  if (!p) return null;
  if (
    typeof p.schemaVersion === "number" &&
    Number.isFinite(p.schemaVersion) &&
    p.schemaVersion < MIN_PRODUCTION_SCHEMA_VERSION
  ) {
    throw new Error(
      `This production uses schema version ${p.schemaVersion}, older than the minimum supported version ${MIN_PRODUCTION_SCHEMA_VERSION}. ` +
        `It can't be migrated automatically — reopen it with the app version that created it, or restore it from a backup.`
    );
  }
  // The store caches parsed documents and hands out the cached object graph
  // by reference. Every caller gets a private copy instead: long-running
  // generation jobs hold shot/node references across awaits while the
  // renderer keeps saving, and a mid-run `production:save` replaces the
  // cached graph's scenes — silently detaching the job's references so its
  // finished generation is recorded onto orphaned objects and never
  // persisted (file on disk, nothing in history). Cloning here closes that
  // whole class: holders can never share, and rebase merges by value.
  // The file is small (tens of KB) so the copy is microseconds; the cache
  // still skips the JSON.parse on hits.
  // Perf 1.2: post-migration loads skip the full-board walk entirely. The
  // >= keeps a downgrade from silently stamping a newer document down.
  if (typeof p.schemaVersion === "number" && p.schemaVersion >= PRODUCTION_SCHEMA_VERSION) return structuredClone(p);
  // One-time migrations (legacy PNGs → JPEGs; classic generations seed the
  // node-graph generation nodes). Persist in place so the very next read
  // sees the new layout. Always stamp, even when the walk reports no change,
  // so the next load hits the fast path.
  migrateBoardArtwork(p);
  p.schemaVersion = PRODUCTION_SCHEMA_VERSION;
  store.save(p);
  return structuredClone(p);
}

/** Absolute paths of every artwork-bearing reference — reference images
 *  (characters, products, custom references) and video references' clips —
 *  feeding the thumbnail-cache regenerator so the node graph's tiles (and the
 *  moodboard shelf's video posters) are pre-generated for older projects. */
export function referenceThumbnailPaths(p: ProductionFile): string[] {
  const imagePaths = [...(p.characters ?? []), ...(p.products ?? []), ...(p.references ?? [])]
    .filter((r) => !!r.imagePath)
    .map((r) => assetPath(p, r.imagePath!));
  const videoPaths = (p.references ?? [])
    .filter((r) => r.media === "video" && !!r.mediaPath)
    .map((r) => assetPath(p, r.mediaPath!));
  return [...imagePaths, ...videoPaths];
}

export function saveProduction(p: ProductionFile): void {
  normalize(p);
  p.meta.updatedAt = new Date().toISOString();
  p.schemaVersion ??= PRODUCTION_SCHEMA_VERSION;
  // Monotonic write revision for the renderer's stale-snapshot guard: every
  // persisted write (insert/delete/prompt save/…) stamps a higher rev so an
  // older whole-object snapshot can never overwrite newer structural state.
  // Persisted in the JSON so the counter survives restarts (never decreases).
  const cur = typeof p.rev === "number" && Number.isFinite(p.rev) ? p.rev : 0;
  p.rev = cur + 1;
  store.save(p);
}

/**
 * Prefer the incoming generation index when both snapshots agree on the
 * node's history, but keep the fresh index when the histories diverged (a
 * generation landed after the snapshot was captured — the stale index is
 * positional and would select the wrong take). Readers treat undefined as 0.
 */
function takeGenIndex(
  incomingIdx: number | undefined,
  incomingGens: { path: string }[] | undefined,
  freshIdx: number | undefined,
  freshGens: { path: string }[] | undefined
): number | undefined {
  if (incomingIdx === undefined) return freshIdx;
  const same = JSON.stringify(incomingGens ?? []) === JSON.stringify(freshGens ?? []);
  return same ? incomingIdx : freshIdx;
}

/** Merge the camera-grid node: the fresh document owns the generated sheet,
 *  its provenance, and the panel geometry (all written main-side by a
 *  generation); the incoming snapshot owns the renderer-edited wiring
 *  (`source`/`gridSource`/`refIds`), prompt, and generation picks.
 *
 *  The sheet itself is written by BOTH sides — main on a generation, the
 *  renderer on a grid-image import — so `sheetAt` (the last sheet-write
 *  timestamp) decides which `sheetPath` is newer. Without that, a generation
 *  landing concurrently would revert a just-imported grid image (the imported
 *  sheet vanished on the next save), and a stale renderer save would revert a
 *  fresh generation. */
function mergeCameraGrid(
  freshGrid: CameraGridData | undefined,
  incomingGrid: CameraGridData | undefined
): CameraGridData | undefined {
  if (!incomingGrid) return freshGrid;
  if (!freshGrid) return incomingGrid;
  const freshAt = typeof freshGrid.sheetAt === "string" ? freshGrid.sheetAt : "";
  const incomingAt = typeof incomingGrid.sheetAt === "string" ? incomingGrid.sheetAt : "";
  const merged: CameraGridData = {
    ...freshGrid,
    ...incomingGrid,
    cols: freshGrid.cols,
    rows: freshGrid.rows,
    ...(freshGrid.panels ? { panels: freshGrid.panels } : {}),
    ...(freshGrid.panelLabels ? { panelLabels: freshGrid.panelLabels } : {}),
    ...(freshGrid.generation ? { generation: freshGrid.generation } : {}),
  };
  // The sheet (path + write timestamp) follows the newer write, whichever side
  // produced it — a generation (main) or a grid-image import (renderer).
  const sheet = incomingAt > freshAt ? incomingGrid : freshGrid;
  if (sheet.sheetPath) merged.sheetPath = sheet.sheetPath;
  else delete merged.sheetPath;
  if (sheet.sheetAt) merged.sheetAt = sheet.sheetAt;
  else delete merged.sheetAt;
  return merged;
}

/** Merge the upscale node: the fresh document owns the stored output history
 *  (main-side appends), the incoming snapshot owns the renderer-edited source
 *  wiring and model/resolution/params picks. */
function mergeUpscale(
  freshNode: UpscaleData | undefined,
  incomingNode: UpscaleData | undefined
): UpscaleData | undefined {
  if (!incomingNode) return freshNode;
  if (!freshNode) return incomingNode;
  const { gens: _gens, genIndex: _idx, ...rest } = incomingNode;
  const node: UpscaleData = { ...freshNode, ...rest };
  node.genIndex = takeGenIndex(incomingNode.genIndex, incomingNode.gens, freshNode.genIndex, freshNode.gens);
  return node;
}

/** Merge one shot's edit-image nodes by stable node id: the fresh node owns
 *  its generation history (main-side appends), the incoming snapshot owns the
 *  node's editable fields (prompt, wiring, model picks). Nodes only the
 *  incoming snapshot has are creations racing this save — adopt them whole. */
function mergeEditNodes(
  freshNodes: GraphEditNode[] | undefined,
  incomingNodes: GraphEditNode[] | undefined
): GraphEditNode[] | undefined {
  if (!incomingNodes) return freshNodes;
  const incomingById = new Map<string, GraphEditNode>();
  for (const n of incomingNodes) {
    if (n && typeof n.id === "string" && !incomingById.has(n.id)) incomingById.set(n.id, n);
  }
  const out = (freshNodes ?? []).map((fn) => {
    const inc = incomingById.get(fn.id);
    if (!inc) return fn;
    const { gens: _gens, genIndex: _idx, id: _id, ...rest } = inc;
    const node: GraphEditNode = { ...fn, ...rest };
    node.genIndex = takeGenIndex(inc.genIndex, inc.gens, fn.genIndex, fn.gens);
    return node;
  });
  for (const [id, inc] of incomingById) {
    if (!(freshNodes ?? []).some((n) => n.id === id)) out.push({ ...inc });
  }
  return out;
}

/** Merge in-betweener action blocks by keyframe pair (start/end source ids —
 *  block ids are positional and reshuffle when keyframes reorder). The fresh
 *  block owns its generation history; the incoming snapshot owns the block's
 *  prompt and timing. Pairs only the incoming snapshot has are re-derived
 *  from the (incoming) keyframe list by syncTweenBlocks below. */
function mergeTweenBlocks(
  freshBlocks: TweenBlock[] | undefined,
  incomingBlocks: TweenBlock[] | undefined
): TweenBlock[] | undefined {
  if (!incomingBlocks) return freshBlocks;
  const incomingByPair = new Map<string, TweenBlock>();
  for (const b of incomingBlocks) {
    if (!b) continue;
    const key = `${b.startRefId}→${b.endRefId}`;
    if (!incomingByPair.has(key)) incomingByPair.set(key, b);
  }
  return (freshBlocks ?? []).map((fb) => {
    const ib = incomingByPair.get(`${fb.startRefId}→${fb.endRefId}`);
    if (!ib) return fb;
    const { gens: _gens, genIndex: _idx, id: _id, startRefId: _s, endRefId: _e, ...rest } = ib;
    const block: TweenBlock = { ...fb, ...rest };
    block.genIndex = takeGenIndex(ib.genIndex, ib.gens, fb.genIndex, fb.gens);
    return block;
  });
}

/**
 * Merge one shot's renderer edits onto the fresh shot. The fresh shot owns
 * its identity, its number, and every path-bearing field (artwork, histories,
 * generation arrays, clip paths) — those are written main-side by generations
 * and by relocateBoardsForRenumber, and a stale snapshot must never resurrect
 * or cross-wire them. The incoming snapshot owns everything the renderer
 * edits (text, prompts, pipes, selections, flags). Two exceptions:
 * explicit nulls on `artwork`/`videoPath` are honoured (the node-graph
 * pipe/unpipe flows clear the storyboard frame that way), and a `videoPath`
 * string rides through when the output feeds the edit-video node (no pipe
 * sync derives it — there is no follow-up channel for that selection).
 */
function mergeRendererShot(freshShot: ProductionShot, incoming: ProductionShot): ProductionShot {
  const { voiceoverPath: _v, transition: _t, ...incomingFields } = incoming as ProductionShot & {
    voiceoverPath?: unknown; transition?: unknown;
  };
  const incomingRec = incomingFields as unknown as Record<string, unknown>;
  // Main-owned fields: never copied from the incoming snapshot.
  const DENIED = new Set([
    "id", "number",
    "artworkHistory",
    "graphImageGens", "graphVideoGens", "graphEditGens", "graphEditVideoGens",
    "graphTweenOutput", "pendingImageGen", "graphMigrated",
    "graphImageGenIndex", "graphVideoGenIndex", "graphEditVideoGenIndex",
  ]);
  const merged: ProductionShot = { ...freshShot };
  const mergedRec = merged as unknown as Record<string, unknown>;
  // Legacy fields no longer used (single-VO model, cuts-only timeline) —
  // stripped from whichever side still carries them so they don't resurface.
  delete mergedRec.voiceoverPath;
  delete mergedRec.transition;
  for (const [key, value] of Object.entries(incomingRec)) {
    if (DENIED.has(key)) continue;
    if (key === "artwork" || key === "videoPath") continue; // explicit-null / editvideo rules below
    if (key === "graphEditNodes" || key === "graphTweenBlocks" || key === "graphUpscale") continue; // merged by id / pair / state below
    mergedRec[key] = value;
  }
  merged.graphImageGenIndex = takeGenIndex(
    incoming.graphImageGenIndex, incoming.graphImageGens,
    freshShot.graphImageGenIndex, freshShot.graphImageGens
  );
  merged.graphVideoGenIndex = takeGenIndex(
    incoming.graphVideoGenIndex, incoming.graphVideoGens,
    freshShot.graphVideoGenIndex, freshShot.graphVideoGens
  );
  merged.graphEditVideoGenIndex = takeGenIndex(
    incoming.graphEditVideoGenIndex, incoming.graphEditVideoGens,
    freshShot.graphEditVideoGenIndex, freshShot.graphEditVideoGens
  );
  merged.graphEditNodes = mergeEditNodes(freshShot.graphEditNodes, incoming.graphEditNodes);
  merged.graphTweenBlocks = mergeTweenBlocks(freshShot.graphTweenBlocks, incoming.graphTweenBlocks);
  merged.graphCameraGrid = mergeCameraGrid(freshShot.graphCameraGrid, incoming.graphCameraGrid);
  merged.graphUpscale = mergeUpscale(freshShot.graphUpscale, incoming.graphUpscale);
  // Explicit clears ride the whole-document save (unpipe flows send
  // artwork/videoPath as explicit nulls). A stale echo carries paths, never
  // nulls, so honouring nulls cannot resurrect or cross-wire frames.
  if ("artwork" in incomingFields && (incoming as { artwork?: unknown }).artwork == null) merged.artwork = undefined;
  if ("videoPath" in incomingFields && (incoming as { videoPath?: unknown }).videoPath == null) merged.videoPath = undefined;
  if (
    merged.graphOutputSource === "editvideo"
    && typeof incoming.videoPath === "string" && incoming.videoPath
  ) {
    merged.videoPath = incoming.videoPath;
  }
  return merged;
}

/**
 * Merge renderer-owned scene edits onto the freshest on-disk scenes.
 *
 * Whole-document renderer saves (`production:save`) are captured from the
 * renderer's snapshot, which can predate a structural change that committed
 * first — the classic case is a shot drag-reorder (new order, new numbers,
 * relocated board folders) racing an in-flight graph/text save. Copying the
 * incoming scenes wholesale would revert the order, reattach stale numbers,
 * and point artwork at another shot's folder; the pipe sync would then
 * "heal" the artwork from the wrong selection, visibly swapping pure and
 * edited frames.
 *
 * So the fresh document owns everything structural — scene membership and
 * order, shot numbers, and all path-bearing fields — matched per shot by
 * stable id (a shot moved across scenes is found in its new scene). The
 * incoming snapshot contributes only the fields the renderer edits. Shots the
 * fresh document no longer has (deleted after the snapshot) stay deleted;
 * the save's edits to surviving shots still apply.
 */
function mergeRendererScenes(fresh: ProductionFile, incoming: Production): void {
  if (!Array.isArray(incoming.scenes)) return;
  const incomingById = new Map<string, ProductionShot>();
  for (const scene of incoming.scenes) {
    if (!scene || !Array.isArray(scene.shots)) continue;
    for (const shot of scene.shots) {
      if (shot && typeof shot.id === "string" && !incomingById.has(shot.id)) incomingById.set(shot.id, shot);
    }
  }
  for (const scene of fresh.scenes) {
    for (let i = 0; i < scene.shots.length; i++) {
      const prev = incomingById.get(scene.shots[i].id);
      if (prev) scene.shots[i] = mergeRendererShot(scene.shots[i], prev);
    }
  }
  for (const shot of fresh.scenes.flatMap((s) => s.shots)) {
    // Fold any legacy single-edit fields from a stale renderer payload into
    // the edit-node list before the output pipe is re-derived from it.
    migrateEditNodes(shot);
    // The output pipe is authoritative: re-derive artwork/videoPath so a
    // renderer save with a stale or missing frame can't diverge from the
    // graph's frame output node (e.g. an edit-image node piped to output).
    syncBoardOutputToPipe(shot);
    // Tween keyframes must point at live references — prune deleted refs so
    // a stale save can't leave phantom action blocks behind.
    syncTweenBlocks(fresh, shot);
  }
}

/** Merge renderer-owned state onto the freshest on-disk production.
 *
 *  `fresh` is the document just loaded from disk — it is never clobbered
 *  wholesale (concurrent edits from other long-running jobs must survive).
 *  Only the known renderer-editable fields are copied from `incoming`, and
 *  legacy fields (single-VO model, cuts-only timeline) are stripped so they
 *  don't resurface. This is the write-side counterpart to `normalize`'s
 *  read-side back-fill; both live here so the production document's shape
 *  rules have one home. */
export function applyRendererState(fresh: ProductionFile, incoming: Production): ProductionFile {
  const p = incoming;
  fresh.currentStep = p.currentStep;
  fresh.visualStyle = p.visualStyle ?? "";
  fresh.styles = Array.isArray(p.styles) ? p.styles : [];
  fresh.brand = p.brand && Array.isArray(p.brand.colors)
    ? { colors: p.brand.colors.slice(0, 5).map((c) => String(c)), font: typeof p.brand.font === "string" ? p.brand.font : "" }
    : { colors: [], font: "" };
  // Scenes merge per shot by stable id (see mergeRendererScenes): the fresh
  // document owns order, numbers, and all media paths, so a renderer snapshot
  // that predates a shot reorder can neither revert the order nor cross-wire
  // frames between shots. Shots the renderer deleted stay deleted.
  mergeRendererScenes(fresh, p);
  // promptOverrides is keyed by displayed shot number and written main-side
  // (ingest stashes manual prompts, reorder remaps them) — the renderer never
  // edits it through a save, so the fresh map always wins. Replacing it with
  // a stale snapshot's map would reattach overrides to the wrong shots after
  // a reorder.
  fresh.promptOverrides =
    fresh.promptOverrides && typeof fresh.promptOverrides === "object" ? { ...fresh.promptOverrides } : {};
  fresh.characters = Array.isArray(p.characters) ? p.characters : [];
  fresh.products = Array.isArray(p.products) ? p.products : [];
  fresh.references = Array.isArray(p.references) ? p.references : [];
  fresh.suggestedReferences = Array.isArray(p.suggestedReferences) ? p.suggestedReferences : [];
  fresh.referenceCategories = Array.isArray(p.referenceCategories) ? p.referenceCategories : [];
  if (p.openArt && typeof p.openArt.model === "string" && typeof p.openArt.resolution === "string") {
    fresh.openArt = { model: p.openArt.model, resolution: p.openArt.resolution };
    if (typeof p.openArt.quality === "string" && p.openArt.quality.trim()) {
      fresh.openArt.quality = p.openArt.quality.trim();
    }
    // Schema-driven model options (variant, mode, …) are renderer-edited
    // through saves like quality — dropping them here silently reverted every
    // storyboard params pick (and its quote) on the next reload.
    const params = sanitizeGenParams(p.openArt.params);
    if (params) fresh.openArt.params = params;
  }
  if (typeof p.voiceoverPath === "string" || p.voiceoverPath === null) {
    fresh.voiceoverPath = typeof p.voiceoverPath === "string" && p.voiceoverPath ? p.voiceoverPath : undefined;
  }
  if (typeof p.voiceoverVolume === "number" && Number.isFinite(p.voiceoverVolume)) {
    fresh.voiceoverVolume = Math.max(0, Math.min(1, p.voiceoverVolume));
  }
  if (typeof p.musicPath === "string" || p.musicPath === null) {
    fresh.musicPath = typeof p.musicPath === "string" && p.musicPath ? p.musicPath : undefined;
  }
  if (typeof p.musicVolume === "number" && Number.isFinite(p.musicVolume)) {
    fresh.musicVolume = Math.max(0, Math.min(1, p.musicVolume));
  }
  fresh.status = p.status ?? {};
  if (typeof p.scriptSource === "string") fresh.scriptSource = p.scriptSource;
  if (p.assembly) {
    const a = p.assembly;
    const fps = Number.isFinite(a.fps) && a.fps >= 1 ? Math.round(a.fps) : 24;
    const width = Number.isFinite(a.width) && a.width >= 1 ? Math.round(a.width) : 1920;
    const height = Number.isFinite(a.height) && a.height >= 1 ? Math.round(a.height) : 1080;
    fresh.assembly = {
      fps,
      width,
      height,
      exportDir: typeof a.exportDir === "string" && a.exportDir ? a.exportDir : `${fresh.assets.outDir}/${fresh.assets.assemblyDir}`,
      assembledAt: a.assembledAt,
      renderPath: typeof a.renderPath === "string" && a.renderPath ? a.renderPath : undefined,
      renderedAt: a.renderedAt,
      totalSec: Number.isFinite(a.totalSec) ? a.totalSec : undefined,
      skippedShots: Array.isArray(a.skippedShots) ? a.skippedShots.filter((s) => typeof s === "string") : undefined,
    };
  }
  if (typeof p.meta.name === "string" && p.meta.name.trim()) fresh.meta.name = p.meta.name.trim();
  // magicPrompts IS renderer-edited through saves (the prompt drawer writes
  // magicPrompts[shotId]), so merge per key: incoming non-blank entries win,
  // incoming blanks clear, and fresh-only keys survive a stale snapshot
  // (e.g. a save captured before a bulk magic-prompt generation landed).
  if (p.magicPrompts && typeof p.magicPrompts === "object") {
    fresh.magicPrompts ??= {};
    for (const [k, v] of Object.entries(p.magicPrompts)) {
      if (typeof v === "string" && v.trim()) fresh.magicPrompts[k] = v.trim().slice(0, 2000);
      else delete fresh.magicPrompts[k];
    }
  } else if (p.magicPrompts === undefined) {
    fresh.magicPrompts = fresh.magicPrompts ?? {};
  }
  if (typeof p.magicEnabled === "boolean") fresh.magicEnabled = p.magicEnabled;
  // The reference moodboard (node placements, viewport, notes) is renderer-owned
  // like the shot graph layouts. Its shape is repaired on read by the renderer's
  // `normalizeMoodboardLayout`; main only stores it verbatim so a save never
  // partitions it across two writers.
  if (p.moodboard && typeof p.moodboard === "object") fresh.moodboard = p.moodboard;
  return fresh;
}

/** Reference-image files (workspace-relative) that nothing on the production
 *  claims yet — the input to the references-folder rescan. Characters,
 *  products, and custom references claim their imagePath/mediaPath; everything
 *  else in referencesDir is an orphan (e.g. an image dropped into the folder
 *  externally) the rescan adopts as a new reference. */
export function unclaimedReferenceFiles(files: string[], p: Production): string[] {
  const claimed = new Set<string>();
  for (const c of p.characters) if (c.imagePath) claimed.add(c.imagePath);
  for (const c of p.products) if (c.imagePath) claimed.add(c.imagePath);
  for (const r of p.references ?? []) {
    if (r.imagePath) claimed.add(r.imagePath);
    if (r.mediaPath) claimed.add(r.mediaPath);
  }
  return files.filter((f) => !claimed.has(f));
}

/** Walk every shot's artwork + history and convert any legacy PNG paths to
 *  the new JPEG layout. Returns true if anything changed. */
function migrateBoardArtwork(p: Production): boolean {
  let changed = false;
  for (const sc of p.scenes) {
    for (const s of sc.shots) {
      if (migrateGraphGenerations(s)) changed = true;
      if (migrateGraphPipes(s)) changed = true;
      if (migrateEditNodes(s)) changed = true;
      if (syncTweenBlocks(p, s)) changed = true;
      if (s.artwork && migrateBoardArtworkToJpeg(p, s)) changed = true;
      if (relocateBoardLayout(p, s)) changed = true;
      if (relocateVideoLayout(p, s)) changed = true;
      if (syncBoardOutputToPipe(s)) changed = true;
      if (migrateShotGraph(p, s)) changed = true;
      if (s.artworkHistory) {
        const next = s.artworkHistory.map((rel) => rel);
        let hChanged = false;
        for (let i = 0; i < next.length; i++) {
          const fake = { artwork: next[i], number: s.number } as Parameters<typeof migrateBoardArtworkToJpeg>[1];
          if (migrateBoardArtworkToJpeg(p, fake)) {
            next[i] = fake.artwork!;
            hChanged = true;
          }
        }
        if (hChanged) { s.artworkHistory = next; changed = true; }
      }
    }
  }
  // The legacy flat video folder is no longer part of the layout; drop the
  // field once every shot's clips have been relocated into its `video/` folder.
  if ((p.assets as { videosDir?: string }).videosDir) {
    delete (p.assets as { videosDir?: string }).videosDir;
    changed = true;
  }
  if (migrateReferenceArtwork(p)) changed = true;
  return changed;
}

/** One-time migration: legacy flag/text wiring → the stored `shot.graph`.
 *  Runs after the edit-node/tween/output migrations so it reads settled
 *  state. Old fields are left untouched (step 10 deletes them); the graph is
 *  the only writer from here on. Step 04 additionally strips the pasted
 *  Style:/Brand copies the new edges cover (exact style matches; any brand
 *  paragraph — the edge re-renders the canonical clause), so no consumer
 *  stores shared text. Custom prose that merely looks like a section is left
 *  in storage (render normalizes attached prompts at read; the next edit
 *  converges). Idempotent via `graph.migrated`. */
export function migrateShotGraph(p: Production, shot: ProductionShot): boolean {
  if (shot.graph?.migrated) return false;
  const { graph } = normalizeGraph(materializeGraph(shot, graphRefViews(p)));
  stripMigratedCopies(p, shot, graph);
  graph.migrated = true;
  shot.graph = graph;
  return true;
}

/** Drop shared-text copies covered by the freshly materialized edges. */
function stripMigratedCopies(p: Production, shot: ProductionShot, graph: Graph): void {
  const styleText = resolveNodeStyleText(p, shot);
  const stripField = (text: string | undefined, target: StylePromptTarget): string | undefined => {
    if (text == null) return text;
    let out = text;
    if (styleEdgePresent(graph, target)) {
      const body = parsePromptBoxes(out).style.trim();
      if (!styleText || body === styleText.trim()) out = stripStyleParagraph(out);
    }
    if (brandEdgePresent(graph, target) && hasBrandParagraph(out)) out = stripBrandParagraph(out);
    return out;
  };
  shot.prompt = stripField(shot.prompt, "composer");
  shot.graphVideoPrompt = stripField(shot.graphVideoPrompt, "videoprompt");
  shot.graphEditVideoPrompt = stripField(shot.graphEditVideoPrompt, "editvideoprompt");
  // graphEditPrompt (the classic draft for the NEXT edit) is left verbatim —
  // it seeds a future node, not a current consumer.
  for (const n of shot.graphEditNodes ?? []) {
    const next = stripField(n.prompt, { editprompt: n.id });
    if (next !== n.prompt) n.prompt = next ?? "";
  }
}

/** Tag-resolution views for migration: characters → products → custom refs,
 *  deduped by name (first wins), mirroring the canvas `references` prop. */
function graphRefViews(p: Production): GraphRefView[] {
  const out: GraphRefView[] = [];
  const seen = new Set<string>();
  const push = (id: string, name: string, media?: "video" | "audio", artwork?: string): void => {
    const key = (name ?? "").trim().toLowerCase();
    if (!id || !key || seen.has(key)) return;
    seen.add(key);
    out.push({ id, name: name.trim(), media, artwork });
  };
  for (const c of p.characters ?? []) push(c.id, c.name, undefined, c.artwork ?? c.imagePath);
  for (const pr of p.products ?? []) push(pr.id, pr.name, undefined, pr.artwork ?? pr.imagePath);
  for (const r of p.references ?? []) push(r.id, r.name, r.media, r.artwork ?? r.imagePath ?? r.mediaPath);
  return out;
}

/** One-time field migration: the image gen node used to route its single
 *  output to exactly one destination (`graphImageOutTarget: "videogen" |
 *  "output"`). It can now feed the video node AND the output simultaneously,
 *  so the routing is two independent booleans — `graphImageToVideo` (video
 *  node feed) and `graphOutputSource === "imagegen"` (output feed). */
function migrateGraphPipes(shot: ProductionShot): boolean {
  const legacy = (shot as unknown as { graphImageOutTarget?: string }).graphImageOutTarget;
  if (legacy === undefined) return false;
  if (legacy === "videogen") shot.graphImageToVideo = true;
  // "output" needs no extra flag — graphOutputSource === "imagegen" already
  // described the output feed.
  delete (shot as unknown as { graphImageOutTarget?: string }).graphImageOutTarget;
  return true;
}

/** Make a production name safe as a single folder segment (Windows + POSIX).
 *  Strips illegal characters and trailing dots/spaces; falls back to
 *  "Untitled production" when nothing usable remains. */
export function sanitizeProductionFolderName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "Untitled production";
  return cleaned.slice(0, 100);
}

export function newProduction(name: string, parentFolder: string): ProductionFile {
  const now = new Date().toISOString();
  const trimmed = typeof name === "string" ? name.trim() : "";
  // The picker chooses a parent directory; the production lives in a
  // subfolder named after the production so the disk layout mirrors the
  // production name. An empty name keeps the legacy behavior (the picked
  // folder itself is the production folder).
  let folder = parentFolder;
  let prodName = trimmed || path.basename(parentFolder) || "Untitled production";
  if (trimmed) {
    folder = path.join(parentFolder, sanitizeProductionFolderName(trimmed));
    prodName = trimmed;
  }
  const meta: ProductionMeta = {
    id: store.newId(),
    name: prodName,
    folder,
    createdAt: now,
    updatedAt: now,
    stepDone: 0,
    shotCount: 0,
  };
  const p: ProductionFile = {
    meta,
    currentStep: 1,
    visualStyle: "",
    styles: [],
    brand: { colors: [], font: "" },
    scenes: [],
    characters: [],
    products: [],
    references: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
    schemaVersion: PRODUCTION_SCHEMA_VERSION,
  };
  // Scaffold the asset folders inside the user's production folder.
  for (const d of [p.assets.boardsDir, p.assets.voiceoverDir, p.assets.musicDir, p.assets.outDir, p.assets.referencesDir, p.assets.modelsDir, `${p.assets.outDir}/${p.assets.assemblyDir}`]) {
    try {
      fs.mkdirSync(path.join(folder, d), { recursive: true });
    } catch {
      /* non-fatal: user may add it later */
    }
  }
  saveProduction(p);
  return p;
}

/**
 * Re-register an existing production folder (e.g. after moving to a new PC
 * or wiping app data, the userData/productions/ JSON is gone but the folder
 * with boards/, script.md, … survives). The folder ITSELF becomes the
 * production folder — unlike newProduction, no subfolder is created. Missing
 * asset dirs are scaffolded non-destructively; existing files are never
 * touched. Pipeline state starts fresh (the old JSON is gone), so the user
 * re-ingests the script from Step 1. Re-importing an already-registered
 * folder returns the existing document instead of a duplicate.
 */
export function importProduction(folder: string): ProductionFile {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(folder);
  } catch {
    throw new Error(`That folder doesn't exist: ${folder}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${folder}`);
  const resolved = path.resolve(folder);
  const existing = store.list().find((p) => {
    try {
      return path.resolve(p.meta.folder) === resolved;
    } catch {
      return false;
    }
  });
  if (existing) return existing;
  const now = new Date().toISOString();
  const p: ProductionFile = {
    meta: {
      id: store.newId(),
      name: path.basename(resolved) || "Untitled production",
      folder: resolved,
      createdAt: now,
      updatedAt: now,
      stepDone: 0,
      shotCount: 0,
    },
    currentStep: 1,
    visualStyle: "",
    styles: [],
    brand: { colors: [], font: "" },
    scenes: [],
    characters: [],
    products: [],
    references: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
    schemaVersion: PRODUCTION_SCHEMA_VERSION,
  };
  // Scaffold only what's missing — never delete or overwrite.
  for (const d of [p.assets.boardsDir, p.assets.voiceoverDir, p.assets.musicDir, p.assets.outDir, p.assets.referencesDir, p.assets.modelsDir, `${p.assets.outDir}/${p.assets.assemblyDir}`]) {
    try {
      fs.mkdirSync(path.join(resolved, d), { recursive: true });
    } catch {
      /* non-fatal: user may add it later */
    }
  }
  saveProduction(p);
  return p;
}

export function deleteProduction(id: string): boolean {
  return store.remove(id);
}

export function archiveProduction(id: string): boolean {
  return store.archive(id);
}