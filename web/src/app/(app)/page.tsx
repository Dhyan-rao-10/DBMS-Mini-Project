import Link from "next/link";
import { StackedBars } from "@/components/StackedBars";
import { Card, PageHeader, Stat, StatusBadge, Table, td, tdNum, th, thNum } from "@/components/ui";
import { actorOf, requireUser } from "@/lib/auth";
import { inr, inrCompact, month, num } from "@/lib/format";
import { getDashboard } from "@/lib/services/dashboard";

export default async function DashboardPage() {
  const user = await requireUser("admin", "staff");
  const d = await getDashboard(actorOf(user));

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={
          <>
            Figures computed in PostgreSQL and cached in Redis for 5 minutes (as of{" "}
            {new Date(d.generatedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}).
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label={d.latestPaid ? `Revenue · ${month(d.latestPaid.period_start)}` : "Revenue"}
          value={inrCompact(d.latestPaid?.revenue)}
          hint="Latest paid month"
        />
        <Stat label="Paid to contributors" value={inrCompact(d.latestPaid?.net_paid)} hint={`${num(d.latestPaid?.statements)} statements, after TDS & recoupment`} />
        <Stat
          label={d.nextToPay ? `Next to pay · ${month(d.nextToPay.period_start)}` : "Next to pay"}
          value={inrCompact(d.nextToPay?.revenue)}
          hint={d.nextToPay ? <StatusBadge status={d.nextToPay.status} /> : "Nothing pending"}
        />
        <Stat label="Catalogue" value={num(d.counts.tracks)} hint={`active tracks · ${num(d.counts.contributors)} contributors`} />
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Link href="/tracks?proposals=1" className="rounded-xl border border-border bg-surface p-4 hover:border-accent">
          <div className="num text-2xl font-semibold">{num(d.counts.open_proposals)}</div>
          <div className="text-sm text-muted">split proposals waiting for approval</div>
        </Link>
        <Link href="/fraud" className="rounded-xl border border-border bg-surface p-4 hover:border-accent">
          <div className="num text-2xl font-semibold">{num(d.counts.open_flags)}</div>
          <div className="text-sm text-muted">open fraud flags (earnings held)</div>
        </Link>
        <Link href="/unmatched" className="rounded-xl border border-border bg-surface p-4 hover:border-accent">
          <div className="num text-2xl font-semibold">{num(d.counts.unmatched)}</div>
          <div className="text-sm text-muted">report lines waiting for a track match</div>
        </Link>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Streaming revenue by platform" className="xl:col-span-2">
          <StackedBars
            label="Monthly streaming revenue by platform"
            data={d.monthly.map((m) => ({ x: month(m.period_start), series: m.platform, value: Number(m.revenue) }))}
            unit="inr"
          />
        </Card>
        <Card title={d.topPeriod ? `Top tracks · ${month(d.topPeriod)}` : "Top tracks"}>
          <p className="-mt-2 mb-3 text-xs text-muted">From a Redis sorted set (ZREVRANGE).</p>
          <Table>
            <thead>
              <tr>
                <th className={th}>#</th>
                <th className={th}>Track</th>
                <th className={thNum}>Streams</th>
              </tr>
            </thead>
            <tbody>
              {d.top.map((t, i) => (
                <tr key={t.trackId}>
                  <td className={`${td} text-muted`}>{i + 1}</td>
                  <td className={td}>
                    <Link className="hover:underline" href={`/tracks/${t.trackId}`}>{t.title}</Link>
                  </td>
                  <td className={tdNum}>{num(t.streams)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      {d.latestPaid && (
        <p className="mt-6 text-xs text-muted">
          {month(d.latestPaid.period_start)}: {inr(d.latestPaid.recouped)} recouped against advances, {inr(d.latestPaid.tds)} TDS withheld,{" "}
          {inr(d.latestPaid.held)} held for fraud review.
        </p>
      )}
    </>
  );
}
