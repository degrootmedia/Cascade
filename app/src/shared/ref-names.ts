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

/** The next auto-generated reference name for `base`: "<base>_001", then
 *  "_002", … — the first suffix no existing reference already uses
 *  (case-insensitive). The one numbering convention every save path uses. */
export function nextNumberedRefName(existingNames: Iterable<string>, base: string): string {
  const taken = new Set<string>();
  for (const n of existingNames) taken.add(n.trim().toLowerCase());
  for (let i = 1; ; i++) {
    const candidate = `${base}_${String(i).padStart(3, "0")}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The pre-filled suggestion for a suite export: the prompt's first line,
 *  cleaned, falling back to "Suite" (the historical automatic name). */
/** A citable reference with optional script/model names it also answers to.
 *  Aliases are how a user "slots" their own reference where the model or the
 *  script used a different name (`@[MainCharacter]` → the user's `@[Hero]`). */
export interface AliasedRef {
  id?: string;
  name: string;
  aliases?: string[];
}

/** Lookup key for a cited name: sanitized, whitespace-collapsed, lowercased. */
export function refLookupKey(name: string): string {
  return sanitizeReferenceName(name ?? "").toLowerCase();
}

/** Clean a user/model-supplied alias list: sanitized, deduplicated
 *  (case-insensitive), with the canonical name itself removed. */
export function sanitizeAliases(aliases: Iterable<string> | undefined | null, canonicalName: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([refLookupKey(canonicalName)]);
  for (const raw of aliases ?? []) {
    if (typeof raw !== "string") continue;
    const clean = sanitizeReferenceName(raw);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 12) break;
  }
  return out;
}

/** Index every resolvable cited name (canonical names + aliases) to its ref.
 *  An exact canonical name always beats another ref's alias. */
export function buildRefNameIndex<T extends AliasedRef>(refs: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const r of refs) {
    const key = refLookupKey(r.name ?? "");
    if (key && !index.has(key)) index.set(key, r);
  }
  for (const r of refs) {
    for (const a of sanitizeAliases(r.aliases, r.name ?? "")) {
      const key = refLookupKey(a);
      if (key && !index.has(key)) index.set(key, r);
    }
  }
  return index;
}

/** Resolve a cited `@[Name]` tag to its reference by name or alias. */
export function resolveRefByTagName<T extends AliasedRef>(refs: readonly T[], tagName: string): T | undefined {
  const key = refLookupKey(tagName ?? "");
  if (!key) return undefined;
  return buildRefNameIndex(refs).get(key);
}

/** The canonical citable name for a cited tag, or undefined when unmatched. */
export function canonicalRefName(refs: readonly AliasedRef[], tagName: string): string | undefined {
  return resolveRefByTagName(refs, tagName)?.name;
}

/** The canonical name of a *different* reference that already owns `alias`
 *  (as its name or an alias), or null when the alias is free for `selfId`. */
export function refAliasConflict(refs: readonly AliasedRef[], selfId: string | undefined, alias: string): string | null {
  const key = refLookupKey(alias ?? "");
  if (!key) return null;
  for (const r of refs) {
    if (selfId && r.id === selfId) continue;
    if (refLookupKey(r.name ?? "") === key) return r.name;
    if (sanitizeAliases(r.aliases, r.name ?? "").some((a) => refLookupKey(a) === key)) return r.name;
  }
  return null;
}

export function suggestSuiteRefName(prompt: string): string {
  const first = (prompt ?? "").split("\n")[0] ?? "";
  return sanitizeReferenceName(first).slice(0, 48).trim() || "Suite";
}
