import type { NextRequest } from "next/server";
import { apiUser, handle } from "@/lib/api";
import { actorOf } from "@/lib/auth";
import { listTracks } from "@/lib/services/catalog";

/** GET /api/tracks?q=&status=&genre=&language=&page= : full-text search + filters, 25 per page. */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const user = await apiUser("admin", "staff");
    const p = request.nextUrl.searchParams;
    return listTracks(actorOf(user), {
      q: p.get("q") ?? undefined,
      status: p.get("status") ?? undefined,
      genre: p.get("genre") ?? undefined,
      language: p.get("language") ?? undefined,
      page: Number(p.get("page") ?? 1),
    });
  });
}
