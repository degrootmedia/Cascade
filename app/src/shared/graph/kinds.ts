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
}

export const NODE_KIND_REGISTRY: Record<GraphNodeKind, NodeKindRegistration> = {
  composer: { kind: "composer", canvasType: "composer", submitChannels: [], canonicalIds: ["composer"] },
  style: { kind: "style", canvasType: "style", submitChannels: [], canonicalIds: ["style"] },
  brand: { kind: "brand", canvasType: "brand", submitChannels: [], canonicalIds: ["brand"] },
  output: { kind: "output", canvasType: "frame", submitChannels: [], canonicalIds: ["output"] },
  imagegen: {
    kind: "imagegen",
    canvasType: "imagegen",
    stateField: "graphImageGens",
    submitChannels: ["production:generateFrameNode"],
    canonicalIds: ["imagegen"],
  },
  videogen: {
    kind: "videogen",
    canvasType: "videogen",
    stateField: "graphVideoNodes",
    submitChannels: ["production:generateVideoNode"],
    canonicalIds: ["videogen", "videogen:vid1"],
  },
  videoprompt: { kind: "videoprompt", canvasType: "videoprompt", submitChannels: [], canonicalIds: ["videoprompt", "videoprompt:vid1"] },
  editgen: {
    kind: "editgen",
    canvasType: "editgen",
    stateField: "graphEditNodes",
    submitChannels: ["production:generateEditNode"],
    canonicalIds: ["editgen", "editgen:edit0", "editgen:edit1"],
  },
  editprompt: { kind: "editprompt", canvasType: "editprompt", submitChannels: [], canonicalIds: ["editprompt", "editprompt:edit0"] },
  editvideo: {
    kind: "editvideo",
    canvasType: "editvideo",
    stateField: "graphVideoNodes",
    submitChannels: ["production:generateEditVideoNode"],
    canonicalIds: ["editvideo", "editvideo:ev1"],
  },
  editvideoprompt: {
    kind: "editvideoprompt",
    canvasType: "editvideoprompt",
    submitChannels: [],
    canonicalIds: ["editvideoprompt", "editvideoprompt:ev1"],
  },
  tween: {
    kind: "tween",
    canvasType: "tween",
    stateField: "graphTweenBlocks",
    submitChannels: ["production:generateTweenBlock"],
    canonicalIds: ["tween"],
  },
  ref: { kind: "ref", canvasType: "ref", submitChannels: [], canonicalIds: ["ref:r1"] },
  cameraGrid: {
    kind: "cameraGrid",
    canvasType: "cameraGrid",
    stateField: "graphCameraGrid",
    submitChannels: ["cameraGrid:generate"],
    canonicalIds: ["cameraGrid"],
  },
  upscale: {
    kind: "upscale",
    canvasType: "upscale",
    stateField: "graphUpscale",
    submitChannels: ["production:generateUpscaleNode"],
    canonicalIds: ["upscale"],
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
