import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveSafe, WorkspaceError } from "../src/workspace.js";

let root: string;
let outside: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-ws-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-outside-"));
  fs.writeFileSync(path.join(root, "inside.txt"), "hello");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.mkdirSync(path.join(root, "sub"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("resolveSafe", () => {
  it("resolves relative paths inside the workspace", () => {
    expect(resolveSafe(root, "inside.txt", { mustExist: true })).toBe(fs.realpathSync(path.join(root, "inside.txt")));
  });

  it("allows nested new paths for writing", () => {
    expect(resolveSafe(root, "sub/new-file.txt")).toBe(path.join(root, "sub", "new-file.txt"));
  });

  it("rejects .. escapes", () => {
    expect(() => resolveSafe(root, "../escape.txt")).toThrow(WorkspaceError);
    expect(() => resolveSafe(root, "sub/../../escape.txt")).toThrow(WorkspaceError);
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(() => resolveSafe(root, path.join(outside, "secret.txt"))).toThrow(WorkspaceError);
  });

  it("accepts absolute paths inside the workspace", () => {
    expect(resolveSafe(root, path.join(root, "inside.txt"), { mustExist: true })).toBe(
      fs.realpathSync(path.join(root, "inside.txt"))
    );
  });

  it("rejects empty and non-string paths", () => {
    expect(() => resolveSafe(root, "")).toThrow(WorkspaceError);
    // @ts-expect-error deliberate bad input
    expect(() => resolveSafe(root, null)).toThrow(WorkspaceError);
  });

  it("rejects symlink escapes when reading", function () {
    const link = path.join(root, "sneaky-link.txt");
    try {
      fs.symlinkSync(path.join(outside, "secret.txt"), link);
    } catch {
      return; // symlinks may need privileges on Windows; skip there
    }
    expect(() => resolveSafe(root, "sneaky-link.txt", { mustExist: true })).toThrow(WorkspaceError);
  });

  it("rejects writes through a symlinked directory", function () {
    const dirLink = path.join(root, "sneaky-dir");
    try {
      fs.symlinkSync(outside, dirLink, "dir");
    } catch {
      return;
    }
    expect(() => resolveSafe(root, "sneaky-dir/new.txt")).toThrow(WorkspaceError);
  });
});
