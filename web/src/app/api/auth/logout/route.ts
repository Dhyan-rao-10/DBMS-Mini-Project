import { cookies } from "next/headers";
import { handle } from "@/lib/api";
import { SESSION_COOKIE } from "@/lib/auth";
import { destroySession } from "@/lib/stores/cache";

/** POST /api/auth/logout: deletes the session from Redis and clears the cookie. */
export async function POST() {
  return handle(async () => {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (token) await destroySession(token);
    jar.delete(SESSION_COOKIE);
    return { redirectTo: "/login" };
  });
}
