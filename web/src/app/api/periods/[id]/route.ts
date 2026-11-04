import { after } from "next/server";
import { HttpError, apiUser, handle, intParam, readJson } from "@/lib/api";
import { actorOf } from "@/lib/auth";
import { payPeriod, setPeriodStatus } from "@/lib/services/payouts";
import { afterPeriodDataChanged } from "@/lib/services/side-effects";

/**
 * POST /api/periods/:id  { action: "lock" | "unlock" | "pay" }
 * "pay" calls the process_payout procedure: one transaction that locks the
 * period row, so a second simultaneous click waits and is then refused.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/periods/[id]">) {
  return handle(async () => {
    const user = await apiUser("admin");
    const periodId = intParam((await ctx.params).id, "period id");
    const { action } = await readJson<{ action?: string }>(request);
    switch (action) {
      case "lock":
        return setPeriodStatus(actorOf(user), periodId, "locked");
      case "unlock":
        return setPeriodStatus(actorOf(user), periodId, "open");
      case "pay": {
        const result = await payPeriod(actorOf(user), periodId);
        after(() => afterPeriodDataChanged(periodId));
        return result;
      }
      default:
        throw new HttpError(422, "Unknown action.");
    }
  });
}
