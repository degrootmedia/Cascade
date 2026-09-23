import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  SPILL_DIR,
  spillContent,
  pruneSpills,
  needsSpill,
  formatSpillResult,
  DEFAULT_SPILL_THRESHOLD_CHARS,
} from "../src/spill.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-spill-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("needsSpill", () => {
  it("is false at/under threshold, true above", () => {
    expect(needsSpill("a".repeat(10), 10)).toBe(false);
    expect(needsSpill("a".repeat(11), 10)).toBe(true);
  });
});

describe("spillContent", () => {
  it("under threshold → no write, text unchanged", () => {
    const out = spillContent(root, "read_file", "small content", { thresholdChars: 100 });
    expect(out.spilled).toBe(false);
    expect(out.text).toBe("small content");
    expect(out.relPath).toBeUndefined();
    expect(fs.existsSync(path.join(root, ...SPILL_DIR.split("/")))).toBe(false);
  });

  it("over threshold → file exists, descriptor points at it, bytes round-trip", () => {
    const content = "line1\nline2\nline3 trailing newline\n";
    const big = content + "x".repeat(DEFAULT_SPILL_THRESHOLD_CHARS + 100);
    const out = spillContent(root, "run_command", big);
    expect(out.spilled).toBe(true);
    expect(out.relPath).toBeDefined();
    const abs = path.join(root, ...(out.relPath as string).split("/"));
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs, "utf8")).toBe(big); // byte-for-byte, trailing newline intact
    expect(out.text).toContain(out.relPath as string);
    expect(out.text).toContain("read_file");
    expect(out.text).toContain("grep");
  });

  it("preserves exact bytes including trailing newline", () => {
    const big = "abc\ndef\n".padEnd(DEFAULT_SPILL_THRESHOLD_CHARS + 10, "z") + "\n";
    const out = spillContent(root, "read_file", big);
    expect(out.spilled).toBe(true);
    expect(fs.readFileSync(path.join(root, ...(out.relPath as string).split("/")), "utf8")).toBe(big);
  });

  it("sanitizes hostile tool names — spill stays inside the workspace", () => {
    const big = "y".repeat(DEFAULT_SPILL_THRESHOLD_CHARS + 10);
    const out = spillContent(root, "../../evil", big);
    expect(out.spilled).toBe(true);
    const abs = path.resolve(root, out.relPath as string);
    expect(abs.startsWith(path.resolve(root) + path.sep)).toBe(true);
    expect(fs.existsSync(abs)).toBe(true);
  });
});

describe("formatSpillResult (pure)", () => {
  it("mentions path, totals, and how to page", () => {
    const text = formatSpillResult("head", ".cascade/tool-output/x.txt", "head" + "y".repeat(5000));
    expect(text).toContain(".cascade/tool-output/x.txt");
    expect(text).toContain("read_file");
    expect(text).toContain("grep");
  });
});

describe("pruneSpills", () => {
  it("removes oldest beyond keep and never removes excluded", () => {
    const dir = path.join(root, ...SPILL_DIR.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      const name = `f-${i}.txt`;
      names.push(name);
      fs.writeFileSync(path.join(dir, name), `content ${i}`);
      // ensure distinct mtimes, oldest first
      const t = new Date(Date.now() - (5 - i) * 1000);
      fs.utimesSync(path.join(dir, name), t, t);
    }
    const newest = names[names.length - 1];
    const removed = pruneSpills(root, { keep: 2, exclude: [newest] });
    expect(removed).not.toContain(newest);
    expect(fs.existsSync(path.join(dir, newest))).toBe(true);
    expect(fs.readdirSync(dir)).toHaveLength(2);
  });
});
