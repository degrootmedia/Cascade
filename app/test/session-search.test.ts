/**
 * Session search tests (master plan step 09 T1): full-transcript hits over the
 * EXISTING session JSON, with no storage change. The query is case-insensitive,
 * multiple terms AND together, and searching never rewrites a file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-search-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));

import * as sessions from "../src/main/sessions.js";
import { clearSessionSearchCache, searchSessions, sessionSearchParts } from "../src/main/session-search.js";
import { ipcContract } from "../src/shared/ipc.js";

function makeSession(title: string, opts: { history?: { role: "user" | "assistant"; content: string }[]; display?: unknown[] } = {}): string {
  const s = sessions.newSessionFile(null);
  s.title = title;
  s.history = (opts.history ?? []).map((m) => ({ role: m.role, content: m.content })) as never;
  s.display = (opts.display ?? []) as never;
  sessions.saveSession(s);
  return s.id;
}

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  clearSessionSearchCache();
});

describe("searchSessions (content, no storage change)", () => {
  it("finds a hit in the model history even when the title/preview don't match", () => {
    makeSession("Weather chat", { history: [{ role: "user", content: "How do I configure the gondola lift brake?" }] });
    const hits = searchSessions("gondola");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Weather chat");
    expect(hits[0].snippet).toContain("gondola");
  });

  it("finds hits in the renderer transcript (tool results, notices, mentions)", () => {
    makeSession("Build log", {
      display: [
        { kind: "tool", name: "run_command", args: "{}", result: "compiled successfully in 4s" },
        { kind: "notice", text: "Cache regenerated" },
        { kind: "mention", filename: "hero-sheet.png", image: "data:image/png;base64,AA" },
      ],
    });
    expect(searchSessions("compiled").map((h) => h.sessionId)).toHaveLength(1);
    expect(searchSessions("regenerated")).toHaveLength(1);
    expect(searchSessions("hero-sheet")).toHaveLength(1);
  });

  it("ANDs multiple terms and is case-insensitive", () => {
    makeSession("A", { history: [{ role: "assistant", content: "Refactor the provider seam" }] });
    makeSession("B", { history: [{ role: "assistant", content: "Refactor the ledger" }] });
    expect(searchSessions("refactor").length).toBe(2);
    expect(searchSessions("REFACTOR provider").map((h) => h.title)).toEqual(["A"]);
  });

  it("returns [] for an empty/whitespace query", () => {
    makeSession("A", { history: [{ role: "user", content: "hello" }] });
    expect(searchSessions("")).toEqual([]);
    expect(searchSessions("   ")).toEqual([]);
  });

  it("respects the limit", () => {
    for (let i = 0; i < 5; i++) makeSession(`S${i}`, { history: [{ role: "user", content: "needle here" }] });
    expect(searchSessions("needle", { limit: 3 })).toHaveLength(3);
  });

  it("never writes a session file (read-only)", () => {
    makeSession("A", { history: [{ role: "user", content: "immutable" }] });
    const dir = path.join(dataDir, "sessions");
    const before = fs.readdirSync(dir).map((f) => ({ f, bytes: fs.readFileSync(path.join(dir, f), "utf8"), mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
    searchSessions("immutable");
    searchSessions("nothing-here");
    const after = fs.readdirSync(dir).map((f) => ({ f, bytes: fs.readFileSync(path.join(dir, f), "utf8"), mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
    expect(after).toEqual(before);
  });
});

describe("sessionSearchParts", () => {
  it("collects title, history and transcript, skipping empty entries", () => {
    const s = sessions.newSessionFile(null);
    s.title = "T";
    s.history = [{ role: "user", content: "  " }, { role: "assistant", content: "answer" }] as never;
    s.display = [{ kind: "assistant", text: "shown" }, { kind: "user", text: "" }] as never;
    const parts = sessionSearchParts(s);
    expect(parts).toContain("T");
    expect(parts).toContain("answer");
    expect(parts).toContain("shown");
    expect(parts.filter((p) => p.trim() === "")).toEqual([]);
  });
});

describe("search IPC contract", () => {
  it("exposes sessions:search", () => {
    expect(ipcContract["sessions:search"]).toEqual({ method: "searchSessions", kind: "invoke" });
  });
});
