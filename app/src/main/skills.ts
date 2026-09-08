/**
 * Skills: markdown instruction files the agent can pull in on demand.
 *
 * Skills live in userData/skills/. Each skill is one .md file, optionally under
 * a namespace directory (e.g. spec/, oracle/, code/) so the agent can carry a
 * Research → Plan → Implement harness the way the Atelier post describes.
 *
 * Layout + metadata:
 *   - Flat file:   skills/weekly-report.md            → name "weekly-report"
 *   - Namespaced:  skills/spec/research.md            → name "spec:research"
 *   - Optional leading YAML-ish frontmatter:
 *         ---
 *         namespace: spec
 *         kind: sequential
 *         triggers: plan a feature, break a task into steps
 *         ---
 *       `kind` is sequential | advisory | utility (default utility).
 *       `namespace` (when the file is flat) sets the group; it is derived from
 *       the directory when present. `triggers` are comma-separated hints the
 *       model sees to know which skill matches a request.
 *   - The first non-frontmatter, non-heading line is the description shown to
 *     the model. The rest is the full instructions, loaded only on demand.
 *   - Files/dirs starting with "_" are ignored (used for the README).
 *
 * The bundled harness skills in app/skills/ are seeded into userData/skills/
 * on startup (idempotent — only copied when missing) so the spec/oracle/code
 * workflow works out of the box and the user can edit or delete them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, SkillMeta } from "@core";

const MAX_SKILL_CHARS = 20_000;

const README = `# Cascade skills

Drop markdown files in this folder to teach Cascade repeatable workflows.

- The FILENAME (without .md) is the skill name; files under a subfolder are
  namespaced (skills/spec/research.md → "spec:research").
- An optional leading frontmatter block sets how the model treats the skill:
    ---
    kind: sequential | advisory | utility
    triggers: comma, separated, hints
    ---
- The first non-heading line after any frontmatter is the description shown
  to the model, so make it a clear one-sentence summary of when to use it.
- The rest of the file is the full instructions, loaded only when needed.
- Files and folders starting with _ are ignored.

Example — save as "spec/research.md":

---
kind: sequential
triggers: research the codebase, plan a feature
---
Explores the codebase and produces a spec.md.

# Research workflow
1. Read relevant files and patterns.
2. Write the findings to spec.md.
`;

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

interface SkillMetaRaw {
  name: string;
  description: string;
  namespace?: string;
  kind?: SkillMeta["kind"];
  triggers?: string[];
}

/** Parse an optional frontmatter block off the top of a skill file. */
export function parseFrontmatter(text: string): { meta: Partial<Pick<SkillMetaRaw, "namespace" | "kind" | "triggers">>; body: string } {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { meta: {}, body: text };
  const meta: Partial<Pick<SkillMetaRaw, "namespace" | "kind" | "triggers">> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!val) continue;
    if (key === "kind" && ["sequential", "advisory", "utility"].includes(val)) {
      meta.kind = val as SkillMeta["kind"];
    } else if (key === "namespace") {
      meta.namespace = val;
    } else if (key === "triggers") {
      meta.triggers = val.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Walk a skills dir (recursively, skipping _-prefixed entries) and build the
 *  list of { dir, name, file } skill sources. */
function walkSkills(dir: string): Array<{ namespace: string | undefined; name: string; file: string }> {
  const out: Array<{ namespace: string | undefined; name: string; file: string }> = [];
  const walk = (cur: string, namespace: string | undefined) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith("_")) continue;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        walk(full, namespace ?? ent.name);
      } else if (ent.isFile() && ent.name.endsWith(".md")) {
        const base = ent.name.slice(0, -3).replace(/[^a-zA-Z0-9_-]/g, "-");
        out.push({ namespace, name: base, file: full });
      }
    }
  };
  walk(dir, undefined);
  return out;
}

