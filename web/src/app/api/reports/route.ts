import { after } from "next/server";
import { HttpError, apiUser, handle } from "@/lib/api";
import { actorOf } from "@/lib/auth";
import { listReports, uploadReport } from "@/lib/services/intake";
import { afterReportLoaded } from "@/lib/services/side-effects";

const MAX_BYTES = 10 * 1024 * 1024;

/** GET /api/reports : the latest uploaded platform reports (from MongoDB). */
export async function GET() {
  return handle(async () => {
    await apiUser("admin", "staff");
    return listReports();
  });
}

/**
 * POST /api/reports  multipart: platform, month (YYYY-MM), file
 * Stores the file's lines untouched in MongoDB, normalises them with an
 * aggregation pipeline and loads them into Postgres in one transaction.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const user = await apiUser("admin", "staff");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new HttpError(422, "Choose a report file.");
    if (file.size > MAX_BYTES) throw new HttpError(413, "Report files can be at most 10 MB.");
    const result = await uploadReport(actorOf(user), {
      platform: String(form.get("platform") ?? ""),
      month: String(form.get("month") ?? ""),
      fileName: file.name,
      text: await file.text(),
    });
    after(() => afterReportLoaded(result.periodId));
    return result;
  });
}
