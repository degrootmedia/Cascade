/**
 * <ProdLog> — the production activity log shown on the step panels. It must
 * collapse to a header so the scrolling text can be hidden, and the choice
 * persists (one key, so every panel agrees).
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ProdLog, type LogLine } from "../src/renderer/src/components/production/animatic.js";

const LINES: LogLine[] = [
  { id: "1", at: "10:00:01", message: "Generating shot 0100", level: "info" },
  { id: "2", at: "10:00:40", message: "Frame ready", level: "done" },
];

function mount(lines: LogLine[] = LINES) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(ProdLog, { lines }));
  });
  return { host, root };
}

describe("ProdLog", () => {
  it("collapses to a header that hides the scrolling lines, and expands again", () => {
    window.localStorage.removeItem("cascade.prodLog.collapsed");
    const { host, root } = mount();
    expect(host.textContent).toContain("Frame ready");

    const toggle = host.querySelector("button.prod-log-toggle") as HTMLButtonElement;
    expect(toggle, "collapse toggle").toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    act(() => { toggle.click(); });
    expect(host.textContent).not.toContain("Frame ready");
    expect(host.querySelector(".prod-log-lines")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // The header (with the line count) stays visible while collapsed.
    expect(host.querySelector(".prod-log-head")?.textContent).toContain("2");

    act(() => { toggle.click(); });
    expect(host.textContent).toContain("Frame ready");
    act(() => { root.unmount(); });
    host.remove();
  });

  it("the collapse caret is a CSS shape with no text glyph (encoding-proof)", () => {
    const { host, root } = mount();
    const caret = host.querySelector(".prod-log-caret");
    expect(caret, "caret element").toBeTruthy();
    expect(caret!.textContent).toBe("");
    expect(caret!.getAttribute("aria-hidden")).toBe("true");
    act(() => { root.unmount(); });
    host.remove();
  });
});
