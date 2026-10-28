/**
 * Production persistence: one JSON file per production under
 * userData/productions/, mirroring the sessions.ts pattern. The production's
 * own folder (anywhere on disk) holds generated assets; this file holds the
 * pipeline state. The document lifecycle is the shared store; this module owns
 * the normalize-on-read pass and the asset-folder scaffolding.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { CameraGridData, Graph, GraphEditNode, GraphVideoNode, Production, ProductionMeta, ProductionShot, ShotSequence, TweenBlock, UpscaleData }
from "../shared/ipc.js";
import { mergeGraphLayoutPatch } from "../shared/graph/layout.js";
import { pickGraphShotPatch } from "../shared/graph/shot-patch.js";
export { mergeGraphLayoutPatch };
import { sanitizeGenParams, normalizeShotSequences, isVideoEditFamilyMode, SEQUENCE_ACCENT_COLORS } from "../shared/ipc.js";
import { migrateBoardArtworkToJpeg, migrateEditNodes, migrateVideoNodes, migrateEditVideoNodes, migrateGraphGenerations,
relocateBoardLayout, relocateVideoLayout, migrateReferenceArtwork, syncBoardOutputToPipe, syncTweenBlocks, assetPath, mediaFiles, productionMediaRefs,
parseScriptMarkdown, parseBoardPromptsMarkdown, refreshBoardLinks, refreshShotVideos, scanBoardImportFolder, importBoards, markBoardsStatus, newRefId, STYLES_DIR }
from "./pipeline.js";
import * as shotter from "./shotter.js";
import { normalizeMediaRegistry } from "../shared/media-registry.js";
import { materializeGraph, type GraphRefView } from "../shared/graph/materialize.js";
import { normalizeGraph } from "../shared/graph/normalize.js";
import { setStyleEdge } from "../shared/graph/connect.js";
import { nodeDecl } from "../shared/graph/ports.js";
import { brandEdgePresent, resolveNodeStyleText, stripSharedSections, styleEdgePresent, type StylePromptTarget } from "../shared/graph/render.js";
import { hasBrandParagraph, parsePromptBoxes, stripBrandParagraph, stripStyleParagraph } from "../shared/prompt-grammar.js";
import { createStore } from "./store.js";
import { SHOT_INDEX_FIELDS, SHOT_MERGE_DENIED_FIELDS, SHOT_SPECIAL_FIELDS } from "./shot-ownership.js";
import { archiveSuiteSession, removeSuiteSession } from "./suite.js";
import { sanitizeAliases } from "../shared/ref-names.js";

export interface ProductionFile extends Production {}

/** Back-fill fields so older files keep parsing as the schema grows. */
function normalize(p: ProductionFile): ProductionFile {
  if (!p.meta || !p.meta.id || !p.meta.folder) throw new Error("corrupt production file");
  p.scenes ??= [];
  p.outdatedShots ??= [];
  p.characters ??= [];
  p.products ??= [];
  p.references ??= [];
  p.references = p.references.map((r) => {
    const clean = { ...r } as typeof r & { description?: unknown };
    delete clean.description;
    return clean;
  });
  for (const r of p.references) {
    if (r.purpose !== undefined && !["subject", "environment", "style", "layout", "inspiration"].includes(r.purpose)) delete r.purpose;
    // An explicit purpose is authoritative for the legacy style flag:
    // changing the purpose away from style must stop the reference from
    // being treated as style-tagged (a stale `styleOnly` once kept it so).
    if (r.purpose !== undefined) {
      if (r.purpose === "style") r.styleOnly = true;
      else delete r.styleOnly;
    }
    if (r.visualSummary !== undefined) {
      const clean = typeof r.visualSummary === "string" ? r.visualSummary.trim().slice(0, 300) : "";
      if (clean) r.visualSummary = clean; else delete r.visualSummary;
    }
    if (r.waveformColor !== undefined && !SEQUENCE_ACCENT_COLORS.some((c) => c.id === r.waveformColor)) delete r.waveformColor;
  }
  // Reference aliases are read-repaired: sanitized/deduped, canonical dropped.
  for (const pool of [p.characters, p.products, p.references]) {
    for (const r of pool as { name: string; aliases?: string[] }[]) {
      if (r.aliases !== undefined) {
        const clean = sanitizeAliases(r.aliases, r.name ?? "");
        if (clean.length) r.aliases = clean;
        else delete r.aliases;
      }
    }
  }
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
  p.assets ??= { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" };
  p.assets.voiceoverDir ??= "voiceover";
  p.assets.musicDir ??= "music";
  p.assets.referencesDir ??= "references";
  p.assets.assemblyDir ??= "assembly";
  p.assembly ??= { fps: 24, width: 1920, height: 1080, exportDir: `${p.assets.outDir}/${p.assets.assemblyDir}` };
  p.magicPrompts ??= {};
  if (typeof p.magicEnabled !== "boolean") p.magicEnabled = false;
  // The Story Bible is main-normalized on generation; read repair only drops
  // a corrupt shape so a bad file can't poison generation or the merge.
  if (p.magicBible !== undefined) {
    const b = p.magicBible as unknown as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || b.version !== 1 || typeof b.inputHash !== "string" || !Array.isArray(b.shotPlans) || !Array.isArray(b.entities) || !Array.isArray(b.scenes)) {
      delete (p as { magicBible?: unknown }).magicBible;
    }
  }
  if (p.magicRefDecisions !== undefined) {
    if (!p.magicRefDecisions || typeof p.magicRefDecisions !== "object" || Array.isArray(p.magicRefDecisions)) {
      delete (p as { magicRefDecisions?: unknown }).magicRefDecisions;
    } else {
      for (const [k, d] of Object.entries(p.magicRefDecisions)) {
        if (!d || typeof d !== "object" || typeof d.entityName !== "string" || !Array.isArray(d.refIds)) delete p.magicRefDecisions[k];
        else d.refIds = d.refIds.filter((x) => typeof x === "string");
      }
    }
  }
  if (p.magicDismissedRefs !== undefined) {
    p.magicDismissedRefs = Array.isArray(p.magicDismissedRefs)
      ? [...new Set(p.magicDismissedRefs.filter((n) => typeof n === "string").map((n) => n.trim().toLowerCase()).filter(Boolean))]
      : [];
  }
  // Clean stale magic entries for deleted shots and non-string values
  if (p.magicPrompts && typeof p.magicPrompts === "object") {
    // Outdated panels are preserved verbatim, so their magic prompts count as
    // live keys too — only truly-gone shots get pruned.
    const ids = new Set([
      ...p.scenes.flatMap((sc) => sc.shots.map((s) => s.id)),
      ...(p.outdatedShots ?? []).map((s) => s.id),
    ]);
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
  // Shot sequences are read-repaired here: dead member ids are pruned,
  // duplicates/corrupt entries dropped, and a sequence left with no member
  // vanishes. Outdated panels count as live members (like magicPrompts keys
  // above) so a re-ingest preserves sequences whole and a restore brings them
  // back; their clips are preserved by the write-side `removeShotSequence`
  // paths when a member is deleted for good. Absent stays absent (additive).
  if (p.shotSequences !== undefined) {
    const liveIds = new Set([
      ...p.scenes.flatMap((sc) => sc.shots.map((s) => s.id)),
      ...(p.outdatedShots ?? []).map((s) => s.id),
    ]);
    const liveRefIds = new Set((p.references ?? []).map((r) => r.id));
    p.shotSequences = normalizeShotSequences(p.shotSequences, liveIds, liveRefIds);
  }
  // The media registry is read-repaired: dedupe by path, drop terminal
  // `deleted` entries. (The present/missing disk sweep runs in
  // `loadProduction`'s bootstrap, after the migrations settle the paths.)
  p.media = normalizeMediaRegistry(p.media);
  // Color tags replaced the short-lived boolean `complete` marker: a marked
  // shot reads back green-tagged, the legacy key is dropped, and an
  // out-of-set tag value can't poison the border CSS class downstream.
  for (const s of [...p.scenes.flatMap((sc) => sc.shots), ...p.outdatedShots]) {
    const legacy = s as typeof s & { complete?: unknown };
    if (legacy.complete !== undefined) {
      if (legacy.complete === true && s.colorTag === undefined) s.colorTag = "green";
      delete legacy.complete;
    }
    if (s.colorTag !== undefined && !(["green", "yellow", "red"] as string[]).includes(s.colorTag)) delete s.colorTag;
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

/** One production's identity + folder without returning the whole document. */
export function getProductionMeta(id: string): ProductionMeta | null {
  const p = store.load(id);
  return p ? summary(p) : null;
}

/** Current production schema version. Bump when adding a one-time migration
 *  to migrateBoardArtwork; loads with >= this value skip the board walk. */
export const PRODUCTION_SCHEMA_VERSION = 3;

/** Oldest production schema the loader can migrate. Data below this cannot be
 *  brought forward safely, so it fails loudly with the version named instead
 *  of silently dropping fields. (v1 and unversioned legacy docs migrate.) */
export const MIN_PRODUCTION_SCHEMA_VERSION = 1;

/** Folder-only lookup for media serving: the production's folder without
 *  loading, cloning, migrating, or media-bootstrapping the document. */
export function productionFolder(id: string): string | null {
  return getProductionMeta(id)?.folder ?? null;
}

/** Perf phase 3: how long a load may reuse the previous load's media
 *  bootstrap for the SAME cached document object. `loadProduction` runs on
 *  nearly every IPC handler, and the bootstrap stats every referenced media
 *  file — measured at ~450ms per load on a real video-heavy project
 *  (372 referenced files), paid again by every click. The store hands back
 *  the identical cached object until a save or an external JSON change
 *  replaces it, so identity + a short TTL bounds the only staleness: a file
 *  deleted externally shows "present" for at most this long. */
const BOOTSTRAP_TTL_MS = 10_000;
const lastBootstrap = new Map<string, { obj: unknown; at: number }>();

/** Test seam — forget every remembered bootstrap so the next load re-sweeps. */
export function resetProductionLoadCacheForTests(): void {
  lastBootstrap.clear();
}

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
  // (Video-heavy documents reach ~600KB — the clone is still far cheaper
  // than the per-load media sweep the bootstrap cache below bounds.)
  // Perf 1.2: post-migration loads skip the full-board walk entirely. The
  // >= keeps a downgrade from silently stamping a newer document down.
  if (typeof p.schemaVersion === "number" && p.schemaVersion >= PRODUCTION_SCHEMA_VERSION) {
    // The media registry bootstraps on every load: upsert an entry per
    // referenced path, mark present/missing from disk (the storyboard's
    // explicit "Missing file" badge reads it), and prune entries no field
    // references. It bootstraps on the CACHED document (before the clone), so
    // ids stay stable across loads — a move re-points the path, never the id.
    // Same pattern for the stored node graphs: every canvas must own its
    // wiring at load so the canvas reads stored nodes/edges only.
    // Perf phase 3: all three sweeps are idempotent repairs of the cached
    // document — repeat loads of the identical cached object within the TTL
    // skip them (the clone below is still per-caller, unchanged).
    const seen = lastBootstrap.get(id);
    if (!seen || seen.obj !== p || Date.now() - seen.at >= BOOTSTRAP_TTL_MS) {
      mediaFiles.bootstrap(p, productionMediaRefs(p));
      backfillGenerationMediaIds(p);
      ensureShotGraphs(p);
      lastBootstrap.set(id, { obj: p, at: Date.now() });
    }
    return structuredClone(p);
  }
  // One-time migrations run on a COPY: validate the result, keep a
  // recoverable pre-migration backup, and only then replace the file.
  // A failing step leaves the original document untouched (the cached
  // object included) and names the step that failed. Always stamp, even
  // when the walk reports no change, so the next load hits the fast path
  // and a second load changes nothing.
  const fromVersion = typeof p.schemaVersion === "number" && Number.isFinite(p.schemaVersion) ? p.schemaVersion : 1;
  const working = structuredClone(p);
  try {
    migrateBoardArtwork(working);
  } catch (e) {
    throw new Error(`Migration failed during board/graph migration from schema ${fromVersion}: ${e instanceof Error ? e.message : String(e)}`);
  }
  working.schemaVersion = PRODUCTION_SCHEMA_VERSION;
  mediaFiles.bootstrap(working, productionMediaRefs(working));
  backfillGenerationMediaIds(working);
  ensureShotGraphs(working);
  validateMigratedProduction(working);
  writePreMigrationBackup(p.meta.id, fromVersion, p);
  store.save(working);
  return structuredClone(working);
}

/** Check the migrated document before it may replace the original:
 *  unique shot ids, every shot owns a stored graph with unique node ids
 *  and edges that land on real nodes, and output picks that name nodes
 *  which exist. Unknown node kinds and extra fields are preserved, never
 *  rejected. Throws naming the failing shot. */
/** Attach stable media-registry ids to generation takes (by their path's
 *  registry entry, created by the bootstrap just before this runs). Paths
 *  remain as compatibility data; consumers may resolve a take by id so a
 *  file move cannot orphan it. Idempotent: an existing id is kept. */
export function backfillGenerationMediaIds(p: Production): void {
  const media = p.media ?? [];
  if (!media.length) return;
  const byPath = new Map(media.map((e) => [e.path, e.id]));
  const attach = (gens: { path: string; mediaId?: string }[] | undefined): void => {
    for (const g of gens ?? []) {
      if (g.mediaId) continue;
      const id = byPath.get(g.path);
      if (id) g.mediaId = id;
    }
  };
  const shots = [...(p.scenes ?? []).flatMap((s) => s.shots ?? []), ...(p.outdatedShots ?? [])];
  for (const shot of shots) {
    attach(shot.graphImageGens);
    attach(shot.graphVideoGens);
    attach(shot.graphEditGens);
    for (const n of shot.graphVideoNodes ?? []) attach(n.gens);
    for (const n of shot.graphEditNodes ?? []) attach(n.gens);
    attach(shot.graphUpscale?.gens);
    for (const b of shot.graphTweenBlocks ?? []) attach(b.gens);
  }
}

export function validateMigratedProduction(p: Production): void {
  const seenShots = new Set<string>();
  const allShots = [...(p.scenes ?? []).flatMap((s) => s.shots ?? []), ...(p.outdatedShots ?? [])];
  {
    for (const shot of allShots) {
      const fail = (why: string): never => { throw new Error(`Migration validation failed for shot ${shot.id ?? "(missing id)"}: ${why}`); };
      if (!shot.id || seenShots.has(shot.id)) fail("duplicate or missing shot id");
      seenShots.add(shot.id);
      if (!shot.graph) fail("no stored graph after migration");
      const nodeIds = new Set<string>();
      for (const n of shot.graph!.nodes ?? []) {
        if (!n.id || nodeIds.has(n.id)) fail(`duplicate or missing graph node id "${n.id ?? ""}"`);
        nodeIds.add(n.id);
      }
      for (const e of shot.graph!.edges ?? []) {
        if (!nodeIds.has(e.from?.node) || !nodeIds.has(e.to?.node)) fail(`graph edge "${e.id ?? ""}" lands on a missing node`);
      }
      if (shot.graphOutputVideoNodeId && !(shot.graphVideoNodes ?? []).some((n) => n.id === shot.graphOutputVideoNodeId)) {
        fail(`selected video node "${shot.graphOutputVideoNodeId}" does not exist`);
      }
      if (shot.graphOutputEditNodeId && !(shot.graphEditNodes ?? []).some((n) => n.id === shot.graphOutputEditNodeId)) {
        fail(`selected edit node "${shot.graphOutputEditNodeId}" does not exist`);
      }
    }
  }
}

/** Keep the pre-migration document recoverable: one backup per starting
 *  version, written before the migrated file replaces the original and
 *  never overwritten by a retry, so the earliest original survives. */
export function writePreMigrationBackup(id: string, fromVersion: number, original: ProductionFile): string {
  const dir = path.join(store.dir(), "pre-migration");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}-v${fromVersion}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(original, null, 2), { encoding: "utf8", flag: "wx" });
  } catch { /* an earlier backup for this version already exists — keep it */ }
  return file;
}

