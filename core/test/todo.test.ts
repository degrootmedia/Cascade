import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  formatTodoList,
  makeTodoTools,
  parseTodoList,
  workspaceTodoPersistence,
  type TodoItem,
  type TodoPersistence,
} from "../src/todo.js";

const item = (over: Partial<TodoItem> = {}): TodoItem => ({
  id: "t1",
  text: "do the thing",
  status: "todo",
  updatedAt: "2026-09-20T00:00:00.000Z",
  ...over,
});

function memStore(seed: TodoItem[] = []): TodoPersistence & { saved: TodoItem[][] } {
  let cur = seed;
  const saved: TodoItem[][] = [];
  return {
    saved,
    async load() {
      return cur;
    },
    async save(items) {
      saved.push(items);
      cur = items;
    },
  };
}

describe("parseTodoList", () => {
  it("accepts a valid list and stamps updatedAt", () => {
    const r = parseTodoList([{ text: "a", status: "todo" }], "NOW");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items).toHaveLength(1);
      expect(r.items[0].updatedAt).toBe("NOW");
      expect(r.items[0].id).toMatch(/^t-/);
    }
  });

  it("rejects invalid status with a clear error", () => {
    const r = parseTodoList([{ text: "a", status: "eventually" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid status");
  });

  it("rejects oversized text and too many items", () => {
    expect(parseTodoList([{ text: "x".repeat(501), status: "todo" }]).ok).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => ({ text: `t${i}`, status: "todo" }));
    const r = parseTodoList(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("too many");
  });

  it("rejects duplicate and malformed ids", () => {
    expect(parseTodoList([{ id: "a", text: "x", status: "todo" }, { id: "a", text: "y", status: "todo" }]).ok).toBe(false);
    const r = parseTodoList([{ id: "../evil", text: "x", status: "todo" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid id");
  });

  it("rejects empty text and non-objects", () => {
    expect(parseTodoList([{ text: "  ", status: "todo" }]).ok).toBe(false);
    expect(parseTodoList(["nope"]).ok).toBe(false);
    expect(parseTodoList({ items: [] } as unknown as unknown[]).ok).toBe(false);
  });

  it("preserves a valid stored updatedAt; stamps only new/invalid ones", () => {
    const r = parseTodoList(
      [
        { id: "a", text: "old", status: "todo", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "b", text: "new", status: "todo" },
        { id: "c", text: "bad", status: "todo", updatedAt: "not-a-date" },
      ],
      "NOW"
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items[0].updatedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(r.items[1].updatedAt).toBe("NOW");
      expect(r.items[2].updatedAt).toBe("NOW");
    }
  });

  it("round-trips unknown future properties instead of stripping them", () => {
    const r = parseTodoList([{ id: "a", text: "x", status: "todo", futureField: 7 }], "NOW");
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.items[0] as unknown as Record<string, unknown>).futureField).toBe(7);
  });
});

describe("formatTodoList", () => {
  it("renders statuses distinctly; empty list says so", () => {
    expect(formatTodoList([])).toContain("empty");
    const text = formatTodoList([
      item({ id: "a", status: "todo" }),
      item({ id: "b", status: "running" }),
      item({ id: "c", status: "done", note: "n" }),
      item({ id: "d", status: "blocked" }),
    ]);
    expect(text).toContain("[ ] a");
    expect(text).toContain("[~] b");
    expect(text).toContain("[x] c");
    expect(text).toContain("[!] d");
  });
});

describe("makeTodoTools over an injected store", () => {
  it("todo_write persists; todo_read returns the same items", async () => {
    const store = memStore();
    const tools = makeTodoTools(() => store);
    const written = await tools.todo_write.run(
      { items: [{ text: "first", status: "running" }, { id: "k", text: "second", status: "done" }] },
      "/ws"
    );
    expect(typeof written === "string" ? written : written.text).toContain("first");
    const read = await tools.todo_read.run({}, "/ws");
    expect(read).toBe(written);
    expect(store.saved).toHaveLength(1);
  });

  it("invalid writes return ERROR text and never touch the store", async () => {
    const store = memStore([item()]);
    const tools = makeTodoTools(() => store);
    const out = await tools.todo_write.run({ items: [{ text: "x", status: "bogus" }] }, "/ws");
    expect(out).toContain("ERROR");
    expect(store.saved).toHaveLength(0);
  });

  it("tools need no approval", async () => {
    const tools = makeTodoTools(() => memStore());
    expect(tools.todo_read.requiresApproval).toBe(false);
    expect(tools.todo_write.requiresApproval).toBe(false);
  });
});

describe("workspaceTodoPersistence", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-todo-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("round-trips through .cascade/tasks.json", async () => {
    const p = workspaceTodoPersistence(root);
    expect(await p.load()).toEqual([]);
    await p.save([item({ id: "a" }), item({ id: "b", status: "done" })]);
    expect(await p.load()).toHaveLength(2);
    expect(fs.existsSync(path.join(root, ".cascade", "tasks.json"))).toBe(true);
  });

  it("load preserves stored updatedAt (reading never mutates timestamps)", async () => {
    const p = workspaceTodoPersistence(root);
    await p.save([item({ id: "a", updatedAt: "2020-01-01T00:00:00.000Z" })]);
    const loaded = await p.load();
    expect(loaded[0].updatedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("concurrent writes do not corrupt (temp+rename)", async () => {
    const p = workspaceTodoPersistence(root);
    await Promise.all([
      p.save([item({ id: "a" })]),
      p.save([item({ id: "b" })]),
      p.save([item({ id: "c" })]),
    ]);
    const loaded = await p.load();
    expect([["a"], ["b"], ["c"]]).toContainEqual(loaded.map((t) => t.id));
  });

  it("a corrupt store surfaces a clear error, not silent loss", async () => {
    fs.mkdirSync(path.join(root, ".cascade"), { recursive: true });
    fs.writeFileSync(path.join(root, ".cascade", "tasks.json"), "{not json", "utf8");
    await expect(workspaceTodoPersistence(root).load()).rejects.toThrow("corrupt");
  });
});
