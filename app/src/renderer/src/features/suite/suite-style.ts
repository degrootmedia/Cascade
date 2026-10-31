/**
 * Suite style application — pure.
 *
 * The suite's generate flow picks one Design style per submit. Its prompt text
 * becomes the prompt's `Style:` paragraph (replacing any existing one) so the
 * read-only Style preview matches the picker; None clears it. The look frame +
 * LOOK clause are applied main-side at generation (`suite:generate`), so this
 * only owns the text the draft/entry stores.
 *
 * The picker and the paragraph are two views of one fact, so this module also
 * owns their reconciliation: the dropdown value is derived from the style
 * text actually applied to the prompt (never from the pick alone), and a
 * draft whose pick and paragraph disagree is repaired toward the text.
 */
import type { ProductionStyle, SuiteDraft } from "../../../../shared/ipc.js";
import { composePromptBoxes, parsePromptBoxes } from "../../../../shared/prompt-grammar.js";

/** The prompt with `style`'s text as its Style paragraph (or the Style
 *  paragraph removed when `style` is undefined). Never throws on bad input. */
export function withSuiteStyle(prompt: string, style: ProductionStyle | undefined): string {
  const boxes = parsePromptBoxes(prompt ?? "");
  boxes.style = style?.prompt.trim() ?? "";
  return composePromptBoxes(boxes);
}

/** The prompt with its Style paragraph removed (the None pick). */
export function stripSuiteStyle(prompt: string): string {
  return withSuiteStyle(prompt ?? "", undefined);
}

/** A draft made valid for its mode: edit prompts never carry a style at all
 *  (no Style paragraph, no style pick), so an edit draft — switched to,
 *  seeded, replayed, or restored from disk — has any carried-over style
 *  removed here, the one place every path into edit mode passes through.
 *  Generate/upscale drafts pass through untouched. */
export function suiteDraftForMode(draft: SuiteDraft): SuiteDraft {
  if (draft.mode !== "edit") return draft;
  if (!draft.styleId && !parsePromptBoxes(draft.prompt ?? "").style) return draft;
  return { ...draft, prompt: stripSuiteStyle(draft.prompt ?? ""), styleId: undefined };
}

/** Dropdown value for style text that is applied to the prompt but owned by
 *  no Design style (historical text from before a style was edited/deleted).
 *  It exists so the dropdown can truthfully say "a style is applied" — and
 *  choosing None from it is a real change that removes the paragraph. */
export const SUITE_CUSTOM_STYLE_VALUE = "__custom__";

/** What the Style dropdown must show for a generate draft: the style whose
 *  text is actually applied to the prompt. Applied text wins over a stale
 *  pick; a pick with no text yet (a handoff that carried only the id) still
 *  shows its style; unowned applied text shows the Custom sentinel; nothing
 *  applied and nothing picked shows "" (None). */
export function suiteStyleSelectValue(
  prompt: string,
  styleId: string | undefined,
  styles: readonly ProductionStyle[]
): string {
  const applied = parsePromptBoxes(prompt ?? "").style.trim();
  const picked = styleId ? styles.find((s) => s.id === styleId) : undefined;
  if (applied) {
    if (picked && picked.prompt.trim() === applied) return picked.id;
    return styles.find((s) => s.prompt.trim() === applied)?.id ?? SUITE_CUSTOM_STYLE_VALUE;
  }
  return picked?.id ?? "";
}

/** Repair a generate draft whose style pick and Style paragraph disagree,
 *  toward the applied text: adopt the style the text came from, drop a pick
 *  the text no longer matches (unowned text stays, shown as Custom), and
 *  mirror a lone pick's text into the prompt. Returns the same object when
 *  already consistent, and never touches edit/upscale drafts. */
export function reconcileSuiteDraftStyle(
  draft: SuiteDraft,
  styles: readonly ProductionStyle[]
): SuiteDraft {
  if (draft.mode !== "generate") return draft;
  const value = suiteStyleSelectValue(draft.prompt, draft.styleId, styles);
  if (value === SUITE_CUSTOM_STYLE_VALUE || value === "") {
    return draft.styleId === undefined ? draft : { ...draft, styleId: undefined };
  }
  const style = styles.find((s) => s.id === value);
  if (!style) return draft.styleId === undefined ? draft : { ...draft, styleId: undefined };
  const applied = parsePromptBoxes(draft.prompt ?? "").style.trim();
  const prompt = applied === style.prompt.trim() ? draft.prompt : withSuiteStyle(draft.prompt, style);
  if (draft.styleId === style.id && prompt === draft.prompt) return draft;
  return { ...draft, styleId: style.id, prompt };
}