/** Absolute paths of every artwork-bearing reference — reference images
 *  (characters, products, custom references) and video references' clips —
 *  feeding the thumbnail-cache regenerator so the node graph's tiles (and the
 *  moodboard shelf's video posters) are pre-generated for older projects. */
/** Absolute paths of every generated/imported video clip a production
 *  references (shot takes, tween blocks/output, sequences, video refs) —
 *  the video half of the thumbnail-cache regenerator: node previews are
 *  poster-first (perf phase 1), so pre-encoding these posters removes the
 *  first-view ffmpeg extract for generation clips, not just references. */
export function generationVideoThumbnailPaths(p: ProductionFile): string[] {
  return productionMediaRefs(p)
    .filter((rel) => /\.(mp4|m4v|mov|webm|mkv)$/i.test(rel))
    .map((rel) => assetPath(p, rel));
}

/** Absolute paths of every still image a production references (board
 *  frames, generation/edit/upscale takes, camera-grid sheets, style frames)
 *  — the image half of the thumbnail-cache regenerator: graph previews
 *  paint LOD tiers by settled zoom, so pre-encoding every tier removes the
 *  first-view resize encode for generated stills, not just references.
 *  Overlaps `referenceThumbnailPaths` harmlessly (the regenerator dedupes). */
export function generationImageThumbnailPaths(p: ProductionFile): string[] {
  return productionMediaRefs(p)
    .filter((rel) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(rel))
    .map((rel) => assetPath(p, rel));
}

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

