/**
 * Cascade v1 tool set: file operations + run_command.
 *
 * Mutating tools (write_file, edit_file, run_command) are marked
 * `requiresApproval` — the agent loop routes them through the user's
 * approval gate before executing. Reads are auto-allowed inside the
 * workspace.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { resolveSafe, WorkspaceError } from "./workspace.js";
import type { ToolDefinition, ApprovalRequest, AgentTool } from "./types.js";

const MAX_READ_CHARS = 50_000;
const MAX_OUTPUT_CHARS = 10_000;
const MAX_GREP_RESULTS = 200;
const DEFAULT_CMD_TIMEOUT_MS = 60_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__"]);

/** Built-in tools share the AgentTool shape used for dynamic (MCP) tools. */
export type ToolSpec = AgentTool;

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new WorkspaceError(`missing/invalid argument: ${key}`);
  return v;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n[... truncated, ${s.length - max} more chars]` : s;
}

// ---------------------------------------------------------------- read_file
const readFile: ToolSpec = {
  requiresApproval: false,
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file inside the workspace. Returns up to 50k chars.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to workspace root" } },
        required: ["path"],
      },
    },
  },
  async run(args, root) {
    const p = resolveSafe(root, str(args, "path"), { mustExist: true });
    return truncate(fs.readFileSync(p, "utf8"), MAX_READ_CHARS);
  },
};

// --------------------------------------------------------------- write_file
const writeFile: ToolSpec = {
  requiresApproval: true,
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file inside the workspace. Creates parent directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  describe(args, root) {
    const rel = str(args, "path");
    const content = str(args, "content");
    const abs = path.resolve(root, rel);
    const exists = fs.existsSync(abs);
    let detail: string;
    if (exists) {
      let old = "";
      try {
        old = fs.readFileSync(abs, "utf8");
      } catch {
        /* binary or unreadable; fall through to plain preview */
      }
      detail = old ? lineDiff(old, content) : truncate(content, 2000);
    } else {
      detail = truncate(content, 2000);
    }
    return {
      tool: "write_file",
      summary: `${exists ? "Overwrite" : "Create"} ${rel} (${content.length} chars)`,
      detail,
    };
  },
  async run(args, root) {
    const p = resolveSafe(root, str(args, "path"));
    const content = str(args, "content");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
    return `OK: wrote ${content.length} chars to ${str(args, "path")}`;
  },
};

// ---------------------------------------------------------------- edit_file
const editFile: ToolSpec = {
  requiresApproval: true,
  definition: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact string in a file with a new string. old_string must appear exactly once unless replace_all is true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  describe(args) {
    return {
      tool: "edit_file",
      summary: `Edit ${str(args, "path")}`,
      detail: `--- remove\n${truncate(str(args, "old_string"), 1000)}\n+++ insert\n${truncate(str(args, "new_string"), 1000)}`,
    };
  },
  async run(args, root) {
    const p = resolveSafe(root, str(args, "path"), { mustExist: true });
    const oldS = str(args, "old_string");
    const newS = str(args, "new_string");
    if (oldS === newS) return "ERROR: old_string and new_string are identical";
    const content = fs.readFileSync(p, "utf8");
    const count = content.split(oldS).length - 1;
    if (count === 0) return "ERROR: old_string not found in file";
    if (count > 1 && !args.replace_all) {
      return `ERROR: old_string appears ${count} times; provide more context or set replace_all`;
    }
    const updated = args.replace_all ? content.split(oldS).join(newS) : content.replace(oldS, newS);
    fs.writeFileSync(p, updated, "utf8");
    return `OK: replaced ${args.replace_all ? count : 1} occurrence(s)`;
  },
};

// ----------------------------------------------------------- list_directory
const listDirectory: ToolSpec = {
  requiresApproval: false,
  definition: {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and subdirectories at a path inside the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Defaults to workspace root", default: "." } },
      },
    },
  },
  async run(args, root) {
    const p = resolveSafe(root, typeof args.path === "string" ? args.path : ".", { mustExist: true });
    const entries = fs.readdirSync(p, { withFileTypes: true });
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : `${e.name} (${fs.statSync(path.join(p, e.name)).size} B)`))
      .join("\n") || "(empty directory)";
  },
};

// --------------------------------------------------------------------- glob
const globTool: ToolSpec = {
  requiresApproval: false,
  definition: {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern (e.g. **/*.ts) inside the workspace.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  async run(args, root) {
    const pattern = str(args, "pattern");
    const rx = globToRegex(pattern);
    const results: string[] = [];
    walk(root, root, (rel) => {
      if (rx.test(rel)) results.push(rel);
      return results.length < 500;
    });
    return results.length ? results.join("\n") : "(no matches)";
  },
};

// --------------------------------------------------------------------- grep
const grepTool: ToolSpec = {
  requiresApproval: false,
  definition: {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regex. Returns matching lines as path:line: text.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regex" },
          path: { type: "string", description: "Subdirectory to search; defaults to workspace root" },
        },
        required: ["pattern"],
      },
    },
  },
  async run(args, root) {
    let rx: RegExp;
    try {
      rx = new RegExp(str(args, "pattern"));
    } catch (e) {
      return `ERROR: invalid regex: ${e}`;
    }
    const start = resolveSafe(root, typeof args.path === "string" ? args.path : ".", { mustExist: true });
    const results: string[] = [];
    walk(start, root, (rel, abs, isDir) => {
      if (isDir) return true;
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        return true;
      }
      if (text.includes("\0")) return true; // binary
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && results.length < MAX_GREP_RESULTS; i++) {
        if (rx.test(lines[i])) results.push(`${rel}:${i + 1}: ${lines[i].slice(0, 200)}`);
      }
      return results.length < MAX_GREP_RESULTS;
    });
    return results.length ? results.join("\n") : "(no matches)";
  },
};

// -------------------------------------------------------------- run_command

export class CommandParseError extends Error {}

const SHELL_METACHARS = /[|&;<>()$`{}\[\]!*?~#\n\r]/;

