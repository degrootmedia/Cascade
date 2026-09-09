/**
 * productions tests — the production document's shape rules: the read-side
 * normalize back-fill and the write-side applyRendererState whitelist merge
 * (which used to live inline in index.ts's production:save handler). Pins that
 * the merge copies only renderer-editable fields and never clobbers concurrent
 * state that the renderer doesn't send.
 */
import { afterAll, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/opencode/cascade-productions-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));

// productions.ts imports pipeline.ts (soft electron + scripting); the tests
// never call the text-extraction helpers, and scripting's dynamic pdf-parse
// import doesn't resolve under Vitest — replace it with a factory.
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { applyRendererState, importProduction, loadProduction, saveProduction, unclaimedReferenceFiles } from "../src/main/productions.js";
import { recordBoardEdit, selectBoardFrame, syncBoardOutputToPipe } from "../src/main/pipeline.js";
import { boardFrameHistory } from "../src/shared/board-frames.js";

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function baseProduction(overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "p1", name: "Prod", folder: "C:/workspace/prod", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 1,
    visualStyle: "",
    styles: [],
    scenes: [],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    ...overrides,
  };
}

describe("applyRendererState", () => {
  it("copies the renderer-editable fields onto the fresh document", () => {
    const fresh = baseProduction();
    const incoming = baseProduction({
      currentStep: 3,
      styles: [{ id: "s1", index: 1, name: "Heroic", prompt: "Heroic 3D" }],
      openArt: { model: "kling", resolution: "2k" },
      status: { 3: "done" },
      scriptSource: "C:/script.md",
    });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.currentStep).toBe(3);
    expect(merged.styles).toEqual(incoming.styles);
    expect(merged.openArt).toEqual({ model: "kling", resolution: "2k" });
    expect(merged.status).toEqual({ 3: "done" });
    expect(merged.scriptSource).toBe("C:/script.md");
  });

  it("never clobbers fields the renderer doesn't send", () => {
    // The fresh doc carries node-graph + artwork state a long-running job wrote;
    // the incoming renderer copy predates it and omits it — it must survive.
    const fresh = baseProduction({
      scenes: [
        {
          number: 1,
          title: "S1",
          shots: [
            {
              id: "shot1",
              number: "0100",
              audio: "",
              visual: "Hero walks",
              artwork: "boards/0100/shot-0100-new.jpg",
              graphVideoGens: [{ path: "videos/shot-0100-new.mp4", prompt: "p", model: "m", at: "" }],
            },
          ],
        },
      ],
    });
    const incoming = baseProduction({ scenes: [] });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.scenes).toEqual([]); // renderer owns scenes — it sent an empty list
    // ...but anything NOT in the scenes whitelist that lives elsewhere survives:
    expect(merged.meta.name).toBe("Prod");
  });

  it("preserves concurrent shot fields when the renderer resends the same shots", () => {
    const fresh = baseProduction({
      scenes: [
        {
          number: 1,
          title: "S1",
          shots: [
            {
              id: "shot1",
              number: "0100",
              audio: "",
              visual: "Hero walks",
              artwork: "boards/0100/shot-0100-new.jpg",
              graphVideoGens: [{ path: "videos/shot-0100-new.mp4", prompt: "p", model: "m", at: "" }],
            },
          ],
        },
      ],
    });
    // Renderer sends the same shot but from a stale snapshot without the video.
    const incoming = baseProduction({
      scenes: [
        {
          number: 1,
          title: "S1",
          shots: [{ id: "shot1", number: "0100", audio: "", visual: "Hero walks", artwork: "boards/0100/shot-0100-old.jpg" }],
        },
      ],
    });
    const merged = applyRendererState(fresh, incoming);
    // The renderer's snapshot is authoritative for the fields it owns — but
    // per-shot generated state the renderer didn't resend is lost. (This is the
    // documented trade-off of the whitelist merge; concurrent long-running jobs
    // go through rebaseProduction, not this path.)
    expect(merged.scenes[0].shots[0].artwork).toBe("boards/0100/shot-0100-old.jpg");
  });

  it("strips legacy per-shot fields (single-VO model, cuts-only timeline)", () => {
    const legacyShot = { id: "shot1", number: "0100", audio: "", visual: "Hero" } as unknown as Record<string, unknown>;
    legacyShot.voiceoverPath = "voiceover/legacy.mp3";
    legacyShot.transition = "cut";
    const incoming = baseProduction({
      scenes: [
        {
          number: 1,
          title: "S1",
          shots: [legacyShot as unknown as Production["scenes"][number]["shots"][number]],
        },
      ],
    });
    const merged = applyRendererState(baseProduction(), incoming);
    const shot = merged.scenes[0].shots[0] as unknown as Record<string, unknown>;
    expect(shot.voiceoverPath).toBeUndefined();
    expect(shot.transition).toBeUndefined();
    expect(shot.visual).toBe("Hero");
  });

  it("slices brand colors to 5 and stringifies", () => {
    const incoming = baseProduction({ brand: { colors: ["#aabbcc", "#ddeeff", "#112233", "#445566", "#778899", "#000000"], font: "Baskerville" } });
    const merged = applyRendererState(baseProduction(), incoming);
    expect(merged.brand?.colors).toHaveLength(5);
    expect(merged.brand?.colors).toEqual(["#aabbcc", "#ddeeff", "#112233", "#445566", "#778899"]);
    expect(merged.brand?.font).toBe("Baskerville");
  });

  it("drops blank promptOverrides entries", () => {
    const incoming = baseProduction({ promptOverrides: { "0100": "valid prompt", "0200": "   " } });
    const merged = applyRendererState(baseProduction(), incoming);
    expect(merged.promptOverrides).toEqual({ "0100": "valid prompt" });
  });

  it("clamps volume fields to [0, 1]", () => {
    const incoming = baseProduction({ voiceoverVolume: 2, musicVolume: -1 } as Production);
    const merged = applyRendererState(baseProduction(), incoming);
    expect(merged.voiceoverVolume).toBe(1);
    expect(merged.musicVolume).toBe(0);
  });

  it("renames the production when the renderer sends a new name", () => {
    const incoming = baseProduction({ meta: { ...baseProduction().meta, name: "Renamed" } });
    const merged = applyRendererState(baseProduction(), incoming);
    expect(merged.meta.name).toBe("Renamed");
  });

  it("re-derives the storyboard frame from the output pipe when the renderer's save is stale", () => {
    // The renderer sends the shot with the edit-image node piped to the output
    // but a stale/empty `artwork` (the apply raced its save). The pipe owns the
    // frame, so the merged document must mirror the node graph's output node.
    const incoming = baseProduction({
      scenes: [
        {
          number: 1,
          title: "S1",
          shots: [
            {
              id: "shot1",
              number: "0100",
              audio: "",
              visual: "Hero walks",
              graphOutputSource: "editgen",
              graphEditGens: [{ path: "boards/0100/shot-0100-edit.jpg", prompt: "make it night", model: "auto", at: "" }],
              graphEditGenIndex: 0,
              artwork: undefined,
              videoPath: "videos/stale.mp4",
            },
          ],
        },
      ],
    });
    const merged = applyRendererState(baseProduction(), incoming);
    const shot = merged.scenes[0].shots[0];
    expect(shot.artwork).toBe("boards/0100/shot-0100-edit.jpg");
    expect(shot.videoPath).toBeUndefined();
  });
});

