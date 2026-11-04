import type { Metadata } from "next";
import Link from "next/link";
import { ActionButton } from "@/components/client";
import { Card, Empty, PageHeader, Stat, StatusBadge, Table, td, tdNum, th, thNum } from "@/components/ui";
import { actorOf, requireUser } from "@/lib/auth";
import { date, inr, pct } from "@/lib/format";
import { myOverview, myStatementLines } from "@/lib/services/me";

export const metadata: Metadata = { title: "My royalties" };

/**
 * Contributor portal. Every query here runs as app_contributor, which can read
 * only the v_my_* views, so this page physically cannot show anyone else's data.
 */
export default async function MyRoyaltiesPage(props: PageProps<"/me">) {
  const user = await requireUser("contributor");
  const actor = actorOf(user);
  const sp = await props.searchParams;
  const openStatement = Number(typeof sp.statement === "string" ? sp.statement : 0);
  const { statements, splits, advances, pending } = await myOverview(actor);
  const lines = openStatement ? await myStatementLines(actor, openStatement) : [];

  const paid = statements.reduce((s, r) => s + Number(r.net_payable), 0);
  const outstanding = advances.reduce((s, a) => s + Number(a.outstanding), 0);
  const active = splits.filter((s) => s.status === "active");

  return (
    <>
      <PageHeader title={`Hello, ${user.name.split(" ")[0]}`} subtitle="Your splits, statements and payments. Only your own data is visible here." />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Paid to you" value={inr(paid)} hint={`${statements.length} monthly statements`} />
        <Stat label="Latest month" value={statements[0] ? inr(statements[0].net_payable) : "—"} hint={statements[0]?.period_label} />
        <Stat label="Tracks you're on" value={new Set(active.map((s) => s.track_id)).size} />
        <Stat label="Advance still to recoup" value={inr(outstanding)} />
      </div>

      <Card title={`Waiting for your decision (${pending.length})`} className="mb-6">
        {pending.length === 0 ? (
          <Empty>Nothing to approve right now.</Empty>
        ) : (
          <div className="flex flex-col gap-4">
            {pending.map((p) => (
              <div key={p.version_id} className="rounded-lg border border-border p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{p.title}</div>
                    <div className="text-xs text-muted">New split from {date(p.valid_from)}</div>
                  </div>
                  <div className="flex gap-2">
                    <ActionButton url={`/api/splits/${p.version_id}/decision`} body={{ decision: "approved" }}>Approve</ActionButton>
                    <ActionButton url={`/api/splits/${p.version_id}/decision`} body={{ decision: "rejected" }} variant="danger" confirm="Reject this split? The whole proposal will be rejected.">
                      Reject
                    </ActionButton>
                  </div>
                </div>
                <Table>
                  <tbody>
                    {p.shares.map((s, i) => (
                      <tr key={i} className={s.is_me ? "bg-blue-50/50" : undefined}>
                        <td className={td}>{s.legal_name}{s.is_me && <span className="text-muted"> (you)</span>}</td>
                        <td className={`${td} text-muted`}>{s.role.replace("_", " ")}</td>
                        <td className={tdNum}>{pct(s.share_pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ))}
            <p className="text-xs text-muted">A split goes live only when everyone on it approves; one rejection rejects it.</p>
          </div>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Statements">
          {statements.length === 0 ? (
            <Empty>No statements yet.</Empty>
          ) : (
            <Table>
              <thead>
                <tr><th className={th}>Month</th><th className={thNum}>Gross</th><th className={thNum}>Deductions</th><th className={thNum}>Paid</th><th className={th} /></tr>
              </thead>
              <tbody>
                {statements.map((s) => (
                  <tr key={s.statement_id} className={s.statement_id === openStatement ? "bg-blue-50/50" : undefined}>
                    <td className={td}>{s.period_label}</td>
                    <td className={tdNum}>{inr(s.gross_earned)}</td>
                    <td className={`${tdNum} text-muted`}>
                      {inr(Number(s.recouped_amount) + Number(s.tds_amount) + Number(s.held_amount) - Number(s.released_amount))}
                    </td>
                    <td className={`${tdNum} font-medium`}>{inr(s.net_payable)}</td>
                    <td className={td}>
                      <Link className="text-xs text-accent hover:underline" href={s.statement_id === openStatement ? "/me" : `/me?statement=${s.statement_id}`}>
                        {s.statement_id === openStatement ? "Hide" : "Details"}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title={openStatement ? "Statement details" : "Your splits"}>
          {openStatement ? (
            <StatementDetails statement={statements.find((s) => s.statement_id === openStatement)} lines={lines} />
          ) : active.length === 0 ? (
            <Empty>You&apos;re not on any active split.</Empty>
          ) : (
            <Table>
              <thead>
                <tr><th className={th}>Track</th><th className={th}>Role</th><th className={thNum}>Share</th><th className={th}>Since</th></tr>
              </thead>
              <tbody>
                {active.map((s) => (
                  <tr key={`${s.version_id}:${s.role}`}>
                    <td className={td}>{s.title}</td>
                    <td className={`${td} text-muted`}>{s.role.replace("_", " ")}</td>
                    <td className={tdNum}>{pct(s.share_pct)}</td>
                    <td className={td}>{date(s.valid_from)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      {advances.length > 0 && (
        <Card title="Advances" className="mt-6">
          <Table>
            <thead>
              <tr><th className={th}>Issued</th><th className={th}>For</th><th className={thNum}>Amount</th><th className={thNum}>Recouped</th><th className={thNum}>Outstanding</th></tr>
            </thead>
            <tbody>
              {advances.map((a) => (
                <tr key={a.advance_id}>
                  <td className={td}>{date(a.issued_on)}</td>
                  <td className={`${td} text-muted`}>{a.note}</td>
                  <td className={tdNum}>{inr(a.amount)}</td>
                  <td className={tdNum}>{inr(a.recouped)}</td>
                  <td className={`${tdNum} font-medium`}>{inr(a.outstanding)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-xs text-muted">Advances are recouped from your earnings, oldest first, before anything is paid out.</p>
        </Card>
      )}
    </>
  );
}

function StatementDetails({
  statement,
  lines,
}: {
  statement?: Record<string, string>;
  lines: Record<string, string>[];
}) {
  if (!statement) return <Empty>That statement isn&apos;t yours.</Empty>;
  const row = (label: string, value: string | number, strong = false) => (
    <div className={`flex justify-between py-1 ${strong ? "border-t border-border font-semibold" : ""}`}>
      <span>{label}</span>
      <span className="num">{inr(value)}</span>
    </div>
  );
  return (
    <div>
      <div className="mb-4 text-sm">
        <div className="mb-1 font-medium">{statement.period_label}</div>
        {row("Earned", statement.gross_earned)}
        {Number(statement.held_amount) > 0 && row("Held for fraud review", -Number(statement.held_amount))}
        {Number(statement.released_amount) > 0 && row("Released from earlier holds", statement.released_amount)}
        {Number(statement.recouped_amount) > 0 && row("Recouped against advances", -Number(statement.recouped_amount))}
        {row(`TDS (${Number(statement.tds_rate_applied)}%)`, -Number(statement.tds_amount))}
        {row("Paid", statement.net_payable, true)}
        {statement.payment_reference && <div className="mt-1 text-xs text-muted">Payment {statement.payment_reference}</div>}
      </div>
      <Table>
        <thead>
          <tr><th className={th}>Track</th><th className={th}>Role</th><th className={thNum}>Amount</th></tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.line_no}>
              <td className={td}>
                {l.title}
                {l.via_track && <div className="text-xs text-muted">via sample in {l.via_track}</div>}
              </td>
              <td className={`${td} text-muted`}>
                {l.role.replace("_", " ")} · {pct(l.share_pct)}
              </td>
              <td className={tdNum}>
                {inr(l.amount)} {String(l.is_held) === "true" && <StatusBadge status="held" />}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
