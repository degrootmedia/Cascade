/**
 * Reference Moodboard — a PureRef-style pan/zoom canvas of every custom
 * reference in the open production. The board is production-scoped: its
 * layout (node placements, viewport, background, notes) persists additively on
 * `Production.moodboard` through the normal save path, so nothing about it is
 * shared between projects.
 *
 * Nodes reuse the sidebar's `RefFigure` visuals (`variant="node"`); this
 * component owns only the canvas interactions. All layout math lives in the
 * pure `moodboard-layout.ts` module.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type {
  CustomRef,
  MoodboardLayout,
  MoodboardNote,
  Production,
  ReferenceCategory,
} from "../../../../shared/ipc.js";
import { PlusIcon, XIcon } from "../../components/icons.js";
import { cascadeMedia } from "../../components/production/animatic.js";
import { MoodboardNode } from "./MoodboardNode.js";
import { MoodboardFrameView } from "./MoodboardFrame.js";
import { MoodboardToolbar } from "./MoodboardToolbar.js";
import { MoodboardMinimap } from "./MoodboardMinimap.js";
import { MoodboardShelf } from "./MoodboardShelf.js";
import {
  MB_DEFAULT_H,
  MB_DEFAULT_W,
  MB_FRAME_MIN_H,
  MB_FRAME_MIN_W,
  MB_SHELF_COLS,
  MB_SHELF_GAP,
  contentBounds,
  fitViewport,
  framesForRefs,
  groupNodes,
  nextZ,
  nodeBounds,
  nodesInRect,
  normalizeMoodboardLayout,
  reconcileMoodboard,
  offBoardRefs,
  refKeys,
  removeFrame,
  resizeFrame,
  screenToWorld,
  setFrameColor,
  setFrameLabel,
  settleFrameMembership,
  snapMove,
  snapRotation,
  snapToGrid,
  ungroupFrames,
  visibleNodes,
  zoomAt,
  type MoodboardGuide,
  type MoodboardRect,
  type MoodboardViewport,
} from "./moodboard-layout.js";

/** Debounce before the layout is persisted through `production:save`. */
const SAVE_DEBOUNCE_MS = 500;
/** Boards larger than this get a minimap (orientation stops being optional). */
const MINIMAP_THRESHOLD = 40;

type Gesture =
  | { kind: "move"; ids: string[]; startWorld: { x: number; y: number }; start: Map<string, { x: number; y: number }>; frames: Map<string, { x: number; y: number }>; settle: boolean; alt: boolean; moved: boolean }
  | { kind: "resize"; id: string; startWorld: { x: number; y: number }; startW: number; startH: number; ratio: number }
  | { kind: "frameresize"; id: string; startWorld: { x: number; y: number }; startW: number; startH: number }
  | { kind: "rotate"; id: string; center: { x: number; y: number }; startAngle: number; startRotation: number }
  | { kind: "pan"; button: number; startScreen: { sx: number; sy: number }; startVp: MoodboardViewport }
  | { kind: "marquee"; startWorld: { x: number; y: number }; add: boolean }
  | { kind: "notemove"; id: string; startWorld: { x: number; y: number }; startX: number; startY: number };

function angleDeg(cx: number, cy: number, x: number, y: number): number {
  return (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
}

function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): MoodboardRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function renderNoteMarkdown(text: string): string {
  try {
    const html = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "input", "script"], FORBID_ATTR: ["style"] });
  } catch {
    return "";
  }
}

