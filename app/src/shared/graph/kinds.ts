/**
 * The node-kind registration table (architecture hardening workstream 1).
 *
 * Recommendation 2 of the hardening brief: a node type should be either fully
 * registered or impossible to build. This module is the declarative record for
 * every `GraphNodeKind` — its canvas type (the React Flow `nodeTypes` key),
 * which shot field owns its state, which IPC channels submit its generations,
 * and the canonical canvas ids `nodeKindForId` must resolve back to it.
 *
 * The completeness test (`app/test/node-registry.test.ts`) iterates the
 * `GraphNodeKind` union (derived from the type, never a hand-maintained list)
 * and fails when any registered kind is missing a piece: a ports-table row,
 * a node view, a reconciliation equality rule, an id resolution path, a
 * materializer emission, a merge/ownership classification, or a submit
 * channel. Derived lookup tables in NodeGraphModal should consult this table
 * rather than hand-rolling a parallel list.
 */
import type { GraphNodeKind, ProductionShot } from "../ipc.js";

/** Node-shelf categories, in shelf order. Fixed in this version: assignment
 *  is data on each registry row (`category`), so renaming or moving a node
 *  type between categories is a one-line registry edit. Generation and edit
 *  nodes file under the media they PRODUCE (an edit-image node is Image, an
 *  edit-video node is Video); prompt/text nodes file under Text & Prompts;
 *  reference inputs under Inputs & References; the frame output under
 *  Output; non-generating helpers under Layout & Utility. */
export const NODE_CATEGORIES = [
  { id: "image", label: "Image" },
  { id: "video", label: "Video" },
  { id: "text-prompts", label: "Text & Prompts" },
  { id: "inputs-references", label: "Inputs & References" },
  { id: "output", label: "Output" },
  { id: "layout-utility", label: "Layout & Utility" },
] as const;

export type NodeCategoryId = (typeof NODE_CATEGORIES)[number]["id"];

/** Where a node type with no declared category files, so it can never
 *  vanish from the shelf: the non-generating helpers' home. */
export const FALLBACK_NODE_CATEGORY: NodeCategoryId = "layout-utility";

/** The declared category of a (possibly partial) registration, else the
 *  fallback. The safety net behind `nodeCategoryFor`. */
export function categoryOrFallback(reg?: { category?: NodeCategoryId } | null): NodeCategoryId {
  return reg?.category ?? FALLBACK_NODE_CATEGORY;
}

export interface NodeKindRegistration {
  kind: GraphNodeKind;
  /** The React Flow node type used in the canvas `nodeTypes` map. The output
   *  kind aliases to `frame` (React Flow's built-in "output" type paints a
   *  white box behind the custom node). */
  canvasType: string;
  /** The `ProductionShot` field that owns this kind's state (generator kinds).
   *  Absent for structural kinds whose state is the graph itself. */
  stateField?: keyof ProductionShot;
  /** IPC channels that submit a generation for this kind (structural/prompt
   *  kinds have none). */
  submitChannels: string[];
  /** Canvas ids (bare and prefixed forms) that `nodeKindForId` must resolve
   *  back to this kind. */
  canonicalIds: string[];
  /** The node-shelf category this kind files under — exactly one per kind.
   *  Optional in the type so a future kind that forgets to declare one
   *  still compiles and lands in the fallback (`FALLBACK_NODE_CATEGORY`)
   *  instead of vanishing from the shelf; the completeness test asserts
   *  every registered kind declares one. */
  category?: NodeCategoryId;
}

/** The shelf category a node kind files under: its declared category, or
 *  the Layout & Utility fallback for undeclared/unknown kinds. */
export function nodeCategoryFor(kind: GraphNodeKind): NodeCategoryId {
  return categoryOrFallback(NODE_KIND_REGISTRY[kind]);
}

export const NODE_KIND_REGISTRY: Record<GraphNodeKind, NodeKindRegistration> = {
  composer: { kind: "composer", canvasType: "composer", submitChannels: [], canonicalIds: ["composer"], category: "text-prompts" },
  style: { kind: "style", canvasType: "style", submitChannels: [], canonicalIds: ["style"], category: "text-prompts" },
  brand: { kind: "brand", canvasType: "brand", submitChannels: [], canonicalIds: ["brand"], category: "text-prompts" },
  output: { kind: "output", canvasType: "frame", submitChannels: [], canonicalIds: ["output"], category: "output" },
  imagegen: {
    kind: "imagegen",
    canvasType: "imagegen",
    stateField: "graphImageGens",
    submitChannels: ["production:generateFrameNode"],
    canonicalIds: ["imagegen"],
    category: "image",
  },
  videogen: {
    kind: "videogen",
    canvasType: "videogen",
    stateField: "graphVideoNodes",
    submitChannels: ["production:generateVideoNode"],
    canonicalIds: ["videogen", "videogen:vid1"],
    category: "video",
  },
  videoprompt: { kind: "videoprompt", canvasType: "videoprompt", submitChannels: [], canonicalIds: ["videoprompt", "videoprompt:vid1"], category: "text-prompts" },
  editgen: {
    kind: "editgen",
    canvasType: "editgen",
    stateField: "graphEditNodes",
    submitChannels: ["production:generateEditNode"],
    canonicalIds: ["editgen", "editgen:edit0", "editgen:edit1"],
    category: "image",
  },
  editprompt: { kind: "editprompt", canvasType: "editprompt", submitChannels: [], canonicalIds: ["editprompt", "editprompt:edit0"], category: "text-prompts" },
  editvideo: {
    kind: "editvideo",
    canvasType: "editvideo",
    stateField: "graphVideoNodes",
    submitChannels: ["production:generateEditVideoNode"],
    canonicalIds: ["editvideo", "editvideo:ev1"],
    category: "video",
  },
  editvideoprompt: {
    kind: "editvideoprompt",
    canvasType: "editvideoprompt",
    submitChannels: [],
    canonicalIds: ["editvideoprompt", "editvideoprompt:ev1"],
    category: "text-prompts",
  },
  tween: {
    kind: "tween",
    canvasType: "tween",
    stateField: "graphTweenBlocks",
    submitChannels: ["production:generateTweenBlock"],
    canonicalIds: ["tween"],
    category: "video",
  },
  ref: { kind: "ref", canvasType: "ref", submitChannels: [], canonicalIds: ["ref:r1"], category: "inputs-references" },
  cameraGrid: {
    kind: "cameraGrid",
    canvasType: "cameraGrid",
    stateField: "graphCameraGrid",
    submitChannels: ["cameraGrid:generate"],
    canonicalIds: ["cameraGrid"],
    category: "image",
  },
  upscale: {
    kind: "upscale",
    canvasType: "upscale",
    stateField: "graphUpscale",
    submitChannels: ["production:generateUpscaleNode"],
    canonicalIds: ["upscale"],
    category: "image",
  },
};

/** Canvas-only node types that are not `GraphNodeKind`s: `frame` (the output
 *  kind's alias) and `sequenceprompt` (the sequence canvas's prompt view;
 *  its stored kind is `videoprompt`). They still need views + equality rules,
 *  and the completeness test covers them alongside the kinds. */
export const EXTRA_CANVAS_TYPES = ["frame", "sequenceprompt"] as const;

/** Every canvas type the node-graph renderer must be able to draw. */
export function canvasTypes(): string[] {
  return [...Object.values(NODE_KIND_REGISTRY).map((r) => r.canvasType), ...EXTRA_CANVAS_TYPES];
}
