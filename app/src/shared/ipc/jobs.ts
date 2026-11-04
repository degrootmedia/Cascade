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
  | "fetchVideos"
  | "tweenBlock"
  | "stitch"
  | "unstitch"
  | "styleFrame"
  | "recheckStyleFrame"
  | "referenceImage"
  | "characterSheet"
  | "magicPrompts"
  | "proxies"
  | "assemblyRender"
  | "suite";

/** Lifecycle: queued -> submitting -> running -> fetching -> succeeded.
 *  `failed`, `cancelled` and `succeeded` are final; `interrupted` stays until
 *  the user's explicit Retry. The original four names keep their meaning. */
export type JobState = "queued" | "submitting" | "running" | "fetching" | "succeeded" | "failed" | "cancelled" | "interrupted";

/** States that still occupy the queue (not final, not interrupted). */
export const ACTIVE_JOB_STATES: readonly JobState[] = ["queued", "submitting", "running", "fetching"];
export const isActiveJobState = (s: JobState): boolean => ACTIVE_JOB_STATES.includes(s);
/** Final states: never picked up again by recovery. */
export const isFinalJobState = (s: JobState): boolean => s === "succeeded" || s === "failed" || s === "cancelled";

/** Plain-language label for the queue panel (UI layer only; internal names unchanged). */
export function jobStateLabel(s: JobState): string {
  const labels: Record<JobState, string> = {
    queued: "Queued", submitting: "Generating", running: "Generating", fetching: "Fetching",
    succeeded: "Done", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted",
  };
  return labels[s];
}

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
  /** The failure reason when `state === "failed"`, or why it was interrupted. */
  error?: string;
  provider?: string;
  model?: string;
  /** Replayable snapshot of the generation request (the IPC args after the
   *  production id), used by Retry. JSON-serializable. */
  settings?: unknown;
  /** The provider's task id, stored the moment the provider accepts the job.
   *  Once set, the job is tracked by it and never submitted again. */
  taskId?: string;
  /** Provider-reported progress 0-100, when it reports one. */
  progress?: number;
  /** Where the job came from (UI door or chat agent). */
  origin?: "ui" | "agent";
  /** The IPC channel that started this job — lets the queue panel retry it. */
  channel?: string;
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
    if (!isActiveJobState(job.state)) continue;
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
    "production:fetchPendingVideos": "fetchVideos",
    "production:generateTweenBlock": "tweenBlock",
    "production:stitchTween": "stitch",
    "production:unstitchTween": "unstitch",
    "production:generateStyleFrame": "styleFrame",
    "production:recheckStyleFrame": "recheckStyleFrame",
    "production:generateReferenceImage": "referenceImage",
    "production:generateCharacterSheet": "characterSheet",
    "production:generateMagicPrompts": "magicPrompts",
    "production:generateProxies": "proxies",
    "production:assemblyRender": "assemblyRender",
    "production:regenerateMagicPrompt": "magicPrompts",
    "suite:generate": "suite",
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

/** The scheduler's per-target serialization key — the same keys the renderer
 *  `genKeys` used, so "one job per target at a time" now lives in main.
 *  Null = no per-target serialization (videos, storyboard batches, ... stay
 *  concurrent exactly as before). args[0] is the production id. */
export function jobTargetKey(kind: JobKind, args: unknown[]): string | null {
  const prod = String(args[0] ?? "");
  const a1 = typeof args[1] === "string" && args[1] ? args[1] : "";
  const o = args[2] && typeof args[2] === "object" && !Array.isArray(args[2]) ? (args[2] as Record<string, unknown>) : {};
  const nodeId = typeof o.nodeId === "string" ? o.nodeId : "";
  switch (kind) {
    case "frameNode":
    case "boardRecheck":
      return a1 ? `image:${a1}` : null;
    case "editNode":
      return a1 ? `edit:${a1}:${nodeId}` : null;
    case "cameraGrid":
      return a1 ? `camgrid:${a1}` : null;
    case "upscale":
      return a1 ? `upscale:${a1}` : null;
    case "suite":
      return `suite:${prod}`;
    case "proxies":
      return `proxies:${prod}`;
    case "assemblyRender":
      return `render:${prod}`;
    case "referenceImage":
      return `ref:${prod}`;
    case "characterSheet":
      return `char:${a1 || "new"}`;
    case "styleFrame":
      return a1 ? `style:${a1}` : null;
    default:
      return null;
  }
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
    fetchVideos: "Fetching pending videos",
    tweenBlock: "Generating an in-between clip",
    stitch: "Stitching in-between clips",
    unstitch: "Unstitching in-between clips",
    styleFrame: "Generating a style frame",
    recheckStyleFrame: "Fetching a style frame",
    referenceImage: "Generating a reference image",
    characterSheet: "Generating a character sheet",
    magicPrompts: "Writing Magic Prompts",
    proxies: "Generating preview proxies",
    assemblyRender: "Rendering animatic to MP4",
    suite: "Generating (Image Suite)",
  };
  return labels[kind];
}

/** Header-button summary of a production's queue. Pure.
 *  `fraction` is overall progress across the active jobs plus the recently
 *  succeeded ones (0-1); null when nothing is active. A job without a
 *  provider-reported progress counts as 0 until it finishes. */
export interface QueueSummary {
  active: number;
  queued: number;
  needsAttention: number;
  fraction: number | null;
}
export function queueSummary(jobs: JobRecord[]): QueueSummary {
  const active = jobs.filter((j) => isActiveJobState(j.state));
  const done = jobs.filter((j) => j.state === "succeeded").length;
  const partial = active.reduce((n, j) => n + Math.min(100, Math.max(0, j.progress ?? 0)) / 100, 0);
  const total = active.length + done;
  return {
    active: active.length,
    queued: active.filter((j) => j.state === "queued").length,
    needsAttention: jobs.filter((j) => j.state === "failed" || j.state === "interrupted").length,
    fraction: active.length === 0 || total === 0 ? null : (done + partial) / total,
  };
}
