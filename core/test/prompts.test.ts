import { describe, it, expect } from "vitest";
import { systemPrompt, pureChatSystemPrompt, skillsPrompt, planModePrompt } from "../src/prompts.js";
import type { SkillMeta } from "../src/types.js";

describe("skillsPrompt", () => {
  it("returns empty when no skills", () => {
    expect(skillsPrompt()).toBe("");
    expect(skillsPrompt([])).toBe("");
  });

  it("groups skills by kind and labels namespaced skills ns:name", () => {
    const skills: SkillMeta[] = [
      { name: "research", namespace: "spec", kind: "sequential", description: "Explore and produce spec.md", triggers: ["plan a feature"] },
      { name: "challenge", namespace: "oracle", kind: "advisory", description: "Poke holes in a design" },
      { name: "weekly-report", description: "Formats a report" },
    ];
    const out = skillsPrompt(skills);
    expect(out).toContain("spec:research");
    expect(out).toContain("oracle:challenge");
    expect(out).toContain("weekly-report");
    expect(out).toContain("Sequential");
    expect(out).toContain("Advisory");
    expect(out).toContain("Utility");
    expect(out).toMatch(/plan a feature/);
  });
});

describe("planModePrompt", () => {
  it("instructs the model to defer mutations until approval", () => {
    expect(planModePrompt()).toMatch(/PLAN MODE is ON/);
    expect(planModePrompt()).toMatch(/until the user has reviewed/);
  });
});

describe("systemPrompt", () => {
  it("includes the plan-mode directive when enabled and omits it when disabled", () => {
    const withPlan = systemPrompt("/ws", undefined, undefined, undefined, undefined, true);
    expect(withPlan).toMatch(/PLAN MODE is ON/);
    const withoutPlan = systemPrompt("/ws", undefined, undefined, undefined, undefined, false);
    expect(withoutPlan).not.toMatch(/PLAN MODE is ON/);
  });

  it("keeps pure-chat prompt free of plan mode and skills", () => {
    const p = pureChatSystemPrompt();
    expect(p).not.toMatch(/PLAN MODE/);
    expect(p).not.toMatch(/read_skill/);
  });
});
