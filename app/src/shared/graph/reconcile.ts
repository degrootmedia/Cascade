/**
 * Node-data equality for the canvas reconciliation pass (architecture
 * hardening workstream 1).
 *
 * `NodeGraphModal` reconciles derived nodes against the live React Flow node
 * list and reuses the old node object when its visible data is unchanged (so
 * prompt editors keep focus across keystrokes). Every canvas node type has a
 * case here — one `else if (d.type === …)` chain per type, extracted from
 * `NodeGraphModal.tsx` so a test can enumerate it and a new node type can
 * never ship without its equality rule (the 2026-09-24 lesson: a missing
 * equality case fails silently — the edge is written but the wire never
 * draws).
 *
 * Unknown/future types intentionally compare EQUAL (the historical default):
 * reusing the old node keeps an unknown kind's serialized data and geometry
 * instead of rebuilding it — the completeness test in `node-registry.test.ts`
 * is what guarantees every registered kind has a real rule here.
 */
export type NodeData = Record<string, unknown>;

export type NodeDataEqual = (a: NodeData, b: NodeData) => boolean;

/** Element-wise identity for per-node generation lists. Length-only checks
 *  missed in-place edits AND rebuilt data on every pass; when nothing
 *  genuinely differs the old node (and its data reference) is reused verbatim
 *  so React Flow skips the re-render. */
export function sameGenItems(x: unknown, y: unknown): boolean {
  const ax = x as { url: string; prompt: string; path: string }[];
  const by = y as { url: string; prompt: string; path: string }[];
  if (!Array.isArray(ax) || !Array.isArray(by) || ax.length !== by.length) return false;
  return ax.every((it, i) => it.url === by[i]?.url && it.prompt === by[i]?.prompt && it.path === by[i]?.path);
}

/** Element-wise identity for tween keyframe lists. */
export function sameKeyframes(x: unknown, y: unknown): boolean {
  const ax = x as { id: string; name: string; artwork: string }[];
  const by = y as { id: string; name: string; artwork: string }[];
  if (!Array.isArray(ax) || !Array.isArray(by) || ax.length !== by.length) return false;
  return ax.every((k, i) => k.id === by[i]?.id && k.name === by[i]?.name && k.artwork === by[i]?.artwork);
}

const promptNodeEqual = (a: NodeData, b: NodeData): boolean =>
  (a.value as string) === (b.value as string) &&
  (a.includeBrand as boolean) === (b.includeBrand as boolean) &&
  (a.refHandles as string[]).length === (b.refHandles as string[]).length &&
  (a.refHandles as string[]).every((v, i) => v === (b.refHandles as string[])[i]) &&
  (a.openHandleId as string) === (b.openHandleId as string);

/** Per-canvas-type equality rules. Keys are React Flow node type names —
 *  `frame` is the output kind's canvas alias, `sequenceprompt` is a canvas-only
 *  type that is not a `GraphNodeKind` (its stored kind is `videoprompt`). */