describe("board frame selection persistence", () => {
  it.each(["image", "edit", "legacy", "current"] as const)("preserves a %s selection through renderer state and repeated disk save/load", (kind) => {
    const images = [0, 1, 2].map((i) => ({
      path: `boards/0100/image-${i}.jpg`, prompt: `image ${i}`, model: "image-model", at: `2026-09-0${3 - i}T00:00:00.000Z`,
    }));
    const edits = [0, 1, 2].map((i) => ({
      path: `boards/0100/edit-${i}.jpg`, prompt: `edit ${i}`, model: "edit-model", at: `2026-09-0${6 - i}T00:00:00.000Z`,
    }));
    const shot: ProductionShot = {
      id: "shot1", number: "0100", audio: "", visual: "Hero walks",
      artwork: "boards/0100/current.jpg", artworkHistory: ["boards/0100/legacy.jpg", "boards/0100/older.jpg"],
      graphImageGens: images, graphImageGenIndex: 0,
      graphEditGens: edits, graphEditGenIndex: 1,
      graphOutputSource: "videogen", videoPath: "videos/clip.mp4", graphImageToVideo: true,
      graphVideoGens: [{ path: "videos/clip.mp4", prompt: "motion", model: "video-model", at: "" }],
      graphVideoGenIndex: 0,
      // Deliberately omit graphMigrated: an explicit selection must also survive legacy migration.
    };
    const incoming = baseProduction({
      meta: { ...baseProduction().meta, id: `selection-${kind}`, folder: path.join(dataDir, "assets") },
      scenes: [{ number: 1, title: "S1", shots: [shot] }],
    });
    const rel = kind === "image" ? images[2].path : kind === "edit" ? edits[2].path
      : kind === "legacy" ? "boards/0100/legacy.jpg" : shot.artwork!;
    selectBoardFrame(shot, rel);
    const selected = structuredClone(shot);
    const history = boardFrameHistory(shot);
    // A stale artwork mirror cannot replace the newly selected node output.
    shot.artwork = "boards/0100/current.jpg";
    shot.videoPath = "videos/clip.mp4";
    const fresh = baseProduction({ meta: { ...incoming.meta } });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.scenes[0].shots[0].artwork).toBe(rel);
    expect(merged.scenes[0].shots[0].videoPath).toBeUndefined();
    saveProduction(merged);

    for (let i = 0; i < 2; i++) {
      const loaded = loadProduction(incoming.meta.id);
      expect(loaded).not.toBeNull();
      const restored = loaded!.scenes[0].shots[0];
      expect(restored.artwork).toBe(rel);
      expect(restored.videoPath).toBeUndefined();
      expect(restored.graphOutputSource).toBe(kind === "edit" ? "editgen" : "imagegen");
      expect(restored.graphImageGenIndex).toBe(selected.graphImageGenIndex);
      expect(restored.graphEditGenIndex).toBe(selected.graphEditGenIndex);
      expect(restored.graphImageGens).toEqual(selected.graphImageGens);
      expect(restored.graphEditGens).toEqual(selected.graphEditGens);
      expect(restored.graphVideoGens).toEqual(selected.graphVideoGens);
      expect(restored.graphImageToVideo).toBe(true);
      expect(boardFrameHistory(restored)).toEqual(history);
      expect(syncBoardOutputToPipe(restored)).toBe(false);
      saveProduction(loaded!);
    }
  });

  it("persists a classic edit and re-edit with the correct source fallback and complete node history", () => {
    const shot: ProductionShot = {
      id: "shot1", number: "0100", audio: "", visual: "Hero walks",
      artwork: "boards/0100/image-1.jpg", graphImageGenIndex: 0, graphImageToVideo: true,
      graphImageGens: [0, 1].map((i) => ({ path: `boards/0100/image-${i}.jpg`, prompt: `image ${i}`, model: "image-model", at: "" })),
    };
    const incoming = baseProduction({
      meta: { ...baseProduction().meta, id: "classic-edit", folder: path.join(dataDir, "assets") },
      scenes: [{ number: 1, title: "S1", shots: [shot] }],
    });
    const images = structuredClone(shot.graphImageGens);
    for (const [rel, prompt, imageSource] of [
      ["boards/0100/edit-1.jpg", "make it night", true],
      ["boards/0100/edit-2.jpg", "add rain", undefined],
    ] as const) {
      recordBoardEdit(incoming.scenes[0].shots[0], rel, prompt, "edit-model");
      const selected = structuredClone(incoming.scenes[0].shots[0]);
      const merged = applyRendererState(baseProduction({ meta: { ...incoming.meta } }), incoming);
      saveProduction(merged);
      const loaded = loadProduction(incoming.meta.id)!;
      const restored = loaded.scenes[0].shots[0];
      expect(restored.artwork).toBe(rel);
      expect(restored.graphOutputSource).toBe("editgen");
      expect(restored.graphEditGenIndex).toBe(0);
      expect(restored.graphImageGenIndex).toBe(1);
      expect(restored.graphEditImageSource).toBe(imageSource);
      expect(restored.graphEditSourceRefId).toBeUndefined();
      expect(restored.graphEditPrompt).toBe(prompt);
      expect(restored.graphEditGens).toEqual(selected.graphEditGens);
      expect(restored.graphImageGens).toEqual(images);
      expect(restored.artworkHistory).toEqual(selected.artworkHistory);
      expect(restored.graphImageToVideo).toBe(true);
      incoming.scenes = loaded.scenes;
    }
    expect(incoming.scenes[0].shots[0].graphEditGens).toHaveLength(2);
    expect(boardFrameHistory(incoming.scenes[0].shots[0])).toEqual([
      "boards/0100/edit-1.jpg", "boards/0100/image-0.jpg", "boards/0100/image-1.jpg",
    ]);
  });
});

