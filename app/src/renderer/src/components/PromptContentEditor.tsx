/**
 * Contenteditable replacement for the prompt content box: plain text with the
 * `@[Name]` reference tags rendered as draggable chips (move a chip anywhere
 * in the paragraph by dragging it). The plain text stays the single source of
 * truth — the chips are a live view, and any edit (typing, paste, chip drag)
 * serializes the box back to text and fires `onChange`. Exposes a
 * textarea-compatible handle so the existing @ autocomplete / caret math keeps
 * working against it.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { refTagMatches } from "../../../shared/prompt-grammar.js";

export interface PromptContentHandle {
  focus(): void;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  getBoundingClientRect(): DOMRect;
  /** Pixel rect of the current collapsed caret (for the @ autocomplete menu). */
  caretRect(): DOMRect | null;
  /** Whether the content box currently holds focus. */
  isActive(): boolean;
}

/** Text length (in the box's serialized form) before a range's start. */
function textLengthBeforeRange(el: HTMLElement, range: Range): number {
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

/** Serialized-text offset where a node (chip) begins. */
function textOffsetOfNode(el: HTMLElement, node: Node): number {
  const range = document.createRange();
  range.selectNode(node);
  range.collapse(true);
  return textLengthBeforeRange(el, range);
}

/** Collapsed range at a serialized-text offset (walks the text nodes). */
function offsetToRange(el: HTMLElement, offset: number): Range {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) {
      const r = document.createRange();
      r.setStart(node, remaining);
      r.collapse(true);
      return r;
    }
    remaining -= len;
    node = walker.nextNode();
  }
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  return r;
}

function selectionOffsets(el: HTMLElement): { start: number; end: number } {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { start: 0, end: 0 };
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return { start: 0, end: 0 };
  const start = textLengthBeforeRange(el, range);
  const endR = range.cloneRange();
  endR.collapse(false);
  return { start, end: textLengthBeforeRange(el, endR) };
}

function caretRangeAtPoint(el: HTMLElement, x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    return r && el.contains(r.startContainer) ? r : null;
  }
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos && el.contains(pos.offsetNode)) {
      const r = document.createRange();
      r.setStart(pos.offsetNode, pos.offset);
      r.collapse(true);
      return r;
    }
  }
  return null;
}

