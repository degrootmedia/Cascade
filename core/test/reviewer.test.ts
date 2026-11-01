import { describe, expect, it } from "vitest";
import { Agent, REVIEWER_TOOLS } from "../src/agent.js";

const base = { apiKey: "x", model: "m", workspaceRoot: process.cwd(), onEvent: () => {}, requestApproval: async () => "deny" as const };
const fakeWrite = {
  definition: { type: "function", function: { name: "cascade_write", description: "", parameters: { type: "object", properties: {} } } },
  requiresApproval: false,
  run: async () => "",
};

describe("reviewer mode", () => {
  it("exposes only read tools, even when extra tools are supplied", () => {
    const a = new Agent({ ...base, reviewerMode: true, extraTools: { cascade_write: fakeWrite } } as never);
    expect(a.toolNames.sort()).toEqual([...REVIEWER_TOOLS].sort());
    for (const n of ["write_file", "edit_file", "run_command", "cascade_write"]) expect(a.toolNames).not.toContain(n);
  });
  it("normal agents keep their edit tools", () => {
    const a = new Agent({ ...base } as never);
    expect(a.toolNames).toContain("edit_file");
  });
});
