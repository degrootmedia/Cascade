/**
 * Folder-only media lookup (Step 7): serving one asset resolves the
 * production folder and validates the relative path inside it — without
 * loading the production document. Traversal outside the folder is refused
 * exactly as the document-based path refuses it.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-folder-lookup-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { assetPathInFolder } from "../src/main/pipeline.js";
import { productionFolder } from "../src/main/productions.js";

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("assetPathInFolder", () => {
  const folder = path.join(dataDir, "prod-a");

  it("resolves a contained asset path", () => {
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    expect(assetPathInFolder(folder, "boards/a.jpg")).toBe(path.resolve(folder, "boards/a.jpg"));
  });

  it("refuses traversal outside the folder", () => {
    expect(() => assetPathInFolder(folder, "../secret.txt")).toThrow(/Refusing to touch outside/);
    expect(() => assetPathInFolder(folder, "")).toThrow(/Refusing to touch outside/);
  });
});

describe("productionFolder", () => {
  it("returns the folder for a known production and null otherwise", () => {
    const dir = path.join(dataDir, "productions");
    fs.mkdirSync(dir, { recursive: true });
    const doc = {
      meta: { id: "pf1", name: "P", folder: "C:/workspace/pf1", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
      currentStep: 1,
      visualStyle: "",
      styles: [],
      scenes: [],
      characters: [],
      products: [],
      openArt: { model: "auto", resolution: "1k" },
      status: {},
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
      schemaVersion: 3,
    };
    fs.writeFileSync(path.join(dir, "pf1.json"), JSON.stringify(doc), "utf8");
    expect(productionFolder("pf1")).toBe("C:/workspace/pf1");
    expect(productionFolder("nope")).toBeNull();
  });
});
