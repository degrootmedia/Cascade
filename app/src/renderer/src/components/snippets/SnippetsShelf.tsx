/**
 * The Snippets shelf: the user's prompt-snippet library, openable from the
 * classic view (prompt side panel) and the node view (graph header).
 *
 * Click model (insert first, copy second):
 *  - Clicking a snippet inserts its body at the cursor of the most
 *    recently focused prompt field and returns focus there; the first
 *    [placeholder] in the body is selected for typing over.
 *  - With no prompt field to insert into, the same click copies the body
 *    to the clipboard and shows a toast — never a silent no-op.
 *  - The copy icon on each entry always copies.
 *
 * The panel is portaled to <body>: inside the node graph it would
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

/** Button that opens the shelf. Rendered in each view's prompt chrome. */
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

/**
 * The shelf host: mount once above both views. Renders nothing until
 * opened (plus a transient toast). Also carries the snippet form used for
 * add / edit / save-selection (pre-filled body).
 */
export function SnippetsShelfHost() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useSyncExternalStore(subscribeSnippets, snippetsVersion, snippetsVersion);
  const snippets = getSnippets();
  const visible = filterSnippets(snippets, query);
  const groups = groupSnippetsByCategory(visible);
  const categories = [...new Set(snippets.map((s) => s.category))];

  useEffect(() => {
    installPromptFieldTracking();
    void primePromptSnippets();
    return onOpenSnippetsShelf((req) => {
      setOpen(true);
      setConfirmDeleteId(null);
      if (req.prefillBody !== undefined) {
        setForm({ ...EMPTY_FORM, body: req.prefillBody });
      }
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (form) setForm(null);
        else setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, form]);

  useEffect(() => {
    if (open && !form) searchRef.current?.focus();
    if (form) nameRef.current?.focus();
  }, [open, form]);

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
      setOpen(false);
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

  const selectionAvailable = open && !form ? getActivePromptSelectionText().length > 0 : false;

  if (!open && !toast) return null;

  return createPortal(
    <>
      {open && (
        <div className="snippets-backdrop" data-snippets-ui onMouseDown={() => setOpen(false)}>
          <aside
            className="snippets-shelf"
            data-snippets-ui
            role="dialog"
            aria-label="Prompt snippets"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="snippets-head">
              <span className="snippets-title">Snippets</span>
              <span className="snippets-head-actions">
                {selectionAvailable && (
                  <button type="button" className="prod-btn ghost snippets-small-btn" onClick={startAddFromSelection} title="Save the text selected in the prompt field as a new snippet">
                    New from selection
                  </button>
                )}
                <button type="button" className="prod-btn ghost snippets-small-btn" onClick={() => startAdd()} title="Add a new snippet">
                  <PlusIcon size={13} /> New
                </button>
                <button type="button" className="snippets-icon-btn" onClick={() => setOpen(false)} title="Close snippets" aria-label="Close snippets">
                  <XIcon size={14} />
                </button>
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
          </aside>
        </div>
      )}
      {toast && (
        <div className="snippets-toast" data-snippets-ui role="status">
          {toast}
        </div>
      )}
    </>,
    document.body,
  );
}
