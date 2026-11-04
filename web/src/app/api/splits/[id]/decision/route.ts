import { after } from "next/server";
import { HttpError, apiUser, handle, intParam, readJson } from "@/lib/api";
import { actorOf } from "@/lib/auth";
import { afterPeriodDataChanged, afterSplitActivated } from "@/lib/services/side-effects";
import { decideSplit } from "@/lib/services/workflow";

/**
 * POST /api/splits/:id/decision  { decision: "approved" | "rejected" }
 * The signed-in contributor's decision. The last approval activates the version
 * (trigger R3); then Neo4j and the track's embedding are refreshed in the background.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/splits/[id]/decision">) {
  return handle(async () => {
    const user = await apiUser("contributor");
    const { decision } = await readJson<{ decision?: string }>(request);
    if (decision !== "approved" && decision !== "rejected") throw new HttpError(422, "Decision must be approved or rejected.");
    const result = await decideSplit(actorOf(user), intParam((await ctx.params).id, "version id"), decision);
    if (result.status === "active" && result.trackId) {
      const trackId = result.trackId;
      after(async () => {
        await afterSplitActivated(trackId);
        await afterPeriodDataChanged(null);
      });
    }
    return result;
  });
}
