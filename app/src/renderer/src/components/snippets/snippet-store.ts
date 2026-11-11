/**
 * Renderer-side cache of the user's prompt-snippet library. Main owns the
 * values (`settings.promptSnippets`); this module mirrors
 * `production/prompt-templates.ts` + `production/media-defaults.ts`: the
 * workspace/shelf primes it, readers get the seeds until the real list
 * lands, and every mutation writes the whole list back through IPC so it
 * persists across restarts. Subscribers re-render on any change.
 */
import type { CascadeApi } from "../../../../shared/ipc.js";
import {
  resolvePromptSnippets,
  sanitizePromptSnippets,
  type PromptSnippet,
} from "../../../../shared/prompt-snippets.js";

let cache: PromptSnippet[] = resolvePromptSnippets(null);
let primed = false;
let version = 0;
const listeners = new Set<() => void>();

/** The IPC surface, when it exists (test harnesses stub a subset). */
function cascade(): Pick<CascadeApi, "getPromptSnippets" | "setPromptSnippets"> | null {
  const c = (globalThis as { cascade?: unknown }).cascade as CascadeApi | undefined;
  return c && typeof c.getPromptSnippets === "function" && typeof c.setPromptSnippets === "function" ? c : null;
}

function notify() {
  version += 1;
  for (const fn of [...listeners]) fn();
}

/** Subscribe to library changes (for useSyncExternalStore). */
export function subscribeSnippets(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Monotonic change counter (snapshot for useSyncExternalStore). */
export function snippetsVersion(): number {
  return version;
}

/** The current library (seeds until primed). Lazily primes. */
export function getSnippets(): PromptSnippet[] {
  if (!primed) void primePromptSnippets();
  return cache;
}

/** Warm the cache from settings. Idempotent; safe to call on every mount. */
export function primePromptSnippets(): Promise<void> {
  const c = cascade();
  if (!c) {
    primed = true;
    return Promise.resolve();
  }
  return c
    .getPromptSnippets()
    .then((list) => {
      cache = resolvePromptSnippets(list);
      primed = true;
      notify();
    })
    .catch(() => {
      primed = true;
    });
}

/** Test seam: forget the cache so the next read re-primes from IPC. */
export function resetSnippetStoreForTests(): void {
  cache = resolvePromptSnippets(null);
  primed = false;
  notify();
}

let idCounter = 0;
/** A fresh snippet id (unique against the given list). */
export function newSnippetId(existing: readonly PromptSnippet[] = cache): string {
  let id = "";
  do {
    idCounter += 1;
    id = `snippet-${Date.now().toString(36)}-${idCounter}`;
  } while (existing.some((s) => s.id === id));
  return id;
}

/** Replace the whole library, persist through IPC, and notify. */
export function saveSnippets(next: readonly PromptSnippet[]): PromptSnippet[] {
  cache = sanitizePromptSnippets(next);
  notify();
  const c = cascade();
  if (c) void c.setPromptSnippets(cache).catch(() => undefined);
  return cache;
}

/** Add a snippet; returns the stored entry (with its assigned id). */
export function addSnippet(input: { name: string; category: string; body: string }): PromptSnippet {
  const entry: PromptSnippet = {
    id: newSnippetId(),
    name: input.name.trim(),
    category: input.category.trim(),
    body: input.body,
  };
  saveSnippets([...cache, entry]);
  return cache.find((s) => s.id === entry.id) ?? entry;
}

/** Edit a snippet in place; returns the updated entry (null when unknown). */
export function updateSnippet(
  id: string,
  input: { name: string; category: string; body: string },
): PromptSnippet | null {
  if (!cache.some((s) => s.id === id)) return null;
  saveSnippets(
    cache.map((s) =>
      s.id === id ? { id, name: input.name.trim(), category: input.category.trim(), body: input.body } : s,
    ),
  );
  return cache.find((s) => s.id === id) ?? null;
}

/** Delete a snippet; returns whether anything was removed. */
export function deleteSnippet(id: string): boolean {
  if (!cache.some((s) => s.id === id)) return false;
  saveSnippets(cache.filter((s) => s.id !== id));
  return true;
}
