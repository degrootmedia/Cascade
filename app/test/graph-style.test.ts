/**
 * Regression tests for the node-graph style bugs:
 * 1. Changing the style dropdown to "None" must remove the Style section from
 *    the prompt that is submitted for generation — even when the composer
 *    holds an unsynced draft (the blur-sync race) and even when the edge is
 *    detached but a leftover paragraph survives.
 * 2. Choosing a style rewrites the Style paragraph of a plugged prompt.
 *
 * The harness mirrors ProductionWorkspace.setGraphStyle / onGraphField /
 * onPromptChange / onStyleDetached and the prompt cache, so the real
 * NodeGraphModal is driven through the same seams the app uses.
 */
import { describe, it, expect } from "vitest";
import { createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { NodeGraphModal } from "../src/renderer/src/components/NodeGraphModal.js";
import { addStyleParagraph, removeStyleParagraph } from "../src/shared/prompt-grammar.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = ROStub;
(globalThis as any).window = (globalThis as any).window ?? {};
const gWin = (globalThis as any).window as Record<string, unknown>;
gWin.cascade = {
  boardThumbnail: async () => null,
  videoModelOptions: async () => null,
};

const SHOT = "s1";
const STYLE_ID = "st1";
const STYLE_TEXT = "Heroic 3D render style";
const CONTENT = "hello world";
const BRAND = "Brand identity: Color palette: #123456. Font: Helvetica.";
const WITH_STYLE = `Style: ${STYLE_TEXT}\n\n${CONTENT}\n\n${BRAND}`;

function makeProd(prompt: string, patch?: Record<string, unknown>): any {
  return {
    meta: { id: "p1", name: "T" },
    currentStep: 3,
    openArt: { model: "auto", resolution: "1k" },
    styles: [{ id: STYLE_ID, index: 1, name: "Style 1", prompt: STYLE_TEXT }],
    brand: { colors: [], font: "" },
    references: [{ id: "r1", name: "Hero", imagePath: "references/hero.png" }],
    scenes: [{
      id: "sc1", name: "S",
      shots: [{
        id: SHOT, number: 1, prompt, promptManual: true,
        includeBrandIdentity: true, artwork: "boards/0001.jpg",
        graphStyleConnected: true,
        ...patch,
      }],
    }],
  };
}

function Harness({ initialPrompt, initialConnected, initialStyle }: {
  initialPrompt: string;
  initialConnected?: boolean;
  initialStyle?: string;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [prod, setProd] = useState(() => makeProd(initialPrompt, { graphStyleConnected: initialConnected ?? true, style: initialStyle }));
  const cacheRef = useRef<Record<string, string>>({ [SHOT]: initialPrompt });

  // Mirror of ProductionWorkspace.setGraphStyle (same logic, same seams).
  const setGraphStyle = (styleId: string) => {
    const styleText = prod.styles.find((s: { id: string; prompt: string }) => s.id === styleId)?.prompt.trim() ?? "";
    const target = prod.scenes[0].shots[0];
    const basePrompt = cacheRef.current[SHOT] ?? target.prompt;
    const isPlugged = (flag: boolean | undefined, cur: string | undefined) => flag ?? /^Style:/m.test(cur ?? "");
    const rewritePlugged = (cur: string | undefined, plugged: boolean | undefined): string | undefined => {
      if (cur == null) return cur;
      if (!styleText) return /^Style:/m.test(cur) ? removeStyleParagraph(cur) : cur;
      if (!isPlugged(plugged, cur)) return cur;
      return addStyleParagraph(cur, styleText);
    };
    let nextPrompt: string | undefined = basePrompt;
    let nextManual = target.promptManual;
    const baseIsManual = target.promptManual || !!cacheRef.current[SHOT];
    if (baseIsManual && basePrompt?.trim() && (isPlugged(target.graphStyleConnected, basePrompt) || !styleText)) {
      nextPrompt = styleText ? addStyleParagraph(basePrompt, styleText) : removeStyleParagraph(basePrompt);
      nextManual = true;
    } else if (!target.promptManual && target.graphStyleConnected && styleText) {
      if (!/^Style:/m.test(basePrompt ?? "")) nextPrompt = addStyleParagraph(basePrompt ?? "", styleText);
    }
    const patch: Record<string, unknown> = { style: styleId || undefined };
    if (nextPrompt !== target.prompt) { patch.prompt = nextPrompt; patch.promptManual = nextManual; }
    setProd((p: any) => makeProd(nextPrompt ?? "", { graphStyleConnected: p.scenes[0].shots[0].graphStyleConnected, style: styleId || undefined, ...patch }));
    if (nextPrompt !== basePrompt) {
      setPrompt(nextPrompt ?? "");
      if (nextPrompt != null) cacheRef.current[SHOT] = nextPrompt;
    }
  };

  const onPromptChange = (v: string) => {
    setPrompt(v);
    cacheRef.current[SHOT] = v;
    setProd((p: any) => makeProd(v, { graphStyleConnected: p.scenes[0].shots[0].graphStyleConnected }));
  };

  const onGraphField = (patch: Record<string, unknown>) => {
    setProd((p: any) => ({ ...p, scenes: p.scenes.map((sc: any) => ({ ...sc, shots: sc.shots.map((s: any) => s.id === SHOT ? { ...s, ...patch } : s) })) }));
  };

  const onStyleDetached = () => {
    setProd((p: any) => ({ ...p, scenes: p.scenes.map((sc: any) => ({ ...sc, shots: sc.shots.map((s: any) => s.id === SHOT ? { ...s, style: undefined } : s) })) }));
  };

  const shot = prod.scenes[0].shots[0];
  return createElement(NodeGraphModal, {
    prod, shot, bust: 0, prompt,
    references: [{ id: "r1", name: "Hero", artwork: "data:image/png;base64,AAAA" }] as never,
    styles: prod.styles, styleValue: shot.style ?? prod.styles[0].id ?? "", includeBrand: true,
    onPromptChange, onStyleChange: setGraphStyle, onToggleBrand: () => {}, onDropFile: () => {},
    onStyleDetached, imageModels: [], videoModels: [],
    defaultImageModel: "auto", defaultImageResolution: "1k",
    onRunImageGen: async () => {}, onRunVideoGen: async () => {}, onRunEditGen: async () => {},
    onSelectGraphGen: () => {}, onCycleGraphGen: () => {}, onGraphField,
    onPipeImageToVideo: () => {}, onPipeImageToOutput: () => {}, onPipeVideoToOutput: () => {}, onPipeEditToOutput: () => {}, onPipeRefToOutput: () => {},
    onUnpipeImageGen: () => {}, onUnpipeImageToVideo: () => {}, onUnpipeVideoGen: () => {}, onUnpipeEditGen: () => {}, onUnpipeOutput: () => {},
    onSaveLayout: () => {}, onClose: () => {},
  } as never);
}

function styleSelect(host: HTMLDivElement) { return host.querySelector(".prod-graph-style select") as HTMLSelectElement; }
function contentBox(host: HTMLDivElement) { return host.querySelector(".prompt-content-editor") as HTMLElement; }
/** The composer's composed prompt as the submitted prompt would see it. */
function composerPrompt(host: HTMLDivElement): string {
  const styleBox = host.querySelector("textarea[placeholder*='Visual style']") as HTMLTextAreaElement | null;
  const content = (host.querySelector(".prompt-content-editor") as HTMLElement | null)?.textContent ?? "";
  const brandBox = host.querySelector("textarea[placeholder*='Palette']") as HTMLTextAreaElement | null;
  const paras: string[] = [];
  if (styleBox) paras.push(`Style: ${styleBox.value}`);
  if (content.trim()) paras.push(content);
  if (brandBox) paras.push(`Brand identity: ${brandBox.value}`);
  return paras.join("\n\n");
}
function render(initial: Partial<Parameters<typeof Harness>[0]> = {}): { root: Root; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(Harness, { initialPrompt: WITH_STYLE, ...initial })); });
  return { root, host };
}
function flush() { return act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }

