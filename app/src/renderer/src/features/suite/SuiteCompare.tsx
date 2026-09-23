/**
 * A/B compare for two suite frames: the two full-res outputs are stacked and a
 * draggable vertical divider wipes one over the other. Both stream over
 * `cascade-media://` (no base64 payloads). The divider, the whole stage, and
 * the range slider below all move the same `split` state.
 */
import { useCallback, useRef, useState } from "react";
import type { SuiteFrame } from "./suite-compare.js";

export function SuiteCompare({
  a,
  b,
  onFrameContextMenu,
}: {
  a: SuiteFrame;
  b: SuiteFrame;
  /** Right-click either side (the left half is A, the right half B). */
  onFrameContextMenu?: (frame: SuiteFrame, e: React.MouseEvent) => void;
}) {
  const [split, setSplit] = useState(50);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const setFromClientX = useCallback((clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setSplit(Math.max(0, Math.min(100, pct)));
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setFromClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
    setFromClientX(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <div className="suite-compare">
      <div
        ref={stageRef}
        className="suite-compare-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title="Drag the line to wipe between the two versions"
      >
        <img
          className="suite-compare-img"
          src={b.url}
          alt={b.label}
          draggable={false}
          title={`Right-click for save, copy, edit, or folder options (${b.label})`}
          onContextMenu={onFrameContextMenu ? (e) => onFrameContextMenu(b, e) : undefined}
        />
        <div className="suite-compare-top" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
          <img
            className="suite-compare-img"
            src={a.url}
            alt={a.label}
            draggable={false}
            title={`Right-click for save, copy, edit, or folder options (${a.label})`}
            onContextMenu={onFrameContextMenu ? (e) => onFrameContextMenu(a, e) : undefined}
          />
        </div>
        <div className="suite-compare-divider" style={{ left: `${split}%` }} aria-hidden="true">
          <span className="suite-compare-grip">⇔</span>
        </div>
        <span className="suite-compare-tag left">{a.label}</span>
        <span className="suite-compare-tag right">{b.label}</span>
      </div>
      <label className="suite-compare-slider">
        Wipe
        <input type="range" min={0} max={100} value={Math.round(split)} onChange={(e) => setSplit(Number(e.target.value))} />
      </label>
    </div>
  );
}
