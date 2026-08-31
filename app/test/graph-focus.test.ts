import { describe, it, expect } from "vitest";
import { createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { NodeGraphModal } from "../src/renderer/src/components/NodeGraphModal.js";
class ROStub { observe(){} unobserve(){} disconnect(){} }
;(globalThis as any).ResizeObserver = ROStub;
(globalThis as any).window = (globalThis as any).window ?? {};
const gWin = (globalThis as any).window as Record<string, unknown>;
gWin.cascade = {
  boardThumbnail: async () => null,
  videoModelOptions: async () => null,
};
const P0 = "Style: S\n\nhello world\n\nBrand identity: B";
function makeProd(prompt: string): any {
  return {
    meta: { id: "p1", name: "T" },
    currentStep: 3,
    openArt: { model: "auto", resolution: "1k" },
    styles: [],
    brand: { colors: [], font: "" },
    references: [{ id: "r1", name: "Hero", imagePath: "references/hero.png" }],
    scenes: [{ id: "sc1", name: "S", shots: [{ id: "s1", number: 1, prompt, promptManual: true, includeBrandIdentity: true, artwork: "boards/0001.jpg" }] }],
  };
}
function Harness({ initial }: { initial: string }) {
  const [prompt, setPrompt] = useState(initial);
  const [prod, setProd] = useState(() => makeProd(initial));
  const onPromptChange = (v: string) => {
    setPrompt(v);
    void Promise.resolve().then(() => setProd(makeProd(v)));
  };
  return createElement(NodeGraphModal, {
    prod, shot: prod.scenes[0].shots[0], bust: 0, prompt,
    references: [{ id: "r1", name: "Hero", artwork: "data:image/png;base64,AAAA" }] as never,
    styles: [], styleValue: "", includeBrand: true,
    onPromptChange, onStyleChange: () => {}, onToggleBrand: () => {}, onDropFile: () => {},
    onStyleDetached: () => {}, imageModels: [], videoModels: [],
    defaultImageModel: "auto", defaultImageResolution: "1k",
    onRunImageGen: async () => {}, onRunVideoGen: async () => {}, onRunEditGen: async () => {},
    onSelectGraphGen: () => {}, onCycleGraphGen: () => {}, onGraphField: () => {},
    onPipeImageToVideo: () => {}, onPipeImageToOutput: () => {}, onPipeVideoToOutput: () => {}, onPipeEditToOutput: () => {}, onPipeRefToOutput: () => {},
    onUnpipeImageGen: () => {}, onUnpipeImageToVideo: () => {}, onUnpipeVideoGen: () => {}, onUnpipeEditGen: () => {}, onUnpipeOutput: () => {},
    onSaveLayout: () => {}, onClose: () => {},
  });
}
function contentBox(host: HTMLDivElement) { return host.querySelector(".prompt-content-editor") as HTMLElement; }
function caret(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return -1;
  const r = sel.getRangeAt(0);
  const pre = document.createRange(); pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
describe("focus survives rapid typing", () => {
  it("keeps focus and caret for 4 rapid keystrokes", async () => {
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(Harness, { initial: P0 })); });
    const ed = contentBox(host);
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    // focus and place caret at end of "hello"
    await act(async () => { ed.focus(); });
    await act(async () => {
      const range = document.createRange();
      const tn = ed.firstChild as Node;
      // "hello world" -> after "hello" (5)
      range.setStart(tn, 5);
      range.collapse(true);
      const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
    });
    for (let i = 0; i < 4; i++) {
      const ch = String.fromCharCode(97 + i); // a,b,c,d
      await act(async () => {
        const before = ed.textContent ?? "";
        const pos = caret(ed);
        const next = before.slice(0, pos) + ch + before.slice(pos);
        ed.textContent = next;
        // move caret after inserted char (like browser)
        const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
        let remain = pos + 1, node = walker.nextNode();
        while (node) {
          const len = node.textContent?.length ?? 0;
          if (remain <= len) { const r = document.createRange(); r.setStart(node, remain); r.collapse(true); const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r); break; }
          remain -= len; node = walker.nextNode();
        }
        ed.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
      const isFocused = document.activeElement === ed || ed.contains(document.activeElement as Node) || caret(ed) !== -1;
      console.log(`keystroke ${i} (${ch}): text=${JSON.stringify(ed.textContent?.slice(0, 30))} caret=${caret(ed)} focused=${document.activeElement === ed} isFocused=${isFocused} activeTag=${(document.activeElement as HTMLElement)?.className}`);
      expect(document.activeElement === ed, `lost focus after keystroke ${i}`).toBe(true);
      expect(ed.textContent).toContain(ch);
    }
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});
