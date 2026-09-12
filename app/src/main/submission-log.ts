/**
 * submission-log — Dev Mode human-readable generation submission log.
 *
 * Pure formatting + file append. Main-process only (uses userData path via
 * injected dir resolver so tests can redirect). Never logs API keys/tokens.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface RefRecord {
  name: string;
  role: "character" | "product" | "reference" | "style";
  media: "image" | "video";
  /** Redacted source descriptor (e.g. "disk:boards/0100/…" or "data:image/…"). Never raw bytes. */
  source: string;
  bytes: number;
  downscaled?: boolean;
  height?: number;
}

export interface SubmissionRecord {
  ts: string;
  providerId: string;
  transport: string;
  kind: "image" | "video" | "tween";
  modelId: string;
  prompt: string;
  aspect?: string;
  resolution?: string;
  durationSec?: number;
  startFrame?: string;
  endFrame?: string;
  refs: RefRecord[];
  params: Record<string, unknown>;
}

/** Sentinel thrown in dry-run mode before any vendor call / spend. */
export class DryRunError extends Error {
  constructor(message = "Dry run — submission built and logged, no vendor call made.") {
    super(message);
    this.name = "DryRunError";
  }
}

/** Strip anything that looks like a secret from params before logging. */
export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (/api[_-]?key|token|secret|auth|bearer|key$/i.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    if (typeof v === "string" && v.length > 2000) {
      out[k] = `${v.slice(0, 200)}…[${v.length} chars]`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function refSource(source: string): string {
  // Never persist data-URL bytes — keep only the media prefix.
  const m = /^data:([^;,]+)/.exec(source);
  if (m) return `${m[1]} (inline)`;
  return source;
}

export function renderSubmissionMarkdown(r: SubmissionRecord): string {
  const lines: string[] = [
    `## ${r.ts} — ${r.providerId} / ${r.modelId} (${r.kind})`,
    ``,
    `- transport: ${r.transport}`,
    `- prompt: ${r.prompt.slice(0, 2000)}`,
  ];
  if (r.aspect) lines.push(`- aspect: ${r.aspect}`);
  if (r.resolution) lines.push(`- resolution: ${r.resolution}`);
  if (r.durationSec !== undefined) lines.push(`- durationSec: ${r.durationSec}`);
  if (r.startFrame) lines.push(`- startFrame: ${r.startFrame}`);
  if (r.endFrame) lines.push(`- endFrame: ${r.endFrame}`);
  lines.push(`- refs (${r.refs.length}):`);
  for (const ref of r.refs) {
    lines.push(
      `  - ${ref.name} [${ref.role}/${ref.media}] ${refSource(ref.source)} bytes=${ref.bytes}` +
        (ref.downscaled !== undefined ? ` downscaled=${ref.downscaled}` : "") +
        (ref.height !== undefined ? ` height=${ref.height}` : "")
    );
  }
  lines.push(`- params: ${JSON.stringify(redactParams(r.params))}`);
  lines.push(``);
  return lines.join("\n");
}

export interface SubmissionLogDeps {
  /** Resolve the production logs dir (userData/logs/... or a test tmp dir). */
  logsDir: () => string;
  /** Whether Dev Mode is on. Injected so tests don't touch Electron. */
  devMode: () => boolean;
}

export function logSubmission(deps: SubmissionLogDeps, record: SubmissionRecord): void {
  if (!deps.devMode()) return;
  const dir = deps.logsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "submissions.md"), renderSubmissionMarkdown(record), "utf8");
  fs.appendFileSync(
    path.join(dir, "submissions.jsonl"),
    JSON.stringify({ ...record, params: redactParams(record.params) }) + "\n",
    "utf8"
  );
}
