/** Main-process job ledger — IPC types (architecture hardening workstream 3,
 *  recommendation 3 of the brief).
 *
 *  Every generation job's lifecycle is recorded in the MAIN process (queued →
 *  running → succeeded/failed), and every window subscribes to it instead of
 *  inferring "busy" from its own local events. A window opened mid-generation
 *  requests the snapshot and then listens for changes; a completion event can
 *  never be missed because the ledger — not the promise that started the job —
 *  is the source of the state.
 */
import type { CanvasBusySnapshot } from "./window.js";

export type JobKind =
  | "boards"
  | "boardRecheck"
  | "frameNode"
  | "editNode"
  | "upscale"
  | "cameraGrid"
  | "video"
  | "videoNode"
  | "editVideoNode"
  | "sequenceVideo"
  | "sequenceEditVideo"
  | "recheckVideo"
  | "tweenBlock"
  | "stitch"
  | "unstitch"
  | "styleFrame"
  | "recheckStyleFrame"
  | "referenceImage"
  | "characterSheet"
  | "magicPrompts"
  | "suite"
  | "3d";

export type JobState = "running" | "succeeded" | "failed" | "interrupted";

/** One generation job's record. Non-terminal jobs are persisted so a crash
 *  leaves them recoverable (see the `interrupted` state). */
export interface JobRecord {
  id: string;
  productionId: string;
  /** The shot the job belongs to (shot-scoped jobs only). */
  shotId?: string;
  /** The node/block the job belongs to (per-node jobs only). */
  nodeId?: string;
  kind: JobKind;
  state: JobState;
  /** Short user-facing label ("Generating a video (node graph)"). */
  label: string;
  startedAt: string;
  finishedAt?: string;
  /** The failure reason when `state === "failed"`. */
  error?: string;
}

/** The ledger state for one production: every non-terminal job plus a bounded
 *  window of recently finished ones, so a late subscriber still sees what just
 *  completed. */
export interface JobSnapshot {
  productionId: string;
  jobs: JobRecord[];
}

/** Project a production's job records onto the canvas busy shape the node
 *  graph renders (the same shape the two windows used to mirror between
 *  themselves). Pure — the renderer and tests both read it. */
export function jobsToCanvasBusy(productionId: string, jobs: JobRecord[]): CanvasBusySnapshot {
  const image = new Set<string>();
  const video = new Set<string>();
  const editVideo = new Set<string>();
  const editNodes = new Set<string>();
  const tween: Record<string, string> = {};
  const stitching = new Set<string>();
  const sequences = new Set<string>();
  const cameraGrid = new Set<string>();
  const upscale = new Set<string>();
  for (const job of jobs) {
    if (job.state !== "running") continue;
    const shot = job.shotId;
    switch (job.kind) {
      case "frameNode":
      case "boardRecheck":
        if (shot) image.add(shot);
        break;
      case "cameraGrid":
        if (shot) cameraGrid.add(shot);
        break;
      case "upscale":
        if (shot) upscale.add(shot);
        break;
      case "editNode":
        if (shot) editNodes.add(job.nodeId ? `${shot}:${job.nodeId}` : shot);
        break;
      case "videoNode":
        if (shot) video.add(`${shot}:${job.nodeId ?? "vid0"}`);
        break;
      case "sequenceVideo":
        if (shot) sequences.add(`${shot}:${job.nodeId ?? "vid0"}`);
        break;
      case "editVideoNode":
      case "sequenceEditVideo":
        if (shot) editVideo.add(`${shot}:${job.nodeId ?? "ev0"}`);
        break;
      case "tweenBlock":
        if (shot) tween[shot] = job.nodeId ?? shot;
        break;
      case "stitch":
      case "unstitch":
        if (shot) stitching.add(shot);
        break;
      default:
        break;
    }
  }
  return {
    productionId,
    image: [...image],
    video: [...video],
    editVideo: [...editVideo],
    editNodes: [...editNodes],
    tween,
    stitching: [...stitching],
    sequences: [...sequences],
    cameraGrid: [...cameraGrid],
    upscale: [...upscale],
  };
}

