/**
 * Media-provider registry. index.ts builds both vendors once (injecting the
 * live McpManager + the ledger recorder at the seam) and resolves the active
 * one per call from the global settings selection. Selection is global-only
 * by decision (per-production/per-shot scoping is a future expansion, not a
 * rewrite — it would thread a provider id through Production + every IPC).
 */
import type { McpManager } from "../mcp.js";
import { OpenArtClient } from "../openart.js";
import { HiggsfieldProvider } from "./higgsfield.js";
import type { GenerationRecorder, MediaProvider, MediaProviderId } from "./types.js";
import { FALLBACK_VIDEO_DURATIONS, FALLBACK_VIDEO_RESOLUTIONS, IMAGE_RESOLUTIONS } from "../ledger.js";
import type { MediaModelLadder, OpenArtModelChoice } from "../../shared/ipc.js";

export type { MediaProviderId };

export const PROVIDER_META: Record<MediaProviderId, { displayName: string }> = {
  openart: { displayName: "OpenArt" },
  higgsfield: { displayName: "Higgsfield" },
};

export const PROVIDER_IDS: MediaProviderId[] = ["openart", "higgsfield"];

/** Coerce a stored/foreign value to a known provider id (unknown → openart). */
export function resolveProviderId(raw: unknown): MediaProviderId {
  return raw === "higgsfield" ? "higgsfield" : "openart";
}

/**
 * Which vendor owns an explicit model pick. A `higgsfield:…` id always
 * belongs to Higgsfield (ids leave that provider namespaced); "auto",
 * empty, and unprefixed OpenArt ids defer to the caller's active provider
 * (null = use active). Callers use this so a saved cross-vendor pick (e.g. a
 * Seedance tween chosen under Higgsfield) still submits to its own vendor
 * after the global provider flips — instead of silently falling back to the
 * active vendor's first model (the Seedance→Gemini bug).
 */
export function providerOfModelId(model?: string): MediaProviderId | null {
  if (typeof model !== "string") return null;
  const m = model.trim();
  if (!m || m === "auto") return null;
  if (m.startsWith("higgsfield:")) return "higgsfield";
  return null;
}

/** Resolve the provider for one generation call: the model's own vendor when
 *  the pick names one, otherwise the global active vendor. */
export function mediaForModel(
  providers: Record<MediaProviderId, MediaProvider>,
  activeId: MediaProviderId,
  model?: string
): MediaProvider {
  return providers[providerOfModelId(model) ?? activeId] ?? providers[activeId];
}

export function createProviders(mcp: McpManager, recorder?: GenerationRecorder): Record<MediaProviderId, MediaProvider> {
  return {
    openart: new OpenArtClient(mcp, recorder),
    higgsfield: new HiggsfieldProvider(mcp, recorder),
  };
}

/** Force model choices to the user's manual kind assignments (Settings →
 *  Models & expenses drag-and-drop). A "video" assignment sets the video flag;
 *  an "image" assignment clears it and ensures image input. Unassigned models
 *  pass through untouched. */
export function applyKindOverrides(
  choices: OpenArtModelChoice[],
  overrides: Record<string, "image" | "video">
): OpenArtModelChoice[] {
  if (!overrides || !Object.keys(overrides).length) return choices;
  return choices.map((c) => {
    const kind = overrides[c.id];
    if (kind === "video") return c.videoInput ? c : { ...c, videoInput: true };
    if (kind === "image") return !c.videoInput && c.imageInput ? c : { ...c, videoInput: false, imageInput: true };
    return c;
  });
}

/** Probe EVERY vendor's model catalog and bake each model's pricing ladder
 *  (resolution ladder + video length range) for the Settings → Models &
 *  expenses tab. Ids are provider-namespaced so the union can't collide; one
 *  vendor's failure never blocks the others. Ladders fall back to the kind's
 *  default buckets when a video model's live options can't be read. */
export async function listAllModelLadders(
  providers: Record<MediaProviderId, MediaProvider>,
  overrides: Record<string, "image" | "video"> = {}
): Promise<MediaModelLadder[]> {
  const out: MediaModelLadder[] = [];
  for (const id of PROVIDER_IDS) {
    const p = providers[id];
    let choices: OpenArtModelChoice[] = [];
    try {
      // Manual kind assignments win over the auto-detected flags, so the
      // baked ladder (and every downstream dropdown) follows the user.
      choices = applyKindOverrides(await p.listModelChoices(), overrides);
      // Warm the per-model option caches so the ladder lookups below (and the
      // renderer's later videoModelOptions calls) don't stall on first use.
      p.prewarm?.(choices);
    } catch {
      choices = [];
    }
for (const c of choices) {
    }
    // Probe each video model's live options in parallel (per-model caches make
    // repeats cheap); order is preserved so the union stays deterministic.
    const entries = await Promise.all(
      choices.map(async (c): Promise<MediaModelLadder> => {
        let resolutions: string[];
        let durMin: number | null = null;
        let durMax: number | null = null;
        if (c.videoInput) {
          const o = await p.videoModelOptions(c.id, true).catch(() => null);
          if (o && o.resolutions.length && o.durations.length) {
            resolutions = o.resolutions;
            durMin = Math.min(...o.durations);
            durMax = Math.max(...o.durations);
          } else {
            resolutions = [...FALLBACK_VIDEO_RESOLUTIONS];
            durMin = Math.min(...FALLBACK_VIDEO_DURATIONS);
            durMax = Math.max(...FALLBACK_VIDEO_DURATIONS);
          }
        } else {
          resolutions = [...IMAGE_RESOLUTIONS];
        }
        return { provider: id, choice: c, resolutions, durMin, durMax };
      })
    );
    out.push(...entries);
  }
  return out;
}