describe("unclaimedReferenceFiles", () => {
  it("skips files claimed by a character, product, or reference image/media path", () => {
    const p = baseProduction({
      characters: [{ id: "c1", name: "Mara", key: "", imagePath: "references/mara.png" }],
      products: [{ id: "pr1", name: "Compass", imagePath: "references/compass.jpg" }],
      references: [
        { id: "r1", name: "Silk", imagePath: "references/silk.webp" },
        { id: "r2", name: "Clip", media: "video", mediaPath: "references/clip.mp4" },
      ],
    });
    const files = [
      "references/mara.png", "references/compass.jpg", "references/silk.webp", "references/clip.mp4",
      "references/new-drop.png", "references/another (2).jpg",
    ];
    expect(unclaimedReferenceFiles(files, p)).toEqual(["references/new-drop.png", "references/another (2).jpg"]);
  });

  it("claims media paths even for files that look like images and claims on an empty production", () => {
    const p = baseProduction();
    expect(unclaimedReferenceFiles(["references/a.png", "references/b.jpg"], p)).toEqual(["references/a.png", "references/b.jpg"]);
    const media = baseProduction({ references: [{ id: "r1", name: "Odd", mediaPath: "references/a.png" }] });
    expect(unclaimedReferenceFiles(["references/a.png", "references/b.jpg"], media)).toEqual(["references/b.jpg"]);
  });
});

