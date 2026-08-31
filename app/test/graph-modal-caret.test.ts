/**
 * High-fidelity reproduction: renders the REAL NodeGraphModal (full modal, not
 * just nodeTypes) and simulates the ProductionWorkspace save round trip — every
 * keystroke is echoed back through `prompt` AND followed by an async `setProd`
 * with a fresh production object (new references identity), exactly like
 * `saveShotPrompt` → `updateBoardPrompt` → `setProd(next)` does in the app.
 */
import { describe, it, expect } from "vitest";
import { createElement, useEffect, useRef, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { NodeGraphModal } from "../src/renderer/src/components/NodeGraphModal.js";

class ROStub { observe(): void {} unobserve(): void {} disconnect(): void {} }
(globalThis as Record<string, unknown>).ResizeObserver = ROStub;

// window.cascade stubs the modal touches.
(globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
const g = globalThis as Record<string, unknown>;
const existingWindow = g.window as Record<string, unknown>;
existingWindow.cascade = {
  ...(existingWindow.cascade as object ?? {}),
  boardThumbnail: async () => null,
  videoModelOptions: async () => null,
};

const P0 = "Style: Heroic 3D render style\n\nA hero walks through the valley.\n\nBrand identity: Color palette: #123456. Font: Helvetica.";

/* Minimal Production/GraphRef fixtures — fresh identities on every call to
 * mirror the structured-clone that comes back from the main process. */
function makeProd(prompt: string): Record<string, unknown> {
  return {
    meta: { id: "p1", name: "Test production" },
    currentStep: 3,
    openArt: { model: "auto", resolution: "1k" },
    styles: [],
    brand: { colors: [], font: "" },
    references: [{ id: "r1", name: "Hero", imagePath: "references/hero.png" }],
    scenes: [{
      id: "sc1",
      name: "Scene 1",
      shots: [{
        id: "s1",
        number: 1,
        prompt,
        promptManual: true,
        includeBrandIdentity: true,
        artwork: "boards/0001.jpg",
      }],
    }],
  };
}
function makeRefs(): unknown[] {
  return [{ id: "r1", name: "Hero", artwork: "data:image/png;base64,AAAA" }];
}

function noop(): void {}
async function noopAsync(): Promise<void> {}

function Harness({ initial }: { initial: string }): ReactElement {
  const [prompt, setPrompt] = useState(initial);
  const [prod, setProd] = useState(() => makeProd(initial));
  const savedRef = useRef(initial);
  // Mirrors ProductionWorkspace.onPromptChange: sync focusedPrompt update +
  // queued async save whose setProd(next) swaps in a fresh production object.
  const onPromptChange = (v: string) => {
    setPrompt(v);
    savedRef.current = v;
    void Promise.resolve().then(() => {
      setProd(makeProd(savedRef.current));
    });
  };
  // Mirrors the graph open effect: a late getBoardPrompt resolving with the
  // DISK text (arrives after the user has already typed) — controlled by tests
  // through the ref below.
  const lateFetch = useRef<(() => void) | null>(null);
  lateFetchRef.current = (diskText: string) => { setPrompt(diskText); };
  return createElement(NodeGraphModal, {
    prod: prod as never,
    shot: (prod as { scenes: { shots: unknown[] }[] }).scenes[0].shots[0] as never,
    bust: 0,
    prompt,
    references: makeRefs() as never,
    styles: [],
    styleValue: "",
    includeBrand: true,
    onPromptChange,
    onStyleChange: noop,
    onToggleBrand: noop,
    onDropFile: noop,
    onStyleDetached: noop,
    imageModels: [],
    videoModels: [],
    defaultImageModel: "auto",
    defaultImageResolution: "1k",
    onRunImageGen: noopAsync,
    onRunVideoGen: noopAsync,
    onRunEditGen: noopAsync,
    onSelectGraphGen: noop,
    onCycleGraphGen: noop,
    onGraphField: noop,
    onPipeImageToVideo: noop,
    onPipeImageToOutput: noop,
    onPipeVideoToOutput: noop,
    onPipeEditToOutput: noop,
    onPipeRefToOutput: noop,
    onUnpipeImageGen: noop,
    onUnpipeImageToVideo: noop,
    onUnpipeVideoGen: noop,
    onUnpipeEditGen: noop,
    onUnpipeOutput: noop,
    onSaveLayout: noop,
    onClose: noop,
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lateFetchRef: { current: ((diskText: string) => void) | null } = { current: null };

function flush(ms = 0): Promise<void> {
  return act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

function renderModal(initial: string): { root: Root; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(Harness, { initial })); });
  return { root, host };
}

function styleBox(host: HTMLDivElement): HTMLTextAreaElement {
  return host.querySelector(".prod-graph-composer .prod-prompt-box.side") as HTMLTextAreaElement;
}
function contentBox(host: HTMLDivElement): HTMLElement {
  return host.querySelector(".prod-graph-composer .prompt-content-editor") as HTMLElement;
}
function contentCaret(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return -1;
  const r = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}

describe("NodeGraphModal composer caret (full modal + save round trip)", () => {
  it("keeps the caret in the Style box across the async prod round trip", async () => {
    const { root, host } = renderModal(P0);
    const ta = styleBox(host);
    expect(ta).toBeTruthy();
    expect(ta.value).toBe("Heroic 3D render style");

    await flush();
    act(() => { ta.focus(); ta.setSelectionRange(6, 6); });
    // Type "x" at caret 6 (browser-accurate: prototype setter + selection + input).
    act(() => {
      const before = ta.value;
      const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), "value")?.set;
      proto?.call(ta, before.slice(0, 6) + "x" + before.slice(6));
      ta.setSelectionRange(7, 7);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ta.value).toBe("Heroicx 3D render style");
    expect(ta.selectionStart).toBe(7);

    // The async setProd round trip + references identity churn.
    await flush();
    await flush();
    expect(ta.value).toBe("Heroicx 3D render style");
    expect(ta.selectionStart).toBe(7);

    // Second keystroke after the round trip settled.
    act(() => {
      const before = ta.value;
      const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), "value")?.set;
      proto?.call(ta, before.slice(0, 7) + "y" + before.slice(7));
      ta.setSelectionRange(8, 8);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    expect(ta.value).toBe("Heroicxy 3D render style");
    expect(ta.selectionStart).toBe(8);

    await flush();
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("keeps the caret in the Content box across the async prod round trip", async () => {
    const { root, host } = renderModal(P0);
    const ed = contentBox(host);
    expect(ed).toBeTruthy();
    expect(ed.textContent).toBe("A hero walks through the valley.");

    await flush();
    act(() => { ed.focus(); });
    act(() => {
      const range = document.createRange();
      range.setStart(ed.firstChild as Node, 6);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    expect(contentCaret(ed)).toBe(6);
    // Type "x" at caret 6.
    act(() => {
      const before = ed.textContent ?? "";
      ed.textContent = before.slice(0, 6) + "x" + before.slice(6);
      const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
      let remain = 7;
      let node = walker.nextNode();
      while (node) {
        const len = node.textContent?.length ?? 0;
        if (remain <= len) {
          const nr = document.createRange();
          nr.setStart(node, remain);
          nr.collapse(true);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(nr);
          break;
        }
        remain -= len;
        node = walker.nextNode();
      }
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ed.textContent).toBe("A herox walks through the valley.");
    expect(contentCaret(ed)).toBe(7);

    // Async setProd round trip + churn.
    await flush();
    await flush();
    expect(ed.textContent).toBe("A herox walks through the valley.");
    expect(contentCaret(ed)).toBe(7);

    await flush();
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("defers a late external prompt overwrite while the user is focused", async () => {
    const { root, host } = renderModal(P0);
    const ta = styleBox(host);
    await flush();
    act(() => { ta.focus(); ta.setSelectionRange(6, 6); });
    act(() => {
      const before = ta.value;
      const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), "value")?.set;
      proto?.call(ta, before.slice(0, 6) + "x" + before.slice(6));
      ta.setSelectionRange(7, 7);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ta.value).toBe("Heroicx 3D render style");

    // A late getBoardPrompt fetch resolves with the pre-edit disk text while
    // the box is still focused — the local edit must stay authoritative.
    act(() => { lateFetchRef.current?.("Style: Heroic 3D render style\n\nA hero walks through the valley.\n\nBrand identity: Color palette: #123456. Font: Helvetica."); });
    await flush();
    expect(ta.value).toBe("Heroicx 3D render style");
    expect(ta.selectionStart).toBe(7);

    await flush();
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("keeps the caret in the Content box next to an @[Name] chip across the round trip", async () => {
    const P_TAG = "Style: Heroic 3D render style\n\nA hero walks with @[Hero] through the valley.\n\nBrand identity: Color palette: #123456. Font: Helvetica.";
    const { root, host } = renderModal(P_TAG);
    const ed = contentBox(host);
    expect(ed).toBeTruthy();
    // The tag renders as a non-editable chip between two text nodes.
    expect(ed.textContent).toBe("A hero walks with @[Hero] through the valley.");
    expect((ed.querySelector(".prompt-tag-chip") as HTMLElement)?.textContent).toBe("@[Hero]");

    await flush();
    act(() => { ed.focus(); });
    // Caret at the START of the text node AFTER the chip (offset 0 = right
    // after "@[Hero] ") — the classic Chromium caret position next to a chip.
    act(() => {
      const chip = ed.querySelector(".prompt-tag-chip") as HTMLElement;
      const after = chip.nextSibling as Text;
      const range = document.createRange();
      range.setStart(after, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    expect(contentCaret(ed)).toBe("A hero walks with @[Hero]".length);
    // Type "x" right after the chip — Chromium inserts it into the following
    // text node, often as a SPLIT (new text node). Simulate both the insert
    // and the node split.
    act(() => {
      const chip = ed.querySelector(".prompt-tag-chip") as HTMLElement;
      const after = chip.nextSibling as Text;
      after.splitText(0); // Chromium-style node split: "x" | " through the valley."
      after.textContent = "x" + after.textContent;
      const range = document.createRange();
      range.setStart(after, 1);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ed.textContent).toBe("A hero walks with @[Hero]x through the valley.");
    expect(contentCaret(ed)).toBe("A hero walks with @[Hero]x".length);

    // Async setProd round trip + churn.
    await flush();
    await flush();
    expect(ed.textContent).toBe("A hero walks with @[Hero]x through the valley.");
    expect(contentCaret(ed)).toBe("A hero walks with @[Hero]x".length);

    await flush();
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("keeps the caret when the content ENDS with a chip and the user types after it", async () => {
    // addRefTag appends tags as their own trailing paragraph — typing at the
    // very end lands right after the chip.
    const P_TRAILING = "Style: Heroic 3D render style\n\nA hero walks through the valley.\n\n@[Hero]\n\nBrand identity: Color palette: #123456. Font: Helvetica.";
    const { root, host } = renderModal(P_TRAILING);
    const ed = contentBox(host);
    expect(ed.textContent).toBe("A hero walks through the valley.\n\n@[Hero]");

    await flush();
    act(() => { ed.focus(); });
    act(() => {
      // Caret at the end of the box (after the trailing chip).
      const range = document.createRange();
      range.selectNodeContents(ed);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    const end = ed.textContent?.length ?? 0;
    expect(contentCaret(ed)).toBe(end);
    act(() => {
      const chip = ed.querySelector(".prompt-tag-chip") as HTMLElement;
      const after = (chip.nextSibling ?? document.createTextNode("")) as Text;
      if (!chip.nextSibling) ed.appendChild(after);
      after.textContent = (after.textContent ?? "") + "!";
      const range = document.createRange();
      range.setStart(after, after.textContent!.length);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ed.textContent).toBe("A hero walks through the valley.\n\n@[Hero]!");
    expect(contentCaret(ed)).toBe(end + 1);

    await flush();
    await flush();
    expect(contentCaret(ed)).toBe(end + 1);

    await flush();
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });
});
