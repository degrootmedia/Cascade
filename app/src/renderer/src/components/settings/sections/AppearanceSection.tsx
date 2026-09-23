import { useEffect, useState } from "react";
import { applyAccent } from "../../../theme.js";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

const ACCENT_PRESETS = [
  { name: "Blue", value: "#4f8ef7" },
  { name: "Violet", value: "#a371f7" },
  { name: "Teal", value: "#2ea89a" },
  { name: "Green", value: "#57ab5a" },
  { name: "Orange", value: "#e0823d" },
  { name: "Pink", value: "#f778ba" },
];

export const DEFAULT_ACCENT = ACCENT_PRESETS[0].value;

export async function resetAppearance(): Promise<void> {
  await window.cascade.setAccent(DEFAULT_ACCENT);
  applyAccent(DEFAULT_ACCENT);
}

export function AppearanceSection() {
  const { view, setError } = useSettings();
  const [accent, setAccentState] = useState(view.accent);

  useEffect(() => setAccentState(view.accent), [view.accent]);

  function changeAccent(color: string) {
    setAccentState(color);
    applyAccent(color);
    void window.cascade.setAccent(color).catch((e) => setError(String(e)));
  }

  return (
    <SettingField label="Accent color" help="Highlights, links, and selection outlines. Applied immediately.">
      <div className="accent-row">
        {ACCENT_PRESETS.map((p) => (
          <button
            key={p.value}
            className={`accent-swatch${accent.toLowerCase() === p.value ? " selected" : ""}`}
            style={{ background: p.value }}
            title={p.name}
            aria-label={`Accent color: ${p.name}`}
            onClick={() => changeAccent(p.value)}
          />
        ))}
        <input
          type="color"
          className="accent-custom"
          value={accent}
          title="Custom accent color"
          onChange={(e) => changeAccent(e.target.value)}
        />
      </div>
    </SettingField>
  );
}
