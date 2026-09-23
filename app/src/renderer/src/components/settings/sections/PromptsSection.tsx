import { useEffect, useMemo, useState } from "react";
import { PROMPT_TEMPLATES } from "../../../../../shared/prompt-templates.js";
import { primePromptTemplates } from "../../production/prompt-templates.js";
import { useSettings } from "../context.js";

const SECTION_ID = "prompts";

/** The built-in wording for every template, keyed by id. */
const BUILTINS: Record<string, string> = Object.fromEntries(PROMPT_TEMPLATES.map((d) => [d.id, d.builtin]));

/** Build the final override map from the drafts: drop blanks and values that
 *  still equal the built-in, so the built-in shows through. */
function overridesFrom(drafts: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of PROMPT_TEMPLATES) {
    const value = (drafts[def.id] ?? "").trim();
    if (value && value !== def.builtin) out[def.id] = value;
  }
  return out;
}

/**
 * Editable creative prompt templates (Settings → Advanced → Prompts). Each
 * template shows its active wording with a "Reset to default" action; edits are
 * deferred (Save prompts / the panel's close guard write them). Mechanical
 * grammar (JSON shapes, `@imageN` tokens) deliberately stays in code.
 */
export function PromptsSection() {
  const { setError, setDirty, registerSaver } = useSettings();
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({ ...BUILTINS }));
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    const api = (window as { cascade?: { getPromptTemplates?: () => Promise<Record<string, string>> } }).cascade;
    if (!api || typeof api.getPromptTemplates !== "function") {
      setLoaded(true);
      return () => { live = false; };
    }
    void api
      .getPromptTemplates()
      .then((overrides) => {
        if (!live) return;
        const o = overrides && typeof overrides === "object" ? overrides : {};
        setSaved(o);
        setDrafts(Object.fromEntries(PROMPT_TEMPLATES.map((d) => [d.id, o[d.id]?.trim() ? o[d.id] : d.builtin])));
        setLoaded(true);
      })
      .catch((e) => {
        if (!live) return;
        setError(String(e));
        setLoaded(true);
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(() => {
    if (!loaded) return false;
    const next = overridesFrom(drafts);
    const keys = new Set([...Object.keys(saved), ...Object.keys(next)]);
    for (const key of keys) if ((saved[key] ?? "") !== (next[key] ?? "")) return true;
    return false;
  }, [drafts, saved, loaded]);

  useEffect(() => setDirty(SECTION_ID, dirty), [dirty, setDirty]);

  async function persist(): Promise<void> {
    try {
      const next = overridesFrom(drafts);
      const api = (window as { cascade?: { setPromptTemplates?: (o: Record<string, string>) => Promise<void> } }).cascade;
      if (api && typeof api.setPromptTemplates === "function") await api.setPromptTemplates(next);
      setSaved(next);
      // Refresh the renderer's cached overrides so newly-seeded defaults
      // (video motion) pick up the edit without an app restart.
      void primePromptTemplates();
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    registerSaver(SECTION_ID, persist);
    return () => registerSaver(SECTION_ID, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts]);

  const modifiedCount = PROMPT_TEMPLATES.filter((d) => (drafts[d.id] ?? "") !== d.builtin).length;

  return (
    <>
      <p className="hint">
        The creative wording Cascade uses when it generates. Edits are saved with <strong>Save prompts</strong>.
        Mechanical formatting (JSON shapes, reference tokens) stays in code and is not editable here.
      </p>
      {PROMPT_TEMPLATES.map((def) => {
        const modified = (drafts[def.id] ?? "") !== def.builtin;
        return (
          <div key={def.id} className="settings-prompt">
            <div className="settings-prompt-head">
              <span className="settings-prompt-title">
                {def.label}
                {modified && <span className="settings-prompt-badge" title="This template differs from the built-in">modified</span>}
              </span>
              <button
                type="button"
                disabled={!modified}
                onClick={() => setDrafts((prev) => ({ ...prev, [def.id]: def.builtin }))}
                title="Restore the shipped wording"
              >
                Reset to default
              </button>
            </div>
            <p className="hint">
              {def.description}
              {def.placeholders?.length ? <> Placeholders: {def.placeholders.map((p) => `{{${p}}}`).join(", ")}.</> : null}
            </p>
            <textarea
              className="settings-prompt-textarea"
              spellCheck={false}
              value={drafts[def.id] ?? ""}
              placeholder={def.builtin}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [def.id]: e.target.value }))}
            />
          </div>
        );
      })}
      <div className="row">
        <button type="button" disabled={!dirty} onClick={() => void persist()} title="Save every edited template">
          Save prompts
        </button>
        <button
          type="button"
          disabled={modifiedCount === 0}
          onClick={() => setDrafts({ ...BUILTINS })}
          title="Restore every template's shipped wording"
        >
          Reset all
        </button>
        {loaded && !dirty && modifiedCount > 0 && <span className="hint">saved</span>}
        {loaded && !dirty && modifiedCount === 0 && <span className="hint">all defaults</span>}
      </div>
    </>
  );
}
