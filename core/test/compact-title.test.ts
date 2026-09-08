/**
 * Chat-title seam: suggestChatTitle takes the provider's client + a cheap
 * background model resolved by the app (AgentConfig.helperModel) — the model
 * is never hardcoded in core, so any provider's cheapest model works.
 */
import { describe, it, expect } from "vitest";
import { suggestChatTitle } from "../src/compact.js";
import type { ChatClient } from "../src/chat.js";
import type { ChatMessage } from "../src/types.js";

function fakeClient(text: string, seen: { model?: string } = {}): ChatClient {
  return {
    completeOnce: async (model: string) => {
      seen.model = model;
      return { text, usage: {} };
    },
  } as unknown as ChatClient;
}

const messages: ChatMessage[] = [{ role: "user", content: "help me write a haiku about goats" }];

describe("suggestChatTitle", () => {
  it("asks the given background model and trims the reply", async () => {
    const seen: { model?: string } = {};
    const title = await suggestChatTitle(messages, fakeClient(' "Goat Haiku" ', seen), "cheap-model");
    expect(title).toBe("Goat Haiku");
    expect(seen.model).toBe("cheap-model");
  });

  it("falls back to the default title without a client or model", async () => {
    expect(await suggestChatTitle(messages)).toBe("New chat");
    expect(await suggestChatTitle(messages, fakeClient("x"))).toBe("New chat");
  });

  it("surfaces the default title when the model fails", async () => {
    const broken = {
      completeOnce: async () => {
        throw new Error("HTTP 404");
      },
    } as unknown as ChatClient;
    expect(await suggestChatTitle(messages, broken, "gone")).toBe("New chat");
  });
});
