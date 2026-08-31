/**
 * Three stacked prompt boxes — Style / Content / Brand — that decompose the
 * prompt text into editable sections. The composed text stays the single
 * source of truth: editing any box re-composes the whole prompt and clearing
 * a box removes its section. Purely a view over the text; nothing here is
 * stored separately.
 */
import { useEffect, useRef, useState } from "react";
import { PromptContentEditor, type PromptContentHandle } from "./PromptContentEditor.js";
import { composePromptBoxes, parsePromptBoxes, type PromptBoxes } from "../../../shared/prompt-grammar.js";

export type { PromptContentHandle } from "./PromptContentEditor.js";
export type { PromptBoxes } from "../../../shared/prompt-grammar.js";

export function TriplePrompt({ value, includeBrand, className, sideRows, resizable, placeholder, contentRef, onChange, onContentChange, onContentKeyDown, onFocus, onBlur, deferExternalWhileFocused }: {
  value: string;
  /** When false the Brand box is hidden (the brand checkbox/node owns existence). */
  includeBrand: boolean;
  /** Applied to all three boxes so they share the surface styling. */
  className?: string;
  sideRows?: number;
  /** Show drag dividers between the boxes that resize the two neighbors. */
  resizable?: boolean;
  placeholder?: string;
  /** Ref to the content editor (autocomplete caret math). */
  contentRef?: { current: PromptContentHandle | null };
  onChange: (value: string) => void;
  /** Fires with the raw content-box text on every content edit. */
  onContentChange?: (content: string) => void;
  onContentKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** While a box is focused, ignore EXTERNAL value changes: the user's local
   *  edits stay authoritative until blur. This is what keeps the caret put
   *  when the parent re-derives the prompt mid-keystroke (the node graph's
   *  composer passes it; the side panel's @-autocomplete needs external
   *  re-decomposes while focused, so it does not). */
  deferExternalWhileFocused?: boolean;
}) {
  const [boxes, setBoxes] = useState<PromptBoxes>(() => parsePromptBoxes(value));
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Every composed value this component has emitted. The parent echoes the
  // value back (sometimes one render late — the node graph reconciles node
  // state in an effect), so a re-decompose must ignore OUR OWN echoes or the
  // boxes reset and the textarea caret jumps to the end. A genuine external
  // value (style dropdown, brand toggle, generation refresh) is never in the
  // set and clears it.
  const emitted = useRef<Set<string>>(new Set());
  const [styleH, setStyleH] = useState<number | null>(null);
  const [brandH, setBrandH] = useState<number | null>(null);
  const drag = useRef<{ which: "style" | "brand"; startY: number; startH: number } | null>(null);

  // External prompt changes (generation refresh, style dropdown, brand
  // toggle, graph edits) re-decompose — unless they're our own echo (current
  // or stale) or the user is actively editing a box (deferExternalWhileFocused
  // keeps local edits authoritative until blur). Focus is read straight from
  // the DOM at sync time — synthetic focus/blur events inside React Flow's
  // transformed viewport are unreliable (style/brand boxes don't even wire
  // onBlur, and bubble ordering races), while document.activeElement is
  // authoritative. This runs once on mount too.
  useEffect(() => {
    if (deferExternalWhileFocused && containerRef.current?.contains(document.activeElement)) return;
    if (emitted.current.has(value)) return;
    emitted.current.clear();
    emitted.current.add(value);
    setBoxes(parsePromptBoxes(value));
  }, [value, deferExternalWhileFocused]);

const emit = (next: PromptBoxes) => {
    setBoxes(next);
    const composed = composePromptBoxes(next);
    const s = emitted.current;
    if (s.size > 100) s.clear();
    s.add(composed);
    onChange(composed);
  };

  function startDrag(which: "style" | "brand") {
    return (e: React.PointerEvent<HTMLDivElement>) => {
      if (!resizable) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { which, startY: e.clientY, startH: (which === "style" ? styleH : brandH) ?? 64 };
    };
  }
  function onDragMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const delta = e.clientY - d.startY;
    // Dragging toward a box shrinks it — the divider moves into it.
    const h = Math.max(36, Math.min(420, d.startH + (d.which === "style" ? delta : -delta)));
    if (d.which === "style") setStyleH(h);
    else setBrandH(h);
  }
  function endDrag() { drag.current = null; }

  const cls = className ? ` ${className}` : "";
  const sideStyle = (h: number | null) => (h !== null ? { height: h, resize: "none" as const } : undefined);
  // The Style box only exists while the prompt has a Style section — same
  // existence model as the Brand box (detaching hides it; re-attaching via
  // the graph or the style dropdown brings it back).
  const styleAttached = /^Style:/m.test(value);
  return (
    <div
      ref={containerRef}
      className="prod-prompt-triple"
    >
      {styleAttached && (
        <>
          <span className="prod-prompt-box-label style">Style</span>
          <textarea
            className={`prod-prompt-box side${cls}`}
            rows={sideRows}
            style={sideStyle(styleH)}
            value={boxes.style}
            placeholder="Visual style — empty runs without a style section"
            onChange={(e) => emit({ ...boxes, style: e.target.value })}
            onFocus={onFocus}
            onBlur={onBlur}
          />
          {resizable && (
            <div
              className="prod-prompt-divider"
              title="Drag to resize — double-click to reset"
              onPointerDown={startDrag("style")}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onDoubleClick={() => setStyleH(null)}
            />
          )}
        </>
      )}
      <span className="prod-prompt-box-label content">Content</span>
      <PromptContentEditor
        ref={(el) => { if (contentRef) contentRef.current = el; }}
        className={`prod-prompt-box content${cls}`}
        text={boxes.content}
        placeholder={placeholder}
        onChange={(text) => { emit({ ...boxes, content: text }); onContentChange?.(text); }}
        onKeyDown={onContentKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        deferExternalWhileFocused={deferExternalWhileFocused}
      />
      {includeBrand && (
        <>
          {resizable && (
            <div
              className="prod-prompt-divider"
              title="Drag to resize — double-click to reset"
              onPointerDown={startDrag("brand")}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onDoubleClick={() => setBrandH(null)}
            />
          )}
          <span className="prod-prompt-box-label brand">Brand identity</span>
          <textarea
            className={`prod-prompt-box side${cls}`}
            rows={sideRows}
            style={sideStyle(brandH)}
            value={boxes.brand}
            placeholder="Palette & typography — empty regenerates from the brand set"
            onChange={(e) => emit({ ...boxes, brand: e.target.value })}
            onFocus={onFocus}
            onBlur={onBlur}
          />
        </>
      )}
    </div>
  );
}
