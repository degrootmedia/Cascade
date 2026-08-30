/**
 * Production persistence: one JSON file per production under
 * userData/productions/, mirroring the sessions.ts pattern. The production's
 * own folder (anywhere on disk) holds generated assets; this file holds the
 * pipeline state.
 */
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Production, ProductionMeta, ProductionShot } from "../shared/ipc.js";
import { migrateBoardArtworkToJpeg, migrateGraphGenerations, relocateBoardLayout, migrateReferenceArtwork } from "./pipeline.js";

export interface ProductionFile extends Production {}

function productionsDir(): string {
  const dir = path.join(app.getPath("userData"), "productions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function filePath(id: string): string {
  return path.join(productionsDir(), `${id}.json`);
}

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
  p.assets ??= { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references" };
  p.assets.voiceoverDir ??= "voiceover";
  p.assets.musicDir ??= "music";
  p.assets.videosDir ??= "videos";
  p.assets.referencesDir ??= "references";
  if (typeof (p as unknown as { voiceoverVolume?: unknown }).voiceoverVolume !== "number") {
    // Default voiceover volume when a VO exists, otherwise leave undefined for fresh projects.
    if (p.voiceoverPath) (p as ProductionFile).voiceoverVolume = 1;
  }
  if (typeof (p as unknown as { musicVolume?: unknown }).musicVolume !== "number") {
    if (p.musicPath) (p as ProductionFile).musicVolume = 0.5;
  }
  return p;
}

export function listProductions(): ProductionMeta[] {
  const metas: ProductionMeta[] = [];
  for (const f of fs.readdirSync(productionsDir())) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = normalize(JSON.parse(fs.readFileSync(filePath(f.replace(/\.json$/, "")), "utf8")));
      metas.push(summary(p));
    } catch {
      /* skip corrupt files */
    }
  }
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

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

export function loadProduction(id: string): ProductionFile | null {
  try {
    const p = normalize(JSON.parse(fs.readFileSync(filePath(id), "utf8")));
    // One-time migrations (legacy PNGs → JPEGs; classic generations seed the
    // node-graph generation nodes). Persist in place so the very next read
    // sees the new layout — done directly here to avoid a self-reference to
    // this module.
    if (migrateBoardArtwork(p)) {
      try { fs.writeFileSync(filePath(p.meta.id), JSON.stringify(p, null, 2), "utf8"); } catch { /* best-effort */ }
    }
    return p;
  } catch {
    return null;
  }
}

export function saveProduction(p: ProductionFile): void {
  normalize(p);
  p.meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath(p.meta.id), JSON.stringify(p, null, 2), "utf8");
}

/** Walk every shot's artwork + history and convert any legacy PNG paths to
 *  the new JPEG layout. Returns true if anything changed. */
function migrateBoardArtwork(p: Production): boolean {
  let changed = false;
  for (const sc of p.scenes) {
    for (const s of sc.shots) {
      if (migrateGraphGenerations(s)) changed = true;
      if (migrateGraphPipes(s)) changed = true;
      if (s.artwork && migrateBoardArtworkToJpeg(p, s)) changed = true;
      if (relocateBoardLayout(p, s)) changed = true;
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

export function newProduction(name: string, folder: string): ProductionFile {
  const now = new Date().toISOString();
  const meta: ProductionMeta = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim() || path.basename(folder) || "Untitled production",
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
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references" },
  };
  // Scaffold the asset folders inside the user's production folder.
  for (const d of [p.assets.boardsDir, p.assets.voiceoverDir, p.assets.musicDir, p.assets.videosDir, p.assets.outDir, p.assets.referencesDir]) {
    try {
      fs.mkdirSync(path.join(folder, d), { recursive: true });
    } catch {
      /* non-fatal: user may add it later */
    }
  }
  saveProduction(p);
  return p;
}

export function deleteProduction(id: string): boolean {
  try {
    fs.rmSync(filePath(id), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function archiveProduction(id: string): boolean {
  const src = filePath(id);
  const archiveDir = path.join(productionsDir(), "archive");
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(src, path.join(archiveDir, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}
