/**
 * Renderer-side UI state (open/collapsed panels) persisted in localStorage so
 * it survives step switches and app restarts. Only collapsed entries are
 * stored ("1"); absence means open, and opening removes the entry.
 */
import { useEffect, useState } from "react";

export function usePersistedCollapsed(key: string): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      if (collapsed) window.localStorage.setItem(key, "1");
      else window.localStorage.removeItem(key);
    } catch { /* ignore */ }
  }, [key, collapsed]);
  return [collapsed, setCollapsed];
}