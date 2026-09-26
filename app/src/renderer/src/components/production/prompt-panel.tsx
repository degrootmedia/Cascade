import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { composePromptBoxes, parsePromptBoxes, refTagNames } from "../../../../shared/prompt-grammar.js";
import type { ProductionStyle } from "../../../../shared/ipc.js";
import { TriplePrompt, type PromptContentHandle } from "../TriplePrompt.js";
import { RefMediaGlyph, type PromptReference } from "./references.js";
import { NodesIcon, RegenerateIcon } from "../icons.js";

export function ReferencePromptEditor({ value, includeBrand, onChange, references, className, rows, resizable, autoFocus, placeholder, contentLabel, contentRef: externalContentRef, styleControl, brandControl, afterContent, styleReadOnly, brandReadOnly, onKeyDown, onFocus, onBlur }: {
  value: string;
  includeBrand: boolean;
  onChange: (value: string) => void;
  references: PromptReference[];
  className: string;
  rows: number;
  resizable?: boolean;
  autoFocus?: boolean;
  placeholder: string;
  /** Label above the content box (defaults to "Content"). */
  contentLabel?: string;
  /** Supply to drive the content editor from outside (e.g. inserting a
   *  dropped reference tag at the caret). */
  contentRef?: { current: PromptContentHandle | null };
  /** Optional control under the Style label / next to the Brand identity label (see TriplePrompt). */
  styleControl?: ReactNode;
  brandControl?: ReactNode;
  /** Optional node rendered between the Content box and the Brand section. */
  afterContent?: ReactNode;
  /** Shared-reference previews are read-only (step 04). */
  styleReadOnly?: boolean;
  brandReadOnly?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const internalContentRef = useRef<PromptContentHandle>(null);
  const contentRef = externalContentRef ?? internalContentRef;
  const [query, setQuery] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });
  const matches = query === null ? [] : references.filter((r) => r.name.toLowerCase().includes(query.toLowerCase()));
  const tags = refTagNames(value);
  const content = parsePromptBoxes(value).content;

  /** Autocomplete tracking lives on the content box only. */
  function updateQuery(next: string, caret = contentRef.current?.selectionStart ?? next.length) {
    const before = next.slice(0, caret);
    const open = before.lastIndexOf("@");
    const tail = open >= 0 ? before.slice(open + 1) : "";
    const nextQuery = open >= 0 && !/[\s\[\]]/.test(tail) ? tail : null;
    setQuery(nextQuery);
    if (nextQuery !== null && contentRef.current) {
      // Anchor the menu to the actual caret (accurate with variable-width tag
      // chips), falling back to the box's top-left corner.
      const rect = contentRef.current.caretRect?.() ?? contentRef.current.getBoundingClientRect();
      const left = Math.min(rect.left, window.innerWidth - 220);
      const top = Math.min(rect.bottom + 4, window.innerHeight - 220);
      setMenuPos({ left: Math.max(8, left), top: Math.max(8, top) });
    }
    setSelected(0);
  }
  function choose(ref: PromptReference) {
    const el = contentRef.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = content.slice(0, caret);
    const open = before.lastIndexOf("@");
    if (open < 0) return;
    const next = `${content.slice(0, open)}@[${ref.name}]${content.slice(caret)}`;
    const nextCaret = open + ref.name.length + 3;
    onChange(composePromptBoxes({ ...parsePromptBoxes(value), content: next }));
    setQuery(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(nextCaret, nextCaret); });
  }
  function keyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (query !== null && matches.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((n) => (n + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelected((n) => (n + matches.length - 1) % matches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(matches[selected]); return; }
      if (e.key === "Escape") { e.preventDefault(); setQuery(null); return; }
    }
    onKeyDown?.(e);
  }
  return (
    <div className="prod-ref-prompt-editor">
      <TriplePrompt
        contentRef={contentRef}
        className={className}
        sideRows={2}
        resizable={resizable}
        value={value}
        includeBrand={includeBrand}
        placeholder={placeholder}
        contentLabel={contentLabel}
        styleControl={styleControl}
        brandControl={brandControl}
        afterContent={afterContent}
        styleReadOnly={styleReadOnly}
        brandReadOnly={brandReadOnly}
        onChange={onChange}
        onContentChange={updateQuery}
        onContentKeyDown={keyDown}
        onFocus={onFocus}
        onBlur={() => {
          onBlur?.();
          window.setTimeout(() => {
            if (contentRef.current?.isActive() || query === null) return;
            const caret = contentRef.current?.selectionStart ?? content.length;
            const before = content.slice(0, caret);
            const open = before.lastIndexOf("@");
            const tail = open >= 0 ? before.slice(open + 1) : "";
            if (open >= 0 && !/[\s\[\]]/.test(tail)) {
              onChange(composePromptBoxes({ ...parsePromptBoxes(value), content: content.slice(0, open) + content.slice(caret) }));
            }
            setQuery(null);
          }, 120);
        }}
      />
      {query !== null && matches.length > 0 && (
        <div className="prod-ref-autocomplete" style={{ left: menuPos.left, top: menuPos.top }}>
          {matches.map((r, i) => (
            <button key={r.id} className={i === selected ? "selected" : ""} onMouseDown={(e) => { e.preventDefault(); choose(r); }}>
              {r.artwork ? <img src={r.artwork} alt="" /> : <RefMediaGlyph media={r.media} />}<span>@[{r.name}]</span>
            </button>
          ))}
        </div>
      )}
      {tags.length > 0 && (
        <div className="prod-ref-tag-previews">
          {tags.map((tag, i) => {
            const ref = references.find((r) => r.name.toLowerCase() === tag.toLowerCase());
            return ref ? <span key={`${ref.id}-${i}`} title={`Reference @[${ref.name}]`}>{ref.artwork ? <img src={ref.artwork} alt={ref.name} /> : <RefMediaGlyph media={ref.media} />}@[{ref.name}]</span> : null;
          })}
        </div>
      )}
    </div>
  );
}

