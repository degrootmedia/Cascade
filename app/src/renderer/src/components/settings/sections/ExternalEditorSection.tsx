import { useEffect, useState } from "react";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

export async function resetExternalEditor(): Promise<void> {
  await window.cascade.setExternalEditor(null);
}

/** Path to the external image editor used by "Edit externally" everywhere. */
export function ExternalEditorSection() {
  const { view, setError } = useSettings();
  const [editor, setEditor] = useState(view.externalEditor);

  useEffect(() => setEditor(view.externalEditor), [view.externalEditor]);

  async function pickExternalEditor() {
    try {
      const picked = await window.cascade.pickExternalEditor();
      if (picked) setEditor(picked);
    } catch (e) {
      setError(String(e));
    }
  }

  async function clearExternalEditor() {
    try {
      await window.cascade.setExternalEditor(null);
      setEditor(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveExternalEditor(path: string | null) {
    const trimmed = path?.trim() ? path.trim() : null;
    // Allow WindowsApps even though it may not pass exists check — we bake elevation for it.
    try {
      await window.cascade.setExternalEditor(trimmed);
      setEditor(trimmed);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <SettingField
      label="External image editor"
      help={
        <>
          Photoshop, Affinity, etc. Right-click any reference or generated frame and choose “Edit externally” to open it here.
          Windows Store apps (e.g. <code>...\WindowsApps\Affinity.exe</code>) are ACL-locked — the file picker can't enter that folder, so paste the full path above. It will be launched elevated (UAC) automatically.
        </>
      }
    >
      <div className="row">
        <input
          value={editor ?? ""}
          placeholder="System default — paste path e.g. ...\WindowsApps\Affinity.exe"
          onChange={(e) => setEditor(e.target.value || null)}
          onBlur={(e) => void saveExternalEditor(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditor(view.externalEditor);
          }}
          style={{ flex: 1, minWidth: 220 }}
          title={editor ?? "System default"}
        />
        <button onClick={() => void pickExternalEditor()}>Choose…</button>
        {editor && <button onClick={() => void clearExternalEditor()}>Clear</button>}
      </div>
    </SettingField>
  );
}
