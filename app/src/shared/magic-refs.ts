/**
 * Magic Prompt reference bookkeeping shared by main (generation + validation)
 * and the renderer (the reconciliation queue). Pure and dependency-free
 * (types + prompt grammar + the alias resolver only) so both sides agree on
 * what "this cited name resolves" means.
 */
import type { CustomRef, MagicBibleEntity, MagicUnresolvedRef, Production, ReferencePurpose } from "./ipc.js";
import { refTagMatches, renameRefTag } from "./prompt-grammar.js";
import { canonicalRefName, refLookupKey, resolveRefByTagName, sanitizeAliases } from "./ref-names.js";

/** One citable reference in the production's roster, with the context the
 *  Magic passes need to cite it correctly. Order is the canonical citation
 *  order: characters → products → custom references. */
export interface MagicRefRosterEntry {
  id: string;
  name: string;
  kind: "character" | "product" | "reference";
  /** One-line visual descriptor (character `key`/builder text) when known. */
  descriptor: string;
  aliases: string[];
  /** True when citing it will actually upload an image. */
  hasArtwork: boolean;
  /** Style-tagged refs are LLM context only and never upload; content
   *  prompts never cite them. */
  styleOnly: boolean;
  category?: string;
  /** Effective purpose (explicit, else inferred from strong name/category
   *  signals, else `subject`). Characters/products are always `subject`. */
  purpose: ReferencePurpose;
  /** True when `purpose` was inferred rather than set by the user. */
  purposeInferred: boolean;
}

/** Strong-signal purpose inference from a reference's name + category.
 *  Deliberately narrow: only unambiguous signals (blockout/layout/style/
 *  lookdev/mood/environment words) override the `subject` default — a
 *  Blender blockout category must never be cast as a subject, but an
 *  ordinary name like "Gondola" stays a subject. */
export function inferReferencePurpose(name: string, categoryName = "", categoryKind?: string, styleOnly?: boolean): ReferencePurpose {
  if (styleOnly || categoryKind === "style") return "style";
  const text = ` ${name} ${categoryName} `.toLowerCase();
  const has = (...words: string[]): boolean => words.some((w) => text.includes(w));
  if (has("blockout", "block-out", "layout", "blender", "previz", "pre-viz", "plate")) return "layout";
  if (has("lookdev", "look dev", "look-dev", "style frame", "style image")) return "style";
  if (has("moodboard", "mood board", "inspiration", "inspo")) return "inspiration";
  if (has("environment", "location", "backdrop", "set design")) return "environment";
  return "subject";
}

/** Magic may auto-cast/cite only subjects and environments. Layout,
 *  style, and inspiration refs still resolve when the USER cites them. */
export function isMagicCitablePurpose(purpose: ReferencePurpose): boolean {
  return purpose === "subject" || purpose === "environment";
}

/** A reference's effective purpose: the explicit user choice when set,
 *  else strong-signal inference. An explicit purpose always wins — over
 *  inference and over a stale `styleOnly` flag left behind when the user
 *  changed the purpose away from style. */
export function effectiveReferencePurpose(
  r: Pick<CustomRef, "name" | "purpose" | "styleOnly">,
  categoryName = "",
  categoryKind?: string
): ReferencePurpose {
  return r.purpose ?? inferReferencePurpose(r.name, categoryName, categoryKind, r.styleOnly);
}

/** True when a custom reference is style-tagged (effective purpose
 *  `style`). Style-tagged references are prompt/LLM context only: their
 *  files must never be uploaded with a generation payload. Characters and
 *  products carry no purpose and are never style-tagged. */
export function isStyleTaggedReference(
  r: Pick<CustomRef, "name" | "purpose" | "styleOnly">,
  categoryName = "",
  categoryKind?: string
): boolean {
  return effectiveReferencePurpose(r, categoryName, categoryKind) === "style";
}

function categoryLookups(p: Production): { catName: Map<string, string>; catKind: Map<string, string | undefined> } {
  return {
    catName: new Map((p.referenceCategories ?? []).map((c) => [c.id, c.name])),
    catKind: new Map((p.referenceCategories ?? []).map((c) => [c.id, c.kind])),
  };
}

/** Ids of the production's style-tagged custom references. */
export function styleTaggedRefIds(p: Production): Set<string> {
  const { catName, catKind } = categoryLookups(p);
  const out = new Set<string>();
  for (const r of p.references ?? []) {
    if (isStyleTaggedReference(r, r.categoryId ? catName.get(r.categoryId) ?? "" : "", r.categoryId ? catKind.get(r.categoryId) : undefined)) out.add(r.id);
  }
  return out;
}

/** Lowercased names of the production's style-tagged custom references. */
export function styleTaggedRefNames(p: Production): Set<string> {
  const { catName, catKind } = categoryLookups(p);
  const out = new Set<string>();
  for (const r of p.references ?? []) {
    if (isStyleTaggedReference(r, r.categoryId ? catName.get(r.categoryId) ?? "" : "", r.categoryId ? catKind.get(r.categoryId) : undefined)) out.add(r.name.toLowerCase());
  }
  return out;
}

