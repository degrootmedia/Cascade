/**
 * UI polish batch (Nov 2026): Feature #19 (Snippets beside Nodes), #27
 * ("Choose folder..." first), #28 (autonomous warning in the button's
 * yellow) and #29 (Chat tab glows when the agent needs the user).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { FolderPicker } from "../src/renderer/src/components/FolderPicker.js";
import { ViewTabs } from "../src/renderer/src/components/ViewTabs.js";
import { chatAttentionAfterEvent, type ChatAttention } from "../src/renderer/src/components/chat-attention.js";

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");
const css = read("../src/renderer/src/styles.css");

async function mount(el: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(el); });
  return {
    container,
    rerender: (next: ReturnType<typeof createElement>) => act(async () => { root.render(next); }),
    done: async () => { await act(async () => { root.unmount(); }); document.body.removeChild(container); },
  };
}

describe("Feature #19 — classic side panel: [Snippets] [Nodes]", () => {
  it("Snippets is the sibling immediately before Nodes, in one right-aligned group", () => {
    const src = read("../src/renderer/src/components/production/prompt-panel.tsx");
    expect(src).toMatch(/<span className="prod-prompt-drawer-actions">\s*<SnippetsButton \/>\s*\{shotNumber && <button className="prod-btn prod-graph-open"/);
    expect(css).toMatch(/\.prod-prompt-drawer-actions \{[^}]*margin-left: auto/);
    // Nodes keeps its own rule untouched; the snippets button keeps its behavior.
    expect(css).toContain(".prod-graph-open { margin-left: auto; flex-shrink: 0; }");
    expect(read("../src/renderer/src/components/snippets/SnippetsShelf.tsx")).toContain("onClick={() => openSnippetsShelf()}");
  });
});

describe("Feature #27 — Choose folder... leads the folder list", () => {
  it("is the first item, reads exactly 'Choose folder...', opens the picker; the rest keep their order", async () => {
    let picked = 0;
    const props = {
      current: "C:\\work\\a", recents: ["C:\\work\\a", "C:\\work\\b"], instructions: null, pureChat: false, followProduction: false,
      production: null, onPick: () => { picked++; }, onSelect: () => {}, onNone: () => {}, onSelectProduction: () => {}, onOpenInstructions: () => {},
    };
    const m = await mount(createElement(FolderPicker, props));
    await act(async () => { (m.container.querySelector(".folder-chip") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const items = Array.from(m.container.querySelectorAll(".folder-menu > *")).map((el) =>
      el.classList.contains("folder-menu-heading") ? `# ${el.textContent}` : el.querySelector(".folder-label")?.textContent
    );
    expect(items).toEqual(["Choose folder...", "None — chat only", "Active Production", "Current", "# Recent", "b"]);
    expect(m.container.textContent).not.toContain("Choose different folder");
    await act(async () => { (m.container.querySelector(".folder-option.add") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(picked).toBe(1);
    await m.done();
  });
});

describe("Feature #28 — autonomous ON warning in the button's yellow", () => {
  it("the warning notice is tagged caution and renders in the button's exact color token", () => {
    const btnColor = /\.plan-mode\.autonomous-mode\.on \{ color: (var\(--[a-z-]+\))/.exec(css)![1];
    expect(css).toContain(`.msg.notice.notice-caution { color: ${btnColor}; }`);
    // Every other notice stays red.
    expect(css).toContain(".msg.notice { color: var(--danger);");
    const main = read("../src/main/index.ts");
    expect(main).toContain('"Autonomous mode ON — Cascade will act without asking for approval. Turn it off any time."');
    expect(main).toContain('...(entry.session.autonomousMode ? { tone: "caution" as const } : {})');
    expect(read("../src/renderer/src/components/Transcript.tsx")).toContain('(item.tone === "caution" ? " notice-caution" : "")');
  });
});

describe("Feature #29 — Chat tab glows when the agent needs the user", () => {
  const step = (a: ChatAttention, type: string, visible = false) => chatAttentionAfterEvent(a, { type } as never, visible);

  it("glows when the turn ends (finished or asked a question), red-tinted on an error", () => {
    expect(step(null, "agent-done")).toBe("waiting");
    expect(step(null, "error")).toBe("error");
    expect(step("error", "agent-done")).toBe("error");
  });
  it("never glows while the agent is working", () => {
    for (const t of ["text-delta", "text-done", "tool-start", "tool-result", "turn-done", "notice"]) {
      expect(step(null, t)).toBe(null);
    }
  });
  it("never glows while the chat is the visible view", () => {
    expect(step(null, "agent-done", true)).toBe(null);
    expect(step("waiting", "error", true)).toBe(null);
  });
  it("the Chat tab carries the glow class and loses it once attention clears", async () => {
    const m = await mount(createElement(ViewTabs, { value: "prod", onChange: () => {}, chatAttention: "waiting" }));
    const chatTab = () => m.container.querySelector(".view-tab") as HTMLElement;
    expect(chatTab().textContent).toBe("Chat");
    expect(chatTab().className).toContain("attention attention-waiting");
    await m.rerender(createElement(ViewTabs, { value: "home", onChange: () => {}, chatAttention: null }));
    expect(chatTab().className).not.toContain("attention");
    await m.done();
  });
  it("App clears the glow when the Chat view is shown and feeds every agent event through the rule", () => {
    const app = read("../src/renderer/src/App.tsx");
    expect(app).toContain('if (view === "home") setChatAttention(null);');
    expect(app).toContain('setChatAttention((a) => chatAttentionAfterEvent(a, event, viewRef.current === "home"));');
    expect(css).toMatch(/\.view-tab\.attention \{[^}]*animation: view-tab-attention 2\.4s ease-in-out infinite/);
  });
});
