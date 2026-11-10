/**
 * Storyboard panel multi-selection transitions (pure; the workspace holds
 * the state). One selection serves two jobs: contiguous ranges can become
 * shot sequences, and any selection (contiguous or not) can be exported as
 * a style-frame PDF.
 *
 * - "single" (plain click): replace the selection with the clicked panel
 *   and move the anchor to it.
 * - "range" (Shift-click): add every panel between the anchor and the
 *   clicked panel (in storyboard order) to the selection; the anchor stays
 *   put. Without a live anchor this degrades to "single".
 * - "toggle" (Ctrl/Cmd-click): add the clicked panel, or remove it when it
 *   is already selected; the anchor moves to it so a following Shift-click
 *   extends from the most recently toggled panel.
 */
export type BoardSelectMode = "single" | "range" | "toggle";

export interface BoardSelectionState {
  selection: Set<string>;
  anchor: string | null;
}

export function nextBoardSelection(
  order: string[],
  prev: Set<string>,
  anchor: string | null,
  id: string,
  mode: BoardSelectMode
): BoardSelectionState {
  if (mode === "toggle") {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selection: next, anchor: id };
  }
  if (mode === "range" && anchor) {
    const from = order.indexOf(anchor);
    const to = order.indexOf(id);
    if (from >= 0 && to >= 0) {
      const next = new Set(prev);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(order[i]);
      return { selection: next, anchor };
    }
  }
  return { selection: new Set([id]), anchor: id };
}

/** Selected ids in storyboard order (ids no longer on the board drop out). */
export function orderedSelection(order: string[], selection: Set<string>): string[] {
  return order.filter((id) => selection.has(id));
}

/**
 * Whether the selection is one unbroken run in storyboard order — the only
 * shape a shot sequence can be created from. Empty and single-panel
 * selections count as contiguous.
 */
export function isContiguousSelection(order: string[], selection: Set<string>): boolean {
  const ids = orderedSelection(order, selection);
  if (ids.length < 2) return true;
  const first = order.indexOf(ids[0]);
  return ids.every((id, i) => order.indexOf(id) === first + i);
}
