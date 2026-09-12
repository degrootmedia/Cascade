/**
 * Cascade's shared text-serialization grammar.
 *
 * The prompt text is a protocol: `@[Name]` reference tags, `Style:` /
 * `Brand identity:` paragraphs, loose JSON extracted from model/MCP prose, and
 * the media helpers (data URLs, image/video URLs) that code across main and
 * renderer must agree on. This module is the one home for those grammars —
 * anything re-parsing them by hand is a duplication to consolidate here. It is
 * environment-agnostic (no Electron, no Buffer) so main, renderer, and tests
 * all import the same code.
 */

// ---- reference tags: @[Name] ----------------------------------------------

/** One `@[Name]` occurrence in a prompt (in document order). */
export interface RefTagMatch {
  /** The full tag text, e.g. `@[Gandalf]`. */
  tag: string;
  /** The name between the brackets. */
  name: string;
  /** Character offset of the tag in the source text. */
  index: number;
}

/** All `@[Name]` occurrences in order. */
export function refTagMatches(text: string): RefTagMatch[] {
  return Array.from(text.matchAll(/@\[([^\]]+)\]/g)).map((m) => ({
    tag: m[0],
    name: m[1],
    index: m.index ?? 0,
  }));
}

/** The names cited by `@[Name]` tags, in document order. */
export function refTagNames(text: string): string[] {
  return refTagMatches(text).map((m) => m.name);
}

/** Escape a literal string for use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive pattern matching one exact `@[Name]` tag. */
export function refTagPattern(name: string): RegExp {
  return new RegExp(`@\\[${escapeRegExp(name)}\\]`, "gi");
}

/** True when the text already cites this reference. */
export function hasRefTag(text: string, name: string): boolean {
  return refTagPattern(name).test(text);
}

/** Append an `@[Name]` tag beneath the content paragraphs — before the
 *  generated `Brand identity:` section when one is present, so tags never
 *  land after the brand. Idempotent (case-insensitive). */
export function addRefTag(text: string, name: string): string {
  const tag = `@[${name}]`;
  if (hasRefTag(text, name)) return text;
  const brand = BRAND_PARA_HEAD_RE.exec(text);
  if (brand) {
    const start = brand.index + (brand[0].startsWith("\n\n") ? 2 : 0);
    const before = text.slice(0, start).trimEnd();
    const after = text.slice(start);
    return before ? `${before}\n\n${tag}\n\n${after}` : `${tag}\n\n${after}`;
  }
  const base = text.trimEnd();
  return base ? `${base}\n\n${tag}` : tag;
}

