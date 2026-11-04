import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, Empty, PageHeader, Pagination, Table, inputClass, secondaryButtonClass, td, tdNum, th, thNum, withParams } from "@/components/ui";
import { actorOf, requireUser } from "@/lib/auth";
import { inr, num } from "@/lib/format";
import { PAGE_SIZE, listContributors } from "@/lib/services/catalog";

export const metadata: Metadata = { title: "Contributors" };

export default async function ContributorsPage(props: PageProps<"/contributors">) {
  const user = await requireUser("admin", "staff");
  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const page = Number(typeof sp.page === "string" ? sp.page : 1);
  const data = await listContributors(actorOf(user), q, page);

  return (
    <>
      <PageHeader title="Contributors" subtitle="Everyone who earns royalties. Full-text search on legal and stage names, or part of an email." />
      <Card>
        <form className="mb-4 flex gap-2" action="/contributors">
          <input name="q" defaultValue={q} placeholder="Search name or email…" className={`${inputClass} w-72`} />
          <button className={secondaryButtonClass}>Search</button>
          {q && <Link href="/contributors" className="self-center px-2 text-sm text-muted hover:underline">Clear</Link>}
        </form>
        {data.rows.length === 0 ? (
          <Empty>No contributors match.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Contributor</th>
                <th className={th}>Email</th>
                <th className={thNum}>Tracks</th>
                <th className={thNum}>Paid to date</th>
                <th className={thNum}>Advance outstanding</th>
                <th className={th}>TDS</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((c) => (
                <tr key={c.contributor_id} className="hover:bg-zinc-50">
                  <td className={td}>
                    <Link href={`/contributors/${c.contributor_id}`} className="font-medium hover:underline">{c.legal_name}</Link>
                    {c.stage_name && <span className="text-muted"> · {c.stage_name}</span>}
                    {c.has_login && <span className="ml-2"><Badge tone="info">portal</Badge></span>}
                  </td>
                  <td className={`${td} text-muted`}>{c.email}</td>
                  <td className={tdNum}>{num(c.tracks)}</td>
                  <td className={tdNum}>{inr(c.paid_total)}</td>
                  <td className={tdNum}>{Number(c.advance_outstanding) > 0 ? inr(c.advance_outstanding) : "—"}</td>
                  <td className={td}>
                    {Number(c.tds_rate)}%{c.no_pan && <span className="ml-1"><Badge tone="warning">no PAN</Badge></span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination page={data.page} total={data.total} pageSize={PAGE_SIZE} href={(p) => withParams("/contributors", { q }, { page: p })} />
      </Card>
    </>
  );
}
