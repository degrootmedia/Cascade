import { useEffect, useState } from "react";
import type { UiTheme } from "../../../../../shared/ipc.js";
import { applyAccent, applyTheme, DEFAULT_THEME, normalizeTheme } from "../../../theme.js";
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

const THEME_PRESETS: Array<{ name: string; value: UiTheme }> = [
  { name: "Dark", value: "dark" },
  { name: "Light (XSI gray)", value: "light" },
];

export const DEFAULT_ACCENT = ACCENT_PRESETS[0].value;

export async function resetAppearance(): Promise<void> {
  await window.cascade.setAccent(DEFAULT_ACCENT);
  applyAccent(DEFAULT_ACCENT);
  await window.cascade.setTheme(DEFAULT_THEME);
  applyTheme(DEFAULT_THEME);
}

export function AppearanceSection() {
  const { view, setError } = useSettings();
  const [accent, setAccentState] = useState(view.accent);
  const [theme, setThemeState] = useState<UiTheme>(normalizeTheme(view.theme));

  useEffect(() => setAccentState(view.accent), [view.accent]);
  useEffect(() => setThemeState(normalizeTheme(view.theme)), [view.theme]);

  function changeAccent(color: string) {
    setAccentState(color);
    applyAccent(color);
    void window.cascade.setAccent(color).catch((e) => setError(String(e)));
  }

  function changeTheme(next: UiTheme) {
    setThemeState(next);
    applyTheme(next);
    void window.cascade.setTheme(next).catch((e) => setError(String(e)));
  }

  return (
    <>
      <SettingField label="Theme" help="Overall color palette. Light is the Softimage XSI gray. Applied immediately.">
        <div className="theme-row">
          {THEME_PRESETS.map((p) => (
            <button
              key={p.value}
              className={`theme-swatch${theme === p.value ? " selected" : ""}`}
              data-theme={p.value}
              title={p.name}
              aria-label={`Theme: ${p.name}`}
              aria-pressed={theme === p.value}
              onClick={() => changeTheme(p.value)}
            >
              <span className="theme-swatch-dot" aria-hidden />
              {p.name}
            </button>
          ))}
        </div>
      </SettingField>
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
    </>
  );
}
