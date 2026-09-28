/**
 * Sidebar chat search visibility (Issue 6): the search box must render
 * whenever chats exist — not only when there are more than three.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { Sidebar } from "../src/renderer/src/components/Sidebar.js";
import type { SessionMeta } from "../src/shared/ipc.js";

const g = globalThis as Record<string, any>;
let container: HTMLElement;
let root: Root | null = null;

function session(id: string, title: string): SessionMeta {
  return { id, title, updatedAt: new Date().toISOString(), preview: `${title} preview` };
}

function renderSidebar(sessions: SessionMeta[]) {
  act(() => {
    root!.render(
      createElement(Sidebar, {
        sessions,
        onSelect: () => {},
        onNew: () => {},
        onSettings: () => {},
        onRemove: () => {},
        onRename: () => {},
        credits: null,
      }),
    );
  });
}

function searchInput(): HTMLInputElement | null {
  return container.querySelector(".sidebar-search") as HTMLInputElement | null;
}

beforeEach(() => {
  container = g.document.createElement("div");
  g.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  container.remove();
});

describe("Sidebar search visibility", () => {
  it("shows the search box with a single chat", () => {
    renderSidebar([session("a", "Hello")]);
    expect(searchInput()).toBeTruthy();
  });

  it("hides the search box only when there are no chats", () => {
    renderSidebar([]);
    expect(searchInput()).toBeNull();
  });

  it("still reports no matches for a non-matching query", () => {
    renderSidebar([session("a", "Hello")]);
    const input = searchInput()!;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set
      ?? Object.getOwnPropertyDescriptor(g.window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter!.call(input, "zzz-no-match");
      input.dispatchEvent(new g.Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".session-empty")?.textContent).toBe("No chats match your search.");
  });
});
