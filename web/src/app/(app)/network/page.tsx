import type { Metadata } from "next";
import Link from "next/link";
import { Card, Empty, PageHeader, Table, inputClass, secondaryButtonClass, td, tdNum, th, thNum } from "@/components/ui";
import { actorOf, requireUser } from "@/lib/auth";
import { contributorOptions } from "@/lib/services/catalog";
import { mostSampled, shortestConnection } from "@/lib/stores/graph";

export const metadata: Metadata = { title: "Network" };

export default async function NetworkPage(props: PageProps<"/network">) {
  const user = await requireUser("admin", "staff");
  const sp = await props.searchParams;
  const from = Number(typeof sp.from === "string" ? sp.from : 0);
  const to = Number(typeof sp.to === "string" ? sp.to : 0);
  const options = await contributorOptions(actorOf(user));
  // suggested query for the demo data, shown only when both people exist
  const tara = options.find((o) => o.label.startsWith("Tara D'Souza"));
  const leela = options.find((o) => o.label.startsWith("Leela Krishnan"));
  const example = tara && leela ? { from: tara.contributor_id, to: leela.contributor_id } : null;

  const graph = await Promise.all([from && to ? shortestConnection(from, to) : Promise.resolve(null), mostSampled(10)])
    .then(([path, sampled]) => ({ path, sampled, graphError: false }))
    .catch(() => ({ path: null, sampled: [], graphError: true }));
  const { path, sampled, graphError } = graph;

  return (
    <>
      <PageHeader
        title="Collaboration & sample network"
        subtitle="Questions of unknown depth (how are two people connected? what is sampled, directly or indirectly?) answered by Neo4j, a read-only mirror of PostgreSQL."
      />
      {graphError && <Empty>The graph database isn&apos;t reachable. Rebuild it with `npm run stores -- graph`.</Empty>}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="How are two contributors connected?">
          <form action="/network" className="flex flex-wrap items-end gap-2">
            <select name="from" defaultValue={from || ""} className={`${inputClass} w-56`} required>
              <option value="">From…</option>
              {options.map((o) => <option key={o.contributor_id} value={o.contributor_id}>{o.label}</option>)}
            </select>
            <select name="to" defaultValue={to || ""} className={`${inputClass} w-56`} required>
              <option value="">To…</option>
              {options.map((o) => <option key={o.contributor_id} value={o.contributor_id}>{o.label}</option>)}
            </select>
            <button className={secondaryButtonClass}>Find path</button>
          </form>
          <p className="mt-2 text-xs text-muted">
            <code>shortestPath((a)-[:CREDITED_ON|SAMPLES*..10]-(b))</code>, through shared tracks and sample links.
          </p>

          {path && (
            <div className="mt-4">
              {path.length === 0 ? (
                <Empty>No connection within 10 hops.</Empty>
              ) : (
                <>
                  <p className="mb-3 text-sm"><strong>{path[0].hops}</strong> hops:</p>
                  <ol className="flex flex-wrap items-center gap-2 text-sm">
                    {path[0].path.map((n, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <span className={`rounded-full px-3 py-1 ${n.kind === "Track" ? "bg-blue-50 text-blue-900" : "bg-zinc-100 font-medium"}`}>
                          {n.kind === "Track" ? "♪ " : ""}{n.label}
                        </span>
                        {i < path[0].path.length - 1 && <span className="text-muted">—</span>}
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          )}
          {!path && example && (
            <p className="mt-4 text-sm text-muted">
              Try <Link className="underline" href={`/network?from=${example.from}&to=${example.to}`}>Tara D&apos;Souza → Leela Krishnan</Link>: they never worked together, but a chain of samples links them.
            </p>
          )}
        </Card>

        <Card title="Most-sampled tracks" actions={<span className="text-xs text-muted">counting indirect samples</span>}>
          {sampled.length ? (
            <Table>
              <thead>
                <tr><th className={th}>Track</th><th className={thNum}>Sampled by</th><th className={thNum}>Longest chain</th></tr>
              </thead>
              <tbody>
                {sampled.map((s) => (
                  <tr key={s.title}>
                    <td className={td}>{s.title}</td>
                    <td className={tdNum}>{s.sampled_by}</td>
                    <td className={tdNum}>{s.max_depth} hops</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : <Empty>No samples recorded.</Empty>}
          <p className="mt-3 text-xs text-muted"><code>MATCH p = (d:Track)-[:SAMPLES*1..]-&gt;(t:Track)</code>; the same question as the recursive CTE on each track page.</p>
        </Card>
      </div>
    </>
  );
}
