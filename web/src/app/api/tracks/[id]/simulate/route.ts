import { HttpError, apiUser, handle, intParam, readJson } from "@/lib/api";
import type { ShareInput } from "@/lib/services/catalog";
import { simulateSplit } from "@/lib/services/workflow";

/**
 * POST /api/tracks/:id/simulate  { shares: [...] }
 * X2 what-if: runs the real payout for the next unpaid month with the current
 * and the proposed split, inside a transaction that is always rolled back.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/tracks/[id]/simulate">) {
  return handle(async () => {
    const user = await apiUser("admin", "staff", "contributor");
    const trackId = intParam((await ctx.params).id, "track id");
    const { shares } = await readJson<{ shares?: ShareInput[] }>(request);
    if (!Array.isArray(shares) || shares.length === 0) throw new HttpError(422, "Add at least one share.");
    return simulateSplit(user, trackId, shares);
  });
}
