/**
 * Skills live check: run ONE real agent turn in the BUILT app against a
 * throwaway copy of the user's profile, and record what the agent did.
 *
 *   npm run build            (first; this script runs out/main)
 *   node scripts/skills-live-check.mjs --scenario film --label before [--skills <dir>] [--out ../tasks/skills-live-check]
 *
 * What is copied into the temp profile: settings.json and "Local State" (so the
 * app can decrypt its own stored LLM key; the key is never read here) plus a
 * skills folder (--skills, default the real profile's skills/). Sessions, MCP
 * servers, productions and agents are NOT copied. The temp settings point the
 * workspace at a temp dir and turn on the submission dry run.
 *
 * Every approval request is DENIED unless the scenario's allowlist matches the
 * request's command detail, so nothing generates media, installs software or
 * edits files. The temp profile (with its copy of the encrypted key) and the
 * temp workspace are deleted at the end.
 *
 * Output: <out>/<timestamp>-<scenario>-<label>.json with every tool call,
 * approval decision and the final answer.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const electronPath = require("electron");
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const arg = (f, d) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};

/** Prompts are plain, the way a user would type them. `allow` lists regexes
 *  matched against the approval detail (the exact command for run_command). */
const SCENARIOS = {
  film: {
    prompt:
      "I want to make a 20-second animated short about a lighthouse keeper who befriends a seagull, using Cascade productions. " +
      "Before you call any production tool, tell me which skill you are following, then list the workflow steps you will take in order " +
      "and the exact cascade_* tool you will call at each step. Do not create or generate anything yet.",
    allow: [],
  },
  script: {
    prompt: "Run the script check skill with the word lighthouse and tell me the exact output line.",
    allow: ["echo_token\\.py"],
  },
  topview: {
    prompt: "Stage a simple 3D scene for me: a character sits next to a box, front view.",
    allow: ["^\\s*\"?[^\"\\s]*topview-3d-cli(\\.exe)?\"?\\s+(doctor|--version|--help)\\b"],
  },
};

