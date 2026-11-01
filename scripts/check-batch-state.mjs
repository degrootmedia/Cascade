// Verifies tasks/batch-state.json: valid shape, and versus git HEAD only `status` fields changed.
// Exit 0 = ok, 1 = violation. Usage: node scripts/check-batch-state.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = "tasks/batch-state.json";
const STATUSES = ["not-started", "in-progress", "passing", "blocked"];
const errors = [];

const cur = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
for (const it of cur.items ?? []) {
  for (const k of ["id", "title", "batch", "status"]) if (typeof it[k] !== "string") errors.push(`${it.id ?? "?"}: missing ${k}`);
  if (!STATUSES.includes(it.status)) errors.push(`${it.id}: bad status "${it.status}"`);
}

let headText = null;
// Baseline = the staged copy (`git add` after a legit seed), else the committed one.
for (const ref of [`:${file}`, `HEAD:${file}`]) {
  try {
    headText = execFileSync("git", ["show", ref], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
    break;
  } catch {
    /* try next baseline */
  }
}
if (headText) {
  const old = JSON.parse(headText);
  const oldById = new Map(old.items.map((i) => [i.id, i]));
  if (old.items.length !== cur.items.length || old.batch !== cur.batch) {
    // A new batch may reseed the file; only allowed when every id is new.
    const reseed = cur.items.every((i) => !oldById.has(i.id));
    if (!reseed) errors.push("items were added/removed or batch renamed (only allowed when reseeding a whole new batch)");
  } else {
    for (const it of cur.items) {
      const o = oldById.get(it.id);
      if (!o) { errors.push(`${it.id}: new id`); continue; }
      for (const k of Object.keys({ ...o, ...it })) {
        if (k !== "status" && o[k] !== it[k]) errors.push(`${it.id}: field "${k}" changed (only status may change)`);
      }
    }
  }
}
if (errors.length) {
  console.error("batch-state check FAILED:\n - " + errors.join("\n - "));
  process.exit(1);
}
console.log("batch-state check ok");
