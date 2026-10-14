/**
 * Canonical media-menu wording and order, shared by the native menu (main)
 * and both renderer menus so the same take offers the same actions with
 * the same labels everywhere. A surface omits only the actions it cannot
 * perform; it never renames or reorders them.
 */
export const MEDIA_MENU_ORDER = [
  "save",
  "copy",
  "editExternal",
  "openFolder",
  "saveAsReference",
  "editInSuite",
  "refresh",
  "delete",
] as const;

export type MediaMenuAction = (typeof MEDIA_MENU_ORDER)[number];

export const MEDIA_MENU_LABELS = {
  saveImageAs: "Save image as…",
  saveVideoAs: "Save video as…",
  copyImage: "Copy image",
  openFolder: "Open file folder",
  saveAsReference: "Save as reference",
  editInSuite: "Edit in Suite",
  refreshImage: "Refresh image",
  refreshClip: "Refresh clip",
  deleteGeneration: "Delete generation…",
} as const;
