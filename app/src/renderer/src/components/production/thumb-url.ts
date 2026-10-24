/**
 * Thumbnail URL helper shared by every surface that lists references (the node
 * graph side shelf, the Image Suite rail, and the Reference Moodboard). The
 * cascade-media protocol serves a small compressed JPEG for `?thumb=1`, so a
 * list never pulls full-resolution reference files just to draw its tiles.
 * Legacy inline data URLs are already in-memory and pass through unchanged.
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