const scenarioName = arg("--scenario", "");
const scenario = SCENARIOS[scenarioName];
if (!scenario) {
  console.error(`--scenario must be one of: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}
const label = arg("--label", "run");
const port = Number(arg("--port", "9334"));
const timeoutMs = Number(arg("--timeout", "300")) * 1000;
const sourceProfile = arg("--profile", path.join(process.env.APPDATA ?? "", "cascade-app"));
const skillsSrc = arg("--skills", path.join(sourceProfile, "skills"));
const outDir = path.resolve(appDir, arg("--out", "../tasks/skills-live-check"));

if (!fs.existsSync(path.join(appDir, "out", "main", "index.js"))) {
  console.error("No build found: run `npm run build` in app/ first.");
  process.exit(2);
}
for (const f of ["settings.json", "Local State"]) {
  if (!fs.existsSync(path.join(sourceProfile, f))) {
    console.error(`Profile file missing: ${path.join(sourceProfile, f)}`);
    process.exit(2);
  }
}

const s = JSON.parse(fs.readFileSync(path.join(sourceProfile, "settings.json"), "utf8"));
// --provider switches the temp copy to another provider whose key is already
// stored in the profile (e.g. gab); the real settings are never changed.
const provider = arg("--provider", "");
if (provider) {
  if (!s.encryptedApiKeys?.[provider]) {
    console.error(`No stored key for provider "${provider}" in the profile.`);
    process.exit(2);
  }
  s.provider = provider;
}
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-skills-live-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-skills-ws-"));
fs.copyFileSync(path.join(sourceProfile, "Local State"), path.join(userData, "Local State"));
Object.assign(s, {
  workspace,
  recentWorkspaces: [workspace],
  submissionDryRun: true,
  autonomousByDefault: false,
  followProduction: false,
  activeProductionId: null,
});
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify(s, null, 2));
fs.cpSync(skillsSrc, path.join(userData, "skills"), { recursive: true });

const env = { ...process.env, CASCADE_USER_DATA: userData, CASCADE_DEBUG_PORT: String(port) };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, ["."], { cwd: appDir, env, stdio: "ignore" });
const exited = new Promise((r) => child.once("exit", r));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
let record = {
  scenario: scenarioName,
  label,
  provider: s.provider,
  model: s.models?.[s.provider] ?? null,
  prompt: scenario.prompt,
  skillsSource: skillsSrc,
  startedAt: new Date().toISOString(),
};
let browser;
let exitCode = 0;
try {
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!browser) throw new Error("Could not attach to the app over CDP");
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) throw new Error("App window not found");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.cascade?.newSession), null, { timeout: 30000 });

  const result = await page.evaluate(
    async ({ prompt, allow, timeoutMs }) => {
      const allowRe = allow.map((a) => new RegExp(a, "i"));
      const sid = await window.cascade.newSession();
      const events = [];
      const approvals = [];
      let done;
      const finished = new Promise((r) => (done = r));
      const offEvent = window.cascade.onAgentEvent((e) => {
        if (e.sessionId !== sid) return;
        const ev = e.event;
        if (ev.type === "text-delta") return;
        events.push(ev);
        if (ev.type === "agent-done" || ev.type === "error") done();
      });
      const offApproval = window.cascade.onApprovalRequest((req) => {
        const decision = allowRe.some((re) => re.test(req.detail)) ? "allow" : "deny";
        approvals.push({ tool: req.tool, summary: req.summary, detail: req.detail, decision });
        window.cascade.respondApproval(req.id, decision);
      });
      const send = window.cascade.sendMessage(sid, prompt).catch((err) => events.push({ type: "error", message: String(err) }));
      const timer = new Promise((r) => setTimeout(() => r("timeout"), timeoutMs));
      const outcome = await Promise.race([finished.then(() => "done"), timer]);
      await Promise.race([send, new Promise((r) => setTimeout(r, 2000))]);
      offEvent();
      offApproval();
      return { sessionId: sid, outcome, events, approvals };
    },
    { prompt: scenario.prompt, allow: scenario.allow, timeoutMs }
  );

  const toolCalls = [];
  for (const ev of result.events) {
    if (ev.type === "tool-start") toolCalls.push({ name: ev.call.name, args: ev.call.args });
    if (ev.type === "tool-result") {
      const open = [...toolCalls].reverse().find((t) => t.name === ev.name && t.result === undefined);
      if (open) {
        open.isError = ev.isError;
        open.resultChars = ev.result.length;
        open.result = ev.result.length > 4000 ? `${ev.result.slice(0, 4000)}\n…[${ev.result.length - 4000} more chars]` : ev.result;
      }
    }
  }
  const final = result.events.filter((e) => e.type === "agent-done").pop();
  record = {
    ...record,
    outcome: result.outcome,
    toolCalls,
    approvals: result.approvals,
    errors: result.events.filter((e) => e.type === "error").map((e) => e.message),
    notices: result.events.filter((e) => e.type === "notice").map((e) => e.text),
    finalText: final?.finalText ?? null,
    credits: final?.totalCredits ?? null,
  };
  if (result.outcome !== "done" || record.errors.length) exitCode = 1;
} catch (e) {
  record.harnessError = String(e?.stack ?? e);
  exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
  for (const dir of [userData, workspace]) {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  record.tempProfileDeleted = !fs.existsSync(userData);
}

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${stamp}-${scenarioName}-${label}.json`);
fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
console.log(`scenario=${scenarioName} label=${label} outcome=${record.outcome ?? "harness-error"}`);
for (const t of record.toolCalls ?? []) {
  console.log(`  tool ${t.name} ${JSON.stringify(t.args).slice(0, 160)}${t.isError ? "  [error]" : ""}`);
}
for (const a of record.approvals ?? []) console.log(`  approval ${a.decision}: ${a.summary.slice(0, 140)}`);
for (const e of record.errors ?? []) console.log(`  agent error: ${e}`);
if (record.harnessError) console.log(`  harness error: ${record.harnessError.split("\n")[0]}`);
console.log(`  temp profile deleted: ${record.tempProfileDeleted}`);
console.log(`  -> ${outFile}`);
process.exit(exitCode);
