/**
 * Oversize image drops/pastes: an image File over the 15MB import limit is
 * offered a JPEG downsample (the shared popup) instead of being refused.
 * The conversion runs in main (`production:downsampleImage`); the dropped
 * File is only read — the original on disk is never modified, and the
 * converted data URL is what the caller imports. Under-limit files pass
 * through untouched (reader result unchanged, no popup).
 */
import { isOverImageImportLimit, OVERSIZE_IMAGE_MESSAGE, OVERSIZE_IMAGE_CONVERT_LABEL } from "../../../../shared/image-import.js";
import { confirmDestructive } from "../ConfirmDialog.js";

/** Read a File as a data URL (the import transport every drop path uses). */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Couldn't read the image."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the image."));
    reader.readAsDataURL(file);
  });
}

/**
 * A dropped/pasted image File → an importable data URL, or null when the
 * user cancels the oversize popup. Conversion failures throw (callers
 * surface them like any other import error).
 */
export async function importableImageDataUrl(file: File): Promise<string | null> {
  const pending = await beginImportableImageDataUrl(file);
  return pending ? pending.dataUrl : null;
}

/** An in-flight image materialization (see `beginImportableImageDataUrl`).
 *  Wrapped in an object because `await` would flatten a bare nested
 *  promise, forcing the caller to wait for the data immediately. */
export interface PendingImageDataUrl {
  dataUrl: Promise<string>;
}

/**
 * Begin materializing a dropped/pasted image File into an importable data
 * URL. The oversize consent (decidable from `file.size` alone) is asked up
 * front; the read — and, for oversize images, the downsample — then runs in
 * flight in the returned handle, so a caller can start it at paste time
 * and merely await readiness when the user confirms. Returns null when the
 * user declines the oversize conversion (an explicit cancel, before any
 * other UI). Read/conversion failures reject `dataUrl`.
 */
export async function beginImportableImageDataUrl(file: File): Promise<PendingImageDataUrl | null> {
  if (!isOverImageImportLimit(file.size)) return { dataUrl: readFileAsDataUrl(file) };
  const convert = await confirmDestructive({
    title: OVERSIZE_IMAGE_MESSAGE,
    confirmLabel: OVERSIZE_IMAGE_CONVERT_LABEL,
    danger: false,
  });
  if (!convert) return null;
  return { dataUrl: (async () => window.cascade.downsampleImage(await readFileAsDataUrl(file)))() };
}
