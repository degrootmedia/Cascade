/**
 * Waypoint edge: a connection rendered as straight segments through its
 * bend points (waypoints). Waypoints are layout-only data (stored per edge
 * id in the shot's canvas layout) — never graph nodes, never selectable as
 * nodes, and invisible to classic view and pipe resolution.
 *
 * Interactions (all through WaypointContext, supplied by the canvas):
 * - Click (press + release within a few px) on the line adds a waypoint at
 *   the click point, inserted on the nearest segment.
 * - Dragging a waypoint moves it (committed on release).
 * - Clicking/dragging a waypoint selects it; Delete (or double-click)
 *   deletes it.
 * Only dragging from a port starts a connection — waypoint dots carry
 * `nodrag` and swallow their pointerdown, so a waypoint drag never becomes
 * a connection drag or a canvas pan.
 */
import { createContext, useContext, useRef } from "react";
import { BaseEdge, useReactFlow, type EdgeProps } from "@xyflow/react";

export interface WaypointHandlers {
  add: (edgeId: string, pos: { x: number; y: number }, index: number) => void;
  move: (edgeId: string, index: number, pos: { x: number; y: number }) => void;
  remove: (edgeId: string, index: number) => void;
  /** Select a waypoint (click/drag start) so Delete can remove it; the
   *  canvas clears its node/edge selection in exchange, so one Delete
   *  keypress can never also delete a node. */
  select: (edgeId: string, index: number) => void;
  selected: { edgeId: string; index: number } | null;
  /** Live (uncommitted) drag, shared so every wire through a shared point redraws. */
  live?: { edgeId: string; index: number; id?: string; pos: { x: number; y: number } } | null;
  /** Wire rendering style; absent = curved. */
  wireStyle?: "curved" | "straight";
  setLive?: (v: { edgeId: string; index: number; id?: string; pos: { x: number; y: number } } | null) => void;
}

export const WaypointContext = createContext<WaypointHandlers | null>(null);

const CLICK_TOLERANCE_PX = 4;

function distToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/**
 * Where a new waypoint at `pos` belongs in the waypoint list: the index of
 * the nearest segment's start among the full point list
 * `[source, ...waypoints, target]` — inserting there keeps the polyline
 * order along the line.
 */
export function waypointInsertIndex(
  points: { x: number; y: number }[],
  pos: { x: number; y: number }
): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const d = distToSegment(pos, points[i], points[i + 1]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** SVG path through the points: straight segments or Bezier (horizontal tangents). */
export function wirePath(full: { x: number; y: number }[], style: "curved" | "straight" = "curved"): string {
  if (style === "straight") return full.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  let d = `M${full[0].x},${full[0].y}`;
  for (let i = 1; i < full.length; i++) {
    const a = full[i - 1], b = full[i];
    const k = Math.max(Math.abs(b.x - a.x) / 2, 20);
    d += ` C${a.x + k},${a.y} ${b.x - k},${b.y} ${b.x},${b.y}`;
  }
  return d;
}

export function WaypointEdge({ id, sourceX, sourceY, targetX, targetY, style, markerEnd, data }: EdgeProps) {
  const handlers = useContext(WaypointContext);
  const { screenToFlowPosition } = useReactFlow();
  const stored = (data?.waypoints as { x: number; y: number; id?: string }[] | undefined) ?? [];
  const downAt = useRef<{ x: number; y: number } | null>(null);

  const live = handlers?.live;
  const pts = stored.map((p, i) => (live && (live.id ? p.id === live.id : live.edgeId === id && live.index === i) ? live.pos : p));
  const full = [{ x: sourceX, y: sourceY }, ...pts, { x: targetX, y: targetY }];
  const path = wirePath(full, handlers?.wireStyle);

  const onLinePointerDown = (e: React.PointerEvent) => {
    downAt.current = { x: e.clientX, y: e.clientY };
  };
  const onLineClick = (e: React.MouseEvent) => {
    if (!handlers) return;
    const down = downAt.current;
    downAt.current = null;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_TOLERANCE_PX) return;
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    handlers.add(id, pos, waypointInsertIndex(full, pos));
  };
  const startWaypointDrag = (index: number) => (e: React.PointerEvent) => {
    if (!handlers) return;
    e.preventDefault();
    e.stopPropagation();
    handlers.select(id, index);
    const move = (ev: PointerEvent) => {
      handlers.setLive?.({ edgeId: id, index, id: stored[index]?.id, pos: screenToFlowPosition({ x: ev.clientX, y: ev.clientY }) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const pos = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      handlers.setLive?.(null);
      handlers.move(id, index, pos);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={16} />
      <path d={path} className="prod-waypoint-hit" onPointerDown={onLinePointerDown} onClick={onLineClick} />
      {pts.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={5.5}
          className={"prod-waypoint-dot nodrag" + (handlers?.selected?.edgeId === id && handlers.selected.index === i ? " selected" : "")}
          onPointerDown={startWaypointDrag(i)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            handlers?.remove(id, i);
          }}
        >
          <title>Drag to move · select + Delete, or double-click, to delete</title>
        </circle>
      ))}
    </>
  );
}
