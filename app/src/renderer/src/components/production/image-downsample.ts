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
  if (!isOverImageImportLimit(file.size)) return readFileAsDataUrl(file);
  const convert = await confirmDestructive({
    title: OVERSIZE_IMAGE_MESSAGE,
    confirmLabel: OVERSIZE_IMAGE_CONVERT_LABEL,
    danger: false,
  });
  if (!convert) return null;
  const dataUrl = await readFileAsDataUrl(file);
  return window.cascade.downsampleImage(dataUrl);
}
