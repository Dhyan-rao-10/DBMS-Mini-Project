import { cookies } from "next/headers";
import { HttpError, handle, readJson } from "@/lib/api";
import { SESSION_COOKIE, homeFor } from "@/lib/auth";
import { withTx } from "@/lib/db/pg";
import {
  LOGIN_MAX_FAILURES,
  SESSION_TTL_SECONDS,
  clearLoginFailures,
  createSession,
  loginBlockedFor,
  recordLoginFailure,
} from "@/lib/stores/cache";

/**
 * POST /api/auth/login  { email, password }
 * The password is checked inside Postgres by authenticate() (the hash never
 * reaches this process). Failed attempts are counted in Redis; five in 15
 * minutes lock the address out. On success a random session token goes into
 * an HttpOnly cookie and the session itself into Redis.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const { email, password } = await readJson<{ email?: string; password?: string }>(request);
    if (!email?.trim() || !password) throw new HttpError(422, "Enter your email and password.");
    const normalized = email.trim().toLowerCase();

    const blockedFor = await loginBlockedFor(normalized);
    if (blockedFor > 0) {
      throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(blockedFor / 60)} minutes.`);
    }

    const { rows } = await withTx({ userId: null, role: "login" }, (c) =>
      c.query<{ user_id: number; role: "admin" | "staff" | "contributor"; contributor_id: number | null; full_name: string }>(
        "SELECT * FROM authenticate($1, $2)",
        [normalized, password],
      ),
    );
    if (rows.length === 0) {
      const failures = await recordLoginFailure(normalized);
      const left = LOGIN_MAX_FAILURES - failures;
      throw new HttpError(401, left > 0 ? `Wrong email or password (${left} attempts left).` : "Too many failed attempts. Try again in 15 minutes.");
    }

    await clearLoginFailures(normalized);
    const user = rows[0];
    const token = await createSession({
      userId: user.user_id,
      role: user.role,
      contributorId: user.contributor_id,
      name: user.full_name,
    });
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return { redirectTo: homeFor(user.role) };
  });
}
