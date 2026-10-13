/**
 * The shot's selected output — the ONE resolver for "what is this shot
 * currently showing?" (architecture hardening workstream 2, recommendation 5
 * of the brief).
 *
 * The node-graph output pipe (`graphOutputSource` + per-node take selections)
 * is the single source of truth for the shot's primary visual. `artwork` /
 * `videoPath` are derived read models written only by main's write-through
 * (`setShotSelectedOutput` in pipeline.ts); every surface that needs the
 * current media asks this resolver (or reads the mirrors main derives from
 * it), never a second hand-rolled resolution.
 *
 * The renderer imports this to derive optimistic mirrors on pipe/unpipe
 * gestures; main's `syncBoardOutputToPipe` derives the authoritative mirrors
 * from it on load/save/rebase.
 */
import type { GraphGenItem, ProductionShot } from "./ipc.js";
import { videoNodesFor } from "./graph/materialize.js";

export type OutputSource = "imagegen" | "editgen" | "upscale" | "videogen" | "tween" | "ref";

/** The resolved current output of a shot. `media: "none"` means either
 *  nothing is piped or the piped node has no selection yet. */
export interface SelectedOutput {
  /** Which pipe owns the selection (undefined = nothing piped). */
  source?: OutputSource;
  /** The owning node id when the source is a per-node kind. */
  nodeId?: string;
  /** The reference id when the source is a reference. */
  refId?: string;
  media: "still" | "clip" | "none";
  /** Workspace-relative path of the selected media (absent when "none"). */
  path?: string;
}

/** The selected take of an edit node (find by id, else the first node). */
function editSelection(shot: ProductionShot, nodeId?: string): { nodeId?: string; take?: GraphGenItem } {
  const node = (shot.graphEditNodes ?? []).find((n) => n.id === (nodeId ?? "edit0")) ?? shot.graphEditNodes?.[0];
  return { nodeId: node?.id, take: node?.gens?.[node.genIndex ?? 0] };
}

/** The selected take of a video node (find by id, else the first node; legacy
 *  flat fields synthesize a `vid0` pre-migration). */
function videoSelection(shot: ProductionShot, nodeId?: string): { nodeId?: string; take?: GraphGenItem } {
  const nodes = shot.graphVideoNodes ?? videoNodesFor(shot);
  const node = nodeId ? nodes.find((n) => n.id === nodeId) : nodes[0];
  return { nodeId: node?.id, take: node?.gens?.[node.genIndex ?? 0] };
}

/** Resolve the shot's selected output from the pipe (pure, read-only). */
export function resolveSelectedOutput(shot: ProductionShot): SelectedOutput {
  switch (shot.graphOutputSource) {
    case "imagegen": {
      const take = shot.graphImageGens?.[shot.graphImageGenIndex ?? 0];
      return take?.path
        ? { source: "imagegen", media: "still", path: take.path }
        : { source: "imagegen", media: "none" };
    }
    case "editgen": {
      const sel = editSelection(shot, shot.graphOutputEditNodeId);
      return sel.take?.path
        ? { source: "editgen", nodeId: sel.nodeId, media: "still", path: sel.take.path }
        : { source: "editgen", nodeId: sel.nodeId, media: "none" };
    }
    case "upscale": {
      const take = shot.graphUpscale?.gens?.[shot.graphUpscale.genIndex ?? 0];
      return take?.path
        ? { source: "upscale", media: "still", path: take.path }
        : { source: "upscale", media: "none" };
    }
    case "videogen": {
      const sel = videoSelection(shot, shot.graphOutputVideoNodeId);
      return sel.take?.path
        ? { source: "videogen", nodeId: sel.nodeId, media: "clip", path: sel.take.path }
        : { source: "videogen", nodeId: sel.nodeId, media: "none" };
    }
    case "tween": {
      return shot.graphTweenOutput
        ? { source: "tween", media: "clip", path: shot.graphTweenOutput }
        : { source: "tween", media: "none" };
    }
    case "ref": {
      // A ref-piped shot's media lives in the mirrors main wrote (videoPath
      // for a dropped clip, artwork for a copied still) — the production's
      // reference list is what names the file, and the pipe only holds the id.
      const path = shot.videoPath ?? shot.artwork;
      return path
        ? { source: "ref", refId: shot.graphOutputRefId, media: shot.videoPath ? "clip" : "still", path }
        : { source: "ref", refId: shot.graphOutputRefId, media: "none" };
    }
    default:
      return { media: "none" };
  }
}

/** The wire shape for the `production:selectGraphTake` command. Either a
 *  storyboard-style promotion by stored path (validated main-side, like
 *  `selectBoardFrame`) or a canvas-style selection by node kind + take index.
 *  Selecting a take never re-binds the pipe — the index moves, and the
 *  mirrors re-derive only when that node is the one feeding the output. */
export type SelectGraphTakeRequest =
  | { path: string }
  | { kind: "imagegen" | "editgen" | "upscale" | "videogen"; nodeId?: string; index: number }
  | { kind: "unpipe" };
