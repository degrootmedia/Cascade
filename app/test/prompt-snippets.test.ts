/**
 * Prompt snippets — the seeded starter library (exact texts), storage
 * resolution/sanitization, the pure insert/placeholder math the shelf
 * applies, settings persistence across a simulated restart, and the IPC
 * wiring pins (renderer method ↔ channel ↔ main handler ↔ validator).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-snippets-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({
  app: { getPath: () => dataDir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}));

import {
  SEEDED_PROMPT_SNIPPETS,
  filterSnippets,
  firstPlaceholderRange,
  groupSnippetsByCategory,
  insertSnippetText,
  resolvePromptSnippets,
  sanitizePromptSnippets,
  snippetPreview,
  type PromptSnippet,
} from "../src/shared/prompt-snippets.js";
import { NO_MUSIC_INSTRUCTION } from "../src/shared/no-music.js";

/** Fresh main-settings module = an app restart against the same userData. */
async function freshSettings() {
  vi.resetModules();
  return import("../src/main/settings.js");
}

const EXPECTED_GEOMETRY =
  "Preserve EXACTLY, pixel-for-pixel in position and proportion:\n" +
  "- The camera angle, framing, and composition\n" +
  "- The geometry and silhouette of every object\n" +
  "- All product dimensions and proportions\n" +
  "- The pose and placement of every element\n" +
  "- The perspective and depth relationships\n" +
  "\n" +
  "Do NOT move, resize, rotate, add, remove, or reshape anything. Do NOT reframe or crop. Do NOT reinterpret the design. If a detail is ambiguous, keep it exactly as it appears in the source image rather than inventing a new one. The result must overlay perfectly on the original — only the surface look changes.";

const EXPECTED_POSE =
  "The character must adopt the figure's pose EXACTLY:\n" +
  "- Same head position, tilt, and gaze direction\n" +
  "- Same shoulder and hip height and angle\n" +
  "- Same bend in every joint — elbows, knees, wrists, spine\n" +
  "- Same hand and foot placement, feet in the same spots on the ground\n" +
  "- The character occupies the exact same space and silhouette volume as the figure — same height, same reach, nothing stretched, widened, or shrunk\n" +
  "\n" +
  "Do NOT use the pose from the character sheet. Do NOT change the figure's size relative to the scene. Match the scene's existing lighting and keep the contact shadow under the feet.";

describe("seeded starter library", () => {
  it("ships exactly three snippets with the approved names and categories", () => {
    expect(SEEDED_PROMPT_SNIPPETS.map((s) => [s.name, s.category])).toEqual([
      ["Geometry & camera lock", "Locks — geometry & pose"],
      ["Character swap — pose lock", "Locks — geometry & pose"],
      ["No music", "Audio"],
    ]);
    expect(new Set(SEEDED_PROMPT_SNIPPETS.map((s) => s.id)).size).toBe(3);
  });

  it("geometry & camera lock body is verbatim", () => {
    expect(SEEDED_PROMPT_SNIPPETS[0].body).toBe(EXPECTED_GEOMETRY);
  });

  it("character swap pose lock body is verbatim", () => {
    expect(SEEDED_PROMPT_SNIPPETS[1].body).toBe(EXPECTED_POSE);
  });

  it("no-music body matches the submit-time instruction verbatim", () => {
    expect(SEEDED_PROMPT_SNIPPETS[2].body).toBe(NO_MUSIC_INSTRUCTION);
    expect(SEEDED_PROMPT_SNIPPETS[2].body).toBe(
      "No music. Do not add any music or musical score. Audio: diegetic sound only — in-scene sound effects, ambience, and dialogue.",
    );
  });
});

