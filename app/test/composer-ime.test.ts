/**
 * Composer IME guard (Issue 3a): pressing Enter to confirm an IME candidate
 * must not send a half-finished chat message. Mounts the real `App` and
 * drives its composer textarea.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { App } from "../src/renderer/src/App.js";

const g = globalThis as Record<string, any>;
let container: HTMLElement;
let root: Root | null = null;
let sendMessageCalls: unknown[][];

function installCascade() {
  sendMessageCalls = [];
  g.window.cascade = {
    getSettings: async () => ({ hasApiKey: true, model: "m1", accent: "blue" }),
    listSessions: async () => [],
    getCredits: async () => null,
    listAgents: async () => [],
    getSessionAgent: async () => null,
    getWorkspaceState: async () => ({ workspace: null, followProduction: false, production: null }),
    getRecentWorkspaces: async () => [],
    getCurrentSessionId: async () => "s1",
    getPlanMode: async () => false,
    getAutonomousMode: async () => false,
    getWorkspaceInstructions: async () => null,
    getSessionTodos: async () => ({ sessionId: "s1", updatedAt: "", items: [] }),
    getSessionGoal: async () => ({ sessionId: "s1", goal: "", status: "active", updatedAt: "" }),
    listModels: async () => ({ ok: false, models: [] }),
    getMediaProvider: async () => "openart",
    getMediaCredits: async () => ({ openart: null, "higgsfield-cli": null, "openart-cli": null }),
    listMediaProviders: async () => [{ id: "openart", displayName: "OpenArt", available: true }],
    setMediaProvider: async () => {},
    sendMessage: async (...args: unknown[]) => { sendMessageCalls.push(args); },
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

function typeInto(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set
    ?? Object.getOwnPropertyDescriptor(g.window.HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter!.call(el, text);
    el.dispatchEvent(new g.Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
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
});

describe("Composer IME", () => {
  it("does not send while an IME composition is active; sends after it ends", async () => {
    await act(async () => { root!.render(createElement(App)); });
    await flush();
    const box = composer();
    typeInto(box, "hello");

    const composing = new g.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(composing, "isComposing", { value: true });
    act(() => { box.dispatchEvent(composing); });
    await flush();
    expect(sendMessageCalls).toEqual([]);
    expect(composing.defaultPrevented).toBe(false);

    const plain = new g.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(plain, "isComposing", { value: false });
    act(() => { box.dispatchEvent(plain); });
    await flush();
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0][0]).toBe("s1");
    expect(sendMessageCalls[0][1]).toBe("hello");
  });
});
