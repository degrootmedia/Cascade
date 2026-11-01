// Session start ritual: recent commits, batch scoreboard, smoke checks. Run before writing any code.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, cwd = root) => spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
const head = (t) => console.log(`\n=== ${t} ===`);

head("Last 5 commits");
run("git", ["log", "--oneline", "-5"]);

head("Batch state");
const st = JSON.parse(fs.readFileSync(path.join(root, "tasks/batch-state.json"), "utf8"));
const counts = {};
for (const i of st.items) counts[i.status] = (counts[i.status] ?? 0) + 1;
console.log(`batch: ${st.batch}  ${JSON.stringify(counts)}`);
for (const i of st.items) console.log(`  [${i.status.padEnd(11)}] ${i.id} ${i.title}`);
const next = st.items.find((i) => i.status === "in-progress") ?? st.items.find((i) => i.status === "not-started");
console.log(next ? `\nNEXT: ${next.id} - ${next.title}` : "\nNEXT: nothing left in this batch");
const check = run("node", ["scripts/check-batch-state.mjs"]);

head("Last progress.md entry");
const prog = fs.readFileSync(path.join(root, "tasks/progress.md"), "utf8").split(/^## /m);
console.log("## " + (prog[prog.length - 1] ?? "").trim());

head("Smoke checks (core typecheck+lint, guard tests)");
const a = run("npm", ["run", "check:fast"], path.join(root, "core"));
const b = run("npx", ["vitest", "run", "test/lessons-guards.test.ts", "test/source-guards.test.ts"], path.join(root, "app"));
const ok = check.status === 0 && a.status === 0 && b.status === 0;
console.log(ok ? "\nSESSION START: all green" : "\nSESSION START: PROBLEMS ABOVE - fix before new work");
process.exit(ok ? 0 : 1);
