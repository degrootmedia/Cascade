/**
 * Three stacked prompt boxes — Style / Content / Brand — that decompose the
 * prompt text into editable sections. The composed text stays the single
 * source of truth: editing any box re-composes the whole prompt and clearing
 * a box removes its section. Purely a view over the text; nothing here is
 * stored separately.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PromptContentEditor, type PromptContentHandle } from "./PromptContentEditor.js";
import { composePromptBoxes, isTagOnlyDiff, parsePromptBoxes, type PromptBoxes } from "../../../shared/prompt-grammar.js";

export type { PromptContentHandle } from "./PromptContentEditor.js";
export type { PromptBoxes } from "../../../shared/prompt-grammar.js";

export function TriplePrompt({ value, includeBrand, className, sideRows, resizable, placeholder, contentLabel, contentRef, styleControl, brandControl, onChange, onContentChange, onContentKeyDown, onFocus, onBlur, deferExternalWhileFocused }: {
  value: string;
  /** Label above the content box (defaults to "Content"). */
  contentLabel?: string;
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
  /** Optional control rendered under the Style label (e.g. the sidebar's
   *  render-style picker). When provided, the label row stays visible even
   *  while the Style section is detached so it can be re-attached. */
  styleControl?: ReactNode;
  /** Optional control rendered next to the Brand identity label (e.g. the
   *  sidebar's brand toggle). When provided, the label row stays visible
   *  even while the brand is excluded so it can be toggled back on. */
  brandControl?: ReactNode;
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
  const styleRef = useRef<HTMLTextAreaElement | null>(null);
  const brandRef = useRef<HTMLTextAreaElement | null>(null);
  const boxesRef = useRef(boxes);
  useEffect(() => { boxesRef.current = boxes; }, [boxes]);
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

  // External prompt changes re-decompose. The three boxes are separate
  // logical sections — style, content, brand — and only combined
  // (composed) for persistence / MCP submission. When one box is focused
  // we keep that box authoritative (its caret/selection must not jump)
  // but still allow the other two boxes to follow external changes
  // (e.g. changing the style dropdown while the content editor is
  // focused must update the Style textarea without resetting the tag
  // positions in Content, and vice-versa).
  useEffect(() => {
    if (emitted.current.has(value)) return;
    const incoming = parsePromptBoxes(value);
    if (deferExternalWhileFocused) {
      const active = document.activeElement as HTMLElement | null;
      const contentEl = containerRef.current?.querySelector(".prompt-content-editor") as HTMLElement | null;
      const isContentFocused = !!contentEl && (!!active && (contentEl === active || contentEl.contains(active)));
      const isStyleFocused = !!styleRef.current && styleRef.current === active;
      const isBrandFocused = !!brandRef.current && brandRef.current === active;
      const anyFocused = isContentFocused || isStyleFocused || isBrandFocused;
      if (anyFocused) {
        // Merge only the unfocused boxes; keep the focused one(s) as-is —
        // except tag-only content diffs (graph connect/disconnect), which the
        // focused content box must accept so the chip appears/vanishes under
        // the caret instead of diverging from the saved prompt forever.
        let changed = false;
        const next: PromptBoxes = { ...boxesRef.current };
        if (!isStyleFocused && incoming.style !== boxesRef.current.style) { next.style = incoming.style; changed = true; }
        if (!isContentFocused && incoming.content !== boxesRef.current.content) { next.content = incoming.content; changed = true; }
        else if (isContentFocused && incoming.content !== boxesRef.current.content && isTagOnlyDiff(boxesRef.current.content, incoming.content)) { next.content = incoming.content; changed = true; }
        if (!isBrandFocused && incoming.brand !== boxesRef.current.brand) { next.brand = incoming.brand; changed = true; }
        // Also handle includeBrand structural change: the Brand box may
        // appear/disappear based on incoming, even while content focused.
        // That is derived from `value` outside, but we still need to keep
        // brand text in sync when not focused.
        if (changed) {
          setBoxes(next);
          emitted.current.clear();
          emitted.current.add(value);
        }
        return;
      }
    }
    emitted.current.clear();
    emitted.current.add(value);
    setBoxes(incoming);
  }, [value, deferExternalWhileFocused]);

  const emitPartial = (partial: Partial<PromptBoxes>) => {
    // Use the latest boxes via ref so a drag that started before a
    // concurrent style edit doesn't clobber the style. The three boxes
    // are separate logical sections; they are only combined (composed)
    // here for persistence / MCP submission.
    const next: PromptBoxes = { ...boxesRef.current, ...partial };
    setBoxes(next);
    const composed = composePromptBoxes(next);
    const s = emitted.current;
    if (s.size > 100) s.clear();
    s.add(composed);
    onChange(composed);
    return next;
  };
  // Legacy helper kept for any external callers that still pass a full
  // boxes object.
  const emit = (next: PromptBoxes) => { emitPartial(next); };

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
      {(styleAttached || styleControl) && (
        <>
          <span className="prod-prompt-box-label style">Style</span>
          {styleControl}
        </>
      )}
      {styleAttached && (
        <>
          <textarea
            ref={styleRef}
            className={`prod-prompt-box side${cls}`}
            rows={sideRows}
            style={sideStyle(styleH)}
            value={boxes.style}
            placeholder="Visual style — empty runs without a style section"
            onChange={(e) => emitPartial({ style: e.target.value })}
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
      <span className="prod-prompt-box-label content">{contentLabel ?? "Content"}</span>
      <PromptContentEditor
        ref={(el) => { if (contentRef) contentRef.current = el; }}
        className={`prod-prompt-box content${cls}`}
        text={boxes.content}
        placeholder={placeholder}
        onChange={(text) => { emitPartial({ content: text }); onContentChange?.(text); }}
        onKeyDown={onContentKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        deferExternalWhileFocused={deferExternalWhileFocused}
      />
      {(includeBrand || brandControl) && (
        <>
          {includeBrand && resizable && (
            <div
              className="prod-prompt-divider"
              title="Drag to resize — double-click to reset"
              onPointerDown={startDrag("brand")}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onDoubleClick={() => setBrandH(null)}
            />
          )}
          <span className={brandControl ? "prod-prompt-box-label brand prod-prompt-box-label-row" : "prod-prompt-box-label brand"}>Brand identity{brandControl}</span>
          {includeBrand && (
          <textarea
            ref={brandRef}
            className={`prod-prompt-box side${cls}`}
            rows={sideRows}
            style={sideStyle(brandH)}
            value={boxes.brand}
            placeholder="Palette & typography — empty regenerates from the brand set"
            onChange={(e) => emitPartial({ brand: e.target.value })}
            onFocus={onFocus}
            onBlur={onBlur}
          />
          )}
        </>
      )}
    </div>
  );
}
