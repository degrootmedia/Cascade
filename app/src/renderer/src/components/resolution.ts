/** Selection rules shared by the video-model dropdowns (board modal, graph
 *  video/in-betweener nodes, tween timeline): when a model's live options
 *  arrive, a stale resolution re-picks the CLOSEST supported one instead of
 *  falling back to the first. The pure ranking lives in `shared/resolution.ts`
 *  so main's provider submit paths clamp onto the same tiers. */
export { closestResolution, resolutionWeight } from "../../../shared/resolution.js";

import { resolutionsAllowedByRules } from "../../../shared/cel-lite.js";

/** Narrow a resolution ladder by the model schema's own CEL rules given the
 *  current option values (mode defaults seeded from the schema). */
export function resolutionsForSchema(
  schema: { raw?: unknown; fields: { name: string; default?: unknown }[] } | null | undefined,
  params: Record<string, unknown>,
  base: string[]
): string[] {
  const rules = ((schema?.raw as { rules?: { cel?: unknown }[] } | null | undefined)?.rules ?? [])
    .filter((r): r is { cel: string } => typeof r?.cel === "string");
  if (!rules.length) return base;
  const defaults: Record<string, unknown> = {};
  for (const f of schema?.fields ?? []) if (f.default !== undefined && f.default !== null) defaults[f.name] = f.default;
  return resolutionsAllowedByRules(rules, { ...defaults, ...params }, base);
}