describe("resolvePromptSnippets / sanitizePromptSnippets", () => {
  it("never-stored (null/undefined/non-array) resolves to the seeds", () => {
    for (const v of [null, undefined, {}, "nope", 42]) {
      expect(resolvePromptSnippets(v)).toEqual(SEEDED_PROMPT_SNIPPETS);
    }
  });

  it("an empty stored array stays empty (deleted seeds stay deleted)", () => {
    expect(resolvePromptSnippets([])).toEqual([]);
  });

  it("returns fresh objects (callers cannot mutate the seed constants)", () => {
    const a = resolvePromptSnippets(null);
    a[0].name = "mutated";
    expect(SEEDED_PROMPT_SNIPPETS[0].name).toBe("Geometry & camera lock");
    expect(resolvePromptSnippets(null)[0].name).toBe("Geometry & camera lock");
  });

  it("drops nameless/bodyless entries, defaults the category, dedupes ids", () => {
    const out = sanitizePromptSnippets([
      { id: "a", name: "One", category: "", body: "first" },
      { id: "a", name: "Two", category: "Cat", body: "second" },
      { name: "", category: "Cat", body: "no name" },
      { name: "Three", category: "Cat", body: "   " },
      { name: "Four", body: "fourth" },
      "junk",
      null,
    ]);
    expect(out.map((s) => s.name)).toEqual(["One", "Two", "Four"]);
    expect(out[0].category).toBe("General");
    expect(out[2].category).toBe("General");
    expect(new Set(out.map((s) => s.id)).size).toBe(3);
  });

  it("keeps body interior formatting, trims only the edges", () => {
    const out = sanitizePromptSnippets([{ id: "x", name: "N", category: "C", body: "  line one\n\n- item  \n" }]);
    expect(out[0].body).toBe("line one\n\n- item");
  });
});

describe("insertSnippetText (pure insert math)", () => {
  it("inserts at a collapsed caret and lands the caret after the body", () => {
    const r = insertSnippetText("a hero walks", 7, 7, "brave ");
    expect(r.text).toBe("a hero brave walks");
    expect(r.caret).toBe(13);
    expect(r.placeholder).toBeNull();
  });

  it("replaces a non-collapsed selection", () => {
    const r = insertSnippetText("a hero walks", 2, 6, "villain");
    expect(r.text).toBe("a villain walks");
    expect(r.caret).toBe(9);
  });

  it("appends at the end when the field has no cursor position", () => {
    for (const [s, e] of [[null, null], [undefined, undefined], [Number.NaN, Number.NaN]] as const) {
      const r = insertSnippetText("base", s, e, "+tail");
      expect(r.text).toBe("base+tail");
      expect(r.caret).toBe(9);
    }
  });

  it("clamps out-of-range carets", () => {
    expect(insertSnippetText("abc", 99, 99, "!").text).toBe("abc!");
    expect(insertSnippetText("abc", -5, -5, "!").text).toBe("!abc");
  });

  it("selects the first [placeholder] inside the inserted body", () => {
    const r = insertSnippetText("Style: ", 7, 7, "[describe the style], moody [lighting]");
    expect(r.placeholder).toEqual({ start: 7, end: 27 });
    expect(r.text.slice(r.placeholder!.start, r.placeholder!.end)).toBe("[describe the style]");
  });

  it("does not treat @[Reference] tags as placeholders", () => {
    const r = insertSnippetText("", 0, 0, "@[Hero] in [a location]");
    expect(r.text.slice(r.placeholder!.start, r.placeholder!.end)).toBe("[a location]");
    expect(insertSnippetText("", 0, 0, "@[Hero] walks").placeholder).toBeNull();
  });

  it("only placeholders inside the inserted span count", () => {
    const r = insertSnippetText("[old] text", 10, 10, " plain");
    expect(r.placeholder).toBeNull();
    expect(firstPlaceholderRange("[old] text", 5)).toBeNull();
  });
});

describe("group / filter / preview", () => {
  const lib: PromptSnippet[] = [
    { id: "1", name: "Alpha", category: "Locks", body: "first body" },
    { id: "2", name: "Beta", category: "Audio", body: "second" },
    { id: "3", name: "Gamma", category: "Locks", body: "third" },
  ];

  it("groups by category in first-appearance order", () => {
    const g = groupSnippetsByCategory(lib);
    expect(g.map((x) => x.category)).toEqual(["Locks", "Audio"]);
    expect(g[0].snippets.map((s) => s.id)).toEqual(["1", "3"]);
  });

  it("filters over name, category, and body, case-insensitively", () => {
    expect(filterSnippets(lib, "alpha").map((s) => s.id)).toEqual(["1"]);
    expect(filterSnippets(lib, "SECOND").map((s) => s.id)).toEqual(["2"]);
    expect(filterSnippets(lib, " lock ").map((s) => s.id)).toEqual(["1", "3"]);
    expect(filterSnippets(lib, "")).toHaveLength(3);
    expect(filterSnippets(lib, "zzz")).toEqual([]);
  });

  it("preview collapses whitespace and ellipsizes", () => {
    expect(snippetPreview("line one\n\nline   two")).toBe("line one line two");
    expect(snippetPreview("x".repeat(100), 10)).toBe("xxxxxxxxx…");
  });
});

