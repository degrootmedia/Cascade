/**
 * Settings information architecture (Spec 05). A `SettingsSection` is one leaf
 * pane in the rail; a `SettingsCategory` groups sections under a rail heading.
 * The registry in `registry.tsx` is the single source of truth for the rail,
 * for search, and for the coverage test that keeps every `SettingsView` key
 * reachable. Storage is untouched — this is presentation only.
 */
import type { ReactNode } from "react";
import type { SettingsView } from "../../../../shared/ipc.js";

export interface SettingsSection {
  /** Stable id, used in deep links (`#settings/<id>`) and dirty/reset keys. */
  id: string;
  title: string;
  /** Category id this section belongs to. */
  category: string;
  /** One-line description shown under the section heading. */
  description?: string;
  /** Free-text search terms (labels, synonyms, concepts the section owns). */
  keywords: string[];
  /**
   * The `SettingsView` keys this section is the single home for. The coverage
   * test asserts every key of `SettingsView` appears here, so a future schema
   * addition fails loudly instead of becoming unreachable.
   */
  owns: (keyof SettingsView)[];
  /** Render the section body. The panel keeps every section mounted (hidden
   *  when inactive) so deferred edits survive a section switch. */
  render: () => ReactNode;
  /** Restore this section's keys to their defaults (omit when not resettable). */
  onReset?: () => void | Promise<void>;
}

export interface SettingsCategory {
  id: string;
  title: string;
  sections: SettingsSection[];
}
