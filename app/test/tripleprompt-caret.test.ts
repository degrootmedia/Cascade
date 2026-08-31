/**
 * Regression: typing in a TriplePrompt box inside the node graph must keep the
 * caret where the user left it. The node graph derives its node data in a
 * post-commit effect, so the `value` prop reaches TriplePrompt one render LATE
 * after the parent echoes our edit back. That stale echo must not re-decompose
 * the boxes (which resets the textarea value and drops the caret to the end).
 * This harness reproduces the exact lag: `value` is updated from `focused` in
 * an effect, like the node graph's reconcile effect.
 */
import { describe, it, expect } from "vitest";
import { createElement, useEffect, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { TriplePrompt } from "../src/renderer/src/components/TriplePrompt.js";

const INITIAL = "Style: Heroic 3D render style\n\nA hero walks through the valley.\n\nBrand identity: Color palette: #123456, #789abc. Font: Helvetica.";
const WITH_TAG = "Style: Heroic 3D render style\n\nA hero walks with @[Gandalf] through the valley.\n\nBrand identity: Color palette: #123456. Font: Helvetica.";

function LagHarness({ initial, defer }: { initial: string; defer?: boolean }): ReactElement {
  const [focused, setFocused] = useState(initial);
  const [nodeValue, setNodeValue] = useState(initial);
  // The node graph reconciles derived node data in an effect — the value that
  // reaches TriplePrompt lags the parent's state by one render.
  useEffect(() => {
    setNodeValue(focused);
  }, [focused]);
  return createElement(TriplePrompt, {
    value: nodeValue,
    includeBrand: true,
    className: "test-box",
    sideRows: 3,
    deferExternalWhileFocused: defer,
    onChange: (v: string) => setFocused(v),
  });
}

/** Focus in its own act (a real click is a separate event from the keystroke),
 *  so React's controlled-input restore sees a settled prop. */
function focusTextarea(ta: HTMLTextAreaElement) {
  act(() => { ta.focus(); });
}

/** Type one character into a textarea at a given caret position, exactly as a
 *  browser does: the value is inserted AND the caret lands after the inserted
 *  character before the input event reaches React. Setting `.value` through
 *  the prototype setter (not React's tracked override) simulates the browser's
 *  internal value write, so React's change detection fires onChange. */
function setTextareaValue(ta: HTMLTextAreaElement, value: string) {
  const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), "value")?.set;
  proto?.call(ta, value);
}

function typeChar(ta: HTMLTextAreaElement, caret: number, char: string) {
  act(() => {
    const before = ta.value;
    setTextareaValue(ta, before.slice(0, caret) + char + before.slice(caret));
    ta.setSelectionRange(caret + 1, caret + 1);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function renderHarness(initial: string): { root: Root; host: HTMLDivElement; textarea: HTMLTextAreaElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(LagHarness, { initial })); });
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  return { root, host, textarea };
}

describe("TriplePrompt caret preservation (node-graph lag)", () => {
  it("keeps the caret after a character typed into the Style box", () => {
    const { root, host, textarea } = renderHarness(INITIAL);
    // Style box value is "Heroic 3D render style"; type "x" at index 6 (after "Heroic").
    const caret = 6;
    focusTextarea(textarea);
    typeChar(textarea, caret, "x");
    expect(textarea.value).toBe("Heroicx 3D render style");
    expect(textarea.selectionStart).toBe(caret + 1);
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("keeps the caret mid-text with the node composer's focus-deferral active", () => {
    // The real composer passes `deferExternalWhileFocused` and echoes edits
    // back through the parent — type at caret 6, then again at caret 10.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(LagHarness, { initial: INITIAL, defer: true })); });
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    focusTextarea(textarea);
    typeChar(textarea, 6, "x");
    expect(textarea.value).toBe("Heroicx 3D render style");
    expect(textarea.selectionStart).toBe(7);
    typeChar(textarea, 10, "y");
    expect(textarea.value).toBe("Heroicx 3Dy render style");
    expect(textarea.selectionStart).toBe(11);
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("keeps the caret across several characters typed mid-text", () => {
    const { root, host, textarea } = renderHarness(INITIAL);
    focusTextarea(textarea);
    let caret = 6;
    typeChar(textarea, caret, "x");
    caret += 1;
    typeChar(textarea, caret, "y");
    caret += 1;
    expect(textarea.value).toBe("Heroicxy 3D render style");
    expect(textarea.selectionStart).toBe(caret);
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("keeps the caret after typing into the Content box (contenteditable)", () => {
    const { root, host } = renderHarness(INITIAL);
    const box = host.querySelector(".prompt-content-editor") as HTMLElement;
    expect(box).toBeTruthy();
    act(() => {
      box.textContent = "A hero walks through the valleyx.";
      const range = document.createRange();
      range.setStart(box.firstChild as Node, "A hero walks through the valley".length);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The box must NOT have been rebuilt (rebuild drops the caret to the end).
    expect(box.textContent).toBe("A hero walks through the valleyx.");
    const sel = window.getSelection();
    expect(sel?.getRangeAt(0).startOffset).toBe("A hero walks through the valley".length);
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("keeps the caret typing into the Content box next to an @[Name] chip", () => {
    const { root, host } = renderHarness(WITH_TAG);
    const box = host.querySelector(".prompt-content-editor") as HTMLElement;
    expect(box).toBeTruthy();
    act(() => {
      // Insert a character right after "with " (before the @[Gandalf] chip).
      const caret = "A hero walks with ".length;
      box.textContent = "A hero walks with x@[Gandalf] through the valley.";
      const range = document.createRange();
      const textNode = box.childNodes[1] ?? box.firstChild;
      range.setStart(textNode as Node, caret);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The serialized text keeps the character; the box must not rebuild.
    expect(box.textContent).toBe("A hero walks with x@[Gandalf] through the valley.");
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("preserves the caret across a rebuild of the Content box while focused", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let setExternal!: (v: string) => void;
    function ExternalHarness(): ReactElement {
      const [value, setValue] = useState(INITIAL);
      setExternal = setValue;
      return createElement(TriplePrompt, {
        value,
        includeBrand: true,
        className: "test-box",
        sideRows: 3,
        onChange: () => { /* external parent never echoes edits */ },
      });
    }
    act(() => { root.render(createElement(ExternalHarness)); });
    const box = host.querySelector(".prompt-content-editor") as HTMLElement;

    // Focus and place the caret mid-text.
    act(() => { box.focus(); });
    act(() => {
      const caret = "A hero walks ".length;
      const range = document.createRange();
      range.setStart(box.firstChild as Node, caret);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });

    // An external value change forces a rebuild of the box — the caret must
    // stay at the user's position, not jump to the end.
    act(() => { setExternal("Style: Neon cyberpunk\n\nA hero walks through the valley slowly.\n\nBrand identity: Neon. Font: Mono."); });
    expect(box.textContent).toBe("A hero walks through the valley slowly.");
    const sel = window.getSelection();
    expect(sel?.getRangeAt(0).startOffset).toBe(13);

    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });
});