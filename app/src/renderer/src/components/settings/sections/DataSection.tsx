import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

/** Folders and files the app writes: skills and the Dev Mode submission log. */
export function DataSection() {
  const { setError } = useSettings();

  return (
    <>
      <SettingField label="Skills folder" help="Markdown files that teach Cascade repeatable workflows. Cascade reads them when relevant.">
        <div className="row">
          <button onClick={() => void window.cascade.openSkillsFolder().catch((e) => setError(String(e)))}>
            Open skills folder
          </button>
        </div>
      </SettingField>

      <SettingField
        label="Submission log"
        help="Dev Mode appends every generation submission here (secrets are redacted). The file lives under your user data folder."
      >
        <div className="row">
          <button onClick={() => void window.cascade.openSubmissionLog().catch((e) => setError(String(e)))}>
            Open submission log
          </button>
        </div>
      </SettingField>
    </>
  );
}
