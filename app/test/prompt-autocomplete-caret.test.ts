/**
 * Regression: picking an entry from the side panel's @ autocomplete must insert
 * the `@[Name]` reference block AND leave the caret active right after it, so
 * the user can keep typing without clicking back into the box.
 */
import { describe, it, expect } from "vitest";
import { createElement, useRef, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ReferencePromptEditor } from "../src/renderer/src/components/production/prompt-panel.js";
import type { PromptReference } from "../src/renderer/src/components/production/references.js";

const REFS: PromptReference[] = [{ id: "r1", name: "Gandalf", artwork: "" }];

interface H {
  root: Root;
  host: HTMLDivElement;
  box: HTMLElement;
  value: () => string;
}

function renderEditor(initial: string): H {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let latest = initial;
  function Wrapper(): ReactElement {
    const [v, setV] = useState(initial);
    latest = v;
    // A per-shot editor is keyed by shot in the real app; the ref is internal.
    useRef(null);
    return createElement(ReferencePromptEditor, {
      value: v,
      includeBrand: false,
      onChange: (next: string) => setV(next),
      references: REFS,
      className: "prod-prompt-drawer-text",
      rows: 12,
      placeholder: "type @",
    });
  }
  act(() => { root.render(createElement(Wrapper)); });
  const box = host.querySelector(".prompt-content-editor") as HTMLElement;
  return { root, host, box, value: () => latest };
}

function setCaret(node: Node, offset: number) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

function caretOffset(host: HTMLElement): number {
  const box = host.querySelector(".prompt-content-editor") as HTMLElement;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return -1;
  const range = sel.getRangeAt(0);
  if (!box.contains(range.startContainer)) return -1;
  const pre = document.createRange();
  pre.selectNodeContents(box);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

describe("side-panel @ autocomplete keeps the caret after the block", () => {
  it("inserts the reference and leaves a collapsed caret immediately after it", () => {
    const h = renderEditor("");
    // Type "@" at the caret.
    act(() => {
      h.box.textContent = "@";
      setCaret(h.box.firstChild as Node, 1);
      h.box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const menuBtn = document.querySelector(".prod-ref-autocomplete button") as HTMLButtonElement;
    expect(menuBtn).toBeTruthy();
    act(() => {
      menuBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(h.value()).toBe("@[Gandalf]");
    expect(h.box.textContent).toBe("@[Gandalf]");
    // Caret sits at the very end (right after the inserted block).
    expect(caretOffset(h.host)).toBe("@[Gandalf]".length);
    act(() => { h.root.unmount(); });
    document.body.removeChild(h.host);
  });

  it("keeps the caret after the block when text follows the @query", () => {
    const h = renderEditor("A hero @ walks");
    // Put the caret right after the "@" (offset before " walks").
    const first = h.box.childNodes[0] as Node;
    act(() => {
      setCaret(first, "A hero @".length);
    });
    // Open the autocomplete by re-dispatching an input.
    act(() => {
      h.box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const menuBtn = document.querySelector(".prod-ref-autocomplete button") as HTMLButtonElement;
    expect(menuBtn).toBeTruthy();
    act(() => {
      menuBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(h.value()).toBe("A hero @[Gandalf] walks");
    expect(caretOffset(h.host)).toBe("A hero @[Gandalf]".length);
    act(() => { h.root.unmount(); });
    document.body.removeChild(h.host);
  });
});