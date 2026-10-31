/**
 * Theme runtime (renderer/src/theme.ts): normalization of untrusted values,
 * live application via `data-theme`, and the localStorage pre-paint cache
 * both windows boot from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  DEFAULT_THEME,
  normalizeTheme,
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
  vi.unstubAllGlobals();
});

describe("normalizeTheme", () => {
  it("accepts only the known themes, everything else is dark", () => {
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
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
