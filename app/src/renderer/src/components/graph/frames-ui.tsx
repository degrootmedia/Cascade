/**
 * Frame UI: the expanded frame overlay (title bar, color picker, collapse,
 * deactivate, resize) and the collapsed group node. Layout-only; every
 * mutation goes through FrameContext handlers supplied by the canvas, which
 * save one undoable layout step each.
 */
import { createContext, memo, useContext, useEffect, useState } from "react";
import { Handle, Position, ViewportPortal, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import type { GraphFrame } from "../../../../shared/ipc.js";
import { FRAME_PALETTE, type FrameSocket } from "../../../../shared/graph/frames.js";

export interface FrameHandlers {
  rename: (id: string, name: string) => void;
  recolor: (id: string, color: string) => void;
  toggleCollapse: (id: string) => void;
  toggleDeactivate: (id: string) => void;
  ungroup: (id: string) => void;
  startMove: (id: string, e: React.PointerEvent) => void;
  startResize: (id: string, e: React.PointerEvent) => void;
  menu?: (id: string, e: React.MouseEvent) => void;
  readOnly: boolean;
}
export const FrameContext = createContext<FrameHandlers | null>(null);

export const GRAY = "#8a8f98";

function TitleControls({ frame }: { frame: GraphFrame }) {
  const h = useContext(FrameContext);
  const [editing, setEditing] = useState(false);
  const [palette, setPalette] = useState(false);
  if (!h) return null;
  const color = frame.deactivated ? GRAY : frame.color;
  return (
    <>
      {editing ? (
        <input
          className="prod-frame-name-input nodrag"
          autoFocus onFocus={(e) => e.target.select()}
          defaultValue={frame.name}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => { setEditing(false); if (e.target.value.trim() && e.target.value !== frame.name) h.rename(frame.id, e.target.value.trim()); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(false); e.stopPropagation(); }}
        />
      ) : (
        <span className="prod-frame-name" onDoubleClick={() => !h.readOnly && setEditing(true)} title="Double-click to rename">{frame.name}</span>
      )}
      {!h.readOnly && (
        <span className="prod-frame-actions nodrag" onPointerDown={(e) => e.stopPropagation()}>
          <button title="Rename" onClick={() => setEditing(true)}>✎</button>
          <span className="prod-frame-palette-wrap">
            <button title="Color" onClick={() => setPalette((v) => !v)} style={{ background: color }}>&nbsp;</button>
            {palette && (
              <span className="prod-frame-palette">
                {FRAME_PALETTE.map((c) => (
                  <button key={c} style={{ background: c }} title={c} onClick={() => { h.recolor(frame.id, c); setPalette(false); }} />
                ))}
                <input type="color" title="Custom color" value={/^#[0-9a-f]{6}$/i.test(frame.color) ? frame.color : "#4f8cff"} onChange={(e) => h.recolor(frame.id, e.target.value)} />
              </span>
            )}
          </span>
          <button title={frame.deactivated ? "Reactivate group" : "Deactivate group"} className={frame.deactivated ? "on" : ""} onClick={() => h.toggleDeactivate(frame.id)}>⏻</button>
          <button title={frame.collapsed ? "Expand group" : "Collapse into group node"} onClick={() => h.toggleCollapse(frame.id)} style={{ width: "auto", padding: "0 6px" }}>{frame.collapsed ? "Expand" : "Collapse"}</button>
          <button title="Ungroup" onClick={() => h.ungroup(frame.id)}>✕</button>
        </span>
      )}
    </>
  );
}

/** Overlay for every expanded frame (flow coordinates, via the viewport portal). */
export function FrameLayer({ frames, live }: { frames: GraphFrame[]; live: Record<string, Partial<GraphFrame>> }) {
  const h = useContext(FrameContext);
  return (
    <ViewportPortal>
      {frames.filter((f) => !f.collapsed).map((raw) => {
        const f = { ...raw, ...(live[raw.id] ?? {}) };
        const color = f.deactivated ? GRAY : f.color;
        return (
          <div
            key={f.id}
            className={"prod-frame" + (f.deactivated ? " deactivated" : "")}
            style={{ position: "absolute", transform: `translate(${f.x}px, ${f.y}px)`, width: f.width, height: f.height, borderColor: color, background: `${color}14`, pointerEvents: "none", zIndex: -1 }}
            data-frame-id={f.id}
          >
            <div className="prod-frame-title" style={{ background: color, pointerEvents: "auto" }} onContextMenu={(e) => { if (h?.menu) { e.preventDefault(); e.stopPropagation(); h.menu(f.id, e); } }} onPointerDown={(e) => { if (e.button !== 0 || (e.target as HTMLElement).closest(".nodrag")) return; h?.startMove(f.id, e); }}>
              <TitleControls frame={f} />
            </div>
            {!h?.readOnly && <div className="prod-frame-resize" style={{ pointerEvents: "auto" }} onPointerDown={(e) => h?.startResize(f.id, e)} />}
          </div>
        );
      })}
    </ViewportPortal>
  );
}

export interface GroupNodeData extends Record<string, unknown> {
  frame: GraphFrame;
  inputs: FrameSocket[];
  outputs: FrameSocket[];
}

export const GROUP_ROW_H = 22;
export const GROUP_HEAD_H = 34;

/** Node size for a collapsed group: wide/tall enough to show every socket label. */
export function groupNodeSize(inputs: FrameSocket[], outputs: FrameSocket[]): { width: number; height: number } {
  const longest = (l: FrameSocket[]) => l.reduce((m, s) => Math.max(m, s.label.length), 0);
  const width = Math.max(260, (longest(inputs) + longest(outputs)) * 6.6 + 70);
  return { width: Math.ceil(width), height: GROUP_HEAD_H + Math.max(inputs.length, outputs.length, 1) * GROUP_ROW_H + 10 };
}

/** Collapsed frame: name, color, and one labeled socket per boundary wire. */
export const GroupNodeView = memo(function GroupNodeView({ id, data }: NodeProps) {
  const { frame, inputs, outputs } = data as unknown as GroupNodeData;
  const color = frame.deactivated ? GRAY : frame.color;
  const size = groupNodeSize(inputs, outputs);
  const update = useUpdateNodeInternals();
  const sig = inputs.map((s) => s.edgeId).join(",") + "|" + outputs.map((s) => s.edgeId).join(",") + `|${size.width}x${size.height}`;
  // Handles change with the boundary wires: re-measure so wires attach.
  useEffect(() => { update(id); const t = window.setTimeout(() => update(id), 50); return () => window.clearTimeout(t); }, [id, sig, data, update]);
  const y = (i: number) => GROUP_HEAD_H + i * GROUP_ROW_H + GROUP_ROW_H / 2;
  return (
    <div className={"prod-group-node" + (frame.deactivated ? " deactivated" : "")} style={{ borderColor: color, width: size.width, height: size.height }}>
      <div className="prod-frame-title group-title" style={{ background: color }}>
        <TitleControls frame={frame} />
      </div>
      {inputs.map((s, i) => (
        <div key={`i-${s.edgeId}`}>
          <Handle type="target" position={Position.Left} id={`gin-${s.edgeId}`} style={{ top: y(i) }} />
          <span className="prod-group-label in" style={{ top: y(i) - 9 }} title={s.label}>{s.label}</span>
        </div>
      ))}
      {outputs.map((s, i) => (
        <div key={`o-${s.edgeId}`}>
          <Handle type="source" position={Position.Right} id={`gout-${s.edgeId}`} style={{ top: y(i) }} />
          <span className="prod-group-label out" style={{ top: y(i) - 9 }} title={s.label}>{s.label}</span>
        </div>
      ))}
    </div>
  );
});