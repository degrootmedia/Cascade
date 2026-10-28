/**
 * 720p-retry inventory + eligibility (manual oversize recovery).
 *
 * Video references upload at native resolution. When a video generation
 * fails, the IPC handlers ask this module which of the submission's video
 * inputs were oversize (>720p) saved references — those become the
 * one-click "create a 720p copy & retry" offer on the production log.
 * Nothing here inspects vendor error text: eligibility is purely
 * structural (an oversize reference was attached, no job is still pending,
 * the transport can carry video references at all), and the user decides.
 *
 * Only handler-visible inputs are inventoried: node refIds, prompt
 * @[name] tags, and an edit node's source reference. Style-tagged refs
 * are deliberately excluded — they never upload, so no swap applies.
 * Pure node apart from the injected probe seam.
 */
import type { CustomRef, Production, RefSwap, Retry720pAction } from "../shared/ipc.js";
import { refTagMatches, renameRefTag } from "../shared/prompt-grammar.js";
import { assetPath } from "./pipeline.js";
import { styleRefNames } from "./providers/refs.js";
import { VIDEO_REF_MAX_HEIGHT } from "./video-ref.js";

/** One saved video reference taking part in a submission. */
export interface VideoInputRef {
  refId: string;
  name: string;
  /** Workspace-relative media file (the reference's mediaPath). */
  relPath: string;
}

/** A VideoInputRef with its probed pixel height (null when unreadable). */
export interface ProbedVideoInput extends VideoInputRef {
  height: number | null;
}

function isVideoRef(r: CustomRef): r is CustomRef & { mediaPath: string } {
  return r.media === "video" && typeof r.mediaPath === "string" && r.mediaPath.length > 0;
}

/** Video references eligible for a 720p duplicate: saved video refs that are
 *  not style-tagged refs (effective purpose `style`). */
function eligibleVideoRefs(p: Production): (CustomRef & { mediaPath: string })[] {
  const styles = styleRefNames(p);
  return (p.references ?? []).filter(
    (r): r is CustomRef & { mediaPath: string } => isVideoRef(r) && !styles.has(r.name.toLowerCase())
  );
}

function toInput(r: CustomRef & { mediaPath: string }): VideoInputRef {
  return { refId: r.id, name: r.name, relPath: r.mediaPath };
}

function dedupe(inputs: VideoInputRef[]): VideoInputRef[] {
  const seen = new Set<string>();
  return inputs.filter((i) => (seen.has(i.refId) ? false : (seen.add(i.refId), true)));
}

/** Merge inventory lists from several channels (ids + tags + source),
 *  one entry per reference. */
export function unionVideoInputs(...lists: VideoInputRef[][]): VideoInputRef[] {
  return dedupe(lists.flat());
}

/** A validated ref swap with both sides resolved against the production. */
export interface ResolvedRefSwap {
  fromId: string;
  fromName: string;
  fromPath?: string;
  toId: string;
  toName: string;
  toPath?: string;
}

/** Validate raw IPC ref swaps against the production's references. Entries
 *  naming unknown ids are dropped — a stale retry payload can never inject
 *  a reference that isn't in the library. */
export function resolveRefSwaps(p: Production, swaps: unknown): ResolvedRefSwap[] {
  if (!Array.isArray(swaps)) return [];
  const byId = new Map((p.references ?? []).map((r) => [r.id, r] as const));
  const out: ResolvedRefSwap[] = [];
  for (const s of swaps as RefSwap[]) {
    if (!s || typeof s.fromRefId !== "string" || typeof s.toRefId !== "string") continue;
    if (s.fromRefId === s.toRefId) continue;
    const from = byId.get(s.fromRefId);
    const to = byId.get(s.toRefId);
    if (!from || !to) continue;
    out.push({
      fromId: from.id,
      fromName: from.name,
      ...(from.mediaPath ? { fromPath: from.mediaPath } : {}),
      toId: to.id,
      toName: to.name,
      ...(to.mediaPath ? { toPath: to.mediaPath } : {}),
    });
  }
  return out;
}

/** Rewrite @[from] prompt tags to the swap targets for one submission. */
export function applyRefSwapsToPrompt(prompt: string, swaps: ResolvedRefSwap[]): string {
  let out = prompt;
  for (const s of swaps) out = renameRefTag(out, s.fromName, s.toName);
  return out;
}

