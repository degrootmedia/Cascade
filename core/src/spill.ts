/**
 * Tool-output spill: oversized tool results are written to disk instead of
 * being silently truncated.
 *
 * The model receives a short head preview plus the spill file path, the total
 * size, and instructions for paging through it with `read_file`
 * (offset/limit) or `grep`. Nothing is destroyed — the spilled file holds the
 * exact bytes (byte-for-byte, including trailing newline).
 *
 * Spill files live under `<workspace>/.cascade/tool-output/` so they inherit
 * the same workspace containment as every other file tool. The directory is
 * created lazily and pruned to the most recent N files.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { WorkspaceError } from "./workspace.js";

/** Workspace-relative scratch dir for spilled tool output. */
export const SPILL_DIR = ".cascade/tool-output";

/** Default threshold: content longer than this spills instead of truncating. */
export const DEFAULT_SPILL_THRESHOLD_CHARS = 10_000;

/** Default head preview included in the result alongside the spill path. */
export const DEFAULT_SPILL_PREVIEW_CHARS = 2000;

/** Pruning keeps this many of the most recent spill files. */
export const MAX_SPILL_FILES = 20;

export interface SpillOptions {
  /** Threshold in chars above which content spills (default 10_000). */
  thresholdChars?: number;
  /** Head preview chars included in the descriptor (default 2000). */
  previewChars?: number;
  /** Maximum spill files to keep after pruning (default 20). */
  keep?: number;
}

export interface SpillOutcome {
  /** True when content was written to a spill file. */
  spilled: boolean;
  /** Text to return as the tool result (original content or descriptor). */
  text: string;
  /** Workspace-relative spill path, present only when spilled. */
  relPath?: string;
}

/** Pure predicate — no I/O. */
export function needsSpill(content: string, thresholdChars: number): boolean {
  return content.length > thresholdChars;
}

/** Count lines the way the preview reports them (trailing newline = extra empty segment). */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length;
}

/**
 * Pure formatter — no I/O. Builds the descriptor the model sees when output
 * was spilled: head preview + spill path + totals + how to read more.
 */
export function formatSpillResult(preview: string, relPath: string, content: string): string {
  const bytes = Buffer.byteLength(content, "utf8");
  const lines = countLines(content);
  const shown = preview.length;
  return (
    `[output spilled: ${content.length} chars (${bytes} bytes, ${lines} lines) — showing first ${shown} chars]\n` +
    `${preview}` +
    (preview.endsWith("\n") ? "" : "\n") +
    `[end preview — full output saved to ${relPath}; ` +
    `read pages with read_file {"path": "${relPath}", "offset": <line>, "limit": <lines>} ` +
    `or search with grep {"pattern": "<regex>", "path": "${path.posix.dirname(relPath)}"}]`
  );
}

/** Sanitize the tool name for use in a spill filename (no separators). */
export function sanitizeToolName(tool: string): string {
  const clean = tool.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40);
  return clean || "tool";
}

/** Build a spill filename: `<tool>-<timestamp>-<shortid>.txt`. */
export function buildSpillFilename(tool: string): string {
  const id = randomBytes(4).toString("hex");
  return `${sanitizeToolName(tool)}-${Date.now()}-${id}.txt`;
}

/**
 * Write oversized content to the workspace spill dir and return the model-
 * facing descriptor. Content at or under the threshold is returned unchanged
 * with no file write.
 *
 * Prunes old spills afterwards, never removing the file just written (it is
 * excluded from pruning so a spill referenced in the current turn survives).
 */
export function spillContent(
  workspaceRoot: string,
  tool: string,
  content: string,
  opts: SpillOptions = {}
): SpillOutcome {
  const threshold = opts.thresholdChars ?? DEFAULT_SPILL_THRESHOLD_CHARS;
  const previewChars = opts.previewChars ?? DEFAULT_SPILL_PREVIEW_CHARS;
  if (!needsSpill(content, threshold)) {
    return { spilled: false, text: content };
  }
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new WorkspaceError("cannot spill outside the workspace");
  }
  const root = path.resolve(workspaceRoot);
  const dir = path.join(root, ...SPILL_DIR.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  const filename = buildSpillFilename(tool);
  const abs = path.join(dir, filename);
  // Containment: abs is root + fixed subdir + generated basename, but verify
  // explicitly so a hostile tool name can never escape the workspace.
  const relCheck = path.relative(root, abs);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    throw new WorkspaceError(`spill path escapes workspace: ${filename}`);
  }
  fs.writeFileSync(abs, content, "utf8");
  const relPath = [SPILL_DIR, filename].join("/");
  pruneSpills(workspaceRoot, { keep: opts.keep, exclude: [relPath, filename] });
  return {
    spilled: true,
    text: formatSpillResult(content.slice(0, previewChars), relPath, content),
    relPath,
  };
}

/**
 * Delete oldest spill files beyond `keep` most-recent. `exclude` lists spill
 * relative paths (or basenames) that must never be removed — callers pass the
 * file just spilled so pruning never removes one referenced in the current
 * turn. Returns the basenames removed. Never throws: pruning is best-effort.
 */
export function pruneSpills(
  workspaceRoot: string,
  opts: { keep?: number; exclude?: string[] } = {}
): string[] {
  const keep = opts.keep ?? MAX_SPILL_FILES;
  const excluded = new Set((opts.exclude ?? []).map((e) => path.basename(e)));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(path.resolve(workspaceRoot), ...SPILL_DIR.split("/")), {
      withFileTypes: true,
    });
  } catch {
    return []; // spill dir missing — nothing to prune
  }
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  if (files.length <= keep) return [];
  const dir = path.join(path.resolve(workspaceRoot), ...SPILL_DIR.split("/"));
  const withMtime = files.map((name) => {
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      mtime = 0;
    }
    return { name, mtime };
  });
  withMtime.sort((a, b) => a.mtime - b.mtime); // oldest first
  const removable = withMtime.filter((f) => !excluded.has(f.name));
  const excess = files.length - keep;
  const removed: string[] = [];
  for (let i = 0; i < removable.length && removed.length < excess; i++) {
    try {
      fs.unlinkSync(path.join(dir, removable[i].name));
      removed.push(removable[i].name);
    } catch {
      // best-effort: leave unremovable files in place
    }
  }
  return removed;
}
