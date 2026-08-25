/**
 * Types for untyped script-extraction dependencies used by scripting.ts.
 * pdf-parse ships no .d.ts; we only use its text output.
 */
declare module "pdf-parse/lib/pdf-parse.js" {
  export interface PdfParseResult {
    text: string;
    numpages: number;
    info?: unknown;
  }
  export default function pdfParse(buffer: Buffer): Promise<PdfParseResult>;
}
