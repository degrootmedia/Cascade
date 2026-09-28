/**
 * Suite style application — pure.
 *
 * The suite's generate flow picks one Design style per submit. Its prompt text
 * becomes the prompt's `Style:` paragraph (replacing any existing one) so the
 * read-only Style preview matches the picker; None clears it. The look frame +
 * LOOK clause are applied main-side at generation (`suite:generate`), so this
 * only owns the text the draft/entry stores.
 */
import type { ProductionStyle } from "../../../../shared/ipc.js";
import { composePromptBoxes, parsePromptBoxes } from "../../../../shared/prompt-grammar.js";

/** The prompt with `style`'s text as its Style paragraph (or the Style
 *  paragraph removed when `style` is undefined). Never throws on bad input. */
export function withSuiteStyle(prompt: string, style: ProductionStyle | undefined): string {
  const boxes = parsePromptBoxes(prompt ?? "");
  boxes.style = style?.prompt.trim() ?? "";
  return composePromptBoxes(boxes);
}
