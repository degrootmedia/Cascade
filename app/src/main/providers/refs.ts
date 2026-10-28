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
import { isStyleTaggedReference, styleTaggedRefNames } from "../../shared/magic-refs.js";

/** Lowercased names of style-tagged refs (effective purpose `style`:
 *  explicit purpose, `styleOnly`, or a style-kind category). Style-tagged
 *  references are prompt context only and never upload. */
export function styleRefNames(p: Production): Set<string> {
  return styleTaggedRefNames(p);
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
 * `includeVideo` additionally resolves dropped video/audio references from
 * their on-disk file, for video generation where a reference can be a clip
 * or a sound rather than a still. Image generation leaves it off so a
 * video/audio reference is never uploaded to an image model.
 */
export function resolvePromptRefs(
  p: Production,
  prompt: string,
  startToken: number,
  includeVideo = false
): { resolved: string; extras: { name: string; dataUrl: string }[] } {
  const catName = new Map((p.referenceCategories ?? []).map((c) => [c.id, c.name]));
  const catKind = new Map((p.referenceCategories ?? []).map((c) => [c.id, c.kind]));
  const candidates = [
    ...p.characters.map((c) => ({ name: c.name, aliases: c.aliases, media: undefined, styleTagged: false, artwork: refArtworkDataUrl(p, c) })),
    ...p.products.map((pr) => ({ name: pr.name, aliases: pr.aliases, media: undefined, styleTagged: false, artwork: refArtworkDataUrl(p, pr) })),
    ...(p.references ?? []).map((r) => ({
      name: r.name,
      aliases: r.aliases,
      media: r.media,
      styleTagged: isStyleTaggedReference(r, r.categoryId ? catName.get(r.categoryId) ?? "" : "", r.categoryId ? catKind.get(r.categoryId) : undefined),
      artwork:
        includeVideo && r.media
          ? refMediaDataUrl(p, r) ?? refArtworkDataUrl(p, r)
          : refArtworkDataUrl(p, r),
    })),
  ].filter((r): r is { name: string; aliases: string[] | undefined; media: "video" | "audio" | undefined; styleTagged: boolean; artwork: string } => Boolean(r.name && r.artwork));
  const extras: { name: string; dataUrl: string }[] = [];
  const nameToken = new Map<string, string>();
  const byTagName = buildRefNameIndex(candidates);
  let resolved = prompt;
  let token = startToken;
  for (const { tag, name } of refTagMatches(prompt)) {
    const c = byTagName.get(refLookupKey(name));
    if (!c) continue;
    // Style-tagged references never upload. A citation degrades to the
    // bare name so the prompt keeps the style tag as text context, and
    // no upload token is consumed for it.
    if (c.styleTagged) {
      resolved = resolved.replace(tag, c.name);
      continue;
    }
    if (!extras.some((e) => e.name === c.name)) extras.push({ name: c.name, dataUrl: c.artwork });
    if (!nameToken.has(c.name)) nameToken.set(c.name, refToken(token++));
    resolved = resolved.replace(tag, nameToken.get(c.name)!);
  }
  return { resolved, extras };
}

/**
 * Replace @imageN tokens with positionally-anchored phrases. Both vendors
 * bind references from the submitted array by role + order — probed live:
 * Higgsfield (red/green squares → red sky + green lake) and OpenArt
 * (visualReferences with a prompt citing "reference image 1/2" and NO ref
 * ids → same exact result). So each token becomes "<name> (reference image
 * N)" — or "(reference audio N)" for audio — where N is the ref's 1-based
 * position among the submitted refs of its kind. Refs whose upload failed
 * keep just their name — no media
 * exists to anchor to. `submitted` is parallel to `refs`: non-null =
 * made it into the submitted array.
 */
/** True when a submitted reference carries audio (kind rides the data-URL
 *  MIME everywhere downstream; an explicit `media` wins when present). */
export function isAudioRef(r: { media?: "video" | "audio"; dataUrl?: string }): boolean {
  return r.media === "audio" || /^data:audio\//i.test(r.dataUrl ?? "");
}

export function citePrompt(prompt: string, refs: { name: string; media?: "video" | "audio"; dataUrl?: string }[], submitted: (string | null)[], styleNames?: Set<string> | string[]): string {
  let out = prompt;
  const styles = styleNames
    ? new Set([...styleNames].map((s) => String(s).toLowerCase()))
    : null;
  // Citations number per kind: vendors bind each media group from its own
  // array/flag (images visually, audio separately), so an audio reference
  // must neither be called an image nor shift the image numbering.
  const kindPos = (i: number): number => {
    const audio = isAudioRef(refs[i]);
    let pos = 1;
    for (let k = 0; k < i; k++) if (submitted[k] !== null && isAudioRef(refs[k]) === audio) pos++;
    return pos;
  };
  refs.forEach((r, i) => {
    const token = refToken(i);
    if (!out.includes(token)) return;
    if (submitted[i] === null) {
      out = out.split(token).join(r.name);
      return;
    }
    out = out.split(token).join(isAudioRef(r) ? `${r.name} (reference audio ${kindPos(i)})` : `${r.name} (reference image ${kindPos(i)})`);
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
      if (isAudioRef(r)) return;
      const clause = styleOnlyClause(kindPos(i));
      if (!out.includes(clause) && !clauses.includes(clause)) clauses.push(clause);
    });
    if (clauses.length) out = `${clauses.join(" ")}\n\n${out.trimStart()}`;
  }
  return out;
}
