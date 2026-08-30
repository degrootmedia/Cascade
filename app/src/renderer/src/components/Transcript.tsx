import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { DisplayItem } from "../types.js";
import { AgentHoverCard } from "./AgentIdCard.js";

marked.setOptions({ gfm: true, breaks: true });

/** Markdown → HTML, sanitized. Model output is untrusted input. */
function renderMarkdown(text: string): string {
  // Collapse stacked horizontal rules (---) into a single one, ignoring blank
  // lines between consecutive rules.
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*---+\s*$/.test(line)) {
      const prev = out[out.length - 1];
      if (prev === "---" || (prev === "" && out[out.length - 2] === "---")) {
        // already in (or right after) a rule run → skip
        continue;
      }
      out.push("---");
    } else {
      out.push(line);
    }
  }
  const sanitizedText = out.join("\n");
  const html = marked.parse(sanitizedText, { async: false }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "input"], FORBID_ATTR: ["style"] });
}

export function Transcript({ items, pureChat = false }: { items: DisplayItem[]; pureChat?: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  return (
    <div className="transcript">
      {items.length === 0 && (
        <div className="empty">
          <h2>Cascade</h2>
          {pureChat ? (
            <p>Plain chat — no file access. Pick a folder in the header to let Cascade create, edit, or organize files.</p>
          ) : (
            <p>Your AI agent for local files. Pick a workspace, then ask it to create, edit, or organize.</p>
          )}
        </div>
      )}
      {groupToolRuns(items).map((entry, i) => {
        if (entry.kind === "toolRun") return <ToolGroup key={i} items={entry.items} />;
        const item = entry.item;
        switch (item.kind) {
          case "user":
            return (
              <div key={i} className="msg user">
                {item.images && (
                  <div className="msg-images">
                    {item.images.map((src, j) => (
                      <img key={j} src={src} alt={`sent image ${j + 1}`} />
                    ))}
                  </div>
                )}
                {item.text}
              </div>
            );
          case "assistant":
            return (
              <div
                key={i}
                className={`msg assistant${item.streaming ? " streaming" : ""}`}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
              />
            );
          case "mention":
            return (
              <div key={i} className="msg mention">
                <img src={item.image} alt={item.filename} />
                <span className="mention-label">OpenArt reference: {item.filename}</span>
              </div>
            );
          case "agent-switch": {
            const switchMeta = item.agentId ? { id: item.agentId, name: item.name, description: (item as { description?: string }).description ?? "", avatar: item.avatar, model: (item as { model?: string }).model ?? "", allowedTools: "all" as const, createdAt: "", updatedAt: "", hasPrompt: false } : null;
            const avatarNode = !item.avatar ? <span className="avatar default">○</span> : item.avatar.kind === "emoji" ? <span className="avatar emoji">{item.avatar.value}</span> : item.avatarDataUrl ? <img className="avatar img" src={item.avatarDataUrl} alt="" style={{ width: 24, height: 24, borderRadius: "50%" }} /> : <span className="avatar default">◐</span>;
            return (
              <div key={i} className="agent-switch-frame">
                <div className="agent-switch-avatar">
                  {switchMeta ? <AgentHoverCard meta={switchMeta} avatarDataUrl={item.avatarDataUrl ?? null}>{avatarNode}</AgentHoverCard> : avatarNode}
                </div>
                <div className="agent-switch-text">
                  Switched to <strong>{item.name}</strong>
                  {!item.agentId && <span className="hint"> — Default</span>}
                </div>
              </div>
            );
          }
          case "notice":
            return (
              <div key={i} className="msg notice">
                {item.text}
              </div>
            );
        }
      })}
      <div ref={endRef} />
    </div>
  );
}

type ToolItem = Extract<DisplayItem, { kind: "tool" }>;
type RenderEntry = { kind: "toolRun"; items: ToolItem[] } | { kind: "item"; item: DisplayItem };

/** Fold consecutive tool cards between messages into one collapsible run. */
function groupToolRuns(items: DisplayItem[]): RenderEntry[] {
  const out: RenderEntry[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.kind === "tool") {
      if (last?.kind === "toolRun") last.items.push(item);
      else out.push({ kind: "toolRun", items: [item] });
    } else {
      out.push({ kind: "item", item });
    }
  }
  return out;
}

/**
 * One collapsed-by-default panel covering every tool call made between two
 * messages. Expand it to see each call; each call expands further on its own.
 */
function ToolGroup({ items }: { items: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const pending = items.filter((i) => i.result === undefined).length;
  const failed = items.filter((i) => i.isError).length;
  const title =
    items.length === 1 ? items[0].name : `${items.length} tool calls`;
  // default is collapsed; user expands manually. No auto-open.
  return (
    <div className={`tool-group${pending ? " pending" : ""}${open ? " open" : ""}`}>
      <button type="button" className="tool-group-header" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-group-icon" aria-hidden="true">⚙</span>
        <span className="tool-group-title">{title}</span>
        <span className="tool-status">
          {pending ? (
            <span className="tool-running-label">
              {pending} running<span className="tool-ellipsis" aria-hidden="true" />
            </span>
          ) : failed ? (
            `${failed} failed`
          ) : (
            "done"
          )}
        </span>
      </button>
      {open && (
        <div className="tool-group-body">
          {items.map((item, i) => (
            <ToolCard key={`${item.name}-${i}`} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const pending = item.result === undefined;
  return (
    <div className={`tool-card${item.isError ? " error" : ""}${pending ? " pending" : ""}`}>
      <button className="tool-header" onClick={() => setOpen(!open)}>
        <span className="tool-chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{item.name}</span>
        <span className="tool-status">{pending ? "running…" : item.isError ? "failed" : "done"}</span>
      </button>
      {item.images && item.images.length > 0 && (
        <div className="tool-images">
          {item.images.map((src, i) => (
            <img key={i} src={src} alt={`tool result image ${i + 1}`} />
          ))}
        </div>
      )}
      {open && (
        <div className="tool-body">
          <pre className="tool-args">{item.args}</pre>
          {item.result !== undefined && <pre className="tool-result">{item.result}</pre>}
        </div>
      )}
    </div>
  );
}
