import { useEffect, useState } from "react";
import type { LedgerView } from "../../../../shared/ipc.js";
import { ExpensesIcon, TokenIcon, XIcon } from "../icons.js";
import { formatGenerationCost } from "./generation-cost.js";

function formatPrice(p: number): string {
  return `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** One row's price: credit-tracked rows (Higgsfield CLI) show their credits
 *  with the token icon; $ rule rows and manual rows show dollars. */
function RowPrice({ credits, price, rate }: { credits?: number; price: number; rate: number | null }) {
  if (credits == null) return <>{formatPrice(price)}</>;
  const title = rate != null
    ? `${formatGenerationCost(credits)} credits × $${rate}/credit = ${formatPrice(credits * rate)}`
    : `${formatGenerationCost(credits)} credits — set a Higgsfield credit value in the Model Customizer to price them`;
  return (
    <span className="cost-badge" title={title}>
      <TokenIcon size={12} />
      {formatGenerationCost(credits)}
    </span>
  );
}

/** The Expenses page (far-right tab): this production's AI generations priced
 *  against the user's rules plus manual "purchased asset" rows, tallied at the
 *  bottom. Entries are scoped (and saved) per project. */
export function ExpensesPanel({ productionId }: { productionId: string }) {
  const [view, setView] = useState<LedgerView | null>(null);
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      setView(await window.cascade.getLedger(productionId));
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productionId]);

  const addManual = async () => {
    const amt = Number(amount);
    if (!label.trim() || !Number.isFinite(amt)) return;
    setBusy(true);
    setErr(null);
    try {
      setView(await window.cascade.addManualExpense(productionId, label.trim(), amt));
      setLabel("");
      setAmount("");
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setErr(null);
    try {
      setView(await window.cascade.removeLedgerEntry(productionId, id));
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const reprice = async () => {
    setBusy(true);
    setErr(null);
    try {
      setView(await window.cascade.repriceExpenses(productionId));
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const entries = view?.entries ?? [];
  const rate = view?.creditUsd ?? null;
  const creditRows = entries.filter((e) => e.credits != null).length;

  return (
    <section className="prod-panel prod-expenses">
      <h3><ExpensesIcon size={18} className="prod-panel-title-icon" /> Expenses</h3>
      <p className="hint">
        This project's AI generations{rate != null ? ` (Higgsfield credits convert at $${rate}/credit)` : ""}, priced against the rules in Settings → Media generation and tallied here.
        Rows are mirrored to a per-project CSV text file you can open anytime.
      </p>

      <div className="prod-expenses-toolbar">
        <button className="prod-btn" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
        <button
          className="prod-btn"
          onClick={() => void reprice()}
          disabled={busy}
          title="Re-run the current Settings price rules over every generation (manual rows keep their amounts)"
        >
          Recompute prices
        </button>
        <button className="prod-btn" onClick={() => void window.cascade.openLedgerFile(productionId)} title="Open this project's expenses CSV">
          Open text file
        </button>
      </div>

      {err && <p className="error-text">{err}</p>}

      <table className="prod-expenses-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Model</th>
            <th>Resolution</th>
            <th>Length</th>
            <th>Label</th>
            <th className="num">Price</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className={e.kind === "manual" ? "manual" : ""}>
              <td className="nowrap">{new Date(e.at).toLocaleString()}</td>
              <td>{e.kind === "manual" ? "purchase" : e.kind}</td>
              <td>{e.model}</td>
              <td>
                {e.resolution}
                {e.aspectRatio ? ` · ${e.aspectRatio}` : ""}
              </td>
              <td>{e.kind === "video" && e.durationSec ? `${e.durationSec}s` : ""}</td>
              <td>{e.label ?? ""}</td>
              <td className="num"><RowPrice credits={e.credits} price={e.price} rate={rate} /></td>
              <td>
                <button className="prod-btn inline" onClick={() => void remove(e.id)} title="Remove row" disabled={busy}>
                  <XIcon size={12} />
                </button>
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={8} className="hint">No generations or expenses yet.</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={6}>
              Total — {view?.imageCount ?? 0} images · {view?.videoCount ?? 0} videos
              {rate == null && creditRows > 0 && (
                <> · {creditRows} credit row{creditRows === 1 ? "" : "s"} unpriced (set a Higgsfield credit value in the Model Customizer)</>
              )}
            </td>
            <td className="num total">{formatPrice(view?.total ?? 0)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>

      <div className="prod-expenses-add">
        <input
          value={label}
          placeholder="Purchased asset (e.g. stock audio pack)"
          onChange={(e) => setLabel(e.target.value)}
        />
        <input
          value={amount}
          placeholder="Amount ($)"
          type="number"
          min="0"
          step="0.01"
          onChange={(e) => setAmount(e.target.value)}
        />
        <button
          className="prod-btn primary"
          disabled={busy || !label.trim() || !Number.isFinite(Number(amount))}
          onClick={() => void addManual()}
        >
          Add row
        </button>
      </div>
    </section>
  );
}