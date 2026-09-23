/**
 * Style and brand as references (master plan step 04).
 *
 * REFERENCE MODEL (step 04 T1 — edges preferred, documented choice):
 * - Attachment is an EDGE: `style`/`brand` node → the prompt node's
 *   `in-style`/`in-brand` port (step-03 tables). No consumer stores a copy.
 * - The style AUTHORITY is the library: `production.styles`, selected per
 *   shot by the existing `shot.style` id (`shot.styleNone` = none). The graph
 *   does not carry a second style id and no new id field exists — the edge
 *   says "plugged", the shot selection says "which", the library says "what".
 *   Editing a library entry re-renders every plugged consumer on next read.
 * - The brand AUTHORITY is `production.brand` (production-scoped singleton);
 *   the brand node carries no data.
 * - `GraphNode.data` gains nothing: topology + positions stay the graph's
 *   only owned state until step 05 moves prompts in.
 *
 * RENDERING (not mirroring): `renderPromptText` is the single place
 * style/brand text enters a prompt — display and submission both call it.
 * Nothing rewrites a stored prompt to keep it in sync. Component order is
 * fixed: Style, Brand (palette then typeface, one paragraph), Content,
 * References (inline `@[tag]`s, untouched here — step 05 owns them).
 *
 * OVERRIDES ARE EXPLICIT: a detached prompt renders its stored text, so
 *  custom prose survives untouched — with one sharp edge: a hand-typed
 *  `Brand identity:` paragraph still strips at read (the marker is the legacy
 *  plug signal, indistinguishable from a copy). Override brand wording without
 *  the marker, or re-attach. `Style:` prose while detached is preserved
 *  verbatim (the style mirror never stripped unplugged text).
 */
import type { Graph, Production, ProductionShot } from "../ipc.js";
import { brandClauseText } from "../look.js";
import { promptNodeId, type PromptNodeTarget } from "./connect.js";
import {
  hasBrandParagraph,
  refTagNames,
  removeRefTag,
  stripBrandParagraph,
  stripStyleParagraph,
} from "../prompt-grammar.js";

/** Which prompt node of a shot is being rendered. */
export type StylePromptTarget = PromptNodeTarget;

export { promptNodeId };

/** Stored content per prompt target (may carry legacy pasted paragraphs). */
export function promptContent(shot: ProductionShot, target: StylePromptTarget): string {
  if (target === "composer") return shot.prompt ?? "";
  if (target === "videoprompt") return shot.graphVideoPrompt ?? "";
  if (target === "editvideoprompt") return shot.graphEditVideoPrompt ?? "";
  return (shot.graphEditNodes ?? []).find((n) => n.id === target.editprompt)?.prompt ?? "";
}

/** True when the style node plugs into the target (edge present). */
export function styleEdgePresent(graph: Graph, target: StylePromptTarget): boolean {
  const node = promptNodeId(target);
  return graph.edges.some((e) => e.from.node === "style" && e.to.node === node && e.to.port === "in-style");
}

/** True when the brand node plugs into the target (edge present). */
export function brandEdgePresent(graph: Graph, target: StylePromptTarget): boolean {
  const node = promptNodeId(target);
  return graph.edges.some((e) => e.from.node === "brand" && e.to.node === node && e.to.port === "in-brand");
}

function styleFlagFor(shot: ProductionShot, target: StylePromptTarget): boolean | undefined {
  if (target === "composer") return shot.graphStyleConnected;
  if (target === "videoprompt") return shot.graphVideoStyleConnected;
  if (target === "editvideoprompt") return undefined;
  return (shot.graphEditNodes ?? []).find((n) => n.id === target.editprompt)?.styleConnected;
}

/**
 * Attachment decision with legacy fallback: a stored graph decides by edge;
 * a graph-less shot falls back to the old rule (flag, else paragraph) so
 * boards render identically before first open. Never throws on missing data.
 */
export function isStyleAttached(shot: ProductionShot, target: StylePromptTarget, contentText: string): boolean {
  if (shot.graph) return styleEdgePresent(shot.graph, target);
  return styleFlagFor(shot, target) ?? /^Style:/m.test(contentText ?? "");
}

/** Brand equivalent: legacy fallback is paragraph presence or the
 *  shot-level opt-in flag — except an explicit false, which detaches
 *  (remembered plug, mirroring the style rule). Auto prompts carry no
 *  paragraph, so the flag is their only legacy signal. */
export function isBrandAttached(shot: ProductionShot, target: StylePromptTarget, contentText: string): boolean {
  if (shot.graph) return brandEdgePresent(shot.graph, target);
  if (shot.includeBrandIdentity === false) return false;
  return hasBrandParagraph(contentText ?? "") || shot.includeBrandIdentity === true;
}

/** The shared style text a shot resolves under (node-flow resolver: the
 *  selected library entry's prompt, "" when none). Mirrors the graph's
 *  liveStyleText — no visualStyle fallback (that belongs to the auto board
 *  flow, which keeps its own resolver). */
export function resolveNodeStyleText(p: Production, shot: ProductionShot): string {
  if (shot.styleNone) return "";
  const id = shot.style ?? p.styles?.[0]?.id ?? "";
  return (p.styles ?? []).find((s) => s.id === id)?.prompt.trim() ?? "";
}

