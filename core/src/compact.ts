/**
 * Context compaction: when the conversation grows past a character budget,
 * older turns are replaced by a model-written summary so long sessions don't
 * blow the context window (or the credit budget — providers without prompt
 * caching resend the whole history every turn).
 */
import { ChatClient } from "./chat.js";
import { contentText, type ChatMessage } from "./types.js";

/** ~4 chars/token heuristic; 120k chars ≈ 30k tokens, safe for all our chat models. */
export const DEFAULT_CHAR_BUDGET = 120_000;

/** Never summarize away the most recent turns. */
const KEEP_RECENT = 8;

export function historySize(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += typeof m.content === "string" ? m.content.length : m.content ? JSON.stringify(m.content).length : 0;
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  }
  return n;
}

export interface CompactionPlan {
  /** Messages to summarize (excludes system prompt). */
  toSummarize: ChatMessage[];
  /** Messages kept verbatim (system prompt + recent turns). */
  keep: ChatMessage[];
}

/**
 * Decide what to compact. Returns null when under budget or when there's
 * nothing old enough to fold. Never splits a tool-call/tool-result pair:
 * the cut point is moved earlier until it lands after a completed exchange.
 */
export function planCompaction(messages: ChatMessage[], budget = DEFAULT_CHAR_BUDGET): CompactionPlan | null {
  if (historySize(messages) <= budget) return null;
  const [system, ...rest] = messages;
  if (rest.length <= KEEP_RECENT) return null;

  let cut = rest.length - KEEP_RECENT;
  // Don't cut between an assistant tool_calls message and its tool results.
  while (cut > 0 && rest[cut].role === "tool") cut--;
  if (cut <= 0) return null;

  return { toSummarize: rest.slice(0, cut), keep: [system, ...rest.slice(cut)] };
}

export function summaryPrompt(toSummarize: ChatMessage[]): ChatMessage[] {
  const transcript = toSummarize
    .map((m) => {
      if (m.role === "tool") return `[tool result] ${contentText(m.content).slice(0, 400)}`;
      const calls = m.tool_calls?.map((c) => `${c.function.name}(${c.function.arguments.slice(0, 200)})`).join(", ");
      return `[${m.role}]${calls ? ` called: ${calls}` : ""} ${contentText(m.content).slice(0, 1000)}`;
    })
    .join("\n");
  return [
    {
      role: "user",
      content:
        "Summarize this agent conversation transcript in under 300 words. Preserve: what the user asked for, " +
        "what files were created/modified (with paths), key decisions, and any unfinished work. " +
        "Write it as context notes for the agent to continue the conversation.\n\n" +
        transcript,
    },
  ];
}

/** Build the replacement message that stands in for the summarized turns. */
export function summaryMessage(summary: string): ChatMessage {
  return {
    role: "user",
    content: `[Conversation summary — earlier turns were compacted to save context]\n${summary}`,
  };
}

/** Build the cheap-model prompt that derives a short chat title from the transcript. */
export function titlePrompt(messages: ChatMessage[]): ChatMessage[] {
  const excerpt = messages
    .filter((m) => m.role === "user")
    .map((m) => contentText(m.content).trim().slice(0, 200))
    .filter(Boolean)
    .join("\n")
    .slice(0, 1200);
  return [
    {
      role: "user",
      content:
        "Name this chat with a short title of up to 5 words based on the user's main request. " +
        "Reply with ONLY the title — no quotes, no punctuation, no extra words.\n\n" +
        (excerpt || "[image-only request]"),
    },
  ];
}

/**
 * Ask the cheap model to name a chat from its transcript. Returns a short
 * title, or "New chat" if the model couldn't be reached (never throws).
 * `model` is the provider's cheap background model (see AgentConfig.helperModel).
 */
export async function suggestChatTitle(
  messages: ChatMessage[],
  client?: ChatClient,
  model?: string
): Promise<string> {
  if (!client || !model) return "New chat";
  try {
    const { text } = await client.completeOnce(model, titlePrompt(messages), 20);
    const title = text.trim().replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 48);
    return title || "New chat";
  } catch {
    return "New chat";
  }
}