/**
 * Tokenize a single program invocation into argv. Rejects shell syntax.
 * Single quotes are fully literal; double quotes allow \" and \\ escapes.
 */
export function parseArgv(input: string): string[] {
  const s = input.trim();
  if (!s) throw new CommandParseError("Empty command.");

  const argv: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (c === "\\" && (s[i + 1] === '"' || s[i + 1] === "\\")) {
        cur += s[++i];
      } else if (c === '"') {
        quote = null;
      } else cur += c;
      started = true;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      // Escape only whitespace/quotes/backslash; a bare backslash stays
      // literal so Windows paths (C:\tools\ed.exe) survive tokenizing.
      const n = s[i + 1];
      if (n === " " || n === "\t" || n === "'" || n === '"' || n === "\\") {
        cur += n;
        i++;
      } else {
        cur += c;
      }
      started = true;
      continue;
    }
    if (c === " " || c === "\t") {
      if (started) {
        argv.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    if (SHELL_METACHARS.test(c)) {
      throw new CommandParseError(
        `Shell syntax is not supported. Character "${c}" cannot be used. ` +
          `Issue one program invocation at a time (no pipes, redirection, ` +
          `substitution, chaining or globbing).`
      );
    }
    cur += c;
    started = true;
  }

  if (quote) throw new CommandParseError("Unterminated quote in command.");
  if (started) argv.push(cur);
  if (argv.length === 0) throw new CommandParseError("Empty command.");
  return argv;
}

const REENTRANT_EXT = new Set([".bat", ".cmd", ".ps1", ".vbs", ".js", ".msi"]);

function assertLaunchable(exe: string): void {
  const ext = path.extname(exe).toLowerCase();
  if (REENTRANT_EXT.has(ext)) {
    throw new CommandParseError(
      `Refusing to launch "${ext}" files: they re-enter a script interpreter. ` +
        `Invoke the interpreter explicitly with the script as an argument.`
    );
  }
}

/**
 * ADVISORY ONLY — feeds approval-dialog risk styling. Never gates execution.
 */
export type CommandRisk = "destructive" | "network" | "normal";

export function labelCommandRisk(argv: string[]): CommandRisk {
  const exe = path.basename(argv[0]).toLowerCase().replace(/\.exe$/, "");
  const rest = argv.slice(1);
  if (
    ["rm", "rmdir", "del", "mkfs", "dd", "diskpart", "format", "shutdown", "reboot"].includes(exe)
  )
    return "destructive";
  if (exe === "git" && rest.some((a) => a === "--hard" || a === "clean")) return "destructive";
  if (["curl", "wget", "ssh", "scp", "nc", "ncat"].includes(exe)) return "network";
  return "normal";
}

