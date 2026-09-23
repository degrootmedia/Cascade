/**
 * Pure model-pool resolution for the Image Suite.
 *
 * The suite offers only the active provider's catalog (`models`), narrowed to
 * the pool the current mode draws from: Generate/Edit from their `image:*`
 * surface, Upscale from the provider's live upscale probe ∪ the user's
 * `image:upscale` assignments. Only image-output models reach the suite form.
 *
 * Both the prompt panel (what the dropdown shows) and the submit path resolve
 * the effective model through here, so the suite always submits the model it
 * displays. That keeps a stale pick from a provider switch — or an empty draft
 * — from silently falling through to the production's Step-3 model (a
 * different surface, possibly a foreign vendor id) at the provider layer.
 */
import type { OpenArtModelChoice } from "../../../../shared/ipc.js";
import { isImageModel, modelOnSurface } from "../../../../shared/ipc.js";
import type { SuiteMode } from "./suite-types.js";

/** The models the suite's current mode offers, in catalog order. */
export function resolveSuiteSurfacePool(
  models: OpenArtModelChoice[],
  mode: SuiteMode,
  upscaleModelIds: string[]
): OpenArtModelChoice[] {
  const images = models.filter(isImageModel);
  if (mode === "upscale") {
    const allowed = new Set(upscaleModelIds);
    return images.filter((m) => allowed.has(m.id));
  }
  return images.filter((m) => modelOnSurface(m, mode === "edit" ? "image:edit" : "image:generate"));
}

/** The model the suite submits: the draft pick when it's still in the pool,
 *  else the pool's first model (or "" when the pool is empty). */
export function resolveSuiteModel(draftModel: string, pool: OpenArtModelChoice[]): string {
  return pool.some((m) => m.id === draftModel) ? draftModel : (pool[0]?.id ?? "");
}
