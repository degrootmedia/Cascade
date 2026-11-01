/**
 * Theme-token unification guard (styles.css): every theme color lives in the
 * token blocks at the top of the file, the light (XSI gray) theme redefines
 * the core tokens, and the storyboard selected ring layers OUTSIDE the
 * color-tag ring instead of replacing it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(
  path.resolve(__dirname, "../src/renderer/src/styles.css"),
  "utf8",
);

/** Extract a `selector { ... }` block (brace-matched) and its span. */
function block(selector: string): { text: string; start: number; end: number } {
  const start = css.indexOf(selector);
  expect(start, `selector ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      return { text: css.slice(open + 1, i), start, end: i + 1 };
    }
  }
  throw new Error(`unterminated block for ${selector}`);
}

const dark = block(':root, [data-theme="dark"]');
const light = block('[data-theme="light"]');
/** styles.css with both token blocks removed — what component rules may use. */
const rest =
  css.slice(0, dark.start) +
  css.slice(dark.end, light.start) +
  css.slice(light.end);

/** Content colors: the literal IS the value (hue spectrum, magic rainbow,
 *  moodboard canvas presets, sticky-note paper). Anything else must be a var. */
const CONTENT_HEX = new Set([
  "#f00", "#ff0", "#0f0", "#0ff", "#00f", "#f0f", // hue-picker spectrum
  "#ff6b6b", "#f59e0b", "#84cc16", "#06b6d4", "#8b5cf6", "#ec4899", // magic rainbow
  "#141414", "#2b2b2b", "#1b1b1b", // moodboard canvas background presets
  "#f4e6b0", "#2a2308", // sticky-note paper + ink
]);

const CORE_TOKENS = [
  "--bg", "--bg-panel", "--bg-raised", "--bg-elev", "--bg-inset",
  "--border", "--text", "--text-dim", "--accent", "--danger", "--ok",
  "--warn",
];

function definedTokens(text: string): Set<string> {
  return new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1].toLowerCase()));
}

describe("theme token unification", () => {
  it("no hex color literals outside the token blocks (except content colors)", () => {
    const hexes = [...rest.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
    const stray = [...new Set(hexes)].filter((h) => !CONTENT_HEX.has(h));
    expect(stray).toEqual([]);
  });

  it("no non-black/white rgba() literals outside the token blocks", () => {
    const colored = [...rest.matchAll(/rgba\(([^)]+)\)/gi)]
      .map((m) => m[1].replace(/\s+/g, ""))
      .filter((v) => !v.startsWith("0,0,0,") && !v.startsWith("255,255,255,"));
    expect(colored).toEqual([]);
  });

  it("dark block defines the core tokens; light redefines surfaces as XSI gray", () => {
    const darkTokens = definedTokens(dark.text);
    for (const t of CORE_TOKENS) expect(darkTokens.has(t), `dark ${t}`).toBe(true);
    expect(dark.text).toContain("--bg: #111417");
    expect(dark.text).toContain("color-scheme: dark");

    const lightTokens = definedTokens(light.text);
    for (const t of ["--bg", "--bg-panel", "--bg-raised", "--bg-elev", "--bg-inset", "--border", "--text", "--text-dim", "--danger", "--ok", "--warn"]) {
      expect(lightTokens.has(t), `light ${t}`).toBe(true);
    }
    // The XSI gray ramp + native-control scheme.
    expect(light.text).toContain("--bg: #a8a8a8");
    expect(light.text).toContain("--bg-panel: #bdbdbd");
    expect(light.text).toContain("--text: #202226");
    expect(light.text).toContain("color-scheme: light");
    // Light only overrides tokens that exist in dark (no orphan tokens).
    for (const t of lightTokens) expect(darkTokens.has(t), `orphan light token ${t}`).toBe(true);
  });
});

describe("storyboard selected ring vs color tag", () => {
  /** Every rule whose selector paints a .prod-board-frame border/ring. */
  const ringRules = [...rest.matchAll(/([^{}]*\.prod-board-frame[^{]*)\{([^}]*)\}/g)]
    .filter(([, , body]) => /border-color|border:\s*1px|box-shadow/.test(body))
    .map(([, selector, body]) => ({ selector: selector.trim(), body }));

  it("selection stacks outside the tag ring at equal thickness", () => {
    expect(rest).toContain("--board-band: 3px");
    // Tag = inner band, accent = outer band; spreads derive from --board-band
    // (inner calc(band - 1px), outer calc(2*band - 1px)) so each visible band
    // is exactly --board-band thick (the 1px border completes the inner one).
    expect(rest).toContain(
      ".prod-board.selected.tag-green .prod-board-frame, .prod-board.selected.tag-yellow .prod-board-frame, .prod-board.selected.tag-red .prod-board-frame { border-color: var(--board-tag); box-shadow: 0 0 0 calc(var(--board-band) - 1px) var(--board-tag), 0 0 0 calc(var(--board-band) * 2 - 1px) var(--accent)",
    );
    expect(rest).toContain(
      ".prod-board.selected .prod-board-frame { border-color: var(--accent); box-shadow: 0 0 0 calc(var(--board-band) - 1px) var(--accent)",
    );
  });

  it("every board ring rule derives its spreads from --board-band (no hard-coded spreads, no alpha rings)", () => {
    expect(ringRules.length).toBeGreaterThanOrEqual(8);
    for (const { selector, body } of ringRules) {
      // Hard-coded ring spreads are what made bands differ (2px vs 4px).
      expect(body, selector).not.toMatch(/box-shadow:[^;]*\b0 0 0 \d+px/);
      // Translucent ring colors read thinner than opaque ones at same spread.
      expect(body, selector).not.toMatch(/box-shadow:[^;]*0 0 0 calc\([^)]*\)\s*color-mix\(in srgb, var\(--accent\) \d+%, transparent\)/);
      // The halo glow is identical everywhere (variable glow reads as thickness).
      expect(body, selector).not.toContain("0 0 12px 3px");
    }
    const spreads = ringRules.flatMap(({ body }) =>
      [...body.matchAll(/0 0 0 (calc\(var\(--board-band\)[^)]*\))/g)].map((m) => m[1]),
    );
    expect(spreads.length).toBeGreaterThanOrEqual(10);
    for (const s of spreads) {
      expect(["calc(var(--board-band) - 1px)", "calc(var(--board-band) * 2 - 1px)"]).toContain(s);
    }
  });

  it("selected wins over the muted range band (same thickness, full accent)", () => {
    expect(rest).toContain(
      ".prod-board.selected.in-range .prod-board-frame { border-color: var(--accent); box-shadow: 0 0 0 calc(var(--board-band) - 1px) var(--accent)",
    );
    expect(rest).toContain(".prod-board.selected.in-range.tag-green .prod-board-frame");
    expect(rest).toContain("--board-range: color-mix(in srgb, var(--accent) 65%, var(--border))");
  });
});
