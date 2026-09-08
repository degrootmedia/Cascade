/**
 * CLI harness for the Cascade agent core.
 *
 * Usage:
 *   $env:GAB_API_KEY = "..."          (PowerShell)
 *   npm run cli -- --workspace ../sandbox [--model arya] [--base-url https://gab.ai/v1]
 */
import * as readline from "node:readline/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "./agent.js";
import { ChatClient } from "./chat.js";
import type { ApprovalRequest, ApprovalDecision, AgentEvent } from "./types.js";

const apiKey = process.env.GAB_API_KEY ?? process.env.CASCADE_API_KEY;
if (!apiKey) {
  console.error('Set GAB_API_KEY (or CASCADE_API_KEY) first, e.g. PowerShell: $env:GAB_API_KEY = "your-key"');
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const workspaceRoot = path.resolve(argValue("--workspace") ?? "./workspace");
const model = argValue("--model") ?? "arya";
const baseUrl = argValue("--base-url");
fs.mkdirSync(workspaceRoot, { recursive: true });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

async function requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
  console.log(yellow(`\n⚠ Approval needed — ${req.summary}`));
  console.log(dim(req.detail.split("\n").map((l) => "  " + l).join("\n")));
  while (true) {
    const answer = (await rl.question(yellow("  Allow? [y]es / [a]lways this session / [n]o: "))).trim().toLowerCase();
    if (answer === "y" || answer === "yes") return "allow";
    if (answer === "a" || answer === "always") return "allow-session";
    if (answer === "n" || answer === "no") return "deny";
  }
}

function onEvent(e: AgentEvent) {
  switch (e.type) {
    case "text-delta":
      process.stdout.write(e.text);
      break;
    case "text-done":
      process.stdout.write("\n");
      break;
    case "tool-start":
      console.log(dim(`\n→ ${e.call.name}(${JSON.stringify(e.call.args).slice(0, 160)})`));
      break;
    case "tool-result":
      console.log(dim(`← ${e.isError ? red(e.result.slice(0, 200)) : e.result.slice(0, 200)}`));
      break;
    case "agent-done":
      // Streaming responses carry no usage data (verified 2026-08-04), so we
      // report the real account balance instead of an in-stream counter.
      // Billing can lag slightly, so treat the number as approximate.
      void showBalance();
      break;
    case "error":
      console.log(red(`\n[error] ${e.message}`));
      break;
  }
}

const client = new ChatClient(apiKey, baseUrl);

async function showBalance() {
  try {
    const balance = await client.balance();
    if (balance !== null) {
      console.log(dim(`\n[credits remaining: ~${balance}]`));
    }
  } catch {
    /* balance display is best-effort */
  }
}

const agent = new Agent({ apiKey, model, baseUrl, workspaceRoot, requestApproval, onEvent });

console.log(`Cascade CLI — model: ${model} — workspace: ${workspaceRoot}`);
console.log(dim('Type a request, or "exit" to quit.\n'));

while (true) {
  const input = (await rl.question("you> ")).trim();
  if (!input) continue;
  if (input === "exit" || input === "quit") break;
  await agent.send(input);
  console.log();
}
rl.close();
