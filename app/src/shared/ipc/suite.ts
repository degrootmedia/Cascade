/**
 * Image Generation & Editing Suite types (Spec 01).
 *
 * Domain module of `shared/ipc.ts`; the barrel re-exports everything, so
 * `../shared/ipc.js` import paths are unchanged.
 *
 * The suite is vendor-blind: it only knows `MediaProvider`-shaped concepts
 * (a namespaced model id, a resolution, an aspect ratio, a params bag) and
 * production-relative output paths served over `cascade-media://`. No vendor
 * id ever appears in this file, so a new backend needs zero suite changes.
 */
import type { GenParams } from "./graph.js";
import type { CustomRef, ImageGenAspectRatio, Production } from "./production.js";

/** The suite's three modes: generate from a prompt, edit an image with a
 *  prompt, or upscale an image (no prompt — an upscale-capable model). */
export type SuiteMode = "generate" | "edit" | "upscale";

/** One immutable generation/edit result in the suite timeline. */
export interface SuiteEntry {
  /** Stable uuid (renderer-generated). */
  id: string;
  /** Branch parent entry id; null for a root entry. */
  parentId: string | null;
  kind: SuiteMode;
  /** ISO timestamp. */
  createdAt: string;
  /** Provider-namespaced model id actually submitted (opaque here). */
  model: string;
  resolution: string;
  aspectRatio?: ImageGenAspectRatio;
  prompt: string;
  /** Resolved `@[name]` tag names present in `prompt` at submit time. */
  promptRefs: string[];
  /** Production-relative path of the output (`cascade-media://` serves it). */
  outputPath: string;
  /** Source reference id for edits; absent for pure generations. */
  sourceRefId?: string;
  /** Source image path for edits when the source isn't a production reference
   *  (a node-graph frame or a shot's board frame). Production-relative. */
  sourcePath?: string;
  /** Reference ids passed in at submit time. */
  refIds: string[];
  params?: GenParams;
  /** Live credit quote captured at submit time (display only). */
  quotedCredits?: number;
  /** Failure message when the submit failed (the entry is kept for history). */
  error?: string | null;
}

/** The prompt-panel draft, persisted so it survives tab switches and restarts. */
export interface SuiteDraft {
  mode: SuiteMode;
  prompt: string;
  model: string;
  resolution: string;
  aspectRatio?: ImageGenAspectRatio;
  refIds: string[];
  sourceRefId?: string;
  /** Production-relative source image when editing a non-reference frame. */
  sourcePath?: string;
  params?: GenParams;
}

/** A handoff payload from an existing popup into the suite (not persisted). */
export type SuiteSeed = SuiteDraft;

/** Persisted per-production suite state. */
export interface SuiteSession {
  version: 1;
  entries: SuiteEntry[];
  /** Timeline selection restored on reopen. */
  selectedId: string | null;
  draft: SuiteDraft;
}

/** Where a suite entry's output is exported to. `boards` copies the file into
 *  the production's boards folder; `references` adds a citable reference. */
export type SuiteExportTarget = "references" | "boards";

/** One suite submit. The suite is vendor-blind — `model` is a namespaced id
 *  the active `MediaProvider` resolves (or "auto"/empty for the house
 *  default). */
export interface SuiteGenerateRequest {
  kind: SuiteMode;
  /** Branch parent when replaying an entry; null for a new root. */
  parentId?: string | null;
  model: string;
  resolution: string;
  aspectRatio?: ImageGenAspectRatio;
  prompt: string;
  /** Edit mode: the reference whose current image is the source. */
  sourceRefId?: string;
  /** Edit mode: a production-relative source image path (non-reference frame).
   *  Ignored when `sourceRefId` is set. */
  sourcePath?: string;
  /** Extra reference ids to upload (beyond @tag auto-resolution). */
  refIds?: string[];
  params?: GenParams;
  /** Live credit quote captured by the renderer (display only). */
  quotedCredits?: number;
}

/** Result of a suite export: the created reference (null for `boards`), the
 *  production-relative path of the exported file, and the updated production. */
export interface SuiteExportResult {
  path: string;
  ref: CustomRef | null;
  production: Production;
}

/** Upper bound on stored entries per production — oldest leaf entries are
 *  pruned first so a long-running suite can't grow the session file forever. */
export const SUITE_ENTRY_CAP = 500;

/** The empty draft the suite starts from (also the seed fallback). */
export function emptySuiteDraft(): SuiteDraft {
  return { mode: "generate", prompt: "", model: "", resolution: "1k", refIds: [] };
}

/** A fresh, empty session document. */
export function emptySuiteSession(): SuiteSession {
  return { version: 1, entries: [], selectedId: null, draft: emptySuiteDraft() };
}

const ASPECTS: ImageGenAspectRatio[] = ["1:1", "4:3", "16:9"];

function normalizeAspect(v: unknown): ImageGenAspectRatio | undefined {
  return typeof v === "string" && (ASPECTS as string[]).includes(v) ? (v as ImageGenAspectRatio) : undefined;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

function normalizeParams(v: unknown): GenParams | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: GenParams = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
    else if (typeof val === "number" || typeof val === "boolean") out[k] = String(val);
    else if (Array.isArray(val) && val.every((e) => typeof e === "string")) out[k] = val.join(",");
  }
  return Object.keys(out).length ? out : undefined;
}

