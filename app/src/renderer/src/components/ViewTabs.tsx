/** Slim top-level switcher: Home (chat) ↔ Production Assistant. */

export type AppView = "home" | "prod";

import type { ReactNode } from "react";
import { chatAttentionTitle, type ChatAttention } from "./chat-attention.js";

export function ViewTabs({ value, onChange, rightContent, chatAttention = null }: { value: AppView; onChange: (v: AppView) => void; rightContent?: ReactNode; /** Feature #29: glow the Chat tab while the agent waits for the user. */ chatAttention?: ChatAttention }) {
  return (
    <nav className="view-tabs" role="tablist">
      <button
        role="tab"
        aria-selected={value === "home"}
        className={"view-tab" + (value === "home" ? " active" : "") + (chatAttention ? ` attention attention-${chatAttention}` : "")}
        title={chatAttentionTitle(chatAttention)}
        onClick={() => onChange("home")}
      >
        Chat
      </button>
      <button
        role="tab"
        aria-selected={value === "prod"}
        className={"view-tab" + (value === "prod" ? " active" : "")}
        onClick={() => onChange("prod")}
      >
        Production Assistant
      </button>
      {rightContent && <div className="view-tabs-right">{rightContent}</div>}
    </nav>
  );
}
