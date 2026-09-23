import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TOOLS } from "../src/tools.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-spillwire-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function asText(out: string | { text: string }): string {
  return typeof out === "string" ? out : out.text;
}

function spillPathFrom(text: string): string {
  const m = text.match(/\.cascade\/tool-output\/[A-Za-z0-9_.@-]+\.txt/);
  if (!m) throw new Error(`no spill path in result: ${text.slice(0, 300)}`);
  return m[0];
}

describe("read_file spill + paging (T2)", () => {
  it("a 200KB file returns preview + path; paging the spill yields exact bytes", async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 4000; i++) lines.push(`line-${String(i).padStart(5, "0")}-` + "x".repeat(40));
    const content = lines.join("\n") + "\n";
    expect(content.length).toBeGreaterThan(100_000);
    fs.writeFileSync(path.join(root, "big.txt"), content, "utf8");

    const first = asText(await TOOLS.read_file.run({ path: "big.txt" }, root));
    expect(first).toContain(".cascade/tool-output/");
    const rel = spillPathFrom(first);
    // Spill file holds the exact bytes.
    expect(fs.readFileSync(path.join(root, ...rel.split("/")), "utf8")).toBe(content);

    // Paging the spill path at an offset returns the correct bytes.
    const page = asText(await TOOLS.read_file.run({ path: rel, offset: 11, limit: 5 }, root));
    const expected = lines.slice(10, 15).join("\n");
    expect(page).toContain(expected);
    expect(page).toMatch(/\[lines 11–15 of/);
  });

  it("small files return inline with no spill dir", async () => {
    fs.writeFileSync(path.join(root, "small.txt"), "hello");
    const out = asText(await TOOLS.read_file.run({ path: "small.txt" }, root));
    expect(out).toBe("hello");
    expect(fs.existsSync(path.join(root, ".cascade"))).toBe(false);
  });

  it("offset beyond EOF reports cleanly", async () => {
    fs.writeFileSync(path.join(root, "s.txt"), "a\nb\n");
    const out = asText(await TOOLS.read_file.run({ path: "s.txt", offset: 99 }, root));
    expect(out).toContain("beyond end of file");
  });
});

describe("run_command spill (T3)", () => {
  it("oversized stdout spills instead of truncating", async () => {
    fs.writeFileSync(
      path.join(root, "big.js"),
      "let s=''; for(let i=0;i<600;i++) s+='0123456789abcdef-'+i+'\\n'; console.log(s);"
    );
    const out = asText(await TOOLS.run_command.run({ command: "node big.js" }, root));
    expect(out).toContain(".cascade/tool-output/");
    const rel = spillPathFrom(out);
    const spilled = fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");
    expect(spilled).toContain("0123456789abcdef-599");
  });
});

describe("grep spill + cap (T4)", () => {
  it("oversized matches spill; hitting the cap says so", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push(`MATCH-${i}-` + "y".repeat(60));
    fs.writeFileSync(path.join(root, "hay.txt"), lines.join("\n"));
    const out = asText(await TOOLS.grep.run({ pattern: "MATCH" }, root));
    expect(out).toContain("capped at 200 matches");
    expect(out).toContain(".cascade/tool-output/");
    const rel = spillPathFrom(out);
    expect(fs.existsSync(path.join(root, ...rel.split("/")))).toBe(true);
  });
});
