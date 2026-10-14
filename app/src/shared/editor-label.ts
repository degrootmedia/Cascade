/**
 * The one label for "open in the configured external image editor" — shared
 * by the native menu (main) and every renderer menu so the wording can
 * never drift. Dependency-free: both processes import it.
 */
export function externalEditorLabel(editorPath: string | null | undefined): string {
  const ed = editorPath?.trim();
  if (!ed) return "Edit externally";
  const base = ed.split(/[\\/]/).pop() ?? ed;
  const name = base.replace(/\.[^.]+$/, "");
  return name ? `Edit in ${name}` : "Edit externally";
}
