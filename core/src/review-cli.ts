/**
 * Usage (from core/): npm run review -- --spec ../tasks/some-spec.txt [--base HEAD~1] [--model arya] [--base-url URL]
 * Diff = `git diff <base>` of the repo root (default HEAD, i.e. uncommitted work). Needs GAB_API_KEY.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { runReview } from "./review.js";

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apiKey = process.env.GAB_API_KEY ?? process.env.CASCADE_API_KEY;
const specPath = arg("--spec");
if (!apiKey || !specPath) {
  console.error("Need GAB_API_KEY and --spec <file>");
  process.exit(1);
}
const root = path.resolve("..");
const diff = execFileSync("git", ["diff", arg("--base") ?? "HEAD"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
const report = await runReview({
  apiKey,
  model: arg("--model") ?? "arya",
  baseUrl: arg("--base-url"),
  workspaceRoot: root,
  spec: fs.readFileSync(specPath, "utf8"),
  diff,
});
console.log(report);
