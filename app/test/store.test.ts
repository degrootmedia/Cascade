/**
 * store tests — the generic JSON document store (createStore) that backs
 * sessions, productions, and agents. Covers the atomic-write lifecycle, the
 * newest-first list sort, decode/encode hooks, archive/remove with side-file
 * hooks, and corruption tolerance.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-store-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));

import { createStore } from "../src/main/store.js";

interface Doc {
  id: string;
  updatedAt: string;
  title?: string;
}

function makeStore(opts: { decode?: (d: Doc) => Doc } = {}) {
  return createStore<Doc>({
    dirName: "docs",
    idOf: (d) => d.id,
    sortKey: (d) => d.updatedAt,
    ...opts,
  });
}

const doc = (id: string, updatedAt: string, title?: string): Doc => ({ id, updatedAt, title });

beforeEach(() => {
  // Fresh store directories for every test — the stores share one dataDir.
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("createStore", () => {
  it("round-trips a document through atomic save and load", () => {
    const store = makeStore();
    const d = doc("d1", "2026-08-30T00:00:00.000Z", "first");
    store.save(d);
    expect(store.load("d1")).toEqual(d);
    // Atomic write leaves no temp files behind.
    const leftovers = fs.readdirSync(store.dir()).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("lists documents newest-first by sortKey", () => {
    const store = makeStore();
    store.save(doc("old", "2026-08-28T00:00:00.000Z", "old"));
    store.save(doc("new", "2026-08-30T00:00:00.000Z", "new"));
    store.save(doc("mid", "2026-08-29T00:00:00.000Z", "mid"));
    expect(store.list().map((d) => d.id)).toEqual(["new", "mid", "old"]);
  });

  it("skips corrupt files without throwing", () => {
    const store = makeStore();
    store.save(doc("good", "2026-08-30T00:00:00.000Z"));
    fs.writeFileSync(path.join(store.dir(), "bad.json"), "{not json");
    expect(store.list().map((d) => d.id)).toEqual(["good"]);
  });

  it("applies the decode hook on list and load", () => {
    const store = makeStore({ decode: (d) => ({ ...d, title: d.title ?? "back-filled" }) });
    store.save(doc("d1", "2026-08-30T00:00:00.000Z"));
    expect(store.load("d1")?.title).toBe("back-filled");
    expect(store.list()[0].title).toBe("back-filled");
  });

  it("archives a document into archive/ and runs the side-file hook", () => {
    let hooked = false;
    const store = createStore<Doc>({
      dirName: "docs2",
      idOf: (d) => d.id,
      sortKey: (d) => d.updatedAt,
      sideFiles: {
        archive: (id, archiveDir) => {
          hooked = true;
          fs.writeFileSync(path.join(archiveDir, `${id}.side`), "x");
        },
      },
    });
    store.save(doc("a1", "2026-08-30T00:00:00.000Z"));
    expect(store.archive("a1")).toBe(true);
    expect(store.load("a1")).toBeNull();
    expect(fs.existsSync(path.join(store.dir(), "archive", "a1.json"))).toBe(true);
    expect(hooked).toBe(true);
    expect(fs.existsSync(path.join(store.dir(), "archive", "a1.side"))).toBe(true);
  });

  it("removes a document and runs the side-file hook", () => {
    let hooked = false;
    const store = createStore<Doc>({
      dirName: "docs3",
      idOf: (d) => d.id,
      sortKey: (d) => d.updatedAt,
      sideFiles: {
        remove: (id) => {
          hooked = true;
          fs.writeFileSync(path.join(store.dir(), `${id}.side`), "y");
        },
      },
    });
    store.save(doc("r1", "2026-08-30T00:00:00.000Z"));
    expect(store.remove("r1")).toBe(true);
    expect(store.load("r1")).toBeNull();
    expect(hooked).toBe(true);
  });

  it("generates distinct new ids", () => {
    const store = makeStore();
    expect(store.newId()).not.toBe(store.newId());
    expect(store.newId()).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });
});