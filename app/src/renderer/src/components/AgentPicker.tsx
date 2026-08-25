import { useEffect, useRef, useState } from "react";
import type { AgentMeta } from "../../../shared/ipc.js";
import { AgentHoverCard } from "./AgentIdCard.js";

function avatarEl(avatar: AgentMeta["avatar"], avatarDataUrl?: string | null, size = 20) {
  if (!avatar) return <span className="avatar default" style={{ width: size, height: size }}>○</span>;
  if (avatar.kind === "emoji") return <span className="avatar emoji" style={{ width: size, height: size, fontSize: size * 0.8 }}>{avatar.value}</span>;
  if (avatar.kind === "image" && avatarDataUrl) return <img className="avatar img" src={avatarDataUrl} alt="" style={{ width: size, height: size }} />;
  if (avatar.kind === "image") return <span className="avatar default" style={{ width: size, height: size }}>◐</span>;
  return <span className="avatar default" style={{ width: size, height: size }}>○</span>;
}

export function AgentPicker({
  agents,
  activeAgentId,
  activeMeta,
  onChange,
  onManage,
}: {
  agents: AgentMeta[];
  activeAgentId: string | null;
  activeMeta: AgentMeta | null;
  onChange: (id: string | null) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({});
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    if (open) document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    for (const a of agents) {
      if (a.avatar?.kind === "image" && !avatarUrls[a.id]) {
        window.cascade.getAgent(a.id).then((d) => {
          if (cancelled || !d?.avatarDataUrl) return;
          setAvatarUrls((p) => ({ ...p, [a.id]: d.avatarDataUrl as string }));
        });
      }
    }
    return () => { cancelled = true; };
  }, [agents]);

  const displayAvatar = activeMeta?.avatar ?? null;
  const displayDataUrl = activeMeta?.id ? avatarUrls[activeMeta.id] : undefined;
  const label = activeMeta?.name ?? "Default";

  return (
    <div className="agent-picker" ref={ref}>
      <AgentHoverCard meta={activeMeta} avatarDataUrl={displayDataUrl}>
        <button className="agent-picker-btn" onClick={() => setOpen((v) => !v)} title={label}>
          {avatarEl(displayAvatar, displayDataUrl, 22)}
          <span className="agent-picker-name">{label}</span>
          <span className="agent-picker-caret">▾</span>
        </button>
      </AgentHoverCard>
      {open && (
        <div className="agent-menu">
          <button
            className={`agent-option${!activeAgentId ? " selected" : ""}`}
            onClick={() => { onChange(null); setOpen(false); }}
          >
            <span className="avatar default" style={{ width: 20, height: 20 }}>○</span>
            <span className="agent-option-name">Default</span>
            <span className="agent-option-desc">No agent — standard Cascade</span>
          </button>
          {agents.map((a) => (
            <button
              key={a.id}
              className={`agent-option${activeAgentId === a.id ? " selected" : ""}`}
              onClick={() => { onChange(a.id); setOpen(false); }}
              title={a.description}
            >
              <AgentHoverCard meta={a} avatarDataUrl={avatarUrls[a.id]}>
                <span style={{ display: "inline-flex" }}>{avatarEl(a.avatar, avatarUrls[a.id], 20)}</span>
              </AgentHoverCard>
              <span className="agent-option-name">{a.name}</span>
              <span className="agent-option-desc">{a.description || a.model}</span>
            </button>
          ))}
          <div className="agent-menu-sep" />
          <button className="agent-option manage" onClick={() => { onManage(); setOpen(false); }}>
            Manage agents…
          </button>
        </div>
      )}
    </div>
  );
}
