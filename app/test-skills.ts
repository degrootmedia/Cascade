/** Quick check of the skills loader + read_skill tool. Run: npx tsx test-skills.ts */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkills, makeReadSkillTool, ensureSkillsDir } from "./src/main/skills.js";

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-skills-"));
  ensureSkillsDir(dir);

  fs.writeFileSync(
    path.join(dir, "weekly-report.md"),
    "Formats my weekly status report from raw notes.\n\n# Steps\n1. Group by status.\n"
  );
  fs.writeFileSync(path.join(dir, "_ignored.md"), "should not appear");

  const skills = loadSkills(dir);
  console.log("skills:", JSON.stringify(skills));
  if (skills.length !== 1) throw new Error(`expected 1 skill, got ${skills.length}`);
  if (skills[0].name !== "weekly-report") throw new Error("bad name");
  if (!skills[0].description.includes("weekly status")) throw new Error("bad description");

  const tool = makeReadSkillTool(dir);
  const content = await tool.run({ name: "weekly-report" }, dir);
  if (!content.includes("Group by status")) throw new Error("read_skill content wrong");

  const missing = await tool.run({ name: "nope" }, dir);
  if (!missing.includes("ERROR") || !missing.includes("weekly-report")) throw new Error("missing-skill handling wrong");

  const escape = await tool.run({ name: "../../../etc/passwd" }, dir);
  if (!escape.includes("ERROR")) throw new Error("path escape not blocked");

  console.log("ALL SKILLS CHECKS PASSED");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