/**
 * Reject a stale destructive edit with a recoverable conflict (Phase 4):
 * when the caller names the revision it built on (`baseRev`) and the
 * document moved since, throw naming the fresh revision instead of silently
 * applying — the caller refreshes and retries. An absent `baseRev` (or a
 * document without a revision yet) applies unconditionally, so older callers
 * keep working.
 */
export function assertFreshRevision(p: ProductionFile, baseRev?: number): void {
  if (typeof baseRev !== "number" || !Number.isFinite(baseRev)) return;
  if (typeof p.rev === "number" && p.rev !== baseRev) {
    const err = new Error(
      `Stale edit: this production changed since (rev ${baseRev} → ${p.rev}). Refresh and retry.`
    );
    (err as { freshRev?: number }).freshRev = p.rev;
    throw err;
  }
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
  incomingGrid: CameraGridData | undefined,
  removed: boolean
): CameraGridData | undefined {
  // The renderer explicitly cleared the node (delete-key held no sheet to
  // block it) — honour the deletion so it can't resurrect from the fresh
  // document. A plain absent value still keeps the fresh main-written sheet.
  if (removed) return undefined;
  if (!incomingGrid) return freshGrid;
  if (!freshGrid) return incomingGrid;
  const freshAt = typeof freshGrid.sheetAt === "string" ? freshGrid.sheetAt : "";
  const incomingAt = typeof incomingGrid.sheetAt === "string" ? incomingGrid.sheetAt : "";
  // Geometry (cols/rows + the panels/labels cut from them) is renderer-owned:
  // the node's size dropdown writes it, so the incoming value wins. The one
  // exception is a STALE renderer snapshot that predates the fresh sheet
  // write (older sheetAt): its geometry must not revert the size the sheet
  // was just generated/imported at, so the fresh geometry stands there.
  const geometry = incomingAt < freshAt ? freshGrid : incomingGrid;
  const merged: CameraGridData = {
    ...freshGrid,
    ...incomingGrid,
    cols: geometry.cols,
    rows: geometry.rows,
    ...(freshGrid.generation ? { generation: freshGrid.generation } : {}),
  };
  if (geometry.panels) merged.panels = geometry.panels;
  else delete merged.panels;
  if (geometry.panelLabels) merged.panelLabels = geometry.panelLabels;
  else delete merged.panelLabels;
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
  incomingNode: UpscaleData | undefined,
  removed: boolean
): UpscaleData | undefined {
  // The renderer explicitly cleared the node — honour the deletion.
  if (removed) return undefined;
  if (!incomingNode) return freshNode;
  if (!freshNode) return incomingNode;
  const { gens: _gens, genIndex: _idx, ...rest } = incomingNode;
  const node: UpscaleData = { ...freshNode, ...rest };
  node.genIndex = takeGenIndex(incomingNode.genIndex, incomingNode.gens, freshNode.genIndex, freshNode.gens);
  return node;
}

