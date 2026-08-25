/**
 * Skills: markdown instruction files the agent can pull in on demand.
 * Files live in userData/skills/*.md. The agent sees name + description in
 * its system prompt and fetches full content via the read_skill tool.
 * Files starting with "_" are ignored (used for the README).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, SkillMeta } from "@core";

const MAX_SKILL_CHARS = 20_000;

const README = `# Cascade skills

Drop markdown files in this folder to teach Cascade repeatable workflows.

- The FILENAME (without .md) is the skill name.
- The first non-heading line is shown to the model as the description, so
  make it a clear one-sentence summary of when to use the skill.
- The rest of the file is the full instructions, loaded only when needed.
- Files starting with _ are ignored.

Example — save as "weekly-report.md":

    Formats my weekly status report from raw notes.

    # Weekly report format
    1. Read the notes file the user points at.
    2. Group items under: Done / In progress / Blocked.
    3. Write the result to report-<date>.md, max one page.
`;

export function ensureSkillsDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, "_README.md");
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, README, "utf8");
}

export function loadSkills(dir: string): SkillMeta[] {
  ensureSkillsDir(dir);
  const skills: SkillMeta[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md") || f.startsWith("_")) continue;
    const name = f.slice(0, -3).replace(/[^a-zA-Z0-9_-]/g, "-");
    let description = "";
    try {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      description =
        text
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith("#")) ?? "";
    } catch {
      continue;
    }
    skills.push({ name, description: description.slice(0, 200) });
  }
  return skills;
}

/** Tool that returns a skill's full content. Read-only, no approval needed. */
export function makeReadSkillTool(dir: string): AgentTool {
  return {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "read_skill",
        description: "Read the full instructions of a named skill listed in your system prompt.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Skill name exactly as listed" } },
          required: ["name"],
        },
      },
    },
    run: async (args) => {
      const raw = typeof args.name === "string" ? args.name : "";
      const safe = path.basename(raw).replace(/\.md$/i, "");
      const file = path.join(dir, `${safe}.md`);
      try {
        return fs.readFileSync(file, "utf8").slice(0, MAX_SKILL_CHARS);
      } catch {
        const available = loadSkills(dir)
          .map((s) => s.name)
          .join(", ");
        return `ERROR: skill "${raw}" not found. Available: ${available || "(none)"}`;
      }
    },
  };
}
