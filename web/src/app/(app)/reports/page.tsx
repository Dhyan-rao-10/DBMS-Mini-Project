import type { Metadata } from "next";
import Link from "next/link";
import { UploadForm } from "@/components/forms";
import { Card, Empty, PageHeader, StatusBadge, Table, td, tdNum, th, thNum } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { dateTime, inr, num } from "@/lib/format";
import { UPLOAD_PLATFORMS, listReports, reconcile, reportMonths } from "@/lib/services/intake";
import { listPeriods } from "@/lib/services/payouts";

export const metadata: Metadata = { title: "Reports & reconciliation" };

export default async function ReportsPage(props: PageProps<"/reports">) {
  const user = await requireUser("admin", "staff");
  const sp = await props.searchParams;
  const [reports, months, periods] = await Promise.all([
    listReports(),
    reportMonths(),
    listPeriods({ userId: user.userId, role: "report" }),
  ]);
  const month = typeof sp.month === "string" ? sp.month : months[0];
  const recon = month ? await reconcile(month) : [];
  const openMonths = periods.filter((p) => p.status === "open").map((p) => p.period_start.slice(0, 7)).sort();

  return (
    <>
      <PageHeader
        title="Platform reports"
        subtitle="Each platform sends its own format. Files are stored line-by-line, exactly as received, in MongoDB; an aggregation pipeline normalises them and one PostgreSQL transaction loads them."
      />

      <Card title="Upload a report" className="mb-6">
        {openMonths.length ? (
          <UploadForm platforms={UPLOAD_PLATFORMS} months={openMonths} />
        ) : (
          <Empty>No month is open for reports. An admin opens the next month on the Payouts page.</Empty>
        )}
        <p className="mt-3 text-xs text-muted">Sample files for October 2026 are in <code>db/mongo/sample_reports/</code>.</p>
      </Card>

      <Card
        title={`Reconciliation${month ? ` · ${month}` : ""}`}
        actions={
          months.length > 1 && (
            <div className="flex gap-2 text-sm">
              {months.map((m) => (
                <Link key={m} href={`/reports?month=${m}`} className={m === month ? "font-semibold" : "text-muted hover:underline"}>{m}</Link>
              ))}
            </div>
          )
        }
        className="mb-6"
      >
        <p className="-mt-2 mb-3 text-sm text-muted">
          <strong>Declared</strong>: the platform&apos;s own totals in the file. <strong>Received</strong>: what the lines in MongoDB add up to.{" "}
          <strong>Loaded</strong>: what reached PostgreSQL. PostgreSQL finds platforms that didn&apos;t load fully with an <code>EXCEPT</code>.
        </p>
        {recon.length === 0 ? (
          <Empty>No loaded reports for this month.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Platform</th>
                <th className={thNum}>Declared</th>
                <th className={thNum}>Received</th>
                <th className={thNum}>Loaded</th>
                <th className={th}>Result</th>
              </tr>
            </thead>
            <tbody>
              {recon.map((r) => (
                <tr key={r.platform}>
                  <td className={`${td} font-medium`}>{r.platform}</td>
                  <td className={tdNum}>{r.declared_streams ? <>{num(r.declared_streams)}<div className="text-xs text-muted">{inr(r.declared_revenue)}</div></> : <span className="text-muted">not provided</span>}</td>
                  <td className={tdNum}>{num(r.received_streams)}<div className="text-xs text-muted">{inr(r.received_revenue)}</div></td>
                  <td className={tdNum}>{num(r.loaded_streams)}<div className="text-xs text-muted">{inr(r.loaded_revenue)}</div></td>
                  <td className={td}>
                    <StatusBadge status={r.status} />
                    {r.status === "declared_vs_received" && (
                      <div className="mt-1 text-xs text-muted">
                        The file is short by {num(Number(r.declared_streams) - Number(r.received_streams))} streams; ask the platform for the full export.
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Uploaded files">
        {reports.length === 0 ? (
          <Empty>No reports uploaded yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr><th className={th}>File</th><th className={th}>Platform</th><th className={th}>Month</th><th className={thNum}>Lines</th><th className={thNum}>Tracks / unmatched</th><th className={th}>Uploaded</th><th className={th}>Status</th></tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td className={td}><span className="font-mono text-xs">{r.fileName}</span><div className="font-mono text-[10px] text-muted">{r.id}</div></td>
                  <td className={td}>{r.platform}</td>
                  <td className={td}>{r.month}</td>
                  <td className={tdNum}>{num(r.lines)}</td>
                  <td className={tdNum}>{r.matched !== null ? `${num(r.matched)} / ${num(r.unmatched)}` : "—"}</td>
                  <td className={td}>{r.uploadedBy}<div className="text-xs text-muted">{dateTime(r.uploadedAt)}</div></td>
                  <td className={td}><StatusBadge status={r.status} />{r.error && <div className="mt-1 max-w-xs text-xs text-red-700">{r.error}</div>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
