/**
 * The no-music instruction for video prompts (Settings → Media & Storage,
 * ON by default). Appended at submission time only — the prompt stored in
 * the project is never modified — to video generation prompts in both the
 * classic view and the node view, across every video backend. Image prompts
 * never pass through here.
 *
 * Wording note: "diegetic sound only" spells out that in-scene effects,
 * ambience, AND dialogue stay allowed — a plainer "diegetic SFX only"
 * could be read by a model as muting dialogue.
 */
export const NO_MUSIC_INSTRUCTION =
  "No music. Do not add any music or musical score. Audio: diegetic sound only — in-scene sound effects, ambience, and dialogue.";

/** True when the prompt already carries the exact instruction. */
export function hasNoMusicInstruction(prompt: string): boolean {
  return typeof prompt === "string" && prompt.includes(NO_MUSIC_INSTRUCTION);
}

/**
 * Append the instruction as its own paragraph. Pure and idempotent:
 * disabled, empty, and already-instructed prompts come back unchanged (an
 * empty prompt stays empty so optional-prompt submits — e.g. Genjutsu —
 * keep omitting `--prompt` instead of gaining one from this feature).
 */
export function appendNoMusicInstruction(prompt: string, enabled: boolean): string {
  if (!enabled || typeof prompt !== "string") return prompt;
  const body = prompt.trimEnd();
  if (!body.trim() || body.includes(NO_MUSIC_INSTRUCTION)) return prompt;
  return `${body}\n\n${NO_MUSIC_INSTRUCTION}`;
}
