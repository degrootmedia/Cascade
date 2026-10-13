/**
 * Automated verification feedback: after the agent mutates the workspace, run
 * the checks the user configured for that workspace (typecheck, lint, test, …)
 * and feed any failures back into the loop so the model can self-correct.
 *
 * Safety posture mirrors `run_command` in tools.ts:
 *  - commands are stored as `argv` arrays (never a shell string), so there is
 *    no shell to inject into;
 *  - spawn uses `shell: false`;
 *  - `cwd` is resolved through `resolveSafe` so it can never escape the
 *    workspace;
 *  - oversized output is spilled to `.cascade/tool-output/` through the same
 *    `spillContent` path as tool output, so no bytes are destroyed.
 *
 * Nothing here runs unless the host explicitly provides a `VerificationConfig`
 * (or a resolver that gets the user's consent). With no config, the agent loop
 * behaves exactly as it did before.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { resolveSafe, WorkspaceError } from "./workspace.js";
import { spillContent } from "./spill.js";
import { applySandbox, normalizeSandboxMode, type SandboxMode } from "./sandbox.js";

/** Default per-command timeout. Verification gets a longer budget than the
 *  ad-hoc 60s `run_command` because a full test/lint pass can be slow. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;

/** Default cap on automatic repair rounds before the loop gives up. */
export const DEFAULT_MAX_REPAIR_ROUNDS = 2;

/** Output longer than this spills to `.cascade/tool-output/`. */
export const MAX_VERIFY_OUTPUT_CHARS = 10_000;

/** Per-command tail budget included in the model-facing feedback message. */
export const VERIFY_FEEDBACK_BUDGET_CHARS = 8_000;

export interface VerifyCommand {
  /** Short label shown to the user, e.g. "typecheck". */
  name: string;
  /** argv, never a shell string: ["npm", "run", "typecheck"]. */
  argv: string[];
  /** Workspace-relative working directory; defaults to the workspace root. */
  cwd?: string;
}

export interface VerifyResult {
  name: string;
  argv: string[];
  /** Process exit code, or null when the process could not be started. */
  exitCode: number | null;
  timedOut: boolean;
  /** Combined stdout+stderr (spilled when oversized). */
  output: string;
}

export interface VerificationConfig {
  commands: VerifyCommand[];
  /** Repair rounds allowed before giving up (default 2). */
  maxRepairRounds?: number;
  /** Per-command timeout in ms (default 120_000). */
  timeoutMs?: number;
  /** Stop after the first failing command instead of running the rest. */
  stopOnFirstFailure?: boolean;
  /**
   * Optional OS-level sandbox for the checks (see sandbox.ts). Default "none":
   * approval + shell:false, no OS isolation. Reported but not silently faked
   * when the backend is unavailable.
   */
  sandbox?: SandboxMode;
}

/** The seam the agent loop calls to run verification (injectable for tests). */
export type VerifyRunner = (
  config: VerificationConfig,
  workspaceRoot: string
) => Promise<VerifyResult[]>;

/** Resolve the effective repair-round budget for a config. */
export function maxRepairRounds(config: VerificationConfig): number {
  const n = config.maxRepairRounds;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_MAX_REPAIR_ROUNDS;
  return Math.max(0, Math.floor(n));
}

/** Kill a process and any children it spawned (best-effort). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Validate an argv array; throws WorkspaceError on anything unusable. */
function validateArgv(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new WorkspaceError("verify command requires a non-empty argv array");
  }
  for (const a of argv) {
    if (typeof a !== "string" || a.length === 0) {
      throw new WorkspaceError("verify command argv entries must be non-empty strings");
    }
    if (a.includes("\0")) throw new WorkspaceError("verify command argv may not contain NUL bytes");
  }
}

/**
 * Run one verification command. Never throws for ordinary failures (missing
 * executable, non-zero exit, timeout) — those are captured in the result. Only
 * a malformed command / escaping cwd throws.
 */
