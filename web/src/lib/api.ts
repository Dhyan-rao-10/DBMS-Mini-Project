import { getCurrentUser, type CurrentUser, type Role } from "./auth";

/**
 * Helpers for Route Handlers (the app's API layer).
 *
 * Business rules live in the database, so most "validation errors" are
 * Postgres errors raised by a CHECK, a key or a trigger. They are passed
 * to the client with their message, mapped by SQLSTATE:
 *   23xxx integrity violation   -> 422      55000 wrong lifecycle state -> 409
 *   42501 insufficient privilege -> 403     P0002 not found             -> 404
 */

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function apiUser(...roles: Role[]): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new HttpError(401, "Please sign in again.");
  if (roles.length > 0 && !roles.includes(user.role)) throw new HttpError(403, "You don't have access to this.");
  return user;
}

interface PgError {
  code?: string;
  message: string;
  constraint?: string;
  detail?: string;
}

const STATUS_BY_SQLSTATE: Record<string, number> = {
  "23502": 422, // not null
  "23503": 422, // foreign key
  "23505": 422, // unique
  "23514": 422, // check / business rule
  "22023": 422, // invalid parameter
  "22P02": 422, // invalid text representation
  "55000": 409, // object not in prerequisite state
  "55P03": 409, // lock not available
  "42501": 403, // insufficient privilege
  P0002: 404,
};

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  const pg = err as PgError;
  if (pg?.code && STATUS_BY_SQLSTATE[pg.code]) {
    return Response.json(
      { error: pg.message, code: pg.code, constraint: pg.constraint ?? null },
      { status: STATUS_BY_SQLSTATE[pg.code] },
    );
  }
  console.error(err);
  return Response.json({ error: "Something went wrong on the server." }, { status: 500 });
}

/** Wraps a handler body: JSON result on success, mapped error otherwise. */
export async function handle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    const data = await fn();
    return data instanceof Response ? data : Response.json(data ?? { ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

export function intParam(value: string | null | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}.`);
  return n;
}
