/**
 * board-image-drop tests — dropping an image file onto a storyboard panel.
 * `importBoardDataUrl` saves the file as a reference image and pipes it into
 * the frame output: the same end state as dragging the image into the node
 * graph (reference node) and wiring it to the output node. Deliberately not
 * the image-generator node/history path — a drop is an explicit reference,
 * not a generation.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { importBoardDataUrl } from "../src/main/pipeline.js";

function makeShot(number: string, overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: `shot-${number}`, number, audio: "", visual: `Visual ${number}`, ...overrides };
}

function makeProduction(folder: string, shots: ProductionShot[]): Production {
  return {
    meta: { id: "prod-1", name: "Test", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: shots.length },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: shots.map((shot) => ({ number: 1, title: "S1", shots: [shot] })),
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models", videosDir: "videos" },
  };
}

const noop = () => {};
const pngUrl = (bytes: string) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;

describe("importBoardDataUrl", () => {
  it("saves the file as a reference image piped to the output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-board-image-"));
    try {
      const shot = makeShot("0100", { videoPath: "boards/0100/video/shot-0100-old.mp4" });
      const p = makeProduction(root, [shot]);
      importBoardDataUrl(p, shot.id, "exterior.png", pngUrl("img-bytes"), noop);

      const refs = p.references ?? [];
      expect(refs).toHaveLength(1);
      expect(refs[0].imagePath).toBe("references/exterior.png");
      expect(fs.readFileSync(path.join(root, refs[0].imagePath!), "utf8")).toBe("img-bytes");

      // Board frame rendered from the same bytes (mirrors applyGraphRefOutput).
      expect(shot.artwork).toMatch(/^boards\/0100\/shot-0100-[a-z0-9]+\.jpg$/);
      expect(fs.existsSync(path.join(root, shot.artwork!))).toBe(true);

      // Piped, not generated: no image-gen history touched.
      expect(shot.graphOutputSource).toBe("ref");
      expect(shot.graphOutputRefId).toBe(refs[0].id);
      expect(shot.graphImageGens).toBeUndefined();
      // The stale clip clears (mirrors pipeRefToOutput).
      expect(shot.videoPath).toBeUndefined();
      // The ref node is placed on the canvas so the output edge renders.
      expect(shot.graphLayout?.positions?.[`ref:${refs[0].id}`]).toEqual({ x: 0, y: 116 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the previous frame in history and stacks nodes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-board-image-"));
    try {
      const shot = makeShot("0100", { artwork: "boards/0100/shot-0100-old.jpg" });
      const p = makeProduction(root, [shot]);
      importBoardDataUrl(p, shot.id, "a.png", pngUrl("one"), noop);
      const firstArtwork = shot.artwork;
      importBoardDataUrl(p, shot.id, "a.png", pngUrl("two"), noop);

      expect(shot.artworkHistory).toContain(firstArtwork);
      const refs = p.references ?? [];
      expect(refs.map((r) => r.imagePath)).toEqual(["references/a.png", "references/a (2).png"]);
      expect(shot.graphLayout?.positions?.[`ref:${refs[0].id}`]).toEqual({ x: 0, y: 116 });
      expect(shot.graphLayout?.positions?.[`ref:${refs[1].id}`]).toEqual({ x: 0, y: 244 });
      expect(shot.graphOutputRefId).toBe(refs[1].id);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported mime types, unknown shots, and empty payloads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-board-image-"));
    try {
      const shot = makeShot("0100");
      const p = makeProduction(root, [shot]);
      expect(() =>
        importBoardDataUrl(p, shot.id, "anim.gif", "data:image/gif;base64,eA==", noop)
      ).toThrow("Only PNG/JPG/WebP images can be imported as frames.");
      expect(() => importBoardDataUrl(p, "nope", "a.png", pngUrl("x"), noop)).toThrow("Shot not found.");
      expect(() => importBoardDataUrl(p, shot.id, "a.png", "data:image/png;base64,", noop)).toThrow(
        "The image is empty."
      );
      expect((p.references ?? [])).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
