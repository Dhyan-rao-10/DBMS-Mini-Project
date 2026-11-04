import { HttpError, apiUser, handle, intParam, readJson } from "@/lib/api";
import { actorOf } from "@/lib/auth";
import { setUserActive } from "@/lib/services/admin";

/** PATCH /api/users/:id  { active: boolean } : deactivating also ends the user's sessions. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/users/[id]">) {
  return handle(async () => {
    const user = await apiUser("admin");
    const { active } = await readJson<{ active?: boolean }>(request);
    if (typeof active !== "boolean") throw new HttpError(422, "Send active: true or false.");
    return setUserActive(actorOf(user), intParam((await ctx.params).id, "user id"), active);
  });
}
