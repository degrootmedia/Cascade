import { useEffect, useState } from "react";
import type { LedgerView } from "../../../../shared/ipc.js";
import { ExpensesIcon, XIcon } from "../icons.js";

function formatPrice(p: number): string {
  return `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The Expenses page (far-right tab): every AI generation priced against the
 *  user's rules plus manual "purchased asset" rows, tallied at the bottom. */
export function ExpensesPanel() {
  const [view, setView] = useState<LedgerView | null>(null);
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      setView(await window.cascade.getLedger());
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const addManual = async () => {
    const amt = Number(amount);
    if (!label.trim() || !Number.isFinite(amt)) return;
    setBusy(true);
    setErr(null);
    try {
      setView(await window.cascade.addManualExpense(label.trim(), amt));
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
      setView(await window.cascade.removeLedgerEntry(id));
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
      setView(await window.cascade.repriceExpenses());
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const entries = view?.entries ?? [];

  return (
    <section className="prod-panel prod-expenses">
      <h3><ExpensesIcon size={18} className="prod-panel-title-icon" /> Expenses</h3>
      <p className="hint">
        Every AI generation is priced against the rules in Settings → Expense pricing and tallied here.
        Rows are mirrored to a CSV text file (expenses.csv) you can open anytime.
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
        <button className="prod-btn" onClick={() => void window.cascade.openLedgerFile()} title="Open expenses.csv">
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
              <td className="num">{formatPrice(e.price)}</td>
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