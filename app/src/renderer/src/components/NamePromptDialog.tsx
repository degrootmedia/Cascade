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
 *
 * The reference-save variant accepts an async `onConfirm` commit: the
 * dialog then stays OPEN with a busy Save while the commit runs, an error
 * returned (or thrown) keeps it open with an inline message so the user can
 * retry, and it resolves + closes only once the commit reports success.
 * While busy, cancel/backdrop/Escape/double-submit are all inert — a
 * commit in flight is never silently dismissed or run twice.
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
  /**
   * Async commit run while the dialog stays open (busy Save, dismissal
   * blocked). Return an error message to keep the dialog open for retry,
   * or null on success (dialog resolves with the choice and closes).
   * Throwing is treated as returning the thrown message.
   */
  onConfirm?: (choice: ReferenceSaveChoice) => Promise<string | null>;
  /** Save button label while `onConfirm` runs. Defaults to "Saving…". */
  busyLabel?: string;
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
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Synchronous mirrors for the settle guards: state alone can't stop a
  // double-submit dispatched before the busy render lands.
  const busyRef = useRef(false);
  const settledRef = useRef<Pending | null>(null);

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
      setBusy(false);
      busyRef.current = false;
      if (settledRef.current !== current) settledRef.current = null;
      // Focus + select the suggestion so typing replaces it wholesale.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [current]);

  if (!current) return null;

  /** Resolve `pending` exactly once and advance to the next queued dialog. */
  const settle = (pending: Pending, result: string | ReferenceSaveChoice | null) => {
    if (settledRef.current === pending) return;
    settledRef.current = pending;
    if (pending.kind === "name") pending.resolve(result as string | null);
    else pending.resolve(result as ReferenceSaveChoice | null);
    busyRef.current = false;
    setBusy(false);
    setCurrent(hostQueue.shift() ?? null);
  };
  const settleNull = () => {
    if (busyRef.current) return; // a commit in flight is never dismissed
    settle(current, null);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busyRef.current || settledRef.current === current) return;
    if (current.kind === "name") {
      const err = current.validate?.(value) ?? null;
      if (err) { setError(err); return; }
      settle(current, value);
      return;
    }
    const err = referenceNameError(value);
    if (err) { setError(err); return; }
    const choice: ReferenceSaveChoice = { name: value.trim(), categoryId: categoryId || undefined };
    if (!current.onConfirm) {
      settle(current, choice);
      return;
    }
    // Commit inside the dialog: busy until it reports success (settle) or
    // failure (inline error, dialog retained for retry).
    const pending = current;
    const commit = current.onConfirm;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    void (async () => {
      let failure: string | null;
      try {
        failure = await commit(choice);
      } catch (commitErr) {
        failure = String(commitErr).replace(/^Error:\s*/, "");
      }
      if (failure) {
        busyRef.current = false;
        setBusy(false);
        setError(failure);
        return;
      }
      settle(pending, choice);
    })();
  };

  return createPortal(
    <div
      className="modal-backdrop confirm-layer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settleNull();
      }}
    >
      <form className="modal" role="dialog" aria-modal="true" aria-label={current.title} aria-busy={busy} onSubmit={submit}>
        <h3>{current.title}</h3>
        {current.label && <p>{current.label}</p>}
        <input
          ref={inputRef}
          className="name-prompt-input"
          type="text"
          value={value}
          disabled={busy}
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
              disabled={busy}
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
          <button type="button" disabled={busy} onClick={settleNull}>
            {current.cancelLabel ?? "Cancel"}
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? (current.kind === "referenceSave" ? current.busyLabel ?? "Saving…" : "Saving…") : current.confirmLabel ?? "Save"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
