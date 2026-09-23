import { useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "../../../../../shared/ipc.js";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

/** Default chat/pipeline model for the active provider. */
export function ModelsSection() {
  const { view, onOpenModelCustomizer, setError } = useSettings();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState(view.model);
  const [modelError, setModelError] = useState<string | null>(null);

  const sortedModels = useMemo(
    () => [...models].sort((a, b) => a.baseCost - b.baseCost || a.id.localeCompare(b.id)),
    [models]
  );

  async function loadModels(): Promise<ModelInfo[]> {
    const res = await window.cascade.listModels();
    if (!res.ok) {
      setModelError(res.error);
      return [];
    }
    setModelError(null);
    return res.models;
  }

  async function changeModel(id: string) {
    setModel(id);
    await window.cascade.setModel(id);
  }

  async function refreshModels() {
    setError(null);
    setModels(await loadModels());
  }

  // Fetch whenever the provider's key becomes available (or the provider changes).
  useEffect(() => {
    if (!view.hasApiKey) {
      setModels([]);
      return;
    }
    void loadModels().then(setModels);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.hasApiKey, view.provider]);

  useEffect(() => setModel(view.model), [view.model]);

  // A provider may have no stored model yet (or its saved model is gone) —
  // fall back to its first listed model so we never send an empty model.
  useEffect(() => {
    if (sortedModels.length === 0) return;
    if (!sortedModels.some((m) => m.id === model)) void changeModel(sortedModels[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedModels, model]);

  return (
    <SettingField
      label="Model"
      help="Models are listed cheapest first. Hover a cost badge in the header picker for details."
    >
      <div className="row">
        <select value={model} onChange={(e) => void changeModel(e.target.value)} disabled={!view.hasApiKey} style={{ flex: 1 }}>
          {sortedModels.length === 0 && <option value={model}>{model}</option>}
          {sortedModels.map((m) => (
            <option key={m.id} value={m.id} title={m.costTitle}>
              {m.costLabel.startsWith("$") ? `${m.id} (${m.costLabel})` : m.id}
            </option>
          ))}
        </select>
        <button onClick={() => void refreshModels()} disabled={!view.hasApiKey} title="Re-fetch the model list from this provider">
          Refresh models
        </button>
      </div>
      {view.hasApiKey && models.length === 0 && modelError && <p className="error-text">{modelError}</p>}
      {onOpenModelCustomizer && (
        <p className="hint">
          Hide models, fix image/video kind, reorder dropdowns, and place parameters in the{" "}
          <button className="link" onClick={onOpenModelCustomizer}>
            Model Customizer
          </button>
          .
        </p>
      )}
    </SettingField>
  );
}
