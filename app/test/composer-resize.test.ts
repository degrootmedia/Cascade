/**
 * Composer growth cap (Issue 7): the textarea's maxHeight must track window
 * resizes instead of freezing at the first render's `window.innerHeight`.
 * `AutoTextarea` is mocked to a passthrough that surfaces `maxHeight` as a
 * DOM attribute (the real one only consumes it for height math, which jsdom
 * cannot observe).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { App } from "../src/renderer/src/App.js";

vi.mock("../src/renderer/src/components/AutoTextarea.js", async () => {
  const React = await import("react");
  return {
    AutoTextarea: React.forwardRef<HTMLTextAreaElement, Record<string, unknown>>(
      function MockAutoTextarea({ maxHeight, ...props }, ref) {
        return React.createElement("textarea", {
          ...(props as Record<string, unknown>),
          ref,
          "data-maxheight": maxHeight ?? "",
        });
      },
    ),
  };
});

const g = globalThis as Record<string, any>;
let container: HTMLElement;
let root: Root | null = null;
let origInnerHeight: number;

function installCascade() {
  g.window.cascade = {
    getSettings: async () => ({ hasApiKey: true, model: "m1", accent: "blue" }),
    listSessions: async () => [],
    getCredits: async () => null,
    listAgents: async () => [],
    getSessionAgent: async () => null,
    getWorkspaceState: async () => ({ workspace: null, followProduction: false, production: null }),
    getRecentWorkspaces: async () => [],
    getCurrentSessionId: async () => null,
    getWorkspaceInstructions: async () => null,
    listModels: async () => ({ ok: false, models: [] }),
    getMediaProvider: async () => "openart",
    getMediaCredits: async () => ({ openart: null, "higgsfield-cli": null, "openart-cli": null }),
    listMediaProviders: async () => [{ id: "openart", displayName: "OpenArt", available: true }],
    setMediaProvider: async () => {},
    onWorkspaceChanged: () => () => {},
    onOpenSettings: () => () => {},
    onAgentSwitched: () => () => {},
    onAgentEvent: () => () => {},
    onApprovalRequest: () => () => {},
    onSessionRenamed: () => () => {},
    onMentionAdded: () => () => {},
    onTodosChanged: () => () => {},
    onGoalChanged: () => () => {},
  };
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function composer(): HTMLTextAreaElement {
  const el = container.querySelector('textarea[placeholder="Ask Cascade anything…"]') as HTMLTextAreaElement | null;
  expect(el, "composer textarea").toBeTruthy();
  return el!;
}

beforeEach(() => {
  origInnerHeight = g.window.innerHeight;
  Object.defineProperty(g.window, "innerHeight", { value: 1000, configurable: true });
  installCascade();
  g.window.HTMLElement.prototype.scrollIntoView = () => {};
  container = g.document.createElement("div");
  g.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  container.remove();
  delete g.window.HTMLElement.prototype.scrollIntoView;
  Object.defineProperty(g.window, "innerHeight", { value: origInnerHeight, configurable: true });
});

describe("Composer growth cap", () => {
  it("recomputes maxHeight when the window resizes", async () => {
    await act(async () => { root!.render(createElement(App)); });
    await flush();
    expect(composer().getAttribute("data-maxheight")).toBe(String(Math.round(1000 * 0.4)));

    Object.defineProperty(g.window, "innerHeight", { value: 1400, configurable: true });
    act(() => { g.window.dispatchEvent(new g.Event("resize")); });
    expect(composer().getAttribute("data-maxheight")).toBe(String(Math.round(1400 * 0.4)));
  });
});
