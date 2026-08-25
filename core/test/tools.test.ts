import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TOOLS } from "../src/tools.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-tools-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("write_file / read_file", () => {
  it("round-trips content and creates parent dirs", async () => {
    await TOOLS.write_file.run({ path: "a/b/c.txt", content: "hello cascade" }, root);
    const out = await TOOLS.read_file.run({ path: "a/b/c.txt" }, root);
    expect(out).toBe("hello cascade");
  });

  it("read_file reports missing files as an error", async () => {
    await expect(TOOLS.read_file.run({ path: "nope.txt" }, root)).rejects.toThrow("file not found");
  });
});

describe("edit_file", () => {
  it("replaces a unique string", async () => {
    fs.writeFileSync(path.join(root, "f.txt"), "one two three");
    const res = await TOOLS.edit_file.run({ path: "f.txt", old_string: "two", new_string: "2" }, root);
    expect(res).toContain("OK");
    expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("one 2 three");
  });

  it("refuses ambiguous matches without replace_all", async () => {
    fs.writeFileSync(path.join(root, "f.txt"), "x x x");
    const res = await TOOLS.edit_file.run({ path: "f.txt", old_string: "x", new_string: "y" }, root);
    expect(res).toContain("ERROR");
    expect(res).toContain("3 times");
  });

  it("replaces all occurrences with replace_all", async () => {
    fs.writeFileSync(path.join(root, "f.txt"), "x x x");
    const res = await TOOLS.edit_file.run(
      { path: "f.txt", old_string: "x", new_string: "y", replace_all: true },
      root
    );
    expect(res).toContain("OK");
    expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("y y y");
  });

  it("errors when old_string is missing from the file", async () => {
    fs.writeFileSync(path.join(root, "f.txt"), "abc");
    const res = await TOOLS.edit_file.run({ path: "f.txt", old_string: "zzz", new_string: "y" }, root);
    expect(res).toContain("not found");
  });
});

describe("glob", () => {
  it("matches nested patterns", async () => {
    fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "");
    fs.writeFileSync(path.join(root, "src", "deep", "b.ts"), "");
    fs.writeFileSync(path.join(root, "src", "c.js"), "");
    const res = await TOOLS.glob.run({ pattern: "**/*.ts" }, root);
    expect(res).toContain("src/a.ts");
    expect(res).toContain("src/deep/b.ts");
    expect(res).not.toContain("c.js");
  });
});

describe("grep", () => {
  it("finds matching lines with locations", async () => {
    fs.writeFileSync(path.join(root, "log.txt"), "ok\nERROR: bad thing\nok");
    const res = await TOOLS.grep.run({ pattern: "^ERROR" }, root);
    expect(res).toContain("log.txt:2");
  });
});

describe("run_command", () => {
  it("runs in the workspace cwd and captures output", async () => {
    fs.writeFileSync(path.join(root, "hello.txt"), "");
    const cmd = process.platform === "win32" ? "dir /b" : "ls";
    const res = await TOOLS.run_command.run({ command: cmd }, root);
    expect(res).toContain("hello.txt");
  });

  it("reports failing commands as errors", async () => {
    const res = await TOOLS.run_command.run({ command: "definitely-not-a-real-command-xyz" }, root);
    expect(res).toContain("ERROR");
  });
});

describe("path confinement (through tools)", () => {
  it("blocks reads outside the workspace", async () => {
    await expect(TOOLS.read_file.run({ path: "../../etc/passwd" }, root)).rejects.toThrow("escapes workspace");
  });
  it("blocks writes outside the workspace", async () => {
    await expect(TOOLS.write_file.run({ path: "../evil.txt", content: "x" }, root)).rejects.toThrow(
      "escapes workspace"
    );
  });
});
