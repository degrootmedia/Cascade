import { describe, it, expect } from "vitest";
import { labelCommandRisk, parseArgv, lineDiff } from "../src/tools.js";
import { planCompaction, historySize, summaryMessage } from "../src/compact.js";
import { friendlyApiError } from "../src/chat.js";
import type { ChatMessage } from "../src/types.js";

describe("labelCommandRisk (advisory only — never gates execution)", () => {
  it("labels destructive executables", () => {
    expect(labelCommandRisk(parseArgv("rm -rf /"))).toBe("destructive");
    expect(labelCommandRisk(["format", "c:"])).toBe("destructive");
    expect(labelCommandRisk(["diskpart"])).toBe("destructive");
  });

  it("labels risky-but-legitimate commands", () => {
    expect(labelCommandRisk(parseArgv("rm -rf node_modules"))).toBe("destructive");
    expect(labelCommandRisk(["git", "reset", "--hard", "HEAD~3"])).toBe("destructive");
    expect(labelCommandRisk(["curl", "https://x"])).toBe("network");
  });

  it("passes ordinary commands", () => {
    expect(labelCommandRisk(parseArgv("python hello.py"))).toBe("normal");
    expect(labelCommandRisk(parseArgv("npm install"))).toBe("normal");
    expect(labelCommandRisk(parseArgv("dir /b"))).toBe("normal");
    expect(labelCommandRisk(parseArgv("git status"))).toBe("normal");
  });
});

describe("lineDiff", () => {
  it("shows only the changed middle", () => {
    const d = lineDiff("a\nb\nc\nd", "a\nB\nc\nd");
    expect(d).toContain("- b");
    expect(d).toContain("+ B");
    expect(d).not.toContain("- a");
    expect(d).not.toContain("- c");
  });

  it("reports identical content", () => {
    expect(lineDiff("same", "same")).toContain("identical");
  });

  it("caps very large diffs", () => {
    const oldT = Array.from({ length: 100 }, (_, i) => `old${i}`).join("\n");
    const newT = Array.from({ length: 100 }, (_, i) => `new${i}`).join("\n");
    const d = lineDiff(oldT, newT);
    expect(d).toContain("more lines");
  });
});

function msg(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

describe("planCompaction", () => {
  const system = msg("system", "you are cascade");

  it("returns null under budget", () => {
    expect(planCompaction([system, msg("user", "hi")], 1000)).toBeNull();
  });

  it("keeps system prompt and recent turns, summarizes the rest", () => {
    const many: ChatMessage[] = [system];
    for (let i = 0; i < 30; i++) many.push(msg(i % 2 ? "assistant" : "user", `turn ${i} ${"x".repeat(100)}`));
    const plan = planCompaction(many, 500)!;
    expect(plan).not.toBeNull();
    expect(plan.keep[0].role).toBe("system");
    expect(plan.keep.length).toBe(1 + 8);
    expect(plan.toSummarize.length).toBe(30 - 8);
    expect(historySize([...plan.keep, ...plan.toSummarize])).toBe(historySize(many));
  });

  it("never cuts between a tool call and its result", () => {
    const many: ChatMessage[] = [system];
    for (let i = 0; i < 20; i++) many.push(msg("user", `turn ${i} ${"x".repeat(100)}`));
    // Position the would-be cut right before a tool result.
    const withTools: ChatMessage[] = [
      ...many,
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", content: "result", tool_call_id: "1" },
      ...Array.from({ length: 6 }, (_, i) => msg("user", `tail ${i}`)),
    ];
    const plan = planCompaction(withTools, 500)!;
    expect(plan).not.toBeNull();
    // First kept non-system message must not be an orphaned tool result.
    expect(plan.keep[1].role).not.toBe("tool");
  });

  it("summaryMessage is marked as a summary", () => {
    expect(summaryMessage("stuff happened").content).toContain("summary");
  });
});

describe("friendlyApiError", () => {
  it("maps common failures", () => {
    expect(friendlyApiError(new Error("HTTP 401: bad key"))).toContain("Settings");
    expect(friendlyApiError(new Error("HTTP 429: slow down"))).toContain("Rate limited");
    expect(friendlyApiError(new Error("fetch failed"))).toContain("internet");
    expect(friendlyApiError(new Error("HTTP 402: insufficient credits"))).toContain("credits");
  });
  it("passes through unknown errors", () => {
    expect(friendlyApiError(new Error("weird thing"))).toContain("weird thing");
  });
});
