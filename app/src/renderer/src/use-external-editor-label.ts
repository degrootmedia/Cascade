import { useEffect, useState } from "react";
import { externalEditorLabel } from "../../shared/editor-label.js";

/**
 * The configured external-editor label for renderer menus. Fetched once
 * from `settings:get` (module-cached across surfaces) and refreshed by the
 * settings section whenever the editor changes, so no menu hardcodes the
 * string and none needs settings prop-threaded to it.
 */
let cached: string | null = null;
let inflight: Promise<string> | null = null;

function loadLabel(): Promise<string> {
  if (cached !== null) return Promise.resolve(cached);
  inflight ??= Promise.resolve()
    .then(() => window.cascade.getSettings())
    .then((s) => {
      cached = externalEditorLabel(s.externalEditor);
      return cached;
    })
    .catch(() => "Edit externally");
  return inflight;
}

/** Called by the settings section after the editor path changes. */
export function refreshExternalEditorLabel(editorPath: string | null): void {
  cached = externalEditorLabel(editorPath);
  inflight = null;
}

export function useExternalEditorLabel(): string {
  const [label, setLabel] = useState<string>(cached ?? "Edit externally");
  useEffect(() => {
    let live = true;
    void loadLabel().then((l) => {
      if (live) setLabel(l);
    });
    return () => {
      live = false;
    };
  }, []);
  return label;
}
