/**
 * The media file service (architecture hardening, brief recommendation 1;
 * rollout Phase 2a).
 *
 * ONE door for adopting, moving, registering, and deleting production media
 * files. Every move through here re-points the production's media registry
 * entry, so the stable id keeps resolving to the file's current path no
 * matter where it lands — and an interrupted move (a rename that fails)
 * leaves the old path AND the registry untouched, so the production reports a
 * recoverable state instead of publishing a broken path.
 *
 * The injected `resolveAbs` seam (wired to `assetPath`) keeps this module
 * pure node — tests inject a temp-folder resolver, production wiring injects
 * the real one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Production } from "../shared/ipc.js";
import {
  mediaKindForRel,
  normalizeMediaRegistry,
  remapMediaPaths,
  type MediaEntry,
  type MediaKind,
  type MediaOrigin,
} from "../shared/media-registry.js";

export interface MediaServiceDeps {
  /** Workspace-relative → absolute path. */
  resolveAbs: (p: Production, rel: string) => string;
  newId?: () => string;
}

export interface MediaService {
  /** Register a file (idempotent per path). Returns the entry. */
  register(p: Production, rel: string, kind?: MediaKind, origin?: MediaOrigin): MediaEntry | undefined;
  /** Move a file from `fromRel` to `toRel` (fs rename + registry re-point).
   *  Returns the new rel, or null when the move failed — the old path and the
   *  registry stay exactly as they were, so an interrupted adoption is
   *  recoverable and no broken path is published. */
  moveFile(p: Production, fromRel: string, toRel: string): string | null;
  /** Delete a file and mark its registry entry `deleted`. */
  removeFile(p: Production, rel: string): boolean;
  /** Mark a referenced file missing (state drives the storyboard's explicit
   *  "Missing file" badge instead of a silently blank frame). */
  markMissing(p: Production, rel: string): void;
  /** Rewrite registry paths through `remap` — folder-level moves (renumber,
   *  outdated archive/restore, layout migrations) call this after patching
   *  the stored fields, so the registry can't drift from them. */
  remapPaths(p: Production, remap: (rel: string) => string): void;
  /** Re-bootstrap the registry from the production's referenced fields (run
   *  at load): upsert entries for every referenced path, mark present/missing
   *  from disk, and prune entries no field references any more. */
  bootstrap(p: Production, referenced: string[]): void;
}

export function createMediaService(deps: MediaServiceDeps): MediaService {
  const newId = deps.newId ?? (() => randomUUID());

  const writeRegistry = (p: Production, list: MediaEntry[]): void => {
    p.media = list;
  };

  return {
    register(p, rel, kind, origin) {
      if (!rel) return undefined;
      const list = normalizeMediaRegistry(p.media);
      const existing = list.find((e) => e.path === rel);
      if (existing) {
        if (existing.state === "deleted") existing.state = "present";
        writeRegistry(p, list);
        return existing;
      }
      const entry: MediaEntry = {
        id: newId(),
        path: rel,
        kind: kind ?? mediaKindForRel(rel),
        origin: origin ?? "generated",
        state: "present",
        at: new Date().toISOString(),
      };
      writeRegistry(p, [...list, entry]);
      return entry;
    },

    moveFile(p, fromRel, toRel) {
      if (!fromRel || !toRel || fromRel === toRel) return null;
      try {
        const fromAbs = deps.resolveAbs(p, fromRel);
        if (!fs.existsSync(fromAbs)) return null;
        fs.mkdirSync(path.dirname(deps.resolveAbs(p, toRel)), { recursive: true });
        fs.renameSync(fromAbs, deps.resolveAbs(p, toRel));
      } catch {
        return null; // the old path + registry stay intact — recoverable
      }
      writeRegistry(p, remapMediaPaths(p.media, (rel) => (rel === fromRel ? toRel : rel)));
      return toRel;
    },

    removeFile(p, rel) {
      if (!rel) return false;
      try {
        fs.unlinkSync(deps.resolveAbs(p, rel));
      } catch { /* already gone */ }
      const list = normalizeMediaRegistry(p.media);
      const existing = list.find((e) => e.path === rel);
      if (!existing) return true;
      existing.state = "deleted";
      existing.at = new Date().toISOString();
      writeRegistry(p, list);
      return true;
    },

    markMissing(p, rel) {
      if (!rel) return;
      const list = normalizeMediaRegistry(p.media);
      const existing = list.find((e) => e.path === rel);
      if (existing) {
        if (existing.state !== "missing") {
          existing.state = "missing";
          existing.at = new Date().toISOString();
          writeRegistry(p, list);
        }
        return;
      }
      const entry: MediaEntry = {
        id: newId(),
        path: rel,
        kind: mediaKindForRel(rel),
        origin: "generated",
        state: "missing",
        at: new Date().toISOString(),
      };
      writeRegistry(p, [...list, entry]);
    },

    remapPaths(p, remap) {
      if (!Array.isArray(p.media) || !p.media.length) return;
      writeRegistry(p, remapMediaPaths(p.media, remap));
    },

    bootstrap(p, referenced) {
      const seen = new Set<string>();
      const upserted: MediaEntry[] = [];
      const prior = normalizeMediaRegistry(p.media);
      for (const rel of referenced) {
        if (!rel || seen.has(rel)) continue;
        seen.add(rel);
        const onDisk = (() => { try { return fs.existsSync(deps.resolveAbs(p, rel)); } catch { return false; } })();
        const state: MediaEntry["state"] = onDisk ? "present" : "missing";
        const existing = prior.find((e) => e.path === rel);
        if (existing) {
          upserted.push({ ...existing, state });
        } else {
          upserted.push({
            id: newId(),
            path: rel,
            kind: mediaKindForRel(rel),
            origin: "generated",
            state,
            at: new Date().toISOString(),
          });
        }
      }
      // Prune entries no field references (GC only unreferenced media).
      writeRegistry(p, upserted);
    },
  };
}
