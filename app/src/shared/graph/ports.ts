/**
 * The single port-declaration table for the shot graph (master plan step 03).
 *
 * Every node kind declares its input/output ports with a media type; media is
 * declared here, never inferred from a label or prompt text. Both the
 * connection validator (`canConnect`) and the renderer's handles read this
 * table — there is exactly one, replacing the two duplicated socket lists and
 * the `"ref" | "style" | "brand"` kind union in NodeGraphModal.
 *
 * `canConnect` is type-level validation only. Existence and capacity rules
 * (the ref exists and has artwork, tween slots < 5, edit-chain cycle check,
 * editprompt↔editgen id pairing) are caller-side: they need live shot/
 * production state, not types. Callers must enforce them; see isValidConnection
 * in NodeGraphModal for the current call-site checklist.
 */
import type { GraphMedia, GraphNodeKind, GraphPort } from "../ipc.js";

export interface PortDecl extends GraphPort {
  /** Accepted media when a sink takes more than its nominal `media`. */
  accepts?: GraphMedia[];
  /** Source node kinds allowed on this sink. Absent = any kind with compat media. */
  from?: GraphNodeKind[];
}

export interface NodeDecl {
  kind: GraphNodeKind;
  inputs: PortDecl[];
  outputs: PortDecl[];
}

/** Reference sockets are positional (`in-ref-0…N` + always-open `in-ref-open`);
 *  tween keyframe sockets are `in-tween-0…4`. */
export const REF_SOCKET_RE = /^in-ref-(\d+)$/;
export const TWEEN_SOCKET_RE = /^in-tween-(\d+)$/;
export const MAX_TWEEN_SOCKETS = 5;

const promptInputs: PortDecl[] = [
  { id: "in-style", label: "Style", media: "text", from: ["style"] },
  { id: "in-ref-open", label: "Reference (open)", media: "image", accepts: ["image", "video", "audio"] },
  { id: "in-brand", label: "Brand", media: "text", from: ["brand"] },
];

const TABLE: Record<GraphNodeKind, NodeDecl> = {
  composer: {
    kind: "composer",
    inputs: promptInputs,
    outputs: [{ id: "out", label: "Prompt", media: "text" }],
  },
  videoprompt: {
    kind: "videoprompt",
    inputs: promptInputs,
    outputs: [{ id: "out", label: "Prompt", media: "text" }],
  },
  editprompt: {
    kind: "editprompt",
    inputs: promptInputs,
    outputs: [{ id: "out", label: "Prompt", media: "text" }],
  },
  editvideoprompt: {
    kind: "editvideoprompt",
    inputs: promptInputs,
    outputs: [{ id: "out", label: "Prompt", media: "text" }],
  },
  style: {
    kind: "style",
    inputs: [],
    outputs: [{ id: "out", label: "Style", media: "text" }],
  },
  brand: {
    kind: "brand",
    inputs: [],
    outputs: [{ id: "out", label: "Brand", media: "text" }],
  },
  imagegen: {
    kind: "imagegen",
    inputs: [{ id: "in-prompt", label: "Prompt", media: "text", from: ["composer"] }],
    outputs: [{ id: "out", label: "Image", media: "image" }],
  },
  videogen: {
    kind: "videogen",
    inputs: [
      { id: "in-prompt", label: "Prompt", media: "text", from: ["videoprompt"] },
      { id: "in-image", label: "Source frame", media: "image", accepts: ["image", "video"], from: ["imagegen", "editgen", "ref"] },
    ],
    outputs: [{ id: "out", label: "Clip", media: "video" }],
  },
  editgen: {
    kind: "editgen",
    inputs: [
      { id: "in-prompt", label: "Prompt", media: "text", from: ["editprompt"] },
      { id: "in-image", label: "Source image", media: "image", accepts: ["image", "video"], from: ["imagegen", "editgen", "ref"] },
    ],
    outputs: [{ id: "out", label: "Edit", media: "image" }],
  },
  editvideo: {
    kind: "editvideo",
    inputs: [
      { id: "in-prompt", label: "Prompt", media: "text", from: ["editvideoprompt"] },
      { id: "in-video", label: "Source video", media: "video", from: ["videogen", "ref"] },
    ],
    outputs: [{ id: "out", label: "Edit", media: "video" }],
  },
  tween: {
    kind: "tween",
    inputs: [0, 1, 2, 3, 4].map((i) => ({
      id: `in-tween-${i}`,
      label: `Keyframe ${i + 1}`,
      media: "image" as GraphMedia,
      from: ["imagegen", "editgen", "ref"] as GraphNodeKind[],
    })),
    outputs: [{ id: "out", label: "Clip", media: "video" }],
  },
  ref: {
    kind: "ref",
    inputs: [],
    // Media is dynamic per reference (image, or video/audio for dropped
    // files); the caller resolves it via refOutputMedia and passes it in.
    outputs: [{ id: "out", label: "Reference", media: "image" }],
  },
  output: {
    kind: "output",
    inputs: [{ id: "in-out", label: "Output", media: "image", accepts: ["image", "video"] }],
    outputs: [],
  },
  cameraGrid: {
    // A generator node: a source image plus reference sockets feed a 4x4 sheet
    // generation. It has no output (its panels are marqueed out as references).
    // The grid-image socket takes an already-made sheet to cut up (manual
    // fallback), bypassing generation.
    kind: "cameraGrid",
    inputs: [
      { id: "in-image", label: "Source image", media: "image", from: ["imagegen", "editgen", "ref"] },
      { id: "in-grid", label: "Grid image", media: "image", from: ["imagegen", "editgen", "ref"] },
      { id: "in-ref-open", label: "Reference (open)", media: "image", accepts: ["image"] },
    ],
    outputs: [],
  },
  upscale: {
    // A generator node: one source image in, one upscaled image out (feeds the
    // output node; the shot's frame becomes the upscaled result).
    kind: "upscale",
    inputs: [{ id: "in-image", label: "Source image", media: "image", from: ["imagegen", "editgen", "ref"] }],
    outputs: [{ id: "out", label: "Image", media: "image" }],
  },
};