/** Remove every occurrence of one `@[Name]` tag and tidy leftover blank lines. */
export function removeRefTag(text: string, name: string): string {
  return text.replace(refTagPattern(name), "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Strip every `@[Name]` tag (used to compare the non-tag text of two prompts). */
export function stripRefTags(text: string): string {
  return text.replace(/@\[[^\]]+\]/g, "");
}

/** True when two prompt texts differ only by `@[Name]` tags (add, remove,
 *  replace, or reorder) — the surrounding prose is identical modulo
 *  whitespace. Graph-side connect/disconnect mutations are exactly this shape,
 *  so a focused content editor can accept them without moving the caret off
 *  the user's unsaved typing, while genuine prose edits stay deferred. */
export function isTagOnlyDiff(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (s: string) => stripRefTags(s).replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

/** Replace the `@[Name]` tag at occurrence `index` with a different reference
 *  name, preserving its position in the prompt. Used when a connection is
 *  dropped onto an occupied socket: the incoming reference takes the slot the
 *  old one held instead of appending. An out-of-range index appends instead.
 *  The incoming name is kept only once — any other occurrence of it is dropped
 *  so a reference is never cited twice. */
export function replaceRefTagAt(text: string, index: number, name: string): string {
  const matches = refTagMatches(text);
  if (index < 0 || index >= matches.length) return addRefTag(text, name);
  let out = "";
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    out += text.slice(cursor, m.index);
    cursor = m.index + m.tag.length;
    if (i === index) out += `@[${name}]`;
    else if (m.name.toLowerCase() !== name.toLowerCase()) out += m.tag;
  }
  out += text.slice(cursor);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// ---- Style / Brand identity paragraphs ------------------------------------

/** The whole `Brand identity:` paragraph (leading or following a blank line). */
export const BRAND_PARA_RE = /(?:^|\n\n)Brand identity: [^\n]*(?=\n\n|$)/;
/** Head anchor of a `Brand identity:` paragraph (for placement checks). */
export const BRAND_PARA_HEAD_RE = /(?:^|\n\n)Brand identity: /;
/** The whole `Style:` paragraph. */
export const STYLE_PARA_RE = /(?:^|\n\n)Style:[\s\S]*?(?=\n\n|$)/;

/** True when the text carries a `Brand identity:` paragraph. */
export function hasBrandParagraph(text: string): boolean {
  return BRAND_PARA_HEAD_RE.test(text);
}

/** Remove the `Brand identity:` paragraph and tidy leftover blank lines. */
export function stripBrandParagraph(text: string): string {
  return text.replace(BRAND_PARA_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Append a `Brand identity:` paragraph — idempotent: never adds a second one
 *  when the text already carries one (the existing clause is left untouched,
 *  so a manual prompt keeps its own wording). */
export function insertBrandParagraph(text: string, clause: string): string {
  if (!clause || hasBrandParagraph(text)) return text;
  const base = text.trimEnd();
  return base ? `${base}\n\nBrand identity: ${clause}` : `Brand identity: ${clause}`;
}

/** Remove the `Style:` paragraph and tidy leftover blank lines. */
export function stripStyleParagraph(text: string): string {
  return text.replace(STYLE_PARA_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Insert (or replace) the leading `Style:` paragraph. */
export function addStyleParagraph(text: string, styleText: string): string {
  if (!styleText) return text;
  const para = `Style: ${styleText}`;
  const rest = text.replace(STYLE_PARA_RE, "").trim();
  return rest ? `${para}\n\n${rest}` : para;
}

/** Alias for stripStyleParagraph (paragraph-scoped Style section). */
export const removeStyleParagraph = stripStyleParagraph;

/** Split a prompt into its Style / content / Brand paragraphs. The first
 *  `Style:` and `Brand identity:` paragraphs become the boxes; everything
 *  else (including @[tag] paragraphs) is content. */
export interface PromptBoxes {
  style: string;
  content: string;
  brand: string;
}

export function parsePromptBoxes(prompt: string): PromptBoxes {
  const boxes: PromptBoxes = { style: "", content: "", brand: "" };
  const content: string[] = [];
  for (const para of prompt.split(/\n\n+/)) {
    const p = para.trim();
    if (!p) continue;
    if (!boxes.style && /^Style:[ \t]*/.test(p)) { boxes.style = p.replace(/^Style:[ \t]*/, ""); continue; }
    if (!boxes.brand && /^Brand identity:[ \t]*/.test(p)) { boxes.brand = p.replace(/^Brand identity:[ \t]*/, ""); continue; }
    content.push(p);
  }
  boxes.content = content.join("\n\n");
  return boxes;
}

/** Rebuild the prompt from the three boxes (style → content → brand). */
export function composePromptBoxes(b: PromptBoxes): string {
  const paras: string[] = [];
  const style = b.style.replace(/\n\s*\n/g, "\n").trim();
  if (style) paras.push(`Style: ${style}`);
  const content = b.content.trim();
  if (content) paras.push(content);
  if (b.brand.trim()) paras.push(`Brand identity: ${b.brand.replace(/\n\s*\n/g, "\n").trimEnd()}`);
  return paras.join("\n\n");
}

/** The obsolete "Reference images by id" alias clause appended to legacy prompts. */
const REFERENCE_CLAUSE_RE = /(?:\n+|^)Reference images by id[^\n]*(?:\n*)$/;

/** Remove the obsolete reference-alias clause from a stored or edited prompt. */
export function stripReferenceClause(prompt: string): string {
  return prompt.replace(REFERENCE_CLAUSE_RE, "").trim();
}

// ---- loose JSON from model/MCP prose --------------------------------------

/** Strip code fences and stray prose around a model/MCP reply. */
function looseJsonBody(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

/** Extract a JSON object from prose; null when none can be parsed. */
export function parseJsonLooseObject(text: string): Record<string, unknown> | null {
  const t = looseJsonBody(text);
  try {
    const j = JSON.parse(t);
    if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch { /* fall through to bracket extraction */ }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const j = JSON.parse(t.slice(start, end + 1));
    if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch { /* not JSON after all */ }
  return null;
}

/** Extract a JSON array from prose; null when none can be parsed. */
export function parseJsonLooseArray(text: string): unknown[] | null {
  const t = looseJsonBody(text);
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j;
  } catch { /* fall through to bracket extraction */ }
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const j = JSON.parse(t.slice(start, end + 1));
    if (Array.isArray(j)) return j;
  } catch { /* not JSON after all */ }
  return null;
}

// ---- media helpers ----------------------------------------------------------

/** Decode a `data:<mime>;base64,<payload>` URL into raw bytes (chunked so
 *  multi-MB base64 never hits a single-string decode limit). Env-agnostic:
 *  uses the global `atob`, no Buffer. Null when the URL isn't a valid data URL. */
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  const header = dataUrl.slice(0, comma);
  if (!header.includes(";base64")) return null;
  try {
    const clean = dataUrl.slice(comma + 1).replace(/\s/g, "");
    const chunkSize = 32768; // multiple of 4 so chunk padding stays valid
    const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    const totalLen = Math.ceil((clean.length * 3) / 4) - padding;
    const bytes = new Uint8Array(totalLen);
    let offset = 0;
    for (let i = 0; i < clean.length; i += chunkSize) {
      const slice = clean.slice(i, i + chunkSize);
      const bin = atob(slice);
      for (let j = 0; j < bin.length; j++) bytes[offset++] = bin.charCodeAt(j);
    }
    return offset === bytes.length ? bytes : bytes.slice(0, offset);
  } catch {
    return null;
  }
}

/** A URL pointing at a raster image (png/jpeg/webp/gif), global for matchAll. */
export const IMAGE_URL_RX = /https:\/\/[^\s"')\]}>]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"')\]}>]*)?/gi;
/** A URL pointing at a video file (mp4/webm/mov/m4v). */
export const VIDEO_URL_RX = /https:\/\/[^\s"')\]}>]+\.(?:mp4|webm|mov|m4v)(?:\?[^\s"')\]}>]*)?/i;
/** File-extension match for image URIs (from a content item, not a URL scan). */
export const IMAGE_URI_EXT_RX = /\.(?:png|jpe?g|webp)(?:\?|$)/i;
/** File-extension match for video URIs. */
export const VIDEO_URI_EXT_RX = /\.(?:mp4|webm|mov|m4v)(?:\?|$)/i;