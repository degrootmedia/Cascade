/** Renderer-side stable id for user-created characters/products/references. */
export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Normalize an entered/pasted hex on blur: allow shorthand, fill to 6 hex. */
export function normalizeHex(v: string): string {
  const t = String(v).trim().replace(/^#/, "");
  if (!t) return "";
  if (/^[0-9a-fA-F]{3}$/.test(t)) return `#${t.split("").map((c) => c + c).join("").toUpperCase()}`;
  if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t.toUpperCase()}`;
  return String(v).trim(); // not a full color yet — keep what they typed
}

/** True when the text is a complete hex color (3 or 6 digits, optional #). */
export function isCompleteHex(v: string): boolean {
  const t = String(v).trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{3}$/.test(t) || /^[0-9a-fA-F]{6}$/.test(t);
}

/** #RGB / #RRGGBB → normalized "#RRGGBB" for the chip preview; "" when invalid. */
export function previewHex(v: string): string {
  const t = String(v).trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(t)) return `#${t.split("").map((c) => c + c).join("").toUpperCase()}`;
  return "";
}

/** #RGB / #RRGGBB → { h: 0..360, s: 0..1, v: 0..1 }; null when not valid hex. */
export function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
  const t = String(hex).trim().replace(/^#/, "");
  const full = /^[0-9a-fA-F]{6}$/.test(t) ? t
    : /^[0-9a-fA-F]{3}$/.test(t) ? t.split("").map((c) => c + c).join("")
    : null;
  if (!full) return null;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** { h: 0..360, s: 0..1, v: 0..1 } → "#RRGGBB". */
export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const x = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(255 * x).toString(16).padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`.toUpperCase();
}


