import { after } from "next/server";
import { HttpError, apiUser, handle, intParam, readJson } from "@/lib/api";
import { actorOf } from "@/lib/auth";
import { reviewFlags } from "@/lib/services/payouts";
import { afterPeriodDataChanged } from "@/lib/services/side-effects";

/**
 * POST /api/fraud  { trackId, periodStart, status: "cleared" | "confirmed", note }
 * Reviews a track's open flags for a month. Confirming forfeits the held money
 * (trigger); cleared money is released by the next payout run.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const user = await apiUser("admin");
    const body = await readJson<{ trackId?: number; periodStart?: string; status?: string; note?: string }>(request);
    if (body.status !== "cleared" && body.status !== "confirmed") throw new HttpError(422, "Choose clear or confirm.");
    if (!body.periodStart) throw new HttpError(422, "Missing period.");
    const result = await reviewFlags(actorOf(user), intParam(String(body.trackId), "track id"), body.periodStart, body.status, body.note ?? "");
    after(() => afterPeriodDataChanged(null));
    return result;
  });
}
