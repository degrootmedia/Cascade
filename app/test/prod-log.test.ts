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

function mount(lines: LogLine[] = LINES, props: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(ProdLog, { lines, ...props }));
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

  it("renders a 720p-retry button on an action line and fires it once", () => {
    window.localStorage.removeItem("cascade.prodLog.collapsed");
    const seen: unknown[] = [];
    const action = {
      kind: "retry720p" as const,
      shotId: "s1",
      surface: "classic" as const,
      refs: [{ refId: "r1", name: "Clip", height: 1080 }],
      mayHaveBilled: false,
    };
    const lines: LogLine[] = [
      { id: "1", at: "10:00:01", message: "video reference over 720p", level: "info", action },
    ];
    const { host, root } = mount(lines, { onRetry720p: (a: unknown) => seen.push(a) });
    const btn = host.querySelector("button.prod-log-action-btn") as HTMLButtonElement;
    expect(btn, "retry button").toBeTruthy();
    expect(btn.textContent).toContain("Create 720p copy & retry");
    expect(btn.disabled).toBe(false);

    act(() => { btn.click(); });
    expect(seen).toEqual([action]);
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Retrying…");

    act(() => { root.unmount(); });
    host.remove();
  });

  it("shows no retry button without an action handler", () => {
    const lines: LogLine[] = [
      {
        id: "1", at: "10:00:01", message: "video reference over 720p", level: "info",
        action: { kind: "retry720p", shotId: "s1", surface: "classic", refs: [{ refId: "r1", name: "Clip", height: 1080 }], mayHaveBilled: false },
      },
    ];
    const { host, root } = mount(lines);
    expect(host.querySelector("button.prod-log-action-btn")).toBeNull();
    act(() => { root.unmount(); });
    host.remove();
  });
});
