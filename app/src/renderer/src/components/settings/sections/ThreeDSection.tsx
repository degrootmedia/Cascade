import { useState } from "react";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

export async function resetThreeD(): Promise<void> {
  await window.cascade.set3daiApiKey("");
}

/** 3D AI Studio key for the Design page's Tencent Hunyuan Pro generator. */
export function ThreeDSection() {
  const { view, refresh, setError } = useSettings();
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const hasKey = view.has3daiApiKey && !editing;

  async function save() {
    if (!key.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await window.cascade.set3daiApiKey(key.trim());
      setKey("");
      setEditing(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingField
      label="3D AI Studio API key"
      help={
        <>
          Powers the 3D model generator on the Design page (Tencent Hunyuan Pro via 3dai.studio). Get a key and buy
          credits in the{" "}
          <a href="https://www.3daistudio.com/Platform/API" target="_blank" rel="noreferrer">
            3D AI Studio API dashboard
          </a>
          .
        </>
      }
    >
      {hasKey ? (
        <p className="hint">
          Key saved (encrypted).{" "}
          <button className="link" onClick={() => setEditing(true)}>
            Replace
          </button>
        </p>
      ) : (
        <div className="row">
          <input type="password" value={key} placeholder="3D AI Studio API key" onChange={(e) => setKey(e.target.value)} />
          <button onClick={() => void save()} disabled={saving || !key.trim()}>
            Save
          </button>
          {editing && (
            <button onClick={() => { setEditing(false); setKey(""); }} disabled={saving}>
              Cancel
            </button>
          )}
        </div>
      )}
    </SettingField>
  );
}
