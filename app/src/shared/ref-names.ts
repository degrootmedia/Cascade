/**
 * Reference naming helpers shared by the renderer (the save-time name
 * prompt's suggestion + inline validation) and main (the authoritative
 * sanitize on save). A reference name becomes an `@[name]` prompt tag, so
 * brackets and `@` can never be part of one, and path separators can't
 * either (the name also seeds the copied file's name).
 */

/** Strip tag/path-hostile characters, collapse whitespace, cap length. */
export function sanitizeReferenceName(raw: string): string {
  return raw
    .replace(/[\[\]@/\\:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .trim();
}

/** Why a user-typed name can't be used as-is, or null when it's fine. */
export function referenceNameError(raw: string): string | null {
  if (!raw.trim()) return "A name is required.";
  if (/[\[\]@]/.test(raw)) return "Names can't contain [ ] or @ - they become @[name] tags in prompts.";
  if (/[/\\:*?"<>|]/.test(raw)) return "Names can't contain / \\ : * ? \" < > | - the name also names the saved file.";
  if (sanitizeReferenceName(raw).length === 0) return "That name has no usable characters.";
  return null;
}

/** The pre-filled suggestion for a suite export: the prompt's first line,
 *  cleaned, falling back to "Suite" (the historical automatic name). */
export function suggestSuiteRefName(prompt: string): string {
  const first = (prompt ?? "").split("\n")[0] ?? "";
  return sanitizeReferenceName(first).slice(0, 48).trim() || "Suite";
}
