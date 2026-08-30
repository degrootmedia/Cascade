/**
 * Three stacked prompt boxes — Style / Content / Brand — that decompose the
 * prompt text into editable sections. The composed text stays the single
 * source of truth: editing any box re-composes the whole prompt and clearing
 * a box removes its section. Purely a view over the text; nothing here is
 * stored separately.
 */
import { useEffect, useRef, useState } from "react";
import { PromptContentEditor, type PromptContentHandle } from "./PromptContentEditor.js";

export type { PromptContentHandle } from "./PromptContentEditor.js";

export interface PromptBoxes {
  style: string;
  content: string;
  brand: string;
}

/** Split a prompt into its Style / content / Brand paragraphs. The first
 *  `Style:` and `Brand identity:` paragraphs become the boxes; everything
 *  else (including @[tag] paragraphs) is content. */
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

export function TriplePrompt({ value, includeBrand, className, sideRows, resizable, placeholder, contentRef, onChange, onContentChange, onContentKeyDown, onFocus, onBlur }: {
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
}) {
  const [boxes, setBoxes] = useState<PromptBoxes>(() => parsePromptBoxes(value));
  const lastEmitted = useRef(value);
  // Resizable side-box heights (px); null = fall back to the rows attribute.
  const [styleH, setStyleH] = useState<number | null>(null);
  const [brandH, setBrandH] = useState<number | null>(null);
  const drag = useRef<{ which: "style" | "brand"; startY: number; startH: number } | null>(null);

  // External prompt changes (generation refresh, style dropdown, brand
  // toggle, graph edits) re-decompose — unless they're our own echo.
  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    setBoxes(parsePromptBoxes(value));
  }, [value]);

  const emit = (next: PromptBoxes) => {
    setBoxes(next);
    const composed = composePromptBoxes(next);
    lastEmitted.current = composed;
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
    <div className="prod-prompt-triple">
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
          />
        </>
      )}
    </div>
  );
}
