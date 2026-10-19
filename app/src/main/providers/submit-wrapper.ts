/**
 * submit-wrapper — one choke point every media provider routes through.
 *
 * Assembles prompt order (canonical), normalizes refs (native resolution —
 * a user-approved 720p copy is the only downscale, never an implicit one),
 * cites refs, logs in Dev Mode, and enforces dry-run before any spend.
 * Provider-specific code only maps normalized inputs to its transport.
 */
import { citePrompt } from "./refs.js";
import { DryRunError, logSubmission, type RefRecord, type SubmissionRecord } from "../submission-log.js";

export interface NormalizedRef {
  name: string;
  dataUrl: string;
  role: RefRecord["role"];
  downscaled: boolean;
  /** Whether the source ref was a video before any downscale (kept on the ref
   *  itself so downstream metadata never re-derives it by name). */
  isVideo: boolean;
}

export interface SubmissionInput {
  productionId?: string;
  providerId: string;
  transport: string;
  kind: SubmissionRecord["kind"];
  modelId: string;
  prompt: string;
  aspect?: string;
  resolution?: string;
  durationSec?: number;
  startFrame?: string;
  endFrame?: string;
  refs: { name: string; dataUrl: string; role?: RefRecord["role"] }[];
  params?: Record<string, unknown>;
}

export interface SubmissionDeps {
  logsDir: () => string;
  devMode: () => boolean;
  dryRun: () => boolean;
}

function isVideoDataUrl(dataUrl: string): boolean {
  return /^data:video\//i.test(dataUrl);
}

function redactSource(dataUrl: string): string {
  const m = /^data:([^;,]+)/.exec(dataUrl);
  if (m) return `data:${m[1]}`;
  return dataUrl.slice(0, 120);
}

/** Pass every ref through at native resolution, tagging which are video.
 *  Downscaling is never implicit: the only 720p copy is the user-approved
 *  duplicate reference (see create720pReference in pipeline.ts). */
export async function normalizeRefs(
  refs: SubmissionInput["refs"]
): Promise<NormalizedRef[]> {
  return refs.map((r) => ({
    name: r.name,
    dataUrl: r.dataUrl,
    role: r.role ?? "reference",
    downscaled: false,
    isVideo: isVideoDataUrl(r.dataUrl),
  }));
}

export interface PreparedSubmission {
  prompt: string;
  refs: NormalizedRef[];
  record: SubmissionRecord;
}

/**
 * Normalize refs, cite them into the prompt, log (Dev Mode), then dry-run
 * guard. Returns the cited prompt + normalized refs for the provider to map
 * to its transport. Throws DryRunError before the caller may spend credits.
 */
export async function prepareSubmission(
  deps: SubmissionDeps,
  input: SubmissionInput
): Promise<PreparedSubmission> {
  const refs = await normalizeRefs(input.refs);
  const submitted: (string | null)[] = refs.map((r) => r.dataUrl);
  const prompt = citePrompt(input.prompt, refs, submitted);
  const record: SubmissionRecord = {
    ts: new Date().toISOString(),
    providerId: input.providerId,
    transport: input.transport,
    kind: input.kind,
    modelId: input.modelId,
    prompt,
    aspect: input.aspect,
    resolution: input.resolution,
    durationSec: input.durationSec,
    startFrame: input.startFrame,
    endFrame: input.endFrame,
    refs: refs.map((r) => ({
      name: r.name,
      role: r.role,
      media: r.isVideo ? ("video" as const) : ("image" as const),
      source: redactSource(r.dataUrl),
      bytes: r.dataUrl.length,
      downscaled: r.isVideo ? r.downscaled : undefined,
    })),
    params: input.params ?? {},
  };
  logSubmission({ logsDir: deps.logsDir, devMode: deps.devMode }, record);
  if (deps.devMode() && deps.dryRun()) throw new DryRunError();
  return { prompt, refs, record };
}
