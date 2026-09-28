/**
 * The node-canvas reference shelf (extracted from NodeGraphModal so the shot
 * sequence canvas hosts the exact same shelf): collapsible category groups,
 * lazy `?thumb=1` tiles with a bounded load scheduler, filter search, drag-to-
 * canvas tiles (`application/x-cascade-ref`), a magnifier lightbox hook, and
 * the drag-to-resize edge (width persists per production).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Production } from "../../../../shared/ipc.js";
import { usePersistedCollapsed, usePersistedNumber } from "../production/persisted-state.js";
import { refThumbUrl } from "../production/thumb-url.js";
import { MagnifyIcon } from "../icons.js";
import type { GraphRef } from "./ref-node.js";

/* ------------------------------------------------------------------ */
/* Reference shelf                                                     */
/* ------------------------------------------------------------------ */

/** Shelf tiles rendered per group before their thumbnails may load - keeps
 *  the initial DOM small so large projects open fast. */
const SHELF_PAGE = 24;
/** Shelf width (px): the default list column, its drag bounds, and the width at
 *  which tiles switch from a one-column list to a wrapping grid (two 120px
 *  columns plus the list padding/gaps). */
export const SHELF_DEFAULT_WIDTH = 220;
export const SHELF_MIN_WIDTH = 180;
export const SHELF_MAX_WIDTH = 560;
export const SHELF_GRID_WIDTH = 300;
/** Groups bigger than this start collapsed (persisted choice still wins). */
const SHELF_AUTO_COLLAPSE_AT = 24;
/** Max simultaneous shelf thumbnail loads - each `?thumb=1` fetch is a main-
 *  process disk read + resize, so unbounded parallel loads stall the open. */
const MAX_CONCURRENT_SHELF_THUMBS = 4;

let shelfThumbActive = 0;
const shelfThumbWaiters: Array<() => void> = [];

/** Resolve with a slot release once fewer than MAX_CONCURRENT_SHELF_THUMBS
 *  shelf thumbnails are in flight. FIFO; the slot is held until the image
 *  settles (load/error/unmount), not just until its request starts. */
function acquireShelfThumbSlot(): Promise<() => void> {
  return new Promise<() => void>((resolve) => {
    const grant = () => {
      shelfThumbActive += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        shelfThumbActive -= 1;
        const next = shelfThumbWaiters.shift();
        if (next) next();
      });
    };
    if (shelfThumbActive < MAX_CONCURRENT_SHELF_THUMBS) grant();
    else shelfThumbWaiters.push(grant);
  });
}

/** Test seam - reset the thumbnail slot scheduler between cases. */
export function resetShelfThumbSchedulerForTests(): void {
  shelfThumbActive = 0;
  shelfThumbWaiters.length = 0;
}

/** Shelf thumbnail: disk-backed (`cascade-media://`) artwork loads only once
 *  the tile scrolls near the viewport and while a load slot is free - so
 *  opening the graph in a large project no longer fires N thumbnail encodes
 *  at once. Inline data URLs are already in memory and render immediately.
 *  The tile row itself always renders; only the `src` is gated, with a blank
 *  placeholder holding the layout until then. */
function ShelfThumb({ src, alt }: { src: string; alt: string }) {
  const direct = !src.startsWith("cascade-media://");
  const [armed, setArmed] = useState(direct);
  const boxRef = useRef<HTMLDivElement>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (direct) return;
    let live = true;
    let observer: IntersectionObserver | null = null;
    const start = () => {
      void acquireShelfThumbSlot().then((release) => {
        if (!live) { release(); return; }
        releaseRef.current = release;
        setArmed(true);
      });
    };
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") start();
    else {
      observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              observer?.disconnect();
              observer = null;
              start();
            }
          }
        },
        { rootMargin: "200px" },
      );
      observer.observe(el);
    }
    return () => {
      live = false;
      observer?.disconnect();
      releaseRef.current?.();
      releaseRef.current = null;
    };
  }, [direct, src]);
  const settle = () => {
    releaseRef.current?.();
    releaseRef.current = null;
  };
  return (
    <div ref={boxRef} className="prod-graph-shelf-thumb" aria-hidden="true">
      {armed
        ? <img src={refThumbUrl(src)} alt={alt} draggable={false} loading="lazy" decoding="async" onLoad={settle} onError={settle} />
        : <div className="prod-graph-shelf-blank">{"\u2026"}</div>}
    </div>
  );
}

