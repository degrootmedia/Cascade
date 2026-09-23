/**
 * Settings panel reorg (Spec 05): the registry covers every SettingsView key,
 * fuzzy search ranks the expected sections, deep links select a section, and
 * "Reset section" reverts only that section.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { SettingsView } from "../src/shared/ipc.js";
import { SettingsPanel } from "../src/renderer/src/components/SettingsPanel.js";
import { buildSettingsRegistry } from "../src/renderer/src/components/settings/registry.js";
import { highlightSegments, matchSections } from "../src/renderer/src/components/settings/search.js";
import { sectionFromHash } from "../src/renderer/src/components/settings/open-settings.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Compile-time exhaustiveness guard: if a key is added to `SettingsView` this
 * object stops typechecking, and the runtime assertion below then fails until
 * the key is assigned to a section.
 */
const ALL_SETTINGS_KEYS: Record<keyof SettingsView, true> = {
  provider: true,
  hasApiKey: true,
  model: true,
  workspace: true,
  accent: true,
  externalEditor: true,
  has3daiApiKey: true,
};

describe("settings registry coverage", () => {
  it("every SettingsView key is owned by a section", () => {
    const sections = buildSettingsRegistry().flatMap((c) => c.sections);
    const owned = new Set(sections.flatMap((s) => s.owns));
    for (const key of Object.keys(ALL_SETTINGS_KEYS)) {
      expect(owned.has(key as keyof SettingsView)).toBe(true);
    }
    // No section may claim a key outside SettingsView.
    const valid = new Set(Object.keys(ALL_SETTINGS_KEYS));
    for (const s of sections) for (const k of s.owns) expect(valid.has(k)).toBe(true);
  });

  it("has unique section ids and every section belongs to its category", () => {
    const registry = buildSettingsRegistry();
    const ids = registry.flatMap((c) => c.sections.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of registry) {
      for (const section of category.sections) expect(section.category).toBe(category.id);
    }
  });
});

describe("settings search", () => {
  const registry = buildSettingsRegistry();
  const ranked = (q: string) => matchSections(registry, q).flatMap((g) => g.sections.map((s) => s.section.id));

  it("maps the acceptance queries to the right section first", () => {
    expect(ranked("api key")[0]).toBe("providers");
    expect(ranked("accent")[0]).toBe("appearance");
    expect(ranked("cli")[0]).toBe("cli-tools");
  });

  it("drops categories with no match and returns [] for nonsense", () => {
    expect(ranked("zzzzq")).toEqual([]);
  });

  it("keeps registry order when the query is empty", () => {
    const ids = ranked("");
    expect(ids[0]).toBe("appearance");
    expect(ids.length).toBeGreaterThan(10);
  });

  it("highlights matching runs of a label", () => {
    const segs = highlightSegments("Accent color", "accent");
    expect(segs.some((s) => s.hit && s.text.toLowerCase() === "accent")).toBe(true);
    expect(highlightSegments("Accent color", "zzz")).toEqual([{ text: "Accent color", hit: false }]);
  });

  it("parses #settings deep links", () => {
    expect(sectionFromHash("#settings/providers")).toBe("providers");
    expect(sectionFromHash("#settings/cli-tools")).toBe("cli-tools");
    expect(sectionFromHash("#something")).toBeUndefined();
  });
});

/* ---------- deep link + reset (mounted) ---------- */

const gWin = (globalThis as any).window as Record<string, any>;
const writes: Array<[string, unknown]> = [];

const VIEW: SettingsView = {
  provider: "gab",
  hasApiKey: false,
  model: "arya",
  workspace: null,
  accent: "#4f8ef7",
  externalEditor: null,
  has3daiApiKey: false,
};

function installCascade() {
  writes.length = 0;
  gWin.cascade = {
    getSettings: async () => VIEW,
    listMediaProviders: async () => [],
    getMediaProvider: async () => "openart",
    getHiggsfieldCliBinary: async () => null,
    getHiggsfieldCliStatus: async () => null,
    getOpenArtCliBinary: async () => null,
    getOpenArtCliStatus: async () => null,
    getMcpConfig: async () => "",
    getMcpStatus: async () => [],
    getMcpOnDemand: async () => [],
    getDevMode: async () => false,
    getSubmissionDryRun: async () => false,
    getHiddenMediaModels: async () => [],
    listModels: async () => ({ ok: true, models: [] }),
    setProvider: async (id: string) => { writes.push(["setProvider", id]); },
    setModel: async (id: string) => { writes.push(["setModel", id]); },
    setAccent: async (c: string) => { writes.push(["setAccent", c]); },
    setExternalEditor: async (p: string | null) => { writes.push(["setExternalEditor", p]); },
    set3daiApiKey: async (k: string) => { writes.push(["set3daiApiKey", k]); },
    clearDefaultWorkspace: async () => { writes.push(["clearDefaultWorkspace", null]); },
    openSkillsFolder: async () => {},
    openSubmissionLog: async () => {},
  };
}

async function mount(hash: string) {
  installCascade();
  gWin.location.hash = hash;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(SettingsPanel, { settings: VIEW, onClose: () => {} })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { container, root };
}

function activeTabId(container: HTMLElement): string | null {
  const active = container.querySelector(".settings-rail-item.active");
  return active?.id.replace("settings-tab-", "") ?? null;
}

describe("settings deep link", () => {
  it("opens the section named in the hash", async () => {
    const { container, root } = await mount("#settings/providers");
    expect(activeTabId(container)).toBe("providers");
    const panel = container.querySelector("#settings-panel-providers") as HTMLElement;
    expect(panel.hidden).toBe(false);
    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("falls back to the first section for an unknown deep link", async () => {
    const { container, root } = await mount("#settings/nope");
    expect(activeTabId(container)).toBe("appearance");
    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("selects a section from the rail and resets only that section", async () => {
    const { container, root } = await mount("#settings/appearance");
    // Click the Providers tab.
    const providersTab = container.querySelector("#settings-tab-providers") as HTMLButtonElement;
    await act(async () => { providersTab.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(activeTabId(container)).toBe("providers");

    // "Reset section" reverts the providers section only.
    const resetBtn = Array.from(container.querySelectorAll(".settings-pane-head button")).find((b) => b.textContent === "Reset section") as HTMLButtonElement;
    await act(async () => { resetBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(writes).toContainEqual(["setProvider", "gab"]);
    expect(writes.some(([k]) => k === "setAccent")).toBe(false);

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });
});
