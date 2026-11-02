import type { UiIconSet, UiTheme } from "../../shared/ipc.js";

/** Apply the chosen accent color to the CSS variable (live, no restart). */
export function applyAccent(hex: string) {
  document.documentElement.style.setProperty("--accent", hex);
}

export const THEME_STORAGE_KEY = "cascade-theme";
export const DEFAULT_THEME: UiTheme = "dark";

/** Coerce any stored/IPC value to a known theme (unknown = dark default). */
export function normalizeTheme(value: unknown): UiTheme {
  return value === "light" || value === "graphite" ? value : "dark";
}

/**
 * Apply a theme live (no restart): the token sets in styles.css key off
 * `data-theme` on <html>. Also mirror it to localStorage so the next boot
 * (main window or detached canvas) can paint the right theme before the
 * settings IPC round-trip lands — main-process settings stay authoritative.
 */
export function applyTheme(theme: UiTheme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch { /* storage unavailable (tests) — the attribute still applies */ }
}

/** The theme cached by the last `applyTheme`, for pre-paint boot. */
export function readCachedTheme(): UiTheme {
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export const ICON_SET_STORAGE_KEY = "cascade-icon-set";
export const DEFAULT_ICON_SET: UiIconSet = "colorful";

/** Coerce any stored/IPC value to a known icon set (unknown = colorful). */
export function normalizeIconSet(value: unknown): UiIconSet {
  return value === "minimal" ? "minimal" : "colorful";
}

// The icon components (components/icons.tsx) subscribe to this store so a
// set change re-renders every mounted icon in place — no remount, no restart.
let currentIconSet: UiIconSet = DEFAULT_ICON_SET;
const iconSetListeners = new Set<() => void>();

/** Current icon set, for `useSyncExternalStore` in the icon components. */
export function getIconSetSnapshot(): UiIconSet {
  return currentIconSet;
}

/** Subscribe to icon-set changes; returns the unsubscribe function. */
export function subscribeIconSet(cb: () => void): () => void {
  iconSetListeners.add(cb);
  return () => { iconSetListeners.delete(cb); };
}

/**
 * Apply an icon set live (no restart): `data-icon-set` on <html> for CSS,
 * the localStorage boot cache (same contract as the theme), and a store
 * notification so mounted icons swap artwork immediately.
 */
export function applyIconSet(iconSet: UiIconSet) {
  document.documentElement.dataset.iconSet = iconSet;
  try {
    localStorage.setItem(ICON_SET_STORAGE_KEY, iconSet);
  } catch { /* storage unavailable (tests) — the attribute still applies */ }
  if (iconSet !== currentIconSet) {
    currentIconSet = iconSet;
    for (const cb of [...iconSetListeners]) cb();
  }
}

/** The icon set cached by the last `applyIconSet`, for pre-paint boot. */
export function readCachedIconSet(): UiIconSet {
  try {
    return normalizeIconSet(localStorage.getItem(ICON_SET_STORAGE_KEY));
  } catch {
    return DEFAULT_ICON_SET;
  }
}
