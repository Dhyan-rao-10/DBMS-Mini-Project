import type { NextRequest } from "next/server";
import { apiUser, handle, intParam } from "@/lib/api";
import { collaborators, mostSampled, shortestConnection } from "@/lib/stores/graph";

/**
 * GET /api/network?from=&to=   shortest connection between two contributors (Neo4j)
 * GET /api/network?contributor= collaborators of one contributor
 * GET /api/network              most-sampled tracks
 */
export async function GET(request: NextRequest) {
  return handle(async () => {
    await apiUser("admin", "staff");
    const p = request.nextUrl.searchParams;
    if (p.get("from") && p.get("to")) {
      return shortestConnection(intParam(p.get("from"), "from"), intParam(p.get("to"), "to"));
    }
    if (p.get("contributor")) return collaborators(intParam(p.get("contributor"), "contributor"));
    return mostSampled(10);
  });
}
