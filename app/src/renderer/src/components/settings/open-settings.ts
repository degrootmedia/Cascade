/**
 * Renderer-side entry points for opening Settings on a specific section.
 * Features call `openSettings("providers")`; the app listens for the event and
 * mounts the panel, which consumes the requested section on mount. Deep links
 * (`#settings/<sectionId>`) are parsed from the hash too, so a link works on a
 * cold load.
 */
export const OPEN_SETTINGS_EVENT = "cascade:open-settings";

let pendingSection: string | undefined;

/** Ask the app to open Settings, optionally focused on `sectionId`. */
export function openSettings(sectionId?: string): void {
  pendingSection = sectionId;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: sectionId }));
}

/** Consume the section requested by the most recent `openSettings` call. */
export function consumePendingSettingsSection(): string | undefined {
  const section = pendingSection;
  pendingSection = undefined;
  return section;
}

/** Parse a `#settings/<id>` deep link, if present. */
export function sectionFromHash(hash: string): string | undefined {
  const m = /^#settings\/([a-z0-9-]+)/i.exec(hash);
  return m ? m[1] : undefined;
}
