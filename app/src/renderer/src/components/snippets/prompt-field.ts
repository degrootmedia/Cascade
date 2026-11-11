/**
 * Tracks the most recently focused prompt field so the Snippets shelf can
 * insert at the user's cursor.
 *
 * Prompt fields in Cascade are two kinds of DOM:
 *  - `PromptContentEditor` contenteditables (the Content box everywhere:
 *    classic side panel, node graph, Image Suite). They register an
 *    inserter here that rides the editor's own commit path.
 *  - plain `<textarea>`s whose class marks them as prompts
 *    (`prod-prompt-box`, `prod-edit-prompt`, `prod-tween-prompt`, …).
 *    Insertion goes through the native value setter + an `input` event so
 *    React controlled state picks it up.
 *
 * The tracker snapshots the caret/selection while a field is focused
 * (focusin / selectionchange / keyup / mouseup) and keeps the last field
 * after blur — clicking the shelf must not lose the insertion point. The
 * shelf's own inputs (inside `[data-snippets-ui]`) never become targets.
 */
import { insertSnippetText, type TextRange } from "../../../../shared/prompt-snippets.js";

export type PromptEditorInserter = (body: string, at: TextRange | null) => void;

const editorInserters = new WeakMap<HTMLElement, PromptEditorInserter>();

interface TrackedField {
  el: HTMLElement;
  start: number | null;
  end: number | null;
}

let last: TrackedField | null = null;
let installed = false;

/** Register a PromptContentEditor's inserter (called by the editor itself). */
export function registerPromptEditor(el: HTMLElement, insert: PromptEditorInserter): void {
  editorInserters.set(el, insert);
}

export function unregisterPromptEditor(el: HTMLElement): void {
  editorInserters.delete(el);
  if (last?.el === el) last = null;
}

/** The prompt field an element belongs to, or null when it isn't one. */
export function promptFieldOf(node: EventTarget | Node | null): HTMLElement | null {
  if (!node || typeof (node as Node).nodeType !== "number") return null;
  const el = ((node as Node).nodeType === 1 ? node : (node as Node).parentElement) as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return null;
  if (el.closest("[data-snippets-ui]")) return null;
  const editor = el.closest(".prompt-content-editor") as HTMLElement | null;
  if (editor) return editor;
  const ta = el.closest("textarea") as HTMLTextAreaElement | null;
  if (ta && !ta.readOnly && !ta.disabled && /prompt|composer/.test(ta.className)) return ta;
  return null;
}

/** Serialized-text caret/selection offsets inside a contenteditable. */
function contentOffsets(el: HTMLElement): TextRange | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
  const before = (r: Range, endSide: boolean) => {
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(endSide ? r.endContainer : r.startContainer, endSide ? r.endOffset : r.startOffset);
    return pre.toString().length;
  };
  return { start: before(range, false), end: before(range, true) };
}

function snapshot(el: HTMLElement): void {
  if (el.tagName === "TEXTAREA") {
    const ta = el as HTMLTextAreaElement;
    last = { el, start: ta.selectionStart, end: ta.selectionEnd };
    return;
  }
  const off = contentOffsets(el);
  if (off) last = { el, start: off.start, end: off.end };
  else if (last?.el !== el) last = { el, start: null, end: null };
}

function refreshFromEvent(e: Event): void {
  const field = promptFieldOf(e.target);
  if (field) snapshot(field);
  else if (last && document.activeElement === last.el) snapshot(last.el);
  else if (last) {
    // Selection may have moved inside the tracked contenteditable without
    // the event target being the box itself (selectionchange targets the
    // document).
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && last.el.contains(sel.getRangeAt(0).startContainer)) snapshot(last.el);
  }
}

/** Install the document listeners. Idempotent. */
export function installPromptFieldTracking(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("focusin", refreshFromEvent, true);
  document.addEventListener("selectionchange", refreshFromEvent);
  document.addEventListener("keyup", refreshFromEvent, true);
  document.addEventListener("mouseup", refreshFromEvent, true);
}

/** Record a field + caret directly (the editor calls this on focus). */
export function notePromptFieldFocused(el: HTMLElement): void {
  snapshot(el);
}

/** The tracked field when it is still in the document, else null. */
export function getActivePromptField(): TrackedField | null {
  if (last && !last.el.isConnected) last = null;
  return last;
}

export function hasActivePromptField(): boolean {
  return getActivePromptField() !== null;
}

/** The tracked field's selected text ("" when collapsed/none). */
export function getActivePromptSelectionText(): string {
  const f = getActivePromptField();
  if (!f || f.start === null || f.end === null || f.end <= f.start) return "";
  const text = f.el.tagName === "TEXTAREA" ? (f.el as HTMLTextAreaElement).value : (f.el.textContent ?? "");
  return text.slice(f.start, f.end);
}

function insertIntoTextarea(ta: HTMLTextAreaElement, body: string, at: TextRange | null): void {
  const r = insertSnippetText(ta.value, at?.start ?? ta.selectionStart, at?.end ?? ta.selectionEnd, body);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), "value")?.set;
  if (setter) setter.call(ta, r.text);
  else ta.value = r.text;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  const sel = r.placeholder ?? { start: r.caret, end: r.caret };
  try {
    ta.setSelectionRange(sel.start, sel.end);
  } catch {
    /* jsdom / detached — focus already returned */
  }
  last = { el: ta, start: sel.start, end: sel.end };
}

/**
 * Insert `body` at the tracked field's caret (appended when the field has
 * no known caret), returning focus to the field. Returns false when there
 * is no usable prompt field — the caller copies to the clipboard instead.
 */
export function insertIntoActivePromptField(body: string): boolean {
  const f = getActivePromptField();
  if (!f) return false;
  const at: TextRange | null = f.start !== null && f.end !== null ? { start: f.start, end: f.end } : null;
  const insert = editorInserters.get(f.el);
  if (insert) {
    insert(body, at);
    return f.el.isConnected;
  }
  if (f.el.tagName === "TEXTAREA") {
    insertIntoTextarea(f.el as HTMLTextAreaElement, body, at);
    return true;
  }
  return false;
}

/** Copy text to the clipboard; resolves true on success. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Test seam: forget the tracked field. */
export function resetPromptFieldForTests(): void {
  last = null;
}
