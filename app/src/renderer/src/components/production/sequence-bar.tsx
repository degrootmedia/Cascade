/**
 * Storyboard shot-sequence bars (Spec 06): the accent bar that spans a
 * sequence's frames ("Open Sequence", enable/disable, delete, right-click
 * accent palette) and the "Create Shot Sequence" strip that pops up under a
 * fresh shift-click range.
 *
 * The storyboard grid reflows as cards wrap (window width / the frame-size
 * slider), so bars are positioned from MEASURED card rects — the pure
 * `sequenceBarSpans` turns the members' rects into one span per grid row and
 * this layer renders each span over the animated bottom slot the member cards
 * open for it ("the frames animate to make space"). Measurement lives here
 * (the one DOM owner); the span math is shared and unit-tested.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SequenceBarSpan, ShotSequence } from "../../../../shared/ipc.js";
import {
  SEQUENCE_ACCENT_COLORS,
  sequenceAccentHex,
  sequenceBarSpans,
} from "../../../../shared/ipc.js";

/** Bottom slot height member cards open for a bar — must match the
 *  `.prod-board.seq-slot` padding in styles.css. */
export const SEQUENCE_BAR_SLOT = 40;

/** One bar/strip to draw under a set of member cards. */
export interface SequenceBarTarget {
  /** Stable identity for the positioned span list. */
  key: string;
  /** The cards the bar spans (shot ids). */
  shotIds: string[];
  /** Chrome per row span: `spanCount` bars top-to-bottom. */
  render: (spanIndex: number, spanCount: number) => React.ReactNode;
}

/** Relative rects of the members' cards → one span per grid row. */
function measureSpans(grid: HTMLElement, shotIds: string[]): SequenceBarSpan[] {
  const gridRect = grid.getBoundingClientRect();
  const wanted = new Set(shotIds);
  const rects: { id: string; left: number; top: number; right: number; bottom: number }[] = [];
  for (const el of grid.querySelectorAll<HTMLElement>("[data-shot-id]")) {
    const id = el.dataset.shotId;
    if (!id || !wanted.has(id)) continue;
    const r = el.getBoundingClientRect();
    rects.push({
      id,
      left: r.left - gridRect.left,
      top: r.top - gridRect.top,
      right: r.right - gridRect.left,
      bottom: r.bottom - gridRect.top,
    });
  }
  return sequenceBarSpans(rects);
}

/**
 * Absolutely-positioned bar layer over the board grid. Re-measures on target
 * changes, grid resize/reflow (ResizeObserver), and window resize.
 */
export function SequenceBarLayer({ gridRef, targets }: {
  gridRef: React.RefObject<HTMLElement | null>;
  targets: SequenceBarTarget[];
}) {
  const [spans, setSpans] = useState<Record<string, SequenceBarSpan[]>>({});
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const measure = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const next: Record<string, SequenceBarSpan[]> = {};
    for (const t of targetsRef.current) next[t.key] = measureSpans(grid, t.shotIds);
    setSpans((prev) => {
      const same =
        Object.keys(prev).length === Object.keys(next).length &&
        Object.keys(next).every((k) => JSON.stringify(prev[k]) === JSON.stringify(next[k]));
      return same ? prev : next;
    });
  }, [gridRef]);
  // Signature so a targets identity change (selection/membership) re-measures
  // without depending on the (unstable) render closures in `targets`.
  const sig = JSON.stringify(targets.map((t) => [t.key, t.shotIds]));
  useLayoutEffect(() => {
    measure();
  }, [measure, sig]);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(grid);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, gridRef]);
  return (
    <>
      {targets.flatMap((t) =>
        (spans[t.key] ?? []).map((span, i, all) => (
          <div
            key={`${t.key}-${i}`}
            className="seq-bar-slot"
            style={{
              left: span.left,
              width: Math.max(0, span.right - span.left),
              top: span.bottom - SEQUENCE_BAR_SLOT + 4,
              height: SEQUENCE_BAR_SLOT - 8,
            }}
          >
            {t.render(i, all.length)}
          </div>
        ))
      )}
    </>
  );
}

