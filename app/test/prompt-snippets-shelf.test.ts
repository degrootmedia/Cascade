/**
 * Prompt snippets — shelf behavior against the real DOM components:
 * insert-at-cursor into the contenteditable prompt box and into plain
 * prompt textareas (focus returns, first [placeholder] selected),
 * copy-fallback + toast when no prompt field is active, the always-copy
 * icon, add/edit/delete persisting through a store "restart", search,
 * and Save-selection-as-snippet pre-filling the form.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, createRef, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { PromptContentEditor, type PromptContentHandle } from "../src/renderer/src/components/PromptContentEditor.js";
import { SnippetsShelfHost } from "../src/renderer/src/components/snippets/SnippetsShelf.js";
import { openSnippetsShelf } from "../src/renderer/src/components/snippets/snippets-ui.js";
import {
  getSnippets,
  primePromptSnippets,
  resetSnippetStoreForTests,
} from "../src/renderer/src/components/snippets/snippet-store.js";
import {
  insertIntoActivePromptField,
  installPromptFieldTracking,
  resetPromptFieldForTests,
} from "../src/renderer/src/components/snippets/prompt-field.js";
import { SEEDED_PROMPT_SNIPPETS, type PromptSnippet } from "../src/shared/prompt-snippets.js";

/* ---------- fake persistence (window.cascade) + clipboard ---------- */

let persisted: PromptSnippet[] | null = null;
let clipboardWrites: string[] = [];

function installFakes() {
  (globalThis as Record<string, unknown>).cascade = {
    getPromptSnippets: async () => (persisted === null ? SEEDED_PROMPT_SNIPPETS.map((s) => ({ ...s })) : persisted.map((s) => ({ ...s }))),
    setPromptSnippets: async (list: PromptSnippet[]) => {
      persisted = list.map((s) => ({ ...s }));
    },
  };
  clipboardWrites = [];
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (t: string) => { clipboardWrites.push(t); } },
    configurable: true,
  });
}

