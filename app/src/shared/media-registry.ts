/**
 * Media registry — pure helpers (architecture hardening, brief
 * recommendation 1; rollout Phase 2a).
 *
 * A generated frame or clip keeps one stable identity even if its file is
 * moved, renamed, or adopted from a temporary directory. The registry entry
 * (`Production.media`) is that identity: an id, the file's CURRENT
 * workspace-relative path, its kind, origin, and lifecycle state. Path fields
 * on shots/styles/references stay the transport during this transitional
 * phase — the registry adds identity and state, and every adoption/move/
 * delete goes through one service (`main/media.ts`). Phase 4 swaps the
 * fields to media ids and reads through this registry.
 *
 * Everything here is pure: no filesystem, no ids generation — the service
 * owns those.
 */
import type { Production } from "./ipc.js";

export type MediaKind = "image" | "video" | "audio" | "other";
export type MediaOrigin = "generated" | "adopted" | "imported";
export type MediaState = "present" | "missing" | "deleted";

/** One registered media file. `path` is ALWAYS the current workspace-relative
 *  path — a move through the media service re-points it, so consumers that
 *  resolve by id can't be orphaned. */
export interface MediaEntry {
  id: string;
  path: string;
  kind: MediaKind;
  origin: MediaOrigin;
  state: MediaState;
  /** ISO timestamp of the last change. */
  at?: string;
}

/** Media kind by file extension. */
export function mediaKindForRel(rel: string): MediaKind {
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "webp", "gif", "bmp", "tga", "tiff"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "m4v", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) return "audio";
  return "other";
}

/** Read repair: dedupe by path (first entry wins, so the oldest identity
 *  survives a move), drop terminal `deleted` entries (their file is gone and
 *  nothing references them), and keep entries in registration order. */
export function normalizeMediaRegistry(media: MediaEntry[] | undefined): MediaEntry[] {
  if (!Array.isArray(media)) return [];
  const out: MediaEntry[] = [];
  const byPath = new Map<string, MediaEntry>();
  for (const entry of media) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || !entry.path) continue;
    if (entry.state === "deleted") continue;
    if (byPath.has(entry.path)) continue;
    byPath.set(entry.path, entry);
    out.push(entry);
  }
  return out;
}

/** The registry entry for a path (a move re-points the path on the same id). */
export function mediaEntryForPath(media: MediaEntry[] | undefined, rel: string | undefined): MediaEntry | undefined {
  if (!rel || !Array.isArray(media)) return undefined;
  return media.find((e) => e.path === rel);
}

/** Upsert one entry (by id, else by path), preserving array order. */
export function upsertMediaEntry(media: MediaEntry[] | undefined, entry: MediaEntry): MediaEntry[] {
  const list = normalizeMediaRegistry(media);
  const byId = list.findIndex((e) => e.id === entry.id);
  const byPath = byId < 0 ? list.findIndex((e) => e.path === entry.path) : -1;
  if (byId >= 0) list[byId] = entry;
  else if (byPath >= 0) list[byPath] = entry;
  else list.push(entry);
  return list;
}

/** Rewrite registry paths through `remap` (folder-level moves). Entries whose
 *  path isn't touched pass through unchanged. */
export function remapMediaPaths(media: MediaEntry[] | undefined, remap: (rel: string) => string): MediaEntry[] {
  if (!Array.isArray(media) || !media.length) return media ?? [];
  let changed = false;
  const next = media.map((e) => {
    const path = remap(e.path);
    if (path === e.path) return e;
    changed = true;
    return { ...e, path };
  });
  return changed ? normalizeMediaRegistry(next) : next;
}

/** The production's media registry (back-filled to an empty list). */
export function mediaRegistryOf(p: Production): MediaEntry[] {
  return normalizeMediaRegistry(p.media);
}
