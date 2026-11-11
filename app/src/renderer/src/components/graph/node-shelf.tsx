/**
 * The node shelf: the node graph's right-hand "Nodes" palette, organized
 * into collapsible category sections (grouping/search model in
 * `shared/graph/node-shelf.ts`, categories declared in the node-kind
 * registry). Extracted from NodeGraphModal like the reference shelf.
 *
 * Tiles are the same drag-to-canvas tools as before (same
 * `application/x-cascade-tool` payload, same disabled/draggable rules —
 * the modal computes those and passes them in); this component only
 * organizes them. Collapse state persists per user across restarts;
 * while a search is active every section shows its matches regardless of
 * collapse, and clearing the search restores the stored states untouched.
 */
import { useMemo, useState, type ReactNode } from "react";
import { usePersistedCollapsed } from "../production/persisted-state.js";
import {
  groupPaletteItems,
  nodeShelfCollapsedKey,
  type PaletteToolId,
} from "../../../../shared/graph/node-shelf.js";
import type { NodeCategoryId } from "../../../../shared/graph/kinds.js";

/** One draggable shelf tile, as computed by the modal (provider gates,
 *  on-canvas state, and hints stay modal-owned). */
export interface NodeShelfTile {
  tool: PaletteToolId;
  label: string;
  icon: ReactNode;
  title: string;
  draggable: boolean;
  /** Provider-gated tile: dimmed, not draggable, drag start refused. */
  disabled?: boolean;
  /** On-canvas instance count badge (multi-instance tools only). */
  count?: number;
}

/** One collapsible category section. `forceOpen` (an active search) shows
 *  the matches without touching the persisted collapsed flag. */
function NodeShelfGroup({ category, label, tiles, total, forceOpen }: {
  category: NodeCategoryId;
  label: string;
  tiles: NodeShelfTile[];
  /** Tiles in this category before the search filter (header count). */
  total: number;
  forceOpen: boolean;
}) {
  const [collapsed, setCollapsed] = usePersistedCollapsed(nodeShelfCollapsedKey(category), false);
  const open = forceOpen || !collapsed;
  return (
    <div className="prod-graph-tools-group">
      <button
        type="button"
        className="prod-graph-tools-group-head"
        aria-expanded={open}
        title={collapsed ? `Show ${label} nodes` : `Hide ${label} nodes`}
        onClick={() => setCollapsed(!collapsed)}
      >
        <svg className={"prod-graph-tools-caret" + (open ? "" : " collapsed")} viewBox="0 0 16 16" width="9" height="9" aria-hidden="true"><path d="M5 3l6 5-6 5V3z" fill="currentColor" /></svg>
        <span className="prod-graph-tools-group-name">{label}</span>
        <span className="prod-graph-shelf-count">{forceOpen ? `${tiles.length}/${total}` : total}</span>
      </button>
      {open && tiles.map((tile) => (
        <div
          key={tile.tool}
          className={"prod-graph-tools-item" + (tile.disabled ? " disabled" : "")}
          draggable={tile.draggable}
          aria-disabled={tile.disabled || undefined}
          title={tile.title}
          onDragStart={(e) => {
            if (tile.disabled) { e.preventDefault(); return; }
            e.dataTransfer.setData("application/x-cascade-tool", tile.tool);
            e.dataTransfer.effectAllowed = "copy";
          }}
        >
          {tile.icon}
          <span className="prod-graph-tools-label">{tile.label}</span>
          {tile.count !== undefined && (
            <span className="prod-graph-shelf-count">{tile.count}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** The whole node palette body: header, search box, and the grouped,
 *  collapsible tile sections. The modal owns the outer panel chrome. */
export function NodeShelf({ tiles }: { tiles: NodeShelfTile[] }) {
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const sections = useMemo(() => groupPaletteItems(tiles, query), [tiles, query]);
  const totals = useMemo(() => {
    const map = new Map<NodeCategoryId, number>();
    for (const s of groupPaletteItems(tiles)) map.set(s.category, s.items.length);
    return map;
  }, [tiles]);
  return (
    <>
      <div className="prod-graph-tools-head">
        <span className="prod-graph-tools-title">Nodes</span>
        <span className="prod-graph-tools-hint">Drag onto the canvas to add</span>
        <input
          type="search"
          className="prod-graph-tools-search nodrag"
          placeholder="Search nodes"
          aria-label="Search nodes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="prod-graph-tools-list">
        {sections.map((section) => (
          <NodeShelfGroup
            key={section.category}
            category={section.category}
            label={section.label}
            tiles={section.items}
            total={totals.get(section.category) ?? section.items.length}
            forceOpen={searching}
          />
        ))}
        {searching && sections.length === 0 && (
          <div className="prod-graph-tools-empty">No nodes match “{query.trim()}”.</div>
        )}
      </div>
    </>
  );
}
