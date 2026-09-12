/**
 * Generic JSON document store shared by the collection-style persistence
 * modules (sessions, productions, agents). One JSON file per document under
 * userData/<dirName>/, written atomically (temp file + rename so an
 * interrupted save can't corrupt a document), soft-deletable into an
 * archive/ subfolder. Each domain configures the store and keeps its bespoke
 * behavior — normalization, multi-file entities, summaries — on top.
 */
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

export interface DocumentStoreConfig<T> {
  /** Subdirectory of userData holding the JSON files (e.g. "sessions"). */
  dirName: string;
  /** The document's stable identity (a production's id lives on meta.id). */
  idOf: (doc: T) => string;
  /** Newest-first sort key for list(). */
  sortKey: (doc: T) => string;
  /** Back-fill/validate a doc read from disk (list + load + save). */
  decode?: (doc: T) => T;
  /** Transform a doc right before it's written (e.g. strip computed fields). */
  encode?: (doc: T) => T;
  /** Extra files moved/deleted alongside the JSON on archive/remove. */
  sideFiles?: {
    archive?: (id: string, archiveDir: string, dir: string) => void;
    remove?: (id: string, dir: string) => void;
  };
}

export interface DocumentStore<T> {
  /** The directory holding this store's JSON files. */
  dir(): string;
  /** Every document, newest first by sortKey (corrupt files skipped). */
  list(): T[];
  load(id: string): T | null;
  /** Write `doc` (after encode) atomically. The domain owns `updatedAt`. */
  save(doc: T): void;
  remove(id: string): boolean;
  /** Soft-delete: move the document (and side files) into archive/. */
  archive(id: string): boolean;
  /** A fresh, reasonably-unique id for a new document. */
  newId(): string;
}

export function createStore<T>(config: DocumentStoreConfig<T>): DocumentStore<T> {
  const dir = () => path.join(app.getPath("userData"), config.dirName);
  const docPath = (id: string) => path.join(dir(), `${id}.json`);
  const archiveDir = () => path.join(dir(), "archive");

  // Perf (1.1): parsed-document cache keyed by absolute path. Single-writer
  // app, so mtimeMs invalidation is correct: a hit skips JSON.parse entirely.
  // The cached object graph is returned unchanged — callers must not mutate
  // it without saving (the domain save paths mutate-then-save, which is the
  // intended ownership flow).
  const cache = new Map<string, { mtimeMs: number; data: T }>();

  function read(id: string): T | null {
    const target = docPath(id);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(target).mtimeMs;
    } catch {
      cache.delete(target);
      return null;
    }
    const hit = cache.get(target);
    if (hit && hit.mtimeMs === mtimeMs) return hit.data;
    try {
      const raw = JSON.parse(fs.readFileSync(target, "utf8")) as T;
      const decoded = config.decode ? config.decode(raw) : raw;
      cache.set(target, { mtimeMs, data: decoded });
      return decoded;
    } catch {
      return null;
    }
  }

  function write(doc: T): void {
    fs.mkdirSync(dir(), { recursive: true });
    const payload = config.encode ? config.encode(doc) : doc;
    const target = docPath(config.idOf(doc));
    // Atomic: write to a sibling temp then rename, so a crash mid-write never
    // leaves a truncated JSON that the next list/load silently skips.
    const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, target);
    // The writer never pays a re-parse: cache what load() would decode to
    // (not the raw pre-encode object) under the fresh mtime, so a cache hit
    // is indistinguishable from a disk read + decode.
    try {
      const mtimeMs = fs.statSync(target).mtimeMs;
      let cached: T;
      try {
        cached = config.decode ? config.decode(payload as T) : (payload as T);
      } catch {
        cached = doc;
      }
      cache.set(target, { mtimeMs, data: cached });
    } catch {
      cache.delete(target);
    }
  }

  return {
    dir,
    list() {
      const out: T[] = [];
      let entries: string[];
      try {
        entries = fs.readdirSync(dir());
      } catch {
        return out;
      }
      for (const f of entries) {
        if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
        const doc = read(f.slice(0, -".json".length));
        if (doc) out.push(doc);
      }
      return out.sort((a, b) => config.sortKey(b).localeCompare(config.sortKey(a)));
    },
    load: read,
    save(doc) {
      write(doc);
    },
    remove(id) {
      try {
        fs.rmSync(docPath(id), { force: true });
        cache.delete(docPath(id));
        config.sideFiles?.remove?.(id, dir());
        return true;
      } catch {
        return false;
      }
    },
    archive(id) {
      const dst = archiveDir();
      try {
        fs.mkdirSync(dst, { recursive: true });
        fs.renameSync(docPath(id), path.join(dst, `${id}.json`));
        cache.delete(docPath(id));
        config.sideFiles?.archive?.(id, dst, dir());
        return true;
      } catch {
        return false;
      }
    },
    newId() {
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    },
  };
}