/** Strip shared sections from stored text (write-back + render defense). */
export function stripSharedSections(text: string): string {
  return stripStyleParagraph(stripBrandParagraph(text ?? ""));
}

export interface RenderRefs {
  /** Style plug present (edge, or legacy fallback). */
  styleAttached: boolean;
  /** Resolved shared style text ("" when the library resolves nothing). */
  styleText: string;
  /** Brand plug present (edge, or legacy fallback). */
  brandAttached: boolean;
  /** Resolved brand clause ("" when the brand set is empty). */
  brand: string;
}

/** Resolve what a prompt target plugs into. Attached-but-empty resolves to
 *  "" (the section strips, matching the legacy mirror) — distinct from
 *  detached, which renders stored text verbatim. */
export function promptRefsFor(p: Production, shot: ProductionShot, target: StylePromptTarget): RenderRefs {
  const content = promptContent(shot, target);
  const styleAttached = isStyleAttached(shot, target, content);
  const brandAttached = isBrandAttached(shot, target, content);
  return {
    styleAttached,
    styleText: styleAttached ? resolveNodeStyleText(p, shot) : "",
    brandAttached,
    brand: brandAttached ? brandClauseText(p.brand) : "",
  };
}

/**
 * The single renderer: shared sections in the fixed required order (Style,
 * Brand, Content — references ride inline in content). Fully detached prompts
 * render verbatim, except the legacy brand-off defense: an explicit false
 * strips a leftover Brand paragraph at read (the style mirror never did, so
 * style prose stays). Composition is raw (no whitespace normalization) so
 * rendering a well-formed legacy prompt is byte-identical. Idempotent.
 */
export function renderPromptText(content: string, refs: RenderRefs): string {
  if (!refs.styleAttached && !refs.brandAttached) return stripBrandParagraph(content);
  const stripped = stripSharedSections(content).trim();
  const paras: string[] = [];
  const style = refs.styleText.trim();
  if (refs.styleAttached && style) paras.push(`Style: ${style}`);
  const brand = refs.brand.trim();
  if (refs.brandAttached && brand) paras.push(`Brand identity: ${brand}`);
  if (stripped) paras.push(stripped);
  return paras.join("\n\n");
}

/** Every reference id → name in a production (characters → products →
 *  custom refs), for tag reconciliation. */
function referenceNameById(p: Production): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of p.characters ?? []) if (c.id && c.name) m.set(c.id, c.name);
  for (const pr of p.products ?? []) if (pr.id && pr.name) m.set(pr.id, pr.name);
  for (const r of p.references ?? []) if (r.id && r.name) m.set(r.id, r.name);
  return m;
}

/** Attached reference ids for one prompt node, in socket order — from the
 *  stored graph's ref edges. Empty when the shot has no graph (legacy: tags). */
export function attachedRefIds(shot: ProductionShot, target: StylePromptTarget): string[] {
  const graph = shot.graph;
  if (!graph) return [];
  const node = promptNodeId(target);
  return graph.edges
    .filter((e) => e.to.node === node && /^in-ref-(\d+)$/.test(e.to.port) && e.from.node.startsWith("ref:"))
    .sort((a, b) => Number(/^in-ref-(\d+)$/.exec(a.to.port)![1]) - Number(/^in-ref-(\d+)$/.exec(b.to.port)![1]))
    .map((e) => e.from.node.slice(4));
}

/**
 * Reconcile the emitted `@[Name]` tags to the prompt node's reference edges
 * (step 05 T2): attached refs are always cited, and tags for production
 * references that are not attached to this prompt drop out. Dangling tags
 * (no matching reference) are prose and stay. Only runs when the shot has a
 * graph — legacy shots keep tag-driven output until migrated. Tags become an
 * output format; the graph is the attachment authority.
 */
export function reconcileRefTags(p: Production, shot: ProductionShot, target: StylePromptTarget, text: string): string {
  if (!shot.graph) return text;
  const attachedIds = attachedRefIds(shot, target);
  const nameById = referenceNameById(p);
  // Name-based comparison: a character and its mirrored reference share a
  // name but not an id, so id equality would wrongly drop the tag.
  const knownNames = new Set([...nameById.values()].map((n) => n.toLowerCase()));
  const attachedNames = attachedIds.map((id) => nameById.get(id)).filter((n): n is string => Boolean(n));
  const attachedLc = new Set(attachedNames.map((n) => n.toLowerCase()));

  let out = text;
  for (const name of refTagNames(out)) {
    const lc = name.toLowerCase();
    if (knownNames.has(lc) && !attachedLc.has(lc)) out = removeRefTag(out, name);
  }
  // References come AFTER Content in the required component order, so an
  // attached-but-uncited ref appends at the very end (not before a Brand
  // paragraph, which would violate Style → Brand → Content → References).
  for (const name of attachedNames) {
    if (refTagNames(out).some((n) => n.toLowerCase() === name.toLowerCase())) continue;
    const trimmed = out.trimEnd();
    out = trimmed ? `${trimmed}\n\n@[${name}]` : `@[${name}]`;
  }
  return out;
}

/** Render one stored prompt node (display + submission share this). */
export function renderShotPrompt(p: Production, shot: ProductionShot, target: StylePromptTarget): string {
  const base = renderPromptText(promptContent(shot, target), promptRefsFor(p, shot, target));
  return reconcileRefTags(p, shot, target, base);
}
