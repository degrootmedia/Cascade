/**
 * Presentational wrappers around `useGenerationCost`:
 *
 * - `CostValue` — self-contained quote pill (token icon + number) for
 *   sentences ("This clip costs about …") and standalone labels.
 * - `GenerationCostSuffix` — the same pill for Generate-button labels and
 *   toolbar spots (hooks can't run inside `.map` rows). Null when the quote
 *   is unknown, so the parent stays readable.
 *
 * Buttons that already hold the hook's state can use `CostValue` directly
 * instead of suffixing. Styling is pure CSS (`.cost-pill`): zero JS cost.
 */
import type { GenerationCostRequest } from "../../../../shared/ipc.js";
import { TokenIcon } from "../icons.js";
import { formatGenerationCost, useGenerationCost } from "./generation-cost.js";

export function CostValue({ cost, title }: { cost: number; title?: string }) {
  return (
    <span className="cost-pill" title={title ?? `About ${formatGenerationCost(cost)} credits`}>
      <TokenIcon size={12} />
      {formatGenerationCost(cost)}
    </span>
  );
}

export function GenerationCostSuffix({ req }: { req: GenerationCostRequest | null }) {
  const { cost } = useGenerationCost(req);
  if (cost == null) return null;
  return <CostValue cost={cost} />;
}
