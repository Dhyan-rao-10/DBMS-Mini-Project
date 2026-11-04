import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, Empty, PageHeader, Stat, Table, td, tdNum, th, thNum } from "@/components/ui";
import { actorOf, requireUser } from "@/lib/auth";
import { date, inr, maskPan, pct } from "@/lib/format";
import { getContributor } from "@/lib/services/catalog";
import { collaborators } from "@/lib/stores/graph";

export const metadata: Metadata = { title: "Contributor" };

export default async function ContributorPage(props: PageProps<"/contributors/[id]">) {
  const user = await requireUser("admin", "staff");
  const id = Number((await props.params).id);
  if (!Number.isInteger(id)) notFound();
  const detail = await getContributor(actorOf(user), id);
  if (!detail) notFound();
  const network = await collaborators(id, 8).catch(() => null); // Neo4j is optional for this page

  const { contributor: c, splits, statements, advances, managers } = detail;
  const paid = statements.reduce((s, r) => s + Number(r.net_payable), 0);
  const outstanding = advances.reduce((s, a) => s + Number(a.outstanding), 0);

  return (
    <>
      <PageHeader
        title={c.legal_name}
        subtitle={
          <>
            {c.stage_name && <>Performs as <strong>{c.stage_name}</strong> · </>}
            {c.email} · PAN {maskPan(c.pan)} · TDS {Number(c.effective_tds)}%
            {c.login_email ? " · has a portal login" : ""}
          </>
        }
        actions={<Link href="/contributors" className="text-sm text-muted hover:underline">← All contributors</Link>}
      />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Tracks credited" value={new Set(splits.map((s) => s.track_id)).size} />
        <Stat label="Paid to date" value={inr(paid)} hint={`${statements.length} statements`} />
        <Stat label="Advance outstanding" value={inr(outstanding)} hint={`${advances.length} advances`} />
        <Stat label="Account managers" value={managers.length} hint={managers.map((m) => `${m.full_name} (${m.platform})`).join(", ") || "none"} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Current splits">
          {splits.length ? (
            <Table>
              <thead>
                <tr><th className={th}>Track</th><th className={th}>Role</th><th className={thNum}>Share</th></tr>
              </thead>
              <tbody>
                {splits.map((s) => (
                  <tr key={`${s.track_id}:${s.role}`}>
                    <td className={td}><Link className="hover:underline" href={`/tracks/${s.track_id}`}>{s.title}</Link></td>
                    <td className={`${td} text-muted`}>{String(s.role).replace("_", " ")}</td>
                    <td className={tdNum}>{pct(s.share_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : <Empty>No current splits.</Empty>}
        </Card>

        <Card title="Frequent collaborators" actions={<span className="text-xs text-muted">from Neo4j</span>}>
          {network === null ? (
            <Empty>The graph database isn&apos;t reachable right now.</Empty>
          ) : network.length ? (
            <ul className="text-sm">
              {network.map((n) => (
                <li key={n.name} className="flex justify-between border-t border-border py-1.5 first:border-0">
                  <span>{n.name}</span>
                  <span className="num text-muted">{n.shared_tracks} shared {n.shared_tracks === 1 ? "track" : "tracks"}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>No shared tracks.</Empty>}
        </Card>
      </div>

      <Card title="Statements" className="mt-6">
        {statements.length ? (
          <Table>
            <thead>
              <tr>
                <th className={th}>Month</th>
                <th className={thNum}>Gross</th>
                <th className={thNum}>Held</th>
                <th className={thNum}>Released</th>
                <th className={thNum}>Recouped</th>
                <th className={thNum}>TDS</th>
                <th className={thNum}>Net paid</th>
                <th className={th}>Payment</th>
              </tr>
            </thead>
            <tbody>
              {statements.map((s) => (
                <tr key={s.statement_id}>
                  <td className={td}>{s.period_label}</td>
                  <td className={tdNum}>{inr(s.gross_earned)}</td>
                  <td className={tdNum}>{Number(s.held_amount) ? inr(s.held_amount) : "—"}</td>
                  <td className={tdNum}>{Number(s.released_amount) ? inr(s.released_amount) : "—"}</td>
                  <td className={tdNum}>{Number(s.recouped_amount) ? inr(s.recouped_amount) : "—"}</td>
                  <td className={tdNum}>{inr(s.tds_amount)} <span className="text-xs text-muted">({Number(s.tds_rate_applied)}%)</span></td>
                  <td className={`${tdNum} font-medium`}>{inr(s.net_payable)}</td>
                  <td className={`${td} font-mono text-xs text-muted`}>{s.payment_reference ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <Empty>No statements yet.</Empty>}
      </Card>

      {advances.length > 0 && (
        <Card title="Advances" className="mt-6">
          <Table>
            <thead>
              <tr><th className={th}>Issued</th><th className={th}>Note</th><th className={thNum}>Amount</th><th className={thNum}>Recouped</th><th className={thNum}>Outstanding</th></tr>
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
        </Card>
      )}
    </>
  );
}
