import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionMeta } from "../../../shared/ipc.js";

type BucketKey = "today" | "yesterday" | "week" | "month" | "older";

const BUCKET_ORDER: BucketKey[] = ["today", "yesterday", "week", "month", "older"];

const BUCKET_LABEL: Record<BucketKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Previous 7 days",
  month: "This month",
  older: "Older",
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function bucketKeyFor(iso: string, now: Date): BucketKey {
  const d = new Date(iso);
  const sod = startOfDay(d);
  const today = startOfDay(now);
  const diffDays = Math.round((today.getTime() - sod.getTime()) / 86400000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return "week";
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "month";
  return "older";
}

function formatRowDate(iso: string, now: Date): string {
  const d = new Date(iso);
  const sod = startOfDay(d);
  const today = startOfDay(now);
  const diffDays = Math.round((today.getTime() - sod.getTime()) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function Sidebar({
  sessions,
  onSelect,
  onNew,
  onSettings,
  onRemove,
  onRename,
  credits,
  width,
}: {
  sessions: SessionMeta[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onSettings: () => void;
  onRemove: (id: string, mode: "delete" | "archive") => void;
  onRename: (id: string) => void;
  credits: number | null;
  width?: number;
}) {
  // Right-click context menu state (opened over a specific session).
  const [menu, setMenu] = useState<{ x: number; y: number; session: SessionMeta } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Live search filter.
  const [query, setQuery] = useState("");
  // Collapsed groups (key -> hidden).
  const [collapsed, setCollapsed] = useState<Partial<Record<BucketKey, boolean>>>({});

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const now = useMemo(() => new Date(), []);

  // Hide placeholder "New chat" sessions that have no messages yet — the
  // "+ New chat" button is the entry point for creating chats.
  const visible = useMemo(
    () => sessions.filter((s) => !(s.title === "New chat" && !s.preview)),
    [sessions],
  );

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? visible.filter(
          (s) => s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q),
        )
      : visible;
    const buckets = new Map<BucketKey, SessionMeta[]>();
    for (const key of BUCKET_ORDER) buckets.set(key, []);
    for (const s of base) {
      buckets.get(bucketKeyFor(s.updatedAt, now))!.push(s);
    }
    return BUCKET_ORDER.map((key) => ({ key, label: BUCKET_LABEL[key], sessions: buckets.get(key)! }))
      .filter((b) => b.sessions.length > 0);
  }, [visible, query, now]);

  const total = visible.length;

  const toggle = (key: BucketKey) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <aside className="sidebar" style={width ? { width } : undefined}>
      <button className="new-chat" onClick={onNew}>
        + New chat
      </button>
      {total > 3 && (
        <input
          className="sidebar-search"
          type="search"
          placeholder="Search chats…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <nav className="session-list">
        {groups.length === 0 && (
          <div className="session-empty">{query ? "No chats match your search." : "No chats yet."}</div>
        )}
        {groups.map((group) => {
          const isCollapsed = !!collapsed[group.key];
          return (
            <div key={group.key} className="session-group">
              <button
                className={`session-group-head${isCollapsed ? "" : " open"}`}
                onClick={() => toggle(group.key)}
                title={group.label}
              >
                <span className="session-group-caret">▸</span>
                <span className="session-group-label">{group.label}</span>
                <span className="session-group-count">{group.sessions.length}</span>
              </button>
              {!isCollapsed &&
                group.sessions.map((s) => (
                  <button
                    key={s.id}
                    className="session-item"
                    onClick={() => onSelect(s.id)}
                    title={s.title}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, session: s });
                    }}
                  >
                    <span className="session-item-top">
                      <span className="session-item-title">{s.title}</span>
                      <span className="session-item-date">{formatRowDate(s.updatedAt, now)}</span>
                    </span>
                    {s.preview && <span className="session-item-preview">{s.preview}</span>}
                  </button>
                ))}
            </div>
          );
        })}
      </nav>
      {menu && (
        <div
          ref={menuRef}
          className="session-context-menu"
          style={{ position: "fixed", top: menu.y, left: menu.x }}
        >
          <button
            className="ctx-item"
            onClick={() => {
              onRename(menu.session.id);
              setMenu(null);
            }}
          >
            Refresh name (Arya)
          </button>
          <div className="ctx-sep" />
          <button
            className="ctx-item"
            onClick={() => {
              onRemove(menu.session.id, "archive");
              setMenu(null);
            }}
          >
            Archive chat
          </button>
          <button
            className="ctx-item danger"
            onClick={() => {
              if (window.confirm(`Permanently delete "${menu.session.title}"? This can't be undone.`)) {
                onRemove(menu.session.id, "delete");
              }
              setMenu(null);
            }}
          >
            Delete…
          </button>
        </div>
      )}
      <div className="sidebar-footer">
        {credits !== null && <div className="credits">~{credits} credits</div>}
        <button className="link" onClick={onSettings}>
          Settings
        </button>
      </div>
    </aside>
  );
}


