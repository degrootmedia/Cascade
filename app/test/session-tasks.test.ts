/**
 * Session task-list tests (master plan step 02): the per-chat JSON store
 * round-trips through atomic writes, validation rejects bad input with clear
 * errors, a restart restores from disk (the file is the truth), and the
 * session tool factory persists-before-emit with ERROR-string rejections.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-tasks-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));

import {
  loadSessionTasks,
  saveSessionTasks,
  makeSessionTodoTools,
} from "../src/main/session-tasks.js";
import { ipcContract, type SessionTasks } from "../src/shared/ipc.js";

const SID = "sess-abc123";

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("session-tasks store", () => {
  it("round-trips a task list through atomic save and load", () => {
    const saved = saveSessionTasks(SID, [
      { text: "research", status: "done" },
      { id: "keep", text: "implement", status: "running", note: "step 1" },
    ]);
    expect(saved.sessionId).toBe(SID);
    expect(saved.items.map((t) => t.id)).toEqual([expect.stringMatching(/^t-/), "keep"]);
    expect(loadSessionTasks(SID)).toEqual(saved);
    // Atomic write leaves no temp files behind.
    const leftovers = fs.readdirSync(path.join(dataDir, "session-tasks")).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("an untouched chat reads as an empty list, not an error", () => {
    expect(loadSessionTasks("never-seen").items).toEqual([]);
  });

  it("rejects invalid status / oversized text / too many items with clear errors", () => {
    expect(() => saveSessionTasks(SID, [{ text: "x", status: "someday" }])).toThrow("invalid status");
    expect(() => saveSessionTasks(SID, [{ text: "x".repeat(501), status: "todo" }])).toThrow("exceeds 500");
    const many = Array.from({ length: 51 }, (_, i) => ({ text: `t${i}`, status: "todo" }));
    expect(() => saveSessionTasks(SID, many)).toThrow("too many");
  });

  it("rejects path-shaped session ids instead of touching disk", () => {
    expect(() => loadSessionTasks("../../evil")).toThrow("Invalid session id");
    expect(() => saveSessionTasks("a/b", [])).toThrow("Invalid session id");
    expect(fs.existsSync(path.join(dataDir, "session-tasks"))).toBe(false);
  });

  it("restart restores from disk: the file is the truth", () => {
    const saved = saveSessionTasks(SID, [{ id: "r1", text: "survive", status: "todo" }]);
    // Simulate a fresh process: read the bytes straight off disk, bypassing
    // every in-memory cache, the way the renderer's mount-time IPC read does.
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "session-tasks", `${SID}.json`), "utf8"));
    expect(raw.items).toEqual(saved.items);
    expect(raw.sessionId).toBe(SID);
    // And a fresh load (mtime-validated cache) agrees.
    expect(loadSessionTasks(SID).items).toEqual(saved.items);
  });
});

describe("makeSessionTodoTools (host bridge)", () => {
  it("todo_write persists then emits; todo_read returns the same items", async () => {
    const emitted: SessionTasks[] = [];
    const tools = makeSessionTodoTools(() => SID, (t) => void emitted.push(t));
    expect(tools.todo_write.requiresApproval).toBe(false);
    expect(tools.todo_read.requiresApproval).toBe(false);
    const written = await tools.todo_write.run({ items: [{ text: "a", status: "running" }] }, "/ws");
    expect(written).toContain("Todos (1)");
    // Persisted before display: the file and the emission agree.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].items).toEqual(loadSessionTasks(SID).items);
    const read = await tools.todo_read.run({}, "/ws");
    expect(read).toBe(written);
  });

  it("invalid writes return ERROR text, persist nothing, emit nothing", async () => {
    const emitted: SessionTasks[] = [];
    const tools = makeSessionTodoTools(() => SID, (t) => void emitted.push(t));
    const out = await tools.todo_write.run({ items: [{ text: "x", status: "bogus" }] }, "/ws");
    expect(out).toContain("ERROR");
    expect(out).toContain("invalid status");
    expect(emitted).toHaveLength(0);
    expect(loadSessionTasks(SID).items).toEqual([]);
  });
});

describe("todos IPC contract", () => {
  it("exposes todos:get for the renderer's mount-time read", () => {
    expect(ipcContract["todos:get"]).toEqual({ method: "getSessionTodos", kind: "invoke" });
  });
});
