import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, type Session } from "./stores/cache";
import type { Actor } from "./db/pg";

/**
 * Who is signed in. The browser holds only an opaque random token in an
 * HttpOnly cookie; the session itself (user id, role) lives in Redis.
 */

export const SESSION_COOKIE = "royalty_session";

export type Role = Session["role"];
export type CurrentUser = Session;

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getSession(token);
}

/** For pages: sends visitors to /login, and users without the role to their home page. */
export async function requireUser(...roles: Role[]): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (roles.length > 0 && !roles.includes(user.role)) redirect(homeFor(user.role));
  return user;
}

export const homeFor = (role: Role) => (role === "contributor" ? "/me" : "/");

/** The database identity a request runs as (SET LOCAL ROLE + app.user_id). */
export const actorOf = (user: CurrentUser): Actor => ({ userId: user.userId, role: user.role });
