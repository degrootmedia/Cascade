/**
 * The Snippets shelf: the user's prompt-snippet library. Two homes share
 * one panel (`SnippetsPanel`):
 *  - Overlay: `SnippetsShelfHost` (the classic side panel and the Image
 *    Suite open it via `SnippetsButton`) — a portaled right-hand drawer.
 *  - Embedded: the node canvas's tabbed right shelf (its Snippets tab) —
 *    mounted there for as long as the canvas is open; inserting returns
 *    focus to the prompt field and the panel stays put.
 *
 * Click model (insert first, copy second):
 *  - Clicking a snippet inserts its body at the cursor of the most
 *    recently focused prompt field and returns focus there; the first
 *    [placeholder] in the body is selected for typing over.
 *  - With no prompt field to insert into, the same click copies the body
 *    to the clipboard and shows a toast — never a silent no-op.
 *  - The copy icon on each entry always copies.
 *
 * The overlay is portaled to <body>: inside the node graph it would
 * otherwise sit under React Flow's transformed viewport. Entry buttons
 * swallow mousedown so a live prompt selection survives the click.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  filterSnippets,
  groupSnippetsByCategory,
  snippetPreview,
  type PromptSnippet,
} from "../../../../shared/prompt-snippets.js";
import { EditIcon, PlusIcon, SearchIcon, TrashIcon, XIcon } from "../icons.js";
import {
  copyTextToClipboard,
  getActivePromptSelectionText,
  hasActivePromptField,
  insertIntoActivePromptField,
  installPromptFieldTracking,
} from "./prompt-field.js";
import {
  addSnippet,
  deleteSnippet,
  getSnippets,
  primePromptSnippets,
  snippetsVersion,
  subscribeSnippets,
  updateSnippet,
} from "./snippet-store.js";
import { onOpenSnippetsShelf, openSnippetsShelf } from "./snippets-ui.js";

/** Button that opens the overlay shelf. Rendered in the classic view's
 *  and the Image Suite's prompt chrome (the node canvas uses its shelf
 *  tab instead). */
export function SnippetsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className ?? "prod-btn snippets-open-btn"}
      title="Open the prompt snippets library"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => openSnippetsShelf()}
    >
      Snippets
    </button>
  );
}

/** Two-sheets glyph for "copy" (no bundled copy icon asset). */
function CopyGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v7A1.5 1.5 0 0 0 3.5 12H5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

interface FormState {
  /** Snippet id when editing; null when adding. */
  editingId: string | null;
  name: string;
  category: string;
  body: string;
}

const EMPTY_FORM: FormState = { editingId: null, name: "", category: "", body: "" };

/** An external "open with this body pre-filled" ask (Save selection as
 *  snippet). `nonce` makes repeat asks with the same body re-fire. */
export interface SnippetPrefillRequest {
  body: string;
  nonce: number;
}

/**
 * The snippet library panel: search, the grouped entries, the
 * add/edit/delete form, and the copy toast. `embedded` renders inline
 * (the node canvas's shelf tab — no backdrop, title, or close chrome);
 * otherwise it renders the portaled overlay drawer, shown only while
 * `visible` (the toast outlives a close, as before).
 */
