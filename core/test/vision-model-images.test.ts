/**
 * On-demand vision: a tool that returns `modelImages` has them attached to the
 * conversation as ONE synthetic user turn — but only when the agent is
 * `visionEnabled`. Without it (or without modelImages) the message stream is
 * exactly what it was before, so non-vision models and image-less tools are
 * unaffected.
 *
 * `Agent` builds its own `ChatClient`, so the fake client here is the seam: it
 * replays a scripted list of assistant turns.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTool, ChatMessage, ContentPart } from "../src/types.js";

const { state } = vi.hoisted(() => ({
  state: { script: [] as Array<Record<string, unknown>> },
}));

vi.mock("../src/chat.js", () => ({
  ChatClient: class {
    async complete(
      _model: string,
      _messages: unknown,
      _tools: unknown,
      onDelta: (t: string) => void
    ) {
      const r = state.script.shift() ?? { content: "done" };
      const content = (r.content as string) ?? null;
      if (content) onDelta(content);
      return { message: { role: "assistant", content, tool_calls: r.tool_calls }, usage: {} };
    }
    async completeOnce() {
      return { text: "" };
    }
  },
  friendlyApiError: (e: unknown) => String(e),
}));

import { Agent } from "../src/agent.js";

function toolCall(name: string, id = "1") {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

/** A read-only tool that returns model-visible images. */
function visionTool(name: string, modelImages: string[]): AgentTool {
  return {
    requiresApproval: false,
    definition: {
      type: "function",
      function: { name, description: "test vision tool", parameters: { type: "object", properties: {} } },
    },
    async run() {
      return { text: "loaded", modelImages };
    },
  };
}

function makeAgent(opts: { extraTools: Record<string, AgentTool>; visionEnabled?: boolean }): Agent {
  return new Agent({
    apiKey: "k",
    model: "m",
    workspaceRoot: "/ws",
    visionEnabled: opts.visionEnabled,
    extraTools: opts.extraTools,
    requestApproval: async () => "allow",
    onEvent: () => {},
  });
}

/** The user turns whose content is a media-part array. */
function imageTurns(history: ChatMessage[]): ContentPart[][] {
  return history
    .filter((m) => m.role === "user" && Array.isArray(m.content))
    .map((m) => m.content as ContentPart[])
    .filter((parts) => parts.some((p) => p.type === "image_url"));
}

beforeEach(() => {
  state.script = [];
});

describe("on-demand vision feedback", () => {
  it("attaches modelImages as a user turn when visionEnabled", async () => {
    state.script = [{ tool_calls: [toolCall("view")] }, { content: "done" }];
    const img = "data:image/png;base64,AAAA";
    const agent = makeAgent({ extraTools: { view: visionTool("view", [img]) }, visionEnabled: true });
    await agent.send("look");
    const turns = imageTurns(agent.getHistory());
    expect(turns).toHaveLength(1);
    const parts = turns[0];
    expect(parts[0]).toEqual({ type: "text", text: expect.any(String) });
    expect(parts.some((p) => p.type === "image_url" && p.image_url.url === img)).toBe(true);
  });

  it("does NOT attach images when vision is disabled", async () => {
    state.script = [{ tool_calls: [toolCall("view")] }, { content: "done" }];
    const agent = makeAgent({
      extraTools: { view: visionTool("view", ["data:image/png;base64,AAAA"]) },
      visionEnabled: false,
    });
    await agent.send("look");
    expect(imageTurns(agent.getHistory())).toHaveLength(0);
  });

  it("leaves the stream unchanged when a tool returns no modelImages", async () => {
    state.script = [{ tool_calls: [toolCall("view")] }, { content: "done" }];
    const agent = makeAgent({ extraTools: { view: visionTool("view", []) }, visionEnabled: true });
    await agent.send("look");
    expect(imageTurns(agent.getHistory())).toHaveLength(0);
    // The tool message is still present and text-only.
    const toolMsg = agent.getHistory().find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("loaded");
  });

  it("coalesces multiple tools' images into one user turn, after the tool messages", async () => {
    // Two calls in the same assistant turn.
    state.script = [{ tool_calls: [toolCall("a", "1"), toolCall("b", "2")] }, { content: "done" }];
    const a = visionTool("a", ["data:image/png;base64,AAAA"]);
    const b = visionTool("b", ["data:image/png;base64,BBBB"]);
    const agent = makeAgent({ extraTools: { a, b }, visionEnabled: true });
    await agent.send("look");
    const history = agent.getHistory();
    const turns = imageTurns(history);
    expect(turns).toHaveLength(1);
    const urls = turns[0].filter((p) => p.type === "image_url").map((p) => p.image_url.url);
    expect(urls).toEqual(["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"]);
    // The synthetic user turn must come AFTER both tool messages.
    const lastToolIdx = history.map((m) => m.role).lastIndexOf("tool");
    const imageTurnIdx = history.findIndex((m) => Array.isArray(m.content) && (m.content as ContentPart[]).some((p) => p.type === "image_url"));
    expect(imageTurnIdx).toBeGreaterThan(lastToolIdx);
  });
});
