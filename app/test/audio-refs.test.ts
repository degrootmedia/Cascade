/**
 * Imported-audio reference tests: an audio CustomRef resolves for video
 * generation (and only there), is cited as audio without shifting image
 * numbering, binds to the OpenArt form's audio slot (never a frame slot),
 * and reaches the Higgsfield CLI as a correctly-extensioned temp file.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { audioArrayKey, referenceArrayKey, videoRefsAssign } from "../src/main/providers/openart.js";
import { citePrompt, isAudioRef, resolvePromptRefs } from "../src/main/providers/refs.js";
import { writeCliTempRefs } from "../src/main/providers/cli-run.js";
import type { Production } from "../src/shared/ipc.js";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-audio-refs-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
    createFromPath: () => ({ isEmpty: () => true }),
  },
  dialog: { showOpenDialog: async () => ({ canceled: true }) },
}));

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

function makeProduction(overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "prod-1", name: "Test Production", folder: "C:/workspace/test-production", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
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
  } as Production;
}

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("resolvePromptRefs with an audio reference", () => {
  it("resolves cited audio for video generation, never for image generation", () => {
    const folder = path.join(dataDir, "refs-audio");
    fs.mkdirSync(path.join(folder, "references"), { recursive: true });
    fs.writeFileSync(path.join(folder, "references", "vo.mp3"), Buffer.from("mp3-bytes"));
    const p = makeProduction({
      meta: { id: "prod-1", name: "Test Production", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
      references: [{ id: "r1", name: "Voiceover", media: "audio", mediaPath: "references/vo.mp3" }],
    });
    const video = resolvePromptRefs(p, "lip-sync to @[Voiceover]", 0, true);
    expect(video.resolved).toBe("lip-sync to @image1");
    expect(video.extras).toEqual([
      { name: "Voiceover", dataUrl: `data:audio/mpeg;base64,${Buffer.from("mp3-bytes").toString("base64")}` },
    ]);
    const image = resolvePromptRefs(p, "lip-sync to @[Voiceover]", 0);
    expect(image.resolved).toBe("lip-sync to @[Voiceover]");
    expect(image.extras).toEqual([]);
  });

  it("never uploads an uncited style-tagged audio reference", () => {
    const folder = path.join(dataDir, "refs-audio-style");
    fs.mkdirSync(path.join(folder, "references"), { recursive: true });
    fs.writeFileSync(path.join(folder, "references", "theme.mp3"), Buffer.from("mp3-bytes"));
    const p = makeProduction({
      meta: { id: "prod-1", name: "Test Production", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
      references: [{ id: "r1", name: "Theme", media: "audio", mediaPath: "references/theme.mp3", styleOnly: true }],
    });
    expect(resolvePromptRefs(p, "no citations here", 0, true).extras).toEqual([]);
  });
});

describe("citePrompt per-kind numbering", () => {
  const refs = [
    { name: "Frame", dataUrl: "data:image/png;base64,QQ==" },
    { name: "Voiceover", dataUrl: "data:audio/mpeg;base64,Qg==" },
    { name: "Hero", dataUrl: "data:image/png;base64,Qw==" },
  ];

  it("cites audio as reference audio without shifting image numbers", () => {
    const out = citePrompt("@image1 with @image2 and @image3", refs, ["u1", "u2", "u3"]);
    expect(out).toBe("Frame (reference image 1) with Voiceover (reference audio 1) and Hero (reference image 2)");
  });

  it("falls back to the bare name when the audio upload failed", () => {
    const out = citePrompt("@image1 with @image2 and @image3", refs, ["u1", null, "u3"]);
    expect(out).toBe("Frame (reference image 1) with Voiceover and Hero (reference image 2)");
  });

  it("classifies audio from the data-URL MIME (isAudioRef)", () => {
    expect(isAudioRef({ dataUrl: "data:audio/wav;base64,QQ==" })).toBe(true);
    expect(isAudioRef({ dataUrl: "data:video/mp4;base64,QQ==" })).toBe(false);
    expect(isAudioRef({ media: "audio" })).toBe(true);
    expect(isAudioRef({})).toBe(false);
  });
});

describe("OpenArt audio binding", () => {
  const frame = { type: "image", label: "Shot 0100 frame", url: "https://example.invalid/frame.png", id: "vr-1" };
  const audio = { type: "audio", label: "Voiceover", url: "https://example.invalid/vo.mp3", id: "vr-2" };

  it("finds a dedicated audio array and never mistakes it for the visual array", () => {
    const props = {
      visualReferences: { type: "array", items: { type: "object" } },
      audioReferences: { type: "array", items: { type: "object" } },
      generateAudio: { type: "boolean" },
    };
    expect(audioArrayKey(props)).toBe("audioReferences");
    expect(referenceArrayKey(props)).toBe("visualReferences");
    expect(videoRefsAssign([frame, audio], props)).toEqual({
      visualReferences: [frame],
      audioReferences: [audio],
    });
  });

  it("never fills the start-frame slot with audio, even when audio leads", () => {
    const props = {
      startFrame: { type: "object", properties: { type: { type: "string" }, label: { type: "string" }, url: { type: "string" }, id: { type: "string" } } },
    };
    expect(videoRefsAssign([audio, frame], props)).toEqual({ startFrame: frame });
  });

  it("rides the visual array as a typed element when no audio field exists", () => {
    const props = { visualReferences: { type: "array", items: { type: "object" } } };
    expect(videoRefsAssign([frame, audio], props)).toEqual({ visualReferences: [frame, audio] });
  });

  it("binds audio alone (refsOnly) without an empty visual array", () => {
    const props = {
      visualReferences: { type: "array", items: { type: "object" } },
      audioReferences: { type: "array", items: { type: "object" } },
    };
    expect(videoRefsAssign([audio], props, { refsOnly: true })).toEqual({ audioReferences: [audio] });
  });
});

describe("writeCliTempRefs audio extensions", () => {
  it("names audio temp files by their real kind (never .jpg/.mp4)", () => {
    const { paths, cleanup } = writeCliTempRefs([
      { name: "Voiceover", dataUrl: "data:audio/mpeg;base64,QQ==" },
      { name: "Theme", dataUrl: "data:audio/mp4;base64,Qg==" },
      { name: "Room tone", dataUrl: "data:audio/wav;base64,Qw==" },
      { name: "Frame", dataUrl: "data:image/png;base64,RA==" },
    ]);
    try {
      expect(paths[0]).toMatch(/\.mp3$/);
      expect(paths[1]).toMatch(/\.m4a$/);
      expect(paths[2]).toMatch(/\.wav$/);
      expect(paths[3]).toMatch(/\.png$/);
    } finally {
      cleanup();
    }
  });
});