describe("settings persistence across restart", () => {
  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("first run (no settings file) returns the three seeds", async () => {
    const settings = await freshSettings();
    expect(settings.getPromptSnippets()).toEqual(SEEDED_PROMPT_SNIPPETS);
  });

  it("add/edit/delete survives a fresh module (restart) on the same userData", async () => {
    const first = await freshSettings();
    const lib = first.getPromptSnippets();
    const edited = lib.map((s) => (s.id === "seed-no-music" ? { ...s, body: "Absolutely no music at all." } : s));
    const withNew = [...edited, { id: "user-1", name: "My lock", category: "Mine", body: "Keep [this thing] fixed." }];
    first.setPromptSnippets(withNew);

    const second = await freshSettings();
    const after = second.getPromptSnippets();
    expect(after).toHaveLength(4);
    expect(after.find((s) => s.id === "seed-no-music")?.body).toBe("Absolutely no music at all.");
    expect(after.find((s) => s.id === "user-1")).toEqual({ id: "user-1", name: "My lock", category: "Mine", body: "Keep [this thing] fixed." });

    second.setPromptSnippets(after.filter((s) => s.id !== "seed-geometry-camera-lock"));
    const third = await freshSettings();
    expect(third.getPromptSnippets().map((s) => s.id)).not.toContain("seed-geometry-camera-lock");
    expect(third.getPromptSnippets()).toHaveLength(3);
  });

  it("deleting every snippet persists (seeds do not resurrect)", async () => {
    const first = await freshSettings();
    first.setPromptSnippets([]);
    const second = await freshSettings();
    expect(second.getPromptSnippets()).toEqual([]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
    expect(onDisk.promptSnippets).toEqual([]);
  });

  it("the settings file stores snippets under promptSnippets (global userData)", async () => {
    const settings = await freshSettings();
    settings.setPromptSnippets([{ id: "k", name: "K", category: "C", body: "B" }]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
    expect(onDisk.promptSnippets).toEqual([{ id: "k", name: "K", category: "C", body: "B" }]);
  });
});

describe("snippet IPC wiring", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

  it("renderer API, channel contract, and main handlers all carry both methods", () => {
    expect(read("../src/shared/ipc.ts")).toContain("getPromptSnippets(): Promise<PromptSnippet[]>");
    expect(read("../src/shared/ipc.ts")).toContain("setPromptSnippets(snippets: PromptSnippet[])");
    const channels = read("../src/shared/ipc-channels/workspace.ts");
    expect(channels).toContain('"settings:getPromptSnippets": { method: "getPromptSnippets", kind: "invoke" }');
    expect(channels).toContain('"settings:setPromptSnippets": { method: "setPromptSnippets", kind: "invoke" }');
    const main = read("../src/main/index.ts");
    expect(main).toContain('handle("settings:getPromptSnippets"');
    expect(main).toContain('handle("settings:setPromptSnippets"');
  });

  it("the set channel has a runtime payload validator", () => {
    expect(read("../src/shared/ipc-schemas.ts")).toContain('"settings:setPromptSnippets"');
  });

  it("the shelf is openable from the classic side panel and the node graph header", () => {
    expect(read("../src/renderer/src/components/production/prompt-panel.tsx")).toContain("<SnippetsButton />");
    expect(read("../src/renderer/src/components/NodeGraphModal.tsx")).toContain("<SnippetsButton />");
    expect(read("../src/renderer/src/components/ProductionWorkspace.tsx")).toContain("<SnippetsShelfHost />");
  });

  it("tmp dir sanity (os.tmpdir available)", () => {
    expect(fs.existsSync(os.tmpdir())).toBe(true);
  });
});
