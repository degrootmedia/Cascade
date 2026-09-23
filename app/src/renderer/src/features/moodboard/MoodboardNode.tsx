/**
 * One reference on the moodboard canvas: the shared `<RefFigure variant="node">`
 * (same `ref-*` visuals as the sidebar) wrapped in an absolutely-positioned,
 * draggable/resizable/rotatable box. All interaction state lives in the canvas;
 * this component only reports gesture starts and forwards ref actions.
 */
import { memo, type CSSProperties, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { CustomRef, MoodboardNodeLayout } from "../../../../shared/ipc.js";
import { RefFigure } from "../../components/production/references.js";

/** The wrapper never starts a drag from an interactive control. */
function isInteractive(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest("input, button, textarea, a, select");
}

export const MoodboardNode = memo(function MoodboardNode({
  prodId,
  refItem,
  node,
  selected,
  dimmed,
  onGestureStart,
  onResizeStart,
  onRotateStart,
  onRemoveFromBoard,
  onAttach,
  onRename,
  onOpenViewer,
  onContextMenu,
}: {
  prodId: string;
  refItem: CustomRef;
  node: MoodboardNodeLayout;
  selected: boolean;
  /** A filter excludes this node: dim it, never hide it (layout is preserved). */
  dimmed: boolean;
  onGestureStart: (e: ReactPointerEvent, id: string) => void;
  onResizeStart: (e: ReactPointerEvent, id: string) => void;
  onRotateStart: (e: ReactPointerEvent, id: string) => void;
  onRemoveFromBoard: (id: string) => void;
  onAttach: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onOpenViewer: (ref: CustomRef) => void;
  onContextMenu: (e: ReactMouseEvent, id: string) => void;
}) {
  const style: CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.w,
    height: node.h,
    zIndex: node.z,
    ...(node.rotation ? { transform: `rotate(${node.rotation}deg)` } : {}),
  };
  const handlePointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || isInteractive(e.target)) return;
    onGestureStart(e, node.refId);
  };
  const handleDoubleClick = (e: ReactMouseEvent) => {
    if (isInteractive(e.target)) return;
    onOpenViewer(refItem);
  };
  const stop = (e: ReactPointerEvent) => e.stopPropagation();
  return (
    <div
      className={"moodboard-node" + (selected ? " selected" : "") + (dimmed ? " dimmed" : "")}
      style={style}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => onContextMenu(e, node.refId)}
    >
      <RefFigure
        variant="node"
        prodId={prodId}
        refItem={refItem}
        onAttach={onAttach}
        onRemove={onRemoveFromBoard}
        onRename={onRename}
        onReorder={() => {}}
      />
      <span className="moodboard-node-rotate" title="Drag to rotate (Shift snaps to 15°)" onPointerDown={(e) => { stop(e); onRotateStart(e, node.refId); }} />
      <span className="moodboard-node-resize" title="Drag to resize" onPointerDown={(e) => { stop(e); onResizeStart(e, node.refId); }} />
    </div>
  );
}, (prev, next) =>
  prev.prodId === next.prodId &&
  prev.refItem === next.refItem &&
  prev.node === next.node &&
  prev.selected === next.selected &&
  prev.dimmed === next.dimmed);