describe("node-graph style dropdown → None", () => {
  it("removes the Style section when the composer is idle", async () => {
    const { root, host } = render();
    await flush();
    act(() => { const sel = styleSelect(host); sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(composerPrompt(host)).not.toContain("Style:");
    expect(composerPrompt(host)).toContain(CONTENT);
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("removes the Style section even when the composer holds an unsynced draft", async () => {
    const { root, host } = render();
    await flush();
    // Real browser timing: typing creates a local draft; the blur handler
    // schedules a syncToParent via setTimeout(0). The timeout fires AFTER the
    // dropdown change (i.e. React's passive effects must not flush first).
    act(() => { contentBox(host).focus(); });
    act(() => { const ed = contentBox(host); ed.textContent = "hellox world"; ed.dispatchEvent(new Event("input", { bubbles: true })); });
    act(() => { styleSelect(host).focus(); });
    const sel = styleSelect(host);
    sel.value = "";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    await flush();
    const submitted = composerPrompt(host);
    expect(submitted).not.toContain("Style:");
    expect(submitted).toContain("hellox world");
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("removes a leftover Style paragraph even when the edge is detached", async () => {
    const { root, host } = render({ initialConnected: false });
    await flush();
    // The edge is detached (graphStyleConnected false) but the prompt still
    // carries a Style paragraph — "None" must still strip it.
    act(() => { const sel = styleSelect(host); sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(composerPrompt(host)).not.toContain("Style:");
    expect(composerPrompt(host)).toContain(CONTENT);
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("choosing a style re-adds the Style paragraph after None", async () => {
    const { root, host } = render();
    await flush();
    // None first — the Style section disappears.
    act(() => { const sel = styleSelect(host); sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(composerPrompt(host)).not.toContain("Style:");
    // Then re-pick the style — it must come back on the plugged prompt.
    act(() => { const sel = styleSelect(host); sel.value = STYLE_ID; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    const submitted = composerPrompt(host);
    expect(submitted).toContain(`Style: ${STYLE_TEXT}`);
    expect(submitted).toContain(CONTENT);
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});