/** The identity + generation-history shape every node-graph list entry
 *  (edit-image / video / edit-video) shares, so membership + history merge
 *  once. */
interface GraphNodeHistory {
  id: string;
  gens?: { path: string }[];
  genIndex?: number;
}

/**
 * Merge one shot's node-graph list (edit-image or video nodes) by stable node
 * id. **The renderer owns membership** — the incoming snapshot's node list is
 * authoritative, so a deletion sticks (the union this replaced could never
 * tell "deleted" from "stale snapshot" and resurrected every node the fresh
 * document still held; see `mergeShotSequences`, which already works this way).
 * For a surviving id the fresh document owns the generation history (main-side
 * appends) and the incoming snapshot owns the editable fields (prompt, wiring,
 * model picks); an id only the incoming snapshot has is a renderer creation,
 * adopted whole.
 */
function mergeGraphNodes<T extends GraphNodeHistory>(
  freshNodes: T[] | undefined,
  incomingNodes: T[] | undefined
): T[] | undefined {
  if (!incomingNodes) return freshNodes;
  const freshById = new Map<string, T>();
  for (const n of freshNodes ?? []) {
    if (n && typeof n.id === "string" && !freshById.has(n.id)) freshById.set(n.id, n);
  }
  const out: T[] = [];
  const seen = new Set<string>();
  for (const inc of incomingNodes) {
    if (!inc || typeof inc.id !== "string" || seen.has(inc.id)) continue;
    seen.add(inc.id);
    const fn = freshById.get(inc.id);
    if (!fn) { out.push({ ...inc }); continue; }
    const { gens: _gens, genIndex: _idx, id: _id, ...rest } = inc;
    const node = { ...fn, ...rest } as T;
    node.genIndex = takeGenIndex(inc.genIndex, inc.gens, fn.genIndex, fn.gens);
    out.push(node);
  }
  return out;
}

/** Merge the shot-sequence list by stable id. The renderer owns the list and
 *  every editable field (span, canvas layout, accent, enable, duration, picks)
 *  so creations/edits/deletions ride through; only the per-entry video node's
 *  generation history is main-owned (generated takes land there) and merges
 *  exactly like the shot's video nodes — a stale renderer snapshot can never
 *  revert a finished sequence clip. Entries only the incoming snapshot has are
 *  creations racing this save — adopt them whole. */
