/**
 * The image-import size limit shared by every import surface: the native
 * picker (main), the renderer's drop/paste guards, and the oversize
 * "convert to JPEG" offer both sides show. One home so the limit and the
 * popup wording can never drift between surfaces.
 */

/** Images larger than this are offered a JPEG downsample instead of importing as-is. */
export const IMAGE_IMPORT_LIMIT_BYTES = 15 * 1024 * 1024;

/** True when a byte count exceeds the import limit. */
export function isOverImageImportLimit(byteCount: number): boolean {
  return byteCount > IMAGE_IMPORT_LIMIT_BYTES;
}

/** The oversize popup's message (native picker dialog + renderer confirm). */
export const OVERSIZE_IMAGE_MESSAGE = "This image is over the 15MB import limit. Convert it to JPEG to shrink it below 15MB?";

/** The oversize popup's confirm button (its cancel button is "Cancel"). */
export const OVERSIZE_IMAGE_CONVERT_LABEL = "Convert to JPEG";
