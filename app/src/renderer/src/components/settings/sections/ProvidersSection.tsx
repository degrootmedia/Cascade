import { useState } from "react";
import { API_PROVIDERS } from "../../../../../shared/providers.js";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

export async function resetProviders(): Promise<void> {
  await window.cascade.setProvider("gab");
  await window.cascade.setModel("");
}

/** LLM provider selection, its encrypted API key, and a live connection test. */
export function ProvidersSection() {
  const { view, refresh, setError } = useSettings();
  const [apiKey, setApiKey] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  const providerLabel = API_PROVIDERS.find((p) => p.id === view.provider)?.label ?? view.provider;
  const hasKey = view.hasApiKey && !editingKey;

  async function changeProvider(id: string) {
    setError(null);
    setTest(null);
    try {
      await window.cascade.setProvider(id);
      await refresh();
      setApiKey("");
      setEditingKey(false);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveKey() {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await window.cascade.setApiKey(apiKey.trim());
      setApiKey("");
      setEditingKey(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTest(null);
    try {
      const res = await window.cascade.listModels();
      setTest(
        res.ok
          ? { ok: true, text: `Connected — ${res.models.length} model${res.models.length === 1 ? "" : "s"} available.` }
          : { ok: false, text: res.error }
      );
    } catch (e) {
      setTest({ ok: false, text: String(e) });
    }
  }

  return (
    <>
      <SettingField
        label="API provider"
        help="Which API powers chat, auto-titles, and the production pipeline's LLM steps. Each provider keeps its own key and model."
      >
        <select value={view.provider} onChange={(e) => void changeProvider(e.target.value)}>
          {API_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </SettingField>

      <SettingField label={`${providerLabel} API key`}>
        {hasKey ? (
          <p className="hint">
            Key saved (encrypted).{" "}
            <button className="link" onClick={() => setEditingKey(true)}>
              Replace
            </button>
          </p>
        ) : (
          <div className="row">
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <button onClick={() => void saveKey()} disabled={saving || !apiKey.trim()}>
              Save
            </button>
            {editingKey && (
              <button onClick={() => { setEditingKey(false); setApiKey(""); }} disabled={saving}>
                Cancel
              </button>
            )}
          </div>
        )}
      </SettingField>

      <SettingField label="Test connection" help="Fetches the provider's model list with the stored key to verify the endpoint.">
        <div className="row">
          <button onClick={() => void testConnection()} disabled={!view.hasApiKey}>
            Test connection
          </button>
          {test && <span className={test.ok ? "hint" : "error-text"} style={{ flex: 1 }}>{test.text}</span>}
        </div>
      </SettingField>
    </>
  );
}
