/**
 * Production persistence: one JSON file per production under
 * userData/productions/, mirroring the sessions.ts pattern. The production's
 * own folder (anywhere on disk) holds generated assets; this file holds the
 * pipeline state. The document lifecycle is the shared store; this module owns
 * the normalize-on-read pass and the asset-folder scaffolding.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Production, ProductionMeta, ProductionShot } from "../shared/ipc.js";
import { migrateBoardArtworkToJpeg, migrateGraphGenerations, relocateBoardLayout, migrateReferenceArtwork, syncBoardOutputToPipe, syncTweenBlocks, assetPath } from "./pipeline.js";
import { createStore } from "./store.js";

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
  p.assets ??= { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" };
  p.assets.voiceoverDir ??= "voiceover";
  p.assets.musicDir ??= "music";
  p.assets.videosDir ??= "videos";
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
  return p;
}

const store = createStore<ProductionFile>({
  dirName: "productions",
  idOf: (p) => p.meta.id,
  decode: normalize,
  sortKey: (p) => p.meta.updatedAt,
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

export function loadProduction(id: string): ProductionFile | null {
  const p = store.load(id);
  if (!p) return null;
  // One-time migrations (legacy PNGs → JPEGs; classic generations seed the
  // node-graph generation nodes). Persist in place so the very next read
  // sees the new layout.
  if (migrateBoardArtwork(p)) store.save(p);
  return p;
}

/** Absolute paths of every artwork-bearing reference image (characters,
 *  products, custom references) — feeds the thumbnail-cache regenerator so
 *  the node graph's reference tiles are pre-generated for older projects. */
export function referenceImagePaths(p: ProductionFile): string[] {
  return [...(p.characters ?? []), ...(p.products ?? []), ...(p.references ?? [])]
    .filter((r) => !!r.imagePath)
    .map((r) => assetPath(p, r.imagePath!));
}

export function saveProduction(p: ProductionFile): void {
  normalize(p);
  p.meta.updatedAt = new Date().toISOString();
  store.save(p);
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
  fresh.scenes = Array.isArray(p.scenes) ? p.scenes.map((sc) => ({
    ...sc,
    shots: sc.shots.map((sh) => {
      // Legacy fields no longer used (single-VO model, cuts-only timeline).
      const { voiceoverPath: _v, transition: _t, ...rest } = sh as typeof sh & { voiceoverPath?: unknown; transition?: unknown };
      // The output pipe is authoritative: re-derive artwork/videoPath so a
      // renderer save with a stale or missing frame can't diverge from the
      // graph's frame output node (e.g. an edit-image node piped to output).
      syncBoardOutputToPipe(rest);
      // Tween keyframes must point at live references — prune deleted refs so
      // a stale save can't leave phantom action blocks behind.
      syncTweenBlocks(p, rest);
      return rest;
    }),
  })) : [];
  fresh.promptOverrides =
    p.promptOverrides && typeof p.promptOverrides === "object"
      ? Object.fromEntries(Object.entries(p.promptOverrides).filter(([, v]) => typeof v === "string" && v.trim()))
      : {};
  fresh.characters = Array.isArray(p.characters) ? p.characters : [];
  fresh.products = Array.isArray(p.products) ? p.products : [];
  fresh.references = Array.isArray(p.references) ? p.references : [];
  fresh.suggestedReferences = Array.isArray(p.suggestedReferences) ? p.suggestedReferences : [];
  fresh.referenceCategories = Array.isArray(p.referenceCategories) ? p.referenceCategories : [];
  if (p.openArt && typeof p.openArt.model === "string" && typeof p.openArt.resolution === "string") {
    fresh.openArt = { model: p.openArt.model, resolution: p.openArt.resolution };
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
  if (p.magicPrompts && typeof p.magicPrompts === "object") {
    fresh.magicPrompts = Object.fromEntries(Object.entries(p.magicPrompts).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, String(v).trim().slice(0, 2000)]));
  } else if (p.magicPrompts === undefined) {
    fresh.magicPrompts = fresh.magicPrompts ?? {};
  }
  if (typeof p.magicEnabled === "boolean") fresh.magicEnabled = p.magicEnabled;
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
      if (syncTweenBlocks(p, s)) changed = true;
      if (s.artwork && migrateBoardArtworkToJpeg(p, s)) changed = true;
      if (relocateBoardLayout(p, s)) changed = true;
      if (syncBoardOutputToPipe(s)) changed = true;
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
  if (migrateReferenceArtwork(p)) changed = true;
  return changed;
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
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
  };
  // Scaffold the asset folders inside the user's production folder.
  for (const d of [p.assets.boardsDir, p.assets.voiceoverDir, p.assets.musicDir, p.assets.videosDir, p.assets.outDir, p.assets.referencesDir, p.assets.modelsDir, `${p.assets.outDir}/${p.assets.assemblyDir}`]) {
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
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
  };
  // Scaffold only what's missing — never delete or overwrite.
  for (const d of [p.assets.boardsDir, p.assets.voiceoverDir, p.assets.musicDir, p.assets.videosDir, p.assets.outDir, p.assets.referencesDir, p.assets.modelsDir, `${p.assets.outDir}/${p.assets.assemblyDir}`]) {
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