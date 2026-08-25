/**
 * Production persistence: one JSON file per production under
 * userData/productions/, mirroring the sessions.ts pattern. The production's
 * own folder (anywhere on disk) holds generated assets; this file holds the
 * pipeline state.
 */
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Production, ProductionMeta } from "../shared/ipc.js";

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
  p.openArt ??= { model: "auto", resolution: "1k" };
  p.status ??= {};
  p.visualStyle ??= "";
  p.styles ??= [];
  p.brand ??= { colors: [], font: "" };
  p.currentStep ??= 1;
  p.assets ??= { scriptMd: "script.md", designDir: "design", boardsDir: "boards", outDir: "out" };
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
    return normalize(JSON.parse(fs.readFileSync(filePath(id), "utf8")));
  } catch {
    return null;
  }
}

export function saveProduction(p: ProductionFile): void {
  normalize(p);
  p.meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath(p.meta.id), JSON.stringify(p, null, 2), "utf8");
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
    assets: { scriptMd: "script.md", designDir: "design", boardsDir: "boards", outDir: "out" },
  };
  // Scaffold the asset folders inside the user's production folder.
  for (const d of [p.assets.designDir, p.assets.boardsDir, p.assets.outDir]) {
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
