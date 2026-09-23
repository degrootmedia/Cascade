/**
 * Renderer-side cache of the user's prompt-template overrides (Settings →
 * Prompts), mirrors `media-defaults.ts`: the workspace primes it on mount and
 * every reader falls back to the built-in until it lands. Main owns the values;
 * this module only resolves the built-in/override pair for renderer defaults
 * (the camera-grid node's seed prompt, the video motion default).
 */
import type { CascadeApi } from "../../../../shared/ipc.js";
import { resolvePromptTemplate, type PromptTemplateId } from "../../../../shared/prompt-templates.js";

let cache: Record<string, string> = {};
let primed = false;

/** The IPC surface, when it exists (test harnesses stub a subset — degrade to
 *  built-ins instead of throwing). */
function cascade(): Pick<CascadeApi, "getPromptTemplates"> | null {
  const c = (globalThis as { cascade?: unknown }).cascade as CascadeApi | undefined;
  return c && typeof c.getPromptTemplates === "function" ? c : null;
}

/** Warm the cache from settings. Idempotent; safe to call on every mount. */
export function primePromptTemplates(): Promise<void> {
  const c = cascade();
  if (!c) {
    primed = true;
    return Promise.resolve();
  }
  return c
    .getPromptTemplates()
    .then((t) => {
      cache = t && typeof t === "object" ? t : {};
      primed = true;
    })
    .catch(() => {
      primed = true;
    });
}

/** The active wording for a template (override, else built-in). Sync cache read;
 *  lazily primes when the workspace hasn't yet. */
export function getPromptTemplate(id: PromptTemplateId): string {
  if (!primed) void primePromptTemplates();
  return resolvePromptTemplate(id, cache);
}
