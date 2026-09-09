import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// pipeline.ts imports scripting.ts for text extraction; scripting's dynamic
// pdf-parse import doesn't resolve under Vitest — mock it (same as pipeline.test.ts).
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { assetPath, validateAssetPath } from "../src/main/pipeline.js";
import type { Production } from "../src/shared/ipc.js";

function makeProduction(folder: string): Production {
  return {
    meta: {
      id: "p",
      name: "t",
      folder,
      createdAt: "",
      updatedAt: "",
      stepDone: 0,
      shotCount: 0,
    },
    currentStep: 1,
    visualStyle: "",
    styles: [],
    scenes: [],
    characters: [],
    products: [],
    openArt: { model: "m", resolution: "1k" },
    status: {},
    assets: {
      scriptMd: "script.md",
      boardsDir: "boards",
      voiceoverDir: "voiceover",
      musicDir: "music",
      videosDir: "videos",
      outDir: "out",
      referencesDir: "references",
      assemblyDir: "assembly",
      modelsDir: "models",
    },
  } as unknown as Production;
}

describe("assetPath realpath containment", () => {
  let dir: string;
  let outside: string;
  let p: Production;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-asset-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-asset-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "x");
    p = makeProduction(dir);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("accepts in-folder paths and new creation paths", () => {
    expect(assetPath(p, "boards/a.png")).toBe(path.resolve(dir, "boards/a.png"));
  });
  it("rejects dot-dot escapes", () => {
    expect(() => assetPath(p, "../../etc/passwd")).toThrow("Refusing to touch");
  });
  it("rejects absolute escapes", () => {
    expect(() => assetPath(p, path.join(outside, "secret.txt"))).toThrow("Refusing to touch");
  });
  it("rejects NUL bytes", () => {
    expect(() => assetPath(p, "a\0b")).toThrow("Refusing to touch");
  });
  it("rejects symlink escapes", () => {
    const link = path.join(dir, "evil");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch {
      fs.symlinkSync(outside, link);
    }
    expect(() => assetPath(p, "evil/secret.txt")).toThrow("Refusing to touch");
  });
  it("validateAssetPath requires a non-empty path", async () => {
    await expect(validateAssetPath(p, "")).rejects.toThrow();
    await expect(validateAssetPath(p, "boards/a.png")).resolves.toBe(path.resolve(dir, "boards/a.png"));
  });
});
