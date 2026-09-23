/**
 * Label + help wrapper every Settings section uses. When a search is active,
 * a string label highlights its matching runs so the user can see why the
 * section surfaced. Rich (ReactNode) labels render unchanged.
 */
import type { ReactNode } from "react";
import { useSettings } from "./context.js";
import { highlightSegments } from "./search.js";

export function Highlight({ text }: { text: string }) {
  const { query } = useSettings();
  const segments = highlightSegments(text, query);
  if (!segments.some((s) => s.hit)) return <>{text}</>;
  return (
    <>
      {segments.map((s, i) =>
        s.hit ? (
          <mark key={i} className="settings-hit">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </>
  );
}

export function SettingField({
  label,
  help,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <label>{typeof label === "string" ? <Highlight text={label} /> : label}</label>
      {children}
      {help !== undefined && help !== null && <p className="hint">{help}</p>}
    </>
  );
}
