/**
 * storyboard-pdf tests — Step 3 storyboard PDF export. The pure layout
 * helpers (detectImageKind, sanitizeVersion, footerText,
 * storyboardPdfFileName, paginatePanels, wrapText, fitLines) are exercised
 * directly; `loadPanelImage`/`loadLogoImage` run against a temp production
 * folder (original-preferred, preview fallback); `buildStoryboardPdf`
 * renders real PDFs whose page counts are asserted after reload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PDFDocument } from "pdf-lib";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

// pipeline.ts imports scripting.ts; the tests never call its helpers and its
// dynamic pdf-parse import doesn't resolve under Vitest — mock it away.
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  buildStoryboardPdf,
  detectImageKind,
  fitLines,
  footerText,
  loadLogoImage,
  loadPanelImage,
  paginatePanels,
  sanitizeVersion,
  storyboardPdfFileName,
  wrapText,
  type ReadFileFn,
  type StoryboardPdfPanel,
} from "../src/main/storyboard-pdf.js";

// ---- fixtures --------------------------------------------------------------

let prodFolder: string;

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
// Minimal bytes pdf-lib's sniffer accepts as JPEG (only used for kind
// detection + loadPanelImage, never embedded).
const FAKE_JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function makeProduction(overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "prod-pdf", name: "Test Production", folder: prodFolder, createdAt: "", updatedAt: "", stepDone: 3, shotCount: 0 },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: [],
    characters: [],
    products: [],
    status: {},
    assets: {
      scriptMd: "script/script.md",
      boardsDir: "boards",
      voiceoverDir: "voiceover",
      musicDir: "music",
      videosDir: "videos",
      outDir: "out",
      referencesDir: "references",
      assemblyDir: "assembly",
      modelsDir: "models",
    },
    ...overrides,
  } as Production;
}

function makeShot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return {
    id: crypto.randomUUID(),
    number: "0100",
    audio: "Whistling wind.",
    visual: "A hero walks through the valley.",
    ...overrides,
  };
}

const readFile: ReadFileFn = (abs: string) => {
  try {
    return new Uint8Array(fs.readFileSync(abs));
  } catch {
    return null;
  }
};

function makePanel(i: number): StoryboardPdfPanel {
  return {
    number: String(100 + i).padStart(4, "0"),
    audio: `Audio line ${i}`,
    visual: `Visual line ${i}`,
    image: { bytes: new Uint8Array(PNG_1X1), kind: "png" },
  };
}

beforeEach(() => {
  prodFolder = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-pdf-test-"));
});

afterEach(() => {
  fs.rmSync(prodFolder, { recursive: true, force: true });
});

// ---- pure helpers ----------------------------------------------------------

describe("detectImageKind", () => {
  it("sniffs PNG magic", () => {
    expect(detectImageKind(new Uint8Array(PNG_1X1))).toBe("png");
  });
  it("sniffs JPEG magic", () => {
    expect(detectImageKind(new Uint8Array(FAKE_JPG))).toBe("jpg");
  });
  it("rejects webp/gif bytes pdf-lib can't embed", () => {
    expect(detectImageKind(new Uint8Array(Buffer.from("RIFF....WEBP", "ascii")))).toBeNull();
    expect(detectImageKind(new Uint8Array(Buffer.from("GIF89a", "ascii")))).toBeNull();
    expect(detectImageKind(new Uint8Array(0))).toBeNull();
  });
});

describe("sanitizeVersion", () => {
  it("trims and strips filename-illegal characters", () => {
    expect(sanitizeVersion("  v3// ")).toBe("v3");
    expect(sanitizeVersion('v2: final?"')).toBe("v2 final");
  });
  it("falls back to v1 when blank", () => {
    expect(sanitizeVersion("")).toBe("v1");
    expect(sanitizeVersion("   ")).toBe("v1");
  });
});

describe("footerText / storyboardPdfFileName", () => {
  it("pairs the production name with the version", () => {
    expect(footerText("My Film", "v3")).toBe("My Film — Storyboard v3");
    expect(footerText("", "")).toBe("Untitled production — Storyboard v1");
  });
  it("builds a filename-safe default name", () => {
    expect(storyboardPdfFileName("My Film", "v3")).toBe("My-Film-storyboard-v3.pdf");
    expect(storyboardPdfFileName("", "")).toBe("untitled-production-storyboard-v1.pdf");
  });
});

describe("paginatePanels", () => {
  const panels = [1, 2, 3, 4];
  it("puts one panel per page in single mode", () => {
    expect(paginatePanels(panels, 1)).toEqual([[1], [2], [3], [4]]);
  });
  it("chunks three panels per page in triple mode", () => {
    expect(paginatePanels(panels, 3)).toEqual([[1, 2, 3], [4]]);
  });
  it("handles an empty board", () => {
    expect(paginatePanels([], 3)).toEqual([]);
  });
});

describe("wrapText / fitLines", () => {
  const measure = (s: string) => s.length * 6;
  it("wraps greedy words within the width", () => {
    expect(wrapText("aa bb cc", 13, measure)).toEqual(["aa", "bb", "cc"]);
    expect(wrapText("aa bb", 100, measure)).toEqual(["aa bb"]);
  });
  it("keeps explicit paragraphs", () => {
    expect(wrapText("aa\n\nbb", 100, measure)).toEqual(["aa", "", "bb"]);
  });
  it("truncates with an ellipsis", () => {
    expect(fitLines(["a", "b", "c"], 2)).toEqual(["a", "b…"]);
    expect(fitLines(["a"], 5)).toEqual(["a"]);
    expect(fitLines(["a", "b"], 0)).toEqual([]);
  });
});

// ---- disk-backed loaders ---------------------------------------------------

describe("loadPanelImage", () => {
  it("returns null when the shot has no frame", () => {
    const p = makeProduction();
    expect(loadPanelImage(p, makeShot(), readFile)).toBeNull();
  });
  it("falls back to the JPEG preview when no original exists", () => {
    const rel = "boards/0100/shot-0100-a.jpg";
    fs.mkdirSync(path.join(prodFolder, "boards/0100"), { recursive: true });
    fs.writeFileSync(path.join(prodFolder, rel), FAKE_JPG);
    const p = makeProduction();
    expect(loadPanelImage(p, makeShot({ artwork: rel }), readFile)?.kind).toBe("jpg");
  });
  it("prefers the full-res original over the preview", () => {
    const rel = "boards/0100/shot-0100-a.jpg";
    fs.mkdirSync(path.join(prodFolder, "boards/0100/originals"), { recursive: true });
    fs.writeFileSync(path.join(prodFolder, rel), FAKE_JPG);
    fs.writeFileSync(path.join(prodFolder, "boards/0100/originals/shot-0100-a.png"), PNG_1X1);
    const p = makeProduction();
    expect(loadPanelImage(p, makeShot({ artwork: rel }), readFile)?.kind).toBe("png");
  });
  it("skips a non-embeddable original and uses the preview", () => {
    const rel = "boards/0100/shot-0100-a.jpg";
    fs.mkdirSync(path.join(prodFolder, "boards/0100/originals"), { recursive: true });
    fs.writeFileSync(path.join(prodFolder, rel), FAKE_JPG);
    fs.writeFileSync(path.join(prodFolder, "boards/0100/originals/shot-0100-a.webp"), Buffer.from("RIFF....WEBP", "ascii"));
    const p = makeProduction();
    expect(loadPanelImage(p, makeShot({ artwork: rel }), readFile)?.kind).toBe("jpg");
  });
});

describe("loadLogoImage", () => {
  it("returns null when no logo is attached", () => {
    expect(loadLogoImage(makeProduction(), readFile)).toBeNull();
  });
  it("reads the stored logo asset", () => {
    const rel = "boards/storyboard-logo.png";
    fs.mkdirSync(path.join(prodFolder, "boards"), { recursive: true });
    fs.writeFileSync(path.join(prodFolder, rel), PNG_1X1);
    const p = makeProduction({ storyboardPdf: { logoRel: rel } });
    expect(loadLogoImage(p, readFile)?.kind).toBe("png");
  });
});

// ---- full render -----------------------------------------------------------

describe("buildStoryboardPdf", () => {
  it("renders one landscape page per panel in single mode", async () => {
    const bytes = await buildStoryboardPdf([makePanel(0), makePanel(1)], {
      productionName: "Test Production",
      version: "v3",
      panelsPerPage: 1,
    });
    expect(Buffer.from(bytes).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    const { width: w, height: h } = doc.getPage(0).getSize();
    expect(w).toBeGreaterThan(h); // landscape
  });
  it("packs three panels per page in triple mode", async () => {
    const panels = [makePanel(0), makePanel(1), makePanel(2), makePanel(3)];
    const bytes = await buildStoryboardPdf(panels, {
      productionName: "Test Production",
      version: "v3",
      panelsPerPage: 3,
      logo: { bytes: new Uint8Array(PNG_1X1), kind: "png" },
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
  });
  it("renders placeholder panels without frames", async () => {
    const bytes = await buildStoryboardPdf(
      [{ number: "0100", audio: "Wind.", visual: "Valley.", image: null }],
      { productionName: "Test Production", version: "", panelsPerPage: 1 }
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toContain("v1");
  });
  it("embeds the Audio/Visual text and footer in the page content", async () => {
    const bytes = await buildStoryboardPdf(
      [{ number: "0100", audio: "Zebra audio marker.", visual: "Quokka visual marker.", image: null }],
      { productionName: "Test Production", version: "v7", panelsPerPage: 1 }
    );
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: Buffer.from(bytes) });
    try {
      const result = (await parser.getText()) as { text?: string; pages?: unknown[] };
      const text = String(result.text ?? "");
      expect(text).toContain("Zebra audio marker");
      expect(text).toContain("Quokka visual marker");
      expect(text).toContain("Test Production");
      expect(text).toContain("v7");
      expect(result.pages).toHaveLength(1);
    } finally {
      await parser.destroy();
    }
  });
});
