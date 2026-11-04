import type { Metadata } from "next";
import Link from "next/link";
import { ActionButton } from "@/components/client";
import { Card, Empty, PageHeader, StatusBadge, Table, td, tdNum, th, thNum } from "@/components/ui";
import { actorOf, requireUser } from "@/lib/auth";
import { dateTime, inr, inrCompact, month, num } from "@/lib/format";
import { listPeriods, periodStatements } from "@/lib/services/payouts";

export const metadata: Metadata = { title: "Payouts" };

export default async function PayoutsPage(props: PageProps<"/payouts">) {
  const user = await requireUser("admin");
  const actor = actorOf(user);
  const sp = await props.searchParams;
  const periods = await listPeriods(actor);
  const selected = Number(typeof sp.period === "string" ? sp.period : 0) || periods.find((p) => p.status === "paid")?.period_id;
  const statements = selected ? await periodStatements(actor, selected) : [];
  const selectedPeriod = periods.find((p) => p.period_id === selected);
  // the oldest unpaid month is the only one that can be paid (earlier months first)
  const nextToPay = [...periods].reverse().find((p) => p.status !== "paid");

  return (
    <>
      <PageHeader
        title="Payouts"
        subtitle="A month is locked (no more report changes), then paid by the process_payout procedure in one transaction. It locks the month's row, so a second admin clicking Pay at the same moment waits and is then refused."
        actions={<ActionButton url="/api/periods" variant="secondary">Open next month</ActionButton>}
      />

      <Card title="Royalty months" className="mb-6">
        <Table>
          <thead>
            <tr>
              <th className={th}>Month</th>
              <th className={th}>Status</th>
              <th className={thNum}>Revenue</th>
              <th className={thNum}>Statements</th>
              <th className={thNum}>Recouped</th>
              <th className={thNum}>TDS</th>
              <th className={thNum}>Held</th>
              <th className={thNum}>Paid out</th>
              <th className={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => {
              const blockers = [
                Number(p.unmatched) > 0 && `${p.unmatched} unmatched lines`,
                Number(p.open_flags) > 0 && `${p.open_flags} open fraud flags (their money will be held)`,
              ].filter(Boolean);
              return (
                <tr key={p.period_id} className={p.period_id === selected ? "bg-blue-50/40" : undefined}>
                  <td className={td}>
                    <Link href={`/payouts?period=${p.period_id}`} className="font-medium hover:underline">{month(p.period_start)}</Link>
                  </td>
                  <td className={td}>
                    <StatusBadge status={p.status} />
                    {p.processed_by && <div className="mt-1 text-xs text-muted">{p.processed_by}, {dateTime(p.processed_at)}</div>}
                  </td>
                  <td className={tdNum}>{inrCompact(p.revenue)}</td>
                  <td className={tdNum}>{num(p.statements)}</td>
                  <td className={tdNum}>{p.recouped ? inrCompact(p.recouped) : "—"}</td>
                  <td className={tdNum}>{p.tds ? inrCompact(p.tds) : "—"}</td>
                  <td className={tdNum}>{Number(p.held) ? inrCompact(p.held) : "—"}</td>
                  <td className={`${tdNum} font-medium`}>{p.net_paid ? inrCompact(p.net_paid) : "—"}</td>
                  <td className={td}>
                    <div className="flex flex-wrap gap-2">
                      {p.status === "open" && <ActionButton url={`/api/periods/${p.period_id}`} body={{ action: "lock" }} variant="secondary">Lock</ActionButton>}
                      {p.status === "locked" && (
                        <>
                          <ActionButton url={`/api/periods/${p.period_id}`} body={{ action: "unlock" }} variant="secondary">Unlock</ActionButton>
                          {p.period_id === nextToPay?.period_id && (
                            <ActionButton url={`/api/periods/${p.period_id}`} body={{ action: "pay" }} confirm={`Pay ${month(p.period_start)}? This cannot be undone.`}>
                              Pay
                            </ActionButton>
                          )}
                        </>
                      )}
                    </div>
                    {p.status !== "paid" && blockers.length > 0 && <div className="mt-1 max-w-56 text-xs text-muted">{blockers.join(" · ")}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card title={selectedPeriod ? `Statements · ${month(selectedPeriod.period_start)} (top 40 by earnings)` : "Statements"}>
        {statements.length === 0 ? (
          <Empty>No statements for this month yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr><th className={th}>Contributor</th><th className={thNum}>Gross</th><th className={thNum}>Held</th><th className={thNum}>Released</th><th className={thNum}>Recouped</th><th className={thNum}>TDS</th><th className={thNum}>Net</th><th className={th}>Payment</th></tr>
            </thead>
            <tbody>
              {statements.map((s) => (
                <tr key={s.statement_id}>
                  <td className={td}><Link className="hover:underline" href={`/contributors/${s.contributor_id}`}>{s.legal_name}</Link></td>
                  <td className={tdNum}>{inr(s.gross_earned)}</td>
                  <td className={tdNum}>{Number(s.held_amount) ? inr(s.held_amount) : "—"}</td>
                  <td className={tdNum}>{Number(s.released_amount) ? inr(s.released_amount) : "—"}</td>
                  <td className={tdNum}>{Number(s.recouped_amount) ? inr(s.recouped_amount) : "—"}</td>
                  <td className={tdNum}>{inr(s.tds_amount)}</td>
                  <td className={`${tdNum} font-medium`}>{inr(s.net_payable)}</td>
                  <td className={`${td} font-mono text-xs text-muted`}>{s.payment_reference ?? "nothing owed"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
