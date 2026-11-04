import type { Metadata } from "next";
import Link from "next/link";
import { MatchActions } from "@/components/forms";
import { Card, Empty, PageHeader, StatusBadge, Table, td, tdNum, th, thNum } from "@/components/ui";
import { actorOf, requireUser } from "@/lib/auth";
import { dateTime, inr, month, num } from "@/lib/format";
import { listUnmatched } from "@/lib/services/intake";

export const metadata: Metadata = { title: "Unmatched lines" };

export default async function UnmatchedPage(props: PageProps<"/unmatched">) {
  const user = await requireUser("admin", "staff");
  const sp = await props.searchParams;
  const view = sp.view === "resolved" ? "resolved" : "unmatched";
  const lines = await listUnmatched(actorOf(user), view);

  return (
    <>
      <PageHeader
        title="Unmatched report lines"
        subtitle="Lines whose ISRC was missing or not in the catalogue. Each is compared with every track by meaning (local sentence embeddings, pgvector cosine similarity, HNSW index). Nothing is assigned until a person confirms it."
        actions={
          <div className="flex gap-3 text-sm">
            <Link href="/unmatched" className={view === "unmatched" ? "font-semibold" : "text-muted hover:underline"}>To match</Link>
            <Link href="/unmatched?view=resolved" className={view === "resolved" ? "font-semibold" : "text-muted hover:underline"}>Resolved</Link>
          </div>
        }
      />
      <Card>
        {lines.length === 0 ? (
          <Empty>{view === "unmatched" ? "Every report line is matched. 🎉" : "Nothing resolved yet."}</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>As reported</th>
                <th className={thNum}>Streams / revenue</th>
                <th className={`${th} w-[28rem]`}>{view === "unmatched" ? "Closest tracks (similarity)" : "Outcome"}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.line_id}>
                  <td className={td}>
                    <div className="font-medium">{l.raw_title}</div>
                    <div className="text-sm text-muted">{l.raw_artist ?? "no artist given"}</div>
                    <div className="mt-1 text-xs text-muted">{l.platform} · {month(l.period_start)} · line #{l.line_id}</div>
                  </td>
                  <td className={tdNum}>
                    {num(l.streams)}
                    <div className="text-xs text-muted">{inr(l.revenue)}</div>
                  </td>
                  <td className={td}>
                    {view === "unmatched" ? (
                      <MatchActions lineId={l.line_id} suggestions={l.suggestions} />
                    ) : (
                      <div className="text-sm">
                        <StatusBadge status={l.status} /> {l.matched_title && <>→ {l.matched_title}</>}
                        <div className="text-xs text-muted">{l.matched_by} · {dateTime(l.matched_at)}</div>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="mt-4 text-xs text-muted">
          ≥ 0.85 likely · 0.60–0.85 possible · below 0.60 weak (probably not our track; write it off). Confirming moves the line&apos;s streams and revenue onto
          the track in the same transaction.
        </p>
      </Card>
    </>
  );
}
