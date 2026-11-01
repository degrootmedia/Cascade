import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(__dirname, "../src/renderer/src/styles.css"), "utf8");
const rule = (sel: string) => {
  const m = css.match(new RegExp(sel.replace(/[.]/g, "\\.") + "\\s*\\{([^}]*)\\}"));
  return m ? m[1] : "";
};

describe("storyboard video pending/fetch alignment", () => {
  it("drops below the frame-job badge/button when both are pending", () => {
    expect(css).toMatch(/\.prod-board-pending:not\(\.prod-board-pending-video\) ~ \.prod-board-pending-video/);
    expect(css).toMatch(/\.prod-board-recheck:not\(\.prod-board-recheck-video\) ~ \.prod-board-recheck-video/);
  });
  it("storyboard frame menu offers Send to assembly folder", () => {
    const b = readFileSync(resolve(__dirname, "../src/renderer/src/components/production/boards.tsx"), "utf8");
    expect(b).toContain("Send to assembly folder");
    expect(b).toContain("assemblySend(prod.meta.id");
  });
  it("badge sits in the upper-right corner, fetch button right-aligned just below", () => {
    const badge = rule(".prod-board-pending-video");
    const btn = rule(".prod-board-recheck-video");
    expect(badge).toMatch(/top:\s*8px/);
    expect(badge).toMatch(/right:\s*6px/);
    expect(btn).toMatch(/right:\s*6px/);
    const bt = Number(/top:\s*(\d+)px/.exec(btn)![1]);
    expect(bt).toBeGreaterThan(8 + 16);
  });
});
