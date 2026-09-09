import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TOOLS, parseArgv, labelCommandRisk, CommandParseError } from "../src/tools.js";

describe("parseArgv", () => {
  it("tokenizes a simple invocation", () => {
    expect(parseArgv("git status")).toEqual(["git", "status"]);
  });

  it("honours double-quoted args with spaces", () => {
    expect(parseArgv('git commit -m "two words"')).toEqual(["git", "commit", "-m", "two words"]);
  });

  it("honours single-quoted args literally", () => {
    expect(parseArgv("echo 'a$b'")).toEqual(["echo", "a$b"]);
  });

  it.each(["echo hi | tee /tmp/x", "a; rm -rf /", "echo $(whoami)", "echo `whoami`", "cat a && cat b", "echo > out.txt", "echo *"])(
    "rejects shell syntax: %s",
    (cmd) => {
      expect(() => parseArgv(cmd)).toThrow(CommandParseError);
    }
  );

  it("rejects unterminated quotes", () => {
    expect(() => parseArgv('echo "oops')).toThrow(CommandParseError);
  });

  it("rejects empty commands", () => {
    expect(() => parseArgv("   ")).toThrow(CommandParseError);
  });
});

describe("labelCommandRisk (advisory only)", () => {
  it("labels destructive executables", () => {
    expect(labelCommandRisk(["rm", "-rf", "x"])).toBe("destructive");
    expect(labelCommandRisk(["git", "reset", "--hard"])).toBe("destructive");
  });
  it("labels network tools", () => {
    expect(labelCommandRisk(["curl", "https://x"])).toBe("network");
  });
  it("labels ordinary tools normal", () => {
    expect(labelCommandRisk(["node", "--version"])).toBe("normal");
  });
});

describe("run_command never invokes a shell", () => {
  it("runs a single program via spawn(shell:false)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-rc-"));
    try {
      fs.writeFileSync(path.join(root, "hello.txt"), "");
      const res = await TOOLS.run_command.run({ command: "node --version" }, root);
      expect(res).toMatch(/v\d+\./);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses pipes/chaining instead of interpreting them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-rc-"));
    try {
      const res = await TOOLS.run_command.run({ command: "echo hi | tee pwned.txt" }, root);
      expect(res).toContain("ERROR");
      expect(res).toContain("Shell syntax");
      expect(fs.existsSync(path.join(root, "pwned.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses substitution and redirection", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-rc-"));
    try {
      expect(await TOOLS.run_command.run({ command: "echo $(whoami)" }, root)).toContain("ERROR");
      expect(await TOOLS.run_command.run({ command: "echo x > out.txt" }, root)).toContain("ERROR");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses re-entrant script extensions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-rc-"));
    try {
      expect(await TOOLS.run_command.run({ command: "foo.bat" }, root)).toContain("ERROR");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports missing executables without a shell", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-rc-"));
    try {
      const res = await TOOLS.run_command.run({ command: "definitely-not-a-real-command-xyz" }, root);
      expect(res).toContain("ERROR");
      expect(res).toContain("not found on PATH");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps requiresApproval unconditionally true", () => {
    expect(TOOLS.run_command.requiresApproval).toBe(true);
  });
});
