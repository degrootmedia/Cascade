import { useEffect, useRef, useState } from "react";
import type { ModelInfo } from "../../../shared/ipc.js";

/** Gab-style cost badge: gray token icon + exact credit cost (credit_cost.base_cost). */
function TokenIcon() {
  return (
    <svg className="token-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2.75" fill="currentColor" />
    </svg>
  );
}

/** Clean line-art "image input" indicator (replaces the 📷 emoji). */
function VisionIcon() {
  return (
    <svg
      className="vision-icon"
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <circle cx="5.6" cy="6.4" r="1.2" />
      <path d="M2.5 11.5l3.2-3.2 2.4 2.4 3-3 2.4 2.4" />
    </svg>
  );
}

function CostBadge({ baseCost }: { baseCost: number }) {
  return (
    <span className="cost-badge" title={`${baseCost} credits per message`}>
      <TokenIcon />
      {baseCost}
    </span>
  );
}

export function ModelPicker({
  models,
  current,
  disabled,
  onChange,
}: {
  models: ModelInfo[];
  current: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const currentInfo = models.find((m) => m.id === current);
  const sorted = [...models].sort((a, b) => a.baseCost - b.baseCost || a.id.localeCompare(b.id));

  return (
    <div className="model-picker" ref={ref}>
      <button className="model-button" disabled={disabled} onClick={() => setOpen(!open)} title="Choose model">
        <span className="model-current">{current}</span>
        {currentInfo && <CostBadge baseCost={currentInfo.baseCost} />}
        <span className="model-caret">▴</span>
      </button>
      {open && (
        <div className="model-menu">
          {sorted.map((m) => (
            <button
              key={m.id}
              className={`model-option${m.id === current ? " selected" : ""}`}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className="model-name">{m.id}</span>
              {m.vision && (
                <span className="model-vision" title="Supports image input">
                  <VisionIcon />
                </span>
              )}
              <CostBadge baseCost={m.baseCost} />
            </button>
          ))}
          {sorted.length === 0 && <div className="model-empty">Add your API key to load models</div>}
        </div>
      )}
    </div>
  );
}
