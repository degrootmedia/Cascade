import { useEffect, useState } from "react";

export function useExternalImageMenu(onEdit: () => void): {
  onContextMenu: (e: React.MouseEvent) => void;
  menu: React.ReactNode;
} {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    // close on any click or escape
    window.addEventListener("click", close);
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    return () => {
      window.removeEventListener("click", close);
    };
  }, [pos]);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPos({ x: e.clientX, y: e.clientY });
  };

  const menu = pos ? (
    <div
      className="external-edit-menu"
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        zIndex: 9999,
        background: "var(--bg-raised, #22272c)",
        border: "1px solid var(--border, #2e343a)",
        borderRadius: 8,
        padding: 4,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        minWidth: 160,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          background: "none",
          border: "none",
          color: "var(--text, #e6e9ec)",
          padding: "6px 10px",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: "0.85rem",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-panel, #191d21)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
        onClick={() => {
          setPos(null);
          onEdit();
        }}
      >
        Edit externally
      </button>
    </div>
  ) : null;

  return { onContextMenu, menu };
}
