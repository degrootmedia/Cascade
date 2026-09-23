import type { SessionTasks, TodoStatus } from "../types.js";

const GLYPH: Record<TodoStatus, string> = {
  todo: "○",
  running: "◐",
  done: "●",
  blocked: "⊘",
};

/** Compact read-only view of a chat's durable task list. Fed by the mount-time
 *  todos:get read plus live todos:changed events; the model owns the content
 *  via todo_write, so this panel never edits. */
export function TodoPanel({ tasks }: { tasks: SessionTasks }) {
  const open = tasks.items.filter((t) => t.status === "todo" || t.status === "running").length;
  return (
    <section className="todo-panel" aria-label="Task list">
      <header className="todo-header">
        <span className="todo-title">Tasks</span>
        <span className="todo-count">{open} open · {tasks.items.length} total</span>
      </header>
      <ul className="todo-list">
        {tasks.items.map((t) => (
          <li key={t.id} className={`todo-item todo-${t.status}`}>
            <span className="todo-glyph" aria-hidden="true">{GLYPH[t.status]}</span>
            <span className="todo-text">{t.text}</span>
            {t.note && <span className="todo-note">{t.note}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