describe("importProduction", () => {
  it("adopts the folder itself, names the doc after it, and preserves existing files", () => {
    const folder = path.join(dataDir, "external", "My Film");
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "kept.jpg"), Buffer.from("existing-bytes"));
    fs.writeFileSync(path.join(folder, "script.md"), "# My Film\n", "utf8");

    const p = importProduction(folder);
    // The folder itself is the production folder — no subfolder is created.
    expect(p.meta.folder).toBe(path.resolve(folder));
    expect(p.meta.name).toBe("My Film");
    expect(p.scenes).toEqual([]);
    // Scaffolded dirs exist, pre-existing files untouched.
    expect(fs.existsSync(path.join(folder, "voiceover"))).toBe(true);
    expect(fs.readFileSync(path.join(folder, "boards", "kept.jpg"), "utf8")).toBe("existing-bytes");
    expect(fs.readFileSync(path.join(folder, "script.md"), "utf8")).toBe("# My Film\n");
    expect(loadProduction(p.meta.id)?.meta.folder).toBe(path.resolve(folder));
  });

  it("returns the existing document when the folder is already registered", () => {
    const folder = path.join(dataDir, "external", "Dupe Film");
    fs.mkdirSync(folder, { recursive: true });
    const first = importProduction(folder);
    const second = importProduction(folder);
    expect(second.meta.id).toBe(first.meta.id);
  });

  it("throws for a folder that doesn't exist", () => {
    expect(() => importProduction(path.join(dataDir, "external", "no-such-folder"))).toThrow(/doesn't exist/);
  });
});
