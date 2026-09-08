/**
 * Storyboard PDF export — the printable storyboard module.
 *
 * Deep module with a small surface. The pure layout helpers (paginatePanels,
 * wrapText, fitLines, detectImageKind, footerText, storyboardPdfFileName) hold
 * the real logic and are unit-tested in app/test/storyboard-pdf.test.ts.
 * `buildStoryboardPdf()` renders landscape pages (1 or 3 panels per page)
 * through pdf-lib; `loadPanelImage()` / `loadLogoImage()` resolve board art
 * through an injected `readFile` seam so tests never touch disk.
 *
 * Panel rule (mirrors the Step 3 board grid): the full-res original is
 * preferred for print, falling back to the JPEG preview when the original is
 * missing or isn't embeddable (webp/gif). Shots with no frame at all render
 * a placeholder box so the Audio/Visual text still prints. Frames are always
 * exact 16:9 — borderless, image cover-cropped (center) to fill edge to edge.
 */
import { PDFDocument, StandardFonts, rgb, grayscale, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, type PDFFont, type PDFPage, type PDFImage } from "pdf-lib";
import type { Production, ProductionShot } from "../shared/ipc.js";
import { assetPath, originalForJpegRel } from "./pipeline.js";

/** Raw image bytes plus the only two kinds pdf-lib can embed. */
export interface StoryboardPdfImage {
  bytes: Uint8Array;
  kind: "png" | "jpg";
}

/** One printable panel: still frame (optional) + Audio/Visual direction. */
export interface StoryboardPdfPanel {
  number: string;
  audio: string;
  visual: string;
  image?: StoryboardPdfImage | null;
}

export interface StoryboardPdfOptions {
  productionName: string;
  /** Free-typed by the user per export (e.g. "v3"); remembered per production. */
  version: string;
  panelsPerPage: 1 | 3;
  logo?: StoryboardPdfImage | null;
}

/** File reads go through this seam so tests can fake the disk. */
export type ReadFileFn = (absPath: string) => Uint8Array | null;

/** Landscape A4 in PDF points. */
export const STORYBOARD_PAGE_SIZE: [number, number] = [841.89, 595.28];

const MARGIN = 36;
const FOOTER_H = 30;
const INK = rgb(0.13, 0.13, 0.13);
const MUTED = grayscale(0.42);
const HAIRLINE = grayscale(0.72);
const PLACEHOLDER_FILL = grayscale(0.94);

/** Sniff PNG vs JPEG from magic bytes; null when pdf-lib can't embed it. */
export function detectImageKind(bytes: Uint8Array): "png" | "jpg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  return null;
}

function tryReadImage(readFile: ReadFileFn, p: Production, rel: string): StoryboardPdfImage | null {
  let abs: string;
  try {
    abs = assetPath(p, rel);
  } catch {
    return null;
  }
  let bytes: Uint8Array | null = null;
  try {
    bytes = readFile(abs);
  } catch {
    return null;
  }
  if (!bytes || !bytes.length) return null;
  const kind = detectImageKind(bytes);
  return kind ? { bytes, kind } : null;
}

/**
 * Resolve a shot's printable still: full-res original first (the file the
 * external editor touches), JPEG preview fallback. Null when the shot has no
 * frame or nothing embeddable exists.
 */
export function loadPanelImage(p: Production, shot: ProductionShot, readFile: ReadFileFn): StoryboardPdfImage | null {
  if (!shot.artwork) return null;
  const originalRel = originalForJpegRel(p, shot.artwork);
  if (originalRel) {
    const img = tryReadImage(readFile, p, originalRel);
    if (img) return img;
  }
  return tryReadImage(readFile, p, shot.artwork);
}

/** Resolve the stored production logo (`storyboardPdf.logoRel`), if any. */
export function loadLogoImage(p: Production, readFile: ReadFileFn): StoryboardPdfImage | null {
  const rel = p.storyboardPdf?.logoRel;
  if (!rel) return null;
  return tryReadImage(readFile, p, rel);
}

