import { isActiveJobState, type JobKind, type JobRecord } from "../../../../shared/ipc.js";

const VIDEO_KINDS: ReadonlySet<JobKind> = new Set<JobKind>([
  "video", "videoNode", "editVideoNode", "sequenceVideo", "sequenceEditVideo",
  "recheckVideo", "fetchVideos", "tweenBlock", "stitch", "unstitch",
]);

/** Image or video, for the row's type label and icon. */
export function jobMediaType(kind: JobKind): "image" | "video" {
  return VIDEO_KINDS.has(kind) ? "video" : "image";
}

/** "higgsfield-cli:kling-2" -> "Kling 2 (Higgsfield)"; plain ids are OpenArt. */
export function friendlyModel(job: Pick<JobRecord, "provider" | "model">): string {
  const model = job.model ?? "";
  const bare = model.replace(/^(higgsfield-cli|openart-cli):/, "");
  const nice = bare ? bare.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "";
  const prov =
    job.provider === "higgsfield-cli" || model.startsWith("higgsfield-cli:") ? "Higgsfield"
    : job.provider === "openart-cli" || job.provider === "openart" || model.startsWith("openart-cli:") ? "OpenArt"
    : "";
  if (nice && prov) return `${nice} (${prov})`;
  return nice || prov;
}

/** "42s", "3m 05s", "1h 02m". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** How long a job has been running (frozen at its finish time once done). */
export function jobElapsedMs(job: JobRecord, nowMs: number): number {
  const start = Date.parse(job.startedAt);
  if (Number.isNaN(start)) return 0;
  const end = !isActiveJobState(job.state) && job.finishedAt ? Date.parse(job.finishedAt) : nowMs;
  return Math.max(0, (Number.isNaN(end) ? nowMs : end) - start);
}

/** Footer summary: "2 generating, 1 queued, 1 failed". */
export function queueFooterText(jobs: JobRecord[]): string {
  const n = (f: (j: JobRecord) => boolean) => jobs.filter(f).length;
  const parts: string[] = [];
  const gen = n((j) => j.state === "submitting" || j.state === "running");
  const fetching = n((j) => j.state === "fetching");
  const queued = n((j) => j.state === "queued");
  const failed = n((j) => j.state === "failed");
  const interrupted = n((j) => j.state === "interrupted");
  const done = n((j) => j.state === "succeeded");
  if (gen) parts.push(`${gen} generating`);
  if (fetching) parts.push(`${fetching} fetching`);
  if (queued) parts.push(`${queued} queued`);
  if (failed) parts.push(`${failed} failed`);
  if (interrupted) parts.push(`${interrupted} interrupted`);
  if (done) parts.push(`${done} done`);
  return parts.length ? parts.join(", ") : "Nothing in the queue";
}

/** Ids "Clear finished" dismisses: Completed rows only. Failed (and
 *  interrupted/cancelled) rows stay until dismissed or retried. */
export function clearFinishedIds(jobs: JobRecord[]): string[] {
  return jobs.filter((j) => j.state === "succeeded").map((j) => j.id);
}

/** The "current run": every job seen since the queue last had zero active
 *  jobs. Returns the new run id set given the previous one. */
export function nextRunIds(prev: ReadonlySet<string>, jobs: JobRecord[]): Set<string> {
  const active = jobs.filter((j) => isActiveJobState(j.state));
  if (active.length === 0) return new Set();
  const next = new Set(prev);
  for (const j of jobs) if (isActiveJobState(j.state) || next.has(j.id)) next.add(j.id);
  return next;
}

export interface RunProgress {
  active: number;
  /** 0-1, null when nothing is active. */
  fraction: number | null;
  /** True while running jobs report no percentage (bar shimmers). */
  shimmer: boolean;
}

/** Total progress across the current run. If EVERY active job reports a
 *  percentage the bar is their average; otherwise it is the finished share of
 *  the run (completed + failed + cancelled out of all jobs in the run). */
export function runProgress(jobs: JobRecord[], runIds: ReadonlySet<string>): RunProgress {
  const active = jobs.filter((j) => isActiveJobState(j.state));
  if (active.length === 0) return { active: 0, fraction: null, shimmer: false };
  const allReport = active.every((j) => typeof j.progress === "number");
  if (allReport) {
    const avg = active.reduce((n, j) => n + (j.progress as number), 0) / active.length / 100;
    return { active: active.length, fraction: Math.min(1, Math.max(0, avg)), shimmer: false };
  }
  const inRun = jobs.filter((j) => runIds.has(j.id) || isActiveJobState(j.state));
  const finished = inRun.filter((j) => j.state === "succeeded" || j.state === "failed" || j.state === "cancelled").length;
  return { active: active.length, fraction: inRun.length ? finished / inRun.length : 0, shimmer: true };
}

/** Failed/interrupted jobs the user has not yet seen (panel not opened since). */
export function unseenProblemIds(jobs: JobRecord[], seen: ReadonlySet<string>): string[] {
  return jobs.filter((j) => (j.state === "failed" || j.state === "interrupted") && !seen.has(j.id)).map((j) => j.id);
}

/** Does opening this job land in the node view (vs the classic shot panel)? */
export function jobOpensNodeView(job: Pick<JobRecord, "kind" | "nodeId">): boolean {
  if (job.nodeId) return true;
  return ["frameNode", "editNode", "videoNode", "editVideoNode", "sequenceVideo", "sequenceEditVideo", "cameraGrid", "upscale", "tweenBlock", "stitch", "unstitch"].includes(job.kind);
}
