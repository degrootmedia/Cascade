import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The one name-entry prompt for the renderer, mirroring ConfirmDialog: call
 * `askName(...)` from anywhere; the `<NamePromptHost />` mounted once in App
 * renders it. Promise-based, one dialog at a time (later calls queue),
 * Escape/backdrop cancels (resolves null), Enter confirms. Without a
 * mounted host it resolves null (never invents a name on a guess).
 */
export interface AskNameOptions {
  title: string;
  initial: string;
  label?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Inline validation: return an error message, or null when acceptable. */
  validate?: (value: string) => string | null;
}

interface PendingName extends AskNameOptions {
  resolve: (name: string | null) => void;
}

let hostQueue: PendingName[] = [];
let hostWake: (() => void) | null = null;

export function askName(opts: AskNameOptions): Promise<string | null> {
  if (!hostWake) return Promise.resolve(null);
  return new Promise((resolve) => {
    hostQueue.push({ ...opts, resolve });
    hostWake?.();
  });
}

export function NamePromptHost() {
  const [current, setCurrent] = useState<PendingName | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const pump = () => setCurrent((c) => c ?? hostQueue.shift() ?? null);
    hostWake = pump;
    pump();
    return () => {
      if (hostWake === pump) hostWake = null;
    };
  }, []);

  useEffect(() => {
    if (current) {
      setValue(current.initial);
      setError(null);
      // Focus + select the suggestion so typing replaces it wholesale.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [current]);

  if (!current) return null;

  const settle = (name: string | null) => {
    current.resolve(name);
    setCurrent(hostQueue.shift() ?? null);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const err = current.validate?.(value) ?? null;
    if (err) { setError(err); return; }
    settle(value);
  };

  return createPortal(
    <div
      className="modal-backdrop confirm-layer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settle(null);
      }}
    >
      <form className="modal" role="dialog" aria-modal="true" aria-label={current.title} onSubmit={submit}>
        <h3>{current.title}</h3>
        {current.label && <p>{current.label}</p>}
        <input
          ref={inputRef}
          className="name-prompt-input"
          type="text"
          value={value}
          onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => { if (e.key === "Escape") settle(null); }}
          aria-label={current.title}
        />
        {error && <p className="name-prompt-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={() => settle(null)}>
            {current.cancelLabel ?? "Cancel"}
          </button>
          <button type="submit" className="primary">
            {current.confirmLabel ?? "Save"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