export function runVerifyCommand(
  cmd: VerifyCommand,
  workspaceRoot: string,
  timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
  sandbox: SandboxMode = "none"
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    let argv: string[];
    try {
      validateArgv(cmd.argv);
      argv = applySandbox(cmd.argv, normalizeSandboxMode(sandbox), workspaceRoot).argv;
    } catch (e) {
      resolve({
        name: cmd.name,
        argv: Array.isArray(cmd.argv) ? (cmd.argv as string[]) : [],
        exitCode: null,
        timedOut: false,
        output: `ERROR: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    let cwd: string;
    try {
      cwd = resolveSafe(workspaceRoot, cmd.cwd ?? ".", { mustExist: true });
    } catch (e) {
      resolve({
        name: cmd.name,
        argv,
        exitCode: null,
        timedOut: false,
        output: `ERROR: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let out = "";
    let errText = "";
    let truncated = false;
    const CAP = 2 * 1024 * 1024; // hard memory cap before spilling
    const onData = (buf: Buffer, sink: "o" | "e") => {
      const t = buf.toString("utf8");
      if (sink === "o") {
        if (out.length < CAP) out += t;
        else truncated = true;
      } else {
        if (errText.length < CAP) errText += t;
        else truncated = true;
      }
    };
    child.stdout?.on("data", (b: Buffer) => onData(b, "o"));
    child.stderr?.on("data", (b: Buffer) => onData(b, "e"));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    if (timer.unref) timer.unref();

    const finish = (exitCode: number | null) => {
      let combined = out;
      if (errText) combined += (combined ? "\n--- stderr ---\n" : "") + errText;
      if (timedOut) combined += `\n[verify] killed after ${Math.round(timeoutMs / 1000)}s`;
      if (truncated) combined += "\n[... truncated]";
      if (combined.length > MAX_VERIFY_OUTPUT_CHARS) {
        try {
          combined = spillContent(workspaceRoot, `verify-${cmd.name}`, combined, {
            thresholdChars: MAX_VERIFY_OUTPUT_CHARS,
          }).text;
        } catch {
          combined = combined.slice(0, MAX_VERIFY_OUTPUT_CHARS) + "\n[... truncated]";
        }
      }
      resolve({ name: cmd.name, argv, exitCode, timedOut, output: combined });
    };

    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        name: cmd.name,
        argv,
        exitCode: null,
        timedOut: false,
        output:
          e.code === "ENOENT"
            ? `ERROR: Executable not found on PATH: ${argv[0]}`
            : `ERROR: Failed to start process: ${e.message}`,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

/**
 * Run every configured command sequentially (default: run all of them). The
 * `run` seam defaults to `runVerifyCommand` and is injectable for tests.
 */
export async function runVerification(
  config: VerificationConfig,
  workspaceRoot: string,
  run: (cmd: VerifyCommand, root: string, timeoutMs: number, sandbox: SandboxMode) => Promise<VerifyResult> = runVerifyCommand
): Promise<VerifyResult[]> {
  const commands = Array.isArray(config.commands) ? config.commands : [];
  const timeoutMs = config.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const sandbox = normalizeSandboxMode(config.sandbox);
  const results: VerifyResult[] = [];
  for (const cmd of commands) {
    const r = await run(cmd, workspaceRoot, timeoutMs, sandbox);
    results.push(r);
    if (config.stopOnFirstFailure && !passed(r)) break;
  }
  return results;
}

/** A check passed only on a clean exit code. */
export function passed(r: VerifyResult): boolean {
  return !r.timedOut && r.exitCode === 0;
}

/** Detect the package manager from lockfiles, defaulting to npm. */
function detectPackageManager(root: string): { exe: string; runArgs: (script: string) => string[] } {
  const has = (f: string) => {
    try {
      return fs.statSync(path.join(root, f)).isFile();
    } catch {
      return false;
    }
  };
  if (has("pnpm-lock.yaml")) return { exe: "pnpm", runArgs: (s) => ["pnpm", "run", s] };
  if (has("yarn.lock")) return { exe: "yarn", runArgs: (s) => ["yarn", "run", s] };
  return { exe: "npm", runArgs: (s) => ["npm", "run", s] };
}

/** Script names we propose, in preference order. */
const PREFERRED_SCRIPTS = ["check:fast", "typecheck", "lint", "test"];

/**
 * Best-effort detection of check commands for a workspace. This only PROPOSES
 * commands — the host must confirm with the user before anything auto-runs.
 */
export function detectVerifyCommands(workspaceRoot: string): VerifyCommand[] {
  const root = path.resolve(workspaceRoot);
  const out: VerifyCommand[] = [];

  let scripts: Record<string, unknown> | null = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    scripts = pkg.scripts ?? null;
  } catch {
    scripts = null;
  }

  if (scripts) {
    const pm = detectPackageManager(root);
    for (const name of PREFERRED_SCRIPTS) {
      if (typeof scripts[name] === "string") {
        out.push({ name, argv: pm.runArgs(name) });
      }
    }
  }

  // A TS project with no explicit typecheck script still has a usable check.
  if (!out.some((c) => c.name === "typecheck")) {
    try {
      if (fs.statSync(path.join(root, "tsconfig.json")).isFile()) {
        out.push({ name: "typecheck", argv: ["npx", "tsc", "--noEmit"] });
      }
    } catch {
      /* no tsconfig */
    }
  }

  // Python projects: compile-check every module.
  if (!scripts) {
    const isPython =
      exists(root, "pyproject.toml") || exists(root, "requirements.txt") || exists(root, "setup.py");
    if (isPython) {
      out.push({ name: "compile", argv: ["python", "-m", "compileall", "-q", "."] });
    }
  }

  return dedupeByName(out);
}

function exists(root: string, file: string): boolean {
  try {
    return fs.statSync(path.join(root, file)).isFile();
  } catch {
    return false;
  }
}

function dedupeByName(cmds: VerifyCommand[]): VerifyCommand[] {
  const seen = new Set<string>();
  const out: VerifyCommand[] = [];
  for (const c of cmds) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}

/**
 * Compact, deterministic feedback for the model. Passing commands collapse to a
 * single summary line; each failing command gets a block with its exact
 * command, exit code, and the (tail-truncated) output. Returns "" when nothing
 * failed.
 */
export function formatVerificationFeedback(results: VerifyResult[]): string {
  const failed = results.filter((r) => !passed(r));
  if (!failed.length) return "";
  const passedNames = results.filter(passed).map((r) => r.name);
  const lines: string[] = [
    "Automated checks ran after your changes and some failed. Fix the underlying problems (do NOT edit, skip, or delete tests to make a check pass), then continue.",
  ];
  if (passedNames.length) lines.push(`Passed: ${passedNames.join(", ")}`);
  for (const r of failed) {
    const reason = r.timedOut
      ? `timed out`
      : r.exitCode === null
        ? "could not start"
        : `exit code ${r.exitCode}`;
    lines.push("");
    lines.push(`### ${r.name} — FAILED (${reason})`);
    lines.push(`Command: ${r.argv.join(" ")}`);
    const out = tail(r.output, VERIFY_FEEDBACK_BUDGET_CHARS);
    if (out.trim()) {
      lines.push("Output:");
      lines.push(out);
    }
  }
  return lines.join("\n");
}

/** Keep the last `max` chars (the tail is where failures surface). */
function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `[…${s.length - max} earlier chars omitted]\n` + s.slice(s.length - max);
}
