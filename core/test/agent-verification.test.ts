/**
 * Agent verification loop: after a successful mutation the loop runs the
 * configured checks once per iteration and feeds failures back for a bounded
 * number of repair rounds. With no verification configured the loop is
 * unchanged (no verification events, runner never called).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTool, AgentEvent, ApprovalDecision } from "../src/types.js";
import type { VerificationConfig, VerifyResult, VerifyRunner } from "../src/verify.js";

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

function mutTool(name: string, result = "ok"): AgentTool {
  return {
    requiresApproval: true,
    definition: { type: "function", function: { name, description: "t", parameters: { type: "object", properties: {} } } },
    async run() {
      return result;
    },
  };
}

function readTool(name: string): AgentTool {
  return {
    requiresApproval: false,
    definition: { type: "function", function: { name, description: "t", parameters: { type: "object", properties: {} } } },
    async run() {
      return "read ok";
    },
  };
}

function toolCall(name: string, args: Record<string, unknown> = {}, id = "1") {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

const passResult = (name: string): VerifyResult => ({ name, argv: ["npm", "run", name], exitCode: 0, timedOut: false, output: "" });
const failResult = (name: string): VerifyResult => ({ name, argv: ["npm", "run", name], exitCode: 1, timedOut: false, output: "3 errors" });

interface Harness {
  events: AgentEvent[];
  runner: ReturnType<typeof vi.fn>;
  agent: Agent;
}

function makeAgent(opts: {
  extraTools: Record<string, AgentTool>;
  verification?: VerificationConfig;
  resolveVerification?: () => Promise<VerificationConfig | null>;
  runner: (config: VerificationConfig) => VerifyResult[];
  planMode?: boolean;
}): Harness {
  const events: AgentEvent[] = [];
  const runner = vi.fn(async (config: VerificationConfig, _ws: string) => opts.runner(config));
  const agent = new Agent({
    apiKey: "k",
    model: "m",
    workspaceRoot: "/ws",
    planMode: opts.planMode,
    verification: opts.verification,
    resolveVerification: opts.resolveVerification,
    verificationRunner: runner as unknown as VerifyRunner,
    extraTools: opts.extraTools,
    requestApproval: async (): Promise<ApprovalDecision> => "allow",
    onEvent: (e) => events.push(e),
  });
  return { events, runner, agent };
}

beforeEach(() => {
  state.script = [];
});

describe("agent verification loop", () => {
  it("never runs when no mutation happened", async () => {
    state.script = [{ tool_calls: [toolCall("read")] }, { content: "done" }];
    const h = makeAgent({
      extraTools: { read: readTool("read") },
      verification: { commands: [{ name: "typecheck", argv: ["npm", "run", "typecheck"] }] },
      runner: () => [passResult("typecheck")],
    });
    await h.agent.send("go");
    expect(h.runner).not.toHaveBeenCalled();
    expect(h.events.some((e) => e.type === "verification-start")).toBe(false);
  });

  it("runs once after a successful mutation", async () => {
    state.script = [{ tool_calls: [toolCall("mut")] }, { content: "done" }];
    const h = makeAgent({
      extraTools: { mut: mutTool("mut") },
      verification: { commands: [{ name: "typecheck", argv: ["npm", "run", "typecheck"] }] },
      runner: () => [passResult("typecheck")],
    });
    await h.agent.send("go");
    expect(h.runner).toHaveBeenCalledTimes(1);
    const types = h.events.map((e) => e.type);
    expect(types).toContain("verification-start");
    expect(types).toContain("verification-result");
  });

  it("bounds repair rounds and emits verification-exhausted", async () => {
    state.script = [
      { tool_calls: [toolCall("mut")] },
      { tool_calls: [toolCall("mut")] },
      { tool_calls: [toolCall("mut")] },
      { content: "done" },
    ];
    const h = makeAgent({
      extraTools: { mut: mutTool("mut") },
      verification: { commands: [{ name: "test", argv: ["npm", "test"] }], maxRepairRounds: 2 },
      runner: () => [failResult("test")],
    });
    await h.agent.send("go");
    const rounds = h.events.filter((e) => e.type === "repair-round");
    expect(rounds.map((e) => (e as { round: number }).round)).toEqual([1, 2]);
    expect(h.events.some((e) => e.type === "verification-exhausted")).toBe(true);
    expect(h.runner).toHaveBeenCalledTimes(3);
  });

  it("does not verify a failed mutation", async () => {
    state.script = [{ tool_calls: [toolCall("mut")] }, { content: "done" }];
    const h = makeAgent({
      extraTools: { mut: mutTool("mut", "ERROR: nope") },
      verification: { commands: [{ name: "typecheck", argv: ["npm", "run", "typecheck"] }] },
      runner: () => [passResult("typecheck")],
    });
    await h.agent.send("go");
    expect(h.runner).not.toHaveBeenCalled();
  });

  it("with verification unset the event stream carries no verification events", async () => {
    state.script = [{ tool_calls: [toolCall("mut")] }, { content: "done" }];
    const h = makeAgent({
      extraTools: { mut: mutTool("mut") },
      runner: () => [],
    });
    await h.agent.send("go");
    expect(h.runner).not.toHaveBeenCalled();
    expect(h.events.some((e) => e.type.startsWith("verification") || e.type === "repair-round")).toBe(false);
  });

  it("resolves the config once via the host resolver", async () => {
    state.script = [
      { tool_calls: [toolCall("mut")] },
      { tool_calls: [toolCall("mut")] },
      { content: "done" },
    ];
    const resolveVerification = vi.fn(async () => ({
      commands: [{ name: "typecheck", argv: ["npm", "run", "typecheck"] }],
    }));
    const h = makeAgent({
      extraTools: { mut: mutTool("mut") },
      resolveVerification,
      runner: () => [passResult("typecheck")],
    });
    await h.agent.send("go");
    expect(resolveVerification).toHaveBeenCalledTimes(1);
    expect(h.runner).toHaveBeenCalledTimes(2);
  });

  it("a plan-mode-blocked mutation triggers no verification", async () => {
    state.script = [
      { tool_calls: [toolCall("write_file", { path: "src/a.ts", content: "x" })] },
      { content: "done" },
    ];
    const h = makeAgent({
      extraTools: {},
      planMode: true,
      verification: { commands: [{ name: "typecheck", argv: ["npm", "run", "typecheck"] }] },
      runner: () => [passResult("typecheck")],
    });
    await h.agent.send("go");
    expect(h.runner).not.toHaveBeenCalled();
  });
});