/** cascade-media:// URL for any workspace-relative asset in the production
 *  (references are stored as files on disk now, so thumbnails + previews load
 *  through the streaming protocol rather than inline data URLs). */

export function PromptSidePanel({ shotNumber, value, includeBrand, styles, styleValue, references, onChange, onToggleBrand, onStyleChange, onSubmit, submitting, onOpenGraph, onOpenSuite, magicActive, onRegenMagic, magicBusy, submitSuffix }: { shotNumber?: string; value: string; includeBrand: boolean; /** Step 2 style set for the per-shot render-style override. */ styles: ProductionStyle[]; /** Selected style id ("None" when empty). */ styleValue: string; references: PromptReference[]; onChange: (value: string) => void; onToggleBrand: (include: boolean) => void; /** Switch the focused shot's render style (rewrites the Style paragraph). */ onStyleChange: (style: string) => void; onSubmit: () => void; submitting: boolean; onOpenGraph: () => void; /** Hand this prompt (generate mode) to the Image Suite. */ onOpenSuite?: () => void; magicActive?: boolean; /** Regenerate THIS shot's Magic content prompt (replaces only this entry). */ onRegenMagic?: () => void; magicBusy?: boolean; /** Live credit-quote suffix for the Submit button. */ submitSuffix?: ReactNode }) {
  return (
    <aside className={"prod-prompt-sidepanel" + (magicActive ? " magic-active" : "")}>
      <div className="prod-prompt-drawer-head">
        <span className="prod-prompt-drawer-title">{shotNumber ? `Shot ${shotNumber}` : "Frame prompt"}</span>
        {shotNumber && <button className="prod-btn prod-graph-open" onClick={onOpenGraph} title="Open the node graph for this prompt"><NodesIcon size={14} /> Nodes</button>}
      </div>
      {shotNumber ? <>
        <ReferencePromptEditor
          className="prod-prompt-drawer-text"
          rows={12}
          resizable
          value={value}
          includeBrand={includeBrand}
          references={references}
          placeholder="Generation prompt — type @ to add a reference"
          onChange={onChange}
          styleReadOnly
          brandReadOnly
          afterContent={magicActive && onRegenMagic ? (
            <button
              className="prod-btn prod-magic-refresh"
              disabled={magicBusy}
              onClick={onRegenMagic}
              title="Regenerate this shot's Magic Prompt with AI (other shots are untouched)"
            >
              {magicBusy ? "…" : <RegenerateIcon size={14} />} Regenerate this magic prompt
            </button>
          ) : undefined}
          styleControl={
            <select
              className="prod-openart-select prod-prompt-style"
              value={styleValue}
              onChange={(e) => onStyleChange(e.target.value)}
              title="Render style for this frame (from the styles created in Design, Step 2)"
            >
              <option value="">None</option>
              {styles.map((s) => (
                <option key={s.id} value={s.id}>{s.index}. {s.name || `Style ${s.index}`}</option>
              ))}
            </select>
          }
          brandControl={
            <label className="prod-brand-toggle" title="Include brand identity in this prompt">
              <input type="checkbox" checked={includeBrand} onChange={(e) => onToggleBrand(e.target.checked)} />
            </label>
          }
        />
        <button className="prod-btn prod-prompt-submit" disabled={submitting} onClick={onSubmit}>{submitting ? "Generating…" : <>Submit frame{submitSuffix}</>}</button>
        {onOpenSuite && (
          <button className="prod-btn ghost" title="Open this prompt in the Image Suite" onClick={onOpenSuite}>Open in Suite</button>
        )}
      </> : <p className="hint">Click a storyboard prompt to edit it here.</p>}
    </aside>
  );
}

/** mm:ss label for the Step 4 runtime. */


