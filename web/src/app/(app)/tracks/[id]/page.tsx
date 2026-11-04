import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/client";
import { SplitEditor } from "@/components/SplitEditor";
import { StackedBars } from "@/components/StackedBars";
import { Badge, Card, Empty, PageHeader, StatusBadge, Table, td, tdNum, th, thNum } from "@/components/ui";
import { actorOf, requireUser } from "@/lib/auth";
import { date, dateTime, inr, month, pct } from "@/lib/format";
import { contributorOptions, earliestSplitStart, getTrack } from "@/lib/services/catalog";

export const metadata: Metadata = { title: "Track" };

export default async function TrackPage(props: PageProps<"/tracks/[id]">) {
  const user = await requireUser("admin", "staff");
  const actor = actorOf(user);
  const trackId = Number((await props.params).id);
  if (!Number.isInteger(trackId)) notFound();
  const detail = await getTrack(actor, trackId);
  if (!detail) notFound();
  const [contributors, earliest] = await Promise.all([contributorOptions(actor), earliestSplitStart(actor)]);

  const { track, versions, upstream, sampledBy, monthly, flags, paid } = detail;
  const active = versions.find((v) => v.status === "active");
  const proposal = versions.find((v) => v.status === "proposed");

  return (
    <>
      <PageHeader
        title={track.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{track.isrc}</span>·<span>{track.release_title} ({track.release_type}, {date(track.release_date)})</span>·
            <span>{track.language}</span>·<span>{track.genres}</span>
            <StatusBadge status={track.status} />
          </span>
        }
        actions={
          <Link href="/tracks" className="text-sm text-muted hover:underline">
            ← All tracks
          </Link>
        }
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Current split" actions={active && <span className="text-xs text-muted">in force since {date(active.valid_from)}</span>}>
          {active ? (
            <SharesTable shares={active.shares} />
          ) : (
            <Empty>No approved split yet, so this track can&apos;t earn or be activated (rule R6).</Empty>
          )}
          {proposal && (
            <div className="mt-5 rounded-lg border border-blue-200 bg-blue-50/50 p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">
                  Proposed split from {date(proposal.valid_from)} <span className="font-normal text-muted">by {proposal.proposed_by}</span>
                </div>
                <ActionButton url={`/api/splits/${proposal.version_id}`} method="DELETE" variant="secondary" confirm="Withdraw this proposal?">
                  Withdraw
                </ActionButton>
              </div>
              <SharesTable shares={proposal.shares} />
              <div className="mt-3 flex flex-wrap gap-2 text-sm">
                {proposal.approvals.map((a) => (
                  <span key={a.contributor_id} className="inline-flex items-center gap-1.5">
                    {a.name} <StatusBadge status={a.decision} />
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">Goes live automatically when the last contributor approves (trigger R3).</p>
            </div>
          )}
        </Card>

        <Card title="Change the split">
          <p className="-mt-2 mb-4 text-sm text-muted">
            Start from the current split, adjust it, and simulate what the next payout would look like before proposing it.
          </p>
          <SplitEditor
            trackId={trackId}
            contributors={contributors}
            initial={(active?.shares ?? []).map((s) => ({ contributor_id: s.contributor_id, role: s.role, share_pct: s.share_pct }))}
            earliestMonth={earliest.slice(0, 7)}
            canPropose={!proposal}
          />
          {proposal && <p className="mt-3 text-xs text-muted">A proposal is already open; withdraw it to propose a different one.</p>}
        </Card>
      </div>

      <Card title="Streams per month" className="mt-6">
        {monthly.length ? (
          <StackedBars
            unit="count"
            label="Streams per month by platform"
            data={monthly.map((m) => ({ x: month(m.period_start), series: m.platform, value: Number(m.streams) }))}
          />
        ) : (
          <Empty>No streams reported yet.</Empty>
        )}
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card title="Sample chain">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">This track pays upstream to</h3>
          {upstream.length ? (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Track</th>
                  <th className={th}>Hops</th>
                  <th className={thNum}>Share passed up</th>
                </tr>
              </thead>
              <tbody>
                {upstream.map((u) => (
                  <tr key={u.track_id}>
                    <td className={td}>
                      <Link className="hover:underline" href={`/tracks/${u.track_id}`}>{u.title}</Link>
                      {u.hops > 1 && <div className="text-xs text-muted">through {u.via}</div>}
                    </td>
                    <td className={td}>{u.hops}</td>
                    <td className={tdNum}>{pct(u.upstream_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="text-sm text-muted">Doesn&apos;t sample anything.</p>
          )}
          <h3 className="mb-2 mt-5 text-xs font-medium uppercase tracking-wide text-muted">Sampled by</h3>
          {sampledBy.length ? (
            <ul className="text-sm">
              {sampledBy.map((s) => (
                <li key={s.track_id}>
                  <Link className="hover:underline" href={`/tracks/${s.track_id}`}>{s.title}</Link>{" "}
                  <span className="text-muted">owes {pct(s.upstream_pct)} of its revenue here (cleared {date(s.cleared_on)})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Not sampled by any track.</p>
          )}
        </Card>

        <Card title="Paid out through this track">
          {paid.length ? (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Month</th>
                  <th className={thNum}>Own streams</th>
                  <th className={thNum}>Via samples</th>
                </tr>
              </thead>
              <tbody>
                {paid.map((p) => (
                  <tr key={p.period_start}>
                    <td className={td}>{month(p.period_start)}</td>
                    <td className={tdNum}>{inr(p.direct)}</td>
                    <td className={tdNum}>{p.via_samples ? inr(p.via_samples) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <Empty>Nothing paid yet.</Empty>
          )}
        </Card>
      </div>

      <Card title="Split history" className="mt-6">
        <Table>
          <thead>
            <tr>
              <th className={th}>Version</th>
              <th className={th}>Valid</th>
              <th className={th}>Shares</th>
              <th className={th}>Proposed by</th>
              <th className={th}>Activated</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version_id}>
                <td className={td}>
                  #{v.version_id} <StatusBadge status={v.status} />
                </td>
                <td className={`${td} whitespace-nowrap`}>
                  {date(v.valid_from)} → {v.valid_to ? date(v.valid_to) : "open"}
                </td>
                <td className={td}>{v.shares.map((s) => `${s.name} (${s.role.replace("_", " ")}) ${pct(s.share_pct)}`).join(", ")}</td>
                <td className={td}>{v.proposed_by}</td>
                <td className={td}>{dateTime(v.activated_at)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {flags.length > 0 && (
        <Card title="Fraud flags" className="mt-6">
          <div className="flex flex-wrap gap-2">
            {flags.map((f) => (
              <Link key={f.flag_id} href="/fraud" className="inline-flex items-center gap-2 rounded-md border border-border px-2 py-1 text-sm hover:bg-zinc-50">
                {month(f.period_start)} · {String(f.rule).replace("_", " ")}
                {f.platform && <Badge>{f.platform}</Badge>}
                <StatusBadge status={f.status} />
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

function SharesTable({ shares }: { shares: { contributor_id: number; name: string; role: string; share_pct: string }[] }) {
  return (
    <Table>
      <tbody>
        {shares.map((s) => (
          <tr key={`${s.contributor_id}:${s.role}`}>
            <td className={td}>
              <Link className="hover:underline" href={`/contributors/${s.contributor_id}`}>{s.name}</Link>
            </td>
            <td className={`${td} text-muted`}>{s.role.replace("_", " ")}</td>
            <td className={`${tdNum} font-medium`}>{pct(s.share_pct)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
