/**
 * Per-provider capability record for the generation queue.
 *
 * Verified against the code (not assumed):
 *  - canResume: every provider implements recheckPendingImage/Video, which
 *    look an existing task up by id (OpenArt `creation_get`, the CLIs'
 *    `generate get <id>`), so a task id stored in the ledger can be polled
 *    and fetched after a restart.
 *  - canCancel: NO provider exposes a cancel call today (only status text
 *    "cancelled" is parsed). Cancel is therefore local: Cascade stops
 *    fetching and the provider may still finish the job on its side.
 *  - reportsProgress: no provider reports a percentage today; the queue
 *    shows indeterminate bars.
 *  - maxConcurrent: 1 for every provider until parallel jobs are verified safe.
 */
export interface ProviderCapabilities {
  canResume: boolean;
  canCancel: boolean;
  reportsProgress: boolean;
  maxConcurrent: number;
}

export const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  "higgsfield-cli": { canResume: true, canCancel: false, reportsProgress: false, maxConcurrent: 1 },
  "openart-cli": { canResume: true, canCancel: false, reportsProgress: false, maxConcurrent: 1 },
  openart: { canResume: true, canCancel: false, reportsProgress: false, maxConcurrent: 1 },
};

const UNKNOWN: ProviderCapabilities = { canResume: false, canCancel: false, reportsProgress: false, maxConcurrent: 1 };

export function capabilitiesFor(provider: string | undefined): ProviderCapabilities {
  return (provider && PROVIDER_CAPABILITIES[provider]) || UNKNOWN;
}

/** Provider id from a namespaced model id (`higgsfield-cli:<id>`); bare ids are MCP OpenArt. */
export function providerFromModel(model: string | undefined): string {
  if (model?.startsWith("higgsfield-cli:")) return "higgsfield-cli";
  if (model?.startsWith("openart-cli:")) return "openart-cli";
  return "openart";
}