/* ---------- tiny DOM harness ---------- */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(el: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

beforeEach(() => {
  persisted = null;
  installFakes();
  resetSnippetStoreForTests();
  resetPromptFieldForTests();
  installPromptFieldTracking();
});

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(text: string): HTMLButtonElement {
  const b = [...document.querySelectorAll("button")].find((x) => (x.textContent ?? "").includes(text));
  if (!b) throw new Error(`button not found: ${text}`);
  return b as HTMLButtonElement;
}

function entryButton(name: string): HTMLButtonElement {
  const b = [...document.querySelectorAll(".snippets-entry-main")].find((x) => (x.textContent ?? "").includes(name));
  if (!b) throw new Error(`snippet entry not found: ${name}`);
  return b as HTMLButtonElement;
}

function selectionOffsetsIn(box: HTMLElement): { start: number; end: number } {
  const sel = window.getSelection()!;
  const range = sel.getRangeAt(0);
  const before = (node: Node, offset: number) => {
    const pre = document.createRange();
    pre.selectNodeContents(box);
    pre.setEnd(node, offset);
    return pre.toString().length;
  };
  return { start: before(range.startContainer, range.startOffset), end: before(range.endContainer, range.endOffset) };
}

function setEditorSelection(box: HTMLElement, start: number, end = start) {
  // Walk text nodes to place a range at serialized offsets.
  const place = (target: number) => {
    let remaining = target;
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let lastNode: Node | null = null;
    while (node) {
      lastNode = node;
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) return { node, offset: remaining };
      remaining -= len;
      node = walker.nextNode();
    }
    return { node: lastNode ?? box, offset: lastNode?.textContent?.length ?? 0 };
  };
  const s = place(start);
  const e = place(end);
  const r = document.createRange();
  r.setStart(s.node, s.offset);
  r.setEnd(e.node, e.offset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ---------- editor insertion (contenteditable Content box) ---------- */

describe("snippet insertion into the prompt content editor", () => {
  function renderEditor(initial: string) {
    const handle = createRef<PromptContentHandle>();
    let latest = initial;
    function Wrapper(): ReactElement {
      const [v, setV] = useState(initial);
      latest = v;
      return createElement(PromptContentEditor, { text: v, onChange: (t: string) => setV(t), ref: handle });
    }
    mount(createElement(Wrapper));
    const box = host!.querySelector(".prompt-content-editor") as HTMLElement;
    return { box, handle, value: () => latest };
  }

  it("insert-at-cursor lands at the caret and returns focus", () => {
    const h = renderEditor("a hero walks");
    act(() => { h.box.focus(); setEditorSelection(h.box, 7); });
    act(() => { document.dispatchEvent(new Event("selectionchange")); });
    let ok = false;
    act(() => { ok = insertIntoActivePromptField("brave "); });
    expect(ok).toBe(true);
    expect(h.value()).toBe("a hero brave walks");
    expect(document.activeElement).toBe(h.box);
    expect(selectionOffsetsIn(h.box)).toEqual({ start: 13, end: 13 });
  });

  it("selects the first [placeholder] after insertion so typing replaces it", () => {
    const h = renderEditor("Style: ");
    act(() => { h.box.focus(); setEditorSelection(h.box, 7); });
    act(() => { h.handle.current!.insertSnippetText("[describe the style], moody"); });
    expect(h.value()).toBe("Style: [describe the style], moody");
    const { start, end } = selectionOffsetsIn(h.box);
    expect(h.value().slice(start, end)).toBe("[describe the style]");
    expect(document.activeElement).toBe(h.box);
    expect(h.handle.current!.selectedText()).toBe("[describe the style]");
  });

  it("appends when the tracked field has no caret snapshot", () => {
    const h = renderEditor("base text");
    act(() => { h.handle.current!.insertSnippetText(" + tail", null); });
    expect(h.value()).toBe("base text + tail");
  });
});

/* ---------- plain prompt textareas ---------- */

describe("snippet insertion into a plain prompt textarea", () => {
  it("inserts at the caret through React state, refocuses, selects placeholder", () => {
    let latest = "edit: make it";
    function Wrapper(): ReactElement {
      const [v, setV] = useState(latest);
      latest = v;
      return createElement("textarea", {
        className: "prod-edit-prompt",
        value: v,
        onChange: (e: { target: { value: string } }) => setV(e.target.value),
      });
    }
    mount(createElement(Wrapper));
    const ta = host!.querySelector("textarea") as HTMLTextAreaElement;
    act(() => { ta.focus(); ta.setSelectionRange(13, 13); ta.dispatchEvent(new Event("keyup", { bubbles: true })); });
    let ok = false;
    act(() => { ok = insertIntoActivePromptField(" [warmer] please"); });
    expect(ok).toBe(true);
    expect(latest).toBe("edit: make it [warmer] please");
    expect(document.activeElement).toBe(ta);
    expect(ta.value.slice(ta.selectionStart!, ta.selectionEnd!)).toBe("[warmer]");
  });

  it("a non-prompt textarea never becomes the insert target", () => {
    function Wrapper(): ReactElement {
      const [v, setV] = useState("{}");
      return createElement("textarea", { className: "prod-model-option-json", value: v, onChange: (e: { target: { value: string } }) => setV(e.target.value) });
    }
    mount(createElement(Wrapper));
    const ta = host!.querySelector("textarea") as HTMLTextAreaElement;
    act(() => { ta.focus(); });
    let ok = true;
    act(() => { ok = insertIntoActivePromptField("snippet"); });
    expect(ok).toBe(false);
    expect(ta.value).toBe("{}");
  });
});

/* ---------- shelf: fallback copy, copy icon, search, groups ---------- */

describe("snippets shelf", () => {
  async function openShelf() {
    mount(createElement(SnippetsShelfHost));
    await flush();
    act(() => openSnippetsShelf());
    await flush();
  }

  it("lists the seeds grouped by category with name + preview", async () => {
    await openShelf();
    const cats = [...document.querySelectorAll(".snippets-category")].map((x) => x.textContent);
    expect(cats).toEqual(["Locks — geometry & pose", "Audio"]);
    expect(document.body.textContent).toContain("Geometry & camera lock");
    expect(document.body.textContent).toContain("Preserve EXACTLY, pixel-for-pixel");
    expect(document.body.textContent).toContain("No music");
  });

  it("fallback-to-copy fires with its toast when no prompt field is active", async () => {
    await openShelf();
    await act(async () => { entryButton("No music").click(); });
    expect(clipboardWrites).toEqual([SEEDED_PROMPT_SNIPPETS[2].body]);
    const toast = document.querySelector(".snippets-toast");
    expect(toast?.textContent).toContain("Copied");
    expect(toast?.textContent).toContain("No music");
    // Shelf stays open (nothing was inserted anywhere).
    expect(document.querySelector(".snippets-shelf")).not.toBeNull();
  });

  it("the copy icon always copies, even with a prompt field active", async () => {
    function Wrapper(): ReactElement {
      const [v, setV] = useState("prompt here");
      return createElement("div", null,
        createElement("textarea", { className: "prod-edit-prompt", value: v, onChange: (e: { target: { value: string } }) => setV(e.target.value) }),
        createElement(SnippetsShelfHost),
      );
    }
    mount(createElement(Wrapper));
    await flush();
    const ta = host!.querySelector("textarea") as HTMLTextAreaElement;
    act(() => { ta.focus(); ta.setSelectionRange(6, 6); });
    act(() => openSnippetsShelf());
    await flush();
    const copyBtn = document.querySelector('button[aria-label="Copy No music"]') as HTMLButtonElement;
    await act(async () => { copyBtn.click(); });
    expect(clipboardWrites).toEqual([SEEDED_PROMPT_SNIPPETS[2].body]);
    expect(ta.value).toBe("prompt here");
  });

  it("search filters entries by name/body", async () => {
    await openShelf();
    const search = document.querySelector(".snippets-search input") as HTMLInputElement;
    act(() => setNativeValue(search, "character swap"));
    await flush();
    expect(document.body.textContent).toContain("Character swap — pose lock");
    expect(document.body.textContent).not.toContain("Geometry & camera lock");
    act(() => setNativeValue(search, "diegetic"));
    await flush();
    expect(document.body.textContent).toContain("No music");
    expect(document.body.textContent).not.toContain("Character swap");
  });

  it("clicking a snippet with an active editor inserts, closes, and refocuses", async () => {
    const handle = createRef<PromptContentHandle>();
    let latest = "shot: ";
    function Wrapper(): ReactElement {
      const [v, setV] = useState(latest);
      latest = v;
      return createElement("div", null,
        createElement(PromptContentEditor, { text: v, onChange: (t: string) => setV(t), ref: handle }),
        createElement(SnippetsShelfHost),
      );
    }
    mount(createElement(Wrapper));
    await flush();
    const box = host!.querySelector(".prompt-content-editor") as HTMLElement;
    act(() => { box.focus(); setEditorSelection(box, 6); document.dispatchEvent(new Event("selectionchange")); });
    act(() => openSnippetsShelf());
    await flush();
    await act(async () => { entryButton("No music").click(); });
    expect(latest).toBe(`shot: ${SEEDED_PROMPT_SNIPPETS[2].body}`);
    expect(clipboardWrites).toEqual([]);
    expect(document.activeElement).toBe(box);
    expect(document.querySelector(".snippets-shelf")).toBeNull();
  });
});

/* ---------- managing the library ---------- */

describe("snippet add / edit / delete", () => {
  async function openShelf() {
    mount(createElement(SnippetsShelfHost));
    await flush();
    act(() => openSnippetsShelf());
    await flush();
  }

  function formFields() {
    const inputs = [...document.querySelectorAll(".snippets-field input")] as HTMLInputElement[];
    const body = document.querySelector(".snippets-field textarea") as HTMLTextAreaElement;
    return { name: inputs[0], category: inputs[1], body };
  }

  it("add via the form persists and survives a store restart", async () => {
    await openShelf();
    act(() => buttonByText("New").click());
    await flush();
    const f = formFields();
    act(() => {
      setNativeValue(f.name, "Rain lock");
      setNativeValue(f.category, "Weather");
      setNativeValue(f.body, "Rain falls [heavily] throughout.");
    });
    await act(async () => { buttonByText("Add snippet").click(); });
    await flush();
    expect(persisted?.some((s) => s.name === "Rain lock" && s.category === "Weather")).toBe(true);
    expect(document.body.textContent).toContain("Rain lock");

    // Restart: forget the cache, re-prime from (fake) settings on disk.
    resetSnippetStoreForTests();
    await act(async () => { await primePromptSnippets(); });
    expect(getSnippets().some((s) => s.name === "Rain lock")).toBe(true);
  });

  it("edit changes a seeded snippet and persists; delete removes it for good", async () => {
    await openShelf();
    const editBtn = document.querySelector('button[aria-label="Edit No music"]') as HTMLButtonElement;
    act(() => editBtn.click());
    await flush();
    const f = formFields();
    expect(f.body.value).toBe(SEEDED_PROMPT_SNIPPETS[2].body);
    act(() => setNativeValue(f.body, "Edited: silence please."));
    await act(async () => { buttonByText("Save changes").click(); });
    await flush();
    expect(persisted?.find((s) => s.id === "seed-no-music")?.body).toBe("Edited: silence please.");

    const delBtn = document.querySelector('button[aria-label="Delete No music"]') as HTMLButtonElement;
    act(() => delBtn.click());
    await flush();
    await act(async () => { buttonByText("Delete?").click(); });
    await flush();
    expect(persisted?.some((s) => s.id === "seed-no-music")).toBe(false);

    resetSnippetStoreForTests();
    await act(async () => { await primePromptSnippets(); });
    expect(getSnippets().some((s) => s.id === "seed-no-music")).toBe(false);
    expect(getSnippets()).toHaveLength(2);
  });

  it("save-selection pre-fills the add form with the selected prompt text", async () => {
    const handle = createRef<PromptContentHandle>();
    function Wrapper(): ReactElement {
      const [v, setV] = useState("keep this exact framing please");
      return createElement("div", null,
        createElement(PromptContentEditor, { text: v, onChange: (t: string) => setV(t), ref: handle }),
        createElement(SnippetsShelfHost),
      );
    }
    mount(createElement(Wrapper));
    await flush();
    const box = host!.querySelector(".prompt-content-editor") as HTMLElement;
    act(() => { box.focus(); setEditorSelection(box, 0, 23); });
    act(() => {
      box.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
    });
    await flush();
    const menuBtn = buttonByText("Save selection as snippet");
    await act(async () => { menuBtn.click(); });
    await flush();
    const f = formFields();
    expect(f.body.value).toBe("keep this exact framing");
    expect(f.name.value).toBe("");
    // Finish the save: name + category are all that's left to fill.
    act(() => { setNativeValue(f.name, "Framing"); setNativeValue(f.category, "Locks — geometry & pose"); });
    await act(async () => { buttonByText("Add snippet").click(); });
    await flush();
    expect(persisted?.some((s) => s.name === "Framing" && s.body === "keep this exact framing")).toBe(true);
  });

  it("no context menu without a selection", async () => {
    function Wrapper(): ReactElement {
      const [v, setV] = useState("some prompt");
      return createElement(PromptContentEditor, { text: v, onChange: (t: string) => setV(t) });
    }
    mount(createElement(Wrapper));
    const box = host!.querySelector(".prompt-content-editor") as HTMLElement;
    act(() => { box.focus(); setEditorSelection(box, 3); });
    act(() => { box.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    expect(document.querySelector(".snippets-context-menu")).toBeNull();
  });
});
