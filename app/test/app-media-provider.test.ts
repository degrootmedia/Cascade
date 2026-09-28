/**
 * Media-provider selection side effects (Issue 4): the provider write + the
 * refresh broadcast must run exactly once per dial selection — never inside
 * the `setState` updater, which React may invoke twice (StrictMode).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { App } from "../src/renderer/src/App.js";

const g = globalThis as Record<string, any>;
let container: HTMLElement;
let root: Root | null = null;
let setMediaCalls: unknown[][];
let changedEvents = 0;
let origLocalStorage: PropertyDescriptor | undefined;
const store: Record<string, string> = {};

function installCascade() {
  setMediaCalls = [];
  changedEvents = 0;
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
    getMediaProvider: async () => "higgsfield-cli",
    getMediaCredits: async () => ({ openart: null, "higgsfield-cli": null, "openart-cli": null }),
    listMediaProviders: async () => [
      { id: "higgsfield-cli", displayName: "Higgsfield", available: true },
      { id: "openart-cli", displayName: "OpenArt CLI", available: true },
    ],
    setMediaProvider: async (...args: unknown[]) => { setMediaCalls.push(args); },
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
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** The provider dial's radio buttons (not the MCP/CLI transport toggle). */
function providerRadios(): HTMLButtonElement[] {
  const group = container.querySelector('[aria-label="Media generation provider"]');
  expect(group, "provider radiogroup").toBeTruthy();
  return Array.from(group!.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
}

function onChanged() {
  changedEvents++;
}

beforeEach(() => {
  // CLI transport mode so two providers share the visible dial.
  origLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = String(v); },
      removeItem: (k: string) => { delete store[k]; },
    },
    configurable: true,
    writable: true,
  });
  store["cascade.providerTransportMode"] = "cli";
  installCascade();
  g.window.HTMLElement.prototype.scrollIntoView = () => {};
  container = g.document.createElement("div");
  g.document.body.appendChild(container);
  root = createRoot(container);
  g.window.addEventListener("cascade:media-provider-changed", onChanged);
});

afterEach(async () => {
  g.window.removeEventListener("cascade:media-provider-changed", onChanged);
  await act(async () => { root?.unmount(); });
  root = null;
  container.remove();
  delete g.window.HTMLElement.prototype.scrollIntoView;
  if (origLocalStorage) Object.defineProperty(globalThis, "localStorage", origLocalStorage);
  else delete (globalThis as Record<string, unknown>).localStorage;
  delete store["cascade.providerTransportMode"];
});

describe("selectMedia side effects", () => {
  it("writes once + broadcasts once under StrictMode; re-selecting active is a no-op", async () => {
    await act(async () => { root!.render(createElement(StrictMode, null, createElement(App))); });
    await flush();
    const radios = providerRadios();
    expect(radios.length).toBe(2);
    const active = radios.find((b) => b.getAttribute("aria-checked") === "true")!;
    const other = radios.find((b) => b !== active)!;
    expect(setMediaCalls).toEqual([]);

    // Selecting the already-active provider: no IPC, no broadcast.
    act(() => { active.click(); });
    await flush();
    expect(setMediaCalls).toEqual([]);
    expect(changedEvents).toBe(0);

    // Selecting a new provider: exactly one write, exactly one broadcast.
    act(() => { other.click(); });
    await flush();
    expect(setMediaCalls.length).toBe(1);
    expect(changedEvents).toBe(1);
  });
});
