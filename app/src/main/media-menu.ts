/**
 * Media context-menu target resolution.
 *
 * The right-click menus (the native `context-menu` event, the renderer's
 * `image:showMenu`, and the storyboard panel's custom menu) all need to turn
 * whatever identifies an image/video — an explicit production file, or the
 * `cascade-media://<prodId>/<encodedRel>` URL a real disk asset is served from
 * — into a production id + workspace-relative path. Inline data URLs and
 * remote links have no file on disk, so the file-only items ("Edit
 * externally", "Open file folder") stay hidden for them. Kept pure so main and
 * the unit tests share one parser.
 */

/** A real production asset on disk: production id + workspace-relative path. */
export interface ProductionFileRef {
  productionId: string;
  relPath: string;
}

/** Resolve a media target to its production file, or null when it isn't one
 *  (inline data URL, remote link, or malformed cascade-media URL). */
export function resolveProductionFile(target: { productionId?: string; relPath?: string; src?: string }): ProductionFileRef | null {
  if (target.productionId && target.relPath) return { productionId: target.productionId, relPath: target.relPath };
  const src = target.src ?? "";
  if (src.startsWith("cascade-media://")) {
    try {
      const url = new URL(src);
      const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (url.hostname && relPath) return { productionId: url.hostname, relPath };
    } catch { /* not a usable URL — fall through */ }
  }
  return null;
}
