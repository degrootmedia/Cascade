/**
 * Moodboard toolbar: navigation (fit / 100% / zoom), arrangement, filters,
 * background, and the add/remove actions. Pure presentation — the canvas owns
 * the state and hands down callbacks.
 */
import type { ReferenceCategory } from "../../../../shared/ipc.js";

export function MoodboardToolbar({
  count,
  hiddenCount,
  categories,
  activeCategory,
  background,
  zoom,
  hasSelection,
  onFilter,
  onBackground,
  onFit,
  onReset,
  onZoom,
  onArrange,
  onGroup,
  onUngroup,
  onAddReference,
  onRemoveSelected,
  onShowAll,
}: {
  count: number;
  hiddenCount: number;
  categories: ReferenceCategory[];
  /** null = "All". */
  activeCategory: string | null;
  background: "dark" | "mid" | "grid";
  zoom: number;
  hasSelection: boolean;
  onFilter: (categoryId: string | null) => void;
  onBackground: (background: "dark" | "mid" | "grid") => void;
  onFit: () => void;
  onReset: () => void;
  onZoom: (direction: 1 | -1) => void;
  onArrange: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onAddReference: () => void;
  onRemoveSelected: () => void;
  onShowAll: () => void;
}) {
  return (
    <div className="moodboard-toolbar">
      <div className="moodboard-toolbar-group">
        <button className="prod-btn ghost" onClick={onFit} title="Fit all references in view">Fit</button>
        <button className="prod-btn ghost" onClick={onReset} title="Reset to 100%">100%</button>
        <button className="prod-btn ghost" onClick={() => onZoom(-1)} title="Zoom out">−</button>
        <span className="moodboard-zoom" title="Current zoom">{Math.round(zoom * 100)}%</span>
        <button className="prod-btn ghost" onClick={() => onZoom(1)} title="Zoom in">+</button>
      </div>

      <div className="moodboard-toolbar-group">
        <button className="prod-btn ghost" onClick={onArrange} disabled={!hasSelection} title="Auto-arrange the selected nodes into a shelf">Arrange selected</button>
        <button className="prod-btn ghost" onClick={onGroup} disabled={!hasSelection} title="Group the selected references in a frame (Ctrl+G)">Group</button>
        <button className="prod-btn ghost" onClick={onUngroup} disabled={!hasSelection} title="Ungroup the frames holding the selected references (Ctrl+Shift+G)">Ungroup</button>
        <button className="prod-btn ghost" onClick={onRemoveSelected} disabled={!hasSelection} title="Remove the selected nodes from the board (references are kept)">Remove from board</button>
        <button className="prod-btn" onClick={onAddReference} title="Add a reference image to the board">+ Add reference</button>
      </div>

      <div className="moodboard-toolbar-group moodboard-filters">
        <button className={"moodboard-chip" + (activeCategory === null ? " active" : "")} onClick={() => onFilter(null)}>All</button>
        {categories.map((c) => (
          <button
            key={c.id}
            className={"moodboard-chip" + (activeCategory === c.id ? " active" : "")}
            onClick={() => onFilter(c.id)}
            title={`Filter: ${c.name}`}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="moodboard-toolbar-group">
        <label className="moodboard-bg" title="Board background">
          <select value={background} onChange={(e) => onBackground(e.target.value as "dark" | "mid" | "grid")}>
            <option value="dark">Dark</option>
            <option value="mid">Mid</option>
            <option value="grid">Grid</option>
          </select>
        </label>
        <span className="moodboard-count" title="Visible / total references">
          {count} ref{count === 1 ? "" : "s"}
          {hiddenCount > 0 && (
            <>
              {" · "}
              <button className="moodboard-showall" onClick={onShowAll} title="Show the references removed from the board">{hiddenCount} hidden</button>
            </>
          )}
        </span>
      </div>
    </div>
  );
}