export function nodeDecl(kind: GraphNodeKind): NodeDecl | undefined {
  return TABLE[kind];
}

/** Look up a port declaration, expanding the positional socket patterns
 *  (`in-ref-N` behaves as the open reference socket; `in-tween-N` as declared). */
export function portDecl(kind: GraphNodeKind, dir: "in" | "out", portId: string): PortDecl | undefined {
  const decl = TABLE[kind];
  if (!decl) return undefined;
  const list = dir === "in" ? decl.inputs : decl.outputs;
  const direct = list.find((p) => p.id === portId);
  if (direct) return direct;
  if (dir === "in" && REF_SOCKET_RE.test(portId)) {
    return list.find((p) => p.id === "in-ref-open");
  }
  return undefined;
}

/** Minimal reference shape the graph needs: identity, media kind, artwork presence. */
export interface RefMediaView {
  id: string;
  /** Dropped video/audio files carry media; absent = image. */
  media?: "video" | "audio";
  /** Image artwork present (data URL or disk path). */
  artwork?: string;
}

/** Resolve a reference node's output media: image by default, video/audio for
 *  dropped media files. */
export function refOutputMedia(ref: RefMediaView | undefined): GraphMedia {
  if (!ref) return "image";
  if (ref.media === "video") return "video";
  if (ref.media === "audio") return "audio";
  return "image";
}

export interface ConnectEndpoint {
  kind: GraphNodeKind;
  port: string;
  /** Source media. For `ref` nodes the caller resolves it via refOutputMedia. */
  media: GraphMedia;
}

/**
 * Type-level connection validation against the port table. Checks the sink
 * exists, the source kind is allowed on it, and the media is accepted.
 * Returns false (never throws) for unknown kinds/ports.
 */
export function canConnect(from: ConnectEndpoint, to: { kind: GraphNodeKind; port: string }): boolean {
  if (from.kind === to.kind && from.port === to.port) return false;
  const sink = portDecl(to.kind, "in", to.port);
  if (!sink) return false;
  const source = portDecl(from.kind, "out", from.port);
  if (!source) return false;
  if (sink.from && !sink.from.includes(from.kind)) return false;
  const accepted = sink.accepts ?? [sink.media];
  if (!accepted.includes(from.media)) return false;
  return true;
}
