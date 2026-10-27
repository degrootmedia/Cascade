/**
 * Reference usage — the one home for "is this reference in use, and where".
 * The renderer reads it for the in-use node icon on reference tiles and for
 * the delete confirm, so every surface agrees on the verdict.
 *
 * A reference (character, product, or custom) is in use when:
 *  - a prompt store cites it with an `@[Name]` tag (by name or alias,
 *    resolved exactly as generation resolves it — characters shadow
 *    same-named custom references; see the twin rule below for how the
 *    verdict is reported);
 *  - a shot has it attached (`refIds`, `CustomRef.shotIds`, per-ref prompt
 *    overrides) or wired into its node graph (output pipe, node sources,
 *    reference sockets, tween keyframes, stored `ref:` edges);
 *  - it is placed on the reference moodboard (a board node dangles if its
 *    reference is deleted — delete does not prune the board);
 *  - it auto-attaches (style-only / style-category / style-purpose) or Magic
 *    has cast it.
 *
 * Same-name twins share one verdict: pool entries carrying the same
 * canonical name (a character sheet also saved as a custom reference, say)
 * report the union of their uses. Generation resolves the name to one
 * winner, but deletion acts by name too — deleting the shadowed twin
 * strips the winner's `@[Name]` tags from every prompt store and unlinks
 * the image file both entries share — so a twin that looks unused is
 * exactly the accidental-delete hazard above.
 *
 * Bias: over-count. A false icon is harmless; a missing one lets an in-use
 * reference be deleted by accident — the failure this exists to prevent.
 * Generation-node sentinels stored beside real reference ids (`imagegen`,
 * `editgen:<id>`, `ref:seqframe:*`) never count: usage is keyed to ids that
 * exist in the production's reference pool.
 */
import type { GraphSource, Production } from "./ipc.js";
import { isTweenGenKeyframe, isVideoGenRef } from "./ipc.js";
import { refTagNames } from "./prompt-grammar.js";
import { buildRefNameIndex, refLookupKey } from "./ref-names.js";

/** Where one reference is used. Shot lists carry display numbers, sorted. */
export interface ReferenceUsage {
  /** Shots whose prompts cite the reference via an `@[Name]` tag. */
  tagShots: string[];
  /** Shots with the reference attached or wired into a node. */
  wiredShots: string[];
  /** Non-shot uses (style auto-attach, character/style text, Magic cast). */
  other: string[];
}

type UsageMap = Map<string, Set<string>>;

