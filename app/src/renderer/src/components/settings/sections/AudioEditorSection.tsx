import { useEffect, useState } from "react";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

export async function resetAudioEditor(): Promise<void> {
  await window.cascade.setAudioEditor(null);
}

/** Path to the external audio editor (e.g. Audacity) used by right-click "Edit Audio". */
export function AudioEditorSection() {
  const { view, setError } = useSettings();
  const [editor, setEditor] = useState(view.audioEditor);
  useEffect(() => setEditor(view.audioEditor), [view.audioEditor]);

  async function save(path: string | null) {
    const trimmed = path?.trim() ? path.trim() : null;
    try { await window.cascade.setAudioEditor(trimmed); setEditor(trimmed); setError(null); } catch (e) { setError(String(e)); }
  }
  async function pick() {
    try { const p = await window.cascade.pickAudioEditor(); if (p) setEditor(p); } catch (e) { setError(String(e)); }
  }

  return (
    <SettingField label="External audio editor" help={<>Audacity, Reaper, etc. Right-click an audio asset and choose <b>Edit Audio</b> to open it here. Blank uses the system default app.</>}>
      <div className="row">
        <input
          value={editor ?? ""}
          placeholder="System default — e.g. C:\Program Files\Audacity\audacity.exe"
          onChange={(e) => setEditor(e.target.value || null)}
          onBlur={(e) => void save(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          style={{ flex: 1, minWidth: 220 }}
        />
        <button onClick={() => void pick()}>Choose…</button>
        {editor && <button onClick={() => void save(null)}>Clear</button>}
      </div>
    </SettingField>
  );
}