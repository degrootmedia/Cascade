/**
 * Regression: the prompt Content box is a contenteditable whose `@[Name]`
 * references render as atomic chips. Editing it must feel like a word
 * processor around those chips:
 *  - Backspace/Delete beside a chip deletes ONE character (the space), never
 *    the whole reference block; deleting INTO a chip removes the whole chip.
 *  - Ctrl+Z / Ctrl+Shift+Z step through the editor's own undo history (the
 *    browser's is destroyed by every plain-text rebuild).
 *  - The @ autocomplete inserts THROUGH the editor (`insertRefTag`), so the
 *    insertion never arrives as an external rebuild that resets the caret.
 */
import { describe, it, expect } from "vitest";
import { createElement, createRef, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { PromptContentEditor, type PromptContentHandle } from "../src/renderer/src/components/PromptContentEditor.js";

const INITIAL = "A hero @[Gandalf] walks";

interface Harness {
  root: Root;
  host: HTMLDivElement;
  box: HTMLElement;
  value: () => string;
  handle: { current: PromptContentHandle | null };
  setExternal: (v: string) => void;
}

function renderEditor(initial: string, defer = false): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const handle = createRef<PromptContentHandle>();
  let latest = initial;
  let setExternal!: (v: string) => void;
  function Wrapper(): ReactElement {
    const [v, setV] = useState(initial);
    latest = v;
    setExternal = setV;
    return createElement(PromptContentEditor, {
      text: v,
      onChange: (t: string) => setV(t),
      deferExternalWhileFocused: defer,
      ref: handle,
    });
  }
  act(() => { root.render(createElement(Wrapper)); });
  const box = host.querySelector(".prompt-content-editor") as HTMLElement;
  return { root, host, box, value: () => latest, handle, setExternal: (v) => setExternal(v) };
}

/** Serialized-text caret offset within the box (-1 when the selection is out). */
function caretOffset(box: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return -1;
  const range = sel.getRangeAt(0);
  if (!box.contains(range.startContainer)) return -1;
  const pre = document.createRange();
  pre.selectNodeContents(box);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function setCaret(node: Node, offset: number) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

function key(box: HTMLElement, k: string, mods: KeyboardEventInit = {}) {
  act(() => {
    box.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
  });
}

function dispose(h: Harness) {
  act(() => { h.root.unmount(); });
  document.body.removeChild(h.host);
}

describe("PromptContentEditor reference-block editing", () => {
  it("Backspace before a chip deletes the space, not the reference", () => {
    const h = renderEditor(INITIAL);
    // Caret at offset 7 — right after "A hero " (the trailing space), before the chip.
    setCaret(h.box.childNodes[0] as Node, 7);
    key(h.box, "Backspace");
    expect(h.value()).toBe("A hero@[Gandalf] walks");
    expect(h.box.textContent).toBe("A hero@[Gandalf] walks");
    dispose(h);
  });

  it("Backspace right after a chip removes the whole chip", () => {
    const h = renderEditor(INITIAL);
    // The trailing text node " walks" starts at the chip's end.
    setCaret(h.box.childNodes[2] as Node, 0);
    key(h.box, "Backspace");
    expect(h.value()).toBe("A hero  walks");
    dispose(h);
  });

  it("forward Delete before a chip removes the whole chip", () => {
    const h = renderEditor(INITIAL);
    setCaret(h.box.childNodes[0] as Node, 7);
    key(h.box, "Delete");
    expect(h.value()).toBe("A hero  walks");
    dispose(h);
  });

  it("undo/redo steps through edits", () => {
    const h = renderEditor(INITIAL);
    setCaret(h.box.childNodes[0] as Node, 7);
    key(h.box, "Backspace");
    expect(h.value()).toBe("A hero@[Gandalf] walks");
    key(h.box, "z", { ctrlKey: true });
    expect(h.value()).toBe("A hero @[Gandalf] walks");
    key(h.box, "z", { ctrlKey: true, shiftKey: true });
    expect(h.value()).toBe("A hero@[Gandalf] walks");
    dispose(h);
  });

  it("insertRefTag replaces an open @query in place", () => {
    const h = renderEditor("Add @");
    setCaret(h.box.childNodes[0] as Node, "Add @".length);
    act(() => { h.handle.current?.insertRefTag("Gandalf"); });
    expect(h.value()).toBe("Add @[Gandalf]");
    expect(h.box.textContent).toBe("Add @[Gandalf]");
    dispose(h);
  });

  it("focusAfterTag lands the caret right after an externally added block", () => {
    const h = renderEditor("A hero walks");
    // The node graph adds the tag from outside and asks for the caret after it.
    act(() => {
      h.handle.current?.focusAfterTag("Gandalf");
      h.setExternal("A hero @[Gandalf] walks");
    });
    expect(h.box.textContent).toBe("A hero @[Gandalf] walks");
    expect(caretOffset(h.box)).toBe("A hero @[Gandalf]".length);
    dispose(h);
  });
});