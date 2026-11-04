import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic check only: no session cookie -> send pages to /login.
 * The real check (session in Redis, role) happens in every page and API route.
 */
export function proxy(request: NextRequest) {
  if (!request.cookies.has("royalty_session")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // everything except the login page, the API (which answers 401 itself) and static files
  matcher: ["/((?!login|api|_next/static|_next/image|favicon.ico).*)"],
};
