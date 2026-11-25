/**
 * Feature #29: the Chat tab glows when the agent needs the user — its turn
 * ended (finished, asked a question, or stopped) or it hit an error — while
 * the chat is not the visible view. Working events never start a glow, and
 * showing the chat clears it. Pure, so the rules are unit-tested.
 */
import type { AgentEventIpc } from "../../../shared/ipc.js";

/** null = no glow; "waiting" = turn ended normally (done or asked a
 *  question); "error" = the turn stopped on an error (distinct tint). */
export type ChatAttention = null | "waiting" | "error";

export function chatAttentionAfterEvent(
  prev: ChatAttention,
  event: Pick<AgentEventIpc, "type">,
  chatVisible: boolean
): ChatAttention {
  // The user can already see the agent's message.
  if (chatVisible) return null;
  if (event.type === "error") return "error";
  // An error tint is kept if the turn's final "done" follows the error.
  if (event.type === "agent-done") return prev === "error" ? "error" : "waiting";
  // Streaming text, tool calls, notices: the agent is busy, not waiting.
  return prev;
}

/** Tooltip for the glowing tab. */
export function chatAttentionTitle(a: ChatAttention): string | undefined {
  if (a === "waiting") return "The agent has stopped and is waiting for you";
  if (a === "error") return "The agent stopped on an error";
  return undefined;
}