export function referenceUsage(prod: Production): Map<string, ReferenceUsage> {
  const characters = prod.characters ?? [];
  const products = prod.products ?? [];
  const references = prod.references ?? [];
  const pool = [...characters, ...products, ...references];
  const poolIds = new Set(pool.map((r) => r.id));
  const byName = buildRefNameIndex(pool);

  const tag: UsageMap = new Map();
  const wired: UsageMap = new Map();
  const other: UsageMap = new Map();
  const note = (map: UsageMap, id: string | undefined, value: string) => {
    if (!id || !poolIds.has(id)) return;
    let set = map.get(id);
    if (!set) { set = new Set(); map.set(id, set); }
    set.add(value);
  };
  const noteTags = (map: UsageMap, texts: (string | undefined)[], value: string) => {
    for (const text of texts) {
      if (!text) continue;
      for (const name of refTagNames(text)) {
        const ref = byName.get(refLookupKey(name));
        if (ref) note(map, ref.id, value);
      }
    }
  };
  const noteIds = (ids: readonly string[] | undefined, shotNo: string) => {
    for (const id of ids ?? []) note(wired, id, shotNo);
  };
  const noteSource = (source: GraphSource | undefined, shotNo: string) => {
    if (source?.kind === "ref") note(wired, source.refId, shotNo);
  };

  const shots = [
    ...prod.scenes.flatMap((sc) => sc.shots),
    ...(prod.outdatedShots ?? []),
  ];
  const numberByShotId = new Map(shots.map((s) => [s.id, s.number]));

  for (const shot of shots) {
    const no = shot.number;
    noteTags(tag, [
      shot.prompt,
      prod.magicPrompts?.[shot.id],
      shot.graphEditPrompt,
      ...(shot.graphVideoNodes ?? []).map((n) => n.prompt),
      ...(shot.graphEditNodes ?? []).map((n) => n.prompt),
      ...(shot.graphTweenBlocks ?? []).map((b) => b.prompt),
      ...(shot.graphSequence?.segments ?? []).map((seg) => seg.prompt),
    ], no);

    noteIds(shot.refIds, no);
    noteIds(Object.keys(shot.refPromptOverrides ?? {}), no);
    note(wired, shot.graphOutputRefId, no);
    noteSource(shot.graphCameraGrid?.source, no);
    noteSource(shot.graphCameraGrid?.gridSource, no);
    noteIds(shot.graphCameraGrid?.refIds, no);
    noteSource(shot.graphUpscale?.source, no);
    for (const n of shot.graphVideoNodes ?? []) {
      noteSource(n.source, no);
      for (const id of n.refIds ?? []) if (!isVideoGenRef(id)) note(wired, id, no);
    }
    for (const n of shot.graphEditNodes ?? []) noteSource(n.source, no);
    for (const id of shot.graphTweenRefIds ?? []) if (!isTweenGenKeyframe(id)) note(wired, id, no);
    for (const b of shot.graphTweenBlocks ?? []) {
      if (!isTweenGenKeyframe(b.startRefId)) note(wired, b.startRefId, no);
      if (!isTweenGenKeyframe(b.endRefId)) note(wired, b.endRefId, no);
    }
    // Deprecated flat wiring fields: same wiring, pre-migration spelling.
    noteIds(shot.graphVideoRefIds, no);
    note(wired, shot.graphVideoSourceRefId, no);
    note(wired, shot.graphEditSourceRefId, no);
    noteIds(shot.graphEditVideoRefIds, no);
    note(wired, shot.graphEditVideoSourceRefId, no);
    // Stored graph edges are the wiring truth; a `ref:` edge counts when the
    // id is a live reference (seqframe/missing nodes are filtered by pool).
    for (const e of shot.graph?.edges ?? []) {
      if (e.from.node.startsWith("ref:")) note(wired, e.from.node.slice(4), no);
    }
  }

  // The Step 2/3 association stored on the reference side.
  for (const r of references) {
    for (const shotId of r.shotIds ?? []) {
      const no = numberByShotId.get(shotId);
      if (no) note(wired, r.id, no);
    }
  }

  // Prompt stores that aren't tied to one shot.
  noteTags(other, characters.flatMap((c) => [c.key, c.builder?.description]), "cited in character text");
  noteTags(other, (prod.styles ?? []).map((s) => s.prompt), "cited in a style prompt");
  for (const decision of Object.values(prod.magicRefDecisions ?? {})) {
    for (const id of decision.refIds ?? []) note(other, id, "cast by Magic");
  }

  // Auto-attach (the pipeline's `shotReferences` rule, plus an explicit
  // style purpose): uploaded with every submission, tag or not.
  const styleCats = new Set(
    (prod.referenceCategories ?? []).filter((c) => c.kind === "style").map((c) => c.id),
  );
  for (const r of references) {
    if (r.styleOnly === true || r.purpose === "style" || (r.categoryId && styleCats.has(r.categoryId))) {
      note(other, r.id, "auto-attached style reference");
    }
  }

  // Moodboard placements (nodes, plus frame membership for drifted boards
  // whose frame lists a reference its node list lost).
  for (const n of prod.moodboard?.nodes ?? []) note(other, n.refId, "placed on the moodboard");
  for (const f of prod.moodboard?.frames ?? []) {
    for (const id of f.refIds ?? []) note(other, id, "placed on the moodboard");
  }

  const out = new Map<string, ReferenceUsage>();
  for (const r of pool) {
    const t = tag.get(r.id);
    const w = wired.get(r.id);
    const o = other.get(r.id);
    if (!t && !w && !o) continue;
    out.set(r.id, {
      tagShots: [...(t ?? [])].sort(),
      wiredShots: [...(w ?? [])].sort(),
      other: [...(o ?? [])].sort(),
    });
  }

  // Same-name twins share the union of their uses (see header): group the
  // pool by canonical name and give every member of a used group the merged
  // verdict, including members with no direct use of their own.
  const idsByName = new Map<string, string[]>();
  for (const r of pool) {
    const key = refLookupKey(r.name ?? "");
    if (!key) continue;
    const ids = idsByName.get(key);
    if (ids) ids.push(r.id);
    else idsByName.set(key, [r.id]);
  }
  for (const ids of idsByName.values()) {
    if (ids.length < 2) continue;
    const tagShots = new Set<string>();
    const wiredShots = new Set<string>();
    const otherUses = new Set<string>();
    for (const id of ids) {
      const u = out.get(id);
      if (!u) continue;
      u.tagShots.forEach((s) => tagShots.add(s));
      u.wiredShots.forEach((s) => wiredShots.add(s));
      u.other.forEach((s) => otherUses.add(s));
    }
    if (!tagShots.size && !wiredShots.size && !otherUses.size) continue;
    for (const id of ids) {
      out.set(id, {
        tagShots: [...tagShots].sort(),
        wiredShots: [...wiredShots].sort(),
        other: [...otherUses].sort(),
      });
    }
  }
  return out;
}

function shotList(numbers: string[]): string {
  const shown = numbers.slice(0, 4).map((n) => `Shot ${n}`);
  const extra = numbers.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} +${extra} more` : shown.join(", ");
}

/** One-line summary for tooltips and the delete confirm: where it's used. */
export function formatReferenceUsage(usage: ReferenceUsage): string {
  const parts: string[] = [];
  if (usage.wiredShots.length) parts.push(`wired into ${shotList(usage.wiredShots)}`);
  if (usage.tagShots.length) parts.push(`tagged in ${shotList(usage.tagShots)}`);
  parts.push(...usage.other);
  return parts.join(" · ");
}
