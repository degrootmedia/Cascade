/**
 * Provider-seam guards (master plan step 07).
 *
 * T5 — vendor modules are only imported under `provider` implementations:
 *   no file in main/renderer/shared outside `src/main/providers/` may import
 *   `higgsfield-cli`, `openart-cli`, `openart-core`, `cli-run`, `model-schema`,
 *   or the OpenArt MCP transport (`openart`). This is the "hard to bypass"
 *   guard that keeps every generation behind the registry/queue seam.
 *
 * T3 — the expenses ledger is recorded from exactly one seam: the recorder is
 *   injected once (index.ts → createProviders) and `onGeneration` is only
 *   invoked inside `providers/`, so no generation path can escape accounting.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(__dirname, "../src");

/** Vendor module basenames that must not be imported outside `providers/`. */
const VENDOR_MODULES = new Set([
  "higgsfield-cli",
  "openart-cli",
  "openart-core",
  "cli-run",
  "model-schema",
  "openart", // the OpenArt MCP transport (OpenArtClient)
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Import/require specifiers in a source file. */
function specifiers(src: string): string[] {
  const out: string[] = [];
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

describe("provider seam: vendor imports stay under providers/", () => {
  const providersDir = path.join(SRC, "main", "providers");

  it("no non-provider source imports a vendor module", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.startsWith(providersDir + path.sep)) continue;
      const src = fs.readFileSync(file, "utf8");
      for (const spec of specifiers(src)) {
        const base = path.basename(spec).replace(/\.js$/, "");
        if (VENDOR_MODULES.has(base)) {
          offenders.push(`${path.relative(SRC, file)} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("index.ts reaches provider helpers through providers/api.ts", () => {
    const src = fs.readFileSync(path.join(SRC, "main", "index.ts"), "utf8");
    expect(src).toContain('from "./providers/api.js"');
  });
});

describe("ledger seam: generation is recorded in one place", () => {
  it("recorder.onGeneration is invoked only under providers/", () => {
    const providersDir = path.join(SRC, "main", "providers");
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, "utf8");
      if (!/\.onGeneration\s*\(/.test(src)) continue;
      if (file.startsWith(providersDir + path.sep)) continue;
      offenders.push(path.relative(SRC, file));
    }
    // The interface declares the callback; only providers invoke it.
    expect(offenders).toEqual([]);
  });

  it("ledger.recordGeneration is wired once, from index.ts's recorder", () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, "utf8");
      if (/ledger\.recordGeneration\s*\(/.test(src)) hits.push(path.relative(SRC, file));
    }
    expect(hits).toEqual([path.join("main", "index.ts")]);
  });
});
