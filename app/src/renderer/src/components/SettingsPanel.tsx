/**
 * Settings (Spec 05): a two-pane shell — a searchable, categorized left rail
 * and a scrollable section pane. Presentation only: every value still persists
 * through the existing `main/settings.ts` IPC methods with the same stored key
 * names, so the settings.json schema is untouched.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SettingsView } from "../../../shared/ipc.js";
import { SettingsProvider, type SettingsContextValue } from "./settings/context.js";
import { allSections, buildSettingsRegistry, findSection, firstSectionId } from "./settings/registry.js";
import { matchSections } from "./settings/search.js";
import { SettingsRail, type RailGroup } from "./settings/SettingsRail.js";
import { consumePendingSettingsSection, OPEN_SETTINGS_EVENT, sectionFromHash } from "./settings/open-settings.js";

export function SettingsPanel({
  settings,
  initialSection,
  onClose,
  onOpenAgents,
  onOpenModelCustomizer,
}: {
  settings: SettingsView;
  /** Section to open on mount (overrides the hash). */
  initialSection?: string;
  onClose: () => void;
  onOpenAgents?: () => void;
  onOpenModelCustomizer?: () => void;
}) {
  const registry = useMemo(buildSettingsRegistry, []);
  const [view, setView] = useState(settings);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(() => {
    const requested = initialSection ?? consumePendingSettingsSection() ?? sectionFromHash(window.location.hash);
    return requested && findSection(registry, requested) ? requested : firstSectionId(registry);
  });
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState<Set<string>>(() => new Set());
  const [confirmClose, setConfirmClose] = useState(false);
  const savers = useRef(new Map<string, () => Promise<void>>());

  const refresh = useCallback(async () => {
    try {
      setView(await window.cascade.getSettings());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const setDirty = useCallback((id: string, isDirty: boolean) => {
    setDirtyState((prev) => {
      if (prev.has(id) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const registerSaver = useCallback((id: string, save: (() => Promise<void>) | null) => {
    if (save) savers.current.set(id, save);
    else savers.current.delete(id);
  }, []);

  const selectSection = useCallback((id: string) => {
    setActiveId(id);
    try {
      window.history.replaceState(null, "", `#settings/${id}`);
    } catch {
      /* history may be unavailable in tests; the id state still drives the pane */
    }
  }, []);

  // Deep link / external open: pick up a section requested after mount too.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const pending = consumePendingSettingsSection();
      const id = (e as CustomEvent<string | undefined>).detail ?? pending;
      if (id && findSection(registry, id)) selectSection(id);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, [registry, selectSection]);

  const matches = useMemo(() => matchSections(registry, query), [registry, query]);
  const groups: RailGroup[] = matches.map((m) => ({
    category: m.category,
    sections: m.sections.map((s) => s.section),
  }));

  // Keep the active pane inside the filtered results while searching.
  useEffect(() => {
    if (!query.trim()) return;
    const ids = new Set(groups.flatMap((g) => g.sections.map((s) => s.id)));
    if (ids.size && !ids.has(activeId)) selectSection(groups[0].sections[0].id);
  }, [query, groups, activeId, selectSection]);

  const active = findSection(registry, activeId) ?? allSections(registry)[0];
  const ready = view.hasApiKey;

  function requestClose() {
    if (dirty.size > 0) setConfirmClose(true);
    else onClose();
  }

  async function saveAndClose() {
    for (const save of savers.current.values()) {
      try {
        await save();
      } catch {
        /* a failed save keeps the panel open via the section's own error */
      }
    }
    onClose();
  }

  async function resetActive() {
    if (!active?.onReset) return;
    try {
      await active.onReset();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  const context: SettingsContextValue = {
    view,
    refresh,
    query,
    error,
    setError,
    onOpenAgents,
    onOpenModelCustomizer,
    setDirty,
    registerSaver,
  };

  return (
    <div className="modal-backdrop top-layer" onClick={requestClose}>
      <div className="modal settings settings-modal" onClick={(e) => e.stopPropagation()}>
        <SettingsProvider value={context}>
          <div className="settings-layout">
            <SettingsRail
              groups={groups}
              activeId={activeId}
              onSelect={selectSection}
              query={query}
              onQueryChange={setQuery}
              dirty={dirty}
              onShowAll={() => setQuery("")}
            />
            <div className="settings-pane">
              {active && (
                <header className="settings-pane-head">
                  <div>
                    <h3>{active.title}</h3>
                    {active.description && <p className="hint">{active.description}</p>}
                  </div>
                  {active.onReset && <button onClick={() => void resetActive()}>Reset section</button>}
                </header>
              )}
              <div className="settings-pane-body">
                {allSections(registry).map((section) => (
                  <section
                    key={section.id}
                    id={`settings-panel-${section.id}`}
                    role="tabpanel"
                    aria-labelledby={`settings-tab-${section.id}`}
                    hidden={section.id !== activeId}
                    className="settings-section"
                  >
                    {section.render()}
                  </section>
                ))}
              </div>
              {error && <p className="error-text settings-error">{error}</p>}
              <footer className="modal-actions">
                {confirmClose ? (
                  <>
                    <span className="hint" style={{ marginRight: "auto" }}>
                      Unsaved changes in this section.
                    </span>
                    <button onClick={() => void saveAndClose()}>Save</button>
                    <button onClick={onClose}>Discard</button>
                    <button onClick={() => setConfirmClose(false)}>Cancel</button>
                  </>
                ) : (
                  <button className="primary" onClick={requestClose} disabled={!ready}>
                    {ready ? "Done" : "Add your API key to continue"}
                  </button>
                )}
              </footer>
            </div>
          </div>
        </SettingsProvider>
      </div>
    </div>
  );
}
