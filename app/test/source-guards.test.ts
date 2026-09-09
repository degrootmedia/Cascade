import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/** Recursively list .ts files, skipping node_modules/out/dist. */
function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "out", "dist", ".git"].includes(e.name)) continue;
      out.push(...listTs(abs));
    } else if (e.isFile() && e.name.endsWith(".ts")) {
      out.push(abs);
    }
  }
  return out;
}

const ROOTS = [path.resolve(__dirname, "../../core/src"), path.resolve(__dirname, "../src")];

const FORBIDDEN: Array<[RegExp, string]> = [
  [/(?<![.\w])exec(Sync|File)?\s*\(/, "use spawn with shell:false"],
  [/shell\s*:\s*true/, "shell:true is banned"],
  [/powershell\.exe|Start-Process|-ExecutionPolicy/i, "no PowerShell"],
  [/RunAs/, "no elevation"],
  [/nodeIntegration\s*:\s*true/, "nodeIntegration must stay false"],
  [/contextIsolation\s*:\s*false/, "contextIsolation must stay true"],
  [/webSecurity\s*:\s*false/, "webSecurity must stay true"],
  [/bypassCSP\s*:\s*true/, "bypassCSP must stay false"],
  [/Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*/, "no wildcard CORS"],
  [/console\.log\(JSON\.stringify/, "no full-payload logging"],
  [/\.\.\.process\.env/, "no full process.env spread (use buildMcpEnv)"],
];

describe("security source guards", () => {
  it("source contains no banned security patterns", () => {
    const violations: string[] = [];
    for (const root of ROOTS) {
      for (const f of listTs(root)) {
        if (f.endsWith(".spec.ts") || f.endsWith(".test.ts")) continue;
        // ipc/handle.ts legitimately references ipcMain.handle registration.
        if (f.endsWith(`${path.sep}ipc${path.sep}handle.ts`)) continue;
        const src = fs.readFileSync(f, "utf8");
        // Tests for the media streamer legitimately stream via fh.read.
        src.split("\n").forEach((line, i) => {
          if (line.includes("security-allow")) return;
          for (const [re, why] of FORBIDDEN) {
            if (re.test(line)) violations.push(`${f}:${i + 1} ${why} :: ${line.trim()}`);
          }
        });
      }
    }
    expect(violations).toEqual([]);
  });
});