/** "  v3// " → "v3"; blank → "v1" so the footer/filename never go empty. */
export function sanitizeVersion(v: string): string {
  const clean = (v ?? "").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 24);
  return clean || "v1";
}

/** Lower-left footer: production name + storyboard version. */
export function footerText(productionName: string, version: string): string {
  const name = (productionName ?? "").trim() || "Untitled production";
  return `${name} — Storyboard ${sanitizeVersion(version)}`;
}

/** Default save name: "<name>-storyboard-<version>.pdf", filename-safe. */
export function storyboardPdfFileName(productionName: string, version: string): string {
  const base = ((productionName ?? "").trim() || "untitled-production")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "untitled-production";
  return `${base}-storyboard-${sanitizeVersion(version)}.pdf`;
}

/** Chunk panels into pages (1 or 3 per page). */
export function paginatePanels<T>(panels: T[], panelsPerPage: 1 | 3): T[][] {
  const per = panelsPerPage === 3 ? 3 : 1;
  const pages: T[][] = [];
  for (let i = 0; i < panels.length; i += per) pages.push(panels.slice(i, i + per));
  return pages;
}

/** Greedy word-wrap; paragraphs (explicit newlines) survive intact. */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of String(text ?? "").split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (const w of words) {
      const cand = line ? `${line} ${w}` : w;
      if (measure(cand) <= maxWidth || !line) {
        line = cand;
      } else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

/** Cap wrapped lines to the box; the last visible line takes an ellipsis. */
export function fitLines(lines: string[], maxLines: number): string[] {
  if (maxLines < 1) return [];
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].replace(/\s+$/, "")}…`;
  return kept;
}

/** Largest exact-16:9 rect that fits inside maxW × maxH. */
export function contain16x9(maxW: number, maxH: number): { w: number; h: number } {
  const ratio = 16 / 9;
  if (maxW / maxH > ratio) return { w: maxH * ratio, h: maxH };
  return { w: maxW, h: maxW / ratio };
}

/** Cover-scale placement: image fills the frame, center-cropped, no distortion. */
export function coverImageRect(
  frameX: number,
  frameY: number,
  frameW: number,
  frameH: number,
  imgW: number,
  imgH: number
): { x: number; y: number; width: number; height: number } {
  const scale = Math.max(frameW / imgW, frameH / imgH);
  const dw = imgW * scale;
  const dh = imgH * scale;
  return { x: frameX + (frameW - dw) / 2, y: frameY + (frameH - dh) / 2, width: dw, height: dh };
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** Draw one "LABEL:" box with wrapped body text inside a fixed rect. */
function drawLabeledBox(
  page: PDFPage,
  fonts: Fonts,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  text: string,
  textSize: number
): void {
  page.drawRectangle({ x, y, width: w, height: h, borderColor: HAIRLINE, borderWidth: 0.75 });
  const pad = 6;
  const labelSize = Math.min(textSize + 0.5, 11);
  page.drawText(label, { x: x + pad, y: y + h - pad - labelSize + 2, size: labelSize, font: fonts.bold, color: INK });
  const bodyTop = y + h - pad - labelSize - 4;
  const lineHeight = textSize + 3.5;
  const maxLines = Math.max(1, Math.floor((bodyTop - (y + pad) + lineHeight - textSize) / lineHeight));
  const measure = (s: string) => fonts.regular.widthOfTextAtSize(s, textSize);
  const lines = fitLines(wrapText(text?.trim() || "—", w - pad * 2, measure), maxLines);
  lines.forEach((ln, i) => {
    page.drawText(ln || " ", {
      x: x + pad,
      y: bodyTop - textSize - i * lineHeight + 2,
      size: textSize,
      font: fonts.regular,
      color: INK,
    });
  });
}

/** Draw the still frame: exact-16:9 rect, borderless, image cover-cropped to
 * fill it. Null image draws the placeholder box (the only framed state). */
async function drawFrame(
  doc: PDFDocument,
  page: PDFPage,
  fonts: Fonts,
  x: number,
  y: number,
  w: number,
  h: number,
  image: StoryboardPdfImage | null | undefined,
  shotNumber: string
): Promise<void> {
  if (!image) {
    page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      color: PLACEHOLDER_FILL,
      borderColor: HAIRLINE,
      borderWidth: 0.75,
    });
    const msg = `No frame yet — Shot ${shotNumber}`;
    const size = 10;
    const tw = fonts.regular.widthOfTextAtSize(msg, size);
    page.drawText(msg, { x: x + (w - tw) / 2, y: y + (h - size) / 2, size, font: fonts.regular, color: MUTED });
    return;
  }
  const embedded = image.kind === "png" ? await doc.embedPng(image.bytes) : await doc.embedJpg(image.bytes);
  const placed = coverImageRect(x, y, w, h, embedded.width, embedded.height);
  page.pushOperators(pushGraphicsState(), rectangle(x, y, w, h), clip(), endPath());
  page.drawImage(embedded, { x: placed.x, y: placed.y, width: placed.width, height: placed.height });
  page.pushOperators(popGraphicsState());
}

function drawFooter(
  page: PDFPage,
  fonts: Fonts,
  pageW: number,
  opts: StoryboardPdfOptions,
  pageIndex: number,
  pageCount: number,
  logo: PDFImage | null
): void {
  const y = MARGIN - 22;
  page.drawText(footerText(opts.productionName, opts.version), {
    x: MARGIN,
    y,
    size: 9,
    font: fonts.regular,
    color: MUTED,
  });
  const counter = `Page ${pageIndex + 1} of ${pageCount}`;
  const cs = 9;
  page.drawText(counter, {
    x: (pageW - fonts.regular.widthOfTextAtSize(counter, cs)) / 2,
    y,
    size: cs,
    font: fonts.regular,
    color: MUTED,
  });
  if (logo) {
    const maxW = 130;
    const maxH = FOOTER_H - 4;
    const scale = Math.min(maxW / logo.width, maxH / logo.height, 1);
    const dw = logo.width * scale;
    const dh = logo.height * scale;
    page.drawImage(logo, { x: pageW - MARGIN - dw, y: MARGIN - 20, width: dw, height: dh });
  }
}

async function drawSinglePanelPage(
  doc: PDFDocument,
  page: PDFPage,
  fonts: Fonts,
  panel: StoryboardPdfPanel,
  pageW: number,
  pageH: number
): Promise<void> {
  const contentW = pageW - MARGIN * 2;
  const contentTop = pageH - MARGIN;
  const contentBottom = MARGIN + FOOTER_H;
  let cursor = contentTop;
  const headerSize = 15;
  page.drawText(`Shot ${panel.number}`, { x: MARGIN, y: cursor - headerSize, size: headerSize, font: fonts.bold, color: INK });
  cursor -= headerSize + 10;
  const gap = 8;
  const availH = cursor - contentBottom;
  const frameH = Math.max(140, Math.min(310, availH - 130));
  // Exact 16:9, centered — the cover-crop in drawFrame fills it edge to edge.
  const { w: frameW } = contain16x9(contentW, frameH);
  const frameX = MARGIN + (contentW - frameW) / 2;
  const boxesH = availH - frameH - gap * 2;
  const boxH = boxesH / 2;
  await drawFrame(doc, page, fonts, frameX, cursor - frameH, frameW, frameH, panel.image, panel.number);
  cursor -= frameH + gap;
  drawLabeledBox(page, fonts, MARGIN, cursor - boxH, contentW, boxH, "Audio:", panel.audio, 9.5);
  cursor -= boxH + gap;
  drawLabeledBox(page, fonts, MARGIN, contentBottom, contentW, cursor - contentBottom, "Visual:", panel.visual, 9.5);
}

async function drawTriplePanelPage(
  doc: PDFDocument,
  page: PDFPage,
  fonts: Fonts,
  panels: StoryboardPdfPanel[],
  pageW: number,
  pageH: number
): Promise<void> {
  const contentW = pageW - MARGIN * 2;
  const contentTop = pageH - MARGIN;
  const contentBottom = MARGIN + FOOTER_H;
  const rowGap = 10;
  const rowH = (contentTop - contentBottom - rowGap * (panels.length - 1)) / panels.length;
  let top = contentTop;
  for (const panel of panels) {
    const rowY = top - rowH;
    // Exact 16:9 frame, vertically centered in the row; narrow rows keep full
    // height, tall rows (1–2 panels on the last page) cap at 300 wide.
    const fitted = contain16x9(Math.min(300, contentW), rowH);
    const frameW = fitted.w;
    const frameH = fitted.h;
    const frameY = rowY + (rowH - frameH) / 2;
    await drawFrame(doc, page, fonts, MARGIN, frameY, frameW, frameH, panel.image, panel.number);
    const textX = MARGIN + frameW + 10;
    const textW = contentW - frameW - 10;
    const headSize = 11;
    page.drawText(`Shot ${panel.number}`, { x: textX, y: top - headSize - 1, size: headSize, font: fonts.bold, color: INK });
    const boxesTop = top - headSize - 7;
    const innerGap = 5;
    const upperH = (boxesTop - rowY - innerGap) / 2;
    if (upperH >= 26) {
      drawLabeledBox(page, fonts, textX, boxesTop - upperH, textW, upperH, "Audio:", panel.audio, 8.5);
      drawLabeledBox(page, fonts, textX, rowY, textW, boxesTop - upperH - innerGap - rowY, "Visual:", panel.visual, 8.5);
    } else {
      // Extremely short rows (shouldn't happen on A4): single combined box.
      drawLabeledBox(page, fonts, textX, rowY, textW, boxesTop - rowY, "Audio / Visual:", `${panel.audio}\n${panel.visual}`, 8.5);
    }
    top = rowY - rowGap;
  }
}

/**
 * Render the full storyboard PDF. Every shot becomes one panel (frame or
 * placeholder + Audio box + Visual box) on landscape A4 pages.
 */
export async function buildStoryboardPdf(
  panels: StoryboardPdfPanel[],
  opts: StoryboardPdfOptions
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${(opts.productionName || "Untitled production").trim()} — Storyboard ${sanitizeVersion(opts.version)}`);
  doc.setProducer("Cascade");
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const perPage = opts.panelsPerPage === 3 ? 3 : 1;
  const groups = paginatePanels(panels, perPage);
  const [pageW, pageH] = STORYBOARD_PAGE_SIZE;

  let logo: PDFImage | null = null;
  if (opts.logo) {
    try {
      logo = opts.logo.kind === "png" ? await doc.embedPng(opts.logo.bytes) : await doc.embedJpg(opts.logo.bytes);
    } catch {
      logo = null;
    }
  }

  if (!groups.length) {
    const page = doc.addPage(STORYBOARD_PAGE_SIZE);
    const msg = "No shots yet — ingest a script in Step 1 first.";
    const size = 12;
    page.drawText(msg, {
      x: (pageW - fonts.regular.widthOfTextAtSize(msg, size)) / 2,
      y: pageH / 2,
      size,
      font: fonts.regular,
      color: MUTED,
    });
    drawFooter(page, fonts, pageW, opts, 0, 1, logo);
    return doc.save();
  }

  for (let i = 0; i < groups.length; i++) {
    const page = doc.addPage(STORYBOARD_PAGE_SIZE);
    if (perPage === 3) {
      await drawTriplePanelPage(doc, page, fonts, groups[i], pageW, pageH);
    } else {
      await drawSinglePanelPage(doc, page, fonts, groups[i][0], pageW, pageH);
    }
    drawFooter(page, fonts, pageW, opts, i, groups.length, logo);
  }
  return doc.save();
}
