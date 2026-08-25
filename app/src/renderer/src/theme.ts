/** Apply the chosen accent color to the CSS variable (live, no restart). */
export function applyAccent(hex: string) {
  document.documentElement.style.setProperty("--accent", hex);
}
