/**
 * Deterministic script text extraction (Step 1, part A) — no LLM involved.
 * Supported: .txt / .md / .fountain (raw), .pdf (pdf-parse), .docx (mammoth),
 * Google Docs share URLs (export?format=txt). Legacy .doc is rejected with a
 * re-save hint per the plan's v1 decision.
 */

export interface ExtractedScript {
  /** Clean plain text of the whole script. */
  text: string;
  /** Human label of the source type, shown in the UI. */
  format: string;
}

/** Google Docs share/editor URL -> doc id. */
export function googleDocId(url: string): string | null {
  const m = url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{10,})/);
  return m ? m[1] : null;
}

export function isGoogleDocUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim()) && !!googleDocId(s);
}

/** Collapse the junk extraction libs emit (form feeds, trailing spaces, 3+ newlines). */
function clean(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fromPdf(buf: Buffer): Promise<string> {
  // Import the inner entry point: the package root runs debug code when it
  // thinks it's executed outside a bundler. Types come from pdf-parse.d.ts.
  const { default: pdf } = await import("pdf-parse/lib/pdf-parse.js");
  const parsed = await pdf(buf);
  return parsed.text;
}

async function fromDocx(buf: Buffer): Promise<string> {
  const mammoth = (await import("mammoth")) as {
    extractRawText: (o: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return value;
}

async function fromGoogleDoc(url: string): Promise<string> {
  const id = googleDocId(url)!;
  // format=txt avoids needing mammoth for the Google path entirely.
  const res = await fetch(`https://docs.google.com/document/d/${id}/export?format=txt`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404 || res.status === 403) {
    throw new Error(
      "Google Doc refused the export — set sharing to “Anyone with the link”, or download it as .docx and import the file."
    );
  }
  if (!res.ok) throw new Error(`Google Docs export failed (HTTP ${res.status})`);
  return await res.text();
}

/**
 * Extract script text from a local file path or a Google Docs URL.
 * `readFile` is injected so tests can stub the filesystem.
 */
export async function extractScriptText(
  source: string,
  readFile: (p: string) => Promise<Buffer> = (p) => import("node:fs").then((fs) => fs.promises.readFile(p))
): Promise<ExtractedScript> {
  const s = source.trim();
  if (!s) throw new Error("No script source given");

  if (isGoogleDocUrl(s)) {
    return { text: clean(await fromGoogleDoc(s)), format: "Google Doc" };
  }

  const ext = (s.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  let buf: Buffer;
  try {
    buf = await readFile(s);
  } catch {
    throw new Error(`Can't read ${s}`);
  }
  switch (ext) {
    case "txt":
    case "md":
    case "markdown":
    case "fountain":
      return { text: clean(buf.toString("utf8")), format: ext.toUpperCase() };
    case "pdf": {
      try {
        return { text: clean(await fromPdf(buf)), format: "PDF" };
      } catch (e) {
        throw new Error(`PDF text extraction failed (${String(e)}). Scanned PDFs have no text layer — try a .docx or text export.`);
      }
    }
    case "docx":
      try {
        return { text: clean(await fromDocx(buf)), format: "DOCX" };
      } catch (e) {
        throw new Error(`DOCX extraction failed (${String(e)})`);
      }
    case "doc":
      throw new Error("Legacy .doc isn't supported — open it and Save As → .docx, then import that file.");
    default:
      // No extension knowledge: sniff DOCX (zip magic PK) vs try as text.
      if (buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
        return { text: clean(await fromDocx(buf)), format: "DOCX" };
      }
      return { text: clean(buf.toString("utf8")), format: "text" };
  }
}
