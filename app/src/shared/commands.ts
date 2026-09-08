/**
 * Slash-command handling for the chat composer.
 *
 * The chat has no command infrastructure today; the harness RPI loop needs a
 * lightweight way to invoke skills (`/research`, `/plan`, …) and toggle plan
 * mode. This module expands a leading slash command into a plain instruction
 * message, leaving the rest of the pipeline (chat:send) untouched.
 */

export interface SlashCommand {
  /** The command token without the leading "/", lowercased. */
  name: string;
  /** Everything after the command (the args), trimmed. */
  rest: string;
  /** The expanded instruction text sent to the model. */
  instruction: string;
  /** When set, also toggles plan mode to this value (or no-op when undefined). */
  planMode?: boolean;
}

/** The default harness command set (name → template). The token appears in the
 *  template as {rest}; planMode optionally toggles the gate. */
const COMMANDS: Record<string, { template: string; planMode?: boolean }> = {
  research: {
    template:
      "Use the spec:research skill: explore the workspace and produce a spec.md for: {rest}",
  },
  plan: {
    template:
      "Use the spec:plan skill: break the research into a concrete plan.json task list for: {rest}",
    planMode: true,
  },
  implement: {
    template:
      "Use the spec:implement skill: execute the approved plan for: {rest}",
  },
  finish: {
    template:
      "Use the spec:finish skill: validate the whole implementation and run a review pass. {rest}",
  },
  architect: {
    template:
      "Use the oracle:architect skill: give design guidance on component responsibilities for: {rest}",
  },
  challenge: {
    template:
      "Use the oracle:challenge skill: poke holes in the proposed approach for: {rest}",
  },
  review: {
    template: "Use the code:review skill: review the current changes. {rest}",
  },
  commit: {
    template: "Use the code:commit skill: stage and commit the intended changes. {rest}",
  },
};

/**
 * Try to expand a leading slash command in `text`. Returns null when the text
 * isn't a known slash command (so the caller sends it verbatim).
 *
 * Commands are recognized only at the very start of the trimmed text. A
 * "/plan-mode on|off" is handled specially: it toggles plan mode and produces
 * no model instruction (empty string), which the caller uses to flip the gate
 * without sending a message.
 */
export function expandCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const space = trimmed.indexOf(" ");
  const token = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  const rest = (space === -1 ? "" : trimmed.slice(space + 1)).trim();

  if (token === "plan-mode") {
    const on = rest.toLowerCase().startsWith("on") ? true : rest.toLowerCase().startsWith("off") ? false : undefined;
    return { name: "plan-mode", rest, instruction: "", planMode: on };
  }

  const cmd = COMMANDS[token];
  if (!cmd) return null;
  return {
    name: token,
    rest,
    instruction: cmd.template.replace("{rest}", rest),
    planMode: cmd.planMode,
  };
}