/** The bar chrome: accent-colored, with the sequence's label/status and the
 *  Open Sequence / enable / delete controls. Right-click picks a new accent. */
export function SequenceBarChrome({ seq, frameCount, outputMedia, collapsed, onOpen, onToggle, onDelete, onAccent }: {
  seq: ShotSequence;
  frameCount: number;
  /** What the frame output node is bound to (drives the status chip). */
  outputMedia: "video" | "image" | null;
  /** Row span below the first of a wrapped selection: a bare accent bar. */
  collapsed: boolean;
  onOpen: (sequenceId: string) => void;
  onToggle: (sequenceId: string) => void;
  onDelete: (sequenceId: string) => void;
  onAccent: (sequenceId: string, accent: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const accent = sequenceAccentHex(seq.accent);
  const enabled = seq.enabled !== false;
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenu(null);
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);
  return (
    <div
      className={"seq-bar" + (enabled ? "" : " disabled")}
      style={{ ["--seq-accent" as string]: accent }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {collapsed ? (
        <span className="seq-bar-ghost" aria-hidden />
      ) : (
        <>
          <span className="seq-bar-label" title={`${seq.name} — ${frameCount} frames`}>
            {seq.name}
            <em>{frameCount} frames</em>
          </span>
          <span
            className={"seq-bar-status" + (outputMedia ? " ready" : "")}
            title={
              outputMedia === "video"
                ? "This sequence's output node is bound to a clip — it replaces its span in the animatic"
                : outputMedia === "image"
                  ? "This sequence's output node is bound to a still — it is held over the span"
                  : "The frame output node is unbound — the animatic shows a slate over this span"
            }
          >
            {outputMedia === "video" ? "video" : outputMedia === "image" ? "still" : "slate"}
          </span>
          <span className="seq-bar-actions">
            <button className="seq-bar-open" onClick={() => onOpen(seq.id)}>Open Sequence</button>
            <button
              className="seq-bar-toggle"
              title={enabled ? "Disable this sequence — its frames play individually in the animatic again" : "Enable this sequence — it replaces its frames in the animatic and export"}
              onClick={() => onToggle(seq.id)}
            >
              {enabled ? "On" : "Off"}
            </button>
            <button className="seq-bar-delete" title="Delete this shot sequence…" onClick={() => onDelete(seq.id)}>×</button>
          </span>
        </>
      )}
      {menu && (
        <div
          ref={menuRef}
          className="session-context-menu seq-accent-menu"
          style={{ position: "fixed", top: menu.y, left: menu.x, zIndex: 60 }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <div className="ctx-title">Bar color</div>
          <div className="seq-accent-grid">
            {SEQUENCE_ACCENT_COLORS.map((c) => (
              <button
                key={c.id}
                className={"seq-accent-swatch" + (c.id === seq.accent || (!seq.accent && c.id === "blue") ? " current" : "")}
                style={{ background: c.hex }}
                title={c.label}
                onClick={() => { onAccent(seq.id, c.id); setMenu(null); }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The strip under a fresh shift-click range: create the sequence (or cancel). */
export function SequenceCreateStrip({ frameCount, reason, onCreate, onCancel }: {
  frameCount: number;
  /** Why creation is blocked right now (hidden when null). */
  reason: string | null;
  onCreate: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="seq-create-strip">
      {reason ? (
        <span className="seq-create-reason">{reason}</span>
      ) : (
        <button className="seq-create-button" onClick={onCreate}>
          Create Shot Sequence
        </button>
      )}
      <span className="seq-create-count">{frameCount} frames selected</span>
      <button className="seq-create-cancel" onClick={onCancel} title="Clear the selection">Esc</button>
    </div>
  );
}
