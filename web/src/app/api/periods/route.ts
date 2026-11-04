import { apiUser, handle } from "@/lib/api";
import { actorOf } from "@/lib/auth";
import { listPeriods, openNextPeriod } from "@/lib/services/payouts";

/** GET /api/periods : every royalty period with its totals. */
export async function GET() {
  return handle(async () => listPeriods(actorOf(await apiUser("admin"))));
}

/** POST /api/periods : open the next calendar month for report uploads. */
export async function POST() {
  return handle(async () => openNextPeriod(actorOf(await apiUser("admin"))));
}
