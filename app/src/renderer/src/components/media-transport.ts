import { isProviderVisible, type MediaProviderId, type MediaProviderInfo, type ProviderTransportMode } from "../../../shared/ipc.js";

export type { ProviderTransportMode };
export { isProviderVisible };

/** Persisted mode flag (`ui.providerTransportMode`): renderer-local storage,
 *  default "mcp", invalid values coerce to "mcp". */
const STORAGE_KEY = "cascade.providerTransportMode";

/** Broadcast when the mode changes so the top bar and Settings stay in sync. */
export const TRANSPORT_CHANGED = "cascade:provider-transport-changed";

export function readTransportMode(): ProviderTransportMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "cli" || raw === "mcp" ? raw : "mcp";
  } catch {
    return "mcp";
  }
}

export function hasStoredTransportMode(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "cli" || raw === "mcp";
  } catch {
    return false;
  }
}

export function writeTransportMode(mode: ProviderTransportMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(TRANSPORT_CHANGED));
}

/** First visible + available provider under a mode, for reconciling the
 *  active provider after a flip (null = leave the active provider untouched
 *  and surface the "no available provider" state instead). */
export function firstVisibleAvailable(
  list: MediaProviderInfo[],
  mode: ProviderTransportMode,
): MediaProviderId | null {
  const visible = list.filter((p) => isProviderVisible(p.id, mode));
  return visible.find((p) => p.available)?.id ?? null;
}
