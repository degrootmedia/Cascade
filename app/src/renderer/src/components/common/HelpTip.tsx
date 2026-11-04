/** Section-help affordance (UI cleanup Item 2): guidance that used to sit
 *  as a permanent paragraph under a heading now rides on this "?" marker
 *  next to the heading. It deliberately uses the app-wide native `title`
 *  tooltip — the same mechanism every control in Cascade already uses —
 *  so tooltip style and hover delay stay identical everywhere. Focusable
 *  and labelled so the text is also reachable by keyboard/screen reader. */
export function HelpTip({ text, label }: {
  /** The full guidance text, shown on hover. */
  text: string;
  /** Short name of the section the tip belongs to (screen-reader prefix). */
  label?: string;
}) {
  return (
    <span
      className="cascade-helptip"
      tabIndex={0}
      role="img"
      aria-label={label ? `${label} — ${text}` : text}
      title={text}
      onClick={(e) => e.stopPropagation()}
    >
      ?
    </span>
  );
}