function mergeShotSequences(
  freshSeqs: ShotSequence[] | undefined,
  incomingSeqs: ShotSequence[] | undefined
): ShotSequence[] {
  if (!incomingSeqs) return freshSeqs ?? [];
  const freshById = new Map<string, ShotSequence>();
  for (const s of freshSeqs ?? []) {
    if (s && typeof s.id === "string" && !freshById.has(s.id)) freshById.set(s.id, s);
  }
  return incomingSeqs.map((inc) => {
    const f = inc && typeof inc.id === "string" ? freshById.get(inc.id) : undefined;
    if (!f) return inc;
    const { graph: incGraph, id: _id, ...rest } = inc;
    const merged: ShotSequence = { ...f, ...rest, id: inc.id };
    // The canvas state is a shot-shaped sub-document: merge it with the same
    // per-shot rules (main owns the take histories, the renderer the wiring,
    // prompts, picks, and layout).
    if (incGraph) {
      merged.graph = mergeRendererShot(
        f.graph ?? { id: inc.id, number: inc.name, audio: "", visual: "" },
        incGraph
      );
    }
    return merged;
  });
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
  // Main-owned fields: never copied from the incoming snapshot. The set is
  // derived from the field-ownership table (shot-ownership.ts) — a field
  // added to ProductionShot must be classified there or the ownership test
  // fails, and its merge rule lands here automatically.
  const DENIED = new Set<string>([...SHOT_MERGE_DENIED_FIELDS, ...SHOT_INDEX_FIELDS]);
  const merged: ProductionShot = { ...freshShot };
  const mergedRec = merged as unknown as Record<string, unknown>;
  // Legacy fields no longer used (single-VO model, cuts-only timeline) —
  // stripped from whichever side still carries them so they don't resurface.
  delete mergedRec.voiceoverPath;
  delete mergedRec.transition;
  for (const [key, value] of Object.entries(incomingRec)) {
    if (DENIED.has(key)) continue;
    // The pipe mirrors (artwork/videoPath) and the per-node/block state have
    // dedicated merge rules below — skip them here. The list derives from the
    // ownership table (`SHOT_SPECIAL_FIELDS`).
    if (SHOT_SPECIAL_FIELDS.includes(key as keyof ProductionShot)) continue;
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
  // Node-graph membership is renderer-owned: the incoming node list is
  // authoritative, so deleting a node sticks. The fresh document still owns
  // each surviving node's generation history (see mergeGraphNodes).
  merged.graphEditNodes = mergeGraphNodes(freshShot.graphEditNodes, incoming.graphEditNodes);
  merged.graphVideoNodes = mergeGraphNodes(freshShot.graphVideoNodes, incoming.graphVideoNodes);
  merged.graphTweenBlocks = mergeTweenBlocks(freshShot.graphTweenBlocks, incoming.graphTweenBlocks);
  // The singleton tool nodes carry their deletion as an explicit undefined
  // (an absent value keeps the fresh main-written sheet/output, but an
  // explicit clear means "deleted").
  const clearedCameraGrid = "graphCameraGrid" in incomingRec && (incoming as { graphCameraGrid?: unknown }).graphCameraGrid == null;  const clearedUpscale = "graphUpscale" in incomingRec && (incoming as { graphUpscale?: unknown }).graphUpscale == null;
  merged.graphCameraGrid = mergeCameraGrid(freshShot.graphCameraGrid, incoming.graphCameraGrid, clearedCameraGrid);
  merged.graphUpscale = mergeUpscale(freshShot.graphUpscale, incoming.graphUpscale, clearedUpscale);
  // (Phase 4: the artwork/videoPath explicit-clear + legacy editvideo
  // ride-through are retired — the renderer no longer sends mirror values,
  // and every surface resolves the pipe live. The ref-output store still
  // writes through its command path, never the merge.)
  return merged;
}

/**
 * Apply a narrow graph-field patch to the freshest shot (the
 * production:updateGraphShotFields command). Only allow-listed
 * renderer-owned fields are taken from the patch; everything else on the
 * shot comes from the fresh document, and the per-node merges inside
 * mergeRendererShot keep each surviving node generation history
 * main-owned. A generation that landed after the renderer snapshot
 * therefore survives an unrelated graph edit.
 */
export function applyGraphShotPatch(
  freshShot: ProductionShot,
  patch: Partial<ProductionShot>
): ProductionShot {
  const allowed = pickGraphShotPatch(patch as Record<string, unknown>) as Partial<ProductionShot>;
  const incoming: ProductionShot = { ...freshShot, ...allowed };
  for (const key of Object.keys(allowed)) {
    if ((allowed as Record<string, unknown>)[key] === undefined) {
      (incoming as unknown as Record<string, unknown>)[key] = undefined;
    }
  }
  return mergeRendererShot(freshShot, incoming);
}

/**
 * Merge renderer-owned scene edits onto the freshest on-disk scenes.
 *
 * Whole-document renderer saves (`production:save`) are captured from the
 * renderer's snapshot, which can predate a structural change that committed
 * first — the classic case is a shot drag-reorder (new order, new numbers,
 * relocated board folders) racing an in-flight graph/text save. Copying the
 * incoming scenes wholesale would revert the order, reattach stale numbers,
 * and cross-wire frames between shots (pre-Phase-4 the pipe sync would then
 * "heal" the artwork from the wrong selection).
 *
 * So the fresh document owns everything structural — scene membership and
 * order, shot numbers, and all path-bearing fields — matched per shot by
 * stable id (a shot moved across scenes is found in its new scene). The
 *  incoming snapshot contributes only the fields the renderer edits. Shots the
 *  fresh document no longer has (deleted after the snapshot) stay deleted;
 *  the save's edits to surviving shots still apply. (Phase 4: the output
 *  mirrors are no longer re-derived here — every surface resolves the pipe
 *  live, so a stale save can't diverge them by construction.)
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
    // the edit-node list before the merge below reads it.
    migrateEditNodes(shot);
    // Same for the legacy single video-generation node, then the legacy
    // single edit-video node (which folds into the video-node list).
    migrateVideoNodes(shot);
    migrateEditVideoNodes(shot);
    // (Phase 4: the output mirrors are no longer re-derived here — every
    // surface resolves the pipe live through the shared display helper, so a
    // renderer save can't diverge them by construction.)
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
  // outdatedShots is main-owned (ingest archives panels; the restore/remove
  // handlers mutate it) — the fresh on-disk bucket always wins over a stale
  // renderer snapshot, which never edits it.
  // promptOverrides is keyed by displayed shot number and written main-side
  // (ingest stashes manual prompts, reorder remaps them) — the renderer never
  // edits it through a save, so the fresh map always wins. Replacing it with
  // a stale snapshot's map would reattach overrides to the wrong shots after
  // a reorder.
  fresh.promptOverrides =
    fresh.promptOverrides && typeof fresh.promptOverrides === "object" ? { ...fresh.promptOverrides } : {};
  // The media registry is main-owned (like promptOverrides): the media
  // service maintains it, and a stale renderer snapshot — captured before a
  // move/registration — must never revert an entry's path or state. It is
  // deliberately absent from the copy list above, so the fresh document's
  // registry always wins.
  fresh.media = normalizeMediaRegistry(fresh.media);
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
  // magicPrompts is main-owned, like promptOverrides: every renderer magic edit
  // goes through production:updateBoardPrompt, and bulk/per-shot generation
  // writes it main-side. A whole-document save carries a snapshot that can
  // predate a generation, so accepting its map would revert (or blank) fresh
  // prompts on other shots — the fresh on-disk map always wins.
  fresh.magicPrompts =
    fresh.magicPrompts && typeof fresh.magicPrompts === "object" ? { ...fresh.magicPrompts } : {};
  if (typeof p.magicEnabled === "boolean") fresh.magicEnabled = p.magicEnabled;
  // magicBible is main-owned like magicPrompts (written by the bulk Magic
  // pass main-side): deliberately not copied from the renderer snapshot, so
  // the fresh on-disk bible always wins. magicDismissedRefs IS renderer-owned
  // (the reconciliation queue's dismissals ride ordinary saves).
  if (Array.isArray(p.magicDismissedRefs)) {
    fresh.magicDismissedRefs = [...new Set(p.magicDismissedRefs.filter((n) => typeof n === "string").map((n) => n.trim().toLowerCase()).filter(Boolean))];
  }
  // The reference moodboard (node placements, viewport, notes) is renderer-owned
  // like the shot graph layouts. Its shape is repaired on read by the renderer's
  // `normalizeMoodboardLayout`; main only stores it verbatim so a save never
  // partitions it across two writers.
  if (p.moodboard && typeof p.moodboard === "object") fresh.moodboard = p.moodboard;
  // Shot sequences: renderer-owned span/canvas/picks (see mergeShotSequences),
  // with the per-entry generation history kept main-side — the same deal the
  // shot's video nodes get, one level up. Absent stays absent (additive).
  if (p.shotSequences !== undefined || fresh.shotSequences !== undefined) {
    fresh.shotSequences = mergeShotSequences(fresh.shotSequences, Array.isArray(p.shotSequences) ? p.shotSequences : undefined);
  }
  return fresh;
}

/**
 * Fold ONLY the magic-prompt keys a long-running job actually changed onto the
 * fresh on-disk map. `magicPrompts` is keyed by shot id and written one entry
 * at a time (bulk generation, per-shot regeneration, the prompt drawer's
 * updateBoardPrompt), so rebasing a finished job must not copy its whole
 * snapshot map — that reverts any other shot's prompt that landed while the job
 * ran. Pure so the per-key delta is unit-testable.
 */
export function applyMagicPromptDelta(
  fresh: Record<string, string> | undefined,
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined
): Record<string, string> {
  const out = { ...(fresh ?? {}) };
  const b = before ?? {};
  const a = after ?? {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (b[key] === a[key]) continue;
    if (typeof a[key] === "string") out[key] = a[key];
    else delete out[key];
  }
  return out;
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
      if (migrateVideoNodes(s)) changed = true;
      if (migrateEditVideoNodes(s)) changed = true;
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
  let { graph } = normalizeGraph(materializeGraph(shot, graphRefViews(p)));
  // Unknown future nodes survive normalization: the materializer only emits
  // registered kinds, so carry forward any stored node the registry doesn't
  // know — with its stored edges (normalize keeps unknown-kind edges
  // unvalidated) — instead of dropping its serialized data. A KNOWN kind the
  // materializer didn't emit is materializer-owned (a removed tool, healed
  // wiring) and is deliberately not carried.
  {
    const knownIds = new Set(graph.nodes.map((n) => n.id));
    for (const n of shot.graph?.nodes ?? []) {
      if (!n || typeof n.id !== "string" || knownIds.has(n.id) || nodeDecl(n.kind)) continue;
      knownIds.add(n.id);
      graph.nodes.push(n);
    }
    const edgeKeys = new Set(graph.edges.map((e) => e.id));
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const e of shot.graph?.edges ?? []) {
      if (!e || typeof e.id !== "string" || edgeKeys.has(e.id)) continue;
      if (!e.from || !e.to || !nodeIds.has(e.from.node) || !nodeIds.has(e.to.node)) continue;
      edgeKeys.add(e.id);
      graph.edges.push(e);
    }
    graph = normalizeGraph(graph).graph;
  }
  // Mirroring heal: the sidepanel shows a style (explicit pick or master
  // fallback) but materialize only knows the explicit pick — an implicit
  // master selection would otherwise open unwired. None never heals.
  if (!shot.styleNone && (shot.style ?? p.styles?.[0]?.id) && !styleEdgePresent(graph, "composer")) {
    graph = normalizeGraph(setStyleEdge(graph, "composer", true)).graph;
  }
  stripMigratedCopies(p, shot, graph);
  graph.migrated = true;
  shot.graph = graph;
  return true;
}

