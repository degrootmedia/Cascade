/**
 * External editor launching — no shell, no elevation, ever.
 *
 * The configured editor is validated at set-time (absolute path, real file,
 * no re-entrant script extension); at launch the target is passed as a single
 * argv entry via spawn(shell:false), or handed to the OS via shell.openPath.
 * Deps are injectable so tests can assert argv handling without Electron.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REENTRANT_EDITOR_EXT = new Set([".bat", ".cmd", ".ps1", ".vbs", ".js", ".msi"]);

export interface ExternalEditorDeps {
  getEditor?: () => string | null | undefined | Promise<string | null | undefined>;
  openPath?: (target: string) => Promise<string>;
  spawnFn?: (
    exe: string,
    args: string[],
    opts: Record<string, unknown>
  ) => { on: (ev: string, cb: (...a: never[]) => void) => void; unref: () => void };
}

async function defaultGetEditor(): Promise<string | null> {
  const settings = await import("./settings.js");
  return settings.getExternalEditor()?.trim() ?? null;
}

async function defaultOpenPath(target: string): Promise<string> {
  const { shell } = await import("electron");
  return shell.openPath(target);
}

/** Validate an operator-configured external editor. Throws on invalid values. */
export async function validateExternalEditor(exe: string): Promise<string> {
  if (!exe || !path.isAbsolute(exe)) {
    throw new Error("External editor must be an absolute path to an executable.");
  }
  if (REENTRANT_EDITOR_EXT.has(path.extname(exe).toLowerCase())) {
    throw new Error("Script files cannot be used as an external editor.");
  }
  if (process.platform === "darwin" && exe.endsWith(".app")) {
    return exe;
  }
  const st = await fs.promises.stat(exe);
  if (!st.isFile()) throw new Error("External editor path is not a file.");
  return exe;
}

/** Whether a path is inside the ACL-locked WindowsApps container. */
export function isWindowsAppsPath(p: string): boolean {
  return p.toLowerCase().includes("\\windowsapps\\") || p.toLowerCase().includes("/windowsapps/");
}

/** Launch a Windows Store execution alias by its file name on PATH. No shell, no elevation. */
async function tryWindowsAppsAlias(
  absPath: string,
  editor: string,
  spawnFn: ExternalEditorDeps["spawnFn"]
): Promise<boolean> {
  const alias = path.basename(editor) || "Affinity.exe";
  const spawnImpl =
    spawnFn ?? ((exe: string, args: string[], opts: Record<string, unknown>) => nodeSpawn(exe, args, opts as never) as unknown as ChildProcess);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawnImpl(alias, [absPath], { shell: false, detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", reject as never);
      setTimeout(() => {
        try {
          child.unref();
        } catch {}
        resolve();
      }, 400);
      child.on("close", ((code: unknown) => {
        if (code === 0) resolve();
        else reject(new Error(String(code)));
      }) as never);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open `absPath` in the chosen external editor (or the OS default).
 * Never elevates, never invokes a shell — the target is one argv entry.
 */
export async function openWithExternalEditor(absPath: string, deps: ExternalEditorDeps = {}): Promise<void> {
  if (typeof absPath !== "string" || !absPath || !path.isAbsolute(absPath)) {
    throw new Error("Refusing to open a non-absolute path in an external editor.");
  }
  const getEditor = deps.getEditor ?? defaultGetEditor;
  const openPath = deps.openPath ?? defaultOpenPath;
  const editor = (await getEditor())?.trim() || null;
  if (editor) {
    if (isWindowsAppsPath(editor)) {
      if (await tryWindowsAppsAlias(absPath, editor, deps.spawnFn)) return;
      // Alias failed: fall through to the OS default. Never elevate.
    } else {
      const exe = await validateExternalEditor(editor);
      if (process.platform === "darwin" && exe.endsWith(".app")) {
        const err = await openPath(absPath);
        if (err) throw new Error(err);
        return;
      }
      const spawnImpl =
        deps.spawnFn ??
        ((cmd: string, args: string[], opts: Record<string, unknown>) => nodeSpawn(cmd, args, opts as never) as unknown as ChildProcess);
      await new Promise<void>((resolve, reject) => {
        const child = spawnImpl(exe, [absPath], {
          shell: false,
          detached: true,
          windowsHide: false,
          stdio: "ignore",
        });
        child.on("error", ((e: NodeJS.ErrnoException) =>
          reject(
            new Error(
              e.code === "ENOENT" ? `Configured editor not found: ${exe}` : `Failed to launch editor: ${e.message}`
            )
          )) as never);
        child.on("spawn", (() => resolve()) as never);
        try {
          child.unref();
        } catch {}
      });
      return;
    }
  }
  const err = await openPath(absPath);
  if (err) throw new Error(err);
}