export const CANVAS_TYPE_EQUAL: Record<string, NodeDataEqual> = {
  composer: (a, b) =>
    (a.value as string) === (b.value as string) &&
    (a.includeBrand as boolean) === (b.includeBrand as boolean) &&
    (a.magicActive as boolean) === (b.magicActive as boolean) &&
    (a.refHandles as string[]).length === (b.refHandles as string[]).length &&
    (a.refHandles as string[]).every((v, i) => v === (b.refHandles as string[])[i]) &&
    (a.openHandleId as string) === (b.openHandleId as string),
  videogen: (a, b) =>
    (a.hasImageSource as boolean) === (b.hasImageSource as boolean) &&
    (a.selected as number) === (b.selected as number) &&
    sameGenItems(a.items, b.items) &&
    (a.busy as boolean) === (b.busy as boolean),
  tween: (a, b) =>
    (a.refIds as string[]).length === (b.refIds as string[]).length &&
    (a.refIds as string[]).every((v, i) => v === (b.refIds as string[])[i]) &&
    sameKeyframes(a.keyframes, b.keyframes) &&
    (a.blockCount as number) === (b.blockCount as number) &&
    (a.readyBlocks as number) === (b.readyBlocks as number) &&
    (a.stitched as boolean) === (b.stitched as boolean) &&
    (a.reencoded as boolean) === (b.reencoded as boolean),
  editgen: (a, b) =>
    (a.sourceHint as string) === (b.sourceHint as string) &&
    (a.prompt as string) === (b.prompt as string) &&
    (a.sourceRefId as string | undefined) === (b.sourceRefId as string | undefined) &&
    (a.sourcePath as string | undefined) === (b.sourcePath as string | undefined) &&
    (a.selected as number) === (b.selected as number) &&
    sameGenItems(a.items, b.items) &&
    (a.busy as boolean) === (b.busy as boolean),
  videoprompt: promptNodeEqual,
  sequenceprompt: (a, b) =>
    promptNodeEqual(a, b) && JSON.stringify(a.segments) === JSON.stringify(b.segments),
  editprompt: promptNodeEqual,
  editvideoprompt: (a, b) =>
    promptNodeEqual(a, b) && (a.mode as string | undefined) === (b.mode as string | undefined),
  style: (a, b) => (a.value as string) === (b.value as string),
  brand: (a, b) => (a.include as boolean) === (b.include as boolean),
  ref: (a, b) =>
    (a.name as string) === (b.name as string) &&
    (a.artwork as string) === (b.artwork as string) &&
    (a.tagged as boolean) === (b.tagged as boolean) &&
    (a.sourced as boolean) === (b.sourced as boolean) &&
    (a.missing as boolean) === (b.missing as boolean) &&
    (a.collapsed as boolean) === (b.collapsed as boolean) &&
    (a.mediaPath as string | undefined) === (b.mediaPath as string | undefined),
  frame: (a, b) =>
    (a.previewUrl as string) === (b.previewUrl as string) &&
    (a.previewKind as string) === (b.previewKind as string) &&
    (a.bound as boolean) === (b.bound as boolean),
  imagegen: (a, b) =>
    (a.selected as number) === (b.selected as number) && sameGenItems(a.items, b.items) && (a.busy as boolean) === (b.busy as boolean),
  editvideo: (a, b) =>
    (a.selected as number) === (b.selected as number) &&
    sameGenItems(a.items, b.items) &&
    (a.busy as boolean) === (b.busy as boolean) &&
    (a.piped as boolean) === (b.piped as boolean) &&
    (a.pending as boolean) === (b.pending as boolean) &&
    (a.savedPrompt as string) === (b.savedPrompt as string) &&
    (a.savedResolution as string | undefined) === (b.savedResolution as string | undefined) &&
    (a.savedDurationSec as number | undefined) === (b.savedDurationSec as number | undefined) &&
    ((a.models as unknown[] | undefined)?.length ?? 0) === ((b.models as unknown[] | undefined)?.length ?? 0) &&
    (a.sourceLabel as string | null) === (b.sourceLabel as string | null) &&
    (a.mode as string | undefined) === (b.mode as string | undefined) &&
    (a.imageRefCount as number | undefined) === (b.imageRefCount as number | undefined),
  cameraGrid: (a, b) =>
    (a.busy as boolean | undefined) === (b.busy as boolean | undefined) &&
    (a.sheetUrl as string | null) === (b.sheetUrl as string | null) &&
    (a.sheetPath as string | undefined) === (b.sheetPath as string | undefined) &&
    (a.cols as number) === (b.cols as number) &&
    (a.rows as number) === (b.rows as number) &&
    (a.savedModel as string | undefined) === (b.savedModel as string | undefined) &&
    (a.savedResolution as string | undefined) === (b.savedResolution as string | undefined) &&
    JSON.stringify(a.savedParams ?? {}) === JSON.stringify(b.savedParams ?? {}) &&
    (a.sourceLabel as string | null) === (b.sourceLabel as string | null) &&
    (a.gridSourceLabel as string | null) === (b.gridSourceLabel as string | null) &&
    JSON.stringify(a.refIds) === JSON.stringify(b.refIds) &&
    (a.models as unknown[]).length === (b.models as unknown[]).length,
  upscale: (a, b) =>
    (a.busy as boolean | undefined) === (b.busy as boolean | undefined) &&
    (a.savedModel as string | undefined) === (b.savedModel as string | undefined) &&
    (a.savedResolution as string | undefined) === (b.savedResolution as string | undefined) &&
    JSON.stringify(a.savedParams ?? {}) === JSON.stringify(b.savedParams ?? {}) &&
    (a.sourceHint as string) === (b.sourceHint as string) &&
    (a.sourceRefId as string | undefined) === (b.sourceRefId as string | undefined) &&
    (a.sourcePath as string | undefined) === (b.sourcePath as string | undefined) &&
    (a.selected as number) === (b.selected as number) &&
    sameGenItems(a.items, b.items) &&
    (a.models as unknown[]).length === (b.models as unknown[]).length,
};

/** The reconciliation pass's entry point: same canvas type and unchanged
 *  visible data ⇒ reuse the old node. Unknown types compare equal (see the
 *  module header). */
export function nodeDataEqual(type: string, a: NodeData, b: NodeData): boolean {
  const rule = CANVAS_TYPE_EQUAL[type];
  return rule ? rule(a, b) : true;
}
