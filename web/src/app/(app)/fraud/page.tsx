import type { Metadata } from "next";
import Link from "next/link";
import { FlagReview } from "@/components/forms";
import { Badge, Card, Empty, PageHeader, StatusBadge } from "@/components/ui";
import { actorOf, requireUser } from "@/lib/auth";
import { dateTime, inr, month } from "@/lib/format";
import { listFlags, type FlagRow } from "@/lib/services/payouts";

export const metadata: Metadata = { title: "Fraud review" };

export default async function FraudPage(props: PageProps<"/fraud">) {
  const user = await requireUser("admin");
  const sp = await props.searchParams;
  const view = sp.view === "reviewed" ? "reviewed" : "open";
  const flags = await listFlags(actorOf(user), view);

  // one card per track per month (a spike usually trips both rules)
  const groups = new Map<string, FlagRow[]>();
  for (const f of flags) {
    const key = `${f.track_id}:${f.period_start}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }

  return (
    <>
      <PageHeader
        title="Fraud review"
        subtitle="Raised by window functions over each track's own history: a stream spike (z-score above 4 and more than double last month) or one platform suddenly taking most of the streams. Earnings from flagged tracks are held at payout until reviewed."
        actions={
          <div className="flex gap-3 text-sm">
            <Link href="/fraud" className={view === "open" ? "font-semibold" : "text-muted hover:underline"}>Open</Link>
            <Link href="/fraud?view=reviewed" className={view === "reviewed" ? "font-semibold" : "text-muted hover:underline"}>Reviewed</Link>
          </div>
        }
      />
      {groups.size === 0 ? (
        <Empty>{view === "open" ? "No open flags." : "No reviewed flags yet."}</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {[...groups.values()].map((fs) => {
            const f = fs[0];
            return (
              <Card
                key={`${f.track_id}:${f.period_start}`}
                title={<Link href={`/tracks/${f.track_id}`} className="hover:underline">{f.title}</Link>}
                actions={<span className="text-sm text-muted">{month(f.period_start)}</span>}
              >
                <ul className="mb-3 flex flex-col gap-1 text-sm">
                  {fs.map((x) => (
                    <li key={x.flag_id} className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={x.status} />
                      {x.rule === "stream_spike" ? (
                        <span>Stream spike: <strong className="num">{Number(x.observed_value).toFixed(1)}</strong> standard deviations above its history (threshold {Number(x.threshold_value)})</span>
                      ) : (
                        <span><Badge>{x.platform}</Badge> took <strong className="num">{(Number(x.observed_value) * 100).toFixed(1)}%</strong> of the track&apos;s streams (threshold {Number(x.threshold_value) * 100}%)</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mb-3 text-sm text-muted">
                  {fs.some((x) => x.held) ? <>Held: <strong className="text-foreground">{inr(fs.reduce((s, x) => s + Number(x.held ?? 0), 0))}</strong> ({fs.map((x) => x.held_status).filter(Boolean).join(", ")})</> : "Nothing held yet. Money is held when the month is paid."}
                </p>
                {view === "open" ? (
                  <FlagReview trackId={f.track_id} periodStart={f.period_start} />
                ) : (
                  <p className="text-sm"><em>&ldquo;{f.note}&rdquo;</em> <span className="text-muted">— {f.reviewed_by}, {dateTime(f.reviewed_at)}</span></p>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