/** Map explicit ref ids through the swaps (non-array input → empty). */
export function applyRefSwapsToIds(refIds: unknown, swaps: ResolvedRefSwap[]): string[] {
  if (!Array.isArray(refIds)) return [];
  const map = new Map(swaps.map((s) => [s.fromId, s.toId] as const));
  return refIds
    .filter((x): x is string => typeof x === "string")
    .map((id) => map.get(id) ?? id);
}

/** The submission's video references named by explicit ref ids (node
 *  sockets), in pool order. Unknown ids and non-video refs are skipped. */
export function videoRefsForIds(p: Production, refIds: unknown): VideoInputRef[] {
  if (!Array.isArray(refIds)) return [];
  const wanted = new Set(refIds.filter((x): x is string => typeof x === "string"));
  return dedupe(eligibleVideoRefs(p).filter((r) => wanted.has(r.id)).map(toInput));
}

/** The submission's video references cited by @[name] tags in the prompt —
 *  the classic surface's only reference channel. Name matching is
 *  case-insensitive, like every other tag resolution. */
export function videoRefsForPromptTags(p: Production, prompt: string): VideoInputRef[] {
  if (!prompt) return [];
  const names = new Set(refTagMatches(prompt).map((m) => m.name.toLowerCase()));
  if (!names.size) return [];
  return dedupe(eligibleVideoRefs(p).filter((r) => names.has(r.name.toLowerCase())).map(toInput));
}

/** The edit node's source when it is a saved video reference (explicit
 *  ref id, or a source path that is some video reference's file). A bare
 *  generated-take path has no reference to duplicate — excluded (v1). */
export function videoRefForEditSource(
  p: Production,
  source: { sourceRefId?: unknown; sourcePath?: unknown }
): VideoInputRef[] {
  const pool = eligibleVideoRefs(p);
  if (typeof source.sourceRefId === "string" && source.sourceRefId) {
    const hit = pool.find((r) => r.id === source.sourceRefId);
    if (hit) return [toInput(hit)];
  }
  if (typeof source.sourcePath === "string" && source.sourcePath) {
    const hit = pool.find((r) => r.mediaPath === source.sourcePath);
    if (hit) return [toInput(hit)];
  }
  return [];
}

/** Probe every inventoried input's height via the injected ffmpeg probe.
 *  An unreadable file keeps height null (never offered — we can't claim it
 *  is oversize). Probe failures are swallowed per-input for the same reason. */
export async function probeVideoInputs(
  p: Production,
  inputs: VideoInputRef[],
  probe: (absPath: string) => Promise<{ width: number; height: number } | null>
): Promise<ProbedVideoInput[]> {
  const out: ProbedVideoInput[] = [];
  for (const input of inputs) {
    let height: number | null = null;
    try {
      const size = await probe(assetPath(p, input.relPath));
      height = size ? size.height : null;
    } catch {
      height = null;
    }
    out.push({ ...input, height });
  }
  return out;
}

/**
 * The retry offer for a failed submission, or null when no offer applies:
 * a still-pending job belongs to Fetch/recheck, the OpenArt CLI can't carry
 * video references at any size, and only a proven-oversize input makes a
 * 720p copy a sensible next step.
 */
export function retry720pOffer(args: {
  inputs: ProbedVideoInput[];
  hasPending: boolean;
  providerId: string;
  shotId: string;
  nodeId?: string;
  surface: Retry720pAction["surface"];
  mayHaveBilled: boolean;
}): Retry720pAction | null {
  if (args.hasPending) return null;
  if (args.providerId === "openart-cli") return null;
  const refs = args.inputs
    .filter((i) => i.height !== null && i.height > VIDEO_REF_MAX_HEIGHT)
    .map((i) => ({ refId: i.refId, name: i.name, height: i.height as number }));
  if (!refs.length) return null;
  return {
    kind: "retry720p",
    shotId: args.shotId,
    ...(args.nodeId ? { nodeId: args.nodeId } : {}),
    surface: args.surface,
    refs,
    mayHaveBilled: args.mayHaveBilled,
  };
}
