import { useEffect, useRef, useState } from "react";
import type { SettingsCategory, SettingsSection } from "./types.js";
import { SettingsSearch } from "./SettingsSearch.js";

export interface RailGroup {
  category: SettingsCategory;
  sections: SettingsSection[];
}

/** Categorized, searchable left nav. Exposes tablist semantics so keyboard and
 *  assistive tech users can move between sections with ↑/↓. Categories collapse
 *  when idle; a search always expands every group so no match stays hidden. */
export function SettingsRail({
  groups,
  activeId,
  onSelect,
  query,
  onQueryChange,
  dirty,
  onShowAll,
}: {
  groups: RailGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  query: string;
  onQueryChange: (value: string) => void;
  dirty: Set<string>;
  onShowAll: () => void;
}) {
  const mounted = useRef(false);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const searching = query.trim().length > 0;
  const flat = groups.flatMap((g) => g.sections);

  // Return focus to the rail after a programmatic section change.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    buttons.current.get(activeId)?.focus();
  }, [activeId]);

  /** Select a section, expanding its category first so the tab is visible. */
  function select(id: string) {
    const category = groups.find((g) => g.sections.some((s) => s.id === id))?.category.id;
    if (category) setCollapsed((prev) => (prev.has(category) ? new Set([...prev].filter((c) => c !== category)) : prev));
    onSelect(id);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const idx = flat.findIndex((s) => s.id === activeId);
    const next = e.key === "ArrowDown" ? Math.min(idx + 1, flat.length - 1) : Math.max(idx - 1, 0);
    if (flat[next]) select(flat[next].id);
  }

  return (
    <nav className="settings-rail" aria-label="Settings sections">
      <SettingsSearch value={query} onChange={onQueryChange} />
      {flat.length === 0 ? (
        <div className="settings-no-match">
          <p className="hint">No settings match “{query}”.</p>
          <button onClick={onShowAll}>Show all</button>
        </div>
      ) : (
        <div className="settings-rail-scroll" role="tablist" aria-orientation="vertical" onKeyDown={onKeyDown}>
          {groups.map(({ category, sections }) => {
            const categoryDirty = sections.some((s) => dirty.has(s.id));
            const isCollapsed = !searching && collapsed.has(category.id);
            return (
              <div className="settings-rail-group" key={category.id}>
                <button
                  className="settings-rail-heading"
                  aria-expanded={!isCollapsed}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(category.id)) next.delete(category.id);
                      else next.add(category.id);
                      return next;
                    })
                  }
                >
                  <span className="settings-rail-chevron" aria-hidden="true">
                    {isCollapsed ? "▸" : "▾"}
                  </span>
                  <span>{category.title}</span>
                  {categoryDirty && <span className="settings-dirty-dot" aria-label="Unsaved changes" />}
                </button>
                {!isCollapsed &&
                  sections.map((section) => (
                    <button
                      key={section.id}
                      ref={(el) => {
                        if (el) buttons.current.set(section.id, el);
                        else buttons.current.delete(section.id);
                      }}
                      role="tab"
                      aria-selected={activeId === section.id}
                      aria-controls={`settings-panel-${section.id}`}
                      id={`settings-tab-${section.id}`}
                      tabIndex={activeId === section.id ? 0 : -1}
                      className={"settings-rail-item" + (activeId === section.id ? " active" : "")}
                      onClick={() => select(section.id)}
                    >
                      <span>{section.title}</span>
                      {dirty.has(section.id) && <span className="settings-dirty-dot" aria-hidden="true" />}
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </nav>
  );
}
