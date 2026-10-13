/**
 * The renderer-owned shot fields a narrow graph-field command may write
 * (`production:updateGraphShotFields`). This is the allow-list shared by the
 * IPC validator, the main-side merge, and the renderer caller, so the three
 * cannot drift apart.
 *
 * Every entry is a renderer-owned (or legacy deprecated) `ProductionShot`
 * field from the ownership table in `src/main/shot-ownership.ts`. Main-owned
 * generation results, artwork/video mirrors, and identity fields are absent
 * on purpose: those only change through their own commands, and the merge
 * would deny them anyway.
 */
export const GRAPH_SHOT_PATCH_FIELDS = [
  "graph",
  "graphImageParams",
  "graphImageModel",
  "graphImageResolution",
  "graphVideoNodes",
  "graphOutputVideoNodeId",
  "graphVideoPrompt",
  "graphVideoModel",
  "graphVideoResolution",
  "graphVideoDurationSec",
  "graphVideoParams",
  "graphEditNodes",
  "graphOutputEditNodeId",
  "graphEditPrompt",
  "graphEditVideoGenIndex",
  "graphTweenRefIds",
  "graphTweenBlocks",
  "graphTweenModel",
  "graphTweenResolution",
  "graphTweenParams",
  "graphCameraGrid",
  "graphUpscale",
  "graphSequence",
  "graphOutputSource",
  "graphOutputRefId",
  "graphStyleConnected",
  "graphImageToVideo",
  "graphEditToVideo",
  "graphVideoSourceRefId",
  "graphVideoSourceEditNodeId",
  "graphEditImageSource",
  "graphEditSourceRefId",
  "graphVideoRefIds",
  "graphVideoStyleConnected",
  "graphEditStyleConnected",
] as const;

export type GraphShotPatchField = (typeof GRAPH_SHOT_PATCH_FIELDS)[number];

const FIELD_SET: ReadonlySet<string> = new Set(GRAPH_SHOT_PATCH_FIELDS);

export function isGraphShotPatchField(key: string): key is GraphShotPatchField {
  return FIELD_SET.has(key);
}

/** Keep only allow-listed keys from a renderer patch, preserving keys whose
 *  value is explicitly `undefined` (an explicit clear). */
export function pickGraphShotPatch<T extends Record<string, unknown>>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (isGraphShotPatchField(key)) out[key] = patch[key];
  }
  return out as Partial<T>;
}
