/** Detached canvas window (Spec 03) — IPC types.
 *
 *  The node graph and the reference moodboard can be "popped out" into a second
 *  window the user can drag to another monitor. Exactly one detached window
 *  exists at a time; opening it again retargets the existing one. Main owns the
 *  context (production + target + selected frame) so a late-loading window gets
 *  the latest state on `did-finish-load`. */

/** Which canvas a detached window hosts. */
export type DetachedCanvasTarget = "graph" | "moodboard";

/** The context main pushes to the detached window (and tracks as "current"). */
export interface DetachedCanvasContext {
  productionId: string;
  target: DetachedCanvasTarget;
  /** The storyboard frame the detached graph follows (null = none selected). */
  frameId: string | null;
}

/** Snapshot of the detached window's state, returned by the window: channels. */
export interface DetachedCanvasState {
  open: boolean;
  productionId: string | null;
  target: DetachedCanvasTarget | null;
  frameId: string | null;
}

/** In-flight canvas jobs for one production, mirrored between the main and the
 *  detached window so "Generating…" survives the graph living in the other
 *  window. Each window publishes its own local sets; main relays them to the
 *  sibling (no shared job state — the window that started the job owns it). */
export interface CanvasBusySnapshot {
  productionId: string;
  /** Shot ids with an image / video / edit-video node generating. */
  image: string[];
  video: string[];
  editVideo: string[];
  /** `${shotId}:${nodeId}` for edit-image nodes. */
  editNodes: string[];
  /** shotId → in-flight block id for the in-betweener. */
  tween: Record<string, string>;
  /** Shot ids with a stitch/unstitch in flight. */
  stitching: string[];
}

/** Validate + sanitize an untrusted busy snapshot (main-side IPC boundary).
 *  Throws on a malformed shape so the generic IPC guard rejects it. */
export function normalizeCanvasBusy(value: unknown): CanvasBusySnapshot {
  if (!value || typeof value !== "object") throw new Error("canvas busy: snapshot must be an object");
  const o = value as Record<string, unknown>;
  if (typeof o.productionId !== "string" || o.productionId.length === 0 || o.productionId.length > 256) {
    throw new Error("canvas busy: productionId must be a non-empty string");
  }
  const strArray = (v: unknown, what: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new Error(`canvas busy: ${what} must be a string array`);
    }
    return (v as string[]).slice(0, 10000);
  };
  const tweenRaw = o.tween === undefined ? {} : o.tween;
  if (typeof tweenRaw !== "object" || tweenRaw === null || Array.isArray(tweenRaw)) {
    throw new Error("canvas busy: tween must be an object");
  }
  const tween: Record<string, string> = {};
  for (const [k, v] of Object.entries(tweenRaw as Record<string, unknown>)) {
    if (typeof v !== "string") throw new Error("canvas busy: tween values must be strings");
    tween[k] = v;
  }
  return {
    productionId: o.productionId,
    image: strArray(o.image, "image"),
    video: strArray(o.video, "video"),
    editVideo: strArray(o.editVideo, "editVideo"),
    editNodes: strArray(o.editNodes, "editNodes"),
    tween,
    stitching: strArray(o.stitching, "stitching"),
  };
}
