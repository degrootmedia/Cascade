/**
 * Generation ownership — the one home for "which stored generation is this
 * path, is it currently feeding something, and how do I remove it". Both the
 * main process (delete + unlink) and the renderer (right-click gating,
 * pre-flight block) read this so the two can't drift.
 *
 * A generation is a `GraphGenItem` living on a shot's node history (image /
 * video / edit / edit-video) or on an in-betweener block. Board-frame history
 * (`artworkHistory`) and imported frames are NOT generations — they carry no
 * model/prompt and aren't recoverable from the vendor account.
 */
import type { GraphGenItem, ProductionShot } from "./ipc.js";
import { TWEEN_KEY_IMGGEN, editNodeKeyframe } from "./ipc.js";

export type GenerationKind = "image" | "video" | "edit" | "editvideo" | "tween" | "upscale";

/** A located generation entry within a shot's stored history. */
export interface GenerationRef {
  kind: GenerationKind;
  /** Workspace-relative path of the stored file. */
  rel: string;
  /** Index within its owning history array. */
  index: number;
  /** Owning edit node id (kind "edit"). */
  nodeId?: string;
  /** Owning in-betweener block id (kind "tween"). */
  blockId?: string;
}

function indexOfPath(arr: GraphGenItem[] | undefined, rel: string): number {
  if (!arr) return -1;
  return arr.findIndex((g) => g.path === rel);
}

/** Locate a generation by its stored path, or null when the path isn't one. */
export function findGeneration(shot: ProductionShot, rel: string): GenerationRef | null {
  if (typeof rel !== "string" || !rel) return null;
  let index = indexOfPath(shot.graphImageGens, rel);
  if (index >= 0) return { kind: "image", rel, index };
  index = indexOfPath(shot.graphVideoGens, rel);
  if (index >= 0) return { kind: "video", rel, index };
  for (const node of shot.graphVideoNodes ?? []) {
    index = indexOfPath(node.gens, rel);
    if (index >= 0) return { kind: "video", rel, index, nodeId: node.id };
  }
  index = indexOfPath(shot.graphEditVideoGens, rel);
  if (index >= 0) return { kind: "editvideo", rel, index };
  index = indexOfPath(shot.graphUpscale?.gens, rel);
  if (index >= 0) return { kind: "upscale", rel, index };
  for (const node of shot.graphEditNodes ?? []) {
    index = indexOfPath(node.gens, rel);
    if (index >= 0) return { kind: "edit", rel, index, nodeId: node.id };
  }
  for (const block of shot.graphTweenBlocks ?? []) {
    index = indexOfPath(block.gens, rel);
    if (index >= 0) return { kind: "tween", rel, index, blockId: block.id };
  }
  return null;
}

/** The selected path on a history array, or null when nothing is selected. */
function selectedPath(arr: GraphGenItem[] | undefined, index: number | undefined): string | null {
  return arr?.[index ?? 0]?.path ?? null;
}

/**
 * Why a generation can't be deleted — it's feeding the storyboard output, the
 * animatic, or a node pipe — or null when it's safe to remove. Only the
 * SELECTED item of a history can feed anything; older takes are inert.
 */
export function generationInUse(shot: ProductionShot, gen: GenerationRef): string | null {
  const rel = gen.rel;
  if (shot.artwork === rel) return "the storyboard's current frame";
  if (shot.videoPath === rel) return "the shot's current clip";
  if (gen.kind === "image") {
    if (selectedPath(shot.graphImageGens, shot.graphImageGenIndex) !== rel) return null;
    if (shot.graphImageToVideo) return "the video node's source frame";
    if ((shot.graphTweenRefIds ?? []).includes(TWEEN_KEY_IMGGEN)) return "an in-betweener keyframe";
    return null;
  }
  if (gen.kind === "video") {
    if (gen.nodeId) {
      const node = (shot.graphVideoNodes ?? []).find((n) => n.id === gen.nodeId);
      if (!node || selectedPath(node.gens, node.genIndex) !== rel) return null;
    } else if (selectedPath(shot.graphVideoGens, shot.graphVideoGenIndex) !== rel) {
      return null;
    }
    if (shot.graphVideoToEditVideo) return "the edit-video node's source clip";
    return null;
  }
  if (gen.kind === "editvideo") {
    if (selectedPath(shot.graphEditVideoGens, shot.graphEditVideoGenIndex) !== rel) return null;
    if (shot.graphOutputSource === "editvideo") return "the storyboard's current clip";
    return null;
  }
  if (gen.kind === "edit" && gen.nodeId) {
    const node = (shot.graphEditNodes ?? []).find((n) => n.id === gen.nodeId);
    if (!node || selectedPath(node.gens, node.genIndex) !== rel) return null;
    if (shot.graphOutputSource === "editgen" && shot.graphOutputEditNodeId === gen.nodeId) return "the storyboard's current frame";
    if (shot.graphEditToVideo && shot.graphVideoSourceEditNodeId === gen.nodeId) return "the video node's source frame";
    if ((shot.graphTweenRefIds ?? []).includes(editNodeKeyframe(gen.nodeId))) return "an in-betweener keyframe";
    if ((shot.graphEditNodes ?? []).some((n) => n.source?.kind === "editgen" && n.source.nodeId === gen.nodeId)) return "another edit node's source image";
    return null;
  }
  if (gen.kind === "tween" && gen.blockId) {
    const block = (shot.graphTweenBlocks ?? []).find((b) => b.id === gen.blockId);
    if (!block || (block.genIndex ?? 0) !== gen.index) return null;
    if (shot.graphTweenOutput || shot.graphOutputSource === "tween") return "the stitched in-betweener output";
    return null;
  }
  if (gen.kind === "upscale") {
    if (selectedPath(shot.graphUpscale?.gens, shot.graphUpscale?.genIndex) !== rel) return null;
    if (shot.graphOutputSource === "upscale") return "the storyboard's current frame";
    return null;
  }
  return null;
}

