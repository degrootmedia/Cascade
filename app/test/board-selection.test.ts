/**
 * Storyboard panel multi-selection: plain click anchors a single panel,
 * Shift-click extends a range from the anchor, Ctrl-click toggles individual
 * panels in/out (non-contiguous selections allowed for the style-frame PDF
 * export). The pure helper owns the transitions; ProductionWorkspace holds
 * the state.
 */
import { describe, it, expect } from "vitest";
import {
  isContiguousSelection,
  nextBoardSelection,
  orderedSelection,
} from "../src/shared/board-selection.js";

const ORDER = ["s1", "s2", "s3", "s4", "s5"];

describe("nextBoardSelection", () => {
  it("single click anchors and replaces the selection", () => {
    const out = nextBoardSelection(ORDER, new Set(["s1", "s2"]), "s1", "s4", "single");
    expect([...out.selection]).toEqual(["s4"]);
    expect(out.anchor).toBe("s4");
  });

  it("range extends from the anchor (both directions) and keeps the anchor", () => {
    const fwd = nextBoardSelection(ORDER, new Set(["s2"]), "s2", "s4", "range");
    expect(orderedSelection(ORDER, fwd.selection)).toEqual(["s2", "s3", "s4"]);
    expect(fwd.anchor).toBe("s2");
    const back = nextBoardSelection(ORDER, new Set(["s4"]), "s4", "s2", "range");
    expect(orderedSelection(ORDER, back.selection)).toEqual(["s2", "s3", "s4"]);
    expect(back.anchor).toBe("s4");
  });

  it("range without a live anchor falls back to a single selection", () => {
    const out = nextBoardSelection(ORDER, new Set(), null, "s3", "range");
    expect([...out.selection]).toEqual(["s3"]);
    expect(out.anchor).toBe("s3");
    const stale = nextBoardSelection(ORDER, new Set(), "gone", "s3", "range");
    expect([...stale.selection]).toEqual(["s3"]);
    expect(stale.anchor).toBe("s3");
  });

  it("toggle adds an unselected panel without dropping the others", () => {
    const out = nextBoardSelection(ORDER, new Set(["s1"]), "s1", "s4", "toggle");
    expect(orderedSelection(ORDER, out.selection)).toEqual(["s1", "s4"]);
    expect(out.anchor).toBe("s4");
  });

  it("toggle removes an already-selected panel", () => {
    const out = nextBoardSelection(ORDER, new Set(["s1", "s4"]), "s4", "s4", "toggle");
    expect(orderedSelection(ORDER, out.selection)).toEqual(["s1"]);
  });

  it("a range after ctrl-clicks extends from the last toggled panel and keeps toggled panels", () => {
    // s1 plain, s4 toggled in (anchor moves to s4), then Shift-click s5.
    const out = nextBoardSelection(ORDER, new Set(["s1", "s4"]), "s4", "s5", "range");
    expect(orderedSelection(ORDER, out.selection)).toEqual(["s1", "s4", "s5"]);
  });

  it("does not mutate the previous selection set", () => {
    const prev = new Set(["s1"]);
    nextBoardSelection(ORDER, prev, "s1", "s3", "toggle");
    expect([...prev]).toEqual(["s1"]);
  });
});

describe("orderedSelection / isContiguousSelection", () => {
  it("returns selected ids in storyboard order regardless of click order", () => {
    expect(orderedSelection(ORDER, new Set(["s5", "s2", "s4"]))).toEqual(["s2", "s4", "s5"]);
  });

  it("drops ids that are not on the board", () => {
    expect(orderedSelection(ORDER, new Set(["s2", "gone"]))).toEqual(["s2"]);
  });

  it("a toggled (gappy) selection is not contiguous; a range is", () => {
    expect(isContiguousSelection(ORDER, new Set(["s1", "s3"]))).toBe(false);
    expect(isContiguousSelection(ORDER, new Set(["s2", "s3", "s4"]))).toBe(true);
    expect(isContiguousSelection(ORDER, new Set(["s3"]))).toBe(true);
    expect(isContiguousSelection(ORDER, new Set())).toBe(true);
  });
});
