/**
 * Animatic edge-drag modes: roll trades time with the neighbor (total
 * fixed), ripple changes only the dragged item (following items shift
 * because starts are cumulative). Bounds [0.5, 20] apply in both.
 */
import { describe, it, expect } from "vitest";
import { edgeDragUpdates } from "../src/renderer/src/components/production/animatic-edit.js";

const items = [
  { id: "a", durationSec: 3 },
  { id: "b", durationSec: 4 },
  { id: "c", durationSec: 2 },
];

describe("edgeDragUpdates", () => {
  it("roll: growing one item shrinks the next by the same delta", () => {
    expect(edgeDragUpdates(items, 0, 5, "roll")).toEqual([
      { id: "a", durationSec: 5 },
      { id: "b", durationSec: 2 },
    ]);
  });

  it("roll: the neighbor's 0.5s floor caps how far the drag can go", () => {
    expect(edgeDragUpdates(items, 0, 9, "roll")).toEqual([
      { id: "a", durationSec: 6.5 },
      { id: "b", durationSec: 0.5 },
    ]);
  });

  it("roll on the last item is a single-item change (no neighbor to trade with)", () => {
    expect(edgeDragUpdates(items, 2, 6, "roll")).toEqual([{ id: "c", durationSec: 6 }]);
  });

  it("ripple: only the dragged item changes, so everything after it shifts", () => {
    expect(edgeDragUpdates(items, 0, 1.2, "ripple")).toEqual([{ id: "a", durationSec: 1.2 }]);
    expect(edgeDragUpdates(items, 1, 8, "ripple")).toEqual([{ id: "b", durationSec: 8 }]);
  });

  it("both modes clamp to [0.5, 20] and ignore a bad index", () => {
    expect(edgeDragUpdates(items, 0, 0.1, "ripple")).toEqual([{ id: "a", durationSec: 0.5 }]);
    expect(edgeDragUpdates(items, 0, 99, "ripple")).toEqual([{ id: "a", durationSec: 20 }]);
    expect(edgeDragUpdates(items, 9, 5, "ripple")).toEqual([]);
  });
});
