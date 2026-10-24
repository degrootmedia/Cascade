/**
 * Moodboard shelf category grouping: the off-board shelf groups references
 * by the production's Design categories (Uncategorized first, production
 * order after), omits empty groups, and renders a collapsible header per
 * group — the same grouping the Step 2 panel and node-graph shelf show.
 */
import { describe, it, expect } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { MoodboardShelf, groupShelfRefs } from "../src/renderer/src/features/moodboard/MoodboardShelf.js";

const CATS = [
  { id: "c-video", name: "Video" },
  { id: "c-mood", name: "Mood" },
] as never[];

const ref = (id: string, categoryId?: string) => ({ id, name: id, categoryId }) as never;

describe("groupShelfRefs", () => {
  it("orders Uncategorized first, then categories in production order", () => {
    const groups = groupShelfRefs(
      [ref("m1", "c-mood"), ref("u1"), ref("v1", "c-video"), ref("v2", "c-video")],
      CATS,
    );
    expect(groups.map((g) => g.title)).toEqual(["Uncategorized", "Video", "Mood"]);
    expect(groups.map((g) => g.refs.map((r) => r.id))).toEqual([["u1"], ["v1", "v2"], ["m1"]]);
  });

  it("omits empty groups and folds unknown categories into Uncategorized", () => {
    const groups = groupShelfRefs([ref("a", "gone-category"), ref("b", "c-mood")], CATS);
    expect(groups.map((g) => g.title)).toEqual(["Uncategorized", "Mood"]);
    expect(groups[0].refs.map((r) => r.id)).toEqual(["a"]);
    expect(groupShelfRefs([], CATS)).toEqual([]);
  });
});

describe("MoodboardShelf rendering", () => {
  it("renders a header per non-empty category with its tiles", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(MoodboardShelf, {
        prodId: "p1",
        refs: [ref("u1"), ref("v1", "c-video")],
        categories: CATS,
        onAdd: () => {},
        onZoom: () => {},
      } as never));
    });
    const heads = [...host.querySelectorAll(".moodboard-shelf-group-name")].map((el) => el.textContent);
    expect(heads).toEqual(["Uncategorized", "Video"]);
    expect(host.querySelectorAll(".moodboard-shelf-item").length).toBe(2);

    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });
});