export function SnippetsPanel({ embedded = false, visible = true, prefillRequest = null, onInserted, onClose }: {
  embedded?: boolean;
  visible?: boolean;
  prefillRequest?: SnippetPrefillRequest | null;
  /** Called after a successful insert (the overlay closes; the embedded
   *  panel passes nothing and stays put). */
  onInserted?: () => void;
  /** Overlay close (backdrop / X / Escape). Unused when embedded. */
  onClose?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const seenPrefillNonce = useRef<number | null>(null);
  const wasVisible = useRef(false);

  useSyncExternalStore(subscribeSnippets, snippetsVersion, snippetsVersion);
  const snippets = getSnippets();
  const visibleSnippets = filterSnippets(snippets, query);
  const groups = groupSnippetsByCategory(visibleSnippets);
  const categories = [...new Set(snippets.map((s) => s.category))];

  useEffect(() => {
    installPromptFieldTracking();
    void primePromptSnippets();
  }, []);

  // Save-selection asks routed here pre-fill the add form.
  useEffect(() => {
    if (!prefillRequest || prefillRequest.nonce === seenPrefillNonce.current) return;
    seenPrefillNonce.current = prefillRequest.nonce;
    setConfirmDeleteId(null);
    setForm({ ...EMPTY_FORM, body: prefillRequest.body });
  }, [prefillRequest]);

  // Becoming visible starts from a clean list state (no stale delete arm).
  useEffect(() => {
    if (visible && !wasVisible.current) setConfirmDeleteId(null);
    wasVisible.current = visible;
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (form) {
          e.stopPropagation();
          setForm(null);
        } else if (!embedded) {
          e.stopPropagation();
          onClose?.();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [visible, form, embedded, onClose]);

  useEffect(() => {
    if (!visible) return;
    if (!form) searchRef.current?.focus();
    if (form) nameRef.current?.focus();
  }, [visible, form]);

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }

  async function copySnippet(snippet: PromptSnippet, fallback: boolean) {
    const ok = await copyTextToClipboard(snippet.body);
    showToast(
      ok
        ? fallback
          ? `Copied “${snippet.name}” to clipboard — no prompt field was active`
          : `Copied “${snippet.name}” to clipboard`
        : `Could not copy “${snippet.name}”`,
    );
  }

  /** Primary click: insert at the tracked cursor, else copy + toast. */
  function useSnippet(snippet: PromptSnippet) {
    if (hasActivePromptField() && insertIntoActivePromptField(snippet.body)) {
      onInserted?.();
      return;
    }
    void copySnippet(snippet, true);
  }

  function startAdd(prefillBody = "") {
    setConfirmDeleteId(null);
    setForm({ ...EMPTY_FORM, body: prefillBody });
  }

  function startAddFromSelection() {
    const picked = getActivePromptSelectionText();
    if (picked) startAdd(picked);
  }

  function startEdit(snippet: PromptSnippet) {
    setConfirmDeleteId(null);
    setForm({ editingId: snippet.id, name: snippet.name, category: snippet.category, body: snippet.body });
  }

  function saveForm() {
    if (!form) return;
    const input = { name: form.name, category: form.category, body: form.body };
    if (!input.name.trim() || !input.body.trim()) return;
    if (form.editingId) {
      updateSnippet(form.editingId, input);
      showToast(`Saved “${input.name.trim()}”`);
    } else {
      addSnippet(input);
      showToast(`Added snippet “${input.name.trim()}”`);
    }
    setForm(null);
  }

  function removeSnippet(snippet: PromptSnippet) {
    deleteSnippet(snippet.id);
    setConfirmDeleteId(null);
    if (form?.editingId === snippet.id) setForm(null);
    showToast(`Deleted “${snippet.name}”`);
  }

  const selectionAvailable = visible && !form ? getActivePromptSelectionText().length > 0 : false;

  const toastEl = toast ? (
    <div className="snippets-toast" data-snippets-ui role="status">
      {toast}
    </div>
  ) : null;

  const body = (
    <>
      <div className="snippets-head">
        {!embedded && <span className="snippets-title">Snippets</span>}
        <span className="snippets-head-actions">
          {selectionAvailable && (
            <button type="button" className="prod-btn ghost snippets-small-btn" onClick={startAddFromSelection} title="Save the text selected in the prompt field as a new snippet">
              New from selection
            </button>
          )}
          <button type="button" className="prod-btn ghost snippets-small-btn" onClick={() => startAdd()} title="Add a new snippet">
            <PlusIcon size={13} /> New
          </button>
          {!embedded && (
            <button type="button" className="snippets-icon-btn" onClick={() => onClose?.()} title="Close snippets" aria-label="Close snippets">
              <XIcon size={14} />
            </button>
          )}
        </span>
      </div>

      <label className="snippets-search">
        <SearchIcon size={14} />
        <input
          ref={searchRef}
          type="text"
          value={query}
          placeholder="Search snippets…"
          aria-label="Search snippets"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {form ? (
        <div className="snippets-form">
          <div className="snippets-form-title">{form.editingId ? "Edit snippet" : "New snippet"}</div>
          <label className="snippets-field">
            <span>Name</span>
            <input ref={nameRef} type="text" value={form.name} placeholder="e.g. Geometry & camera lock" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="snippets-field">
            <span>Category</span>
            <input type="text" value={form.category} placeholder="e.g. Locks — geometry & pose" list="snippets-categories" onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <datalist id="snippets-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="snippets-field">
            <span>Body</span>
            <textarea rows={10} value={form.body} placeholder="Prompt text — [bracketed placeholders] get selected on insert" onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </label>
          <div className="snippets-form-actions">
            <button type="button" className="prod-btn ghost" onClick={() => setForm(null)}>Cancel</button>
            <button type="button" className="prod-btn" disabled={!form.name.trim() || !form.body.trim()} onClick={saveForm}>
              {form.editingId ? "Save changes" : "Add snippet"}
            </button>
          </div>
        </div>
      ) : (
        <div className="snippets-list">
          {groups.length === 0 && (
            <p className="hint snippets-empty">
              {snippets.length === 0 ? "No snippets yet. Add one with New." : "No snippets match your search."}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.category} className="snippets-group">
              <div className="snippets-category">{g.category}</div>
              {g.snippets.map((s) => (
                <div key={s.id} className="snippets-entry">
                  <button
                    type="button"
                    className="snippets-entry-main"
                    title="Insert at the prompt cursor (copies when no prompt field is active)"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => useSnippet(s)}
                  >
                    <span className="snippets-entry-name">{s.name}</span>
                    <span className="snippets-entry-preview">{snippetPreview(s.body)}</span>
                  </button>
                  <span className="snippets-entry-actions">
                    <button type="button" className="snippets-icon-btn" title="Copy to clipboard" aria-label={`Copy ${s.name}`} onMouseDown={(e) => e.preventDefault()} onClick={() => void copySnippet(s, false)}>
                      <CopyGlyph />
                    </button>
                    <button type="button" className="snippets-icon-btn" title="Edit snippet" aria-label={`Edit ${s.name}`} onClick={() => startEdit(s)}>
                      <EditIcon size={13} />
                    </button>
                    {confirmDeleteId === s.id ? (
                      <button type="button" className="snippets-confirm-delete" onClick={() => removeSnippet(s)}>Delete?</button>
                    ) : (
                      <button type="button" className="snippets-icon-btn" title="Delete snippet" aria-label={`Delete ${s.name}`} onClick={() => setConfirmDeleteId(s.id)}>
                        <TrashIcon size={13} />
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="snippets-foot">Click a snippet to insert it at your prompt cursor. Stored with your app settings, across all projects.</div>
    </>
  );

  if (embedded) {
    return (
      <>
        <div className="snippets-embedded" data-snippets-ui>{body}</div>
        {toastEl && createPortal(toastEl, document.body)}
      </>
    );
  }

  if (!visible && !toast) return null;

  return createPortal(
    <>
      {visible && (
        <div className="snippets-backdrop" data-snippets-ui onMouseDown={() => onClose?.()}>
          <aside
            className="snippets-shelf"
            data-snippets-ui
            role="dialog"
            aria-label="Prompt snippets"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {body}
          </aside>
        </div>
      )}
      {toastEl}
    </>,
    document.body,
  );
}

/**
 * The overlay shelf host: mount once above the classic view (the
 * workspace owns it in both windows). Renders nothing until opened
 * (plus a transient toast). While the node canvas's embedded Snippets
 * tab claims shelf-open requests, `openSnippetsShelf` never reaches
 * this host, so the two homes never open at once.
 */
export function SnippetsShelfHost() {
  const [open, setOpen] = useState(false);
  const [prefillRequest, setPrefillRequest] = useState<SnippetPrefillRequest | null>(null);
  const nonceRef = useRef(0);

  useEffect(() => onOpenSnippetsShelf((req) => {
    setOpen(true);
    if (req.prefillBody !== undefined) {
      nonceRef.current += 1;
      setPrefillRequest({ body: req.prefillBody, nonce: nonceRef.current });
    }
  }), []);

  return (
    <SnippetsPanel
      visible={open}
      prefillRequest={prefillRequest}
      onInserted={() => setOpen(false)}
      onClose={() => setOpen(false)}
    />
  );
}
