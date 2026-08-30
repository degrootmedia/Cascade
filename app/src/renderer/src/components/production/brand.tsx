import { useEffect, useRef, useState } from "react";
import { hexToHsv, hsvToHex, isCompleteHex, normalizeHex, previewHex } from "./hex.js";

export function BrandSwatchRow({ index, value, onChange, onRemove }: {
  index: number;
  value: string;
  onChange: (hex: string) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Local edit draft so partial/untagged text can be typed freely; committed
  // to the production only once it forms a valid hex color.
  const [draft, setDraft] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const shown = draft ?? value;
  const chip = previewHex(shown) || previewHex(value);

  return (
    <div ref={rowRef} className="prod-brand-swatch" title={`Palette color ${index + 1} — pick or paste a hex value`}>
      <button
        type="button"
        className={"prod-brand-chip" + (chip ? "" : " empty")}
        style={chip ? { background: chip } : undefined}
        aria-label={`Palette color ${index + 1} picker`}
        onClick={() => setOpen((o) => !o)}
      />
      <input
        className="prod-brand-hex"
        value={shown}
        placeholder="#1A2B3C"
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          if (isCompleteHex(v)) onChange(normalizeHex(v));
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        aria-label={`Palette color ${index + 1} hex`}
      />
      <button className="prod-brand-remove" title="Remove this swatch" onClick={onRemove}>×</button>
      {open && (
        <BrandColorPicker
          value={value}
          onPick={(hex) => { onChange(hex); setDraft(null); }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * In-app color popover (matches the app's dark UI, unlike the native dialog):
 * a hex field (autofocused — hex is the default mode) above a saturation/
 * value square and hue slider. Drag commits on release; hex commits live.
 */

export function BrandColorPicker({ value, onPick, onClose }: {
  value: string;
  onPick: (hex: string) => void;
  onClose: () => void;
}) {
  const initial = hexToHsv(value) ?? { h: 210, s: 0.57, v: 0.24 };
  const [hsv, setHsv] = useState(initial);
  const squareRef = useRef<HTMLDivElement>(null);
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;
  const draggingRef = useRef(false);

  const hex = hsvToHex(hsv.h, hsv.s, hsv.v);
  const commit = () => onPick(hsvToHex(hsvRef.current.h, hsvRef.current.s, hsvRef.current.v));

  const setFromSquare = (clientX: number, clientY: number) => {
    const el = squareRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const v = 1 - Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    setHsv((p) => ({ ...p, s, v }));
  };

  return (
    <div className="prod-color-pop">
      <input
        className="prod-color-hex"
        autoFocus
        defaultValue={hsvToHex(initial.h, initial.s, initial.v)}
        placeholder="1A2B3C or #1A2B3C"
        spellCheck={false}
        onChange={(e) => {
          if (isCompleteHex(e.target.value)) {
            const next = hexToHsv(e.target.value);
            if (next) setHsv(next);
          }
        }}
        onBlur={(e) => {
          const t = e.target.value;
          if (isCompleteHex(t)) onPick(normalizeHex(t));
          e.target.value = isCompleteHex(t) ? normalizeHex(t) : hex; // snap back when incomplete
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && isCompleteHex((e.target as HTMLInputElement).value)) {
            onPick(normalizeHex((e.target as HTMLInputElement).value));
          }
        }}
        aria-label="Hex color"
      />
      <div
        ref={squareRef}
        className="prod-color-sv"
        style={{ background: `linear-gradient(to top, #000, rgba(0, 0, 0, 0)), linear-gradient(to right, #fff, hsl(${Math.round(hsv.h)} 100% 50%))` }}
        onPointerDown={(e) => {
          e.preventDefault();
          draggingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          setFromSquare(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => { if (draggingRef.current) setFromSquare(e.clientX, e.clientY); }}
        onPointerUp={() => { draggingRef.current = false; commit(); }}
        onPointerCancel={() => { draggingRef.current = false; }}
        role="presentation"
      >
        <span
          className="prod-color-cursor"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
        />
      </div>
      <input
        type="range"
        className="prod-color-hue"
        min={0}
        max={359}
        value={Math.round(hsv.h)}
        onChange={(e) => setHsv((p) => ({ ...p, h: Number(e.target.value) }))}
        onPointerUp={commit}
        onKeyUp={commit}
        aria-label="Hue"
      />
      <div className="prod-color-row">
        <span className="prod-color-chip" style={{ background: hex }} />
        <span className="prod-color-value">{hex}</span>
        <button type="button" className="prod-color-done" onClick={() => { commit(); onClose(); }}>
          Done
        </button>
      </div>
    </div>
  );
}

