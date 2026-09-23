import { useEffect, useRef } from "react";
import { SearchIcon } from "../icons.js";

/** Search box at the top of the rail. Ctrl/⌘+F focuses it while Settings is
 *  open; clearing restores the full rail. */
export function SettingsSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="settings-search">
      <SearchIcon size={14} />
      <input
        ref={inputRef}
        type="search"
        aria-label="Search settings"
        placeholder="Search settings…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button className="link" onClick={() => onChange("")} aria-label="Clear search">
          Clear
        </button>
      )}
    </div>
  );
}
