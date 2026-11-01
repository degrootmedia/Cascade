/**
 * Auto-format after edit: formatting is the harness's job, not the model's.
 * Runs Prettier on a single file the agent just wrote. Never throws; a missing
 * Prettier or an unsupported file type is a silent no-op (the file is left as
 * written). argv only, shell:false, path confined to the workspace.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { resolveSafe } from "./workspace.js";

export type FormatFile = (relPath: string, workspaceRoot: string) => Promise<boolean>;

/** Extensions Prettier handles in this project. */
const FORMATTABLE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".md", ".html", ".yml", ".yaml"]);

export function isFormattable(rel: string): boolean {
  return FORMATTABLE.has(path.extname(rel).toLowerCase());
}

/** Default formatter: `npx prettier --write <file>`. Resolves true on success. */
export const prettierFormat: FormatFile = (rel, root) =>
  new Promise((resolve) => {
    if (!isFormattable(rel)) return resolve(false);
    let abs: string;
    try {
      abs = resolveSafe(root, rel, { mustExist: true });
    } catch {
      return resolve(false);
    }
    // Only the workspace's own Prettier: never fetch one, and skip the spawn
    // entirely when the project doesn't have it installed.
    if (!existsSync(path.join(root, "node_modules", "prettier"))) return resolve(false);
    const exe = process.platform === "win32" ? "npx.cmd" : "npx";
    let done = false;
    const finish = (ok: boolean) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    try {
      const child = spawn(exe, ["--no-install", "prettier", "--write", abs], {
        cwd: root,
        shell: process.platform === "win32", // .cmd shims need a shell on Windows; args are fixed + path is resolved
        windowsHide: true,
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        child.kill();
        finish(false);
      }, 30_000);
      if (timer.unref) timer.unref();
      child.on("error", () => finish(false));
      child.on("close", (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
    } catch {
      finish(false);
    }
  });
