import type { UiTheme } from "../../shared/ipc.js";

/** Apply the chosen accent color to the CSS variable (live, no restart). */
export function applyAccent(hex: string) {
  document.documentElement.style.setProperty("--accent", hex);
}

export const THEME_STORAGE_KEY = "cascade-theme";
export const DEFAULT_THEME: UiTheme = "dark";

/** Coerce any stored/IPC value to a known theme (unknown = dark default). */
export function normalizeTheme(value: unknown): UiTheme {
  return value === "light" ? "light" : "dark";
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