/** Case-insensitive shelf name filter shared by ShelfGroup and the shelf's
 *  no-match empty state, so both agree on what "matching" means. */
function qShelfMatch(refs: GraphRef[], query: string): GraphRef[] {
  const q = query.trim().toLowerCase();
  return q ? refs.filter((r) => r.name.toLowerCase().includes(q)) : refs;
}

/** One collapsible category in the side reference shelf. Collapsed state is
 *  persisted per production + category name (mirrors the references panel).
 *  Only the first SHELF_PAGE matching tiles render; the rest load behind a
 *  Show-more button so large groups don't mount hundreds of rows at once.
 *  A just-saved reference (`highlightId`) forces its group open and scrolls
 *  its tile into view, regardless of the persisted collapsed/page state. */
function ShelfGroup({ prodId, group, query, onCanvasRefIds, highlightId, onDismissHighlight, onZoom }: {
  prodId: string;
  group: { title: string; refs: GraphRef[] };
  query: string;
  onCanvasRefIds: ReadonlySet<string>;
  /** Reference id to reveal + pulse (a just-saved reference), or null. */
  highlightId?: string | null;
  /** Clear the reveal highlight once the user has seen/acted on it. */
  onDismissHighlight?: () => void;
  /** Open a tile's full-res media in the lightbox. */
  onZoom: (ref: GraphRef) => void;
}) {
  const [collapsed, setCollapsed] = usePersistedCollapsed(
    `cascade.prod.${prodId}.graph.shelf.${group.title}`,
    group.refs.length > SHELF_AUTO_COLLAPSE_AT,
  );
  const [shown, setShown] = useState(SHELF_PAGE);
  // Mount this group's tiles only once it nears the shelf viewport. A project
  // with many small categories (each under the auto-collapse/window size) would
  // otherwise mount every tile at once - the group count, not just the per-
  // group size, has to be bounded. Headers always render so the list is
  // navigable; the tile bodies fill in on scroll.
  const rootRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (revealed) return;
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setRevealed(true); return; }
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setRevealed(true); io.disconnect(); } },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [revealed]);
  const matching = qShelfMatch(group.refs, query);
  const q = query.trim().toLowerCase();
  useEffect(() => { setShown(SHELF_PAGE); }, [q, group.refs]);
  // Scroll the freshly-saved tile into view once (keyed on the highlight id, so
  // re-renders don't keep yanking the shelf back). Declared before the early
  // return so hook order stays stable.
  const highlightEl = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (highlightId && highlightEl.current && typeof highlightEl.current.scrollIntoView === "function") {
      highlightEl.current.scrollIntoView({ block: "nearest" });
    }
  }, [highlightId]);
  if (q && matching.length === 0) return null;
  // A just-saved reference must be visible even if its group was collapsed or
  // its tile sits past the page window - force it open and extend the window.
  const highlightIndex = highlightId ? matching.findIndex((r) => r.id === highlightId) : -1;
  const hasHighlight = highlightIndex >= 0;
  const open = hasHighlight || !collapsed;
  const showTiles = hasHighlight || revealed;
  const visible = matching.slice(0, hasHighlight ? Math.max(shown, highlightIndex + 1) : shown);
  return (
    <div ref={rootRef} className="prod-graph-shelf-group">
      <button
        className="prod-graph-shelf-group-head"
        aria-expanded={open}
        title={collapsed ? `Show ${group.title}` : `Hide ${group.title}`}
        onClick={() => { onDismissHighlight?.(); setCollapsed(open); }}
      >
        <svg className={"prod-graph-shelf-caret" + (open ? "" : " collapsed")} viewBox="0 0 16 16" width="9" height="9" aria-hidden="true"><path d="M5 3l6 5-6 5V3z" fill="currentColor" /></svg>
        <span className="prod-graph-shelf-group-name">{group.title}</span>
        <span className="prod-graph-shelf-count">{q ? `${matching.length}/${group.refs.length}` : group.refs.length}</span>
      </button>
      {open && showTiles && (
        <div className="prod-graph-shelf-tiles">
          {visible.map((r) => {
            const onCanvas = onCanvasRefIds.has(r.id);
            const highlighted = r.id === highlightId;
            return (
              <div
                key={r.id}
                ref={highlighted ? highlightEl : undefined}
                className={"prod-graph-shelf-item" + (onCanvas ? " on-canvas" : "") + (highlighted ? " highlight" : "")}
                draggable={!onCanvas}
                title={onCanvas ? "Already on the canvas" : `Drag onto the canvas to add @[${r.name}]`}
                onMouseEnter={highlighted ? onDismissHighlight : undefined}
                onDragStart={(e) => {
                  if (highlighted) onDismissHighlight?.();
                  e.dataTransfer.setData("application/x-cascade-ref", r.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                {r.artwork
                  ? <ShelfThumb src={r.artwork} alt={r.name} />
                  : <div className="prod-graph-shelf-blank">{r.media === "video" ? "\u25B6" : r.media === "audio" ? "\u266A" : "?"}</div>}
                <span className="prod-graph-shelf-name" title={`Reference @[${r.name}]`}>@[{r.name}]</span>
                {onCanvas && <span className="prod-graph-shelf-check">on canvas</span>}
                {(r.artwork || (r.media === "video" && r.mediaPath)) && (
                  <button
                    type="button"
                    className="prod-graph-shelf-zoom nodrag"
                    title="View full resolution"
                    draggable={false}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (highlighted) onDismissHighlight?.(); onZoom(r); }}
                  >
                    <MagnifyIcon size={11} />
                  </button>
                )}
              </div>
            );
          })}
          {matching.length > visible.length && (
            <button
              className="prod-graph-shelf-more nodrag"
              onClick={() => setShown((n) => n + SHELF_PAGE)}
            >
              Show more ({matching.length - visible.length} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Group the flat reference list by category (characters, products, custom
 *  categories) for the side shelf - the same deduped flat list the tags
 *  resolve against, just grouped for browsing. */
export function shelfGroupsFor(
  prod: Pick<Production, "characters" | "products" | "references" | "referenceCategories">,
  references: GraphRef[]
): { title: string; refs: GraphRef[] }[] {
  const catOf = new Map<string, string>();
  for (const c of prod.characters ?? []) if (c.id) catOf.set(c.id, "Characters");
  for (const p of prod.products ?? []) if (p.id) catOf.set(p.id, "Products");
  const catName = new Map<string, string>();
  for (const c of prod.referenceCategories ?? []) catName.set(c.id, c.name);
  for (const r of prod.references ?? []) if (r.id) catOf.set(r.id, catName.get(r.categoryId ?? "") ?? "References");
  const byTitle = new Map<string, GraphRef[]>();
  const titles: string[] = [];
  const groupFor = (title: string): GraphRef[] => {
    let refs = byTitle.get(title);
    if (!refs) { refs = []; byTitle.set(title, refs); titles.push(title); }
    return refs;
  };
  for (const r of references) groupFor(catOf.get(r.id) ?? "References").push(r);
  const rank = (t: string) => t === "Characters" ? 0 : t === "Products" ? 1 : t === "References" ? 2 : 3;
  titles.sort((a, b) => rank(a) - rank(b));
  return titles.map((title) => ({ title, refs: byTitle.get(title)! }));
}

/** The whole left reference shelf panel: collapse rail, filter search, the
 *  grouped tiles, and the drag-to-resize edge. Collapsed by default so opening
 *  a canvas doesn't mount (and thumbnail-encode) every reference; toggling it
 *  open loads the shelf on demand. A non-null `highlightId` forces it open,
 *  clears the filter, and pulses the tile (the "saved as reference" reveal). */
export function RefShelf({ prodId, prod, references, onCanvasRefIds, highlightId, onDismissHighlight, onZoom }: {
  prodId: string;
  prod: Pick<Production, "characters" | "products" | "references" | "referenceCategories">;
  references: GraphRef[];
  /** Ref ids already placed/wired on this canvas ("on canvas", not draggable). */
  onCanvasRefIds: ReadonlySet<string>;
  /** Reference id to reveal + pulse (a just-saved reference), or null. */
  highlightId?: string | null;
  onDismissHighlight?: () => void;
  onZoom: (ref: GraphRef) => void;
}) {
  const [shelfOpen, setShelfOpen] = useState(false);
  // Shelf width is per-production UI state (localStorage, like the group
  // collapsed flags); past SHELF_GRID_WIDTH the tiles wrap into a grid.
  const [shelfWidth, setShelfWidth] = usePersistedNumber(
    `cascade.prod.${prodId}.graph.shelfWidth`,
    SHELF_DEFAULT_WIDTH,
    { min: SHELF_MIN_WIDTH, max: SHELF_MAX_WIDTH },
  );
  const [shelfQuery, setShelfQuery] = useState("");
  const shelfGroups = useMemo(() => shelfGroupsFor(prod, references), [prod, references]);
  // A reveal (just-saved reference) opens the shelf and clears the filter so
  // the tile can actually be seen, regardless of the collapsed state.
  const lastHighlight = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (highlightId && highlightId !== lastHighlight.current) {
      setShelfOpen(true);
      setShelfQuery("");
    }
    lastHighlight.current = highlightId;
  }, [highlightId]);
  /** Drag the shelf's right edge to resize it (pointer capture so the drag
   *  survives leaving the thin handle). Width persists per production. */
  const shelfResize = useRef<{ startX: number; startW: number } | null>(null);
  const onShelfResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    shelfResize.current = { startX: e.clientX, startW: shelfWidth };
  };
  const onShelfResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = shelfResize.current;
    if (r) setShelfWidth(r.startW + (e.clientX - r.startX));
  };
  const onShelfResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!shelfResize.current) return;
    shelfResize.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  return (
    <div
      className={"prod-graph-shelf" + (shelfOpen ? "" : " collapsed")}
      style={shelfOpen ? { width: shelfWidth } : undefined}
    >
      {shelfOpen ? (
        <>
          <div className="prod-graph-shelf-head">
            <div className="prod-graph-shelf-head-row">
              <button
                type="button"
                className="prod-graph-shelf-toggle nodrag"
                aria-expanded={true}
                title="Collapse the reference shelf"
                onClick={() => { setShelfOpen(false); onDismissHighlight?.(); }}
              >
                <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M10 3L5 8l5 5V3z" fill="currentColor" /></svg>
              </button>
              <span className="prod-graph-shelf-title">References</span>
            </div>
            <span className="prod-graph-shelf-hint">Drag onto the canvas to add · drag the edge to resize</span>
            {references.length > 0 && (
              <input
                className="prod-graph-shelf-search nodrag"
                type="text"
                value={shelfQuery}
                onChange={(e) => { setShelfQuery(e.target.value); onDismissHighlight?.(); }}
                placeholder="Filter references…"
                aria-label="Filter references"
              />
            )}
          </div>
          <div className={"prod-graph-shelf-list" + (shelfWidth >= SHELF_GRID_WIDTH ? " grid" : "")}>
            {shelfGroups.map((group) => (
              <ShelfGroup
                key={group.title}
                prodId={prodId}
                group={group}
                query={shelfQuery}
                onCanvasRefIds={onCanvasRefIds}
                highlightId={highlightId}
                onDismissHighlight={onDismissHighlight}
                onZoom={onZoom}
              />
            ))}
            {references.length === 0 && <div className="prod-graph-shelf-empty">No references yet — drop image, video, or audio files onto the canvas to create them.</div>}
            {references.length > 0 && shelfGroups.every((g) => qShelfMatch(g.refs, shelfQuery).length === 0) && (
              <div className="prod-graph-shelf-empty">No references match “{shelfQuery.trim()}”.</div>
            )}
          </div>
          <div
            className="prod-graph-shelf-resize nodrag"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the reference shelf"
            title="Drag to resize"
            onPointerDown={onShelfResizeDown}
            onPointerMove={onShelfResizeMove}
            onPointerUp={onShelfResizeUp}
            onPointerCancel={onShelfResizeUp}
          />
        </>
      ) : (
        <button
          type="button"
          className="prod-graph-shelf-rail nodrag"
          aria-expanded={false}
          title="Show the reference shelf"
          onClick={() => setShelfOpen(true)}
        >
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M6 3l5 5-5 5V3z" fill="currentColor" /></svg>
          <span className="prod-graph-shelf-rail-label">References</span>
          {references.length > 0 && <span className="prod-graph-shelf-rail-count">{references.length}</span>}
        </button>
      )}
    </div>
  );
}
