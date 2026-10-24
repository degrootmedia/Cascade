/**
 * Reference naming (Item: suite saves ask for a name): the shared sanitizer
 * keeps names tag- and filename-safe, the suggestion derives from the
 * prompt, and the name dialog resolves/validates without a workspace.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { sanitizeReferenceName, referenceNameError, suggestSuiteRefName, nextNumberedRefName } from "../src/shared/ref-names.js";
import { askName, askReferenceSave, NamePromptHost, type ReferenceSaveChoice } from "../src/renderer/src/components/NamePromptDialog.js";

describe("reference name helpers", () => {
  it("sanitizer strips tag/path-hostile characters and collapses space", () => {
    expect(sanitizeReferenceName("  Hero [red] @home /side: view  ")).toBe("Hero red home side view");
    expect(sanitizeReferenceName("a".repeat(80))).toHaveLength(64);
    expect(sanitizeReferenceName("[]@/\\")).toBe("");
  });

  it("validator explains bracket/path/empty problems", () => {
    expect(referenceNameError("")).toMatch(/required/);
    expect(referenceNameError("Hero [1]")).toMatch(/tags/);
    expect(referenceNameError("a/b")).toMatch(/saved file/);
    expect(referenceNameError("Hero pose")).toBeNull();
  });

  it("numbered names start at _001 and take the first free suffix", () => {
    expect(nextNumberedRefName([], "Ref")).toBe("Ref_001");
    expect(nextNumberedRefName(["Ref_001"], "Ref")).toBe("Ref_002");
    expect(nextNumberedRefName(["ref_001", "Ref_002"], "Ref")).toBe("Ref_003");
    expect(nextNumberedRefName(["Image Suite Gen_001"], "Image Suite Gen")).toBe("Image Suite Gen_002");
  });

  it("suggestion comes from the prompt's first line, else Suite", () => {
    expect(suggestSuiteRefName("  A gondola at dawn, wide shot\nmore detail")).toBe("A gondola at dawn, wide shot");
    expect(suggestSuiteRefName("")).toBe("Suite");
    expect(suggestSuiteRefName("@[x] !!!")).toBe("x !!!".replace(/!/g, "!"));
  });
});

describe("NamePromptDialog", () => {
  function mount() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(NamePromptHost)); });
    return { host, root };
  }
  const setValue = (el: HTMLInputElement, v: string) => {
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    proto?.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("resolves the entered name on submit and null on cancel", async () => {
    const { host, root } = mount();
    let result: string | null | undefined;
    let pending!: Promise<string | null>;
    act(() => { pending = askName({ title: "Save as reference", initial: "Hero", validate: referenceNameError }); });
    pending.then((v) => { result = v; });
    const input = document.body.querySelector(".name-prompt-input") as HTMLInputElement;
    expect(input, "name input rendered").toBeTruthy();
    expect(input.value).toBe("Hero");
    await act(async () => { setValue(input, "Hero close-up"); });
    await act(async () => {
      input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await pending;
    });
    expect(result).toBe("Hero close-up");

    let cancelled: string | null | undefined;
    let p2!: Promise<string | null>;
    act(() => { p2 = askName({ title: "Save as reference", initial: "X" }); });
    p2.then((v) => { cancelled = v; });
    const cancel = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Cancel");
    await act(async () => { cancel!.click(); await p2; });
    expect(cancelled).toBeNull();
    act(() => { root.unmount(); });
    host.remove();
  });

  it("shows validation errors inline and does not resolve", async () => {
    const { host, root } = mount();
    let resolved = false;
    let pending!: Promise<string | null>;
    act(() => { pending = askName({ title: "Save as reference", initial: "", validate: referenceNameError }); });
    pending.then(() => { resolved = true; });
    const input = document.body.querySelector(".name-prompt-input") as HTMLInputElement;
    await act(async () => {
      input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(resolved).toBe(false);
    expect(document.body.querySelector(".name-prompt-error")?.textContent).toMatch(/required/);
    act(() => { root.unmount(); });
    host.remove();
  });

  it("reference-save variant resolves name + category, defaulting to Uncategorized", async () => {
    const { host, root } = mount();
    const cats = [{ id: "cat-1", name: "Characters" }, { id: "cat-2", name: "Props" }];
    const setSelect = (el: HTMLSelectElement, v: string) => {
      const proto = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
      proto?.call(el, v);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };

    // Default: Uncategorized (no categoryId), name as pre-filled.
    let first: ReferenceSaveChoice | null | undefined;
    let p1!: Promise<ReferenceSaveChoice | null>;
    act(() => { p1 = askReferenceSave({ title: "Save reference", initialName: "Ref_001", categories: cats }); });
    p1.then((v) => { first = v; });
    const select = document.body.querySelector(".name-prompt-select") as HTMLSelectElement;
    expect(select, "category dropdown rendered").toBeTruthy();
    expect(select.value).toBe("");
    expect([...select.options].map((o) => o.textContent)).toEqual(["Uncategorized", "Characters", "Props"]);
    const input = document.body.querySelector(".name-prompt-input") as HTMLInputElement;
    expect(input.value).toBe("Ref_001");
    await act(async () => {
      input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await p1;
    });
    expect(first).toEqual({ name: "Ref_001", categoryId: undefined });

    // Chosen category + a defaultCategoryId pre-selection.
    let second: ReferenceSaveChoice | null | undefined;
    let p2!: Promise<ReferenceSaveChoice | null>;
    act(() => { p2 = askReferenceSave({ title: "Save reference", initialName: "Hero", categories: cats, defaultCategoryId: "cat-2" }); });
    p2.then((v) => { second = v; });
    const select2 = document.body.querySelector(".name-prompt-select") as HTMLSelectElement;
    expect(select2.value).toBe("cat-2");
    await act(async () => { setSelect(select2, "cat-1"); });
    const input2 = document.body.querySelector(".name-prompt-input") as HTMLInputElement;
    await act(async () => {
      input2.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await p2;
    });
    expect(second).toEqual({ name: "Hero", categoryId: "cat-1" });

    // Cancel resolves null.
    let cancelled: ReferenceSaveChoice | null | undefined;
    let p3!: Promise<ReferenceSaveChoice | null>;
    act(() => { p3 = askReferenceSave({ title: "Save reference", initialName: "X", categories: cats }); });
    p3.then((v) => { cancelled = v; });
    const cancel = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Cancel");
    await act(async () => { cancel!.click(); await p3; });
    expect(cancelled).toBeNull();
    act(() => { root.unmount(); });
    host.remove();
  });
});