export const PromptContentEditor = forwardRef<PromptContentHandle, {
  text: string;
  placeholder?: string;
  className?: string;
  onChange: (text: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  deferExternalWhileFocused?: boolean;
}>(function PromptContentEditor({ text, placeholder, className, onChange, onKeyDown, onFocus, onBlur, deferExternalWhileFocused }, ref) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{ tag: string; pos: number } | null>(null);
  const pendingCaret = useRef<number | null>(null);
  // Every raw text this editor produced from the user's own editing. The
  // parent echoes values back (the graph's reconcile lags one render, and
  // composed/serialized variants can arrive in sequence), so suppression must
  // be a SET — a one-shot flag let the second echo slip through and force a
  // rebuild that dropped the caret to the end.
  const emitted = useRef<Set<string>>(new Set());

  /** Build the box DOM from plain text: text nodes + non-editable tag chips. */
  function buildDom(el: HTMLElement, t: string) {
    el.textContent = "";
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of refTagMatches(t)) {
      const idx = m.index;
      if (idx > last) frag.appendChild(document.createTextNode(t.slice(last, idx)));
      const chip = document.createElement("span");
      chip.className = "prompt-tag-chip nodrag";
      chip.setAttribute("contenteditable", "false");
      chip.draggable = true;
      chip.dataset.tag = m.tag;
      chip.textContent = m.tag;
      chip.addEventListener("dragstart", (e) => {
        if (!e.dataTransfer) return;
        dragState.current = { tag: m.tag, pos: textOffsetOfNode(el, chip) };
        e.dataTransfer.setData("text/plain", m.tag);
        e.dataTransfer.effectAllowed = "move";
        chip.classList.add("dragging");
      });
      chip.addEventListener("dragend", () => {
        chip.classList.remove("dragging");
        dragState.current = null;
      });
      frag.appendChild(chip);
      last = idx + m.tag.length;
    }
    if (last < t.length) frag.appendChild(document.createTextNode(t.slice(last)));
    el.appendChild(frag);
  }

  // External text changes rebuild the box (chips); our own edits leave the DOM
  // alone so the caret survives. When a rebuild does fire while the caret
  // lives in the box (a stale echo slipping through, or a Chromium DOM
  // restructure around the non-editable chips), the caret is mapped through
  // the edit via a common prefix/suffix diff: inside the unchanged prefix it
  // stays put, at the divergence it lands after the inserted region (typing),
  // and past it, it keeps its distance from the end — never a jump to
  // text.length. Focus is detected by the SELECTION living inside the box
  // (not activeElement, which is unreliable around non-editable chip
  // children).
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (emitted.current.has(text)) return;
    if (el.textContent === text) return;
    const sel = window.getSelection();
    const inBox = !!sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer);
    if (deferExternalWhileFocused && inBox && pendingCaret.current === null) return;
    const oldText = el.textContent ?? "";
    const oldCaret = pendingCaret.current ?? (inBox ? selectionOffsets(el).start : null);
    buildDom(el, text);
    pendingCaret.current = null;
    let at = text.length;
    if (oldCaret !== null) {
      if (oldCaret >= oldText.length) {
        at = text.length;
      } else {
        let p = 0;
        const maxP = Math.min(oldText.length, text.length);
        while (p < maxP && oldText[p] === text[p]) p++;
        if (oldCaret < p) {
          at = oldCaret;
        } else {
          let s = 0;
          const maxS = Math.min(oldText.length - p, text.length - p);
          while (s < maxS && oldText[oldText.length - 1 - s] === text[text.length - 1 - s]) s++;
          at = oldCaret === p
            ? text.length - s // typing at the caret: land after the inserted region
            : Math.max(0, text.length - (oldText.length - oldCaret));
        }
      }
    }
    const r = offsetToRange(el, at);
    if (sel) { sel.removeAllRanges(); sel.addRange(r); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useImperativeHandle(ref, () => ({
    focus() { elRef.current?.focus(); },
    get selectionStart() { return elRef.current ? selectionOffsets(elRef.current).start : 0; },
    get selectionEnd() { return elRef.current ? selectionOffsets(elRef.current).end : 0; },
    setSelectionRange(start: number, end: number) {
      const el = elRef.current; if (!el) return;
      const r = offsetToRange(el, start);
      const sel = window.getSelection(); if (!sel) return;
      sel.removeAllRanges();
      if (end !== undefined && end !== start) {
        const er = offsetToRange(el, end);
        r.setEnd(er.startContainer, er.startOffset);
      }
      sel.addRange(r);
    },
    getBoundingClientRect() { return elRef.current?.getBoundingClientRect() ?? new DOMRect(); },
    caretRect() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0).cloneRange();
      r.collapse(true);
      const rect = r.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return rect;
    },
    isActive() { return document.activeElement === elRef.current; },
  }), []);

  return (
    <div
      ref={elRef}
      className={"prompt-content-editor" + (className ? ` ${className}` : "")}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      data-placeholder={placeholder}
      spellCheck={false}
      // Stop React Flow's pane/node drag handling from stealing pointer
      // events while the user is editing - without this the viewport's
      // transform/pan handlers can blur the editor every other keystroke
      // when the node's height changes and a dimensions update cycles.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onInput={() => {
        const el = elRef.current;
        if (!el) return;
        const t = el.textContent ?? "";
        if (emitted.current.size > 100) emitted.current.clear();
        emitted.current.add(t);
        onChange(t);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (!e.defaultPrevented && e.key === "Enter") {
          e.preventDefault();
          document.execCommand("insertText", false, "\n");
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        const t = e.clipboardData.getData("text/plain");
        if (t) document.execCommand("insertText", false, t);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const el = elRef.current;
        const st = dragState.current;
        if (!el || !st) return;
        const range = caretRangeAtPoint(el, e.clientX, e.clientY);
        if (!range) { dragState.current = null; return; }
        const dropPos = textLengthBeforeRange(el, range);
        const current = el.textContent ?? "";
        // Move the dragged tag: remove its occurrence, reinsert at the drop.
        const next = current.slice(0, st.pos) + current.slice(st.pos + st.tag.length);
        let at = dropPos;
        if (st.pos < dropPos) at -= st.tag.length;
        const out = next.slice(0, at) + st.tag + next.slice(at);
        pendingCaret.current = at + st.tag.length;
        dragState.current = null;
        if (emitted.current.size > 100) emitted.current.clear();
        emitted.current.add(out);
        onChange(out);
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  );
});