/**
 * Clipboard → plain text, preserving document structure.
 *
 * Rich sources (AI-chat web pages, Google Docs, Word) put the real structure
 * in the clipboard's `text/html` flavor. Chromium's derived `text/plain`
 * flavor routinely flattens paragraph breaks, so a pasted answer arrives with
 * its paragraphs run together. When HTML is present this module converts it
 * ourselves — block elements become blank lines, `<br>` a single newline,
 * `<pre>` keeps its own whitespace, and literal newlines inside text (pre-wrap
 * surfaces such as our own chat bubbles) are preserved. Clipboards with only
 * plain text pass through unchanged.
 */

/** Elements whose boundaries are paragraph-ish (blank-line) separations. */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIALOG", "DIV",
  "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2",
  "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR", "LI", "MAIN", "NAV", "OL",
  "P", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

function isBlockElement(node: Node): boolean {
  return node.nodeType === 1 && BLOCK_TAGS.has((node as Element).tagName.toUpperCase());
}

/** Walk a parsed HTML tree, emitting text and newlines for block structure. */
function walk(node: Node, out: string[], pre: boolean): void {
  const children = Array.from(node.childNodes);
  // A parent holding block children is laid out as a stack; whitespace-only
  // text nodes between those children are serialization formatting, not
  // content. Inside an inline-only parent (a pre-wrap chat bubble), literal
  // newlines in the text ARE content and must survive.
  const hasBlockChild = children.some(isBlockElement);
  for (const child of children) {
    if (child.nodeType === 3 /* text */) {
      const raw = child.nodeValue ?? "";
      if (pre) { out.push(raw); continue; }
      if (hasBlockChild && /^\s*$/.test(raw)) continue;
      // Collapse runs of spaces/tabs but keep newlines: a pre-wrap element
      // (our chat bubbles) carries its line breaks as literal text.
      out.push(raw.replace(/[^\S\n]+/g, " "));
      continue;
    }
    if (child.nodeType !== 1 /* element */) continue;
    const el = child as Element;
    const tag = el.tagName.toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "HEAD" || tag === "NOSCRIPT" || tag === "IMG" || tag === "BUTTON") continue;
    if (tag === "BR") { out.push("\n"); continue; }
    if (tag === "PRE") {
      out.push("\n\n");
      walk(el, out, true);
      out.push("\n\n");
      continue;
    }
    if (BLOCK_TAGS.has(tag)) {
      out.push("\n\n");
      walk(el, out, pre);
      out.push("\n\n");
      continue;
    }
    walk(el, out, pre);
  }
}

/** Convert a clipboard `text/html` payload to structured plain text. */
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  let body: HTMLElement | null = null;
  try {
    body = new DOMParser().parseFromString(html, "text/html").body;
  } catch {
    return "";
  }
  if (!body) return "";
  const out: string[] = [];
  walk(body, out, false);
  return out
    .join("")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

/**
 * The best plain text for a paste/drop: the structured HTML flavor when the
 * source provides one, else the plain flavor (CRLF-normalized). Returns "" for
 * clipboards that carry neither (e.g. a file-only paste), so callers can fall
 * through to their own handling.
 */
export function clipboardText(dt: DataTransfer | null): string {
  if (!dt) return "";
  const html = dt.getData("text/html");
  if (html && html.trim()) {
    const converted = htmlToPlainText(html);
    if (converted) return converted;
  }
  return (dt.getData("text/plain") || "").replace(/\r\n?/g, "\n");
}
