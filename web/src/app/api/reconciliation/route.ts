import type { NextRequest } from "next/server";
import { HttpError, apiUser, handle } from "@/lib/api";
import { reconcile } from "@/lib/services/intake";

/** GET /api/reconciliation?month=YYYY-MM : declared vs received (MongoDB) vs loaded (Postgres). */
export async function GET(request: NextRequest) {
  return handle(async () => {
    await apiUser("admin", "staff");
    const month = request.nextUrl.searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, "Give month=YYYY-MM.");
    return reconcile(month);
  });
}