/**
 * Guarantee every canvas owns a stored graph at load: run the flag→graph
 * normalization for any shot (or sequence facade) whose stored wiring is
 * absent. The one-time `migrateBoardArtwork` walk only covers documents below
 * the schema stamp — shots created afterwards (insertShot, script re-ingest,
 * sequence creation) skip it, and today the canvas re-derives their wiring
 * live from prompt text until the first-open ensure persists it. With this
 * in place the canvas reads the stored graph (open-time ensure first view,
 * stored afterwards) instead of live derivation. Idempotent and additive:
 * settled shots are untouched.
 */
export function ensureShotGraphs(p: ProductionFile): void {
  for (const scene of p.scenes ?? []) {
    for (const shot of scene.shots ?? []) {
      if (!shot.graph) migrateShotGraph(p, shot);
    }
  }
  for (const shot of p.outdatedShots ?? []) {
    if (!shot.graph) migrateShotGraph(p, shot);
  }
  for (const seq of p.shotSequences ?? []) {
    if (seq.graph && !seq.graph.graph) migrateShotGraph(p, seq.graph);
  }
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
  for (const n of shot.graphVideoNodes ?? []) {
    const next = isVideoEditFamilyMode(n.mode)
      ? stripField(n.prompt, { editvideoprompt: n.id })
      : stripField(n.prompt, { videoprompt: n.id });
    if (next !== n.prompt) n.prompt = next ?? "";
  }
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
  const push = (id: string, name: string, aliases?: string[], media?: "video" | "audio", artwork?: string): void => {
    const key = (name ?? "").trim().toLowerCase();
    if (!id || !key || seen.has(key)) return;
    seen.add(key);
    out.push({ id, name: name.trim(), aliases, media, artwork });
  };
  for (const c of p.characters ?? []) push(c.id, c.name, c.aliases, undefined, c.artwork ?? c.imagePath);
  for (const pr of p.products ?? []) push(pr.id, pr.name, pr.aliases, undefined, pr.artwork ?? pr.imagePath);
  for (const r of p.references ?? []) push(r.id, r.name, r.aliases, r.media, r.artwork ?? r.imagePath ?? r.mediaPath);
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
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
    schemaVersion: PRODUCTION_SCHEMA_VERSION,
  };
  // Scaffold the asset folders inside the user's production folder.
  for (const d of [p.assets.boardsDir, p.assets.voiceoverDir, p.assets.musicDir, p.assets.outDir, p.assets.referencesDir, `${p.assets.outDir}/${p.assets.assemblyDir}`]) {
    try {
      fs.mkdirSync(path.join(folder, d), { recursive: true });
    } catch {
      /* non-fatal: user may add it later */
    }
  }
  saveProduction(p);
  return p;
}

