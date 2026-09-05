import { useEffect, useRef, useState } from "react";
import type { ModelInfo } from "../../../shared/ipc.js";
import { ImageIcon, TokenIcon } from "./icons.js";

/** Clean line-art "image input" indicator (replaces the 📷 emoji). */
function VisionIcon() {
  return <ImageIcon size={13} />;
}

function CostBadge({ info }: { info: ModelInfo }) {
  const isUsd = info.costLabel.startsWith("$");
  return (
    <span className="cost-badge" title={info.costTitle}>
      {!isUsd && <TokenIcon size={13} />}
      {info.costLabel}
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
        {currentInfo && <CostBadge info={currentInfo} />}
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
              <CostBadge info={m} />
            </button>
          ))}
          {sorted.length === 0 && <div className="model-empty">Add your API key to load models</div>}
        </div>
      )}
    </div>
  );
}
