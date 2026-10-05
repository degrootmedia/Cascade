/**
 * Approval-gate behavior: autonomous mode skips the prompt entirely, seeded
 * session grants are honored without prompting, and "always allow" decisions
 * are reported back so the host can persist them.
 *
 * `Agent` builds its own `ChatClient`, so the fake client here is the seam: it
 * replays a scripted list of assistant turns.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTool, ApprovalDecision } from "../src/types.js";

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
      return {
        message: { role: "assistant", content, tool_calls: r.tool_calls },
        usage: {},
      };
    }
    async completeOnce() {
      return { text: "" };
    }
  },
  friendlyApiError: (e: unknown) => String(e),
}));

import { Agent } from "../src/agent.js";

/** A mutating test tool that returns a canned result. */
function dangerTool(name: string): AgentTool {
  return {
    requiresApproval: true,
    definition: {
      type: "function",
      function: { name, description: "test tool", parameters: { type: "object", properties: {} } },
    },
    async run() {
      return "ok";
    },
  };
}

function toolCall(name: string, id = "1") {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

function makeAgent(opts: {
  requestApproval: () => Promise<ApprovalDecision>;
  extraTools: Record<string, AgentTool>;
  autonomousMode?: boolean;
  initialAllowedTools?: string[];
  initialAllowedGroups?: string[];
  onApprovalGrant?: (g: { kind: "tool" | "group"; value: string }) => void;
}): Agent {
  return new Agent({
    apiKey: "k",
    model: "m",
    workspaceRoot: "/ws",
    autonomousMode: opts.autonomousMode,
    initialAllowedTools: opts.initialAllowedTools,
    initialAllowedGroups: opts.initialAllowedGroups,
    onApprovalGrant: opts.onApprovalGrant,
    extraTools: opts.extraTools,
    requestApproval: opts.requestApproval,
    onEvent: () => {},
  });
}

beforeEach(() => {
  state.script = [];
});

describe("agent approval gate", () => {
  it("asks for approval on a mutating tool by default", async () => {
    state.script = [{ tool_calls: [toolCall("danger")] }, { content: "done" }];
    const requestApproval = vi.fn(async (): Promise<ApprovalDecision> => "allow");
    const agent = makeAgent({ requestApproval, extraTools: { danger: dangerTool("danger") } });
    await agent.send("go");
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it("skips the prompt entirely in autonomous mode", async () => {
    state.script = [{ tool_calls: [toolCall("danger")] }, { content: "done" }];
    const requestApproval = vi.fn(async (): Promise<ApprovalDecision> => "deny");
    const agent = makeAgent({
      requestApproval,
      extraTools: { danger: dangerTool("danger") },
      autonomousMode: true,
    });
    await agent.send("go");
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("honors a seeded tool grant without prompting", async () => {
    state.script = [{ tool_calls: [toolCall("danger")] }, { content: "done" }];
    const requestApproval = vi.fn(async (): Promise<ApprovalDecision> => "deny");
    const agent = makeAgent({
      requestApproval,
      extraTools: { danger: dangerTool("danger") },
      initialAllowedTools: ["danger"],
    });
    await agent.send("go");
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("honors a seeded group grant for any MCP tool in the group", async () => {
    state.script = [{ tool_calls: [toolCall("openart__generate")] }, { content: "done" }];
    const requestApproval = vi.fn(async (): Promise<ApprovalDecision> => "deny");
    const agent = makeAgent({
      requestApproval,
      extraTools: { openart__generate: dangerTool("openart__generate") },
      initialAllowedGroups: ["openart"],
    });
    await agent.send("go");
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("reports an allow-session grant for persistence", async () => {
    state.script = [{ tool_calls: [toolCall("danger")] }, { content: "done" }];
    const onApprovalGrant = vi.fn();
    const agent = makeAgent({
      requestApproval: async () => "allow-session",
      extraTools: { danger: dangerTool("danger") },
      onApprovalGrant,
    });
    await agent.send("go");
    expect(onApprovalGrant).toHaveBeenCalledWith({ kind: "tool", value: "danger" });
  });

  it("reports an allow-group-session grant with the server prefix", async () => {
    state.script = [{ tool_calls: [toolCall("openart__generate")] }, { content: "done" }];
    const onApprovalGrant = vi.fn();
    const agent = makeAgent({
      requestApproval: async () => "allow-group-session",
      extraTools: { openart__generate: dangerTool("openart__generate") },
      onApprovalGrant,
    });
    await agent.send("go");
    expect(onApprovalGrant).toHaveBeenCalledWith({ kind: "group", value: "openart" });
  });
});