const NoteCard = memo(function NoteCard({
  note,
  editing,
  onStartMove,
  onStartEdit,
  onCommit,
  onDelete,
}: {
  note: MoodboardNote;
  editing: boolean;
  onStartMove: (e: ReactPointerEvent, id: string) => void;
  onStartEdit: (id: string) => void;
  onCommit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState(note.text);
  useEffect(() => { if (editing) setDraft(note.text); }, [editing, note.text]);
  const html = useMemo(() => renderNoteMarkdown(note.text), [note.text]);
  return (
    <div
      className="moodboard-note"
      style={{ left: note.x, top: note.y, width: note.w, height: note.h }}
      onDoubleClick={(e) => { e.stopPropagation(); onStartEdit(note.id); }}
    >
      <div className="moodboard-note-head" onPointerDown={(e) => onStartMove(e, note.id)}>
        <span>Note</span>
        <button className="moodboard-note-del" title="Delete note" onPointerDown={(e) => e.stopPropagation()} onClick={() => onDelete(note.id)}><XIcon size={11} /></button>
      </div>
      {editing ? (
        <textarea
          className="moodboard-note-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommit(note.id, draft)}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCommit(note.id, draft); } }}
        />
      ) : (
        <div className="moodboard-note-body" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
});

export function MoodboardCanvas({
  prod,
  initialLayout,
  onLayoutChange,
  onAddReference,
  onAddFiles,
  onRename,
  onAttach,
}: {
  prod: Production;
  /** The production's persisted board, read once on mount. */
  initialLayout?: MoodboardLayout;
  /** Debounced persistence callback (the workspace saves `Production.moodboard`). */
  onLayoutChange: (layout: MoodboardLayout) => void;
  /** Add one reference image (native picker); resolves to the new ref id. */
  onAddReference: () => Promise<string | undefined>;
  /** Add dropped files as references; resolves to the new ref ids. */
  onAddFiles?: (files: File[]) => Promise<string[]>;
  onRename: (id: string, name: string) => void;
  onAttach: (id: string) => void;
}) {
  const prodId = prod.meta.id;
  const refs = prod.references ?? [];
  const categories: ReferenceCategory[] = prod.referenceCategories ?? [];

  const [layout, setLayoutState] = useState<MoodboardLayout>(() =>
    reconcileMoodboard(normalizeMoodboardLayout(initialLayout), refKeys(refs)),
  );
  /** Authoritative layout for gesture handlers — updated synchronously so
   *  several pointer moves in one frame never read a stale base. */
  const liveRef = useRef(layout);
  // Perf: coalesce the React state update (and therefore the re-cull/re-render,
  // which can mount full-res images) to at most one per animation frame. The
  // gesture handlers keep computing against the synchronous `liveRef`, so
  // several wheel/pointer events within a frame still compose correctly — only
  // the repaint is throttled. Matches the node graph's position flush.
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<MoodboardLayout | null>(null);
  const flushFrame = useCallback(() => {
    frameRef.current = null;
    const next = pendingRef.current;
    pendingRef.current = null;
    if (next) setLayoutState(next);
  }, []);
  const commit = useCallback((updater: (l: MoodboardLayout) => MoodboardLayout) => {
    const next = updater(liveRef.current);
    liveRef.current = next;
    pendingRef.current = next;
    if (frameRef.current != null) return;
    if (typeof requestAnimationFrame === "function") {
      frameRef.current = requestAnimationFrame(flushFrame);
    } else {
      flushFrame();
    }
  }, [flushFrame]);
  useEffect(() => () => {
    if (frameRef.current != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<MoodboardRect | null>(null);
  const marqueeRef = useRef<MoodboardRect | null>(null);
  marqueeRef.current = marquee;
  const [guides, setGuides] = useState<MoodboardGuide[]>([]);
  const [viewer, setViewer] = useState<CustomRef | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; refId: string } | null>(null);
  const [frameMenu, setFrameMenu] = useState<{ x: number; y: number; frameId: string } | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const canvasRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [gestureActive, setGestureActive] = useState(false);
  const spaceRef = useRef(false);
  /** Set when a right-button drag actually pans, so the trailing contextmenu
   *  (which the browser fires on release) doesn't pop a node menu mid-pan. */
  const suppressContextRef = useRef(false);

  const onLayoutChangeRef = useRef(onLayoutChange);
  onLayoutChangeRef.current = onLayoutChange;

  const refById = useMemo(() => new Map(refs.map((r) => [r.id, r])), [refs]);

  const localPoint = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { sx: e.clientX - (rect?.left ?? 0), sy: e.clientY - (rect?.top ?? 0) };
  }, []);

  // Reconcile when the production's reference set changes (add/remove/category).
  const refsSignature = useMemo(() => refs.map((r) => `${r.id}:${r.categoryId ?? ""}`).join("|"), [refs]);
  useEffect(() => {
    commit((prev) => reconcileMoodboard(prev, refKeys(refs)));
  }, [refsSignature, commit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced persistence; the initial pass is skipped (nothing changed yet).
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) { firstSave.current = false; return; }
    const t = setTimeout(() => onLayoutChangeRef.current(liveRef.current), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [layout]);
  // Flush any pending change when the board closes.
  useEffect(() => () => { onLayoutChangeRef.current(liveRef.current); }, []);

  // Measure the viewport for fit/culling/minimap.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Non-passive wheel: the wheel zooms toward the cursor, matching the node
  // graph canvas (drag-pan is the middle/right button instead).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      commit((l) => ({ ...l, viewport: zoomAt(l.viewport, sx, sy, Math.exp(-e.deltaY * 0.0015)) }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [commit]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === "Space") spaceRef.current = true; };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") spaceRef.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  const hideNodes = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const set = new Set(ids);
    commit((l) => ({ ...l, nodes: l.nodes.map((n) => (set.has(n.refId) ? { ...n, hidden: true } : n)) }));
    setSelection(new Set());
  }, [commit]);

  const showAll = useCallback(() => {
    commit((l) => ({ ...l, nodes: l.nodes.map((n) => (n.hidden ? { ...n, hidden: false } : n)) }));
  }, [commit]);

  const sendZ = useCallback((ids: string[], dir: "front" | "back") => {
    if (!ids.length) return;
    const set = new Set(ids);
    commit((l) => {
      if (dir === "front") {
        let z = nextZ(l.nodes);
        return { ...l, nodes: l.nodes.map((n) => (set.has(n.refId) ? { ...n, z: z++ } : n)) };
      }
      const min = l.nodes.length ? Math.min(...l.nodes.map((n) => n.z)) : 0;
      let z = min - ids.length;
      return { ...l, nodes: l.nodes.map((n) => (set.has(n.refId) ? { ...n, z: z++ } : n)) };
    });
  }, [commit]);

  const fit = useCallback(() => {
    const visible = liveRef.current.nodes.filter((n) => !n.hidden);
    const vp = fitViewport(contentBounds(visible), sizeRef.current.w, sizeRef.current.h);
    commit((l) => ({ ...l, viewport: vp }));
  }, [commit]);

  const resetZoom = useCallback(() => {
    const s = sizeRef.current;
    commit((l) => ({ ...l, viewport: zoomAt(l.viewport, s.w / 2, s.h / 2, 1 / l.viewport.zoom) }));
  }, [commit]);

  const zoomStep = useCallback((direction: 1 | -1) => {
    const s = sizeRef.current;
    commit((l) => ({ ...l, viewport: zoomAt(l.viewport, s.w / 2, s.h / 2, direction > 0 ? 1.2 : 1 / 1.2) }));
  }, [commit]);

  const arrangeSelected = useCallback(() => {
    const ids = selectionRef.current;
    if (!ids.size) return;
    const set = new Set(ids);
    commit((l) => {
      const selected = l.nodes.filter((n) => set.has(n.refId)).sort((a, b) => a.z - b.z);
      if (!selected.length) return l;
      const bounds = contentBounds(selected);
      const startX = bounds?.x ?? 0;
      const startY = bounds?.y ?? 0;
      const placed = selected.map((n, i) => ({
        ...n,
        x: startX + (i % MB_SHELF_COLS) * (MB_DEFAULT_W + MB_SHELF_GAP),
        y: startY + Math.floor(i / MB_SHELF_COLS) * (MB_DEFAULT_H + MB_SHELF_GAP),
      }));
      const placedById = new Map(placed.map((n) => [n.refId, n]));
      return { ...l, nodes: l.nodes.map((n) => placedById.get(n.refId) ?? n) };
    });
  }, [commit]);

  const addNote = useCallback((world: { x: number; y: number }) => {
    const id = `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    commit((l) => ({
      ...l,
      notes: [...(l.notes ?? []), { id, x: world.x, y: world.y, w: 260, h: 160, text: "Double-click to edit" }],
    }));
    setEditingNote(id);
  }, [commit]);

  // --- frames (grouped references) ------------------------------------------

  const groupSelection = useCallback(() => {
    const ids = [...selectionRef.current];
    if (!ids.length) return;
    const id = `frame_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    commit((l) => groupNodes(l, ids, { id }));
  }, [commit]);

  const ungroupSelection = useCallback(() => {
    const ids = [...selectionRef.current];
    if (!ids.length) return;
    commit((l) => ungroupFrames(l, ids));
  }, [commit]);

  const setFrameLabelById = useCallback((id: string, label: string) => {
    commit((l) => setFrameLabel(l, id, label));
  }, [commit]);

  const setFrameColorById = useCallback((id: string, color: string) => {
    commit((l) => setFrameColor(l, id, color));
  }, [commit]);

  const removeFrameById = useCallback((id: string) => {
    commit((l) => removeFrame(l, id));
  }, [commit]);

  const commitNote = useCallback((id: string, text: string) => {
    commit((l) => ({ ...l, notes: (l.notes ?? []).map((n) => (n.id === id ? { ...n, text } : n)) }));
    setEditingNote(null);
  }, [commit]);

  const deleteNote = useCallback((id: string) => {
    commit((l) => ({ ...l, notes: (l.notes ?? []).filter((n) => n.id !== id) }));
    setEditingNote((cur) => (cur === id ? null : cur));
  }, [commit]);

  // --- gesture starts -------------------------------------------------------

  const beginMove = useCallback((e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setMenu(null);
    setFrameMenu(null);
    const sel = selectionRef.current;
    let ids: string[];
    if (e.shiftKey) {
      const next = new Set(sel);
      if (next.has(id)) next.delete(id); else next.add(id);
      setSelection(next);
      ids = [...next];
    } else if (sel.has(id)) {
      ids = [...sel];
    } else {
      setSelection(new Set([id]));
      ids = [id];
    }
    if (!ids.length) return;
    const l = liveRef.current;
    // Dragging any member of a frame moves the whole group, frame included —
    // unless Alt is held, which pulls just the grabbed node(s) out of the group.
    const frames = e.altKey ? [] : framesForRefs(l, ids);
    const memberIds = new Set(ids);
    for (const f of frames) for (const r of f.refIds) memberIds.add(r);
    const start = new Map(l.nodes.map((n) => [n.refId, { x: n.x, y: n.y }]));
    const p = localPoint(e);
    gestureRef.current = {
      kind: "move",
      ids: [...memberIds],
      startWorld: screenToWorld(l.viewport, p.sx, p.sy),
      start,
      frames: new Map(frames.map((f) => [f.id, { x: f.x, y: f.y }])),
      settle: true,
      alt: e.altKey,
      moved: false,
    };
    setGestureActive(true);
  }, [localPoint]);

  /** Drag a frame's header: translate the frame and every member node. */
  const beginFrameMove = useCallback((e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setMenu(null);
    setFrameMenu(null);
    const l = liveRef.current;
    const frame = (l.frames ?? []).find((f) => f.id === id);
    if (!frame) return;
    const memberIds = new Set(frame.refIds);
    setSelection(new Set(memberIds));
    const p = localPoint(e);
    gestureRef.current = {
      kind: "move",
      ids: [...memberIds],
      startWorld: screenToWorld(l.viewport, p.sx, p.sy),
      start: new Map(l.nodes.map((n) => [n.refId, { x: n.x, y: n.y }])),
      frames: new Map([[frame.id, { x: frame.x, y: frame.y }]]),
      settle: false,
      alt: false,
      moved: false,
    };
    setGestureActive(true);
  }, [localPoint]);

  const beginFrameResize = useCallback((e: ReactPointerEvent, id: string) => {
    const frame = (liveRef.current.frames ?? []).find((f) => f.id === id);
    if (!frame) return;
    e.preventDefault();
    const p = localPoint(e);
    gestureRef.current = {
      kind: "frameresize",
      id,
      startWorld: screenToWorld(liveRef.current.viewport, p.sx, p.sy),
      startW: frame.w,
      startH: frame.h,
    };
    setGestureActive(true);
  }, [localPoint]);

  const beginResize = useCallback((e: ReactPointerEvent, id: string) => {
    const n = liveRef.current.nodes.find((node) => node.refId === id);
    if (!n) return;
    e.preventDefault();
    setSelection(new Set([id]));
    const p = localPoint(e);
    gestureRef.current = {
      kind: "resize",
      id,
      startWorld: screenToWorld(liveRef.current.viewport, p.sx, p.sy),
      startW: n.w,
      startH: n.h,
      ratio: n.h > 0 ? n.w / n.h : 1,
    };
    setGestureActive(true);
  }, [localPoint]);

  const beginRotate = useCallback((e: ReactPointerEvent, id: string) => {
    const n = liveRef.current.nodes.find((node) => node.refId === id);
    if (!n) return;
    e.preventDefault();
    const p = localPoint(e);
    const world = screenToWorld(liveRef.current.viewport, p.sx, p.sy);
    const center = { x: n.x + n.w / 2, y: n.y + n.h / 2 };
    gestureRef.current = {
      kind: "rotate",
      id,
      center,
      startAngle: angleDeg(center.x, center.y, world.x, world.y),
      startRotation: n.rotation ?? 0,
    };
    setGestureActive(true);
  }, [localPoint]);

  const beginNoteMove = useCallback((e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const note = (liveRef.current.notes ?? []).find((n) => n.id === id);
    if (!note) return;
    const p = localPoint(e);
    gestureRef.current = {
      kind: "notemove",
      id,
      startWorld: screenToWorld(liveRef.current.viewport, p.sx, p.sy),
      startX: note.x,
      startY: note.y,
    };
    setGestureActive(true);
  }, [localPoint]);

  const onCanvasPointerDown = useCallback((e: ReactPointerEvent) => {
    const p = localPoint(e);
    // Middle- and right-button drags pan the board from anywhere — over nodes
    // too — matching the node graph canvas.
    if (e.button === 1 || e.button === 2) {
      if (e.button === 1) e.preventDefault();
      suppressContextRef.current = false;
      setMenu(null);
      setFrameMenu(null);
      gestureRef.current = { kind: "pan", button: e.button, startScreen: p, startVp: { ...liveRef.current.viewport } };
      setGestureActive(true);
      return;
    }
    if (e.target !== e.currentTarget) return;
    setMenu(null);
    setFrameMenu(null);
    if (editingNote) setEditingNote(null);
    if (spaceRef.current) {
      e.preventDefault();
      gestureRef.current = { kind: "pan", button: 0, startScreen: p, startVp: { ...liveRef.current.viewport } };
      setGestureActive(true);
      return;
    }
    if (e.button !== 0) return;
    const world = screenToWorld(liveRef.current.viewport, p.sx, p.sy);
    if (e.detail === 2) { addNote(world); return; }
    if (!e.shiftKey) setSelection(new Set());
    gestureRef.current = { kind: "marquee", startWorld: world, add: e.shiftKey };
    setGestureActive(true);
  }, [addNote, editingNote, localPoint]);

  // --- gesture move/up ------------------------------------------------------

  useEffect(() => {
    if (!gestureActive) return;
    const onMove = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      const l = liveRef.current;
      const p = localPoint(e);
      if (g.kind === "pan") {
        const dx = p.sx - g.startScreen.sx;
        const dy = p.sy - g.startScreen.sy;
        if (g.button === 2 && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) suppressContextRef.current = true;
        commit((cur) => ({
          ...cur,
          viewport: { ...cur.viewport, x: g.startVp.x + dx, y: g.startVp.y + dy },
        }));
        return;
      }
      const world = screenToWorld(l.viewport, p.sx, p.sy);
      if (g.kind === "marquee") {
        setMarquee(normalizeRect(g.startWorld, world));
        return;
      }
      if (g.kind === "move") {
        const dx = world.x - g.startWorld.x;
        const dy = world.y - g.startWorld.y;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) g.moved = true;
        const dragSet = new Set(g.ids);
        // A grouped drag translates the frame(s) and all members by one delta so
        // the arrangement is preserved (no per-node snapping).
        if (g.frames.size) {
          commit((cur) => ({
            ...cur,
            nodes: cur.nodes.map((n) => {
              if (!dragSet.has(n.refId)) return n;
              const s = g.start.get(n.refId)!;
              return { ...n, x: s.x + dx, y: s.y + dy };
            }),
            frames: (cur.frames ?? []).map((f) => {
              const s = g.frames.get(f.id);
              return s ? { ...f, x: s.x + dx, y: s.y + dy } : f;
            }),
          }));
          return;
        }
        const others = l.nodes.filter((n) => !dragSet.has(n.refId)).map(nodeBounds);
        let nextGuides: MoodboardGuide[] = [];
        const nodes = l.nodes.map((n) => {
          if (!dragSet.has(n.refId)) return n;
          const s = g.start.get(n.refId)!;
          let nx = s.x + dx;
          let ny = s.y + dy;
          if (!e.shiftKey) {
            const snapped = snapMove({ x: nx, y: ny, w: n.w, h: n.h }, others);
            if (snapped.guides.length) { nx = snapped.x; ny = snapped.y; nextGuides = snapped.guides; }
            else { nx = snapToGrid(nx); ny = snapToGrid(ny); }
          }
          return { ...n, x: nx, y: ny };
        });
        setGuides(nextGuides);
        commit((cur) => ({ ...cur, nodes }));
        return;
      }
      if (g.kind === "frameresize") {
        const dx = world.x - g.startWorld.x;
        const dy = world.y - g.startWorld.y;
        commit((cur) => resizeFrame(cur, g.id, g.startW + dx, g.startH + dy));
        return;
      }
      if (g.kind === "resize") {
        const dx = world.x - g.startWorld.x;
        const dy = world.y - g.startWorld.y;
        commit((cur) => ({
          ...cur,
          nodes: cur.nodes.map((n) => {
            if (n.refId !== g.id) return n;
            let w = Math.max(80, g.startW + dx);
            let h = Math.max(80, g.startH + dy);
            if (e.shiftKey) h = w / g.ratio;
            return { ...n, w, h };
          }),
        }));
        return;
      }
      if (g.kind === "rotate") {
        const current = angleDeg(g.center.x, g.center.y, world.x, world.y);
        let rotation = g.startRotation + (current - g.startAngle);
        if (e.shiftKey) rotation = snapRotation(rotation);
        commit((cur) => ({ ...cur, nodes: cur.nodes.map((n) => (n.refId === g.id ? { ...n, rotation } : n)) }));
        return;
      }
      if (g.kind === "notemove") {
        const dx = world.x - g.startWorld.x;
        const dy = world.y - g.startWorld.y;
        commit((cur) => ({
          ...cur,
          notes: (cur.notes ?? []).map((n) => (n.id === g.id ? { ...n, x: snapToGrid(g.startX + dx), y: snapToGrid(g.startY + dy) } : n)),
        }));
      }
    };
    const onUp = () => {
      const g = gestureRef.current;
      gestureRef.current = null;
      setGestureActive(false);
      setGuides([]);
      if (g?.kind === "marquee") {
        const rect = marqueeRef.current;
        setMarquee(null);
        if (rect && (rect.w > 2 || rect.h > 2)) {
          const hits = nodesInRect(liveRef.current.nodes.filter((n) => !n.hidden), rect).map((n) => n.refId);
          setSelection((prev) => (g.add ? new Set([...prev, ...hits]) : new Set(hits)));
        }
      }
      // Re-home dragged refs: Alt-drag removes them from their frame; a normal
      // drop into a frame joins it (a drop outside leaves membership alone).
      if (g?.kind === "move" && g.settle && g.moved) {
        commit((cur) => settleFrameMembership(cur, g.ids, g.alt));
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [gestureActive, commit, localPoint]);

  // Keyboard shortcuts (Delete hides, [ ] z-order, Esc clears, ⌘0/⌘1 zoom).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "Escape") { setSelection(new Set()); setMenu(null); setFrameMenu(null); setViewer(null); setMarquee(null); setEditingNote(null); return; }
      if (typing) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectionRef.current.size) { e.preventDefault(); hideNodes([...selectionRef.current]); }
        return;
      }
      if (e.key === "]") { sendZ([...selectionRef.current], "front"); return; }
      if (e.key === "[") { sendZ([...selectionRef.current], "back"); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (e.shiftKey) ungroupSelection(); else groupSelection();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "0") { e.preventDefault(); fit(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "1") { e.preventDefault(); resetZoom(); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fit, groupSelection, hideNodes, resetZoom, sendZ, ungroupSelection]);

  // --- adds -----------------------------------------------------------------

  const placeNewRef = useCallback((id: string, world: { x: number; y: number }) => {
    commit((l) => {
      const existing = l.nodes.find((n) => n.refId === id);
      if (existing) {
        // Dropping an already-placed ref moves it here, un-hides it, and brings
        // it to the front so the drop is always visibly honoured.
        return {
          ...l,
          nodes: l.nodes.map((n) =>
            n.refId === id ? { ...n, hidden: false, x: world.x - n.w / 2, y: world.y - n.h / 2, z: nextZ(l.nodes) } : n,
          ),
        };
      }
      return {
        ...l,
        nodes: [...l.nodes, { refId: id, x: world.x - MB_DEFAULT_W / 2, y: world.y - MB_DEFAULT_H / 2, w: MB_DEFAULT_W, h: MB_DEFAULT_H, z: nextZ(l.nodes) }],
      };
    });
  }, [commit]);

  const handleAddReference = useCallback(async () => {
    const center = screenToWorld(liveRef.current.viewport, sizeRef.current.w / 2, sizeRef.current.h / 2);
    const id = await onAddReference();
    if (id) placeNewRef(id, center);
  }, [onAddReference, placeNewRef]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const p = localPoint(e);
    const world = screenToWorld(liveRef.current.viewport, p.sx, p.sy);
    const refId = e.dataTransfer.getData("application/x-cascade-reference");
    if (refId && refId !== "") {
      placeNewRef(refId, world);
      return;
    }
    if (!onAddFiles) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (!files.length) return;
    const ids = await onAddFiles(files);
    ids.forEach((id, i) => placeNewRef(id, { x: world.x + i * 24, y: world.y + i * 24 }));
  }, [localPoint, onAddFiles, placeNewRef]);

  /** Clicking a shelf tile drops that reference at the viewport center. */
  const addFromShelf = useCallback((id: string) => {
    const center = screenToWorld(liveRef.current.viewport, sizeRef.current.w / 2, sizeRef.current.h / 2);
    placeNewRef(id, center);
  }, [placeNewRef]);

  // --- render ---------------------------------------------------------------

  const hiddenCount = layout.nodes.filter((n) => n.hidden).length;
  const placed = useMemo(() => layout.nodes.filter((n) => !n.hidden), [layout.nodes]);
  const visible = useMemo(
    // Before the viewport is measured, render everything (one frame at most).
    () => (size.w > 0 ? visibleNodes(placed, layout.viewport, size.w, size.h) : placed),
    [placed, layout.viewport, size.w, size.h],
  );
  const notes = layout.notes ?? [];
  const background = layout.background ?? "dark";
  const showMinimap = placed.length > MINIMAP_THRESHOLD;
  const offBoard = useMemo(() => offBoardRefs(layout, refs), [layout, refs]);

  // Frames are drawn behind their members: a frame's z sits just under the
  // lowest member node's z (nodes keep their persisted z untouched). A frame
  // with every member hidden is skipped (and reappears via "Show all").
  const frames = layout.frames ?? [];
  const nodeZ = new Map(layout.nodes.map((n) => [n.refId, n.z]));
  const visibleRefIds = useMemo(() => new Set(placed.map((n) => n.refId)), [placed]);
  const frameViews = useMemo(
    () =>
      frames
        .map((frame) => ({ frame, members: frame.refIds.filter((r) => visibleRefIds.has(r)) }))
        .filter((v) => v.members.length > 0),
    [frames, visibleRefIds],
  );
  const frameZ = (frameIds: string[]): number => {
    let min = Infinity;
    for (const r of frameIds) {
      const z = nodeZ.get(r);
      if (z !== undefined && z < min) min = z;
    }
    return (min === Infinity ? 0 : min) - 1;
  };

  const transform = `translate(${layout.viewport.x}px, ${layout.viewport.y}px) scale(${layout.viewport.zoom})`;

  return (
    <div className="moodboard">
      <MoodboardToolbar
        count={refs.length}
        hiddenCount={hiddenCount}
        categories={categories}
        activeCategory={activeCategory}
        background={background}
        zoom={layout.viewport.zoom}
        hasSelection={selection.size > 0}
        onFilter={setActiveCategory}
        onBackground={(b) => commit((l) => ({ ...l, background: b }))}
        onFit={fit}
        onReset={resetZoom}
        onZoom={zoomStep}
        onArrange={arrangeSelected}
        onGroup={groupSelection}
        onUngroup={ungroupSelection}
        onAddReference={() => void handleAddReference()}
        onRemoveSelected={() => hideNodes([...selection])}
        onShowAll={showAll}
      />
      <div className="moodboard-main">
      <MoodboardShelf
        prodId={prodId}
        refs={offBoard}
        onAdd={addFromShelf}
        onZoom={setViewer}
      />
      <div
        ref={canvasRef}
        className={"moodboard-canvas moodboard-bg-" + background + (spaceRef.current ? " panning" : "")}
        onPointerDown={onCanvasPointerDown}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes("application/x-cascade-reference")) e.preventDefault(); }}
        onDrop={(e) => void handleDrop(e)}
        onContextMenu={(e) => {
          if (suppressContextRef.current) { e.preventDefault(); e.stopPropagation(); return; }
          if (e.target === e.currentTarget) e.preventDefault();
        }}
      >
        <div className="moodboard-content" style={{ transform }}>
          {frameViews.map(({ frame, members }) => (
            <MoodboardFrameView
              key={frame.id}
              frame={frame}
              memberCount={members.length}
              selected={members.some((r) => selection.has(r))}
              z={frameZ(members)}
              onStartMove={beginFrameMove}
              onStartResize={beginFrameResize}
              onLabel={setFrameLabelById}
              onColor={setFrameColorById}
              onUngroup={removeFrameById}
              onContextMenu={(e, frameId) => {
                if (suppressContextRef.current) { e.preventDefault(); e.stopPropagation(); return; }
                e.preventDefault();
                e.stopPropagation();
                setMenu(null);
                const p = localPoint(e);
                setFrameMenu({ x: p.sx, y: p.sy, frameId });
              }}
            />
          ))}
          {visible.map((n) => {
            const r = refById.get(n.refId);
            if (!r) return null;
            return (
              <MoodboardNode
                key={n.refId}
                prodId={prodId}
                refItem={r}
                node={n}
                selected={selection.has(n.refId)}
                dimmed={activeCategory !== null && (r.categoryId ?? null) !== activeCategory}
                onGestureStart={beginMove}
                onResizeStart={beginResize}
                onRotateStart={beginRotate}
                onRemoveFromBoard={(id) => hideNodes([id])}
                onAttach={onAttach}
                onRename={onRename}
                onOpenViewer={setViewer}
                onContextMenu={(e, id) => {
                  if (suppressContextRef.current) { e.preventDefault(); e.stopPropagation(); return; }
                  e.preventDefault();
                  setFrameMenu(null);
                  const p = localPoint(e);
                  setMenu({ x: p.sx, y: p.sy, refId: id });
                }}
              />
            );
          })}
          {notes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              editing={editingNote === note.id}
              onStartMove={beginNoteMove}
              onStartEdit={setEditingNote}
              onCommit={commitNote}
              onDelete={deleteNote}
            />
          ))}
          {guides.map((g, i) => (
            <span
              key={`${g.axis}-${i}`}
              className={"moodboard-guide moodboard-guide-" + g.axis}
              style={g.axis === "x" ? { left: g.world } : { top: g.world }}
            />
          ))}
          {marquee && (
            <span className="moodboard-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
          )}
        </div>

        {refs.length === 0 && (
          <div className="moodboard-empty">
            <div className="suite-empty-card">
              <h2>No references yet</h2>
              <p>Add character, product, or mood references in Step 2, then arrange them here like a PureRef board.</p>
              <button className="prod-btn" onClick={() => void handleAddReference()}><PlusIcon size={13} /> Add reference</button>
            </div>
          </div>
        )}

        {showMinimap && (
          <MoodboardMinimap
            nodes={placed}
            viewport={layout.viewport}
            viewW={size.w}
            viewH={size.h}
            onCenter={(wx, wy) => commit((l) => ({ ...l, viewport: { ...l.viewport, x: sizeRef.current.w / 2 - wx * l.viewport.zoom, y: sizeRef.current.h / 2 - wy * l.viewport.zoom } }))}
          />
        )}

        {menu && (
          <div className="moodboard-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => { sendZ([menu.refId], "front"); setMenu(null); }}>Bring to front</button>
            <button onClick={() => { sendZ([menu.refId], "back"); setMenu(null); }}>Send to back</button>
            <button className="danger" onClick={() => { hideNodes([menu.refId]); setMenu(null); }}>Remove from board</button>
          </div>
        )}

        {frameMenu && (
          <div className="moodboard-menu" style={{ left: frameMenu.x, top: frameMenu.y }} onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => { removeFrameById(frameMenu.frameId); setFrameMenu(null); }}>Ungroup frame</button>
          </div>
        )}
      </div>
      </div>

      {viewer && createPortal(
        <div className="prod-ref-lightbox" onClick={() => setViewer(null)}>
          <figure className="prod-ref-lightbox-card">
            {viewer.media === "video" && viewer.mediaPath ? (
              <video className="prod-ref-lightbox-video" src={cascadeMedia(prodId, viewer.mediaPath)} controls autoPlay loop playsInline />
            ) : (
              <img src={viewer.imagePath ? cascadeMedia(prodId, viewer.imagePath) : viewer.artwork} alt={viewer.name} />
            )}
            <figcaption>{viewer.name} — click anywhere to close</figcaption>
          </figure>
        </div>, document.body)}
    </div>
  );
}
