import { useEffect, useState } from "react";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

/** Dev Mode: submission logging, credit-free dry runs, and the Model Customizer. */
export function DeveloperSection() {
  const { onOpenModelCustomizer, setError } = useSettings();
  const [devMode, setDevMode] = useState(false);
  const [dryRun, setDryRun] = useState(false);

  useEffect(() => {
    void window.cascade.getDevMode().then(setDevMode).catch(() => {});
    void window.cascade.getSubmissionDryRun().then(setDryRun).catch(() => {});
  }, []);

  return (
    <>
      <SettingField
        label="Dev Mode"
        help="Logs every generation submission to <userData>/logs/submissions.md (+ submissions.jsonl). Secrets are redacted."
      >
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={devMode}
            onChange={(e) => {
              const v = e.target.checked;
              setDevMode(v);
              void window.cascade.setDevMode(v).catch((err) => setError(String(err)));
            }}
          />
          Log every generation submission
        </label>
      </SettingField>

      {devMode && (
        <SettingField label="Dry run" help="Builds and logs the real request, then throws before spending credits.">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => {
                const v = e.target.checked;
                setDryRun(v);
                void window.cascade.setSubmissionDryRun(v).catch((err) => setError(String(err)));
              }}
            />
            Spend no credits
          </label>
        </SettingField>
      )}

      {onOpenModelCustomizer && (
        <SettingField label="Model customization" help="Probe every media vendor and customize models + parameters.">
          <div className="row">
            <button onClick={onOpenModelCustomizer}>Open Model Customizer…</button>
          </div>
        </SettingField>
      )}
    </>
  );
}