/** Coerce a stored/legacy mode to the current union (unknown → "generate"). */
function normalizeSuiteMode(v: unknown): SuiteMode {
  return v === "edit" ? "edit" : v === "upscale" ? "upscale" : "generate";
}

function normalizeDraft(raw: unknown): SuiteDraft {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const draft: SuiteDraft = {
    mode: normalizeSuiteMode(d.mode),
    prompt: typeof d.prompt === "string" ? d.prompt.slice(0, 8000) : "",
    model: typeof d.model === "string" ? d.model : "",
    resolution: typeof d.resolution === "string" && d.resolution ? d.resolution : "1k",
    refIds: stringList(d.refIds),
  };
  const aspect = normalizeAspect(d.aspectRatio);
  if (aspect) draft.aspectRatio = aspect;
  if (typeof d.sourceRefId === "string" && d.sourceRefId) draft.sourceRefId = d.sourceRefId;
  if (typeof d.sourcePath === "string" && d.sourcePath && isProductionRelative(d.sourcePath)) draft.sourcePath = d.sourcePath;
  const params = normalizeParams(d.params);
  if (params) draft.params = params;
  return draft;
}

function normalizeEntry(raw: unknown): SuiteEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id) return null;
  if (typeof e.outputPath !== "string" || !isProductionRelative(e.outputPath)) return null;
  const entry: SuiteEntry = {
    id: e.id,
    parentId: typeof e.parentId === "string" && e.parentId ? e.parentId : null,
    kind: normalizeSuiteMode(e.kind),
    createdAt: typeof e.createdAt === "string" && e.createdAt ? e.createdAt : new Date(0).toISOString(),
    model: typeof e.model === "string" ? e.model : "",
    resolution: typeof e.resolution === "string" && e.resolution ? e.resolution : "1k",
    prompt: typeof e.prompt === "string" ? e.prompt.slice(0, 8000) : "",
    promptRefs: stringList(e.promptRefs),
    outputPath: e.outputPath,
    refIds: stringList(e.refIds),
  };
  const aspect = normalizeAspect(e.aspectRatio);
  if (aspect) entry.aspectRatio = aspect;
  if (typeof e.sourceRefId === "string" && e.sourceRefId) entry.sourceRefId = e.sourceRefId;
  if (typeof e.sourcePath === "string" && e.sourcePath && isProductionRelative(e.sourcePath)) entry.sourcePath = e.sourcePath;
  const params = normalizeParams(e.params);
  if (params) entry.params = params;
  if (typeof e.quotedCredits === "number" && Number.isFinite(e.quotedCredits)) entry.quotedCredits = e.quotedCredits;
  if (typeof e.error === "string" && e.error) entry.error = e.error.slice(0, 2000);
  return entry;
}

/** Coerce an untrusted session payload to the current shape. Never throws —
 *  a corrupt file / IPC payload yields an empty session (the caller logs). */
export function normalizeSuiteSession(raw: unknown): SuiteSession {
  if (!raw || typeof raw !== "object") return emptySuiteSession();
  const s = raw as Record<string, unknown>;
  const entries = Array.isArray(s.entries)
    ? s.entries.map(normalizeEntry).filter((e): e is SuiteEntry => e !== null)
    : [];
  const selectedId = typeof s.selectedId === "string" && entries.some((e) => e.id === s.selectedId) ? s.selectedId : null;
  return { version: 1, entries, selectedId, draft: normalizeDraft(s.draft) };
}

/** True when `rel` is a safe production-relative path: non-empty, no NUL, and
 *  no `..` segment (which could escape the production root). The main-side
 *  `assetPath` re-checks containment; this is the cheap IPC-boundary guard. */
export function isProductionRelative(rel: unknown): rel is string {
  if (typeof rel !== "string" || !rel.trim() || rel.includes("\0")) return false;
  if (rel.startsWith("/") || rel.startsWith("\\") || /^[a-zA-Z]:/.test(rel)) return false;
  const parts = rel.split(/[\\/]+/);
  return parts.every((seg) => seg !== "..");
}

/** Prune a session to the entry cap, dropping oldest leaf entries first (an
 *  entry nothing branches from); roots protect their descendants. Returns the
 *  pruned session (or the input when already within cap). */
export function pruneSuiteSession(session: SuiteSession): SuiteSession {
  if (session.entries.length <= SUITE_ENTRY_CAP) return session;
  const order = [...session.entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const kept = new Set(session.entries.map((e) => e.id));
  const remainingChildren = (id: string): boolean =>
    session.entries.some((c) => c.parentId === id && kept.has(c.id));
  // Repeat passes: removing a leaf can turn its parent into one.
  let changed = true;
  while (kept.size > SUITE_ENTRY_CAP && changed) {
    changed = false;
    for (const e of order) {
      if (kept.size <= SUITE_ENTRY_CAP) break;
      if (!kept.has(e.id) || remainingChildren(e.id)) continue;
      kept.delete(e.id);
      changed = true;
    }
  }
  if (kept.size === session.entries.length) return session;
  const entries = session.entries.filter((e) => kept.has(e.id));
  const selectedId = session.selectedId && kept.has(session.selectedId) ? session.selectedId : null;
  return { ...session, entries, selectedId };
}
