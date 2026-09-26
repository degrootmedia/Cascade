/**
 * Reference external-edit watcher.
 *
 * A reference image (character / product / custom) can be edited outside
 * Cascade — through the "Edit externally" context menu, or by saving over the
 * file from another app. The node canvas reads the live reference, but the
 * Design grid, node shelf, and moodboard paint a cached bitmap, and a
 * reference piped to a shot's frame output is a *copy* in the boards dir —
 * both would stay stale. This module watches the reference files of the open
 * production and reports a change the moment it lands on disk.
 *
 * Watches are per-directory (reliable across editors that save by writing a
 * temp file then renaming over the target, which breaks a per-file watch) and
 * reconciled against the production's current references, so a reference
 * whose image path changes is followed without re-registering. Detection
 * compares an `mtimeMs`/`size` signature, so a no-op touch is ignored.
 *
 * Every dependency is injected: that injection IS the test surface.
 */
import * as path from "node:path";
import type { Production } from "../shared/ipc.js";

export interface RefStat {
  mtimeMs: number;
  size: number;
}

export interface WatchHandle {
  close(): void;
}

export interface RefWatcherDeps {
  loadProduction(id: string): Production | null;
  /** Every image/video file backing a reference on the production. */
  collectRefs(p: Production): Array<{ id: string; rel: string }>;
  /** Absolute path of a production asset. Throws when outside the folder. */
  assetPath(p: Production, rel: string): string;
  /** File signature, or null when the file can't be read. */
  stat(abs: string): RefStat | null;
  /** Begin watching a directory; `onChange` fires for entries within it. */
  watchDir(dir: string, onChange: () => void): WatchHandle;
}

export interface RefChange {
  id: string;
  rel: string;
}

export interface RefWatcher {
  /** Follow a production's references (re-primed on load/save). Pass null to
   *  stop watching. `known` skips the reload when the caller already has the
   *  production. */
  watch(productionId: string | null, known?: Production | null): void;
  /** Re-stat every reference now and report changes (used by the focus sweep). */
  scan(): void;
  clear(): void;
  dispose(): void;
}

interface WatchedRef {
  id: string;
  rel: string;
  abs: string;
}

export function createRefWatcher(
  deps: RefWatcherDeps,
  onChanged: (productionId: string, changes: RefChange[]) => void,
  debounceMs = 250
): RefWatcher {
  let active: string | null = null;
  let current: WatchedRef[] = [];
  const snapshots = new Map<string, RefStat>();
  const dirs = new Map<string, WatchHandle>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function resolve(p: Production, rel: string): string | null {
    try {
      return deps.assetPath(p, rel);
    } catch {
      return null;
    }
  }

  function collect(p: Production): WatchedRef[] {
    const out: WatchedRef[] = [];
    const seen = new Set<string>();
    for (const r of deps.collectRefs(p)) {
      const abs = resolve(p, r.rel);
      if (!abs || seen.has(abs)) continue;
      seen.add(abs);
      out.push({ id: r.id, rel: r.rel, abs });
    }
    return out;
  }

  function syncDirs(): void {
    const wanted = new Set(current.map((r) => path.dirname(r.abs)));
    for (const [dir, handle] of [...dirs]) {
      if (wanted.has(dir)) continue;
      try {
        handle.close();
      } catch {
        /* already gone */
      }
      dirs.delete(dir);
    }
    for (const dir of wanted) {
      if (dirs.has(dir)) continue;
      try {
        dirs.set(dir, deps.watchDir(dir, schedule));
      } catch {
        /* a missing/again-created dir — the next watch() retries */
      }
    }
  }

  function prune(live: Set<string>): void {
    for (const key of [...snapshots.keys()]) {
      if (!live.has(key)) snapshots.delete(key);
    }
  }

  function watch(productionId: string | null, known?: Production | null): void {
    active = productionId;
    if (!productionId) {
      current = [];
      snapshots.clear();
      syncDirs();
      return;
    }
    const p = known !== undefined ? known : deps.loadProduction(productionId);
    if (!p) {
      current = [];
      snapshots.clear();
      syncDirs();
      return;
    }
    current = collect(p);
    const live = new Set(current.map((r) => r.abs));
    prune(live);
    // Baseline new files without reporting them: a reference the app just wrote
    // (or already knows about) is not an external edit.
    for (const r of current) {
      if (snapshots.has(r.abs)) continue;
      const st = deps.stat(r.abs);
      if (st) snapshots.set(r.abs, st);
    }
    syncDirs();
  }

  function scan(): void {
    if (!active) return;
    const p = deps.loadProduction(active);
    if (!p) return;
    current = collect(p);
    const live = new Set(current.map((r) => r.abs));
    prune(live);
    const changes: RefChange[] = [];
    for (const r of current) {
      const st = deps.stat(r.abs);
      if (!st) continue;
      const prev = snapshots.get(r.abs);
      if (prev && (st.mtimeMs > prev.mtimeMs + 50 || st.size !== prev.size)) {
        changes.push({ id: r.id, rel: r.rel });
      }
      snapshots.set(r.abs, st);
    }
    syncDirs();
    if (changes.length) onChanged(active, changes);
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, debounceMs);
  }

  function clear(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    active = null;
    current = [];
    snapshots.clear();
    for (const handle of dirs.values()) {
      try {
        handle.close();
      } catch {
        /* already gone */
      }
    }
    dirs.clear();
  }

  return { watch, scan, clear, dispose: clear };
}
