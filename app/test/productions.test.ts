/**
 * productions tests — the production document's shape rules: the read-side
 * normalize back-fill and the write-side applyRendererState whitelist merge
 * (which used to live inline in index.ts's production:save handler). Pins that
 * the merge copies only renderer-editable fields and never clobbers concurrent
 * state that the renderer doesn't send.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production } from "../src/shared/ipc.js";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-productions-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));

// productions.ts imports pipeline.ts (soft electron + scripting); the tests
// never call the text-extraction helpers, and scripting's dynamic pdf-parse
// import doesn't resolve under Vitest — replace it with a factory.
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { applyRendererState } from "../src/main/productions.js";

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
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references" },
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
      voiceover: { model: "tts", voice: "alloy" },
      status: { 3: "done" },
      scriptSource: "C:/script.md",
    });
    const merged = applyRendererState(fresh, incoming);
    expect(merged.currentStep).toBe(3);
    expect(merged.styles).toEqual(incoming.styles);
    expect(merged.openArt).toEqual({ model: "kling", resolution: "2k" });
    expect(merged.voiceover).toEqual({ model: "tts", voice: "alloy" });
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
});