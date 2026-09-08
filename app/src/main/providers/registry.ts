/**
 * Media-provider registry. index.ts builds both vendors once (injecting the
 * live McpManager + the ledger recorder at the seam) and resolves the active
 * one per call from the global settings selection. Selection is global-only
 * by decision (per-production/per-shot scoping is a future expansion, not a
 * rewrite — it would thread a provider id through Production + every IPC).
 */
import type { McpManager } from "../mcp.js";
import { OpenArtClient } from "../openart.js";
import { HiggsfieldProvider } from "./higgsfield.js";
import type { GenerationRecorder, MediaProvider, MediaProviderId } from "./types.js";

export type { MediaProviderId };

export const PROVIDER_META: Record<MediaProviderId, { displayName: string }> = {
  openart: { displayName: "OpenArt" },
  higgsfield: { displayName: "Higgsfield" },
};

export const PROVIDER_IDS: MediaProviderId[] = ["openart", "higgsfield"];

/** Coerce a stored/foreign value to a known provider id (unknown → openart). */
export function resolveProviderId(raw: unknown): MediaProviderId {
  return raw === "higgsfield" ? "higgsfield" : "openart";
}

export function createProviders(mcp: McpManager, recorder?: GenerationRecorder): Record<MediaProviderId, MediaProvider> {
  return {
    openart: new OpenArtClient(mcp, recorder),
    higgsfield: new HiggsfieldProvider(mcp, recorder),
  };
}
