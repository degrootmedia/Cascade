import { describe, it, expect } from "vitest";
import { expandCommand } from "../src/shared/commands.js";

describe("expandCommand", () => {
  it("returns null for non-command text", () => {
    expect(expandCommand("hello there")).toBeNull();
    expect(expandCommand("build /research")).toBeNull();
  });

  it("expands the harness commands into an instruction with args", () => {
    const r = expandCommand("/research the auth module");
    expect(r?.name).toBe("research");
    expect(r?.rest).toBe("the auth module");
    expect(r?.instruction).toContain("spec:research");
    expect(r?.instruction).toContain("the auth module");

    const p = expandCommand("/plan auth");
    expect(p?.planMode).toBe(true);
    expect(p?.instruction).toContain("spec:plan");
  });

  it("handles /plan-mode on/off as a gate toggle with no instruction", () => {
    const on = expandCommand("/plan-mode on");
    expect(on?.name).toBe("plan-mode");
    expect(on?.planMode).toBe(true);
    expect(on?.instruction).toBe("");

    const off = expandCommand("/plan-mode off");
    expect(off?.planMode).toBe(false);

    const bare = expandCommand("/plan-mode");
    expect(bare?.planMode).toBeUndefined();
  });

  it("keeps /commit and /review as utility commands", () => {
    expect(expandCommand("/commit")?.name).toBe("commit");
    expect(expandCommand("/review")?.name).toBe("review");
  });
});
