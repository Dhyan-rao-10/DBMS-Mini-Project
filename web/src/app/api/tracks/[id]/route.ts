import { HttpError, apiUser, handle, intParam } from "@/lib/api";
import { actorOf } from "@/lib/auth";
import { getTrack } from "@/lib/services/catalog";

/** GET /api/tracks/:id : track, split history, sample chain, monthly streams, payouts. */
export async function GET(_request: Request, ctx: RouteContext<"/api/tracks/[id]">) {
  return handle(async () => {
    const user = await apiUser("admin", "staff");
    const detail = await getTrack(actorOf(user), intParam((await ctx.params).id, "track id"));
    if (!detail) throw new HttpError(404, "No such track.");
    return detail;
  });
}
