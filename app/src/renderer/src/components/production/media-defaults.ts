/**
 * The generation dropdowns' remembered last choices (Settings-backed, global
 * per context — see MediaDefaultCtx in shared/ipc.ts). Every model dropdown
 * seeds from its context's remembered choice (validated against the current
 * list) and writes back on change, so each dropdown starts where the user
 * last left it — across modals, node-graph nodes, and productions.
 */
import type { CascadeApi, MediaDefaultChoice, MediaDefaultCtx } from "../../../../shared/ipc.js";

let cache: Partial<Record<MediaDefaultCtx, MediaDefaultChoice>> = {};
let primed = false;

/** The IPC surface, when it exists (test harnesses stub a subset — the
 *  helpers degrade to cache-only instead of throwing). */
function cascade(): Pick<CascadeApi, "getMediaDefaults" | "setMediaDefault"> | null {
  const c = (globalThis as { cascade?: unknown }).cascade as CascadeApi | undefined;
  return c && typeof c.getMediaDefaults === "function" ? c : null;
}

/** Warm the cache from settings. Idempotent; safe to call on every mount and
 *  provider switch. Resolves once the cache is populated. */
export function primeMediaDefaults(): Promise<void> {
  const c = cascade();
  if (!c) {
    primed = true;
    return Promise.resolve();
  }
  return c
    .getMediaDefaults()
    .then((d) => {
      cache = d ?? {};
      primed = true;
    })
    .catch(() => {
      primed = true;
    });
}

/** The remembered choice for a dropdown context (sync cache read; the
 *  workspace primes on mount, so this is populated by the time any dropdown
 *  the user can open renders). */
export function getMediaDefault(ctx: MediaDefaultCtx): MediaDefaultChoice | undefined {
  if (!primed) void primeMediaDefaults();
  return cache[ctx];
}

/** Record a dropdown's new choice: optimistic cache update (so the next
 *  dropdown instance seeds from it immediately) + fire-and-forget persist. */
export function rememberMediaDefault(ctx: MediaDefaultCtx, patch: MediaDefaultChoice): void {
  cache = { ...cache, [ctx]: { ...cache[ctx], ...patch } };
  const c = cascade();
  if (c) void c.setMediaDefault(ctx, patch).catch(() => {});
}

/** The remembered model for a context when it's still in the offered list,
 *  else the caller's fallback (the dropdown's own validity handling takes it
 *  from there). */
export function rememberedModel(ctx: MediaDefaultCtx, ids: string[], fallback = ""): string {
  const model = getMediaDefault(ctx)?.model;
  return model && ids.includes(model) ? model : fallback;
}
