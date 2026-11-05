/**
 * Mechanical guards distilled from tasks/lessons.md (Group A). Each `describe`
 * names the lesson it now carries; the lesson text was removed from lessons.md.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { CANVAS_TYPE_EQUAL } from "../src/shared/graph/reconcile";
import { graphNodeTypes } from "../src/renderer/src/components/NodeGraphModal";

const APP = path.resolve(__dirname, "..");
const CORE = path.resolve(__dirname, "../../core");
const read = (p: string) => fs.readFileSync(p, "utf8");

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "out", "dist", "release", ".git", ".tmp-test"].includes(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(abs);
  }
  return out;
}

describe("lesson: encoding damage (PowerShell rewrites)", () => {
  it("no U+FFFD, control chars or cp1252 mojibake in source, tests or CSS", () => {
    const mojibake = "\u00e2\u20ac"; // what a UTF-8 em/en dash becomes when read as cp1252
    const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
    const bad: string[] = [];
    for (const root of [path.join(APP, "src"), path.join(APP, "test"), path.join(CORE, "src"), path.join(CORE, "test")]) {
      for (const f of walk(root, [".ts", ".tsx", ".css"])) {
        if (f.endsWith("lessons-guards.test.ts")) continue;
        const t = read(f);
        if (t.includes("\uFFFD") || t.includes(mojibake) || control.test(t)) bad.push(path.relative(APP, f));
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("lesson: new node type needs its equality case (2026-09-24)", () => {
  // Types intentionally relying on the "unknown compares equal" default.
  const EXEMPT = new Set<string>([]);
  it("every node type has a CANVAS_TYPE_EQUAL rule", () => {
    const missing = Object.keys(graphNodeTypes).filter((t) => !(t in CANVAS_TYPE_EQUAL) && !EXEMPT.has(t));
    expect(missing).toEqual([]);
  });
});

describe("lesson: icon <img> must not inherit media-container img rules (2026-10-21)", () => {
  it("lightbox / shelf / video-thumb img rules exclude .cascade-icon", () => {
    const css = read(path.join(APP, "src/renderer/src/styles.css"));
    const containers = /(lightbox-card|shelf-item|video-thumb|moodboard-shelf-item)[^{,]*\bimg\b[^{,]*(?=[{,])/g;
    const offenders = (css.match(containers) ?? []).filter((s) => !s.includes(":not(.cascade-icon)"));
    expect(offenders).toEqual([]);
  });
});

describe("lesson: audio must not be fed multi-MB data: URLs (2026-xx audio)", () => {
  it("no <audio src> built from a data: URL in the renderer", () => {
    const hits: string[] = [];
    for (const f of walk(path.join(APP, "src/renderer"), [".tsx"])) {
      read(f)
        .split("\n")
        .forEach((l, i) => {
          if (/<audio\b[^>]*src=\{[^}]*data:/.test(l) || /<audio\b[^>]*src="data:/.test(l)) hits.push(`${f}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

describe("lesson: every contract channel needs a handler (2026-10-13)", () => {
  it("main keeps the boot-time drift guard over the whole ipcContract", () => {
    const src = read(path.join(APP, "src/main/index.ts"));
    expect(src).toMatch(/is declared in the contract but has no handler/);
    expect(src).toMatch(/Object\.(keys|entries)\(ipcContract\)/);
  });
});

describe("lesson: save helpers read prodRef.current, not the render closure (2026-09-10)", () => {
  it("saveGraphLayout builds scenes from prodRef.current", () => {
    const src = read(path.join(APP, "src/renderer/src/components/ProductionWorkspace.tsx"));
    const i = src.indexOf("async function saveGraphLayout(");
    expect(i).toBeGreaterThan(-1);
    const body = src.slice(i, i + 400);
    expect(body).toMatch(/const current = prodRef\.current/);
    expect(body).not.toMatch(/\bprod\.scenes/);
  });
});

import { parseJsonLooseObject } from "../src/shared/prompt-grammar";

describe("lesson: JSON extractor handles nested objects (2026-08-27)", () => {
  it("parses a nested object wrapped in prose", () => {
    const r = parseJsonLooseObject('Here: {"user":{"id":1},"credits":42} done');
    expect(r).toEqual({ user: { id: 1 }, credits: 42 });
  });
});

describe("lesson: rebaseProduction copy list (2026-09-03)", () => {
  // Every top-level Production field must be a conscious choice: copied by
  // rebaseProduction (job-mutated) or listed here as renderer/main-owned.
  const NOT_JOB_MUTATED = new Set([
    "meta", "visualStyle", "scenes", "outdatedShots", "promptOverrides", "products",
    "suggestedReferences", "openArt", "voiceoverPath", "voiceoverVolume", "musicPath",
    "musicVolume", "brand", "magicPrompts", "lookSeed", "anchorShotId", "scriptSource",
    // Undecided when this guard was added; not written by runProductionJob
    // handlers today. Revisit if a job starts mutating one of them.
    "storyboardPdf", "moodboard", "shotSequences", "media", "assets", "schemaVersion", "rev",
    // Renderer-owned through ordinary saves (applyRendererState); jobs
    // never write them. magicDismissedRefs predates its registration here;
    // timeline landed with Animatic Expansion Item 1.
    "magicDismissedRefs", "timeline", "uncategorizedTileSize",
  ]);
  it("every top-level Production field is copied by rebase or explicitly exempt", () => {
    const iface = read(path.join(APP, "src/shared/ipc/production.ts"));
    const start = iface.indexOf("export interface Production {");
    const end = iface.indexOf("\n}", start);
    const keys = [...iface.slice(start, end).matchAll(/^ {2}([a-zA-Z]+)\??:/gm)].map((m) => m[1]);
    const idx = read(path.join(APP, "src/main/index.ts"));
    const list = idx.match(/for \(const k of \[([^\]]+)\] as const\)/)?.[1] ?? "";
    const copied = new Set([...list.matchAll(/"(\w+)"/g)].map((m) => m[1]));
    const undecided = keys.filter((k) => !copied.has(k) && !NOT_JOB_MUTATED.has(k));
    expect(undecided).toEqual([]);
  });
});

describe("lesson: new migration needs a schema-version bump (2026-09-14)", () => {
  it("migration set and PRODUCTION_SCHEMA_VERSION change together", () => {
    const src = read(path.join(APP, "src/main/productions.ts"));
    const names = [...src.matchAll(/^(?:export )?function (migrate\w+)/gm)].map((m) => m[1]).sort();
    const version = Number(src.match(/PRODUCTION_SCHEMA_VERSION = (\d+)/)?.[1]);
    // Adding/removing a migrate* function? Bump PRODUCTION_SCHEMA_VERSION and update this pair.
    expect({ names, version }).toEqual({ names: ["migrateBoardArtwork", "migrateGraphPipes", "migrateShotGraph"], version: 3 });
  });
});

describe("lesson: Settings checkboxes need their own reset (2026-10-02)", () => {
  it("every .settings checkbox control class has an input[type=checkbox] reset", () => {
    const css = read(path.join(APP, "src/renderer/src/styles.css"));
    expect(css).toMatch(/\.settings[^{]*input\[type="checkbox"\][^{]*\{[^}]*width:\s*auto/);
  });
});
