/**
 * Shared prompt-reference resolution for media providers.
 *
 * Moved verbatim out of OpenArtClient: resolving @[name] tags against the
 * production's artwork references is vendor-neutral (both providers upload
 * the cited artwork alongside the shot's frame). One home, imported by each
 * provider and by the IPC handlers that resolve tags before generating.
 */
import { refArtworkDataUrl, refMediaDataUrl, refToken } from "../pipeline.js";
import { refTagMatches } from "../../shared/prompt-grammar.js";
import type { Production } from "../../shared/ipc.js";
import { buildRefNameIndex, refLookupKey } from "../../shared/ref-names.js";
import { STYLE_ONLY_FORBIDDEN, STYLE_ONLY_TRAITS } from "../../shared/prompt-templates.js";

/** Lowercased names of style-only refs: per-ref `styleOnly` override wins,
 *  otherwise the ref's category `kind === "style"` flags it. */
export function styleRefNames(p: Production): Set<string> {
  const styleCats = new Set(
    (p.referenceCategories ?? []).filter((c) => c.kind === "style").map((c) => c.id)
  );
  const out = new Set<string>();
  for (const r of p.references ?? []) {
    if (r.styleOnly === true || (r.categoryId && styleCats.has(r.categoryId))) {
      out.add(r.name.toLowerCase());
    }
  }
  return out;
}

/** The style-only clause emitted once per style ref (cites its @imageN token
 *  position). Built from the same trait/forbidden fragments as the LOOK
 *  clause so a style frame and a style reference are fenced identically.
 *  Survives `stripReferenceClause` (that only strips the legacy
 *  "Reference images by id" alias) by design. */
export function styleOnlyClause(imagePos: number): string {
  return (
    `Reference image ${imagePos} — STYLE ONLY: use it solely for its ${STYLE_ONLY_TRAITS}. ` +
    `STRICT: do not copy, include, or reproduce anything depicted in reference image ${imagePos} — ` +
    `none of its ${STYLE_ONLY_FORBIDDEN} may appear. ` +
    `Depict only what the rest of this prompt describes; wherever this prompt conflicts ` +
    `with reference image ${imagePos}, the prompt wins.`
  );
}

/**
 * Resolve @[name] tags in a prompt against the production's artwork
 * references. Returns the prompt with tags replaced by portable tokens
 * (@imageN) plus the referenced images, ready to upload alongside the
 * shot's frame. `startToken` is the token index to begin at — the shot's
 * own frame always occupies @image1.
 *
 * `includeVideo` additionally resolves dropped video references from their
 * on-disk file, for video generation where a reference can be a clip rather
 * than a still. Image generation leaves it off so a video is never uploaded
 * to an image model.
 */
export function resolvePromptRefs(
  p: Production,
  prompt: string,
  startToken: number,
  includeVideo = false
): { resolved: string; extras: { name: string; dataUrl: string }[] } {
  const candidates = [
    ...p.characters.map((c) => ({ name: c.name, aliases: c.aliases, artwork: refArtworkDataUrl(p, c) })),
    ...p.products.map((pr) => ({ name: pr.name, aliases: pr.aliases, artwork: refArtworkDataUrl(p, pr) })),
    ...(p.references ?? []).map((r) => ({
      name: r.name,
      aliases: r.aliases,
      artwork:
        includeVideo && r.media === "video"
          ? refMediaDataUrl(p, r) ?? refArtworkDataUrl(p, r)
          : refArtworkDataUrl(p, r),
    })),
  ].filter((r): r is { name: string; aliases: string[] | undefined; artwork: string } => Boolean(r.name && r.artwork));
  const extras: { name: string; dataUrl: string }[] = [];
  const nameToken = new Map<string, string>();
  const byTagName = buildRefNameIndex(candidates);
  let resolved = prompt;
  let token = startToken;
  for (const { tag, name } of refTagMatches(prompt)) {
    const c = byTagName.get(refLookupKey(name));
    if (!c) continue;
    if (!extras.some((e) => e.name === c.name)) extras.push({ name: c.name, dataUrl: c.artwork });
    if (!nameToken.has(c.name)) nameToken.set(c.name, refToken(token++));
    resolved = resolved.replace(tag, nameToken.get(c.name)!);
  }
  // Style-only refs auto-attach: no @[Name] tag required. Stable order after
  // content refs, deduped by name (a tag-cited style ref is cited once).
  const styles = styleRefNames(p);
  if (styles.size) {
    for (const c of candidates) {
      if (!styles.has(c.name.toLowerCase())) continue;
      if (extras.some((e) => e.name.toLowerCase() === c.name.toLowerCase())) continue;
      extras.push({ name: c.name, dataUrl: c.artwork });
      if (!nameToken.has(c.name)) nameToken.set(c.name, refToken(token++));
    }
  }
  return { resolved, extras };
}

/**
 * Replace @imageN tokens with positionally-anchored phrases. Both vendors
 * bind references from the submitted array by role + order — probed live:
 * Higgsfield (red/green squares → red sky + green lake) and OpenArt
 * (visualReferences with a prompt citing "reference image 1/2" and NO ref
 * ids → same exact result). So each token becomes "<name> (reference image
 * N)" where N is the ref's 1-based position among the refs actually
 * submitted. Refs whose upload failed keep just their name — no media
 * exists to anchor to. `submitted` is parallel to `refs`: non-null =
 * made it into the submitted array.
 */
export function citePrompt(prompt: string, refs: { name: string }[], submitted: (string | null)[], styleNames?: Set<string> | string[]): string {
  let out = prompt;
  const styles = styleNames
    ? new Set([...styleNames].map((s) => String(s).toLowerCase()))
    : null;
  refs.forEach((r, i) => {
    const token = refToken(i);
    if (!out.includes(token)) return;
    if (submitted[i] === null) {
      out = out.split(token).join(r.name);
      return;
    }
    // 1-based slot among the successfully submitted refs (submission order).
    let pos = 1;
    for (let k = 0; k < i; k++) if (submitted[k] !== null) pos++;
    out = out.split(token).join(`${r.name} (reference image ${pos})`);
  });
  // Style-only clauses: once per submitted style ref, referencing its
  // @imageN slot, placed FIRST in the wire prompt. They used to trail at the
  // very end, where the shot description in between let the style image's
  // own content win; a phrase-level dedupe also suppressed every clause
  // after the first. Per-clause dedupe keeps a re-cite from stacking copies
  // while still giving every style ref its own clause.
  if (styles) {
    const clauses: string[] = [];
    refs.forEach((r, i) => {
      if (!styles.has(r.name.toLowerCase())) return;
      if (submitted[i] === null) return;
      let pos = 1;
      for (let k = 0; k < i; k++) if (submitted[k] !== null) pos++;
      const clause = styleOnlyClause(pos);
      if (!out.includes(clause) && !clauses.includes(clause)) clauses.push(clause);
    });
    if (clauses.length) out = `${clauses.join(" ")}\n\n${out.trimStart()}`;
  }
  return out;
}
