"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { inr } from "@/lib/format";
import { ErrorText, callApi } from "./client";
import { buttonClass, inputClass, secondaryButtonClass } from "./ui";

const ROLES = ["artist", "featured_artist", "producer", "songwriter", "composer", "lyricist"];

interface Row {
  contributor_id: number | "";
  role: string;
  share_pct: string;
}

interface SimulationResult {
  periodStart: string;
  rows: { contributor_id: number; name: string; role: string; current: number; proposed: number }[];
}

/**
 * F1 split editor + X2 what-if.
 * The total shown here is only a convenience: the database rejects any split
 * that doesn't total exactly 100% (deferred constraint trigger R1).
 */
export function SplitEditor({
  trackId,
  contributors,
  initial,
  earliestMonth,
  canPropose,
}: {
  trackId: number;
  contributors: { contributor_id: number; label: string }[];
  initial: { contributor_id: number; role: string; share_pct: string }[];
  earliestMonth: string; // YYYY-MM
  canPropose: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(
    initial.length ? initial.map((r) => ({ ...r, share_pct: String(Number(r.share_pct)) })) : [{ contributor_id: "", role: "artist", share_pct: "100" }],
  );
  const [month, setMonth] = useState(earliestMonth);
  const [busy, setBusy] = useState<"simulate" | "propose" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sim, setSim] = useState<SimulationResult | null>(null);

  const total = rows.reduce((s, r) => s + (Number(r.share_pct) || 0), 0);
  const shares = rows
    .filter((r) => r.contributor_id !== "")
    .map((r) => ({ contributor_id: Number(r.contributor_id), role: r.role, share_pct: Number(r.share_pct) }));
  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function run(kind: "simulate" | "propose") {
    setBusy(kind);
    setError(null);
    setMessage(null);
    try {
      if (kind === "simulate") {
        setSim(await callApi<SimulationResult>(`/api/tracks/${trackId}/simulate`, "POST", { shares }));
      } else {
        await callApi(`/api/tracks/${trackId}/splits`, "POST", { validFrom: `${month}-01`, shares });
        setMessage("Proposal created. Every contributor on it now has to approve it in their portal.");
        router.refresh();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              value={r.contributor_id}
              onChange={(e) => update(i, { contributor_id: e.target.value ? Number(e.target.value) : "" })}
              className={`${inputClass} w-72`}
            >
              <option value="">Choose contributor…</option>
              {contributors.map((c) => (
                <option key={c.contributor_id} value={c.contributor_id}>
                  {c.label}
                </option>
              ))}
            </select>
            <select value={r.role} onChange={(e) => update(i, { role: e.target.value })} className={inputClass}>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role.replace("_", " ")}
                </option>
              ))}
            </select>
            <span className="inline-flex items-center gap-1">
              <input
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                value={r.share_pct}
                onChange={(e) => update(i, { share_pct: e.target.value })}
                className={`${inputClass} w-24 text-right`}
              />
              <span className="text-sm text-muted">%</span>
            </span>
            <button type="button" className="text-sm text-muted hover:text-red-700" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className={secondaryButtonClass} onClick={() => setRows((rs) => [...rs, { contributor_id: "", role: "producer", share_pct: "0" }])}>
          Add share
        </button>
        <span className={`num text-sm font-medium ${Math.abs(total - 100) < 0.001 ? "text-emerald-700" : "text-amber-700"}`}>
          Total {total.toFixed(2)}% {Math.abs(total - 100) < 0.001 ? "✓" : "(must be exactly 100%)"}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
        <button type="button" disabled={busy !== null || shares.length === 0} className={secondaryButtonClass} onClick={() => run("simulate")}>
          {busy === "simulate" ? "Running two payouts…" : "What-if: simulate next payout"}
        </button>
        {canPropose && (
          <>
            <label className="flex flex-col text-xs text-muted">
              Starts from
              <input type="month" min={earliestMonth} value={month} onChange={(e) => setMonth(e.target.value)} className={inputClass} />
            </label>
            <button type="button" disabled={busy !== null || shares.length === 0} className={buttonClass} onClick={() => run("propose")}>
              {busy === "propose" ? "Proposing…" : "Propose this split"}
            </button>
          </>
        )}
      </div>
      <ErrorText error={error} />
      {message && <p className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</p>}

      {sim && (
        <div className="mt-4 rounded-lg border border-border bg-white p-4">
          <p className="mb-2 text-sm">
            What this track would pay for <strong>{new Date(`${sim.periodStart}T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })}</strong>,
            computed by the real payout procedure inside a transaction that was rolled back. Includes money arriving through sample chains.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-muted">
                <th className="py-1 text-left font-medium">Contributor</th>
                <th className="py-1 text-left font-medium">Role</th>
                <th className="py-1 text-right font-medium">Current split</th>
                <th className="py-1 text-right font-medium">Proposed</th>
                <th className="py-1 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {sim.rows.map((r) => {
                const diff = r.proposed - r.current;
                return (
                  <tr key={`${r.contributor_id}:${r.role}`} className="border-t border-border">
                    <td className="py-1">{r.name}</td>
                    <td className="py-1 text-muted">{r.role.replace("_", " ")}</td>
                    <td className="num py-1 text-right">{inr(r.current)}</td>
                    <td className="num py-1 text-right">{inr(r.proposed)}</td>
                    <td className={`num py-1 text-right ${diff > 0 ? "text-emerald-700" : diff < 0 ? "text-red-700" : "text-muted"}`}>
                      {diff > 0 ? "+" : ""}
                      {inr(diff)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
