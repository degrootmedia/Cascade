import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  detectVerifyCommands,
  formatVerificationFeedback,
  maxRepairRounds,
  runVerification,
  runVerifyCommand,
  type VerifyResult,
} from "../src/verify.js";

let root: string;

function nodeScript(code: string): string[] {
  return ["node", "-e", code];
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-verify-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("runVerifyCommand", () => {
  it("runs an argv command with shell:false and captures clean output", async () => {
    const r = await runVerifyCommand({ name: "ok", argv: nodeScript("console.log('hello checks')") }, root);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain("hello checks");
  });

  it("captures a non-zero exit as a failed result (never throws)", async () => {
    const r = await runVerifyCommand({ name: "bad", argv: nodeScript("process.exit(3)") }, root);
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it("kills the process on timeout and marks timedOut", async () => {
    const r = await runVerifyCommand(
      { name: "slow", argv: nodeScript("setTimeout(() => {}, 60000)") },
      root,
      300
    );
    expect(r.timedOut).toBe(true);
  });

  it("reports a missing executable as a result, not a throw", async () => {
    const r = await runVerifyCommand({ name: "missing", argv: ["definitely-not-real-xyz-42"] }, root);
    expect(r.exitCode).toBeNull();
    expect(r.output).toContain("ERROR");
  });

  it("rejects an argv that escapes the workspace via cwd", async () => {
    const r = await runVerifyCommand({ name: "escape", argv: nodeScript("1"), cwd: ".." }, root);
    expect(r.exitCode).toBeNull();
    expect(r.output).toContain("ERROR");
  });

  it("spills oversized output instead of truncating it", async () => {
    const r = await runVerifyCommand(
      { name: "big", argv: nodeScript("process.stdout.write('x'.repeat(20000))") },
      root
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(".cascade/tool-output/");
  });
});

describe("runVerification", () => {
  it("runs all commands by default, in order", async () => {
    const seen: string[] = [];
    const results = await runVerification(
      {
        commands: [
          { name: "a", argv: ["a"] },
          { name: "b", argv: ["b"] },
        ],
      },
      root,
      async (cmd) => {
        seen.push(cmd.name);
        return { name: cmd.name, argv: cmd.argv, exitCode: 0, timedOut: false, output: "" };
      }
    );
    expect(seen).toEqual(["a", "b"]);
    expect(results).toHaveLength(2);
  });

  it("stops early only when stopOnFirstFailure is set", async () => {
    let calls = 0;
    await runVerification(
      {
        commands: [
          { name: "a", argv: ["a"] },
          { name: "b", argv: ["b"] },
        ],
        stopOnFirstFailure: true,
      },
      root,
      async (cmd) => {
        calls++;
        return { name: cmd.name, argv: cmd.argv, exitCode: 1, timedOut: false, output: "" };
      }
    );
    expect(calls).toBe(1);
  });
});

describe("detectVerifyCommands", () => {
  it("proposes package.json checks in preference order", () => {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit", "check:fast": "tsx check", build: "tsc" },
      })
    );
    const cmds = detectVerifyCommands(root);
    expect(cmds.map((c) => c.name)).toEqual(["check:fast", "typecheck", "lint", "test"]);
    expect(cmds[0].argv).toEqual(["npm", "run", "check:fast"]);
  });

  it("uses the detected package manager from a lockfile", () => {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
    const cmds = detectVerifyCommands(root);
    expect(cmds[0].argv).toEqual(["pnpm", "run", "test"]);
  });

  it("falls back to tsc --noEmit when a tsconfig has no typecheck script", () => {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
    const cmds = detectVerifyCommands(root);
    expect(cmds.map((c) => c.name)).toContain("typecheck");
    expect(cmds.find((c) => c.name === "typecheck")?.argv).toEqual(["npx", "tsc", "--noEmit"]);
  });

  it("returns nothing for a workspace with no project markers", () => {
    expect(detectVerifyCommands(root)).toEqual([]);
  });
});

describe("formatVerificationFeedback", () => {
  const pass = (name: string): VerifyResult => ({
    name,
    argv: [name],
    exitCode: 0,
    timedOut: false,
    output: "SECRET CLEAN OUTPUT",
  });
  const fail = (name: string): VerifyResult => ({
    name,
    argv: ["npm", "run", name],
    exitCode: 2,
    timedOut: false,
    output: "boom: 3 errors",
  });

  it("returns empty string when everything passed", () => {
    expect(formatVerificationFeedback([pass("lint"), pass("test")])).toBe("");
  });

  it("summarizes passes in one line and excludes their output", () => {
    const text = formatVerificationFeedback([pass("lint"), fail("test")]);
    expect(text).toContain("Passed: lint");
    expect(text).not.toContain("SECRET CLEAN OUTPUT");
    expect(text).toContain("### test — FAILED");
    expect(text).toContain("npm run test");
    expect(text).toContain("boom: 3 errors");
  });

  it("notes a timeout reason", () => {
    const text = formatVerificationFeedback([
      { name: "test", argv: ["npm", "test"], exitCode: null, timedOut: true, output: "" },
    ]);
    expect(text).toContain("timed out");
  });
});

describe("maxRepairRounds", () => {
  it("defaults to 2 and clamps negatives", () => {
    expect(maxRepairRounds({ commands: [] })).toBe(2);
    expect(maxRepairRounds({ commands: [], maxRepairRounds: -5 })).toBe(0);
    expect(maxRepairRounds({ commands: [], maxRepairRounds: 4 })).toBe(4);
  });
});
