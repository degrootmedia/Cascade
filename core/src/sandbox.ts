/**
 * Optional OS-level command isolation.
 *
 * The default is `"none"`: approval gating plus `shell:false`/`parseArgv` is
 * NOT OS isolation, and this module never claims otherwise. When a real backend
 * is selected the command's argv is transparently wrapped so it runs inside that
 * sandbox:
 *
 *  - `"srt"` — Anthropic's `sandbox-runtime` (`srt` on PATH), network denied by
 *    default, writes confined to the workspace root.
 *  - `"docker"` — a container mounted at the workspace root, network off.
 *
 * If the selected backend is unavailable the wrapper does NOT silently pretend
 * to isolate: `applySandbox` returns the original argv plus a notice the host
 * surfaces to the user. Pure + injectable (`SandboxDeps`) so it is unit-tested
 * without a real sandbox.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type SandboxMode = "none" | "srt" | "docker";

/** Docker image used for `"docker"` mode (must exist locally / be pullable). */
export const SANDBOX_DOCKER_IMAGE = "cascade-sandbox:latest";

/** Injectable seams (defaults use the real filesystem/PATH). */
export interface SandboxDeps {
  /** Whether an executable is resolvable on PATH. */
  commandExists?: (name: string) => boolean;
}

export function normalizeSandboxMode(v: unknown): SandboxMode {
  return v === "srt" || v === "docker" ? v : "none";
}

/** Resolve an executable name against PATH (honoring PATHEXT on Windows). */
export function resolveOnPath(name: string): string | null {
  if (!name) return null;
  if (name.includes("/") || name.includes("\\")) {
    return fs.existsSync(name) ? name : null;
  }
  const pathVar = process.env.PATH ?? "";
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
      // Windows is case-insensitive; also try the ext as-given.
      if (ext.toLowerCase() !== ext) {
        try {
          if (fs.statSync(path.join(dir, name + ext)).isFile()) return path.join(dir, name + ext);
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return null;
}

function commandExists(name: string, deps: SandboxDeps): boolean {
  return (deps.commandExists ?? ((n) => resolveOnPath(n) !== null))(name);
}

/** Whether the selected backend is usable on this machine. `"none"` is always. */
export function sandboxAvailable(mode: SandboxMode, deps: SandboxDeps = {}): boolean {
  if (mode === "none") return true;
  if (mode === "srt") return commandExists("srt", deps);
  if (mode === "docker") return commandExists("docker", deps);
  return false;
}

/** The notice shown when a requested backend can't be honored. */
export function sandboxFallbackNotice(mode: SandboxMode): string {
  const binary = mode === "docker" ? "docker" : "srt";
  return `Sandbox mode "${mode}" was requested but "${binary}" was not found on PATH, so commands run WITHOUT OS isolation. Approval gating and shell:false still apply.`;
}

export interface SandboxWrap {
  /** The argv to actually spawn (wrapped for the backend, or unchanged). */
  argv: string[];
  /** Present when the backend was unavailable and isolation was NOT applied. */
  notice?: string;
}

/**
 * Wrap an argv so it runs inside the selected sandbox. With `"none"` (or an
 * unavailable backend) the argv is returned unchanged — plus a notice in the
 * unavailable case so the host can be honest with the user.
 */
export function applySandbox(
  argv: string[],
  mode: SandboxMode,
  workspaceRoot: string,
  deps: SandboxDeps = {}
): SandboxWrap {
  if (mode === "none") return { argv };
  if (!sandboxAvailable(mode, deps)) {
    return { argv, notice: sandboxFallbackNotice(mode) };
  }
  if (mode === "srt") {
    // sandbox-runtime: run the command under srt, network denied, writes
    // confined to the workspace.
    return {
      argv: ["srt", "--deny-network", "--allow-write", workspaceRoot, "--", ...argv],
    };
  }
  // docker: ephemeral container, workspace mounted at the same path, no network.
  return {
    argv: [
      "docker",
      "run",
      "--rm",
      "--network=none",
      "-v",
      `${workspaceRoot}:${workspaceRoot}`,
      "-w",
      workspaceRoot,
      SANDBOX_DOCKER_IMAGE,
      ...argv,
    ],
  };
}
