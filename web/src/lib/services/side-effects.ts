import { embedTracks, embedUnmatchedLines } from "../stores/embeddings";
import { syncTrack } from "../stores/graph";
import { invalidate, rebuildLeaderboard } from "../stores/cache";

/**
 * Follow-up work on the secondary stores after Postgres commits. Run with
 * Next's `after()` so the user's request doesn't wait for it. Failures are
 * logged, never surfaced: Postgres already holds the truth, and
 * `npm run stores -- setup` can rebuild every secondary store from it.
 */

// background jobs act as a system staff identity (no app user, not audited)
const SYSTEM_STAFF = { userId: null, role: "staff" } as const;

async function safely(label: string, job: () => Promise<unknown>) {
  try {
    await job();
  } catch (err) {
    console.error(`[side effect] ${label} failed`, err);
  }
}

/** A split version became active: graph edges and the track's embedding text change. */
export async function afterSplitActivated(trackId: number) {
  await safely("neo4j sync", () => syncTrack(trackId));
  await safely("re-embed tracks", () => embedTracks(SYSTEM_STAFF));
}

/** Report data or payouts changed for a period. */
export async function afterPeriodDataChanged(periodId: number | null) {
  if (periodId) await safely("leaderboard", () => rebuildLeaderboard(periodId));
  await safely("cache", () => invalidate("dashboard"));
}

/** New unmatched lines need vectors before they can be matched. */
export async function afterReportLoaded(periodId: number) {
  await safely("embed lines", () => embedUnmatchedLines(SYSTEM_STAFF));
  await afterPeriodDataChanged(periodId);
}
