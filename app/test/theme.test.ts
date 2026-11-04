/**
 * Theme runtime (renderer/src/theme.ts): normalization of untrusted values,
 * live application via `data-theme` / `data-icon-set`, and the localStorage
 * pre-paint caches both windows boot from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyIconSet,
  applyTheme,
  DEFAULT_ICON_SET,
  DEFAULT_THEME,
  ICON_SET_STORAGE_KEY,
  normalizeIconSet,
  normalizeTheme,
  readCachedIconSet,
  readCachedTheme,
  THEME_STORAGE_KEY,
} from "../src/renderer/src/theme.js";

// The shared jsdom setup has no localStorage — stub the Storage contract
// applyTheme/readCachedTheme actually use (getItem/setItem/removeItem).
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  });
});

afterEach(() => {
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.iconSet;
  vi.unstubAllGlobals();
});

describe("normalizeTheme", () => {
  it("accepts only the known themes, everything else is dark", () => {
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("graphite")).toBe("graphite");
    expect(normalizeTheme("solarized")).toBe("dark");
    expect(normalizeTheme("")).toBe("dark");
    expect(normalizeTheme(null)).toBe("dark");
    expect(normalizeTheme(undefined)).toBe("dark");
    expect(normalizeTheme(42)).toBe("dark");
  });
});

describe("applyTheme / readCachedTheme", () => {
  it("sets data-theme on <html> and mirrors it to the boot cache", () => {
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(readCachedTheme()).toBe("light");

    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(readCachedTheme()).toBe("dark");

    applyTheme("graphite");
    expect(document.documentElement.dataset.theme).toBe("graphite");
    expect(readCachedTheme()).toBe("graphite");
  });

  it("a corrupted cache value reads back as the default theme", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "neon");
    expect(readCachedTheme()).toBe(DEFAULT_THEME);
  });

  it("an empty cache reads back as the default theme", () => {
    expect(readCachedTheme()).toBe(DEFAULT_THEME);
    expect(DEFAULT_THEME).toBe("dark");
  });
});

describe("normalizeIconSet", () => {
  it("accepts only the known icon sets, everything else is colorful", () => {
    expect(normalizeIconSet("minimal")).toBe("minimal");
    expect(normalizeIconSet("colorful")).toBe("colorful");
    expect(normalizeIconSet("outline")).toBe("colorful");
    expect(normalizeIconSet("")).toBe("colorful");
    expect(normalizeIconSet(null)).toBe("colorful");
    expect(normalizeIconSet(undefined)).toBe("colorful");
    expect(normalizeIconSet(42)).toBe("colorful");
  });
});

describe("applyIconSet / readCachedIconSet", () => {
  it("sets data-icon-set on <html> and mirrors it to the boot cache", () => {
    applyIconSet("minimal");
    expect(document.documentElement.dataset.iconSet).toBe("minimal");
    expect(readCachedIconSet()).toBe("minimal");

    applyIconSet("colorful");
    expect(document.documentElement.dataset.iconSet).toBe("colorful");
    expect(readCachedIconSet()).toBe("colorful");
  });

  it("a corrupted or empty cache reads back as the default icon set", () => {
    expect(readCachedIconSet()).toBe(DEFAULT_ICON_SET);
    expect(DEFAULT_ICON_SET).toBe("colorful");
    localStorage.setItem(ICON_SET_STORAGE_KEY, "neon");
    expect(readCachedIconSet()).toBe(DEFAULT_ICON_SET);
  });
});
