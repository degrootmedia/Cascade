/**
 * scripting.ts tests — deterministic script text extraction (Step 1 part A).
 *
 * The Google Docs cases pin a live failure chain: with sharing off on the
 * doc, every Google-link ingest failed at the LLM call while the same
 * script as a local .docx ingested fine. The export path accepted whatever
 * Google returned — including an HTML sign-in/interstitial page — as
 * script text. An HTML body must be refused here with the sharing hint.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("pdf-parse", () => ({
  PDFParse: class {
    async getText() {
      return { text: "INT. PDF STAGE - DAY\nExtracted from the pdf.", total: 1, pages: [] };
    }
    async destroy() {}
  },
}));
vi.mock("mammoth", () => ({ extractRawText: async () => ({ value: "" }) }));

import { extractScriptText } from "../src/main/scripting.js";

const DOC_URL = "https://docs.google.com/document/d/1BogiDoCId1234567890abcd/edit?usp=sharing";
const SHARING_HINT = /Anyone with the link/;

function stubFetch(status: number, body: string, contentType: string): void {
  vi.stubGlobal("fetch", async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractScriptText (Google Docs)", () => {
  it("returns the document text from a text/plain export", async () => {
    stubFetch(200, "INT. STUDIO - DAY\nSanta enters.\n", "text/plain; charset=utf-8");
    const out = await extractScriptText(DOC_URL);
    expect(out.format).toBe("Google Doc");
    expect(out.text).toContain("Santa enters.");
  });

  it("refuses an HTML page instead of treating it as the script", async () => {
    stubFetch(200, '<!DOCTYPE html><html lang="en"><head><script>sign in</script></head></html>', "text/html; charset=utf-8");
    await expect(extractScriptText(DOC_URL)).rejects.toThrow(SHARING_HINT);
  });

  it("refuses HTML even when the content-type claims text", async () => {
    stubFetch(200, "  \n<html><body>Google Docs sign in</body></html>", "text/plain; charset=utf-8");
    await expect(extractScriptText(DOC_URL)).rejects.toThrow(SHARING_HINT);
  });

  it("keeps the sharing hint for an HTTP 403 export", async () => {
    stubFetch(403, "", "text/html; charset=utf-8");
    await expect(extractScriptText(DOC_URL)).rejects.toThrow(SHARING_HINT);
  });
});

describe("extractScriptText (PDF)", () => {
  it("extracts text through the pdf-parse v2 API", async () => {
    const out = await extractScriptText("C:/scripts/scene.pdf", async () => Buffer.from("%PDF-fake"));
    expect(out.format).toBe("PDF");
    expect(out.text).toContain("Extracted from the pdf.");
  });
});
