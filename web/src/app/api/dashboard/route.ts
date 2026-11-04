import { apiUser, handle } from "@/lib/api";
import { actorOf } from "@/lib/auth";
import { getDashboard } from "@/lib/services/dashboard";

/** GET /api/dashboard : headline numbers (cached in Redis for 5 minutes). */
export async function GET() {
  return handle(async () => getDashboard(actorOf(await apiUser("admin", "staff"))));
}
