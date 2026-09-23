/**
 * Renderer-side UI state (open/collapsed panels) persisted in localStorage so
 * it survives step switches and app restarts. Collapsed is stored as "1",
 * explicitly opened as "0"; absence means `initial` (open by default), so
 * callers can default large groups to collapsed without overriding the user's
 * explicit choice.
 */
import { useEffect, useState } from "react";

export function usePersistedCollapsed(key: string, initial = false): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const v = window.localStorage.getItem(key);
      if (v === "1") return true;
      if (v === "0") return false;
      return initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, collapsed ? "1" : "0");
    } catch { /* ignore */ }
  }, [key, collapsed]);
  return [collapsed, setCollapsed];
}

/** A persisted panel dimension (px). Clamped to `[min, max]` on read and
 *  write so a corrupt/hand-edited value can never break the layout. */
export function usePersistedNumber(key: string, initial: number, bounds: { min: number; max: number }): [number, (v: number) => void] {
  const clamp = (v: number) => Math.max(bounds.min, Math.min(bounds.max, v));
  const [value, setValue] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) ? clamp(n) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(value));
    } catch { /* ignore */ }
  }, [key, value]);
  return [value, (v: number) => setValue(clamp(v))];
}