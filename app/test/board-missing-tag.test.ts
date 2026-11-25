import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Bug #21: the red "missing file" pill on a storyboard shot floated off the
// card's corner (top 38px / right 38px). It must read as an upper-right
// corner badge, using the same inset as the other upper-right corner badge
// (the "video pending" pill: top 8px, right 6px).
const css = readFileSync(resolve(__dirname, "../src/renderer/src/styles.css"), "utf8");
const rules = (sel: string) => {
  const re = new RegExp("(^|\\n)" + sel.replace(/[.]/g, "\\.") + "\\s*\\{([^}]*)\\}", "g");
  return [...css.matchAll(re)].map((m) => m[2]).join("\n");
};
const px = (body: string, prop: string) => {
  const all = [...body.matchAll(new RegExp("(?:^|[;\\s])" + prop + ":\\s*(-?\\d+)px", "g"))];
  return all.length ? Number(all[all.length - 1][1]) : NaN;
};

describe("storyboard missing-file tag (Bug #21)", () => {
  const missing = rules(".prod-board-missing");
  const cornerBadge = rules(".prod-board-pending-video");

  it("anchors to the frame's upper-right corner with the corner-badge inset", () => {
    expect(px(missing, "top")).toBe(px(cornerBadge, "top"));
    expect(px(missing, "right")).toBe(px(cornerBadge, "right"));
    expect(missing).toMatch(/left:\s*auto/);
  });

  it("never reaches the top-center drag handle, even at the smallest card size", () => {
    // The tag's width is capped so its left edge stays clear of the 24px-wide
    // centered drag handle at any frame width (Frame size slider 180-440px).
    expect(missing).toMatch(/max-width:\s*calc\(50%\s*-\s*\d+px\)/);
    const cap = Number(/max-width:\s*calc\(50%\s*-\s*(\d+)px\)/.exec(missing)![1]);
    // 12px = half the drag handle, plus the right inset, plus a small gap.
    expect(cap).toBeGreaterThanOrEqual(12 + px(missing, "right") + 2);
  });

  it("drops below the Make Primary pill while a history frame is shown", () => {
    expect(css).toMatch(/\.prod-board-promote ~ \.prod-board-missing\s*\{[^}]*top:\s*38px/);
  });

  it("keeps its danger styling and text, and still only renders for missing media", () => {
    expect(missing).toMatch(/border-color:\s*var\(--danger\)/);
    expect(missing).toMatch(/color:\s*var\(--danger\)/);
    const b = readFileSync(resolve(__dirname, "../src/renderer/src/components/production/boards.tsx"), "utf8");
    expect(b).toMatch(/\?\.state === "missing" && \(\s*<span\s+className="prod-board-pending prod-board-missing"/);
    expect(b).toMatch(/>\s*missing file\s*</);
  });
});