/** Derive a job record's identity from an IPC channel + its args, so the
 *  `handle` wrapper records every generation without each call site opting in.
 *  Null for channels that aren't generation jobs. The convention: args[0] is
 *  the production id; args[1] a shot/sequence id when it is a plain string;
 *  per-node ids ride the options object. */
export function jobForChannel(channel: string, args: unknown[]): { kind: JobKind; shotId?: string; nodeId?: string } | null {
  const kindByChannel: Record<string, JobKind> = {
    "production:generateBoards": "boards",
    "production:regenerateBoard": "boards",
    "production:regenerateBoards": "boards",
    "production:recheckBoard": "boardRecheck",
    "production:editBoard": "editNode",
    "production:generateFrameNode": "frameNode",
    "production:generateEditNode": "editNode",
    "production:generateUpscaleNode": "upscale",
    "cameraGrid:generate": "cameraGrid",
    "production:generateVideo": "video",
    "production:generateVideoNode": "videoNode",
    "production:upgradeDraftVideo": "videoNode",
    "production:generateEditVideoNode": "editVideoNode",
    "production:generateSequenceVideo": "sequenceVideo",
    "production:generateSequenceEditVideo": "sequenceEditVideo",
    "production:recheckVideo": "recheckVideo",
    "production:generateTweenBlock": "tweenBlock",
    "production:stitchTween": "stitch",
    "production:unstitchTween": "unstitch",
    "production:generateStyleFrame": "styleFrame",
    "production:recheckStyleFrame": "recheckStyleFrame",
    "production:generateReferenceImage": "referenceImage",
    "production:generateCharacterSheet": "characterSheet",
    "production:generateMagicPrompts": "magicPrompts",
    "production:regenerateMagicPrompt": "magicPrompts",
    "suite:generate": "suite",
    "production:generate3dModel": "3d",
  };
  const kind = kindByChannel[channel];
  if (!kind) return null;
  if (typeof args[0] !== "string" || !args[0]) return null;
  const shotId = typeof args[1] === "string" && args[1] ? args[1] : undefined;
  const opts = args[2];
  let nodeId: string | undefined;
  if (opts && typeof opts === "object" && !Array.isArray(opts)) {
    const o = opts as Record<string, unknown>;
    if (typeof o.nodeId === "string" && o.nodeId) nodeId = o.nodeId;
  }
  if (channel === "production:generateTweenBlock" && typeof args[2] === "string" && args[2]) nodeId = args[2];
  return { kind, shotId, nodeId };
}

/** Short user-facing label for each job kind (the progress events stream the
 *  detail; this is the ledger's one-liner). */
export function jobLabel(kind: JobKind): string {
  const labels: Record<JobKind, string> = {
    boards: "Generating storyboard frames",
    boardRecheck: "Fetching a storyboard frame",
    frameNode: "Generating a node frame",
    editNode: "Editing a frame",
    upscale: "Upscaling a frame",
    cameraGrid: "Generating a camera grid",
    video: "Generating a video",
    videoNode: "Generating a video (node graph)",
    editVideoNode: "Editing a video (node graph)",
    sequenceVideo: "Generating a sequence video",
    sequenceEditVideo: "Editing a sequence video",
    recheckVideo: "Fetching a video",
    tweenBlock: "Generating an in-between clip",
    stitch: "Stitching in-between clips",
    unstitch: "Unstitching in-between clips",
    styleFrame: "Generating a style frame",
    recheckStyleFrame: "Fetching a style frame",
    referenceImage: "Generating a reference image",
    characterSheet: "Generating a character sheet",
    magicPrompts: "Writing Magic Prompts",
    suite: "Generating (Image Suite)",
    "3d": "Generating a 3D model",
  };
  return labels[kind];
}
