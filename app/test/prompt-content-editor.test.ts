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

function paste(box: HTMLElement, text: string) {
  act(() => {
    const ev = new window.Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    ev.clipboardData = { getData: (type: string) => (type === "text/plain" ? text : "") };
    box.dispatchEvent(ev);
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

  it("deleting the spaces before a tag moves it to the start without losing the caret", () => {
    const h = renderEditor("  @[Gandalf] walks");
    act(() => { h.box.focus(); });
    // Caret right before the chip (after the two spaces).
    setCaret(h.box.childNodes[0] as Node, 2);
    key(h.box, "Backspace");
    expect(h.value()).toBe(" @[Gandalf] walks");
    expect(caretOffset(h.box)).toBe(1);
    key(h.box, "Backspace");
    expect(h.value()).toBe("@[Gandalf] walks");
    // The caret must still live inside the box, at the very start — losing
    // it (offset -1) is the reported "cursor loses focus" failure.
    expect(caretOffset(h.box)).toBe(0);
    expect(h.box.contains(document.activeElement) || document.activeElement === h.box).toBe(true);
    dispose(h);
  });

  it("deleting text before a tag char-by-char keeps the caret glued to the edit point", () => {
    const h = renderEditor("A @[Gandalf] walks");
    act(() => { h.box.focus(); });
    setCaret(h.box.childNodes[0] as Node, 2);
    key(h.box, "Backspace"); // the space
    expect(h.value()).toBe("A@[Gandalf] walks");
    expect(caretOffset(h.box)).toBe(1);
    key(h.box, "Backspace"); // the "A" — the tag is now at the start
    expect(h.value()).toBe("@[Gandalf] walks");
    expect(caretOffset(h.box)).toBe(0);
    dispose(h);
  });

  it("Backspace at the very start (tag first) is a harmless no-op", () => {
    const h = renderEditor("@[Gandalf] walks");
    act(() => { h.box.focus(); });
    // Caret at 0: the box's first child is the chip; anchor on the box itself.
    setCaret(h.box, 0);
    key(h.box, "Backspace");
    expect(h.value()).toBe("@[Gandalf] walks");
    expect(caretOffset(h.box)).toBe(0);
    dispose(h);
  });

  it("deleting runs of spaces mid-text keeps the caret at the deletion point", () => {
    const h = renderEditor("A hero   walks @[Gandalf]");
    act(() => { h.box.focus(); });
    setCaret(h.box.childNodes[0] as Node, 9); // after the three spaces
    key(h.box, "Backspace");
    key(h.box, "Backspace");
    expect(h.value()).toBe("A hero walks @[Gandalf]");
    expect(caretOffset(h.box)).toBe(7);
    dispose(h);
  });

  it("a tag at the very start keeps an editable text anchor before the chip", () => {
    // Chromium cannot hold a caret before a leading contenteditable=false
    // element: with the chip as first child there is nowhere for the
    // selection to land, which reads as "cursor loses focus". The box must
    // always keep a (possibly empty) text node ahead of a leading chip, and
    // restored carets must never anchor inside chip text.
    const h = renderEditor("@[Gandalf] walks");
    expect(h.box.childNodes[0]?.nodeType).toBe(3); // text anchor, not the chip
    act(() => { h.handle.current?.setSelectionRange(0, 0); });
    const sel = window.getSelection();
    const anchor = sel?.getRangeAt(0).startContainer as Node;
    expect((anchor as HTMLElement).parentElement?.classList.contains("prompt-tag-chip") ?? false).toBe(false);
    expect(caretOffset(h.box)).toBe(0);
    dispose(h);
  });

  it("setSelectionRange into the middle of a chip clamps to a chip boundary, never inside it", () => {
    const h = renderEditor("A hero @[Gandalf] walks");
    act(() => { h.handle.current?.setSelectionRange(10, 10); }); // inside "@[Gandalf]" (7..16)
    const range = window.getSelection()?.getRangeAt(0);
    const container = range?.startContainer as Node;
    const insideChip = (container as HTMLElement).parentElement?.classList.contains("prompt-tag-chip") ?? false;
    expect(insideChip).toBe(false);
    const off = caretOffset(h.box);
    expect(off === 7 || off === 16).toBe(true);
    dispose(h);
  });

  it("pasting a prompt with @[Name] tags renders them as chips immediately", () => {
    const h = renderEditor("Intro: ");
    act(() => { h.box.focus(); });
    setCaret(h.box.childNodes[0] as Node, "Intro: ".length);
    paste(h.box, "@[Gandalf] walks with @[Frodo]");
    expect(h.value()).toBe("Intro: @[Gandalf] walks with @[Frodo]");
    expect(h.box.textContent).toBe("Intro: @[Gandalf] walks with @[Frodo]");
    const chips = h.box.querySelectorAll(".prompt-tag-chip");
    expect(chips.length).toBe(2);
    expect(chips[0].textContent).toBe("@[Gandalf]");
    expect(chips[1].textContent).toBe("@[Frodo]");
    expect(caretOffset(h.box)).toBe("Intro: @[Gandalf] walks with @[Frodo]".length);
    dispose(h);
  });

  it("pasting over a selection replaces it and still chip-ifies pasted tags", () => {
    const h = renderEditor("Replace me entirely");
    act(() => { h.box.focus(); });
    const range = document.createRange();
    range.selectNodeContents(h.box);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    paste(h.box, "A hero @[Gandalf] walks");
    expect(h.value()).toBe("A hero @[Gandalf] walks");
    expect(h.box.querySelectorAll(".prompt-tag-chip").length).toBe(1);
    // The paste is one undo step, like typing/deleting.
    key(h.box, "z", { ctrlKey: true });
    expect(h.value()).toBe("Replace me entirely");
    expect(h.box.querySelectorAll(".prompt-tag-chip").length).toBe(0);
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