/** The production's full citable roster (deduplicated by canonical name,
 *  first occurrence wins — the same precedence as tag resolution). */
export function magicRefRoster(p: Production): MagicRefRosterEntry[] {
  const out: MagicRefRosterEntry[] = [];
  const seen = new Set<string>();
  const catName = new Map((p.referenceCategories ?? []).map((c) => [c.id, c.name]));
  const catKind = new Map((p.referenceCategories ?? []).map((c) => [c.id, c.kind]));
  const push = (e: MagicRefRosterEntry): void => {
    const key = refLookupKey(e.name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  for (const c of p.characters ?? []) {
    push({
      id: c.id,
      name: c.name,
      kind: "character",
      descriptor: (c.key || c.builder?.description || "").trim(),
      aliases: sanitizeAliases(c.aliases, c.name),
      hasArtwork: Boolean(c.artwork || c.imagePath),
      styleOnly: false,
      purpose: "subject",
      purposeInferred: false,
    });
  }
  for (const pr of p.products ?? []) {
    push({
      id: pr.id,
      name: pr.name,
      kind: "product",
      descriptor: "",
      aliases: sanitizeAliases(pr.aliases, pr.name),
      hasArtwork: Boolean(pr.artwork || pr.imagePath),
      styleOnly: false,
      purpose: "subject",
      purposeInferred: false,
    });
  }
  for (const r of p.references ?? []) {
    const category = r.categoryId ? catName.get(r.categoryId) : undefined;
    const purpose: ReferencePurpose = effectiveReferencePurpose(r, category ?? "", r.categoryId ? catKind.get(r.categoryId) : undefined);
    push({
      id: r.id,
      name: r.name,
      kind: "reference",
      descriptor: (r.visualSummary ?? "").trim(),
      aliases: sanitizeAliases(r.aliases, r.name),
      hasArtwork: Boolean(r.artwork || r.imagePath || r.mediaPath),
      styleOnly: purpose === "style",
      category,
      purpose,
      purposeInferred: !r.purpose,
    });
  }
  return out;
}

/** Resolve a cited name against the roster (canonical name or alias). */
export function resolveRosterRef(roster: readonly MagicRefRosterEntry[], citedName: string): MagicRefRosterEntry | undefined {
  return resolveRefByTagName(roster, citedName);
}

/** Words in a name/descriptor, split on punctuation and camelCase humps. */
function nameTokens(text: string): string[] {
  return (text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Deterministically suggest an existing reference for an unmatched cited
 * name: token overlap with the canonical name (strong), its aliases, and its
 * descriptor (weak), plus substring containment. Returns the canonical name
 * only when one entry is the clear winner — a wrong suggestion is worse
 * than none, and the user always confirms in the queue.
 */
export function suggestRefForCitedName(
  roster: readonly MagicRefRosterEntry[],
  citedName: string,
  hintText = ""
): string | undefined {
  const citedTokens = new Set([...nameTokens(citedName), ...nameTokens(hintText)]);
  if (!citedTokens.size) return undefined;
  const citedKey = refLookupKey(citedName).replace(/\s+/g, "");
  let best: { name: string; score: number } | undefined;
  let tied = false;
  for (const e of roster) {
    let score = 0;
    for (const t of nameTokens(e.name)) if (citedTokens.has(t)) score += 3;
    for (const a of e.aliases) for (const t of nameTokens(a)) if (citedTokens.has(t)) score += 2;
    for (const t of nameTokens(e.descriptor)) if (citedTokens.has(t)) score += 1;
    const nameKey = refLookupKey(e.name).replace(/\s+/g, "");
    if (citedKey && nameKey && (citedKey.includes(nameKey) || nameKey.includes(citedKey))) score += 2;
    if (!score) continue;
    if (!best || score > best.score) { best = { name: e.name, score }; tied = false; }
    else if (score === best.score) tied = true;
  }
  return best && !tied && best.score >= 2 ? best.name : undefined;
}

/**
 * Rewrite alias tags in a prompt to their canonical `@[Name]` form and
 * report the cited names that resolve to nothing. Pure; the input text is
 * only changed where an alias tag actually appears.
 */
export function canonicalizeMagicPromptTags(
  roster: readonly MagicRefRosterEntry[],
  text: string
): { text: string; unresolved: string[] } {
  let out = text;
  const unresolved: string[] = [];
  const seenUnresolved = new Set<string>();
  for (const { name } of refTagMatches(text)) {
    const canonical = canonicalRefName(roster, name);
    if (!canonical) {
      const key = refLookupKey(name);
      if (key && !seenUnresolved.has(key)) { seenUnresolved.add(key); unresolved.push(name); }
      continue;
    }
    if (canonical !== name) out = renameRefTag(out, name, canonical);
  }
  return { text: out, unresolved };
}

/** One Cast & Sets review row: a bible entity the script needs, what it is
 *  for, and what (if anything) depicts it. Pure view over bible + decisions. */
export interface MagicCastNeed {
  entityName: string;
  kind: MagicBibleEntity["kind"];
  descriptor: string;
  /** Display shot numbers where this entity appears (storyboard order). */
  shotNumbers: string[];
  /** Canonical reference names currently mapped to it. */
  refNames: string[];
  boundBy?: "user" | "model" | "auto";
  confidence?: "high" | "medium" | "low";
  bindReason?: string;
  status: "ready" | "review" | "unmapped" | "text-only" | "pending-create";
  /** Set when a mapped reference's purpose can't play this role. */
  purposeWarning?: string;
}

/** The Cast & Sets list for the review UI, in bible order. */
export function magicCastNeeds(p: Production): MagicCastNeed[] {
  const bible = p.magicBible;
  if (!bible) return [];
  const roster = magicRefRoster(p);
  const rosterByName = new Map(roster.map((e) => [refLookupKey(e.name), e]));
  const decisions = new Map<string, NonNullable<Production["magicRefDecisions"]>[string]>();
  for (const [k, d] of Object.entries(p.magicRefDecisions ?? {})) if (d) { decisions.set(refLookupKey(k), d); decisions.set(refLookupKey(d.entityName), d); }
  const shotsFor = (e: MagicBibleEntity): string[] => {
    const keys = new Set([refLookupKey(e.name), ...(e.aliases ?? []).map(refLookupKey)]);
    const out: string[] = [];
    for (const plan of bible.shotPlans) {
      if ((plan.present ?? []).some((n) => keys.has(refLookupKey(n)))) out.push(plan.number);
    }
    return out;
  };
  const needs: MagicCastNeed[] = [];
  for (const e of bible.entities) {
    if (e.kind === "other") continue;
    const decision = decisions.get(refLookupKey(e.name)) ?? (e.aliases ?? []).map((a) => decisions.get(refLookupKey(a))).find(Boolean);
    const refNames = e.refNames?.length ? e.refNames : e.refName ? [e.refName] : [];
    let purposeWarning: string | undefined;
    for (const n of refNames) {
      const entry = rosterByName.get(refLookupKey(n));
      if (entry && !isMagicCitablePurpose(entry.purpose)) {
        purposeWarning = `@[${n}] is marked ${entry.purpose} — it can't play this subject. Pick another reference.`;
        break;
      }
    }
    let status: MagicCastNeed["status"];
    // A user mapping is only "ready" once explicitly confirmed ("Looks
    // right"); editing the mapping (add/remove a ref) un-confirms it.
    // Legacy decisions predate the flag and count as confirmed.
    const userConfirmed = e.boundBy === "user" && (e.confirmed === true || (e.confirmed === undefined && decision?.confirmed !== false && decision !== undefined) || decision?.confirmed === true);
    if (decision?.textOnly) status = "text-only";
    else if (decision?.pendingCreate && !refNames.length) status = "pending-create";
    else if (!refNames.length) status = "unmapped";
    else if (purposeWarning) status = "review";
    else if (decision?.confirmed === false) status = "review";
    else if (userConfirmed || (e.boundBy === "model" && e.confidence === "high")) status = "ready";
    else status = "review";
    needs.push({
      entityName: e.name, kind: e.kind, descriptor: e.descriptor,
      shotNumbers: shotsFor(e), refNames,
      boundBy: e.boundBy, confidence: e.confidence, bindReason: e.bindReason,
      status, ...(purposeWarning ? { purposeWarning } : {}),
    });
  }
  return needs;
}

/** How many cast decisions still need the user (badge counts). */
export function magicCastReviewCount(p: Production): number {
  return magicCastNeeds(p).filter((n) => n.status === "review" || n.status === "unmapped" || n.status === "pending-create").length;
}

/**
 * Every cited name in the production's Magic prompts that no reference
 * resolves, grouped with the shots citing it (storyboard order). Dismissed
 * names are excluded. Each entry carries a deterministic suggestion the
 * reconciliation queue can pre-select (never auto-applied).
 */
export function computeUnresolvedMagicRefs(p: Production): MagicUnresolvedRef[] {
  const roster = magicRefRoster(p);
  const dismissed = new Set((p.magicDismissedRefs ?? []).map((n) => refLookupKey(n)));
  const hints = new Map<string, string>();
  for (const e of p.magicBible?.entities ?? []) hints.set(refLookupKey(e.name), e.descriptor);
  const byKey = new Map<string, MagicUnresolvedRef>();
  for (const scene of p.scenes ?? []) {
    for (const shot of scene.shots) {
      const text = p.magicPrompts?.[shot.id] ?? "";
      if (!text) continue;
      for (const { name } of refTagMatches(text)) {
        if (canonicalRefName(roster, name)) continue;
        const key = refLookupKey(name);
        if (!key || dismissed.has(key)) continue;
        let entry = byKey.get(key);
        if (!entry) {
          entry = {
            citedName: name,
            shotNumbers: [],
            suggestedRefName: suggestRefForCitedName(roster, name, hints.get(key) ?? ""),
          };
          if (!entry.suggestedRefName) delete entry.suggestedRefName;
          byKey.set(key, entry);
        }
        if (!entry.shotNumbers.includes(shot.number)) entry.shotNumbers.push(shot.number);
      }
    }
  }
  return [...byKey.values()];
}
