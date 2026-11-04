import { after } from "next/server";
import { HttpError, apiUser, handle, intParam, readJson } from "@/lib/api";
import { actorOf } from "@/lib/auth";
import { confirmLine, writeOffLine } from "@/lib/services/intake";
import { afterPeriodDataChanged } from "@/lib/services/side-effects";

/**
 * POST /api/unmatched/:id  { action: "confirm", trackId } | { action: "write_off" }
 * Confirming moves the line's streams and revenue onto the track in the same
 * transaction (confirm_unmatched_line).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/unmatched/[id]">) {
  return handle(async () => {
    const user = await apiUser("admin", "staff");
    const lineId = intParam((await ctx.params).id, "line id");
    const body = await readJson<{ action?: string; trackId?: number }>(request);
    if (body.action === "confirm") {
      const result = await confirmLine(actorOf(user), lineId, intParam(String(body.trackId), "track id"));
      after(() => afterPeriodDataChanged(result.periodId));
      return result;
    }
    if (body.action === "write_off") return writeOffLine(actorOf(user), lineId);
    throw new HttpError(422, "Unknown action.");
  });
}
