import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { DisplayItem } from "../types.js";
import { AgentHoverCard } from "./AgentIdCard.js";
import cascadeLogoLight from "../assets/brand/cascade-logo-light.svg";

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
          <img className="empty-brand" src={cascadeLogoLight} alt="Cascade" />
          {pureChat ? (
            <p>Plain chat — no file access. Pick a folder in the header to let Cascade create, edit, or organize files.</p>
          ) : (
            <p>Your AI agent for local files. Pick a workspace, then ask it to create, edit, or organize.</p>
          )}
        </div>
      )}
      {groupToolRuns(items).map((entry) => {
        if (entry.kind === "toolRun") return <ToolGroup key={toolRunKey(entry.items)} items={entry.items} />;
        const item = entry.item;
        switch (item.kind) {
          case "user": {
            const atts =
              item.attachments ??
              (item.images?.map((src) => ({ dataUrl: src, name: "image", mime: "image/*" })) ?? []);
            return (
              <div key={itemKey(item)} className="msg user">
                {atts.length > 0 && (
                  <div className="msg-attachments">
                    {atts.map((a, j) =>
                      a.mime.startsWith("image/") ? (
                        <img key={j} src={a.dataUrl} alt={a.name} />
                      ) : (
                        <span key={j} className="msg-file" title={a.name}>{a.name}</span>
                      )
                    )}
                  </div>
                )}
                {item.text}
              </div>
            );
          }
          case "assistant":
            return <AssistantMessage key={itemKey(item)} text={item.text} streaming={item.streaming} />;
          case "mention":
            return (
              <div key={itemKey(item)} className="msg mention">
                <img src={item.image} alt={item.filename} />
                <span className="mention-label">OpenArt reference: {item.filename}</span>
              </div>
            );
          case "agent-switch": {
            const switchMeta = item.agentId ? { id: item.agentId, name: item.name, description: (item as { description?: string }).description ?? "", avatar: item.avatar, model: (item as { model?: string }).model ?? "", allowedTools: "all" as const, createdAt: "", updatedAt: "", hasPrompt: false } : null;
            const avatarNode = !item.avatar ? <span className="avatar default">○</span> : item.avatar.kind === "emoji" ? <span className="avatar emoji">{item.avatar.value}</span> : item.avatarDataUrl ? <img className="avatar img" src={item.avatarDataUrl} alt="" style={{ width: 24, height: 24, borderRadius: "50%" }} /> : <span className="avatar default">◐</span>;
            return (
              <div key={itemKey(item)} className="agent-switch-frame">
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
              <div key={itemKey(item)} className="msg notice">
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

/**
 * Stable React keys for transcript rows. Entries carry no message/run id (see
 * `DisplayItem` in shared/ipc.ts), so keys derive from the entry's own content:
 * a tool group's key is its calls' names+args (unchanged when results stream
 * in), a message's key its kind+text. Deleting/undoing an earlier row keeps
 * later rows' keys, so expanded/collapsed and "Copied" state follows the item,
 * not the slot. Duplicate identical rows can still collide — strictly better
 * than index keys, which misattribute state on every removal.
 */
function toolRunKey(items: ToolItem[]): string {
  return `toolrun:${items.map((i) => `${i.name}:${i.args}`).join("||")}`;
}

function itemKey(item: DisplayItem): string {
  switch (item.kind) {
    case "user":
      return `user:${item.text}:${(item.attachments ?? []).map((a) => a.name).join(",")}:${(item.images ?? []).join(",")}`;
    case "assistant":
      return `assistant:${item.text}`;
    case "tool":
      return `tool:${item.name}:${item.args}`;
    case "mention":
      return `mention:${item.filename}:${item.image}`;
    case "agent-switch":
      return `agentswitch:${item.agentId}:${item.at}:${item.name}`;
    case "notice":
      return `notice:${item.text}`;
  }
}

/** Extract the copyable text for a fenced block, excluding the copy button itself. */
export function codeBlockText(pre: HTMLElement): string {
  const code = pre.querySelector("code");
  return (code ?? pre).textContent ?? "";
}

async function copyCodeBlockText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API unavailable (permissions, insecure context) — fall back to execCommand.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Assistant bubble. Fenced code blocks (the "inset panels") each get a Copy
 * button that writes the block's text — paragraph breaks intact — to the clipboard.
 * Buttons are injected post-render so sanitized markdown HTML stays untouched.
 */
function AssistantMessage({ text, streaming }: { text: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(text);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const pres = root.querySelectorAll("pre");
    pres.forEach((pre) => {
      const el = pre as HTMLElement;
      // Already enhanced on a previous streaming tick.
      if (el.parentElement?.classList.contains("code-block-wrap")) return;
      const wrap = document.createElement("div");
      wrap.className = "code-block-wrap";
      el.replaceWith(wrap);
      wrap.appendChild(el);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "code-copy-btn";
      btn.textContent = "Copy";
      btn.setAttribute("aria-label", "Copy code to clipboard");
      btn.addEventListener("click", () => {
        void copyCodeBlockText(codeBlockText(el)).then((ok) => {
          btn.textContent = ok ? "Copied" : "Failed";
          setTimeout(() => {
            btn.textContent = "Copy";
          }, 1500);
        });
      });
      wrap.appendChild(btn);
    });
  }, [html]);

  return (
    <div
      ref={ref}
      className={`msg assistant${streaming ? " streaming" : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

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
          {items.map((item, i) => {
            // Disambiguate repeat identical calls (same name+args) so keys stay
            // unique; the suffix counts only identical siblings, so removing a
            // different call never renames a surviving card's key.
            const base = `${item.name}:${item.args}`;
            const occurrence = items.slice(0, i).filter((o) => o.name === item.name && o.args === item.args).length;
            return <ToolCard key={occurrence ? `${base}#${occurrence}` : base} item={item} />;
          })}
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
            <img key={`${i}-${src}`} src={src} alt={`tool result image ${i + 1}`} />
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
