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

/** Everything a "Copy image" action can be handed about its target. The
 *  source fields identify the actual image; `x`/`y` are page coords kept
 *  only as a last-resort hit-test fallback. */
export interface CopyImageTarget {
  productionId?: string;
  relPath?: string;
  dataUrl?: string;
  src?: string;
  x?: number;
  y?: number;
}

/** Where "Copy image" should get its pixels from, in preference order.
 *  Copying must use the target's own source — hit-testing the page at the
 *  click point (`copyImageAt`) breaks whenever anything (e.g. the open
 *  context menu itself) still covers that point, so coords are only the
 *  fallback for sources main cannot decode (blob:, file:, …). */
export type CopyImageSource =
  | { kind: "file"; file: ProductionFileRef }
  | { kind: "dataUrl"; dataUrl: string }
  | { kind: "url"; url: string }
  | { kind: "coords"; x: number; y: number }
  | { kind: "none" };

export function classifyCopyImageSource(target: CopyImageTarget): CopyImageSource {
  const file = resolveProductionFile(target);
  if (file) return { kind: "file", file };
  const dataUrl = target.dataUrl ?? (typeof target.src === "string" && target.src.startsWith("data:image/") ? target.src : undefined);
  if (dataUrl) return { kind: "dataUrl", dataUrl };
  if (typeof target.src === "string" && /^https?:\/\//.test(target.src)) return { kind: "url", url: target.src };
  if (typeof target.x === "number" && typeof target.y === "number") return { kind: "coords", x: target.x, y: target.y };
  return { kind: "none" };
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
