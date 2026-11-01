import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "./agent.js";

/** Build the reviewer's single prompt: instructions + spec + diff (never the implementer's chat). */
export function buildReviewPrompt(instructions: string, spec: string, diff: string): string {
  return `${instructions}\n\n=== ORIGINAL SPEC ===\n${spec}\n\n=== FINISHED DIFF ===\n${diff}\n`;
}

/** Run a read-only reviewer over spec + diff and return its graded report. */
export async function runReview(opts: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  workspaceRoot: string;
  spec: string;
  diff: string;
}): Promise<string> {
  const instructions = fs.readFileSync(path.join(opts.workspaceRoot, "tasks", "reviewer.md"), "utf8");
  let out = "";
  const agent = new Agent({
    apiKey: opts.apiKey,
    model: opts.model,
    baseUrl: opts.baseUrl,
    workspaceRoot: opts.workspaceRoot,
    reviewerMode: true,
    onEvent: (e) => {
      if (e.type === "text-delta") out += e.text;
    },
    requestApproval: async () => "deny",
  });
  await agent.send(buildReviewPrompt(instructions, opts.spec, opts.diff));
  return out;
}
