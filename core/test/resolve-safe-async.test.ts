import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveSafeAsync, PathEscapeError } from "../src/workspace.js";

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-safe-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "x");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("resolveSafeAsync", () => {
  it("accepts the workspace root itself", async () => {
    await expect(resolveSafeAsync(root, ".")).resolves.toBeTruthy();
  });

  it("accepts a non-existent new file under the root", async () => {
    const p = await resolveSafeAsync(root, "new/sub/file.txt");
    expect(p.startsWith(fs.realpathSync(root))).toBe(true);
  });

  it("rejects absolute escapes", async () => {
    await expect(resolveSafeAsync(root, "/etc/passwd")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects dot-dot escapes", async () => {
    await expect(resolveSafeAsync(root, "../../etc/passwd")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects sibling-dir prefix escapes (rootevil)", async () => {
    const evil = root + "evil";
    fs.mkdirSync(evil, { recursive: true });
    try {
      await expect(resolveSafeAsync(root, evil)).rejects.toBeInstanceOf(PathEscapeError);
    } finally {
      fs.rmSync(evil, { recursive: true, force: true });
    }
  });

  it("rejects symlink escapes inside the workspace", async () => {
    const link = path.join(root, "link");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch {
      fs.symlinkSync(outside, link);
    }
    await expect(resolveSafeAsync(root, "link/secret.txt")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("accepts a workspace root that is itself a symlink", async () => {
    const linkRoot = path.join(os.tmpdir(), `cascade-rootlink-${Date.now()}`);
    try {
      fs.symlinkSync(root, linkRoot, "junction");
    } catch {
      try {
        fs.symlinkSync(root, linkRoot);
      } catch {
        return; // symlink creation not permitted here; skip
      }
    }
    try {
      await expect(resolveSafeAsync(linkRoot, "a.txt")).resolves.toBeTruthy();
    } finally {
      try {
        fs.unlinkSync(linkRoot);
      } catch {}
    }
  });
});
