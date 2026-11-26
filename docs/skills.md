# Cascade skills

Skills are instruction files the chat agent loads on demand. They live in
`%APPDATA%\cascade-app\skills\` (`userData/skills/`). The loader is
`app/src/main/skills.ts`; the system-prompt listing is `skillsPrompt` in
`core/src/prompts.ts`; the agent reads a skill with the `read_skill` tool.

## Trust rule

**Install skills only from sources you trust.** A skill's instructions steer
the agent. A skill folder can also bundle scripts, which run on your computer
with your permissions whenever the agent runs them. Read a downloaded skill's
`SKILL.md` and its scripts before you put it in the skills folder. The same
rule is in the folder's `_README.md` and in the Settings help text.

## Two formats

| | Single-file skill | Folder skill (Claude / Agent Skills format) |
|---|---|---|
| On disk | `name.md`, or `ns/name.md` | a directory holding `SKILL.md`, at the top level or inside a namespace directory |
| Name | the file name | frontmatter `name`, else the folder name |
| Example | `spec/research.md` → `spec:research` | `topview-3d-cli/SKILL.md` → `topview-3d-cli`; `production/film/SKILL.md` → `production:film` |
| What `read_skill {name}` returns | the file (first 20,000 characters), exactly as before folder skills existed | `SKILL.md` (first 20,000 characters) plus an index: the skill's folder, its reference files with sizes, its scripts and other files |
| Reference files | none (`file` is refused) | every other `.md` in the folder (usually `references/*.md`), loaded one at a time with `read_skill {name, file}` |

- A directory holding `SKILL.md` (exact case) is one skill and never a
  namespace. Nothing inside it is listed as a separate skill.
- `file` accepts the path relative to the skill folder (`references/layout.md`,
  `./references/layout.md`, `references\layout.md`) or a unique basename
  (`layout.md`). `../SKILL.md`, which reference files use to point back,
  returns `SKILL.md` with its index. Paths that leave the skill folder are refused.
- **The 20,000-character cap is per file.** A folder skill as a whole may be far
  larger: the Topview skill is 117k characters in 13 files, and none is cut. A
  file over the cap is cut with an explicit `[Truncated: …]` note (flat skills
  keep their old silent cut, unchanged).
- Files and folders starting with `_` are ignored, inside skill folders too.
- When a flat file and a folder skill claim the same name, the folder skill
  wins and the name is listed once.

### Frontmatter

Both shapes are accepted, and both apply when both are present:

```yaml
---
name: stage-3d                 # Agent Skills: the skill's name (folder skills)
description: >                 # Agent Skills: shown to the model for relevance
  Block out 3D staging scenes. Use when the user asks to stage a scene.
kind: sequential               # Cascade: sequential | advisory | utility
namespace: production          # Cascade: groups the skill (else from the directory)
triggers: stage a scene, block out a shot   # Cascade: routing hints in the prompt
license: Apache-2.0            # anything else is read past and ignored
---
```

- `description` from frontmatter is shown to the model, capped at 1,024
  characters (the Agent Skills limit). Without one, the first body line that is
  not a heading is shown, capped at 200 characters, as before.
- `triggers` stay what they were: routing hints in the system prompt, next to
  the description.
- The parser handles what skill headers use: one-line values (quoted or not),
  `>` / `|` block scalars, indented continuation lines, `- item` lists, CRLF
  and a leading byte-order mark.

### Seeding

Bundled skills in `app/skills/` are copied into the user folder at startup
when missing, including bundled folder skills with their references. A skill
the user already has in either form (flat `ns/name.md` or folder
`ns/name/SKILL.md`) is never seeded again, so converting a skill never brings
back a duplicate. An unedited `_README.md` from an earlier release is replaced
with the current one; an edited one is left alone.

## Scripts rule (decided 2026-11-25)

Skill folders may bundle scripts (`.py`, `.js`/`.mjs`/`.cjs`, `.sh`, `.ps1`,
`.bat`/`.cmd`, `.rb`, `.pl`, `.ts`, and anything else under `scripts/`).

- **The loader never runs anything.** Listing skills and `read_skill` only read
  markdown.
- `read_skill` never returns a script's source as instructions. It lists each
  script with its absolute path and an interpreter hint, for example
  `- scripts/echo_token.py → python "C:\…\skills\script-check\scripts\echo_token.py"`.
  Asking `read_skill` for a script returns an error telling the agent to run it
  with `run_command` instead, so a script is never half-used as text.
- **The agent runs a script only through `run_command`**, in place from its skill
  folder (nothing is copied). The working directory stays the chat's workspace,
  so outputs land in the user's project. `run_command` spawns one program with
  no shell, so a script needs its interpreter as the first word.
  (`run_command` refuses `.bat`, `.cmd`, `.ps1`, `.js`, `.vbs` and `.msi` files
  as the program, and Windows cannot start a `.py` or `.sh` file by itself.)
  The interpreter must be on PATH. A missing one comes back as a visible error.
- **Confirmation is the normal approval prompt**, showing the full command. In
  autonomous mode, or after an "always allow" choice for `run_command`, a skill
  script runs without a prompt, like any other command. The trust rule above is
  the safeguard at install time.

## Inventory and conversions (2026-11-25)

The user skills folder held 11 skills (sizes in characters):

| Skill | Kind | Size | What it covers | Decision |
|---|---|---:|---|---|
| `spec:research` | sequential | 942 | explore the workspace, write spec.md | flat: short |
| `spec:plan` | sequential | 1,085 | turn research into a plan.json task list | flat: short |
| `spec:implement` | sequential | 991 | execute the plan test-first | flat: short |
| `spec:finish` | sequential | 628 | final validation and review pass | flat: short |
| `oracle:architect` | advisory | 807 | component responsibilities, DDD-style | flat: short |
| `oracle:challenge` | advisory | 638 | poke holes in an approach | flat: short |
| `code:commit` | utility | 586 | stage and commit with a clear message | flat: short |
| `code:review` | utility | 592 | review current changes | flat: short |
| `production:film` | sequential | 10,791 (bundled 11,412) | make a short film through the `cascade_*` tools | **converted**: the `cascade_*` tool table (16–17 rows) moved to `references/tools.md` |
| `ux-audit:ux-audit` | utility | 7,931 | audit Cascade's own UI from screenshots | flat: every section is used on every audit, so nothing to load on demand |
| `ux audit:ux-audit` | utility | 7,848 | the same skill: the user's original folder (LF); `ux-audit` is the copy seeded on 2026-11-25 (CRLF), same text | **deleted** (operator decision); the seeded copy remains |

None was near the 20k cap. `production:film` was the only skill with reference
material: a tool table that repeats each tool's own description. Its
`SKILL.md` keeps the frontmatter, purpose, rules, workflow, the `view_image`
note and the scope line, plus a two-line pointer to the table. The listing
(name, namespace, kind, triggers, description) is identical, so it triggers
the same way. Swapping the pointer back for the table rebuilds the original
byte for byte (`app/test/skills-golden.test.ts`). Both the bundled copy and
the user's copy were converted, the user's from its own (older) text.

Found during the inventory: `ux audit:ux-audit` could not be read by its own
name. The old lookup rebuilt the path with a sanitized namespace (`ux-audit/`),
so it returned "not found", and after 2026-11-25 it returned the other copy.
Lookups now match the advertised name.

## Related work

- **Feature #32 (lean context: load skills only when triggered)** points the same
  way. This change already keeps reference files out of context until asked
  for. It adds no caching: `loadSkills` and `read_skill` still read from disk on
  each agent build and each call, as before, so #32's caching work does not
  overlap. One overlap to weigh in #32: a folder skill's frontmatter
  description may be up to 1,024 characters (the Topview one is about 1,000),
  and it sits in every system prompt. #32's trigger gating should cover it.
- Out of scope: a plugin system (marketplaces, hooks, bundled MCP servers).
  Cascade keeps its own MCP settings. A plugin's `.mcp.json` is not read.

## Verification tools

- `app/test/skills-golden.test.ts`: a byte-exact copy of the 2026-11-25 skills
  folder (`app/test/fixtures/skills-before/`) and the pre-change loader's output
  (`skills-before.golden.json`). Every flat skill must list and read exactly as
  before. `SKILLS_GOLDEN_WRITE=1` regenerates the golden, and only ever from
  pre-change code. The fixtures are `-text` in `.gitattributes` so line endings
  stay exact.
- `app/test/skills.test.ts`: folder skills, references, the per-file cap,
  frontmatter, scripts (listed, never run by the loader, runnable in place
  through `run_command`'s own spawn), seeding and the README migration.
- `app/scripts/skills-live-check.mjs`: one real agent turn in the built app,
  against a throwaway copy of the profile. Only `settings.json` and `Local
  State` are copied, plus a chosen skills folder. Approvals are auto-denied
  except a per-scenario allowlist, and the copy is deleted afterward.
  Scenarios: `film`, `script`, `topview`. Pass `--provider` to use another
  stored provider key. Not yet run to completion: the configured provider had
  no balance on 2026-11-25.
