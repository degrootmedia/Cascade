import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { AgentMeta } from "../../../shared/ipc.js";

function AvatarLarge({ avatar, avatarDataUrl }: { avatar: AgentMeta["avatar"]; avatarDataUrl?: string | null }) {
  if (!avatar) return <span className="id-card-avatar default">○</span>;
  if (avatar.kind === "emoji") return <span className="id-card-avatar emoji">{avatar.value}</span>;
  if (avatar.kind === "image" && avatarDataUrl) return <img className="id-card-avatar img" src={avatarDataUrl} alt="" />;
  if (avatar.kind === "image") return <span className="id-card-avatar default">◐</span>;
  return <span className="id-card-avatar default">○</span>;
}

export function AgentHoverCard({
  meta,
  avatarDataUrl,
  children,
}: {
  meta: AgentMeta | null;
  avatarDataUrl?: string | null;
  children: React.ReactNode;
}) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timeoutRef = useRef<number | null>(null);

  const updatePos = () => {
    if (!anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 10, left: r.left + r.width / 2 });
  };

  useEffect(() => {
    if (show) updatePos();
  }, [show]);

  if (!meta) return <>{children}</>;

  const enter = () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setShow(true), 250) as unknown as number;
  };
  const leave = () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setShow(false), 120) as unknown as number;
  };

  return (
    <>
      <span ref={anchorRef} className="id-card-anchor" onMouseEnter={enter} onMouseLeave={leave} style={{ display: "inline-flex", alignItems: "center" }}>
        {children}
      </span>
      {show && pos && createPortal(
        <span
          className="agent-id-card agent-id-card--fixed"
          style={{ top: pos.top, left: pos.left, transform: "translateX(-50%)" }}
          onMouseEnter={() => { if (timeoutRef.current) window.clearTimeout(timeoutRef.current); setShow(true); }}
          onMouseLeave={leave}
        >
          <AvatarLarge avatar={meta.avatar} avatarDataUrl={avatarDataUrl} />
          <span className="id-card-name">{meta.name}</span>
          <span className="id-card-desc">{meta.description || "No description"}</span>
          <span className="id-card-model">{meta.model}</span>
        </span>,
        document.body
      )}
    </>
  );
}