const runCommand: ToolSpec = {
  requiresApproval: true,
  definition: {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command with the workspace as working directory. Returns stdout+stderr (truncated to 10k chars). 60s timeout by default.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_seconds: { type: "number", description: "Max 300" },
        },
        required: ["command"],
      },
    },
  },
  describe(args) {
    const cmd = str(args, "command");
    let danger = false;
    try {
      danger = labelCommandRisk(parseArgv(cmd)) !== "normal";
    } catch {
      danger = true;
    }
    return {
      tool: "run_command",
      summary: `${danger ? "⚠ DANGEROUS — " : ""}Run: ${truncate(cmd, 120)}`,
      detail: danger ? `⚠ This command can delete data or change system state.\n\n${cmd}` : cmd,
    };
  },
  async run(args, root) {
    const cmd = str(args, "command");
    let argv: string[];
    try {
      argv = parseArgv(cmd);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    try {
      assertLaunchable(argv[0]);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    const timeoutMs = Math.min(Number(args.timeout_seconds) || 0, 300) * 1000 || DEFAULT_CMD_TIMEOUT_MS;
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: root,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let errText = "";
      let truncated = false;
      const CAP = 256 * 1024;
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
      child.stdout.on("data", (b) => onData(b, "o"));
      child.stderr.on("data", (b) => onData(b, "e"));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      if (timer.unref) timer.unref();
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve(
          e.code === "ENOENT"
            ? `ERROR: Executable not found on PATH: ${argv[0]}`
            : `ERROR: Failed to start process: ${e.message}`
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        let combined = out;
        if (errText) combined += (combined ? "\n--- stderr ---\n" : "") + errText;
        if (timedOut) combined += `\n[cascade] killed after ${timeoutMs / 1000}s`;
        if (truncated) combined += "\n[... truncated]";
        combined = truncate(combined, MAX_OUTPUT_CHARS);
        if (timedOut || code !== 0) {
          const reason = timedOut ? `timed out after ${timeoutMs / 1000}s` : `exit code ${code ?? "?"}`;
          resolve(`ERROR (${reason})${combined ? "\n" + combined : ""}`);
        } else {
          resolve(combined || "(no output)");
        }
      });
    });
  },
};

// ------------------------------------------------------------------ helpers

/**
 * Cheap line diff for approval previews: trims the common prefix/suffix and
 * shows what's removed vs added in the middle. Not a real LCS diff, but
 * enough for a human to judge an overwrite.
 */
export function lineDiff(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  if (removed.length === 0 && added.length === 0) return "(no changes — content is identical)";
  const cap = (lines: string[], sign: string) => {
    const shown = lines.slice(0, 40).map((l) => `${sign} ${l}`);
    if (lines.length > 40) shown.push(`${sign} … ${lines.length - 40} more lines`);
    return shown;
  };
  return [
    `@@ line ${start + 1} (${a.length} → ${b.length} lines)`,
    ...cap(removed, "-"),
    ...cap(added, "+"),
  ].join("\n");
}
function walk(
  dir: string,
  root: string,
  visit: (rel: string, abs: string, isDir: boolean) => boolean
): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (!visit(rel, abs, true)) return false;
      if (!walk(abs, root, visit)) return false;
    } else if (e.isFile()) {
      if (!visit(rel, abs, false)) return false;
    }
  }
  return true;
}

function globToRegex(pattern: string): RegExp {
  let rx = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        rx += ".*";
        i++;
        if (pattern[i + 1] === "/") i++; // "**/" matches zero or more dirs
      } else {
        rx += "[^/]*";
      }
    } else if (c === "?") {
      rx += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      rx += "\\" + c;
    } else {
      rx += c;
    }
  }
  return new RegExp(`^${rx}$`);
}

export const TOOLS: Record<string, ToolSpec> = {
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  list_directory: listDirectory,
  glob: globTool,
  grep: grepTool,
  run_command: runCommand,
};

export const TOOL_DEFINITIONS: ToolDefinition[] = Object.values(TOOLS).map((t) => t.definition);
