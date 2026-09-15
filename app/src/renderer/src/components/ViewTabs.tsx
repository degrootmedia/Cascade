/** Slim top-level switcher: Home (chat) ↔ Production Assistant. */

export type AppView = "home" | "prod";

import type { ReactNode } from "react";

export function ViewTabs({ value, onChange, rightContent }: { value: AppView; onChange: (v: AppView) => void; rightContent?: ReactNode }) {
  return (
    <nav className="view-tabs" role="tablist">
      <button
        role="tab"
        aria-selected={value === "home"}
        className={"view-tab" + (value === "home" ? " active" : "")}
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
