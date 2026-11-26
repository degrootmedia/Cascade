/**
 * Skills: markdown instruction files the agent can pull in on demand.
 *
 * Skills live in userData/skills/. A skill is either ONE .md file, or a FOLDER
 * that contains SKILL.md (the Claude / Agent Skills format), optionally under a
 * namespace directory (e.g. spec/, oracle/, code/) so the agent can carry a
 * Research → Plan → Implement harness the way the Atelier post describes.
 *
 * Layout + metadata:
 *   - Flat file:     skills/weekly-report.md          → name "weekly-report"
 *   - Namespaced:    skills/spec/research.md          → name "spec:research"
 *   - Folder skill:  skills/topview-3d-cli/SKILL.md   → name "topview-3d-cli"
 *                    skills/production/film/SKILL.md → name "production:film"
 *     A directory holding SKILL.md is one skill, never a namespace: nothing
 *     inside it is listed as a separate skill. Its other .md files (typically
 *     references/*.md) are reference files the agent loads one at a time with
 *     read_skill's `file` argument; its scripts are listed, never run here.
 *   - Optional leading YAML frontmatter:
 *         ---
 *         name: topview-3d-cli          (Agent Skills; folder skills only)
 *         description: When to use it.  (Agent Skills; shown to the model)
 *         namespace: spec
 *         kind: sequential
 *         triggers: plan a feature, break a task into steps
 *         ---
 *       `kind` is sequential | advisory | utility (default utility).
 *       `namespace` sets the group; otherwise it is derived from the directory.
 *       `triggers` are comma-separated hints the model sees to know which skill
 *       matches a request. A frontmatter `description` (≤1024 chars) is shown
 *       to the model; without one, the first non-frontmatter, non-heading line
 *       (≤200 chars) is. The rest is the full instructions, loaded on demand.
 *   - Every file is read up to MAX_SKILL_CHARS; a folder skill as a whole may
 *     exceed that because its references load one at a time.
 *   - Files/dirs starting with "_" are ignored (used for the README).
 *
 * The bundled harness skills in app/skills/ are seeded into userData/skills/
 * on startup (idempotent — only copied when the skill is missing in either
 * form) so the spec/oracle/code workflow works out of the box and the user can
 * edit or delete them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { AgentTool, SkillMeta } from "@core";

/** Read cap per skill FILE (a flat skill, a SKILL.md, or one reference). */
const MAX_SKILL_CHARS = 20_000;
/** Agent Skills caps `description` at 1024 characters. */
const MAX_FRONTMATTER_DESCRIPTION_CHARS = 1024;
/** Body-derived descriptions keep their historical cap. */
const MAX_BODY_DESCRIPTION_CHARS = 200;
/** Index-listing limits so a huge folder cannot flood a read_skill result. */
const MAX_LISTED_FILES = 100;

const SKILL_FILE = "SKILL.md";

