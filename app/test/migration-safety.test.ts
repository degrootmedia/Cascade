/**
 * Legacy migration safety (Step 5): a pre-current production migrates on a
 * copy, is validated, keeps a recoverable pre-migration backup, and a
 * second load changes nothing. Validation rejects broken graph state
 * while preserving unknown node data.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-migration-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { loadProduction, validateMigratedProduction, writePreMigrationBackup } from "../src/main/productions.js";
import type { ProductionFile } from "../src/main/productions.js";

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const storeDir = () => path.join(dataDir, "productions");
const docFile = (id: string) => path.join(storeDir(), `${id}.json`);

function legacyDoc(id: string): Record<string, unknown> {
  return {
    meta: { id, name: "Legacy", folder: "C:/workspace/legacy", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 1 },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: [{ number: 1, title: "S1", shots: [{ id: "s1", number: "0100", audio: "a", visual: "v", prompt: "A quiet shot" }] }],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    schemaVersion: 1,
  };
}

describe("legacy load migration", () => {
  it("migrates once, keeps a pre-migration backup, and a second load changes nothing", () => {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(docFile("legacy1"), JSON.stringify(legacyDoc("legacy1")), "utf8");

    const first = loadProduction("legacy1");
    expect(first?.schemaVersion).toBe(3);
    const shot = first?.scenes[0].shots[0];
    expect(shot?.graph?.nodes.length).toBeGreaterThan(0);

    const backupFile = path.join(storeDir(), "pre-migration", "legacy1-v1.json");
    expect(fs.existsSync(backupFile)).toBe(true);
    const backup = JSON.parse(fs.readFileSync(backupFile, "utf8"));
    expect(backup.schemaVersion).toBe(1);
    expect(backup.scenes[0].shots[0].graph).toBeUndefined();

    const bytesAfterFirst = fs.readFileSync(docFile("legacy1"), "utf8");
    const second = loadProduction("legacy1");
    expect(fs.readFileSync(docFile("legacy1"), "utf8")).toBe(bytesAfterFirst);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("a retry keeps the earliest backup", () => {
    const original = { meta: { id: "keepme" }, schemaVersion: 1 } as unknown as ProductionFile;
    const changed = { meta: { id: "keepme" }, schemaVersion: 1, visualStyle: "changed" } as unknown as ProductionFile;
    const file = writePreMigrationBackup("keepme", 1, original);
    writePreMigrationBackup("keepme", 1, changed);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).visualStyle).toBeUndefined();
  });
});

describe("validateMigratedProduction", () => {
  const shotWith = (over: Partial<ProductionShot>): Production => ({
    scenes: [{ number: 1, title: "S1", shots: [{ id: "s1", number: "0100", audio: "", visual: "", ...over } as ProductionShot] }],
  } as unknown as Production);

  it("accepts a stored graph with an unknown future node kind", () => {
    const p = shotWith({
      graph: {
        version: 1,
        migrated: true,
        nodes: [
          { id: "composer", kind: "composer", pos: { x: 0, y: 0 } },
          { id: "future1", kind: "futureKind" as ProductionShot["graph"] extends { nodes: { kind: infer K }[] } ? K : never, pos: { x: 1, y: 1 } },
        ],
        edges: [],
      },
    });
    expect(() => validateMigratedProduction(p)).not.toThrow();
  });

  it("rejects a dangling edge and a selected node that does not exist", () => {
    const dangling = shotWith({
      graph: {
        version: 1,
        nodes: [{ id: "composer", kind: "composer", pos: { x: 0, y: 0 } }],
        edges: [{ id: "e1", from: { node: "composer", port: "out" }, to: { node: "ghost", port: "in" } }],
      },
    });
    expect(() => validateMigratedProduction(dangling)).toThrow(/Migration validation failed/);

    const missingPick = shotWith({
      graph: { version: 1, nodes: [{ id: "composer", kind: "composer", pos: { x: 0, y: 0 } }], edges: [] },
      graphOutputVideoNodeId: "vid-missing",
    });
    expect(() => validateMigratedProduction(missingPick)).toThrow(/selected video node/);
  });
});
