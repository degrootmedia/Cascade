/**
 * Public provider surface (master plan step 07 T2).
 *
 * The only module outside `providers/` that IPC handlers and pipeline code may
 * import for provider concerns. It re-exports the vendor helpers (CLI status /
 * binary resolution) and provider-side utilities so no caller reaches a vendor
 * module directly — enforced by `test/provider-seam.test.ts`.
 *
 * Generation itself goes through the registry (`createProviders` / `mediaFor`)
 * and the shared `generation-queue`; this file is the status/utility surface.
 */
export { getHiggsfieldCliStatus, resolveHiggsfieldCliBinary } from "./higgsfield-cli.js";
export { getOpenArtCliStatus, resolveOpenArtCliBinary } from "./openart-cli.js";
export { applyOptionExposure } from "./model-schema.js";
export { createGenerationQueue, runBatch, type GenerationQueue } from "./generation-queue.js";
