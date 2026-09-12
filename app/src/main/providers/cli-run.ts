/**
 * cli-run — the shared subprocess seam for CLI-transport media providers.
 *
 * Both CLI vendors (`higgsfield`, `openart`) spawn a local binary and parse
 * its `--json` stdout. The runner, result shape, and PATH probing live here
 * exactly once; each vendor module only defines its own command vocabulary
 * and reply shapes. Always `shell: false` (security source guard) — binaries
 * must be real executables (vendor-specific shim resolution lives with each
 * vendor's resolver).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dataUrlToBytes } from "../../shared/prompt-grammar.js";

/** One finished CLI invocation. */
export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI with args. `timeoutMs` bounds the invocation (each vendor's
 *  own `--timeout` bounds server waits; this bounds the process itself). */
export type CliRun = (args: string[], opts?: { timeoutMs?: number }) => Promise<CliRunResult>;

/** Capture a child process's output, killing it past `timeoutMs` (null code). */
function spawnCapture(bin: string, args: string[], timeoutMs: number): Promise<CliRunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code: number | null, extra = ""): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: `${stderr}${extra}`.slice(0, 2000) });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
      finish(null, ` (timed out after ${timeoutMs}ms)`);
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
      if (stdout.length > 64 * 1024 * 1024) stdout = stdout.slice(-64 * 1024 * 1024);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    child.on("error", (e) => finish(null, `: ${e.message}`));
    child.on("close", (code) => finish(code));
  });
}

/** The production runner: spawn the resolved binary directly. */
export function defaultCliRun(binary: string): CliRun {
  return (args, opts) => spawnCapture(binary, args, opts?.timeoutMs ?? 120_000);
}

/** One PATH lookup via the system locator (`where`/`which` are real
 *  binaries, spawned shell-free). */
async function probePath(name: string): Promise<string | null> {
  const locator = process.platform === "win32" ? "where" : "which";
  const res = await spawnCapture(locator, [name], 15_000);
  if (res.code !== 0) return null;
  return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null;
}

/** Resolve the first `names` entry found on PATH to an existing file.
 *  Returns the raw path (vendor-specific shim → real-binary mapping is the
 *  caller's job); null when nothing resolves. */
export async function resolveCliOnPath(names: string[]): Promise<string | null> {
  for (const name of names) {
    try {
      const found = await probePath(name);
      if (!found) continue;
      try {
        if (fs.existsSync(found) && fs.statSync(found).isFile()) return found;
      } catch { /* keep looking */ }
    } catch { /* try the next name */ }
  }
  return null;
}

/** True when the path is directly spawnable shell-free (used by vendors
 *  whose binaries need no shim mapping). */
export function isExecutableFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function mimeToExt(mime: string): string {
  if (/png/i.test(mime)) return "png";
  if (/webp/i.test(mime)) return "webp";
  if (/gif/i.test(mime)) return "gif";
  if (/mp4/i.test(mime)) return "mp4";
  if (/quicktime/i.test(mime)) return "mov";
  if (/webm/i.test(mime)) return "webm";
  if (/m4a/i.test(mime)) return "m4a";
  return "jpg";
}

/** Write data-URL refs to a temp dir for a CLI's path-accepting media flags.
 *  Returns the file paths (null per undecodable ref) plus a cleanup. The
 *  CLI auto-uploads local paths on submit; callers decide per-ref whether a
 *  null entry is fatal. */
export function writeCliTempRefs(refs: { name: string; dataUrl: string }[]): {
  paths: (string | null)[];
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-cli-"));
  const paths: (string | null)[] = [];
  for (const [i, r] of refs.entries()) {
    try {
      const bytes = dataUrlToBytes(r.dataUrl);
      if (!bytes) {
        paths.push(null);
        continue;
      }
      const comma = r.dataUrl.indexOf(",");
      const mime = /^data:([^;,]+)/.exec(r.dataUrl.slice(0, Math.max(0, comma)))?.[1] ?? "image/jpeg";
      const safe = (r.name.split("/").pop() ?? "ref").replace(/\.[^.]+$/, "").replace(/[^\w\- ]+/g, "").trim() || "ref";
      const file = path.join(dir, `${i}-${safe}.${mimeToExt(mime)}`);
      fs.writeFileSync(file, Buffer.from(bytes));
      paths.push(file);
    } catch {
      paths.push(null);
    }
  }
  return { paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
