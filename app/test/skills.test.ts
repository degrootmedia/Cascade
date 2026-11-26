import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseArgv, runCommandArgv } from "@core";
import {
  loadSkills,
  makeReadSkillTool,
  ensureSkillsDir,
  seedSkills,
  parseFrontmatter,
  readSkillContent,
  skillFileFor,
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

describe("bundled production:film skill", () => {
  it("is discoverable and sequential", () => {
    const skills = loadSkills(path.resolve(__dirname, "../skills"));
    const film = skills.find((s) => `${s.namespace}:${s.name}` === "production:film");
    expect(film).toBeTruthy();
    expect(film?.kind).toBe("sequential");
    expect(film?.description).toMatch(/production folder/i);
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

// ---------------------------------------------------------------------------
// Folder skills (Claude / Agent Skills format): SKILL.md + references/ + scripts
// ---------------------------------------------------------------------------

const write = (rel: string, text: string) => {
  const p = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};

/** A Claude-format skill shaped like the Topview 3D Builder one: folded
 *  description, extra keys Cascade ignores, references and a script. */
function writeStagingSkill(dirRel = "stage-3d") {
  write(
    `${dirRel}/SKILL.md`,
    [
      "---",
      "name: stage-3d",
      "description: >",
      "  Block out 3D staging scenes with the stage CLI:",
      "  characters, props and cameras.",
      "  Use when the user asks to stage a scene in 3D.",
      "license: Apache-2.0",
      "metadata:",
      "  version: 0.1.8",
      "---",
      "",
      "# stage-3d",
      "",
      "Step 1 is in `references/layout.md`. MAIN-MARKER",
      "",
    ].join("\n")
  );
  write(`${dirRel}/references/layout.md`, "# Layout\nLAYOUT-MARKER relationships and support.\n");
  write(`${dirRel}/references/camera.md`, "# Camera\nCAMERA-MARKER bird's-eye overview.\n");
  write(`${dirRel}/scripts/echo.mjs`, 'console.log("SKILL-SCRIPT-OK " + process.argv[2] + " cwd=" + process.cwd());\n');
  write(`${dirRel}/assets/template.json`, "{}\n");
}

const readSkill = (args: Record<string, unknown>) => makeReadSkillTool(root).run(args, root) as Promise<string>;

describe("folder skills: listing", () => {
  it("lists a top-level folder skill by its frontmatter name with its frontmatter description", () => {
    writeStagingSkill();
    write("weekly-report.md", "Formats a report.\n");
    const skills = loadSkills(root);
    const stage = skills.find((s) => s.name === "stage-3d");
    expect(stage).toBeTruthy();
    expect(stage?.namespace).toBeUndefined();
    expect(stage?.description).toBe(
      "Block out 3D staging scenes with the stage CLI: characters, props and cameras. Use when the user asks to stage a scene in 3D."
    );
    // Nothing inside the folder is listed as a separate skill.
    expect(skills.map((s) => s.name).sort()).toEqual(["stage-3d", "weekly-report"]);
  });

  it("namespaces a folder skill under its namespace directory and keeps kind/triggers", () => {
    write(
      "production/film/SKILL.md",
      "---\nnamespace: production\nkind: sequential\ntriggers: make a short film, storyboard a script\n---\nProduces a short film.\n# production:film\n"
    );
    write("production/film/references/tools.md", "| Tool | Stage |\n");
    const film = loadSkills(root).find((s) => s.name === "film");
    expect(film).toEqual({
      name: "film",
      namespace: "production",
      kind: "sequential",
      triggers: ["make a short film", "storyboard a script"],
      description: "Produces a short film.",
    });
  });

  it("uses the folder name when SKILL.md has no frontmatter name", () => {
    write("plain-skill/SKILL.md", "Does a plain thing.\n");
    expect(loadSkills(root).map((s) => s.name)).toEqual(["plain-skill"]);
  });

  it("caps a frontmatter description at 1024 characters and a body one at 200", () => {
    write("long-fm/SKILL.md", `---\ndescription: ${"d".repeat(1500)}\n---\nbody\n`);
    write("long-body.md", `${"b".repeat(500)}\n`);
    const skills = loadSkills(root);
    expect(skills.find((s) => s.name === "long-fm")?.description.length).toBe(1024);
    expect(skills.find((s) => s.name === "long-body")?.description.length).toBe(200);
  });

  it("lists a label once when a flat file and a folder skill share it, preferring the folder", async () => {
    write("production/film.md", "Old flat film.\nFLAT-MARKER\n");
    write("production/film/SKILL.md", "New folder film.\nFOLDER-MARKER\n");
    const films = loadSkills(root).filter((s) => s.namespace === "production" && s.name === "film");
    expect(films).toHaveLength(1);
    expect(films[0].description).toBe("New folder film.");
    expect(await readSkill({ name: "production:film" })).toContain("FOLDER-MARKER");
  });

  it("treats only an exactly named SKILL.md as a folder skill", () => {
    write("notes/skill.md", "A flat skill that happens to be called skill.\n");
    const skills = loadSkills(root);
    expect(skills.map((s) => `${s.namespace}:${s.name}`)).toEqual(["notes:skill"]);
  });

  it("ignores _-prefixed folder skills", () => {
    write("_disabled/SKILL.md", "Hidden.\n");
    expect(loadSkills(root)).toEqual([]);
  });
});

describe("folder skills: read_skill loads SKILL.md first and references on demand", () => {
  it("returns SKILL.md plus an index of references, without any reference text", async () => {
    writeStagingSkill();
    const out = await readSkill({ name: "stage-3d" });
    expect(out).toContain("MAIN-MARKER");
    expect(out).toContain("- references/layout.md (");
    expect(out).toContain("- references/camera.md (");
    expect(out).not.toContain("LAYOUT-MARKER");
    expect(out).not.toContain("CAMERA-MARKER");
    expect(out).toContain(`read_skill {"name": "stage-3d", "file": "<path>"}`);
  });

  it("loads one reference when asked, by relative path or unique basename", async () => {
    writeStagingSkill();
    const layout = await readSkill({ name: "stage-3d", file: "references/layout.md" });
    expect(layout).toBe("# Layout\nLAYOUT-MARKER relationships and support.\n");
    expect(layout).not.toContain("CAMERA-MARKER");
    expect(await readSkill({ name: "stage-3d", file: "camera.md" })).toContain("CAMERA-MARKER");
    expect(await readSkill({ name: "stage-3d", file: "references\\layout.md" })).toContain("LAYOUT-MARKER");
    expect(await readSkill({ name: "stage-3d", file: "./references/layout.md" })).toContain("LAYOUT-MARKER");
  });

  it("answers ../SKILL.md (a reference pointing back) with SKILL.md and its index", async () => {
    writeStagingSkill();
    const out = await readSkill({ name: "stage-3d", file: "../SKILL.md" });
    expect(out).toContain("MAIN-MARKER");
    expect(out).toContain("references/layout.md");
  });

  it("refuses unknown files and paths outside the skill folder, listing the real references", async () => {
    writeStagingSkill();
    write("secret.md", "SECRET-MARKER\n");
    const unknown = await readSkill({ name: "stage-3d", file: "references/nope.md" });
    expect(unknown).toMatch(/^ERROR: .*not a reference file/);
    expect(unknown).toContain("references/layout.md");
    const escape = await readSkill({ name: "stage-3d", file: "../../secret.md" });
    expect(escape).toMatch(/^ERROR:/);
    expect(escape).not.toContain("SECRET-MARKER");
  });

  it("gives a flat skill no reference files and reads it exactly as before", async () => {
    write("weekly-report.md", "Formats a report.\n# Steps\n");
    expect(await readSkill({ name: "weekly-report" })).toBe("Formats a report.\n# Steps\n");
    expect(await readSkill({ name: "weekly-report", file: "references/x.md" })).toMatch(/^ERROR: .*single-file skill/);
  });

  it("caps each file at 20k, while the skill as a whole can be larger", async () => {
    write("big/SKILL.md", `Big skill.\n${"s".repeat(25_000)}`);
    write("big/references/a.md", `A-START${"a".repeat(15_000)}A-END`);
    write("big/references/b.md", `B-START${"b".repeat(15_000)}B-END`);
    write("big/references/huge.md", `H-START${"h".repeat(30_000)}H-END`);

    const main = await readSkill({ name: "big" });
    expect(main).toContain("[Truncated: SKILL.md is 25,011 characters");
    expect(main).toContain("- references/a.md (15,012 chars)");

    // 30k+ of references, each under the cap, both load whole.
    const a = await readSkill({ name: "big", file: "references/a.md" });
    const b = await readSkill({ name: "big", file: "references/b.md" });
    expect(a.endsWith("A-END")).toBe(true);
    expect(b.endsWith("B-END")).toBe(true);

    const huge = await readSkill({ name: "big", file: "references/huge.md" });
    expect(huge.startsWith(`H-START${"h".repeat(19_993)}`)).toBe(true);
    expect(huge).not.toContain("H-END");
    expect(huge).toContain("[Truncated: references/huge.md is 30,012 characters");
  });

  it("reads a folder skill's main file through readSkillContent and skillFileFor", () => {
    writeStagingSkill("production/stage");
    expect(skillFileFor(root, "production:stage-3d")).toBe(path.join(root, "production", "stage", "SKILL.md"));
    expect(readSkillContent(root, "production:stage-3d")).toContain("MAIN-MARKER");
  });
});

describe("frontmatter: Agent Skills shape and Cascade's own keys", () => {
  it("reads quoted values, literal blocks, lists and CRLF, ignoring unknown keys", () => {
    const fm = parseFrontmatter(
      [
        "---",
        'name: "quoted-name"',
        "description: |",
        "  Line one.",
        "  Line two.",
        "kind: advisory",
        "triggers:",
        "  - stage a scene",
        "  - 'block out'",
        "allowed-tools: Bash Read",
        "---",
        "Body line.",
      ].join("\r\n")
    );
    expect(fm.meta).toEqual({
      name: "quoted-name",
      description: "Line one.\nLine two.",
      kind: "advisory",
      triggers: ["stage a scene", "block out"],
    });
    expect(fm.body).toBe("Body line.");
  });

  it("reads unindented list items and a leading byte-order mark", () => {
    const { meta } = parseFrontmatter("﻿---\ntriggers:\n- one\n- two\nnamespace: spec\n---\nx\n");
    expect(meta).toEqual({ triggers: ["one", "two"], namespace: "spec" });
  });

  it("keeps Cascade's one-line shape exactly as before, including values with colons", () => {
    const { meta } = parseFrontmatter("---\nkind: sequential\ntriggers: plan: a feature, ship it\n---\nx\n");
    expect(meta).toEqual({ kind: "sequential", triggers: ["plan: a feature", "ship it"] });
  });

  it("applies both shapes when both are present", () => {
    write(
      "both/SKILL.md",
      "---\nname: both\ndescription: Agent Skills description.\nkind: sequential\nnamespace: spec\ntriggers: research\n---\nBody line ignored for the description.\n"
    );
    expect(loadSkills(root)).toEqual([
      { name: "both", namespace: "spec", kind: "sequential", triggers: ["research"], description: "Agent Skills description." },
    ]);
  });
});

describe("folder skills: scripts are listed, never run by the loader", () => {
  it("lists scripts with their interpreter and absolute path, and refuses to load them as text", async () => {
    writeStagingSkill();
    const marker = path.join(root, "RAN.txt");
    write("stage-3d/scripts/side-effect.py", `open(r"${marker}", "w").write("ran")\n`);
    loadSkills(root);
    const out = await readSkill({ name: "stage-3d" });
    const abs = path.join(root, "stage-3d", "scripts", "echo.mjs");
    expect(out).toContain(`- scripts/echo.mjs → node "${abs}"`);
    expect(out).toContain(`- scripts/side-effect.py → python "${path.join(root, "stage-3d", "scripts", "side-effect.py")}"`);
    expect(out).toContain("never run automatically");
    expect(out).toContain(`- assets/template.json → "${path.join(root, "stage-3d", "assets", "template.json")}"`);
    expect(out).not.toContain("console.log"); // script source is not returned
    const asText = await readSkill({ name: "stage-3d", file: "scripts/echo.mjs" });
    expect(asText).toMatch(/^ERROR: .*is a script.*run_command/);
    expect(fs.existsSync(marker)).toBe(false); // listing and reading executed nothing
  });

  it("the listed command runs the script in place through run_command's own spawn, with the workspace as cwd", async () => {
    writeStagingSkill();
    const out = await readSkill({ name: "stage-3d" });
    const line = out.split("\n").find((l) => l.startsWith("- scripts/echo.mjs → "))!;
    const command = `${line.slice("- scripts/echo.mjs → ".length)} lighthouse`;
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-skill-ws-"));
    try {
      const result = await runCommandArgv(parseArgv(command), workspace, 30_000);
      expect(result).toContain("SKILL-SCRIPT-OK lighthouse");
      expect(result).toContain(`cwd=${workspace}`);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("seedSkills with folder skills", () => {
  it("seeds bundled folder skills (top-level and namespaced) with their references", () => {
    const bundled = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-bundled-"));
    fs.mkdirSync(path.join(bundled, "production", "film", "references"), { recursive: true });
    fs.writeFileSync(path.join(bundled, "production", "film", "SKILL.md"), "Film.\n");
    fs.writeFileSync(path.join(bundled, "production", "film", "references", "tools.md"), "Tools.\n");
    fs.writeFileSync(path.join(bundled, "production", "film", "references", "_draft.md"), "no");
    fs.mkdirSync(path.join(bundled, "stage-3d"), { recursive: true });
    fs.writeFileSync(path.join(bundled, "stage-3d", "SKILL.md"), "Stage.\n");
    try {
      seedSkills(root, bundled);
      expect(fs.readFileSync(path.join(root, "production", "film", "references", "tools.md"), "utf8")).toBe("Tools.\n");
      expect(fs.existsSync(path.join(root, "production", "film", "references", "_draft.md"))).toBe(false);
      expect(fs.existsSync(path.join(root, "stage-3d", "SKILL.md"))).toBe(true);
      expect(loadSkills(root).map((s) => (s.namespace ? `${s.namespace}:${s.name}` : s.name)).sort()).toEqual([
        "production:film",
        "stage-3d",
      ]);
    } finally {
      fs.rmSync(bundled, { recursive: true, force: true });
    }
  });

  it("never re-seeds a skill the user has in the other form (no duplicates after a conversion)", () => {
    const bundled = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-bundled-"));
    // Bundled: film is a folder skill, review is flat.
    fs.mkdirSync(path.join(bundled, "production", "film"), { recursive: true });
    fs.writeFileSync(path.join(bundled, "production", "film", "SKILL.md"), "Bundled film.\n");
    fs.mkdirSync(path.join(bundled, "code"), { recursive: true });
    fs.writeFileSync(path.join(bundled, "code", "review.md"), "Bundled review.\n");
    // User: an older flat film, and review converted to a folder.
    write("production/film.md", "User flat film.\n");
    write("code/review/SKILL.md", "User folder review.\n");
    try {
      seedSkills(root, bundled);
      expect(fs.existsSync(path.join(root, "production", "film"))).toBe(false);
      expect(fs.existsSync(path.join(root, "code", "review.md"))).toBe(false);
      const labels = loadSkills(root).map((s) => `${s.namespace}:${s.name}`).sort();
      expect(labels).toEqual(["code:review", "production:film"]);
    } finally {
      fs.rmSync(bundled, { recursive: true, force: true });
    }
  });
});

describe("skills README", () => {
  const OLD_DEFAULT_2026_08_25 = fs.readFileSync(path.resolve(__dirname, "fixtures/skills-before/_README.md"), "utf8");

  it("replaces an unedited earlier default README with the current one (which states the trust rule)", () => {
    fs.writeFileSync(path.join(root, "_README.md"), OLD_DEFAULT_2026_08_25.replace(/\n/g, "\r\n"));
    ensureSkillsDir(root);
    const now = fs.readFileSync(path.join(root, "_README.md"), "utf8");
    expect(now).toContain("Only add skills from sources you trust");
    expect(now).toContain("Folder skills");
    expect(now).toContain("never run by themselves");
  });

  it("leaves an edited README alone", () => {
    fs.writeFileSync(path.join(root, "_README.md"), `${OLD_DEFAULT_2026_08_25}\nMy own notes.\n`);
    ensureSkillsDir(root);
    expect(fs.readFileSync(path.join(root, "_README.md"), "utf8")).toContain("My own notes.");
  });
});
