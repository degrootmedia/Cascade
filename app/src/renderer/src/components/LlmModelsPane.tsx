/**
 * Model Customizer → "LLM models" tab (Feature #9). Lists the active chat
 * provider's LLMs with the same eye hide/show control the image/video lists
 * use. Hidden ids persist in the global settings file (`hiddenLlmModels`)
 * and every LLM picker (header model picker, Settings → Model, the agent
 * editor) leaves them out. LLMs have no parameters to place, so there is no
 * detail pane.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "../../../shared/ipc.js";
import { LLM_VISIBILITY_EVENT } from "../../../shared/llm-visibility.js";
import { EyeIcon, EyeOffIcon } from "./icons.js";

export function LlmModelsPane({ panelWidth }: { panelWidth: number }) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [concealHidden, setConcealHidden] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.cascade.listModels();
      if (res.ok) setModels(res.models);
      else { setModels([]); setError(res.error); }
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    if (typeof window.cascade.getHiddenLlmModels === "function") {
      void window.cascade.getHiddenLlmModels().then((ids) => setHidden(new Set(ids ?? []))).catch(() => {});
    }
  }, [load]);

  const sorted = useMemo(
    () => [...models].sort((a, b) => a.baseCost - b.baseCost || a.id.localeCompare(b.id)),
    [models]
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? sorted.filter((m) => m.id.toLowerCase().includes(q)) : sorted;
  }, [sorted, search]);
  const rows = concealHidden ? filtered.filter((m) => !hidden.has(m.id)) : filtered;
  const hiddenCount = models.filter((m) => hidden.has(m.id)).length;

  const toggleHidden = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id); else next.add(id);
    setHidden(next);
    void window.cascade.setHiddenLlmModels([...next]).then(
      () => window.dispatchEvent(new Event(LLM_VISIBILITY_EVENT)),
      () => {}
    );
  };

  return (
    <div className="mc-body">
      <div className="mc-models" style={{ width: panelWidth }}>
        <div className="mc-models-head">
          <input
            className="mc-search"
            placeholder={`Search ${models.length} LLM models…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className={"mc-conceal" + (concealHidden ? " active" : "")}
            aria-pressed={concealHidden}
            onClick={() => setConcealHidden((v) => !v)}
            title={concealHidden ? "Show hidden models again" : "Conceal hidden models from this list"}
          >
            {concealHidden ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
            {concealHidden ? "Concealed" : "Conceal"}
            {hiddenCount ? ` (${hiddenCount})` : ""}
          </button>
          <button className="prod-btn" disabled={busy} onClick={() => void load()}>
            {busy ? "Loading…" : "Refresh"}
          </button>
        </div>
        <p className="mc-hint">Click the eye to hide an LLM from every chat and agent model picker.</p>
        {error && <p className="error-text mc-error">{error}</p>}
        <div className="mc-model-list">
          {rows.length > 0 && (
            <div className="mc-group">
              <div className="mc-group-head">LLM models <span className="mc-count">{rows.length}</span></div>
              {rows.map((m) => {
                const isHidden = hidden.has(m.id);
                return (
                  <div key={m.id} className={"mc-model-row mc-llm-row" + (isHidden ? " hidden-model" : "")}>
                    <button
                      className={"mc-eye" + (isHidden ? " off" : "")}
                      title={isHidden ? "Hidden — click to show in every picker" : "Hide from every model picker"}
                      onClick={(e) => { e.stopPropagation(); toggleHidden(m.id); }}
                    >
                      {isHidden ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                    </button>
                    <span className="mc-model-name" title={m.id}>{m.id}</span>
                    {isHidden && <span className="mc-hidden-badge">hidden</span>}
                    <span className="mc-price" title={m.costTitle}>{m.costLabel}</span>
                  </div>
                );
              })}
            </div>
          )}
          {busy && <p className="hint">Loading LLM models…</p>}
          {!busy && rows.length === 0 && !error && (
            <p className="hint">
              {filtered.length === 0 ? "No LLM models reported. Check the API key in Settings." : "All matching models are hidden — turn off “Conceal” to see them."}
            </p>
          )}
        </div>
      </div>
      <div className="mc-params">
        <p className="hint">
          LLM models have no parameters to place. Hidden LLMs are left out of the header model picker,
          Settings → Model and the agent editor. A chat or agent already set to a hidden model keeps it.
        </p>
      </div>
    </div>
  );
}
