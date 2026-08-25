/** Slim top-level switcher: Home (chat) ↔ Production Assistant. */

export type AppView = "home" | "prod";

export function ViewTabs({ value, onChange }: { value: AppView; onChange: (v: AppView) => void }) {
  return (
    <nav className="view-tabs" role="tablist">
      <span className="view-tabs-brand">Cascade</span>
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
    </nav>
  );
}
