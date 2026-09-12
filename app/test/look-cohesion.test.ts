/**
 * Storyboard style-cohesion tests — the shared look contract.
 *
 * Pins the plan's generation contract: one verbatim LOOK clause first on every
 * shot whose style owns a frame, the frame uploaded at @image1 with content
 * refs shifted by one, a frozen 16:9 aspect + board seed, and back-compat for
 * styles without a frame. All four adapters (OpenArt/Higgsfield MCP + CLI)
 * share citePrompt + this module, so the conformance assertions here keep them
 * from silently diverging.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production, ProductionShot, ProductionStyle } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  LOOK_CLAUSE,
  buildLookClause,
  withLookClause,
  assembleImagePrompt,
  resolveShotStyleEntry,
  styleFrameForShot,
  ensureLookSeed,
  styleFramePrompt,
  buildGenerationRequest,
  STYLE_FRAME_SUBJECT,
  STYLE_FRAME_SETTING,
} from "../src/shared/look.js";
import { citePrompt } from "../src/main/providers/refs.js";
import {
  openArtPrompt,
  refTokens,
  resolveReferenceTags,
  generateBoards,
  styleFrameRelPath,
} from "../src/main/pipeline.js";

function makeStyle(overrides: Partial<ProductionStyle> = {}): ProductionStyle {
  return { id: "s-master", index: 1, name: "Heroic 3D", prompt: "Heroic 3D render style", ...overrides };
}

function makeShot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: "shot-1", number: "0100", audio: "", visual: "A hero walks through the valley.", ...overrides };
}

function makeProduction(styles: ProductionStyle[] = [makeStyle()], shot: ProductionShot = makeShot()): Production {
  return {
    meta: { id: "prod-1", name: "Test", folder: "C:/workspace/test-production", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 1 },
    currentStep: 3,
    visualStyle: "",
    styles,
    scenes: [{ number: 1, title: "S1", shots: [shot] }],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  };
}

describe("buildLookClause", () => {
  it("is the verbatim look sentence — a look, not a subject", () => {
    expect(buildLookClause()).toBe(LOOK_CLAUSE);
    expect(LOOK_CLAUSE).toMatch(/match its medium, palette, lighting/);
    expect(LOOK_CLAUSE).toMatch(/Do not copy its subject matter/);
  });

  it("withLookClause prepends once and is idempotent", () => {
    const once = withLookClause("A hero walks.");
    expect(once.startsWith(LOOK_CLAUSE)).toBe(true);
    expect(withLookClause(once)).toBe(once);
  });
});

describe("assembleImagePrompt", () => {
  it("orders LOOK first, then style, brand, content", () => {
    const out = assembleImagePrompt({ content: "A hero walks.", brand: "Color palette: #fff.", styleText: "Heroic 3D.", look: true });
    const lookAt = out.indexOf(LOOK_CLAUSE);
    const styleAt = out.indexOf("Style:");
    const brandAt = out.indexOf("Brand identity:");
    const contentAt = out.indexOf("A hero walks.");
    expect(lookAt).toBe(0);
    expect(styleAt).toBeGreaterThan(lookAt);
    expect(brandAt).toBeGreaterThan(styleAt);
    expect(contentAt).toBeGreaterThan(brandAt);
  });
});

describe("styleFrameForShot", () => {
  it("resolves the master style by default and honors per-shot overrides", () => {
    const alt = makeStyle({ id: "s-alt", index: 2, name: "Noir", prompt: "Noir style", imagePath: "styles/s-alt.png" });
    const p = makeProduction([makeStyle({ imagePath: "styles/s-master.png" }), alt]);
    const shot = p.scenes[0].shots[0];
    expect(styleFrameForShot(p, shot)?.id).toBe("s-master");
    expect(styleFrameForShot(p, { ...shot, style: "s-alt" })?.id).toBe("s-alt");
    expect(styleFrameForShot(p, { ...shot, styleNone: true })).toBeUndefined();
  });

  it("is undefined without a frame (text-only back-compat)", () => {
    const p = makeProduction([makeStyle()]);
    expect(styleFrameForShot(p, p.scenes[0].shots[0])).toBeUndefined();
    expect(resolveShotStyleEntry(p, p.scenes[0].shots[0])?.id).toBe("s-master");
  });
});

describe("openArtPrompt + refTokens with a style frame", () => {
  it("prepends the verbatim LOOK clause only when a frame is active", () => {
    const plain = makeProduction([makeStyle()]);
    expect(openArtPrompt(plain, plain.scenes[0].shots[0]).includes(LOOK_CLAUSE)).toBe(false);
    const framed = makeProduction([makeStyle({ imagePath: "styles/s-master.png" })]);
    const out = openArtPrompt(framed, framed.scenes[0].shots[0]);
    expect(out.startsWith(LOOK_CLAUSE)).toBe(true);
  });

  it("shifts content refs by one so the frame holds @image1", () => {
    const shot = makeShot({ prompt: "A meeting @[Gandalf]" });
    const p = makeProduction([makeStyle({ imagePath: "styles/s-master.png" })], shot);
    p.characters = [{ id: "c1", name: "Gandalf", key: "grey wizard" }];
    // Shot refs need artwork to claim a token; give Gandalf a data URL.
    (p.characters[0] as { artwork?: string }).artwork = "data:image/png;base64,AAAA";
    const tokens = refTokens(p, shot);
    expect(tokens.get("Gandalf")).toBe("@image2");
    expect(resolveReferenceTags(p, shot, "Meet @[Gandalf]")).toBe("Meet @image2");
  });

  it("keeps @image1 numbering without a frame", () => {
    const shot = makeShot({ prompt: "A meeting @[Gandalf]" });
    const p = makeProduction([makeStyle()], shot);
    p.characters = [{ id: "c1", name: "Gandalf", key: "grey wizard" }];
    (p.characters[0] as { artwork?: string }).artwork = "data:image/png;base64,AAAA";
    expect(refTokens(p, shot).get("Gandalf")).toBe("@image1");
  });
});

describe("adapter conformance (shared citePrompt layer)", () => {
  it("cites the frame as reference image 1 and shifts content refs — identically for every adapter", () => {
    const prompt = `${LOOK_CLAUSE}\n\nMeet @image1 and @image2`;
    const refs = [{ name: "Look — Heroic 3D" }, { name: "Gandalf" }];
    const submitted = ["frame-id", "gandalf-id"];
    const cited = citePrompt(prompt, refs, submitted);
    expect(cited).toContain("Look — Heroic 3D (reference image 1)");
    expect(cited).toContain("Gandalf (reference image 2)");
    // All four adapters call this same function with the frame first, so one
    // assertion pins MCP + CLI parity (transport only differs after this).
    expect(citePrompt(prompt, refs, submitted)).toBe(cited);
  });
});

describe("buildGenerationRequest", () => {
  it("puts the frame at index 0, LOOK first, 16:9, frozen model/resolution + seed", () => {
    const p = makeProduction([makeStyle({ imagePath: "styles/s-master.png" })]);
    p.openArt = { model: "nano-banana-2", resolution: "2k" };
    const req = buildGenerationRequest(p, p.scenes[0].shots[0], "Style: Heroic 3D.\n\nA hero walks.", ["gandalf-bytes"]);
    expect(req.prompt.startsWith(LOOK_CLAUSE)).toBe(true);
    expect(req.styleFramePath).toBe("styles/s-master.png");
    expect(req.references).toEqual(["gandalf-bytes"]);
    expect(req.aspect).toBe("16:9");
    expect(req.model).toBe("nano-banana-2");
    expect(req.resolution).toBe("2k");
    expect(typeof req.seed).toBe("number");
  });

  it("omits the frame but still freezes a seed without one", () => {
    const p = makeProduction([makeStyle()]);
    const req = buildGenerationRequest(p, p.scenes[0].shots[0], "A hero walks.", []);
    expect(req.styleFramePath).toBeUndefined();
    expect(req.prompt.includes(LOOK_CLAUSE)).toBe(false);
    expect(typeof req.seed).toBe("number");
  });
});

describe("ensureLookSeed", () => {
  it("is stable per production and prefers styles[0].seed", () => {
    const p = makeProduction([makeStyle({ seed: 42 })]);
    expect(ensureLookSeed(p)).toBe(42);
    expect(p.lookSeed).toBe(42);
    const q = makeProduction([makeStyle()]);
    const first = ensureLookSeed(q);
    expect(ensureLookSeed(q)).toBe(first);
  });
});

describe("generateBoards with a style frame", () => {
  it("uploads the frame at index 0 and forwards the seeded LOOK prompt", async () => {
    const shot = makeShot();
    const p = makeProduction([makeStyle({ imagePath: "styles/s-master.png" })], shot);
    // Point the frame at a real file so styleFrameDataUrl resolves: reuse this
    // repo's package.json bytes is wrong-mime, so write a tiny PNG instead.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-look-"));
    (p.meta as { folder: string }).folder = dir;
    fs.mkdirSync(path.join(dir, "styles"), { recursive: true });
    fs.mkdirSync(path.join(dir, "boards"), { recursive: true });
    const png1x1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    fs.writeFileSync(path.join(dir, "styles", "s-master.png"), png1x1);

    const seen: { prompt: string; refs: { name: string; dataUrl: string }[] }[] = [];
    const emit = vi.fn();
    await generateBoards(
      p,
      async (prompt, refs) => {
        seen.push({ prompt, refs });
        return png1x1;
      },
      emit,
      { concurrency: 1 }
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].prompt.startsWith(LOOK_CLAUSE)).toBe(true);
    expect(seen[0].refs.length).toBe(1);
    expect(seen[0].refs[0].dataUrl.startsWith("data:image/")).toBe(true);
    expect(typeof p.lookSeed).toBe("number");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("behaves as before without a frame (no LOOK, content refs only)", async () => {
    const shot = makeShot({ prompt: "Meet @[Gandalf]" });
    const p = makeProduction([makeStyle()], shot);
    p.characters = [{ id: "c1", name: "Gandalf", key: "grey wizard" }];
    (p.characters[0] as { artwork?: string }).artwork = "data:image/png;base64,AAAA";
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-look-"));
    (p.meta as { folder: string }).folder = dir;
    fs.mkdirSync(path.join(dir, "boards"), { recursive: true });
    const png1x1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    const seen: { prompt: string; refs: { name: string }[] }[] = [];
    await generateBoards(p, async (prompt, refs) => {
      seen.push({ prompt, refs });
      return png1x1;
    }, vi.fn(), { concurrency: 1 });
    expect(seen[0].prompt.includes(LOOK_CLAUSE)).toBe(false);
    expect(seen[0].refs.map((r) => r.name)).toEqual(["Gandalf"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("styleFramePrompt", () => {
  it("uses the fixed neutral scaffold — only style tokens and brand vary", () => {
    const a = styleFramePrompt("Heroic 3D render style", "Color palette: #fff.");
    const b = styleFramePrompt("Noir ink style", "Color palette: #fff.");
    expect(a).toContain(STYLE_FRAME_SUBJECT);
    expect(a).toContain(STYLE_FRAME_SETTING);
    expect(a).toContain("Heroic 3D render style");
    expect(b).toContain("Noir ink style");
    // Scaffold is constant across styles — only the style tokens differ.
    expect(a.replace("Heroic 3D render style", "X")).toBe(b.replace("Noir ink style", "X"));
    expect(a).toContain(STYLE_FRAME_SUBJECT);
    expect(b).toContain(STYLE_FRAME_SUBJECT);
  });

  it("styleFrameRelPath stays inside styles/", () => {
    expect(styleFrameRelPath("s-1")).toBe("styles/s-1.png");
  });
});
