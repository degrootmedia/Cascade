/**
 * Renderer-side handoff from a generation popup into the Image Suite.
 *
 * Pure renderer state (a module variable + a window event) — no IPC, because
 * switching the app view is renderer-only and an IPC round trip through main
 * would add a channel for nothing. `App.tsx` listens for `SUITE_OPEN_EVENT`,
 * switches to the suite view, and the suite drains the pending seed on mount.
 */
import type { SuiteSeed } from "../../../../shared/ipc.js";

export const SUITE_OPEN_EVENT = "cascade:suite-open";

/** The pending handoff, set by a popup and consumed once by the suite. */
let pending: { productionId: string; seed: SuiteSeed } | null = null;

/** Fill a partial seed with sane defaults so the suite always gets a full
 *  draft (all `@` tags / picks survive the handoff). */
function normalizeSeed(seed?: Partial<SuiteSeed>): SuiteSeed {
  const draft: SuiteSeed = {
    mode: seed?.mode === "edit" ? "edit" : seed?.mode === "upscale" ? "upscale" : "generate",
    prompt: typeof seed?.prompt === "string" ? seed.prompt : "",
    model: typeof seed?.model === "string" ? seed.model : "",
    resolution: typeof seed?.resolution === "string" && seed.resolution ? seed.resolution : "1k",
    refIds: Array.isArray(seed?.refIds) ? seed.refIds.filter((r): r is string => typeof r === "string") : [],
  };
  if (seed?.aspectRatio) draft.aspectRatio = seed.aspectRatio;
  if (seed?.sourceRefId) draft.sourceRefId = seed.sourceRefId;
  if (!seed?.sourceRefId && seed?.sourcePath) draft.sourcePath = seed.sourcePath;
  if (seed?.params) draft.params = seed.params;
  return draft;
}

/** Open the suite (optionally pre-seeded) for a production. Dispatches the
 *  event App.tsx listens for; safe to call from any popup. */
export function openImageSuite(productionId: string, seed?: Partial<SuiteSeed>): void {
  if (!productionId) return;
  pending = { productionId, seed: normalizeSeed(seed) };
  try {
    window.dispatchEvent(new CustomEvent(SUITE_OPEN_EVENT));
  } catch {
    /* non-window environment (tests) */
  }
}

/** Consume the pending handoff. Returns null when nothing is pending or it
 *  targets a different production. */
export function takePendingSuiteSeed(productionId?: string): { productionId: string; seed: SuiteSeed } | null {
  const p = pending;
  if (!p) return null;
  if (productionId && p.productionId !== productionId) return null;
  pending = null;
  return p;
}
