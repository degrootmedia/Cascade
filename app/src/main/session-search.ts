/**
 * Session full-text search (master plan step 09, T1 — search only).
 *
 * Searches the EXISTING session JSON documents in place. No storage change, no
 * event log, no index file on disk: the index is an in-memory, mtime-validated
 * cache, dropped on app exit. This is the safe, reversible first deliverable —
 * the append-only event rewrite (T2–T5) ships separately, in its own release.
 *
 * Searchable text is the model-facing history plus the renderer transcript
 * (user/assistant text, tool calls and results, notices, mention filenames) and
 * the title. Matching is case-insensitive; multiple whitespace-separated terms
 * must all appear (AND).
 */
import { contentText } from "@core";
import type { DisplayItem, SessionSearchHit } from "../shared/ipc.js";
import { listSessions, loadSession, type SessionFile } from "./sessions.js";

/** One indexed session: its searchable text folded to lower case plus segments. */
interface IndexEntry {
  id: string;
  title: string;
  updatedAt: string;
  /** Case-folded haystack (all segments joined). */
  haystack: string;
  /** Per-part raw text, for snippet extraction. */
  parts: string[];
}

/** Cache keyed by id → the session's updatedAt; a save bumps updatedAt so the
 *  entry refreshes, and the file is never rewritten by search. */
const cache = new Map<string, IndexEntry>();

function displayText(items: DisplayItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === "user" || it.kind === "assistant") {
      if (it.text?.trim()) out.push(it.text);
    } else if (it.kind === "tool") {
      if (it.name) out.push(it.name);
      if (it.args?.trim()) out.push(it.args);
      if (it.result?.trim()) out.push(it.result);
    } else if (it.kind === "notice") {
      if (it.text?.trim()) out.push(it.text);
    } else if (it.kind === "mention") {
      if (it.filename?.trim()) out.push(it.filename);
    }
  }
  return out;
}

/** Build the searchable parts for one session (title + history + transcript). */
export function sessionSearchParts(s: SessionFile): string[] {
  const parts: string[] = [];
  if (s.title?.trim()) parts.push(s.title);
  for (const m of s.history ?? []) {
    const t = contentText(m.content);
    if (t.trim()) parts.push(t);
  }
  parts.push(...displayText(s.display ?? []));
  return parts;
}

function entryFor(id: string): IndexEntry | null {
  const s = loadSession(id);
  if (!s) return null;
  const cached = cache.get(id);
  if (cached && cached.updatedAt === s.updatedAt) return cached;
  const parts = sessionSearchParts(s);
  const entry: IndexEntry = {
    id,
    title: s.title,
    updatedAt: s.updatedAt,
    haystack: parts.join("\n").toLowerCase(),
    parts,
  };
  cache.set(id, entry);
  return entry;
}

/** Drop the in-memory index (tests; not needed at runtime — the cache is
 *  mtime/updatedAt-validated). */
export function clearSessionSearchCache(): void {
  cache.clear();
}

/** A window of `text` around the first case-insensitive occurrence of `term`. */
function snippetAround(text: string, term: string, width = 90): string {
  const at = text.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return text.replace(/\s+/g, " ").trim().slice(0, width);
  const start = Math.max(0, at - 30);
  const end = Math.min(text.length, at + term.length + width - 30);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

export interface SearchOptions {
  /** Max hits returned (default 30, capped 100). */
  limit?: number;
}

/**
 * Search every session's content. Returns hits newest-first with a snippet of
 * the best matching part. An empty/whitespace query returns []. Read-only:
 * never writes a session file.
 */
export function searchSessions(query: string, opts: SearchOptions = {}): SessionSearchHit[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));

  const hits: SessionSearchHit[] = [];
  for (const meta of listSessions()) {
    const entry = entryFor(meta.id);
    if (!entry) continue;
    if (!terms.every((t) => entry.haystack.includes(t))) continue;
    const part = entry.parts.find((p) => terms.every((t) => p.toLowerCase().includes(t))) ?? entry.parts[0] ?? "";
    hits.push({
      sessionId: entry.id,
      title: entry.title,
      updatedAt: entry.updatedAt,
      snippet: snippetAround(part, terms[0]),
    });
    if (hits.length >= limit) break;
  }
  hits.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return hits.slice(0, limit);
}