const IMPORT_IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
const IMPORT_VIDEO_FILE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
const IMPORT_AUDIO_FILE = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;

/** Workspace-relative paths of the files directly inside an asset dir whose
 *  names match `rx` (missing dir → none). */
function listAssetFiles(p: ProductionFile, relDir: string, rx: RegExp): string[] {
  try {
    return fs.readdirSync(assetPath(p, relDir), { withFileTypes: true })
      .filter((e) => e.isFile() && rx.test(e.name))
      .map((e) => `${relDir}/${e.name}`);
  } catch {
    return [];
  }
}

/** The newest (by mtime) of the given workspace-relative files, if any. */
function newestAssetFile(p: ProductionFile, rels: string[]): string | undefined {
  let best: { rel: string; mtime: number } | undefined;
  for (const rel of rels) {
    try {
      const mtime = fs.statSync(assetPath(p, rel)).mtimeMs;
      if (!best || mtime > best.mtime) best = { rel, mtime };
    } catch { /* unreadable — skip */ }
  }
  return best?.rel;
}

/** Rebuild whatever pipeline state an imported folder still carries on disk
 *  onto the fresh document: the script breakdown (`script.md`), storyboard
 *  frames/clips (`boards/<NNNN>/`, plus any `boards/import/` drop-ins), shot
 *  prompts (`boards/prompts.md`), reference images, style frames, and the
 *  voiceover/music clips. Every artifact is recovered independently — one
 *  missing or unreadable file never blocks the rest, and nothing on disk is
 *  deleted or overwritten (`importBoards` copies drop-ins into per-shot
 *  folders, as it does from Step 3). JSON-only state (style prompt text,
 *  character/product identities, magic prompts, graph history) cannot be
 *  recovered from the folder alone. */
