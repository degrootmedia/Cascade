import { useEffect, useState } from "react";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

/** Entry point to the dev Model Customizer: which models are hidden, how
 *  parameters are placed, and which surfaces each model appears on. */
export function ModelExposureSection() {
  const { onOpenModelCustomizer, setError } = useSettings();
  const [hidden, setHidden] = useState<string[] | null>(null);

  useEffect(() => {
    void window.cascade
      .getHiddenMediaModels()
      .then(setHidden)
      .catch(() => setHidden([]));
  }, []);

  return (
    <SettingField
      label="Model exposure"
      help="Controls which options show in the generation forms: hidden models, core vs. advanced parameters, and per-surface availability."
    >
      <p className="hint">
        {hidden === null
          ? "Loading…"
          : hidden.length === 0
            ? "No models are hidden."
            : `${hidden.length} model${hidden.length === 1 ? "" : "s"} hidden from the generation dropdowns.`}
      </p>
      <div className="row">
        <button
          onClick={() => {
            if (!onOpenModelCustomizer) {
              setError("The Model Customizer is available in Dev Mode.");
              return;
            }
            onOpenModelCustomizer();
          }}
        >
          Open Model Customizer…
        </button>
      </div>
    </SettingField>
  );
}
