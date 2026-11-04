import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, Empty, PageHeader, Pagination, StatusBadge, Table, inputClass, secondaryButtonClass, td, tdNum, th, thNum, withParams } from "@/components/ui";
import { actorOf, requireUser } from "@/lib/auth";
import { num } from "@/lib/format";
import { PAGE_SIZE, listTracks } from "@/lib/services/catalog";

export const metadata: Metadata = { title: "Tracks" };

export default async function TracksPage(props: PageProps<"/tracks">) {
  const user = await requireUser("admin", "staff");
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const filters = { q: one("q"), status: one("status"), genre: one("genre"), language: one("language"), proposals: one("proposals") };
  const data = await listTracks(actorOf(user), {
    ...filters,
    proposals: filters.proposals === "1",
    page: Number(one("page") ?? 1),
  });

  return (
    <>
      <PageHeader
        title="Tracks & splits"
        subtitle="Full-text search on titles (prefix matching, GIN index) or an exact ISRC. Open a track for its split history, sample chain and earnings."
      />
      <Card>
        <form className="mb-4 flex flex-wrap items-end gap-2" action="/tracks">
          <input name="q" defaultValue={filters.q} placeholder="Search title or ISRC… e.g. mons let" className={`${inputClass} w-72`} />
          <select name="status" defaultValue={filters.status ?? ""} className={inputClass}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="retired">Retired</option>
          </select>
          <select name="genre" defaultValue={filters.genre ?? ""} className={inputClass}>
            <option value="">Any genre</option>
            {data.genres.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
          <select name="language" defaultValue={filters.language ?? ""} className={inputClass}>
            <option value="">Any language</option>
            {data.languages.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 px-1 text-sm">
            <input type="checkbox" name="proposals" value="1" defaultChecked={filters.proposals === "1"} />
            Open proposals only
          </label>
          <button className={secondaryButtonClass}>Apply</button>
          {Object.values(filters).some(Boolean) && (
            <Link href="/tracks" className="px-2 text-sm text-muted hover:underline">
              Clear
            </Link>
          )}
        </form>

        {data.rows.length === 0 ? (
          <Empty>No tracks match these filters.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Track</th>
                <th className={th}>Artists</th>
                <th className={th}>Release</th>
                <th className={th}>Genres</th>
                <th className={th}>Status</th>
                <th className={thNum}>Streams (all months)</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((t) => (
                <tr key={t.track_id} className="hover:bg-zinc-50">
                  <td className={td}>
                    <Link href={`/tracks/${t.track_id}`} className="font-medium hover:underline">
                      {t.title}
                    </Link>
                    <div className="font-mono text-xs text-muted">{t.isrc}</div>
                  </td>
                  <td className={td}>{t.artists ?? <span className="text-muted">—</span>}</td>
                  <td className={td}>{t.release_title}</td>
                  <td className={`${td} text-muted`}>{t.genres}</td>
                  <td className={td}>
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge status={t.status} />
                      {t.open_proposal && <Badge tone="info">proposal</Badge>}
                    </div>
                  </td>
                  <td className={tdNum}>{num(t.streams_12m)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination page={data.page} total={data.total} pageSize={PAGE_SIZE} href={(p) => withParams("/tracks", filters, { page: p })} />
      </Card>
    </>
  );
}
