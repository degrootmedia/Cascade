/**
 * Flat-skill regression golden: a byte-exact copy of the real skills folder as
 * it was on 2026-11-25 (before folder-skill support) and the loader output the
 * pre-change code produced for it. Every flat skill must keep listing and
 * reading exactly as before. SKILLS_GOLDEN_WRITE=1 regenerates the golden —
 * only ever from the pre-change code; the committed file is that run.
 *
 * The one intended difference is BUG_LABEL: a namespace folder whose name
 * contains a space ("ux audit") was resolved through a sanitized path, so its
 * advertised name read a DIFFERENT file (or none). It must read its own file.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { SkillMeta } from "@core";
import { loadSkills, makeReadSkillTool, readSkillContent } from "../src/main/skills.js";

const FIXTURE = path.resolve(__dirname, "fixtures/skills-before");
const GOLDEN = path.resolve(__dirname, "fixtures/skills-before.golden.json");
const WRITE = process.env.SKILLS_GOLDEN_WRITE === "1";
const BUG_LABEL = "ux audit:ux-audit";

const label = (s: SkillMeta) => (s.namespace ? `${s.namespace}:${s.name}` : s.name);
const digest = (t: string | null) =>
  t === null ? null : { sha256: createHash("sha256").update(t).digest("hex"), chars: t.length };

async function snapshot() {
  const list = loadSkills(FIXTURE);
  const readTool = makeReadSkillTool(FIXTURE);
  const reads: Record<string, ReturnType<typeof digest>> = {};
  const tool: Record<string, ReturnType<typeof digest>> = {};
  for (const s of list) {
    const l = label(s);
    reads[l] = digest(readSkillContent(FIXTURE, l));
    tool[l] = digest((await readTool.run({ name: l }, FIXTURE)) as string);
  }
  const missing = await readTool.run({ name: "no-such-skill" }, FIXTURE);
  return { list, reads, tool, missing };
}

const omit = <T>(rec: Record<string, T>, key: string) => Object.fromEntries(Object.entries(rec).filter(([k]) => k !== key));

describe("skills golden (flat skills unchanged)", () => {
  it("lists and reads every flat skill exactly as the pre-change loader did (SKILLS_GOLDEN_WRITE=1 regenerates)", async () => {
    const snap = await snapshot();
    if (WRITE) {
      fs.writeFileSync(GOLDEN, JSON.stringify(snap, null, 2) + "\n");
      return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
    expect(snap.list).toEqual(golden.list);
    expect(snap.missing).toBe(golden.missing);
    expect(omit(snap.reads, BUG_LABEL)).toEqual(omit(golden.reads, BUG_LABEL));
    expect(omit(snap.tool, BUG_LABEL)).toEqual(omit(golden.tool, BUG_LABEL));
  });

  it("the converted production:film folder skill lists exactly like the flat original and loses no content", async () => {
    const CONVERTED = path.resolve(__dirname, "fixtures/skills-converted");
    const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
    // Same name, namespace, kind, triggers and description → same line in the
    // system prompt, so it triggers the same way.
    expect(loadSkills(CONVERTED)).toEqual(golden.list.filter((s: SkillMeta) => label(s) === "production:film"));

    // SKILL.md with the two-line pointer swapped back for the table rebuilds
    // the original file byte for byte.
    const dir = path.join(CONVERTED, "production", "film");
    const skill = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    const tools = fs.readFileSync(path.join(dir, "references", "tools.md"), "utf8");
    const pointer = [
      "The tool table (every `cascade_*` tool, its stage, and what it does) is in",
      "`references/tools.md`; load it with read_skill when you need it.",
    ].join("\n");
    const table = tools.split("\n").slice(2).join("\n").replace(/\n$/, "");
    expect(skill.replace(pointer, table)).toBe(fs.readFileSync(path.join(FIXTURE, "production", "film.md"), "utf8"));

    // The agent gets SKILL.md first and the table only on request.
    const readTool = makeReadSkillTool(CONVERTED);
    const main = (await readTool.run({ name: "production:film" }, CONVERTED)) as string;
    expect(main.startsWith(skill)).toBe(true);
    expect(main).toContain("- references/tools.md (");
    expect(main).not.toContain("| `cascade_list_productions` |");
    expect(await readTool.run({ name: "production:film", file: "references/tools.md" }, CONVERTED)).toBe(tools);
  });

  it("a namespace folder whose name has a space reads its own file", async () => {
    const own = fs.readFileSync(path.join(FIXTURE, "ux audit", "ux-audit.md"), "utf8");
    expect(readSkillContent(FIXTURE, BUG_LABEL)).toBe(own);
    expect(await makeReadSkillTool(FIXTURE).run({ name: BUG_LABEL }, FIXTURE)).toBe(own);
  });
});
