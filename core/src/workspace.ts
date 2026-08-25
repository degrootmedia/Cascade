/**
 * Workspace path confinement.
 *
 * Every path the model supplies is resolved against the workspace root and
 * must remain inside it — including after symlink resolution. This is a
 * security boundary, not a convenience: the model must never read or write
 * outside the folder the user selected.
 */
import * as path from "node:path";
import * as fs from "node:fs";

export class WorkspaceError extends Error {}

/**
 * Resolve a model-supplied path safely inside the workspace root.
 * Accepts relative paths ("notes/a.txt") or absolute paths that already
 * point inside the workspace. Throws WorkspaceError on escape attempts.
 *
 * @param mustExist  when true, also resolves symlinks via realpath and
 *                   re-checks containment.
 */
export function resolveSafe(workspaceRoot: string, p: string, opts: { mustExist?: boolean } = {}): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new WorkspaceError("path must be a non-empty string");
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, p);

  if (!isInside(root, resolved)) {
    throw new WorkspaceError(`path escapes workspace: ${p}`);
  }

  if (opts.mustExist) {
    let real: string;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      throw new WorkspaceError(`file not found: ${p}`);
    }
    // Re-check containment after symlink resolution. Compare against the
    // realpath of the root itself so a symlinked workspace still works.
    const realRoot = fs.realpathSync(root);
    if (!isInside(realRoot, real)) {
      throw new WorkspaceError(`path resolves outside workspace (symlink escape): ${p}`);
    }
    return real;
  }

  // For paths that may not exist yet (writes), verify the nearest existing
  // ancestor doesn't symlink out of the workspace.
  const existingAncestor = nearestExistingAncestor(resolved);
  if (existingAncestor) {
    const realAncestor = fs.realpathSync(existingAncestor);
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
    if (!isInside(realRoot, realAncestor) && realAncestor !== realRoot) {
      throw new WorkspaceError(`path resolves outside workspace (symlink escape): ${p}`);
    }
  }
  return resolved;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function nearestExistingAncestor(p: string): string | null {
  let cur = p;
  while (true) {
    if (fs.existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Filenames checked (in order) for per-directory instructions. */
const INSTRUCTION_FILENAMES = ["CASCADE.md", ".cascade/instructions.md"];
const MAX_INSTRUCTIONS_CHARS = 20_000;

/**
 * Load the per-directory instructions for a workspace: the contents of a
 * CASCADE.md (or .cascade/instructions.md) file living at the workspace root
 * are injected into the agent's system prompt so the model is always aware
 * of them without the user repeating them. Returns "" when no file exists.
 * A trailing newline is stripped so a single-line file doesn't add blank
 * prompt noise.
 */
export function loadWorkspaceInstructions(workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  for (const name of INSTRUCTION_FILENAMES) {
    const file = path.join(root, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      return fs.readFileSync(file, "utf8").slice(0, MAX_INSTRUCTIONS_CHARS).trimEnd();
    } catch {
      // not present / unreadable → try the next candidate
    }
  }
  return "";
}

/** Absolute path of whichever instructions file exists, or null. */
export function workspaceInstructionsFile(workspaceRoot: string): string | null {
  const root = path.resolve(workspaceRoot);
  for (const name of INSTRUCTION_FILENAMES) {
    const file = path.join(root, name);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

