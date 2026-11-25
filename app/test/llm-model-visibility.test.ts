/**
 * Feature #9 — the Model Customizer also hides/shows LLM models.
 * Covers: the pure filter, settings persistence across a simulated restart
 * (stored next to hiddenMediaModels, which stays untouched), the IPC wiring
 * pins, the customizer's LLM tab writing the hidden list, and the header
 * model picker leaving hidden LLMs out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-llm-vis-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({
  app: { getPath: () => dataDir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}));

import { LLM_VISIBILITY_EVENT, sanitizeHiddenLlmModels, visibleLlmModels } from "../src/shared/llm-visibility.js";
import { ModelPicker } from "../src/renderer/src/components/ModelPicker.js";
import { ModelCustomizer } from "../src/renderer/src/components/ModelCustomizer.js";

async function freshSettings() {
  vi.resetModules();
  return import("../src/main/settings.js");
}

const llm = (id: string, baseCost = 1) => ({
  id, thinking: false, vision: false, baseCost, costLabel: String(baseCost), costTitle: "", costKind: "per-message" as const, costTier: null,
});

describe("visibleLlmModels / sanitizeHiddenLlmModels", () => {
  it("drops hidden ids and keeps the rest in order", () => {
    const ms = [llm("a"), llm("b"), llm("c")];
    expect(visibleLlmModels(ms, ["b"]).map((m) => m.id)).toEqual(["a", "c"]);
    expect(visibleLlmModels(ms, new Set<string>()).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
  it("sanitizes stored ids", () => {
    expect(sanitizeHiddenLlmModels([" a ", "a", "", 3, "b"])).toEqual(["a", "b"]);
    expect(sanitizeHiddenLlmModels("nope")).toEqual([]);
  });
});

describe("hidden LLM persistence", () => {
  beforeEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  it("hide and show survive a restart, stored beside (not inside) hiddenMediaModels", async () => {
    const first = await freshSettings();
    expect(first.getHiddenLlmModels()).toEqual([]);
    first.setHiddenMediaModels(["higgsfield-cli:kling-2"]);
    first.setHiddenLlmModels(["grok-4", "claude-x"]);

    const second = await freshSettings();
    expect(second.getHiddenLlmModels()).toEqual(["grok-4", "claude-x"]);
    expect(second.getHiddenMediaModels()).toEqual(["higgsfield-cli:kling-2"]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
    expect(onDisk.hiddenLlmModels).toEqual(["grok-4", "claude-x"]);
    expect(onDisk.hiddenMediaModels).toEqual(["higgsfield-cli:kling-2"]);

    // Show one again.
    second.setHiddenLlmModels(["claude-x"]);
    const third = await freshSettings();
    expect(third.getHiddenLlmModels()).toEqual(["claude-x"]);
    expect(third.getHiddenMediaModels()).toEqual(["higgsfield-cli:kling-2"]);
  });
});

describe("hidden LLM IPC wiring", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");
  it("renderer API, channel contract, main handlers and validator carry both methods", () => {
    expect(read("../src/shared/ipc.ts")).toContain("getHiddenLlmModels(): Promise<string[]>");
    expect(read("../src/shared/ipc.ts")).toContain("setHiddenLlmModels(ids: string[]): Promise<void>");
    const channels = read("../src/shared/ipc-channels/workspace.ts");
    expect(channels).toContain('"settings:getHiddenLlmModels": { method: "getHiddenLlmModels", kind: "invoke" }');
    expect(channels).toContain('"settings:setHiddenLlmModels": { method: "setHiddenLlmModels", kind: "invoke" }');
    const main = read("../src/main/index.ts");
    expect(main).toContain('handle("settings:getHiddenLlmModels"');
    expect(main).toContain('handle("settings:setHiddenLlmModels"');
    expect(read("../src/shared/ipc-schemas.ts")).toContain('"settings:setHiddenLlmModels"');
  });
  it("every LLM picker filters hidden models", () => {
    expect(read("../src/renderer/src/App.tsx")).toMatch(/<ModelPicker[\s\S]*?hidden=\{hiddenLlmModels\}/);
    expect(read("../src/renderer/src/App.tsx")).toMatch(/<AgentsPanel[^\n]*hidden=\{hiddenLlmModels\}/);
    expect(read("../src/renderer/src/components/AgentsPanel.tsx")).toContain("visibleLlmModels(allModels, hidden ?? [])");
    expect(read("../src/renderer/src/components/settings/sections/ModelsSection.tsx")).toContain("visibleLlmModels(sortedModels, hiddenLlm)");
  });
});

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = ROStub;
const gWin = (globalThis as any).window as Record<string, unknown>;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("Model Customizer LLM tab", () => {
  it("lists LLMs with an eye toggle; hiding/showing persists and notifies pickers", async () => {
    let stored: string[] = [];
    const writes: string[][] = [];
    const empty = async () => ({});
    gWin.cascade = {
      listMediaProviders: async () => [{ id: "higgsfield-cli", displayName: "Higgsfield CLI", available: true }],
      getModelOptionExposure: empty, getModelSurfaces: empty, getModelParamDefaults: empty, getModelKindOverrides: empty,
      getHiddenMediaModels: async () => ["higgsfield-cli:kling-2"],
      setHiddenMediaModels: vi.fn(async () => {}),
      getMediaModelOrder: async () => [], getExpensePriceRules: async () => [], listAllMediaModels: async () => [],
      probeModels: async () => ({ provider: "higgsfield-cli", displayName: "Higgsfield CLI", available: true, models: [] }),
      probeModelOptions: async () => null,
      listModels: async () => ({ ok: true, models: [llm("grok-4", 2), llm("mini", 1)] }),
      getHiddenLlmModels: async () => stored,
      setHiddenLlmModels: async (ids: string[]) => { stored = ids; writes.push(ids); },
    };
    let notified = 0;
    const onChange = () => { notified++; };
    window.addEventListener(LLM_VISIBILITY_EVENT, onChange);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(ModelCustomizer, { onClose: () => {} })); });
    await flush();

    const tab = Array.from(container.querySelectorAll(".mc-provider")).find((b) => b.textContent?.includes("LLM models")) as HTMLElement;
    expect(tab).toBeTruthy();
    await act(async () => { tab.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();

    const rows = () => Array.from(container.querySelectorAll(".mc-llm-row"));
    expect(rows().map((r) => r.querySelector(".mc-model-name")?.textContent)).toEqual(["mini", "grok-4"]);

    const eye = rows()[1].querySelector(".mc-eye") as HTMLElement;
    await act(async () => { eye.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(writes.at(-1)).toEqual(["grok-4"]);
    expect(rows()[1].className).toContain("hidden-model");
    expect(notified).toBe(1);

    const eye2 = rows()[1].querySelector(".mc-eye") as HTMLElement;
    await act(async () => { eye2.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(writes.at(-1)).toEqual([]);
    expect(rows()[1].className).not.toContain("hidden-model");
    // The media hidden list was never written by the LLM tab.
    expect((gWin.cascade as { setHiddenMediaModels: ReturnType<typeof vi.fn> }).setHiddenMediaModels).not.toHaveBeenCalled();

    window.removeEventListener(LLM_VISIBILITY_EVENT, onChange);
    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("the header model picker leaves hidden LLMs out of its menu", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (hidden: Set<string>) =>
      act(async () => {
        root.render(createElement(ModelPicker, { models: [llm("grok-4", 2), llm("mini", 1)], hidden, current: "mini", disabled: false, onChange: () => {} }));
      });
    await render(new Set(["grok-4"]));
    await act(async () => { (container.querySelector(".model-button") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const names = () => Array.from(container.querySelectorAll(".model-option .model-name")).map((n) => n.textContent);
    expect(names()).toEqual(["mini"]);
    await render(new Set());
    expect(names()).toEqual(["mini", "grok-4"]);
    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });
});