function hydrateImportedProduction(p: ProductionFile): void {
  // 1. Script breakdown — the deterministic script.md artifact, parsed back
  //    with the shots' original numbers (no model call).
  try {
    const md = fs.readFileSync(assetPath(p, p.assets.scriptMd), "utf8");
    const parsed = parseScriptMarkdown(md);
    if (parsed.name) p.meta.name = parsed.name;
    if (parsed.scenes.length) {
      p.scenes = parsed.scenes;
      p.status[1] = "done";
    }
  } catch { /* no readable script.md — board folders may still define shots */ }

  // 2. Board folders for shot numbers the script doesn't carry (or the only
  //    shot source when script.md is gone) become blank shots to hang the
  //    existing frames on.
  try {
    const numbers = fs.readdirSync(assetPath(p, p.assets.boardsDir), { withFileTypes: true })
      .filter((e) => e.isDirectory() && shotter.isValidNumber(e.name))
      .map((e) => e.name)
      .sort();
    const known = new Set(p.scenes.flatMap((s) => s.shots.map((sh) => sh.number)));
    const missing = numbers.filter((n) => !known.has(n));
    if (missing.length) {
      if (!p.scenes.length) p.scenes = [{ number: 1, title: "Scene 1", shots: [] }];
      const last = p.scenes[p.scenes.length - 1];
      for (const n of missing) last.shots.push(shotter.newShot(n));
      last.shots.sort((a, b) => a.number.localeCompare(b.number));
    }
  } catch { /* no boards dir — nothing to synthesize */ }

  const shots = p.scenes.flatMap((s) => s.shots);
  if (shots.length) {
    // 3. Shot prompts from the manual-workflow export, stored content-only
    //    (shared Style/Brand sections re-render from the style system) and
    //    marked manual so a later re-ingest preserves them.
    try {
      const md = fs.readFileSync(assetPath(p, `${p.assets.boardsDir}/prompts.md`), "utf8");
      const byNumber = parseBoardPromptsMarkdown(md);
      for (const shot of shots) {
        if (shot.prompt?.trim()) continue;
        const content = stripSharedSections(byNumber.get(shot.number) ?? "").trim();
        if (content) {
          shot.prompt = content;
          shot.promptManual = true;
        }
      }
    } catch { /* no prompts.md — prompts re-derive from audio/visual */ }

    // 4. Frames and clips already on disk: adopt boards/import/ drop-ins,
    //    then re-link each shot to its newest frame / orphan clips.
    try {
      const dropped = scanBoardImportFolder(p);
      if (dropped.length) importBoards(p, dropped, () => {});
    } catch { /* drop-in adoption is best-effort */ }
    try { refreshBoardLinks(p); } catch { /* frames can re-link on demand */ }
    try { refreshShotVideos(p); } catch { /* clips can re-link on demand */ }
    markBoardsStatus(p);
  }

  // 5. Reference images — the same adoption as the references-folder rescan
  //    (name from the filename; character/product identity is JSON-only).
  try {
    const rels = listAssetFiles(p, p.assets.referencesDir, IMPORT_IMAGE_FILE);
    for (const rel of unclaimedReferenceFiles(rels, p)) {
      const name = path.basename(rel).replace(/\.[^.]+$/, "").replace(/\s+/g, " ").trim() || "Reference";
      p.references = [...(p.references ?? []), { id: newRefId(), name, imagePath: rel, shotIds: [] }];
    }
    // Dropped video/audio files recover as media references, like the rescan.
    for (const [rx, kind] of [[IMPORT_VIDEO_FILE, "video"], [IMPORT_AUDIO_FILE, "audio"]] as const) {
      for (const rel of unclaimedReferenceFiles(listAssetFiles(p, p.assets.referencesDir, rx), p)) {
        const name = path.basename(rel).replace(/\.[^.]+$/, "").replace(/\s+/g, " ").trim() || "Reference";
        p.references = [...(p.references ?? []), { id: newRefId(), name, media: kind, mediaPath: rel, shotIds: [] }];
      }
    }
  } catch { /* references can be rescanned later from Step 2 */ }

  // 6. Style frames (look plates). Collision copies (`<id> (2).png`) are
  //    older writes of the same style — the newest file per base wins. The
  //    style's prompt text is JSON-only, so recovered styles start blank.
  try {
    const byBase = new Map<string, string[]>();
    for (const rel of listAssetFiles(p, STYLES_DIR, IMPORT_IMAGE_FILE)) {
      const base = path.basename(rel).replace(/\.[^.]+$/, "").replace(/\s+\(\d+\)$/, "");
      byBase.set(base, [...(byBase.get(base) ?? []), rel]);
    }
    for (const [base, rels] of byBase) {
      const imagePath = newestAssetFile(p, rels);
      if (!imagePath) continue;
      p.styles = [...(p.styles ?? []), { id: randomUUID(), index: (p.styles?.length ?? 0) + 1, name: base, prompt: "", imagePath }];
    }
  } catch { /* style frames can be re-attached from Step 2 */ }

  // 7. Voiceover / music — the newest clip in each folder.
  p.voiceoverPath ??= newestAssetFile(p, listAssetFiles(p, p.assets.voiceoverDir, IMPORT_AUDIO_FILE));
  p.musicPath ??= newestAssetFile(p, listAssetFiles(p, p.assets.musicDir, IMPORT_AUDIO_FILE));

  // 8. Land where the recovered work is: storyboard when frames exist,
  //    design when only the breakdown came back.
  if (shots.length) {
    p.currentStep = shots.some((s) => s.artwork || s.graphImageGens?.length) ? 3 : 2;
  }
}

/**
 * Re-register an existing production folder (e.g. after moving to a new PC
 * or wiping app data, the userData/productions/ JSON is gone but the folder
 * with boards/, script.md, … survives). The folder ITSELF becomes the
 * production folder — unlike newProduction, no subfolder is created. Missing
 * asset dirs are scaffolded non-destructively, and the pipeline state the
 * folder still carries on disk (script breakdown, storyboard frames/clips,
 * prompts, references, style frames, voiceover/music) is rebuilt onto the
 * new document by `hydrateImportedProduction`. Re-importing an
 * already-registered folder returns the existing document instead of a
 * duplicate.
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
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
    schemaVersion: PRODUCTION_SCHEMA_VERSION,
  };
  // Scaffold only what's missing — never delete or overwrite.
  for (const d of [p.assets.boardsDir, p.assets.voiceoverDir, p.assets.musicDir, p.assets.outDir, p.assets.referencesDir, `${p.assets.outDir}/${p.assets.assemblyDir}`]) {
    try {
      fs.mkdirSync(path.join(resolved, d), { recursive: true });
    } catch {
      /* non-fatal: user may add it later */
    }
  }
  // Rebuild the pipeline state the folder still carries (script, storyboard,
  // references, …) instead of presenting an empty production.
  hydrateImportedProduction(p);
  saveProduction(p);
  // Return the fully loaded document (stored graphs + media registry
  // materialized), exactly as a production:load would hand it over.
  return loadProduction(p.meta.id) ?? p;
}

/**
 * Step 2: create or update a production style. `styleId` targets a specific
 * style; otherwise the master (styles[0]) is updated, and a new style is
 * appended (position = length + 1) when the production has none yet. The
 * caller persists the returned document (main owns the write) — used by the
 * chat agent's `cascade_set_style` tool.
 */
export function upsertProductionStyle(
  p: ProductionFile,
  input: { name: string; prompt: string; styleId?: string }
): ProductionFile {
  p.styles ??= [];
  const target = input.styleId ? p.styles.find((s) => s.id === input.styleId) : p.styles[0];
  if (target) {
    target.name = input.name;
    target.prompt = input.prompt;
    return p;
  }
  p.styles.push({
    id: randomUUID(),
    index: p.styles.length + 1,
    name: input.name,
    prompt: input.prompt,
  });
  return p;
}

export function deleteProduction(id: string): boolean {
  return store.remove(id);
}

export function archiveProduction(id: string): boolean {
  return store.archive(id);
}