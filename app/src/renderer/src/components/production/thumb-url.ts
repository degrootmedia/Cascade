/**
 * Thumbnail URL helper shared by every surface that lists references (the node
 * graph side shelf, the Image Suite rail, and the Reference Moodboard). The
 * cascade-media protocol serves a small compressed JPEG for `?thumb=1`, so a
 * list never pulls full-resolution reference files just to draw its tiles.
 * Legacy inline data URLs are already in-memory and pass through unchanged.
 *
 * Also the one home for LOD tier math (`thumbTierFor`): the moodboard
 * paints the tier covering a node's settled on-screen size; the node graph
 * uses fixed tiers instead (see graph/lod.tsx — node media never needs
 * high res, the lightbox does). Serving-side tiers live in
 * main/thumbnails.ts and must stay in sync with THUMB_TIERS here.
 */
/** Thumbnail URL at one LOD tier (long edge px). The default/256 tier
 *  keeps the legacy `thumb=1` spelling so existing cache entries and URLs
 *  stay byte-identical; larger tiers (512/1024) spell the edge out. */
export function refThumbUrl(artwork: string, edge?: number): string {
  if (artwork.startsWith("cascade-media://")) {
    return `${artwork}${artwork.includes("?") ? "&" : "?"}thumb=${edge && edge !== 256 ? edge : 1}`;
  }
  return artwork;
}

/** Thumbnail long-edges the media protocol serves (see main/thumbnails.ts). */
export const THUMB_TIERS = [256, 512, 1024] as const;

/** LOD: the thumbnail long-edge a tile needs at a given zoom — the smallest
 *  tier covering its on-screen long edge (`max(w,h) * zoom * dpr`), or 0 for
 *  the full-resolution file when no tier is big enough. Zoomed out this keeps
 *  every visible tile's decoded bitmap near its painted size instead of
 *  natural size; zoomed in past the top tier the tile swaps back to the
 *  original file. Pure — the moodboard feeds it the *settled* zoom so a zoom
 *  gesture doesn't churn srcs mid-flight. */
export function thumbTierFor(boxW: number, boxH: number, zoom: number, dpr: number): number {
  const needed = Math.max(boxW, boxH) * Math.max(zoom, 0) * Math.max(dpr, 1);
  for (const tier of THUMB_TIERS) if (needed <= tier) return tier;
  return 0;
}
