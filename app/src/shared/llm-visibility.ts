/**
 * LLM model visibility (Feature #9): the Model Customizer can hide chat/LLM
 * models the same way it hides image/video models. Hidden ids are stored in
 * the global settings file (`hiddenLlmModels`, next to `hiddenMediaModels`)
 * and every LLM picker (header model picker, Settings → Model, the agent
 * editor) lists only the visible ones. Pure helpers, shared by main and the
 * renderer.
 */

/** Cap on stored ids, matching the media list. */
export const MAX_HIDDEN_LLM_MODELS = 500;

/** Trim, drop blanks/non-strings/duplicates, cap the list. */
export function sanitizeHiddenLlmModels(ids: unknown): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
  }
  return clean.slice(0, MAX_HIDDEN_LLM_MODELS);
}

/** The models a picker offers as choices: every model not hidden. */
export function visibleLlmModels<T extends { id: string }>(models: readonly T[], hidden: Iterable<string>): T[] {
  const h = hidden instanceof Set ? (hidden as Set<string>) : new Set(hidden);
  if (h.size === 0) return [...models];
  return models.filter((m) => !h.has(m.id));
}

/** Window event the customizer fires after a hide/show, so open pickers reload. */
export const LLM_VISIBILITY_EVENT = "cascade:llm-models-changed";
