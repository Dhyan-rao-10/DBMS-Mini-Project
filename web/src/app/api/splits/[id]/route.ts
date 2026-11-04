import { after } from "next/server";
import { HttpError, apiUser, handle, intParam } from "@/lib/api";
import { actorOf } from "@/lib/auth";
import { withdrawProposal } from "@/lib/services/catalog";
import { afterPeriodDataChanged } from "@/lib/services/side-effects";

/** DELETE /api/splits/:id : withdraw a proposal (only proposals can be deleted; trigger R4). */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/splits/[id]">) {
  return handle(async () => {
    const user = await apiUser("admin", "staff");
    const result = await withdrawProposal(actorOf(user), intParam((await ctx.params).id, "version id"));
    if (result.deleted === 0) throw new HttpError(409, "Only an open proposal can be withdrawn.");
    after(() => afterPeriodDataChanged(null));
    return result;
  });
}
