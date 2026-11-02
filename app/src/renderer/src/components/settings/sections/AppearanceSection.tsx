import { useEffect, useState } from "react";
import type { UiIconSet, UiTheme } from "../../../../../shared/ipc.js";
import {
  applyAccent,
  applyIconSet,
  applyTheme,
  DEFAULT_ICON_SET,
  DEFAULT_THEME,
  normalizeIconSet,
  normalizeTheme,
} from "../../../theme.js";
import { ImageIcon, PlusIcon, SearchIcon } from "../../icons.js";
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
  { name: "Graphite", value: "graphite" },
  { name: "Light (XSI gray)", value: "light" },
];

const ICON_SET_PRESETS: Array<{ name: string; value: UiIconSet }> = [
  { name: "Colorful", value: "colorful" },
  { name: "Minimal", value: "minimal" },
];

export const DEFAULT_ACCENT = ACCENT_PRESETS[0].value;

export async function resetAppearance(): Promise<void> {
  await window.cascade.setAccent(DEFAULT_ACCENT);
  applyAccent(DEFAULT_ACCENT);
  await window.cascade.setTheme(DEFAULT_THEME);
  applyTheme(DEFAULT_THEME);
  await window.cascade.setIconSet(DEFAULT_ICON_SET);
  applyIconSet(DEFAULT_ICON_SET);
}

export function AppearanceSection() {
  const { view, setError } = useSettings();
  const [accent, setAccentState] = useState(view.accent);
  const [theme, setThemeState] = useState<UiTheme>(normalizeTheme(view.theme));
  const [iconSet, setIconSetState] = useState<UiIconSet>(normalizeIconSet(view.iconSet));

  useEffect(() => setAccentState(view.accent), [view.accent]);
  useEffect(() => setThemeState(normalizeTheme(view.theme)), [view.theme]);
  useEffect(() => setIconSetState(normalizeIconSet(view.iconSet)), [view.iconSet]);

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

  function changeIconSet(next: UiIconSet) {
    setIconSetState(next);
    applyIconSet(next);
    void window.cascade.setIconSet(next).catch((e) => setError(String(e)));
  }

  return (
    <>
      <SettingField label="Theme" help="Overall color palette. Graphite is a clean neutral dark; Light is the Softimage XSI gray. Applied immediately.">
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
      <SettingField label="Icon set" help="Colorful is the original full-color artwork. Minimal is single-color outlines — white on dark themes, dark gray on Light. Applied immediately.">
        <div className="theme-row">
          {ICON_SET_PRESETS.map((p) => (
            <button
              key={p.value}
              className={`theme-swatch icon-set-swatch${iconSet === p.value ? " selected" : ""}`}
              data-icon-set={p.value}
              title={p.name}
              aria-label={`Icon set: ${p.name}`}
              aria-pressed={iconSet === p.value}
              onClick={() => changeIconSet(p.value)}
            >
              <span className="icon-set-preview" aria-hidden>
                <SearchIcon size={15} iconSet={p.value} />
                <PlusIcon size={15} iconSet={p.value} />
                <ImageIcon size={15} iconSet={p.value} />
              </span>
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
