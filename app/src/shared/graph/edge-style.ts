/**
 * Edge appearance by media type — the single mapping the canvas reads.
 * Color encodes the type (line style separates the neutral bucket): image is a
 * solid blue, video is a solid fuchsia, everything else (text, audio,
 * unresolved) is a neutral dotted gray.
 *
 * The media comes from the existing pipe resolution — the port table's
 * declared output media for the source kind, or `refOutputMedia` for
 * reference nodes — never from parallel bookkeeping.
 */
import type { GraphMedia } from "../ipc.js";

export type EdgeMediaKind = "image" | "video" | "other";

export const EDGE_MEDIA_STYLES: Record<EdgeMediaKind, { stroke: string; strokeDasharray?: string }> = {
  image: { stroke: "#3b82c4" },
  video: { stroke: "#d946ef" },
  other: { stroke: "#8a8f98", strokeDasharray: "2 4" },
};

export function edgeMediaKind(media: GraphMedia | undefined | null): EdgeMediaKind {
  if (media === "image") return "image";
  if (media === "video") return "video";
  return "other";
}

export function edgeMediaStyle(media: GraphMedia | undefined | null): { stroke: string; strokeDasharray?: string } {
  return EDGE_MEDIA_STYLES[edgeMediaKind(media)];
}
