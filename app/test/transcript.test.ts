/**
 * Transcript row keys (Issue 5): rows must be keyed by stable identity, not
 * list index, so a tool group's expanded state follows the item — not the
 * slot — when an earlier row is deleted/undone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { Transcript } from "../src/renderer/src/components/Transcript.js";
import type { DisplayItem } from "../src/shared/ipc.js";

const g = globalThis as Record<string, any>;
let container: HTMLElement;
let root: Root | null = null;

function tool(name: string, args: string): DisplayItem {
  return { kind: "tool", name, args };
}

function notice(text: string): DisplayItem {
  return { kind: "notice", text };
}

function renderItems(items: DisplayItem[]) {
  act(() => { root!.render(createElement(Transcript, { items })); });
}

function headers(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll(".tool-group-header")) as HTMLButtonElement[];
}

function headerTitles(): string[] {
  return headers().map((h) => h.textContent ?? "");
}

let origScrollIntoView: (() => void) | undefined;

beforeEach(() => {
  // jsdom does not implement scrollIntoView (Transcript auto-scrolls on update).
  origScrollIntoView = g.window.HTMLElement.prototype.scrollIntoView;
  g.window.HTMLElement.prototype.scrollIntoView = () => {};
  container = g.document.createElement("div");
  g.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  container.remove();
  if (origScrollIntoView) g.window.HTMLElement.prototype.scrollIntoView = origScrollIntoView;
  else delete g.window.HTMLElement.prototype.scrollIntoView;
});

describe("Transcript stable keys", () => {
  it("keeps the expanded group expanded after an earlier group is removed", () => {
    renderItems([tool("alpha", "{}"), notice("sep1"), tool("beta", "{}"), notice("sep2")]);
    expect(headerTitles().map((t) => t.includes("alpha") || t.includes("beta"))).toEqual([true, true]);
    expect(container.querySelectorAll(".tool-group-body").length).toBe(0);

    // Expand the second group ("beta").
    act(() => { headers()[1].click(); });
    expect(container.querySelectorAll(".tool-group-body").length).toBe(1);
    expect(container.querySelector(".tool-group-body")?.textContent).toContain("beta");

    // Remove the first group (as an undo/delete would); the surviving group's
    // expanded state must follow the item, not collapse into the freed slot.
    renderItems([tool("beta", "{}"), notice("sep2")]);
    expect(headerTitles().length).toBe(1);
    expect(container.querySelectorAll(".tool-group-body").length).toBe(1);
    expect(container.querySelector(".tool-group-body")?.textContent).toContain("beta");
  });

  it("keeps per-card expand state when a later result streams in", () => {
    renderItems([tool("alpha", "{}"), notice("sep")]);
    act(() => { headers()[0].click(); });
    act(() => { headers()[0].click(); });
    // Result arrives on the same call (name+args unchanged): no remount.
    renderItems([{ kind: "tool", name: "alpha", args: "{}", result: "done" }, notice("sep")]);
    expect(headerTitles().length).toBe(1);
  });
});
