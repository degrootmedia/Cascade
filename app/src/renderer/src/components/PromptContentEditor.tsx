/**
 * Contenteditable replacement for the prompt content box: plain text with the
 * `@[Name]` reference tags rendered as draggable chips (move a chip anywhere
 * in the paragraph by dragging it). The plain text stays the single source of
 * truth — the chips are a live view, and any edit (typing, paste, chip drag)
 * serializes the box back to text and fires `onChange`. Exposes a
 * textarea-compatible handle so the existing @ autocomplete / caret math keeps
 * working against it.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isTagOnlyDiff, refTagMatches, type RefTagMatch } from "../../../shared/prompt-grammar.js";
import { clipboardText } from "../clipboard.js";

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
  /** Replace an in-progress `@query` before the caret with a full `@[Name]`
   *  tag as an INTERNAL edit (caret after the tag). The side panel's @
   *  autocomplete routes through this so the insertion rides the editor's own
   *  commit path instead of arriving as an external rebuild that resets the
   *  caret. No-op when there is no open `@` before the caret. */
  insertRefTag(name: string): void;
  /** Focus the box and place the caret right after `name`'s `@[Name]` tag on
   *  the next external rebuild. Used by the node graph: connecting a reference
   *  socket adds the tag from OUTSIDE the editor, and the user should be able
   *  to keep typing immediately after the new block. */
  focusAfterTag(name: string): void;
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
  const dragState = useRef<{ tag: string; pos: number; chip?: HTMLElement } | null>(null);
  const dropPosRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const [dropCaret, setDropCaret] = useState<{ left: number; top: number; height: number } | null>(null);
  // Every raw text this editor produced from the user's own editing. The
  // parent echoes values back (the graph's reconcile lags one render, and
  // composed/serialized variants can arrive in sequence), so suppression must
  // be a SET — a one-shot flag let the second echo slip through and force a
  // rebuild that dropped the caret to the end.
  const emitted = useRef<Set<string>>(new Set());
  // A tag name whose block the caret should land right after on the next
  // rebuild (set by `focusAfterTag` when a graph socket adds a tag externally).
  const pendingFocusTag = useRef<string | null>(null);
  // The latest `onChange` — the imperative handle is created once, so it must
  // not close over a stale prop identity.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  // Native undo history is destroyed every time the DOM is rebuilt from plain
  // text, so the editor keeps its own: a stack of (text, caret) snapshots taken
  // BEFORE each edit. Consecutive typing coalesces into one step (a 700ms
  // boundary breaks a run), matching a word processor.
  const undoStack = useRef<{ text: string; caret: number }[]>([]);
  const redoStack = useRef<{ text: string; caret: number }[]>([]);
  const lastPush = useRef<{ kind: string; time: number }>({ kind: "", time: 0 });

  /** The box's current plain text + caret offset, for the undo stacks. */
  function snapshot(): { text: string; caret: number } {
    const el = elRef.current;
    const text = el?.textContent ?? "";
    const caret = el ? selectionOffsets(el).start : text.length;
    return { text, caret };
  }

  /** Record the pre-edit state. `kind` groups edits: consecutive `typing` within
   *  700ms collapses to one undo step; anything else always starts a step. */
  function pushUndo(kind: string) {
    const now = Date.now();
    if (kind === "typing" && lastPush.current.kind === "typing" && now - lastPush.current.time < 700) {
      lastPush.current.time = now;
      redoStack.current = [];
      return;
    }
    undoStack.current.push(snapshot());
    if (undoStack.current.length > 200) undoStack.current.shift();
    redoStack.current = [];
    lastPush.current = { kind, time: now };
  }

  function updateDropCaret(clientX: number, clientY: number) {
    const el = elRef.current;
    if (!el || !dragState.current) return;
    let range = caretRangeAtPoint(el, clientX, clientY);
    // If pointer is outside the box, clamp to the nearest point inside
    if (!range) {
      const rect = el.getBoundingClientRect();
      // For transformed viewports (React Flow) the viewport rect is already
      // transformed; clamping to it still yields a point inside the editor.
      const cx = Math.max(rect.left + 2, Math.min(rect.right - 2, clientX));
      const cy = Math.max(rect.top + 2, Math.min(rect.bottom - 2, clientY));
      range = caretRangeAtPoint(el, cx, cy);
      if (!range) {
        // Final fallback: approximate drop position by linear interpolation
        // within the editor's text. This ensures node-view dragging still
        // shows a caret even when caretRangeFromPoint fails under a
        // transformed viewport (scale/translate).
        const textLen = (el.textContent ?? "").length;
        const relX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
        const relY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
        // Estimate offset from 2D position: y chooses line, x chooses column
        // For pre-wrap content we approximate with linear proportion.
        const approx = Math.max(0, Math.min(textLen, Math.round((relY * 0.7 + relX * 0.3) * textLen)));
        dropPosRef.current = approx;
        const left = rect.left + Math.max(2, Math.min(rect.width - 2, clientX - rect.left));
        const top = rect.top + Math.max(2, Math.min(rect.height - 2, clientY - rect.top));
        setDropCaret({ left, top, height: 18 });
        return;
      }
    }
    const dropPos = textLengthBeforeRange(el, range);
    dropPosRef.current = dropPos;
    let caretRect: DOMRect | null = null;
    try { caretRect = (range as Range).getBoundingClientRect?.() ?? null; } catch { caretRect = null; }
    if (!caretRect || (caretRect.width === 0 && caretRect.height === 0) || caretRect.height < 2) {
      try {
        const rects = (range as Range).getClientRects?.();
        if (rects && rects.length) caretRect = rects[0] as DOMRect;
      } catch { /* ignore */ }
    }
    // Fallback when still empty (e.g. empty editor or JSDOM) — anchor to the box
    if (!caretRect || (caretRect.width === 0 && caretRect.height === 0)) {
      const boxRect = el.getBoundingClientRect();
      // In JSDOM boxRect may be all zeros — still set a caret so drag isn't invisible in tests
      const left = boxRect.left || 0;
      const top = boxRect.top || 0;
      setDropCaret({ left: left + 6, top: top + 6, height: 18 });
      return;
    }
    const h = caretRect.height || 18;
    // Fixed-position caret: 2px wide line at the drop point
    setDropCaret({ left: caretRect.left, top: caretRect.top, height: h });
  }

  function clearDropCaret() {
    setDropCaret(null);
    dropPosRef.current = null;
  }

  function performDrop(clientX: number, clientY: number) {
    const el = elRef.current;
    const st = dragState.current;
    if (!el || !st) return;
    let dropPos = dropPosRef.current;
    if (dropPos === null) {
      const range = caretRangeAtPoint(el, clientX, clientY);
      if (!range) return;
      dropPos = textLengthBeforeRange(el, range);
    }
    const current = el.textContent ?? "";
    let at = Math.max(0, Math.min(current.length, dropPos));
    // No-op if dropping back onto its own span
    if (at >= st.pos && at <= st.pos + st.tag.length) {
      st.chip?.classList.remove("dragging");
      dragState.current = null;
      clearDropCaret();
      isDraggingRef.current = false;
      return;
    }
    const next = current.slice(0, st.pos) + current.slice(st.pos + st.tag.length);
    if (st.pos < at) at -= st.tag.length;
    at = Math.max(0, Math.min(next.length, at));
    const out = next.slice(0, at) + st.tag + next.slice(at);
    if (out !== current) {
      // For drag we want the DOM to rebuild to the new order (chips re-rendered)
      // and the caret placed after the moved tag. Do NOT add to `emitted` —
      // that would suppress the rebuild and leave the old chip order visible.
      // pendingCaret drives the caret placement in the rebuild effect.
      pushUndo("drag");
      pendingCaret.current = at + st.tag.length;
      onChangeRef.current(out);
    }
    st.chip?.classList.remove("dragging");
    dragState.current = null;
    clearDropCaret();
    isDraggingRef.current = false;
  }

  /** Commit the box's current plain text to the parent. Shared by typing and
   *  programmatic insertion; records it in `emitted` so the parent's echo does
   *  not trigger a rebuild that would move the caret. */
  function commitText() {
    const el = elRef.current;
    if (!el) return;
    const t = el.textContent ?? "";
    if (emitted.current.size > 100) emitted.current.clear();
    emitted.current.add(t);
    onChangeRef.current(t);
  }

  /** Rebuild the DOM from `next`, place the collapsed caret at `caret`, and
   *  commit. Shared by Backspace/Delete, undo/redo, and the autocomplete's
   *  in-editor tag insertion so they all update the box and the parent together. */
  function applyEdit(el: HTMLElement, next: string, caret: number) {
    buildDom(el, next);
    const at = Math.max(0, Math.min(caret, next.length));
    const r = offsetToRange(el, at);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(r); }
    commitText();
  }

  /** Collapse the caret right after `name`'s tag in the CURRENT DOM and focus
   *  the box. Used when an external rebuild already carries the tag (or when a
   *  rebuild is not needed). */
  function placeCaretAfterTag(el: HTMLElement, text: string, name: string) {
    const m = refTagMatches(text).find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!m) return;
    const r = offsetToRange(el, m.index + m.tag.length);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(r); }
    el.focus();
  }

  function undo() {
    const el = elRef.current;
    if (!el) return;
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(snapshot());
    lastPush.current = { kind: "", time: 0 };
    applyEdit(el, prev.text, prev.caret);
  }

  function redo() {
    const el = elRef.current;
    if (!el) return;
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(snapshot());
    lastPush.current = { kind: "", time: 0 };
    applyEdit(el, next.text, next.caret);
  }

  /** The `@[Name]` tag a collapsed Backspace at `caret` must remove as one unit
   *  (the tag whose end is exactly the caret), or null to delete one character. */
  function tagBeforeCaret(text: string, caret: number): RefTagMatch | null {
    for (const m of refTagMatches(text)) {
      if (m.index + m.tag.length === caret) return m;
      if (m.index >= caret) break;
    }
    return null;
  }

  /** The tag a collapsed forward Delete at `caret` must remove as one unit. */
  function tagAtCaret(text: string, caret: number): RefTagMatch | null {
    for (const m of refTagMatches(text)) {
      if (m.index === caret) return m;
      if (m.index > caret) break;
    }
    return null;
  }

  /** Collapsed/seleced Backspace or Delete, reference-block aware: a tag is one
   *  unit, so deleting the space beside it deletes only that character while
   *  deleting INTO a tag removes the whole chip. Returns true when the browser's
   *  default deletion must be suppressed. */
  function handleEditKey(e: React.KeyboardEvent<HTMLDivElement>): boolean {
    if (e.nativeEvent.isComposing) return false;
    const back = e.key === "Backspace";
    const fwd = e.key === "Delete";
    if (!back && !fwd) return false;
    const el = elRef.current;
    if (!el) return false;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    if (!el.contains(sel.getRangeAt(0).startContainer)) return false;
    const { start, end } = selectionOffsets(el);
    const text = el.textContent ?? "";
    if (start !== end) {
      if (start >= end) return false;
      pushUndo("delete");
      applyEdit(el, text.slice(0, start) + text.slice(end), start);
      return true;
    }
    if (back) {
      if (start === 0) return true;
      const tag = tagBeforeCaret(text, start);
      pushUndo("delete");
      applyEdit(
        el,
        tag
          ? text.slice(0, tag.index) + text.slice(tag.index + tag.tag.length)
          : text.slice(0, start - 1) + text.slice(start),
        tag ? tag.index : start - 1,
      );
      return true;
    }
    if (start >= text.length) return true;
    const tag = tagAtCaret(text, start);
    pushUndo("delete");
    applyEdit(
      el,
      tag
        ? text.slice(0, tag.index) + text.slice(tag.index + tag.tag.length)
        : text.slice(0, start) + text.slice(start + 1),
      start,
    );
    return true;
  }

  /** Insert plain text at the caret as a literal text node. Chromium's
   *  `insertText` turns embedded newlines into block elements / `<br>`, which
   *  `textContent` drops — so paragraph breaks (and pasted text) are inserted
   *  by hand here to survive the save/reload round trip. */
  function insertPlainText(raw: string) {
    const el = elRef.current;
    if (!el) return;
    const text = raw.replace(/\r\n?/g, "\n");
    if (!text) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return;
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    const after = document.createRange();
    after.setStartAfter(node);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    commitText();
  }

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
      chip.draggable = false;
      chip.dataset.tag = m.tag;
      chip.textContent = m.tag;
      const startPointerDrag = (e: PointerEvent | MouseEvent) => {
        if ((e as MouseEvent).button !== 0) return;
        if (isDraggingRef.current && dragState.current) return;
        e.preventDefault();
        e.stopPropagation();
        // Stop React Flow's node-drag/pan handling from stealing the gesture
        // (it listens at window/document). Use capture-phase stop.
        if ((e as any).stopImmediatePropagation) (e as any).stopImmediatePropagation();
        const pos = textOffsetOfNode(el, chip);
        dragState.current = { tag: m.tag, pos, chip };
        isDraggingRef.current = true;
        chip.classList.add("dragging");
        const cx = (e as any).clientX as number;
        const cy = (e as any).clientY as number;
        updateDropCaret(cx, cy);
      };
      const endPointerDrag = (e: PointerEvent | MouseEvent) => {
        if (!isDraggingRef.current || !dragState.current) return;
        const pos = dropPosRef.current;
        if (pos === null) {
          chip.classList.remove("dragging");
          dragState.current = null;
          clearDropCaret();
          isDraggingRef.current = false;
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        if ((e as any).stopImmediatePropagation) (e as any).stopImmediatePropagation();
        const cx = (e as any).clientX as number;
        const cy = (e as any).clientY as number;
        performDrop(cx, cy);
      };
      // Use capture so we beat React Flow's pane/node handlers (they also
      // listen at window). Without capture the node would drag instead.
      chip.addEventListener("pointerdown", startPointerDrag as EventListener, { capture: true } as any);
      chip.addEventListener("mousedown", startPointerDrag as EventListener, { capture: true } as any);
      chip.addEventListener("pointerup", endPointerDrag as EventListener, { capture: true } as any);
      chip.addEventListener("mouseup", endPointerDrag as EventListener, { capture: true } as any);
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
  // NOTE: a pendingCaret from a drag operation takes precedence over the
  // `emitted` echo-suppression — dragging must rebuild to show the new chip
  // order, even though the new text was produced by this editor.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const focusTag = pendingFocusTag.current;
    pendingFocusTag.current = null;
    const hasPendingDrag = pendingCaret.current !== null;
    if (!hasPendingDrag && emitted.current.has(text)) {
      if (focusTag) placeCaretAfterTag(el, text, focusTag);
      return;
    }
    if (!hasPendingDrag && el.textContent === text) {
      if (focusTag) placeCaretAfterTag(el, text, focusTag);
      return;
    }
    const sel = window.getSelection();
    const inBox = !!sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer);
    // `inBox` alone is NOT focus: the rebuild path below restores a caret into
    // the box even while it is unfocused (selection sits inside without the
    // element holding focus), so a later external change would be wrongly
    // deferred forever. Require the box (or a chip inside it) to actually be
    // the active element.
    const focusedHere = document.activeElement === el || el.contains(document.activeElement);
    // While the box (or a chip inside it) actually holds focus, external text
    // is deferred so typing never jumps — except tag-only diffs (graph
    // connect/disconnect), which must rebuild under the caret (mapped through
    // below) or the chips diverge from the saved prompt permanently.
    if (deferExternalWhileFocused && focusedHere && pendingCaret.current === null && !isTagOnlyDiff(el.textContent ?? "", text)) return;
    const oldText = el.textContent ?? "";
    const oldCaret = pendingCaret.current ?? (inBox ? selectionOffsets(el).start : null);
    buildDom(el, text);
    pendingCaret.current = null;
    // A genuine external rewrite (not one of our own echoes, not a drag we
    // initiated) is a new document — start its undo history fresh.
    if (!hasPendingDrag && !emitted.current.has(text)) {
      undoStack.current = [];
      redoStack.current = [];
      lastPush.current = { kind: "", time: 0 };
    }
    let at = text.length;
    // An externally added tag (a graph reference connect) wins: land the caret
    // right after the new block so the user can keep typing.
    const tag = focusTag ? refTagMatches(text).find((m) => m.name.toLowerCase() === focusTag.toLowerCase()) : undefined;
    if (tag) {
      at = tag.index + tag.tag.length;
    } else if (oldCaret !== null) {
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

  // Global pointer/mouse tracking while a chip is being dragged.
  // Uses document with capture so React Flow's viewport handlers (which
  // also listen at window) don't steal the gesture. The caret is still
  // positioned via viewport clientX/Y, so the transform is already baked
  // into getBoundingClientRect.
  useEffect(() => {
    function onDocMove(e: PointerEvent | MouseEvent) {
      if (!isDraggingRef.current || !dragState.current) return;
      const cx = (e as any).clientX as number;
      const cy = (e as any).clientY as number;
      updateDropCaret(cx, cy);
      // Prevent the contenteditable selection from following the pointer
      try { e.preventDefault(); } catch {}
    }
    function onDocUp(e: PointerEvent | MouseEvent) {
      if (!isDraggingRef.current || !dragState.current) return;
      const cx = (e as any).clientX as number;
      const cy = (e as any).clientY as number;
      // Always drop at the current pointer location, clamped into the
      // editor — even if the pointer is over the React Flow pane (outside
      // the editor's DOM) the fallback in updateDropCaret will approximate.
      performDrop(cx, cy);
    }
    document.addEventListener("pointermove", onDocMove as unknown as EventListener, true);
    document.addEventListener("mousemove", onDocMove as unknown as EventListener, true);
    document.addEventListener("pointerup", onDocUp as unknown as EventListener, true);
    document.addEventListener("mouseup", onDocUp as unknown as EventListener, true);
    document.addEventListener("pointercancel", onDocUp as unknown as EventListener, true);
    return () => {
      document.removeEventListener("pointermove", onDocMove as unknown as EventListener, true);
      document.removeEventListener("mousemove", onDocMove as unknown as EventListener, true);
      document.removeEventListener("pointerup", onDocUp as unknown as EventListener, true);
      document.removeEventListener("mouseup", onDocUp as unknown as EventListener, true);
      document.removeEventListener("pointercancel", onDocUp as unknown as EventListener, true);
    };
  }, []);

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
    insertRefTag(name: string) {
      const el = elRef.current; if (!el) return;
      const text = el.textContent ?? "";
      const before = text.slice(0, selectionOffsets(el).start);
      const open = before.lastIndexOf("@");
      if (open < 0) return;
      pushUndo("insert-ref");
      applyEdit(el, `${text.slice(0, open)}@[${name}]${text.slice(selectionOffsets(el).start)}`, open + name.length + 3);
    },
    focusAfterTag(name: string) {
      pendingFocusTag.current = name;
      elRef.current?.focus();
    },
  }), []);

  return (
    <>
      <div
        ref={elRef}
        className={"prompt-content-editor" + (className ? ` ${className}` : "") + (isDraggingRef.current ? " drag-active" : "")}
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
        onPointerMove={(e) => {
          if (isDraggingRef.current) updateDropCaret(e.clientX, e.clientY);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onBeforeInput={(e) => {
          // Snapshot the pre-edit state for undo. Backspace/Delete are handled
          // in onKeyDown (they preventDefault, so they never reach here); this
          // covers typing, IME, cut, and any other native edit.
          const it = (e.nativeEvent as InputEvent).inputType;
          if (it === "insertText" || it === "insertCompositionText" || it === "insertReplacementText") pushUndo("typing");
          else if (it === "deleteContentBackward" || it === "deleteContentForward" || it === "deleteContent" || it === "deleteByCut") pushUndo("delete");
        }}
        onInput={commitText}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            const k = e.key.toLowerCase();
            if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
            if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); return; }
          }
          // Undo snapshot for typing. `onBeforeInput` is the primary source,
          // but it does not fire on a contentEditable in every engine — this
          // covers the rest. A double push coalesces (same "typing" kind).
          if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && !e.nativeEvent.isComposing) {
            pushUndo("typing");
          }
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            pushUndo("newline");
            insertPlainText("\n");
            return;
          }
          if (handleEditKey(e)) { e.preventDefault(); return; }
        }}
        onPaste={(e) => {
          e.preventDefault();
          const t = clipboardText(e.clipboardData);
          if (t) { pushUndo("paste"); insertPlainText(t); }
        }}
        onDrop={(e) => {
          e.preventDefault();
          const st = dragState.current;
          if (!st) return;
          performDrop(e.clientX, e.clientY);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (dragState.current) updateDropCaret(e.clientX, e.clientY);
        }}
        onDragLeave={() => {
          // Keep caret visible while dragging over the box — only clear when
          // leaving the editor entirely (pointer path handles hide on outside)
        }}
        onDragEnd={() => {
          // Fallback cleanup if drop didn't fire
          if (dragState.current) {
            dragState.current.chip?.classList.remove("dragging");
            dragState.current = null;
            clearDropCaret();
            isDraggingRef.current = false;
          }
        }}
        onFocus={onFocus}
        onBlur={onBlur}
      />
      {dropCaret &&
        // Portal to <body>: inside the node graph this component sits under
        // React Flow's transformed viewport, and a `position: fixed` element
        // under a CSS transform is positioned relative to that ancestor (and
        // scaled by it) — which threw the caret into the middle of the
        // canvas. At the document root, fixed coordinates are true viewport
        // pixels, matching the getBoundingClientRect math in updateDropCaret.
        createPortal(
          <div
            className="prompt-drop-caret"
            style={{ left: dropCaret.left, top: dropCaret.top, height: dropCaret.height }}
            aria-hidden="true"
          />,
          document.body
        )}
    </>
  );
});