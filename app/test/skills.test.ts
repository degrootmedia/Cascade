import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadSkills,
  makeReadSkillTool,
  ensureSkillsDir,
  seedSkills,
  parseFrontmatter,
  readSkillContent,
} from "../src/main/skills.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-skills-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
  it("parses kind, namespace and triggers from a frontmatter block", () => {
    const { meta, body } = parseFrontmatter(
      "---\nkind: sequential\nnamespace: spec\ntriggers: plan a feature, break a task\n---\nExplores stuff.\n# Heading\nMore.\n"
    );
    expect(meta.kind).toBe("sequential");
    expect(meta.namespace).toBe("spec");
    expect(meta.triggers).toEqual(["plan a feature", "break a task"]);
    expect(body).toContain("Explores stuff.");
  });

  it("returns empty meta and the whole body when no frontmatter", () => {
    const { meta, body } = parseFrontmatter("Just a line.\n");
    expect(meta).toEqual({});
    expect(body).toBe("Just a line.\n");
  });
});

describe("loadSkills", () => {
  it("loads flat and namespaced skills, deriving namespace from the directory", () => {
    ensureSkillsDir(root);
    fs.mkdirSync(path.join(root, "spec"), { recursive: true });
    fs.writeFileSync(path.join(root, "weekly-report.md"), "Formats a report.\n# Steps\n");
    fs.writeFileSync(
      path.join(root, "spec", "research.md"),
      "---\nkind: sequential\ntriggers: research\n---\nExplores the codebase.\n# Steps\n"
    );
    fs.writeFileSync(path.join(root, "_ignored.md"), "no");
    fs.writeFileSync(path.join(root, "spec", "_skip.md"), "no");

    const skills = loadSkills(root);
    const byName = (n: string) => skills.find((s) => (s.namespace ? `${s.namespace}:${s.name}` : s.name) === n);

    expect(byName("weekly-report")?.namespace).toBeUndefined();
    const spec = byName("spec:research");
    expect(spec?.namespace).toBe("spec");
    expect(spec?.kind).toBe("sequential");
    expect(spec?.triggers).toContain("research");
    expect(skills.length).toBe(2);
  });
});

describe("readSkillContent + read_skill tool", () => {
  it("reads by flat name and namespaced name, and blocks escapes", async () => {
    ensureSkillsDir(root);
    fs.mkdirSync(path.join(root, "spec"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes.md"), "Notes content");
    fs.writeFileSync(path.join(root, "spec", "plan.md"), "Plan content");

    expect(readSkillContent(root, "notes")).toBe("Notes content");
    expect(readSkillContent(root, "spec:plan")).toBe("Plan content");
    expect(readSkillContent(root, "../outside")).toBeNull();

    const tool = makeReadSkillTool(root);
    const missing = await tool.run({ name: "nope" }, root);
    expect(missing).toMatch(/ERROR/);
    expect(missing).toMatch(/spec:plan/);
  });
});

describe("seedSkills", () => {
  it("copies namespaced bundled skills only when missing (idempotent), and skips root-level files", () => {
    ensureSkillsDir(root);
    const bundled = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-bundled-"));
    fs.mkdirSync(path.join(bundled, "spec"), { recursive: true });
    fs.writeFileSync(path.join(bundled, "spec", "research.md"), "Bundled research");
    fs.mkdirSync(path.join(bundled, "oracle"), { recursive: true });
    fs.writeFileSync(path.join(bundled, "oracle", "challenge.md"), "Bundled challenge");
    fs.writeFileSync(path.join(bundled, "magic-prompt.md"), "not a chat skill");
    fs.writeFileSync(path.join(bundled, "_skip.md"), "no");
    fs.writeFileSync(path.join(bundled, "spec", "_skip.md"), "no");

    seedSkills(root, bundled);
    expect(fs.existsSync(path.join(root, "spec", "research.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "oracle", "challenge.md"))).toBe(true);
    // Root-level .md (magic-prompt) and _-prefixed entries are NOT seeded.
    expect(fs.existsSync(path.join(root, "magic-prompt.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "_skip.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "spec", "_skip.md"))).toBe(false);

    // Editing the bundled copy should NOT clobber a user edit on re-seed.
    fs.writeFileSync(path.join(root, "oracle", "challenge.md"), "USER EDITED");
    seedSkills(root, bundled);
    expect(fs.readFileSync(path.join(root, "oracle", "challenge.md"), "utf8")).toBe("USER EDITED");

    fs.rmSync(bundled, { recursive: true, force: true });
  });
});
