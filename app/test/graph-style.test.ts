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
import { createElement, Fragment, useRef, useState } from "react";
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

function Harness({ initialPrompt, initialConnected, initialStyle, editNodes }: {
  initialPrompt: string;
  initialConnected?: boolean;
  initialStyle?: string;
  editNodes?: any[];
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [prod, setProd] = useState(() => makeProd(initialPrompt, { graphStyleConnected: initialConnected ?? true, style: initialStyle, ...(editNodes ? { graphEditNodes: editNodes } : {}) }));
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
    const patch: Record<string, unknown> = { style: styleId || undefined, styleNone: !styleId };
    if (nextPrompt !== target.prompt) { patch.prompt = nextPrompt; patch.promptManual = nextManual; }
    setProd((p: any) => makeProd(nextPrompt ?? "", { graphStyleConnected: p.scenes[0].shots[0].graphStyleConnected, style: styleId || undefined, ...(p.scenes[0].shots[0].graphEditNodes ? { graphEditNodes: p.scenes[0].shots[0].graphEditNodes } : {}), ...patch }));
    if (nextPrompt !== basePrompt) {
      setPrompt(nextPrompt ?? "");
      if (nextPrompt != null) cacheRef.current[SHOT] = nextPrompt;
    }
  };

  const onPromptChange = (v: string) => {
    setPrompt(v);
    cacheRef.current[SHOT] = v;
    // Mirrors saveShotPrompt: only the prompt changes — style/styleNone and the
    // node graph survive (a live-draft composer rewrite must not reset them).
    setProd((p: any) => ({ ...p, scenes: p.scenes.map((sc: any) => ({ ...sc, shots: sc.shots.map((s: any) => s.id === SHOT ? { ...s, prompt: v, promptManual: true } : s) })) }));
  };

  const onGraphField = (patch: Record<string, unknown>) => {
    setProd((p: any) => ({ ...p, scenes: p.scenes.map((sc: any) => ({ ...sc, shots: sc.shots.map((s: any) => s.id === SHOT ? { ...s, ...patch } : s) })) }));
  };

  // Simulates editing the style's description on the Design page — the live
  // style text changes with no node-graph interaction at all.
  const setStyleText = (t: string) => {
    setProd((p: any) => ({ ...p, styles: p.styles.map((s: any, i: number) => (i === 0 ? { ...s, prompt: t } : s)) }));
  };

  const onStyleDetached = () => {
    setProd((p: any) => ({ ...p, scenes: p.scenes.map((sc: any) => ({ ...sc, shots: sc.shots.map((s: any) => s.id === SHOT ? { ...s, style: undefined } : s) })) }));
  };

  const shot = prod.scenes[0].shots[0];
  return createElement(Fragment, null,
    createElement("button", { className: "test-set-style-text", onClick: () => setStyleText("Updated cinematic style") }, "set style text"),
    createElement(NodeGraphModal, {
    prod, shot, bust: 0, prompt,
    references: [{ id: "r1", name: "Hero", artwork: "data:image/png;base64,AAAA" }] as never,
    styles: prod.styles, styleValue: shot.styleNone ? "" : (shot.style ?? prod.styles[0].id ?? ""), includeBrand: true,
    onPromptChange, onStyleChange: setGraphStyle, onToggleBrand: () => {}, onDropFile: () => {},
    onStyleDetached, imageModels: [], videoModels: [],
    defaultImageModel: "auto", defaultImageResolution: "1k",
    onRunImageGen: async () => {}, onRunVideoGen: async () => {}, onRunEditGen: async () => {},
    onSelectGraphGen: () => {}, onCycleGraphGen: () => {}, onGraphField,
    onPipeImageToVideo: () => {}, onPipeImageToOutput: () => {}, onPipeVideoToOutput: () => {}, onPipeEditToOutput: () => {}, onPipeRefToOutput: () => {},
    onUnpipeImageGen: () => {}, onUnpipeImageToVideo: () => {}, onUnpipeVideoGen: () => {}, onUnpipeEditGen: () => {}, onUnpipeOutput: () => {},
    onSaveLayout: () => {}, onClose: () => {},
  } as never));
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
/** The connected edit prompt node's Style box / content box. */
function editStyleBox(host: HTMLDivElement): HTMLTextAreaElement | null {
  return host.querySelector(".prod-graph-editprompt textarea[placeholder*='Visual style']") as HTMLTextAreaElement | null;
}
function editContentBox(host: HTMLDivElement): HTMLElement | null {
  return host.querySelector(".prod-graph-editprompt .prompt-content-editor") as HTMLElement | null;
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

describe("node-graph style node → edit nodes", () => {
  const EDIT_PROMPT = `Style: ${STYLE_TEXT}\n\nmake it blue`;

  it("mirrors the selected style into a connected edit node and strips it on None", async () => {
    const { root, host } = render({ editNodes: [{ id: "edit0", prompt: EDIT_PROMPT, styleConnected: true }] });
    await flush();
    expect(editStyleBox(host)?.value).toBe(STYLE_TEXT);
    act(() => { const sel = styleSelect(host); sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(editStyleBox(host)?.value ?? "").toBe("");
    expect(editContentBox(host)?.textContent ?? "").toContain("make it blue");
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("mirrors a Design-page style text change into a connected edit node", async () => {
    const { root, host } = render({ editNodes: [{ id: "edit0", prompt: EDIT_PROMPT, styleConnected: true }] });
    await flush();
    expect(editStyleBox(host)?.value).toBe(STYLE_TEXT);
    // No node-graph interaction — the Design page's style description changes.
    act(() => { (host.querySelector(".test-set-style-text") as HTMLButtonElement).click(); });
    await flush();
    expect(editStyleBox(host)?.value).toBe("Updated cinematic style");
    expect(editContentBox(host)?.textContent ?? "").toContain("make it blue");
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("leaves an unplugged edit node's own Style paragraph untouched", async () => {
    const { root, host } = render({ editNodes: [{ id: "edit0", prompt: "Style: Node's own look\n\nmake it blue", styleConnected: false }] });
    await flush();
    expect(editStyleBox(host)?.value).toBe("Node's own look");
    act(() => { const sel = styleSelect(host); sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(editStyleBox(host)?.value).toBe("Node's own look");
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("re-adds the live style after None on a connected edit node", async () => {
    const { root, host } = render({ editNodes: [{ id: "edit0", prompt: EDIT_PROMPT, styleConnected: true }] });
    await flush();
    act(() => { const sel = styleSelect(host); sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(editStyleBox(host)?.value ?? "").toBe("");
    act(() => { const sel = styleSelect(host); sel.value = STYLE_ID; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(editStyleBox(host)?.value).toBe(STYLE_TEXT);
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});