export function loadSkills(dir: string): SkillMeta[] {
  const skills: SkillMeta[] = [];
  for (const { namespace: dirNs, name, file } of walkSkills(dir)) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(text);
    const description =
      body
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#")) ?? "";
    const namespace = meta.namespace ?? dirNs;
    skills.push({
      name,
      description: description.slice(0, 200),
      ...(namespace ? { namespace } : {}),
      ...(meta.kind ? { kind: meta.kind } : {}),
      ...(meta.triggers?.length ? { triggers: meta.triggers } : {}),
    });
  }
  return skills;
}

/** Resolve a requested skill name (possibly "ns:name") to its file, or null. */
export function skillFileFor(dir: string, raw: string): string | null {
  const clean = raw.replace(/\.md$/i, "");
  const colon = clean.indexOf(":");
  let candidates: string[];
  if (colon !== -1) {
    const ns = clean.slice(0, colon).replace(/[^a-zA-Z0-9_-]/g, "-");
    const name = clean.slice(colon + 1).replace(/[^a-zA-Z0-9_-]/g, "-");
    candidates = [path.join(dir, ns, `${name}.md`)];
  } else {
    const name = clean.replace(/[^a-zA-Z0-9_-]/g, "-");
    candidates = [
      path.join(dir, `${name}.md`),
      ...walkSkills(dir).filter((s) => s.name === name).map((s) => s.file),
    ];
  }
  for (const file of candidates) {
    const safe = path.resolve(dir, file);
    if (!safe.startsWith(path.resolve(dir))) continue; // containment
    try {
      if (fs.statSync(safe).isFile()) return safe;
    } catch {
      // try next
    }
  }
  return null;
}

/** Read one skill's full content by advertised name (accepts "ns:name"). */
export function readSkillContent(dir: string, raw: string): string | null {
  const file = skillFileFor(dir, raw);
  if (!file) return null;
  try {
    return fs.readFileSync(file, "utf8").slice(0, MAX_SKILL_CHARS);
  } catch {
    return null;
  }
}

/**
 * Tool that returns a skill's full content by its advertised name (accepting
 * the "ns:name" form). Read-only, no approval needed.
 */
export function makeReadSkillTool(dir: string): AgentTool {
  return {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "read_skill",
        description: "Read the full instructions of a named skill listed in your system prompt (accepts namespaced names like spec:research).",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Skill name exactly as listed" } },
          required: ["name"],
        },
      },
    },
    run: async (args) => {
      const raw = typeof args.name === "string" ? args.name : "";
      const content = readSkillContent(dir, raw);
      if (content !== null) return content;
      const available = loadSkills(dir)
        .map((s) => (s.namespace ? `${s.namespace}:${s.name}` : s.name))
        .join(", ");
      return `ERROR: skill "${raw}" not found. Available: ${available || "(none)"}`;
    },
  };
}

/** Idempotently copy the bundled harness skills into a userData skills dir.
 *  Only namespace subdirectories (spec/, oracle/, code/, …) are seeded — a
 *  root-level file like magic-prompt.md is a production-pipeline prompt, not a
 *  chat skill, so it must not appear in the agent's skill list. */
export function seedSkills(userSkillsDir: string, bundledDir: string): void {
  ensureSkillsDir(userSkillsDir);
  let bundled: string[];
  try {
    bundled = fs.readdirSync(bundledDir);
  } catch {
    return; // bundled dir absent (e.g. tests) — nothing to seed
  }
  for (const entry of bundled) {
    const src = path.join(bundledDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(src);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || entry.startsWith("_")) continue;
    const destDir = path.join(userSkillsDir, entry);
    fs.mkdirSync(destDir, { recursive: true });
    let files: string[];
    try {
      files = fs.readdirSync(src);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".md") || f.startsWith("_")) continue;
      const dest = path.join(destDir, f);
      if (!fs.existsSync(dest)) fs.copyFileSync(path.join(src, f), dest);
    }
  }
}

export function ensureSkillsDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, "_README.md");
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, README, "utf8");
}