const README = `# Cascade skills

Drop skills in this folder to teach Cascade repeatable workflows.

Only add skills from sources you trust. A skill's instructions steer the
agent, and any scripts a skill folder bundles run on your computer with your
permissions when the agent runs them.

Single-file skills
- A .md file is one skill. The FILENAME (without .md) is the skill name; files
  under a subfolder are namespaced (skills/spec/research.md → "spec:research").
- An optional leading frontmatter block sets how the model treats the skill:
    ---
    kind: sequential | advisory | utility
    triggers: comma, separated, hints
    ---
- The first non-heading line after any frontmatter is the description shown
  to the model, so make it a clear one-sentence summary of when to use it.
- The rest of the file is the full instructions, loaded only when needed.

Folder skills (the Claude / Agent Skills format)
- A folder that contains SKILL.md is one skill, at the top level or inside a
  namespace folder (skills/production/film/SKILL.md → "production:film"). Its
  frontmatter name (or else the folder name) is the skill name.
- Frontmatter may use name and description as well as kind, namespace and
  triggers. A frontmatter description is what the model sees.
- The agent reads SKILL.md first. The folder's other .md files (for example
  references/*.md) load only when the agent asks for one.
- Each file is read up to 20,000 characters; a folder skill as a whole may be
  larger.
- Scripts in a skill folder never run by themselves. The agent can run one
  with its run_command tool, which asks you first, unless autonomous mode or
  an "always allow" choice is on, as for any command.

Files and folders starting with _ are ignored.

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

/** SHA-256 (of the LF-normalized text) of every README this module shipped
 *  before. A _README.md that still matches one is replaced with the current
 *  text; an edited one is left alone. */
const PREVIOUS_DEFAULT_READMES = new Set([
  "7487de14b2fca86ed9489dc865b3f73793be46bce46e6c6fa67cf620d80d6edb", // 2026-08-25
  "1baf7fd94f24891ec47ceb8e16573a7422cbe7138416d0bbb535d1b0ef6b45b3", // 2026-09-08
]);

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  namespace?: string;
  kind?: SkillMeta["kind"];
  triggers?: string[];
}

/** Remove one level of YAML quoting from a scalar. */
function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\n])/g, (_m, c: string) => (c === "n" ? "\n" : c));
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * Read the top-level `key: value` pairs of a frontmatter block. Enough YAML for
 * skill headers: one-line values (quoted or not), indented continuation lines,
 * `>` / `|` block scalars and `- item` lists (joined with ", "). Nested maps and
 * other keys (license, allowed-tools, metadata…) are read past and ignored.
 */
function readFrontmatterBlock(block: string): Record<string, string> {
  const lines = block.replace(/\r\n?/g, "\n").split("\n");
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s/.test(line) || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/);
    if (!m) continue;
    const key = m[1];
    const head = m[2].trim();
    const cont: string[] = [];
    const continues = (l: string) => /^\s/.test(l) || !l.trim() || (!head && /^-\s/.test(l));
    while (i + 1 < lines.length && continues(lines[i + 1])) cont.push(lines[++i]);
    while (cont.length && !cont[cont.length - 1].trim()) cont.pop();
    let value: string;
    const block = head.match(/^([>|])[+-]?$/);
    if (block) {
      const indent = Math.min(...cont.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
      const body = cont.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      value =
        block[1] === "|"
          ? body.join("\n")
          : body.reduce((acc, l) => (!l.trim() ? `${acc}\n` : acc && !acc.endsWith("\n") ? `${acc} ${l.trim()}` : `${acc}${l.trim()}`), "");
    } else if (!head && cont.length && cont.every((l) => !l.trim() || /^\s*-\s/.test(l))) {
      value = cont
        .map((l) => l.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean)
        .map(unquote)
        .join(", ");
    } else {
      value = [unquote(head), ...cont.map((l) => l.trim())].filter(Boolean).join(" ");
    }
    out[key] = value.trim();
  }
  return out;
}

/** Parse an optional frontmatter block off the top of a skill file. */
export function parseFrontmatter(text: string): { meta: SkillFrontmatter; body: string } {
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const m = src.match(FRONTMATTER_RE);
  if (!m) return { meta: {}, body: text };
  const meta: SkillFrontmatter = {};
  for (const [key, val] of Object.entries(readFrontmatterBlock(m[1]))) {
    if (!val) continue;
    if (key === "kind" && ["sequential", "advisory", "utility"].includes(val)) {
      meta.kind = val as SkillMeta["kind"];
    } else if (key === "namespace") {
      meta.namespace = val;
    } else if (key === "triggers") {
      meta.triggers = val.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (key === "name") {
      meta.name = val;
    } else if (key === "description") {
      meta.description = val;
    }
  }
  return { meta, body: src.slice(m[0].length) };
}

const sanitizeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "-");

/** Where one skill lives on disk. */
interface SkillSource {
  /** Namespace from the enclosing directory (undefined at the top level). */
  namespace: string | undefined;
  /** Name from the file or folder name. */
  name: string;
  /** The flat .md file, or the folder skill's SKILL.md. */
  file: string;
  /** Folder skills only: the skill's own directory. */
  folder?: string;
}

/** Walk a skills dir (recursively, skipping _-prefixed entries). A directory
 *  holding SKILL.md is one folder skill; any other directory is a namespace. */
function walkSkills(dir: string): SkillSource[] {
  const out: SkillSource[] = [];
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
        if (hasSkillFile(full)) {
          out.push({ namespace, name: sanitizeName(ent.name), file: path.join(full, SKILL_FILE), folder: full });
        } else {
          walk(full, namespace ?? ent.name);
        }
      } else if (ent.isFile() && ent.name.endsWith(".md")) {
        out.push({ namespace, name: sanitizeName(ent.name.slice(0, -3)), file: full });
      }
    }
  };
  walk(dir, undefined);
  return out;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Does `dir` hold a file named exactly SKILL.md? (Exact case: on a
 *  case-insensitive disk a flat skill called skill.md stays a flat skill.) */
function hasSkillFile(dir: string): boolean {
  try {
    return fs.readdirSync(dir).includes(SKILL_FILE) && isFile(path.join(dir, SKILL_FILE));
  } catch {
    return false;
  }
}

const labelOf = (s: { name: string; namespace?: string }) => (s.namespace ? `${s.namespace}:${s.name}` : s.name);

interface ResolvedSkill {
  meta: SkillMeta;
  source: SkillSource;
  label: string;
}

/** Discover every skill with its metadata, one entry per advertised label. When
 *  a label is taken twice, a folder skill wins over a flat file (the newer
 *  format); otherwise the first one found is kept. */
function resolveSkills(dir: string): ResolvedSkill[] {
  const out: ResolvedSkill[] = [];
  for (const source of walkSkills(dir)) {
    let text = "";
    try {
      text = fs.readFileSync(source.file, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(text);
    const name = source.folder && meta.name ? sanitizeName(meta.name) : source.name;
    const description = meta.description
      ? meta.description.slice(0, MAX_FRONTMATTER_DESCRIPTION_CHARS)
      : (body
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith("#")) ?? ""
        ).slice(0, MAX_BODY_DESCRIPTION_CHARS);
    const namespace = meta.namespace ?? source.namespace;
    const skill: SkillMeta = {
      name,
      description,
      ...(namespace ? { namespace } : {}),
      ...(meta.kind ? { kind: meta.kind } : {}),
      ...(meta.triggers?.length ? { triggers: meta.triggers } : {}),
    };
    const resolved: ResolvedSkill = { meta: skill, source, label: labelOf(skill) };
    const clash = out.findIndex((r) => r.label === resolved.label);
    if (clash === -1) out.push(resolved);
    else if (source.folder && !out[clash].source.folder) out[clash] = resolved;
  }
  return out;
}

export function loadSkills(dir: string): SkillMeta[] {
  return resolveSkills(dir).map((r) => r.meta);
}

/** True when `p` is `root` or inside it. Skill and reference paths come from
 *  directory walks (which never follow links), not from the model's input;
 *  this is defense in depth. */
function isInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolve a requested skill name (the advertised label, possibly "ns:name") to
 *  its skill. An un-namespaced name prefers a top-level skill, then any skill
 *  of that name; a namespaced one also matches with a sanitized namespace. */
function findSkill(dir: string, raw: string): ResolvedSkill | null {
  const clean = raw.trim().replace(/\.md$/i, "");
  if (!clean) return null;
  const skills = resolveSkills(dir);
  const exact = skills.find((s) => s.label === clean);
  if (exact) return exact;
  const colon = clean.indexOf(":");
  if (colon === -1) {
    const name = sanitizeName(clean);
    const named = skills.filter((s) => s.meta.name === name);
    return named.find((s) => !s.meta.namespace) ?? named[0] ?? null;
  }
  const ns = sanitizeName(clean.slice(0, colon));
  const name = sanitizeName(clean.slice(colon + 1));
  return skills.find((s) => s.meta.name === name && s.meta.namespace !== undefined && sanitizeName(s.meta.namespace) === ns) ?? null;
}

/** Resolve a requested skill name (accepts "ns:name") to its main file — the
 *  flat .md or the folder skill's SKILL.md — or null. */
export function skillFileFor(dir: string, raw: string): string | null {
  return findSkill(dir, raw)?.source.file ?? null;
}

/** Read one skill's main file by advertised name (accepts "ns:name"), capped
 *  at MAX_SKILL_CHARS. For a folder skill this is SKILL.md alone. */
export function readSkillContent(dir: string, raw: string): string | null {
  const file = skillFileFor(dir, raw);
  if (!file) return null;
  try {
    return fs.readFileSync(file, "utf8").slice(0, MAX_SKILL_CHARS);
  } catch {
    return null;
  }
}

/** Interpreter per script extension; the agent runs `<interpreter> "<path>"`. */
const SCRIPT_INTERPRETERS: Record<string, string | null> = {
  ".py": "python",
  ".js": "node",
  ".mjs": "node",
  ".cjs": "node",
  ".sh": "bash",
  ".ps1": "powershell -NoProfile -File",
  ".bat": "cmd /c",
  ".cmd": "cmd /c",
  ".rb": "ruby",
  ".pl": "perl",
  ".ts": null,
};

export interface FolderSkillFiles {
  /** Markdown files other than the root SKILL.md, relative ("/"-separated). */
  references: Array<{ path: string; chars: number }>;
  /** Script files: a known script extension anywhere, or anything non-markdown under scripts/. */
  scripts: string[];
  /** Everything else (assets, templates, data). */
  other: string[];
}

/** List a folder skill's files. Skips _-prefixed and dot entries, node_modules
 *  and __pycache__, as the skills folder itself does. */
export function listFolderSkillFiles(folder: string): FolderSkillFiles {
  const files: FolderSkillFiles = { references: [], scripts: [], other: [] };
  const walk = (cur: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith("_") || ent.name.startsWith(".") || ent.name === "node_modules") continue;
      const full = path.join(cur, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(full, relPath);
        continue;
      }
      if (!ent.isFile() || relPath === SKILL_FILE) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (ext === ".md") {
        let chars = 0;
        try {
          chars = fs.readFileSync(full, "utf8").length;
        } catch {
          // listed with 0 when unreadable; reading it reports the error
        }
        files.references.push({ path: relPath, chars });
      } else if (ext in SCRIPT_INTERPRETERS || relPath.startsWith("scripts/")) {
        files.scripts.push(relPath);
      } else {
        files.other.push(relPath);
      }
    }
  };
  walk(folder, "");
  return files;
}

/** Cap one folder-skill file, saying so when it was cut. */
function capped(text: string, rel: string): string {
  if (text.length <= MAX_SKILL_CHARS) return text;
  return (
    text.slice(0, MAX_SKILL_CHARS) +
    `\n\n[Truncated: ${rel} is ${text.length.toLocaleString("en-US")} characters; Cascade reads the first ${MAX_SKILL_CHARS.toLocaleString("en-US")} of each skill file.]`
  );
}

const listCapped = (items: string[]) =>
  items.length > MAX_LISTED_FILES
    ? [...items.slice(0, MAX_LISTED_FILES), `… and ${items.length - MAX_LISTED_FILES} more`]
    : items;

/** The index appended to a folder skill's SKILL.md: what else the skill has and
 *  how to reach it. Reference text itself is NOT included. */
function folderSkillIndex(skill: ResolvedSkill): string {
  const folder = skill.source.folder!;
  const files = listFolderSkillFiles(folder);
  const parts = [`\n\n---\nFolder skill "${skill.label}" lives in ${folder}`];
  if (files.references.length) {
    parts.push(
      `Reference files (not loaded yet). Read one only when these instructions point to it, with read_skill {"name": "${skill.label}", "file": "<path>"}:\n` +
        listCapped(files.references.map((r) => `- ${r.path} (${r.chars.toLocaleString("en-US")} chars)`)).join("\n")
    );
  }
  if (files.scripts.length) {
    parts.push(
      `Scripts (never loaded as instructions, never run automatically). To run one, call run_command with its interpreter and full path; the user is asked first, and the working directory stays the workspace:\n` +
        listCapped(
          files.scripts.map((rel) => {
            const abs = path.join(folder, ...rel.split("/"));
            const interp = SCRIPT_INTERPRETERS[path.extname(rel).toLowerCase()];
            return interp ? `- ${rel} → ${interp} "${abs}"` : `- ${rel} → "${abs}" (pick the interpreter it needs)`;
          })
        ).join("\n")
    );
  }
  if (files.other.length) {
    parts.push(
      `Other files (paths only, for scripts or instructions that name them):\n` +
        listCapped(files.other.map((rel) => `- ${rel} → "${path.join(folder, ...rel.split("/"))}"`)).join("\n")
    );
  }
  return parts.join("\n\n");
}

/** Read a folder skill's file by the path the agent gave: the exact path
 *  relative to the skill folder, else a reference with that unique basename. */
function readFolderSkillFile(skill: ResolvedSkill, requested: string): string {
  const folder = skill.source.folder!;
  const rel = requested.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  const base = rel.split("/").pop() ?? "";
  if (base === SKILL_FILE) return capped(fs.readFileSync(skill.source.file, "utf8"), SKILL_FILE) + folderSkillIndex(skill);
  const files = listFolderSkillFiles(folder);
  const refList = files.references.map((r) => r.path).join(", ") || "(none)";
  const ext = path.extname(rel).toLowerCase();
  if (ext !== ".md") {
    const isScript = files.scripts.includes(rel) || ext in SCRIPT_INTERPRETERS;
    return isScript
      ? `ERROR: "${rel}" is a script, not a reference file. read_skill only loads markdown; run the script with run_command as the skill's index shows.`
      : `ERROR: read_skill only loads markdown reference files. Reference files of "${skill.label}": ${refList}`;
  }
  let match = files.references.find((r) => r.path === rel);
  if (!match) {
    const byBase = files.references.filter((r) => r.path.split("/").pop() === base);
    if (byBase.length === 1) match = byBase[0];
  }
  if (!match) return `ERROR: "${requested}" is not a reference file of skill "${skill.label}". Reference files: ${refList}`;
  const abs = path.join(folder, ...match.path.split("/"));
  if (!isInside(folder, abs)) return `ERROR: "${requested}" is outside the skill folder.`;
  try {
    return capped(fs.readFileSync(abs, "utf8"), match.path);
  } catch (e) {
    return `ERROR: could not read ${match.path}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Tool that returns a skill's instructions by its advertised name (accepting
 * the "ns:name" form). Read-only, no approval needed. A flat skill returns its
 * file exactly as before. A folder skill returns SKILL.md plus an index of its
 * reference files and scripts; `file` loads one reference on demand.
 */
export function makeReadSkillTool(dir: string): AgentTool {
  return {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "read_skill",
        description:
          "Read the full instructions of a named skill listed in your system prompt (accepts namespaced names like spec:research). " +
          "For a folder skill this returns its SKILL.md and lists its reference files; pass `file` to load one of those references.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Skill name exactly as listed" },
            file: {
              type: "string",
              description: "Folder skills only: a reference file to load, as listed after SKILL.md (e.g. references/layout.md). Omit to read SKILL.md.",
            },
          },
          required: ["name"],
        },
      },
    },
    run: async (args) => {
      const raw = typeof args.name === "string" ? args.name : "";
      const file = typeof args.file === "string" ? args.file.trim() : "";
      const skill = findSkill(dir, raw);
      let text: string | null = null;
      if (skill) {
        try {
          text = fs.readFileSync(skill.source.file, "utf8");
        } catch {
          text = null;
        }
      }
      if (!skill || text === null) {
        const available = loadSkills(dir)
          .map((s) => (s.namespace ? `${s.namespace}:${s.name}` : s.name))
          .join(", ");
        return `ERROR: skill "${raw}" not found. Available: ${available || "(none)"}`;
      }
      if (!skill.source.folder) {
        if (file) return `ERROR: "${skill.label}" is a single-file skill and has no reference files. Call read_skill with just its name.`;
        return text.slice(0, MAX_SKILL_CHARS);
      }
      if (file) return readFolderSkillFile(skill, file);
      return capped(text, SKILL_FILE) + folderSkillIndex(skill);
    },
  };
}

/** Is the skill `ns/name` already in a skills dir, as a flat file or a folder? */
function skillPresent(userSkillsDir: string, rel: string[]): boolean {
  const base = path.join(userSkillsDir, ...rel);
  return isFile(`${base}.md`) || isFile(path.join(base, SKILL_FILE));
}

/** Copy a bundled folder skill, skipping _-prefixed entries. */
function copyFolderSkill(src: string, dest: string): void {
  fs.cpSync(src, dest, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (p) => !path.basename(p).startsWith("_") || p === src,
  });
}

/** Idempotently copy the bundled harness skills into a userData skills dir.
 *  Only namespace subdirectories (spec/, oracle/, code/, …) and top-level
 *  folder skills are seeded — a root-level file like magic-prompt.md is a
 *  production-pipeline prompt, not a chat skill, so it must not appear in the
 *  agent's skill list. A skill the user already has in EITHER form (flat .md
 *  or folder) is never seeded again, so converting one never duplicates it. */
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
    if (isFile(path.join(src, SKILL_FILE))) {
      if (!skillPresent(userSkillsDir, [entry])) copyFolderSkill(src, path.join(userSkillsDir, entry));
      continue;
    }
    const destDir = path.join(userSkillsDir, entry);
    fs.mkdirSync(destDir, { recursive: true });
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(src, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.name.startsWith("_")) continue;
      if (f.isFile() && f.name.endsWith(".md")) {
        if (!skillPresent(userSkillsDir, [entry, f.name.slice(0, -3)])) {
          fs.copyFileSync(path.join(src, f.name), path.join(destDir, f.name));
        }
      } else if (f.isDirectory() && isFile(path.join(src, f.name, SKILL_FILE))) {
        if (!skillPresent(userSkillsDir, [entry, f.name])) copyFolderSkill(path.join(src, f.name), path.join(destDir, f.name));
      }
    }
  }
}

const readmeDigest = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

/** Create the skills dir and its _README.md. An existing README is replaced
 *  only when it is an unedited copy of an earlier default. */
export function ensureSkillsDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, "_README.md");
  let current: string | null = null;
  try {
    current = fs.readFileSync(readme, "utf8");
  } catch {
    current = null;
  }
  if (current === null || (current !== README && PREVIOUS_DEFAULT_READMES.has(readmeDigest(current)))) {
    fs.writeFileSync(readme, README, "utf8");
  }
}
