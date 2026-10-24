import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { referenceNameError } from "../../../shared/ref-names.js";

/**
 * The one name-entry prompt for the renderer, mirroring ConfirmDialog: call
 * `askName(...)` (or `askReferenceSave(...)` for the name + category variant)
 * from anywhere; the `<NamePromptHost />` mounted once in App renders it.
 * Promise-based, one dialog at a time (later calls queue),
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

export interface AskReferenceSaveOptions {
  title: string;
  initialName: string;
  /** The production's reference categories; Uncategorized is always offered. */
  categories: { id: string; name: string }[];
  /** Pre-selected category (e.g. the panel a file was dropped on). */
  defaultCategoryId?: string;
  label?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ReferenceSaveChoice {
  name: string;
  /** Absent means uncategorized. */
  categoryId?: string;
}

type Pending =
  | ({ kind: "name" } & AskNameOptions & { resolve: (name: string | null) => void })
  | ({ kind: "referenceSave" } & AskReferenceSaveOptions & { resolve: (choice: ReferenceSaveChoice | null) => void });

let hostQueue: Pending[] = [];
let hostWake: (() => void) | null = null;

export function askName(opts: AskNameOptions): Promise<string | null> {
  if (!hostWake) return Promise.resolve(null);
  return new Promise((resolve) => {
    hostQueue.push({ kind: "name", ...opts, resolve });
    hostWake?.();
  });
}

/** Ask how a brand-new reference should be named and categorized. Resolves
 *  null on cancel — callers must create nothing in that case. */
export function askReferenceSave(opts: AskReferenceSaveOptions): Promise<ReferenceSaveChoice | null> {
  if (!hostWake) return Promise.resolve(null);
  return new Promise((resolve) => {
    hostQueue.push({ kind: "referenceSave", ...opts, resolve });
    hostWake?.();
  });
}

export function NamePromptHost() {
  const [current, setCurrent] = useState<Pending | null>(null);
  const [value, setValue] = useState("");
  const [categoryId, setCategoryId] = useState("");
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
      setValue(current.kind === "name" ? current.initial : current.initialName);
      setCategoryId(
        current.kind === "referenceSave" && current.defaultCategoryId && current.categories.some((c) => c.id === current.defaultCategoryId)
          ? current.defaultCategoryId
          : "",
      );
      setError(null);
      // Focus + select the suggestion so typing replaces it wholesale.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [current]);

  if (!current) return null;

  const settleNull = () => {
    current.resolve(null);
    setCurrent(hostQueue.shift() ?? null);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (current.kind === "name") {
      const err = current.validate?.(value) ?? null;
      if (err) { setError(err); return; }
      current.resolve(value);
    } else {
      const err = referenceNameError(value);
      if (err) { setError(err); return; }
      current.resolve({ name: value.trim(), categoryId: categoryId || undefined });
    }
    setCurrent(hostQueue.shift() ?? null);
  };

  return createPortal(
    <div
      className="modal-backdrop confirm-layer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settleNull();
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
          onKeyDown={(e) => { if (e.key === "Escape") settleNull(); }}
          aria-label={current.title}
        />
        {current.kind === "referenceSave" && (
          <>
            <label className="name-prompt-label" htmlFor="name-prompt-category">Category</label>
            <select
              id="name-prompt-category"
              className="name-prompt-input name-prompt-select"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") settleNull(); }}
              aria-label="Reference category"
            >
              <option value="">Uncategorized</option>
              {current.categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </>
        )}
        {error && <p className="name-prompt-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={settleNull}>
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
