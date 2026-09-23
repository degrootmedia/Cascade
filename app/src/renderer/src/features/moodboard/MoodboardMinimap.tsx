/**
 * Orientation minimap for large boards (rendered once a board has enough nodes
 * that panning alone stops being enough). Maps world content into a small box
 * and draws the current viewport rectangle; dragging the box (or clicking
 * anywhere on the map) recenters the view live as the pointer moves.
 */
import { useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { MoodboardNodeLayout } from "../../../../shared/ipc.js";
import { contentBounds, screenToWorld, type MoodboardViewport } from "./moodboard-layout.js";

const MAP_W = 180;
const MAP_H = 120;
const PAD = 6;

export function MoodboardMinimap({
  nodes,
  viewport,
  viewW,
  viewH,
  onCenter,
}: {
  nodes: MoodboardNodeLayout[];
  viewport: MoodboardViewport;
  viewW: number;
  viewH: number;
  onCenter: (worldX: number, worldY: number) => void;
}) {
  const bounds = useMemo(() => contentBounds(nodes), [nodes]);
  const scale = bounds && bounds.w > 0 && bounds.h > 0
    ? Math.min((MAP_W - PAD * 2) / bounds.w, (MAP_H - PAD * 2) / bounds.h)
    : 1;
  const draggingRef = useRef(false);

  const centerAt = useCallback((clientX: number, clientY: number, el: HTMLDivElement) => {
    if (!bounds) return;
    const rect = el.getBoundingClientRect();
    const wx = (clientX - rect.left - PAD) / scale + bounds.x;
    const wy = (clientY - rect.top - PAD) / scale + bounds.y;
    onCenter(wx, wy);
  }, [bounds, scale, onCenter]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    centerAt(e.clientX, e.clientY, e.currentTarget);
  }, [centerAt]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    e.stopPropagation();
    centerAt(e.clientX, e.clientY, e.currentTarget);
  }, [centerAt]);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }, []);

  if (!bounds || bounds.w <= 0 || bounds.h <= 0) return null;
  const tx = (wx: number) => (wx - bounds.x) * scale + PAD;
  const ty = (wy: number) => (wy - bounds.y) * scale + PAD;
  const tl = screenToWorld(viewport, 0, 0);
  const br = screenToWorld(viewport, viewW, viewH);
  const viewRect = {
    left: tx(tl.x),
    top: ty(tl.y),
    width: Math.max(2, (br.x - tl.x) * scale),
    height: Math.max(2, (br.y - tl.y) * scale),
  };
  return (
    <div
      className="moodboard-minimap"
      title="Drag to move the board"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {nodes.map((n) => (
        <span
          key={n.refId}
          className="moodboard-minimap-node"
          style={{ left: tx(n.x), top: ty(n.y), width: Math.max(1, n.w * scale), height: Math.max(1, n.h * scale) }}
        />
      ))}
      <span className="moodboard-minimap-view" style={viewRect} />
    </div>
  );
}
