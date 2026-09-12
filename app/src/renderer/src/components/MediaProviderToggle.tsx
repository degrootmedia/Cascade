import openartLogo from "../assets/providers/openart.png";
import higgsfieldLogo from "../assets/providers/higgsfield.png";
import type { MediaProviderId, MediaProviderInfo } from "../../../shared/ipc.js";

/** Remaining balances per media vendor (null = unknown/unconnected). */
export type MediaCredits = Record<MediaProviderId, number | null>;

const LOGOS: Record<string, string> = {
  openart: openartLogo,
  higgsfield: higgsfieldLogo,
  // Same vendor families as their MCP transports — one recognizable mark each.
  "higgsfield-cli": higgsfieldLogo,
  "openart-cli": openartLogo,
};

/** Compact balance text: OpenArt (either transport) as an integer,
 *  Higgsfield (either transport) with 1 decimal. */
export function formatMediaBalance(id: MediaProviderId, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (id === "higgsfield" || id === "higgsfield-cli")
    return v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return Math.round(v).toLocaleString("en-US");
}

/**
 * Segmented media-provider dial for the top bar. One half per vendor from
 * `providers` (data-driven, so new transports appear automatically); each
 * half shows the vendor logo + its remaining credit balance, and clicking a
 * half switches the global media provider. An unavailable vendor stays
 * selectable — its tooltip says how to connect it.
 */
export function MediaProviderToggle({
  active,
  credits,
  available,
  providers,
  onSelect,
}: {
  active: MediaProviderId;
  credits: MediaCredits;
  available: Record<MediaProviderId, boolean>;
  providers: MediaProviderInfo[];
  onSelect: (id: MediaProviderId) => void;
}) {
  const list = providers.length
    ? providers
    : (["openart", "higgsfield"] as MediaProviderId[]).map((id) => ({
        id,
        displayName: id === "openart" ? "OpenArt" : "Higgsfield",
        available: true,
      }));
  return (
    <div className="media-toggle" role="radiogroup" aria-label="Media generation provider">
      {list.map(({ id, displayName }) => {
        const name = displayName || id;
        const isActive = active === id;
        const balance = formatMediaBalance(id, credits[id] ?? null);
        const connected = available[id] !== false;
        const isCli = id.endsWith("-cli");
        const title = connected
          ? `${name} — ${balance} credits`
          : isCli
            ? `${name} isn't set up — install its CLI and sign in, or set a custom binary path in Settings → Media generation`
            : `${name} MCP isn't connected — add its MCP server below`;
        return (
          <button
            key={id}
            role="radio"
            aria-checked={isActive}
            aria-label={`${name}, ${balance} credits`}
            title={title}
            className={"media-half" + (isActive ? " active" : "")}
            onClick={() => onSelect(id)}
          >
            <img src={LOGOS[id] ?? higgsfieldLogo} alt="" width={18} height={18} className="media-logo" draggable={false} />
            <span className="media-balance">{balance}</span>
          </button>
        );
      })}
    </div>
  );
}
