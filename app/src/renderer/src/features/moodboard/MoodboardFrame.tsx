/**
 * One labeled, colored frame on the moodboard: a translucent region drawn
 * behind its member nodes, with a header bar carrying an editable label, a
 * color-palette button, and an ungroup button. Only the header and the resize
 * handle capture the pointer (the body is `pointer-events: none`) so marquee
 * selection still works across the board. All state lives in the canvas; this
 * component just renders the frame and forwards interactions.
 */
import { memo, useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { MoodboardFrame } from "../../../../shared/ipc.js";
import { XIcon } from "../../components/icons.js";
import { MOODBOARD_FRAME_COLORS, frameColorHex } from "./moodboard-layout.js";

export const MoodboardFrameView = memo(function MoodboardFrameView({
  frame,
  memberCount,
  selected,
  z,
  onStartMove,
  onStartResize,
  onLabel,
  onColor,
  onUngroup,
  onContextMenu,
}: {
  frame: MoodboardFrame;
  memberCount: number;
  /** A member node is selected: tint the frame outline. */
  selected: boolean;
  /** Stacking order (kept below every member node). */
  z: number;
  onStartMove: (e: ReactPointerEvent, id: string) => void;
  onStartResize: (e: ReactPointerEvent, id: string) => void;
  onLabel: (id: string, label: string) => void;
  onColor: (id: string, color: string) => void;
  onUngroup: (id: string) => void;
  onContextMenu: (e: ReactMouseEvent, id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(frame.label);
  const [palette, setPalette] = useState(false);
  useEffect(() => { if (editing) setDraft(frame.label); }, [editing, frame.label]);

  const hex = frameColorHex(frame.color);
  const style = {
    left: frame.x,
    top: frame.y,
    width: frame.w,
    height: frame.h,
    // While the palette is open, lift the whole frame above the member nodes so
    // the swatch popover (confined to the frame's stacking context) is clickable.
    zIndex: palette ? 1_000_000 : z,
    "--frame-color": hex,
  } as CSSProperties;
  const stop = (e: ReactPointerEvent) => e.stopPropagation();
  const commitLabel = () => { onLabel(frame.id, draft.trim()); setEditing(false); };

  return (
    <div className={"moodboard-frame" + (selected ? " selected" : "")} style={style}>
      <div
        className="moodboard-frame-head"
        onPointerDown={(e) => { if (e.button === 0) onStartMove(e, frame.id); }}
        onContextMenu={(e) => onContextMenu(e, frame.id)}
      >
        <button
          type="button"
          className="moodboard-frame-color"
          style={{ background: hex }}
          title="Frame color"
          aria-label="Frame color"
          onPointerDown={stop}
          onClick={() => setPalette((v) => !v)}
        />
        {editing ? (
          <input
            className="moodboard-frame-label-input"
            autoFocus
            value={draft}
            placeholder="Name this frame"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitLabel}
            onPointerDown={stop}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitLabel(); }
              else if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
            }}
          />
        ) : (
          <span
            className={"moodboard-frame-label" + (frame.label ? "" : " empty")}
            title="Double-click to rename"
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
          >
            {frame.label || "Untitled frame"}
            <span className="moodboard-frame-count">{memberCount}</span>
          </span>
        )}
        <button
          type="button"
          className="moodboard-frame-del"
          title="Ungroup frame (Ctrl+Shift+G)"
          aria-label="Ungroup"
          onPointerDown={stop}
          onClick={() => onUngroup(frame.id)}
        >
          <XIcon size={11} />
        </button>
        {palette && (
          <div className="moodboard-frame-palette" onPointerDown={stop}>
            {MOODBOARD_FRAME_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={"moodboard-frame-swatch" + (c.id === frame.color ? " active" : "")}
                style={{ background: c.hex }}
                title={c.label}
                aria-label={c.label}
                onClick={() => { onColor(frame.id, c.id); setPalette(false); }}
              />
            ))}
          </div>
        )}
      </div>
      <span
        className="moodboard-frame-resize"
        title="Resize frame"
        onPointerDown={(e) => { stop(e); onStartResize(e, frame.id); }}
      />
    </div>
  );
}, (a, b) =>
  a.frame === b.frame &&
  a.memberCount === b.memberCount &&
  a.selected === b.selected &&
  a.z === b.z);
