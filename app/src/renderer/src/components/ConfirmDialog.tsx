import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The one destructive-action confirmation for the whole renderer. Call
 * `confirmDestructive(...)` from anywhere; the `<ConfirmHost />` mounted
 * once in App renders it. Promise-based, one dialog at a time (later calls
 * queue), Escape/backdrop cancels, and Cancel takes initial focus so the
 * safe action is the default. Without a mounted host it resolves `false`
 * (never destructive on a guess).
 */
export interface ConfirmDestructiveOptions {
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
}

interface PendingConfirm extends ConfirmDestructiveOptions {
  resolve: (ok: boolean) => void;
}

let hostQueue: PendingConfirm[] = [];
let hostWake: (() => void) | null = null;

export function confirmDestructive(opts: ConfirmDestructiveOptions): Promise<boolean> {
  if (!hostWake) return Promise.resolve(false);
  return new Promise((resolve) => {
    hostQueue.push({ ...opts, resolve });
    hostWake?.();
  });
}

export function ConfirmHost() {
  const [current, setCurrent] = useState<PendingConfirm | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const pump = () => setCurrent((c) => c ?? hostQueue.shift() ?? null);
    hostWake = pump;
    pump();
    return () => {
      if (hostWake === pump) hostWake = null;
    };
  }, []);

  useEffect(() => {
    if (current) cancelRef.current?.focus();
  }, [current]);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        current.resolve(false);
        setCurrent(hostQueue.shift() ?? null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [current]);

  if (!current) return null;

  const settle = (ok: boolean) => {
    current.resolve(ok);
    setCurrent(hostQueue.shift() ?? null);
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settle(false);
      }}
    >
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={current.title}>
        <h3>{current.title}</h3>
        {current.body && <p>{current.body}</p>}
        <div className="modal-actions">
          <button ref={cancelRef} onClick={() => settle(false)}>
            {current.cancelLabel ?? "Cancel"}
          </button>
          <button className="danger" onClick={() => settle(true)}>
            {current.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
