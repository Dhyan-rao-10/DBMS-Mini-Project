import { HttpError, apiUser, handle, intParam, readJson } from "@/lib/api";
import { actorOf } from "@/lib/auth";
import { proposeSplit, type ShareInput } from "@/lib/services/catalog";

/**
 * POST /api/tracks/:id/splits  { validFrom: "YYYY-MM-DD", shares: [{contributor_id, role, share_pct}] }
 * Proposes a new split version. The database checks the 100% total, the
 * start date and the one-open-proposal rule, and creates the approval rows.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/tracks/[id]/splits">) {
  return handle(async () => {
    const user = await apiUser("admin", "staff");
    const trackId = intParam((await ctx.params).id, "track id");
    const body = await readJson<{ validFrom?: string; shares?: ShareInput[] }>(request);
    if (!body.validFrom || !Array.isArray(body.shares) || body.shares.length === 0) {
      throw new HttpError(422, "Give a start month and at least one share.");
    }
    return proposeSplit(actorOf(user), trackId, body.validFrom, body.shares);
  });
}
