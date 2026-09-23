/**
 * The one "Open in Suite" control every generation popup uses: it hands the
 * popup's current mode/prompt/model/source to the Image Suite (see
 * `suite-handoff.ts`) and lets App switch views. Centralizing it keeps the
 * handoff shape identical across surfaces.
 */
import type { SuiteSeed } from "../../../../shared/ipc.js";
import { openImageSuite } from "../../features/suite/suite-handoff.js";

export function OpenInSuiteButton({
  productionId,
  seed,
  label = "Open in Suite",
  title = "Open this setup in the Image Suite (history, compare)",
  className = "prod-btn",
  onOpened,
}: {
  productionId: string;
  seed?: Partial<SuiteSeed>;
  label?: string;
  title?: string;
  className?: string;
  /** Called after the handoff fires (e.g. close the popup). */
  onOpened?: () => void;
}) {
  return (
    <button
      className={className}
      title={title}
      onClick={() => {
        openImageSuite(productionId, seed);
        onOpened?.();
      }}
    >
      {label}
    </button>
  );
}
