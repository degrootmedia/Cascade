/**
 * Image-suite session persistence. One JSON document per production under
 * userData/suites/<productionId>.json — the suite's timeline + draft, kept
 * separate from the production document (it is UI state, not pipeline state,
 * and can grow to hundreds of entries). Uses the shared atomic `createStore`
 * (temp + rename) so a crash mid-write can't corrupt the session. Every read
 * and write goes through `normalizeSuiteSession`, so an untrusted renderer
 * payload or a hand-edited file can never introduce a path that escapes the
 * production root.
 */
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  emptySuiteSession,
  normalizeSuiteSession,
  pruneSuiteSession,
  type SuiteSession,
} from "../shared/ipc.js";
import { createStore } from "./store.js";

/** One production's suite document (the store needs an id field). */
interface SuiteDoc {
  productionId: string;
  session: SuiteSession;
}

const store = createStore<SuiteDoc>({
  dirName: "suites",
  idOf: (d) => d.productionId,
  sortKey: (d) => d.productionId,
  decode: (d) => ({ productionId: d.productionId, session: normalizeSuiteSession(d.session) }),
  encode: (d) => ({ productionId: d.productionId, session: pruneSuiteSession(d.session) }),
});

/** Load one production's suite session; a missing/corrupt file yields empty. */
export function loadSuiteSession(productionId: string): SuiteSession {
  try {
    return store.load(productionId)?.session ?? emptySuiteSession();
  } catch {
    return emptySuiteSession();
  }
}

/** Persist one production's suite session (normalized + capped). */
export function saveSuiteSession(productionId: string, session: SuiteSession): SuiteSession {
  const normalized = pruneSuiteSession(normalizeSuiteSession(session));
  store.save({ productionId, session: normalized });
  return normalized;
}

/** Drop one entry from the session document (file unlinking is the caller's
 *  job — it owns the production document for path resolution). */
export function removeSuiteEntry(productionId: string, entryId: string): SuiteSession {
  const session = loadSuiteSession(productionId);
  const next: SuiteSession = {
    ...session,
    entries: session.entries.filter((e) => e.id !== entryId),
  };
  if (next.selectedId === entryId) next.selectedId = null;
  return saveSuiteSession(productionId, next);
}

/** Remove a production's whole suite document (production hard-delete hook). */
export function removeSuiteSession(productionId: string): void {
  store.remove(productionId);
}

/** Archive a production's suite document (production archive hook). */
export function archiveSuiteSession(productionId: string): void {
  store.archive(productionId);
}

/** Where a suite output file lives inside a production, as a production-relative
 *  path. Kept here so the generation wiring and the media protocol agree. */
export const SUITE_DIR_NAME = "suite";

export function suiteDirRel(outDir: string): string {
  return `${outDir}/${SUITE_DIR_NAME}`;
}

/** Resolve a unique production-relative filename for a new suite output:
 *  `<dir>/<base>.<ext>`, suffixed ` (2)`, ` (3)`, … when taken. */
export function uniqueSuiteRel(
  dir: string,
  base: string,
  ext: string,
  exists: (rel: string) => boolean
): string {
  const safe = base.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "suite";
  let rel = `${dir}/${safe}.${ext}`;
  let i = 2;
  while (exists(rel)) {
    rel = `${dir}/${safe} (${i}).${ext}`;
    i++;
  }
  return rel;
}

/** Detect an image format from magic bytes (mirrors the reference/board path). */
export function imageExtFor(buf: Buffer): string {
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  return "png";
}

/** The suite-document directory (support-report / diagnostics). */
export function suiteStoreDir(): string {
  return path.join(app.getPath("userData"), "suites");
}

/** Best-effort unlink of a production-relative suite file. Never throws. */
export function unlinkSuiteFile(productionFolder: string, rel: string | null | undefined): void {
  if (!rel) return;
  try {
    const abs = path.resolve(productionFolder, rel);
    const root = path.resolve(productionFolder);
    if (abs !== root && !abs.startsWith(root + path.sep)) return;
    fs.rmSync(abs, { force: true });
  } catch {
    /* already gone */
  }
}
