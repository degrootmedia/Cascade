import { useState } from "react";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

/** App/Electron/Chrome versions parsed from the renderer's user agent. */
export function parseVersions(ua: string): { app: string; electron: string; chrome: string } {
  const pick = (name: string): string => {
    const m = new RegExp(`${name}/([\\d.]+)`).exec(ua);
    return m ? m[1] : "unknown";
  };
  return { app: pick("Cascade"), electron: pick("Electron"), chrome: pick("Chrome") };
}

/** Read-only environment info plus a "Copy diagnostics" convenience. */
export function DiagnosticsSection() {
  const { view, setError } = useSettings();
  const [copied, setCopied] = useState(false);
  const versions = parseVersions(typeof navigator === "undefined" ? "" : navigator.userAgent);

  async function copy() {
    const text = [
      `Cascade ${versions.app}`,
      `Electron ${versions.electron}`,
      `Chrome ${versions.chrome}`,
      `Provider ${view.provider}`,
      `Model ${view.model || "(default)"}`,
      `Workspace ${view.workspace ?? "(none)"}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <SettingField
      label="Environment"
      help="Versions and the active provider/model. Copy this when reporting a problem."
    >
      <ul className="settings-diag">
        <li>Cascade {versions.app}</li>
        <li>Electron {versions.electron}</li>
        <li>Chrome {versions.chrome}</li>
        <li>Provider {view.provider}</li>
        <li>Model {view.model || "(default)"}</li>
      </ul>
      <div className="row">
        <button onClick={() => void copy()}>{copied ? "Copied" : "Copy diagnostics"}</button>
      </div>
    </SettingField>
  );
}