/** The user-facing block reason (shared by the renderer pre-check and the
 *  main-process guard so their wording can't diverge). */
export function generationInUseMessage(reason: string): string {
  return `This generation is in use as ${reason} — unbind it before deleting.`;
}

function dropAt<T>(arr: T[] | undefined, index: number): T[] {
  const next = (arr ?? []).slice();
  next.splice(index, 1);
  return next;
}

/** Shift a selection index after removing `removed`, clamped to `len`. */
function repairIndex(current: number | undefined, removed: number, len: number): number | undefined {
  if (len <= 0) return undefined;
  let i = current ?? 0;
  if (removed < i) i -= 1;
  if (i >= len) i = len - 1;
  return i < 0 ? 0 : i;
}

/** Remove a generation from its owning history and repair the selection.
 *  Returns false when the entry's owner no longer exists. Mutates `shot`. */
export function removeGeneration(shot: ProductionShot, gen: GenerationRef): boolean {
  let removed = false;
  if (gen.kind === "image") {
    shot.graphImageGens = dropAt(shot.graphImageGens, gen.index);
    shot.graphImageGenIndex = repairIndex(shot.graphImageGenIndex, gen.index, shot.graphImageGens.length);
    removed = true;
  } else if (gen.kind === "video" && gen.nodeId) {
    const node = (shot.graphVideoNodes ?? []).find((n) => n.id === gen.nodeId);
    if (node) {
      node.gens = dropAt(node.gens, gen.index);
      node.genIndex = repairIndex(node.genIndex, gen.index, node.gens.length);
      removed = true;
    }
  } else if (gen.kind === "video") {
    shot.graphVideoGens = dropAt(shot.graphVideoGens, gen.index);
    shot.graphVideoGenIndex = repairIndex(shot.graphVideoGenIndex, gen.index, shot.graphVideoGens.length);
    removed = true;
  } else if (gen.kind === "editvideo") {
    shot.graphEditVideoGens = dropAt(shot.graphEditVideoGens, gen.index);
    shot.graphEditVideoGenIndex = repairIndex(shot.graphEditVideoGenIndex, gen.index, shot.graphEditVideoGens.length);
    removed = true;
  } else if (gen.kind === "edit" && gen.nodeId) {
    const node = (shot.graphEditNodes ?? []).find((n) => n.id === gen.nodeId);
    if (node) {
      node.gens = dropAt(node.gens, gen.index);
      node.genIndex = repairIndex(node.genIndex, gen.index, node.gens.length);
      removed = true;
    }
  } else if (gen.kind === "tween" && gen.blockId) {
    const block = (shot.graphTweenBlocks ?? []).find((b) => b.id === gen.blockId);
    if (block) {
      block.gens = dropAt(block.gens, gen.index);
      block.genIndex = repairIndex(block.genIndex, gen.index, block.gens.length);
      removed = true;
    }
  } else if (gen.kind === "upscale" && shot.graphUpscale) {
    shot.graphUpscale.gens = dropAt(shot.graphUpscale.gens, gen.index);
    shot.graphUpscale.genIndex = repairIndex(shot.graphUpscale.genIndex, gen.index, shot.graphUpscale.gens.length);
    removed = true;
  }
  // A generation may also sit in the legacy `artworkHistory` mirror (every
  // previous primary was copied there). Purge it so the board's history
  // browser can't keep pointing at a deleted file.
  if (removed && shot.artworkHistory?.length) {
    shot.artworkHistory = shot.artworkHistory.filter((rel) => rel !== gen.rel);
  }
  return removed;
}
