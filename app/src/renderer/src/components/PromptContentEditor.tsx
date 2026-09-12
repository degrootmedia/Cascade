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
import { isTagOnlyDiff, refTagMatches } from "../../../shared/prompt-grammar.js";

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
      pendingCaret.current = at + st.tag.length;
      onChange(out);
    }
    st.chip?.classList.remove("dragging");
    dragState.current = null;
    clearDropCaret();
    isDraggingRef.current = false;
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
    const hasPendingDrag = pendingCaret.current !== null;
    if (!hasPendingDrag && emitted.current.has(text)) return;
    if (!hasPendingDrag && el.textContent === text) return;
    const sel = window.getSelection();
    const inBox = !!sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer);
    // While the caret lives in the box, external text is deferred so typing
    // never jumps — except tag-only diffs (graph connect/disconnect), which
    // must rebuild under the caret (mapped through below) or the chips
    // diverge from the saved prompt permanently.
    if (deferExternalWhileFocused && inBox && pendingCaret.current === null && !isTagOnlyDiff(el.textContent ?? "", text)) return;
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