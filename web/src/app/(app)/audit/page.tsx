import type { Metadata } from "next";
import Link from "next/link";
import { Card, Empty, PageHeader, Pagination, StatusBadge, Table, td, th, withParams } from "@/components/ui";
import { actorOf, requireUser } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { AUDIT_PAGE_SIZE, listAudit } from "@/lib/services/admin";

export const metadata: Metadata = { title: "Audit log" };

const OP_TONE: Record<string, string> = { INSERT: "approved", UPDATE: "pending", DELETE: "rejected" };

/** Written only by triggers; even app_admin can read it but not edit or delete it. */
export default async function AuditPage(props: PageProps<"/audit">) {
  const user = await requireUser("admin");
  const sp = await props.searchParams;
  const table = typeof sp.table === "string" ? sp.table : undefined;
  const page = Number(typeof sp.page === "string" ? sp.page : 1);
  const data = await listAudit(actorOf(user), table, page);

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every change to ownership, money and access tables, written by AFTER triggers with the old and new row and who made it. Append-only: no role, not even admin, can edit or delete entries."
      />
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        <Link href="/audit" className={`rounded-full px-3 py-1 ${!table ? "bg-accent text-white" : "bg-surface ring-1 ring-border hover:bg-zinc-50"}`}>All</Link>
        {data.tables.map((t) => (
          <Link key={t.table_name} href={`/audit?table=${t.table_name}`} className={`rounded-full px-3 py-1 ${table === t.table_name ? "bg-accent text-white" : "bg-surface ring-1 ring-border hover:bg-zinc-50"}`}>
            {t.table_name} <span className="opacity-70">{t.n}</span>
          </Link>
        ))}
      </div>
      <Card>
        {data.rows.length === 0 ? (
          <Empty>No changes recorded.</Empty>
        ) : (
          <Table>
            <thead>
              <tr><th className={th}>When</th><th className={th}>Who</th><th className={th}>Change</th><th className={th}>What changed</th></tr>
            </thead>
            <tbody>
              {data.rows.map((a) => (
                <tr key={a.audit_id}>
                  <td className={`${td} whitespace-nowrap text-xs`}>{dateTime(a.changed_at)}<div className="text-muted">tx {a.tx_id}</div></td>
                  <td className={td}>{a.changed_by}</td>
                  <td className={td}>
                    <StatusBadge status={OP_TONE[a.operation]} />{" "}
                    <span className="text-xs font-medium">{a.operation}</span>
                    <div className="font-mono text-xs">{a.table_name}</div>
                    <div className="font-mono text-[11px] text-muted">{JSON.stringify(a.row_key)}</div>
                  </td>
                  <td className={`${td} text-xs`}><Diff oldRow={a.old_row} newRow={a.new_row} /></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination page={data.page} total={data.total} pageSize={AUDIT_PAGE_SIZE} href={(p) => withParams("/audit", { table }, { page: p })} />
      </Card>
    </>
  );
}

function Diff({ oldRow, newRow }: { oldRow: Record<string, unknown> | null; newRow: Record<string, unknown> | null }) {
  const keys = [...new Set([...Object.keys(oldRow ?? {}), ...Object.keys(newRow ?? {})])];
  const changed = oldRow && newRow ? keys.filter((k) => JSON.stringify(oldRow[k]) !== JSON.stringify(newRow[k])) : keys;
  const show = (v: unknown) => (v === null || v === undefined ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <div className="flex flex-col gap-0.5 font-mono">
      {changed.slice(0, 8).map((k) => (
        <div key={k}>
          <span className="text-muted">{k}:</span>{" "}
          {oldRow && newRow ? (
            <>
              <span className="text-red-700 line-through">{show(oldRow[k])}</span> → <span className="text-emerald-700">{show(newRow[k])}</span>
            </>
          ) : (
            <span className={newRow ? "text-emerald-700" : "text-red-700"}>{show((newRow ?? oldRow)?.[k])}</span>
          )}
        </div>
      ))}
      {changed.length > 8 && <div className="text-muted">… {changed.length - 8} more fields</div>}
    </div>
  );
}
