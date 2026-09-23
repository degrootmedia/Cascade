/**
 * Image Suite tests: the session validator (path confinement + cap pruning),
 * the atomic session store round-trip, and the IPC-boundary path rejection.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-suite-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));

import {
  emptySuiteSession,
  isProductionRelative,
  normalizeSuiteSession,
  pruneSuiteSession,
  SUITE_ENTRY_CAP,
  type SuiteEntry,
} from "../src/shared/ipc/suite.js";
import { loadSuiteSession, saveSuiteSession, removeSuiteEntry, uniqueSuiteRel, imageExtFor } from "../src/main/suite.js";
import { validateIpcArgs } from "../src/shared/ipc-schemas.js";

function entry(id: string, overrides: Partial<SuiteEntry> = {}): SuiteEntry {
  return {
    id,
    parentId: null,
    kind: "generate",
    createdAt: new Date(1700000000000 + Number(id.replace(/\D/g, "")) * 1000).toISOString(),
    model: "openart:foo",
    resolution: "1k",
    prompt: "a test image",
    promptRefs: [],
    outputPath: `out/suite/${id}.png`,
    refIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("isProductionRelative", () => {
  it("accepts nested production-relative paths", () => {
    expect(isProductionRelative("out/suite/a.png")).toBe(true);
    expect(isProductionRelative("references/ref 1.jpg")).toBe(true);
  });
  it("rejects traversal, absolute, and drive-letter paths", () => {
    expect(isProductionRelative("../secrets.png")).toBe(false);
    expect(isProductionRelative("out/../../etc/passwd")).toBe(false);
    expect(isProductionRelative("/etc/passwd")).toBe(false);
    expect(isProductionRelative("C:/Windows/x.png")).toBe(false);
    expect(isProductionRelative("")).toBe(false);
    expect(isProductionRelative("a\0b")).toBe(false);
  });
});

describe("normalizeSuiteSession", () => {
  it("drops entries whose paths escape the production root", () => {
    const s = normalizeSuiteSession({
      version: 1,
      entries: [entry("1"), entry("2", { outputPath: "../evil.png" }), entry("3")],
      selectedId: "2",
      draft: { mode: "edit", prompt: "hi", model: "m", resolution: "1k", refIds: [] },
    });
    expect(s.entries.map((e) => e.id)).toEqual(["1", "3"]);
    // A selection pointing at a dropped entry resets.
    expect(s.selectedId).toBeNull();
    expect(s.draft.mode).toBe("edit");
  });

  it("returns an empty session for garbage input", () => {
    expect(normalizeSuiteSession(null)).toEqual(emptySuiteSession());
    expect(normalizeSuiteSession("nope")).toEqual(emptySuiteSession());
  });

  it("preserves the upscale mode on entries and the draft", () => {
    const s = normalizeSuiteSession({
      version: 1,
      entries: [entry("1", { kind: "upscale", sourcePath: "boards/0100/frame.jpg", prompt: "" })],
      selectedId: "1",
      draft: { mode: "upscale", prompt: "", model: "higgsfield-cli:bytedance_image_upscale", resolution: "4k", refIds: [] },
    });
    expect(s.entries[0].kind).toBe("upscale");
    expect(s.draft.mode).toBe("upscale");
  });

  it("carries sourcePath only when production-relative", () => {
    const s = normalizeSuiteSession({
      version: 1,
      entries: [entry("1", { sourcePath: "boards/0100/frame.jpg" }), entry("2", { sourcePath: "../x.jpg" })],
      selectedId: null,
      draft: { mode: "edit", prompt: "", model: "", resolution: "1k", refIds: [], sourcePath: "../draft.jpg" },
    });
    expect(s.entries[0].sourcePath).toBe("boards/0100/frame.jpg");
    expect(s.entries[1].sourcePath).toBeUndefined();
    expect(s.draft.sourcePath).toBeUndefined();
  });
});

describe("pruneSuiteSession", () => {
  it("drops oldest leaf entries down to the cap", () => {
    const entries = Array.from({ length: SUITE_ENTRY_CAP + 12 }, (_, i) => entry(`e${String(i).padStart(4, "0")}`));
    const pruned = pruneSuiteSession({ version: 1, entries, selectedId: entries[0].id, draft: emptySuiteSession().draft });
    expect(pruned.entries).toHaveLength(SUITE_ENTRY_CAP);
    // The oldest were removed; the newest survive.
    expect(pruned.entries.some((e) => e.id === "e0000")).toBe(false);
    expect(pruned.entries.some((e) => e.id === `e${String(SUITE_ENTRY_CAP + 11).padStart(4, "0")}`)).toBe(true);
    expect(pruned.selectedId).toBeNull();
  });

  it("leaves a session within the cap untouched", () => {
    const s = { version: 1 as const, entries: [entry("1")], selectedId: "1", draft: emptySuiteSession().draft };
    expect(pruneSuiteSession(s)).toBe(s);
  });
});

describe("suite session store", () => {
  it("round-trips a session through save + load", () => {
    const s = { version: 1 as const, entries: [entry("1")], selectedId: "1", draft: { ...emptySuiteSession().draft, prompt: "draft text" } };
    saveSuiteSession("p1", s);
    const loaded = loadSuiteSession("p1");
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.selectedId).toBe("1");
    expect(loaded.draft.prompt).toBe("draft text");
    // Atomic write leaves no temp files.
    const files = fs.readdirSync(`${dataDir}/suites`);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("removes one entry and clears a dangling selection", () => {
    saveSuiteSession("p2", { version: 1, entries: [entry("1"), entry("2")], selectedId: "1", draft: emptySuiteSession().draft });
    const next = removeSuiteEntry("p2", "1");
    expect(next.entries.map((e) => e.id)).toEqual(["2"]);
    expect(next.selectedId).toBeNull();
  });

  it("returns an empty session for an unknown production", () => {
    expect(loadSuiteSession("missing")).toEqual(emptySuiteSession());
  });
});

describe("suite output helpers", () => {
  it("suffixes a taken filename", () => {
    const taken = new Set(["out/suite/Suite.png", "out/suite/Suite (2).png"]);
    expect(uniqueSuiteRel("out/suite", "Suite", "png", (r) => taken.has(r))).toBe("out/suite/Suite (3).png");
  });
  it("detects image formats from magic bytes", () => {
    expect(imageExtFor(Buffer.from([0xff, 0xd8, 0xff]))).toBe("jpg");
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
    expect(imageExtFor(webp)).toBe("webp");
    expect(imageExtFor(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe("png");
  });
});

describe("suite IPC validation", () => {
  it("rejects a saveSession payload with a traversal path", () => {
    const payload = { version: 1, entries: [entry("1", { outputPath: "../evil.png" })], selectedId: null, draft: emptySuiteSession().draft };
    expect(() => validateIpcArgs("suite:saveSession", ["p1", payload])).toThrow(/production-relative/);
  });
  it("accepts a well-formed saveSession payload", () => {
    const payload = { version: 1, entries: [entry("1")], selectedId: "1", draft: emptySuiteSession().draft };
    expect(() => validateIpcArgs("suite:saveSession", ["p1", payload])).not.toThrow();
  });
});

describe("suite vendor-blindness", () => {
  it("never names a vendor or imports a main-side provider module", () => {
    const suiteDir = path.resolve(__dirname, "../src/renderer/src/features/suite");
    const files = fs.readdirSync(suiteDir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    const forbidden: Array<[RegExp, string]> = [
      [/higgsfield(-cli)?:/i, "no vendor-namespaced id literals"],
      [/openart-cli:/i, "no vendor-namespaced id literals"],
      [/from\s+["'][^"']*\/main\//, "no main-process imports"],
      [/PROVIDER_CAPABILITIES|PROVIDER_META/, "no direct registry access"],
    ];
    const violations: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(suiteDir, f), "utf8");
      src.split("\n").forEach((line, i) => {
        for (const [re, why] of forbidden) {
          if (re.test(line)) violations.push(`${f}:${i + 1} ${why} :: ${line.trim()}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
