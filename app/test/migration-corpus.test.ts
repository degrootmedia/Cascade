/**
 * Legacy fixture corpus (Step 5 release gate, test form): representative
 * historical shapes — v1 flat fields, unversioned legacy clip, partially
 * migrated v2 with an unknown future node, missing media — each migrates
 * once, reopens byte-identical, keeps a pre-migration backup, and resolves
 * the same display/export frame before and after the second load.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-corpus-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { loadProduction } from "../src/main/productions.js";
import { loadPanelImage } from "../src/main/storyboard-pdf.js";
import { resolveShotDisplay } from "../src/shared/selected-output.js";
import type { Production } from "../src/shared/ipc.js";

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const storeDir = () => path.join(dataDir, "productions");
const docFile = (id: string) => path.join(storeDir(), `${id}.json`);
const FAKE_JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70]);
const readFile = (): Uint8Array => FAKE_JPG;

function base(id: string, shot: Record<string, unknown>, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { id, name: "Legacy", folder: path.join(dataDir, "folders", id), createdAt: "", updatedAt: "", stepDone: 0, shotCount: 1 },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: [{ number: 1, title: "S1", shots: [shot] }],
    characters: [],
    products: [],
    references: [{ id: "r1", name: "Gondola", imagePath: "references/gondola.jpg", shotIds: [] }],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    ...over,
  };
}

const FIXTURES: Array<{ id: string; doc: Record<string, unknown>; expectFrame: boolean }> = [
  {
    id: "corpus-v1-flat",
    doc: base("corpus-v1-flat",
      { id: "s1", number: "0100", audio: "a", visual: "v", prompt: "Dawn over the @[Gondola]", artwork: "boards/0100/a.jpg" },
      { schemaVersion: 1 }),
    expectFrame: false,
  },
  {
    id: "corpus-unversioned-clip",
    doc: base("corpus-unversioned-clip",
      { id: "s1", number: "0100", audio: "a", visual: "v", artwork: "boards/0100/a.jpg", videoPath: "boards/0100/video/clip.mp4" }),
    expectFrame: false,
  },
  {
    id: "corpus-v2-unknown-node",
    doc: base("corpus-v2-unknown-node",
      {
        id: "s1", number: "0100", audio: "a", visual: "v", prompt: "A shot", artwork: "boards/0100/a.jpg", graphOutputSource: "imagegen", graphImageGens: [{ path: "boards/0100/a.jpg", prompt: "", model: "auto", at: "" }], graphImageGenIndex: 0,
        graph: {
          version: 1,
          nodes: [
            { id: "composer", kind: "composer", pos: { x: 0, y: 0 } },
            { id: "future1", kind: "futureKind", pos: { x: 9, y: 9 } },
          ],
          edges: [],
        },
      },
      { schemaVersion: 2 }),
    expectFrame: true,
  },
  {
    id: "corpus-missing-media",
    doc: base("corpus-missing-media",
      { id: "s1", number: "0100", audio: "a", visual: "v", prompt: "Gone frame", artwork: "boards/0100/gone.jpg" },
      { schemaVersion: 1 }),
    expectFrame: false,
  },
];

describe("legacy fixture corpus", () => {
  it.each(FIXTURES.map((f) => [f.id, f] as const))("%s migrates once and reopens unchanged", (_id, f) => {
    fs.mkdirSync(storeDir(), { recursive: true });
    const folder = path.join(dataDir, "folders", f.id);
    fs.mkdirSync(path.join(folder, "boards/0100/video"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards/0100/a.jpg"), FAKE_JPG);
    fs.writeFileSync(path.join(folder, "boards/0100/video/clip.mp4"), FAKE_JPG);
    fs.writeFileSync(docFile(f.id), JSON.stringify(f.doc), "utf8");

    const first = loadProduction(f.id) as Production;
    expect(first.schemaVersion).toBe(3);
    const shot = first.scenes[0].shots[0];
    expect(shot.graph?.nodes.length).toBeGreaterThan(0);

    const backups = fs.readdirSync(path.join(storeDir(), "pre-migration")).filter((n) => n.startsWith(f.id));
    expect(backups.length).toBe(1);

    const displayFirst = resolveShotDisplay(shot);
    const panelFirst = loadPanelImage(first, shot, readFile);
    if (f.expectFrame) expect(panelFirst?.kind).toBe("jpg");

    const bytesAfterFirst = fs.readFileSync(docFile(f.id), "utf8");
    const second = loadProduction(f.id) as Production;
    expect(fs.readFileSync(docFile(f.id), "utf8")).toBe(bytesAfterFirst);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(resolveShotDisplay(second.scenes[0].shots[0])).toEqual(displayFirst);
    expect(loadPanelImage(second, second.scenes[0].shots[0], readFile)?.kind).toEqual(panelFirst?.kind);
  });

  it("preserves the unknown future node through migration", () => {
    const loaded = loadProduction("corpus-v2-unknown-node") as Production;
    expect(loaded.scenes[0].shots[0].graph?.nodes.map((n) => n.id)).toContain("future1");
  });
});
