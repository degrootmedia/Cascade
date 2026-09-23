/**
 * Shared state for the Settings panes. Sections read the live `SettingsView`
 * (refreshed after provider/key changes) and reach the panel-level error line
 * and section actions through this context instead of prop-drilling.
 *
 * Dirty tracking is for sections whose writes are deferred (e.g. a CLI path
 * typed but not yet saved). Auto-saving fields never report dirty, so the
 * panel's close guard only fires when the existing behavior actually defers.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { SettingsView } from "../../../../shared/ipc.js";

export interface SettingsContextValue {
  /** Live settings view (re-read from main after provider/key changes). */
  view: SettingsView;
  /** Re-read `SettingsView` from main. */
  refresh: () => Promise<void>;
  /** Current search query ("" when idle). Also read by label highlighting. */
  query: string;
  error: string | null;
  setError: (error: string | null) => void;
  onOpenAgents?: () => void;
  onOpenModelCustomizer?: () => void;
  /** Report a section's unsaved-edit state (drives the rail dot + close guard). */
  setDirty: (id: string, dirty: boolean) => void;
  /** Register a section's deferred-write saver for the close guard. */
  registerSaver: (id: string, save: (() => Promise<void>) | null) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ value, children }: { value: SettingsContextValue; children: ReactNode }) {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
}
