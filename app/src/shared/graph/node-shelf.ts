/**
 * The node shelf's grouping model (the node graph's right-hand "Nodes"
 * palette). Pure data + derivations, shared by the shelf component and its
 * tests: which palette tools exist, which registry kind each one places
 * (the registry then decides its category — see `kinds.ts`), how the
 * visible tools group into ordered sections, and how search filters them.
 *
 * The shelf offers TOOLS, not bare kinds: dragging "Video generation"
 * places a videogen+videoprompt pair. A tool files under its PRIMARY
 * kind's category (the generator it places), so a category change in the
 * registry moves the tile with no shelf edit. Structural kinds that are
 * never dragged in (composer, output, …) still carry registry categories,
 * so any kind offered later already has a home.
 */
import type { GraphNodeKind } from "../ipc.js";
import {
  NODE_CATEGORIES,
  NODE_KIND_REGISTRY,
  nodeCategoryFor,
  type NodeCategoryId,
} from "./kinds.js";

/** A palette tool id — the `application/x-cascade-tool` drag payload the
 *  canvas drop handler understands. */
export type PaletteToolId =
  | "video"
  | "edit"
  | "editvideo"
  | "genjutsu-motion"
  | "genjutsu-swap"
  | "tween"
  | "cameraGrid"
  | "upscale";

export interface PaletteToolDef {
  tool: PaletteToolId;
  /** Shelf label (also the search name). */
  label: string;
  /** The registry kind the tool places — its category follows this kind. */
  kind: GraphNodeKind;
}

/** Every palette tool, in its historical shelf order. Grouping preserves
 *  this order within a category. The Genjutsu tools place `editvideo`
 *  nodes (edit-family modes), so they file under Video with Edit video. */
export const PALETTE_TOOLS: PaletteToolDef[] = [
  { tool: "video", label: "Video generation", kind: "videogen" },
  { tool: "edit", label: "Edit image", kind: "editgen" },
  { tool: "editvideo", label: "Edit video", kind: "editvideo" },
  { tool: "genjutsu-motion", label: "Genjutsu Motion Transfer", kind: "editvideo" },
  { tool: "genjutsu-swap", label: "Genjutsu Object Swap", kind: "editvideo" },
  { tool: "tween", label: "In-betweener", kind: "tween" },
  { tool: "cameraGrid", label: "Camera grid", kind: "cameraGrid" },
  { tool: "upscale", label: "Upscale", kind: "upscale" },
];

/** The shelf category a palette tool files under (its primary kind's). */
export function paletteCategoryFor(tool: PaletteToolId): NodeCategoryId {
  const def = PALETTE_TOOLS.find((t) => t.tool === tool);
  return def ? nodeCategoryFor(def.kind) : nodeCategoryFor(tool as GraphNodeKind);
}

/** Case-insensitive name match for the shelf search box. */
export function matchesNodeSearch(label: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || label.toLowerCase().includes(q);
}

export interface NodeShelfSection<T> {
  category: NodeCategoryId;
  label: string;
  items: T[];
}

/**
 * Group palette items into shelf sections: categories in shelf order,
 * items in their incoming (palette) order, categories with nothing to
 * show omitted. A non-empty `query` filters by name across ALL
 * categories — the caller force-expands sections while searching, so a
 * match in a collapsed category is still reachable.
 */
export function groupPaletteItems<T extends { tool: PaletteToolId; label: string }>(
  items: readonly T[],
  query = "",
): Array<NodeShelfSection<T>> {
  const matching = items.filter((item) => matchesNodeSearch(item.label, query));
  const sections: Array<NodeShelfSection<T>> = [];
  for (const cat of NODE_CATEGORIES) {
    const inCat = matching.filter((item) => paletteCategoryFor(item.tool) === cat.id);
    if (inCat.length > 0) sections.push({ category: cat.id, label: cat.label, items: inCat });
  }
  return sections;
}

export interface NodeKindSection {
  category: NodeCategoryId;
  label: string;
  kinds: GraphNodeKind[];
}

/** Every registered node kind grouped by category, sections in shelf
 *  order (empty sections included). Each kind appears exactly once: its
 *  declared category, or Layout & Utility when undeclared. */
export function groupKindsByCategory(): NodeKindSection[] {
  const kinds = Object.keys(NODE_KIND_REGISTRY) as GraphNodeKind[];
  return NODE_CATEGORIES.map((cat) => ({
    category: cat.id,
    label: cat.label,
    kinds: kinds.filter((kind) => nodeCategoryFor(kind) === cat.id),
  }));
}

/** localStorage key for one category's collapsed flag. Global per user
 *  (not per production): how someone leaves their shelf is a personal
 *  preference, like the reference shelf's width pattern it mirrors. */
export function nodeShelfCollapsedKey(category: NodeCategoryId): string {
  return `cascade.graph.nodeShelf.${category}`;
}
