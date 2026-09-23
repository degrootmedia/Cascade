/**
 * Thumbnail URL helper shared by every surface that lists references (the node
 * graph side shelf, the Image Suite rail, and the Reference Moodboard). The
 * cascade-media protocol serves a small compressed JPEG for `?thumb=1`, so a
 * list never pulls full-resolution reference files just to draw its tiles.
 * Legacy inline data URLs are already in-memory and pass through unchanged.
 */
export function refThumbUrl(artwork: string): string {
  if (artwork.startsWith("cascade-media://")) {
    return `${artwork}${artwork.includes("?") ? "&" : "?"}thumb=1`;
  }
  return artwork;
}
