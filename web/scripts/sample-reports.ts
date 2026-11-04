import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { asReport } from "../src/lib/db/pg";

/**
 * Writes the three October 2026 platform reports in db/mongo/sample_reports/,
 * each in its platform's own format, built from August's real figures (+4%).
 *
 * Deliberate problems, so the demo has something to do:
 *   - lines with no ISRC, a mistyped ISRC or a reworded title  -> unmatched, vector matching (F4)
 *   - one line for a track the label doesn't own               -> written off
 *   - Spotify's footer total includes a line missing from the file -> reconciliation flags it (X1)
 */

interface TrackRow {
  track_id: number;
  isrc: string;
  title: string;
  artists: string[];
  platform: string;
  streams: number;
  paise: number;
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header: string[], rows: (string | number)[][]) =>
  [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
const rupees = (paise: number) => (paise / 100).toFixed(2);

export async function writeSampleReports(outDir: string): Promise<string[]> {
  const { rows } = await asReport((c) =>
    c.query<TrackRow>(
      `SELECT t.track_id, t.isrc, t.title, p.code AS platform,
              -- performers first; tracks with no performer role (Raag Megh) list everyone credited
              coalesce(
                (SELECT array_agg(coalesce(cs.stage_name, cs.legal_name)
                                  ORDER BY cs.role = 'featured_artist', cs.share_pct DESC)
                 FROM v_current_splits cs
                 WHERE cs.track_id = t.track_id AND cs.role IN ('artist', 'featured_artist')),
                (SELECT array_agg(coalesce(cs.stage_name, cs.legal_name) ORDER BY cs.share_pct DESC)
                 FROM v_current_splits cs WHERE cs.track_id = t.track_id)) AS artists,
              round(s.streams * 1.04)::float AS streams,
              round(s.revenue * 1.04 * 100)::float AS paise
       FROM tracks t
       JOIN stream_stats s ON s.track_id = t.track_id
       JOIN royalty_periods rp ON rp.period_id = s.period_id AND rp.period_start = DATE '2026-08-01'
       JOIN platforms p ON p.platform_id = s.platform_id
       WHERE p.code IN ('SPOTIFY', 'YT_MUSIC', 'JIOSAAVN')
         AND t.status = 'active'
         AND (t.isrc LIKE 'INM0R%' OR t.track_id % 7 = 0)
       ORDER BY t.track_id`,
    ),
  );

  const byKey = new Map(rows.map((r) => [`${r.platform}:${r.isrc}`, r]));
  const get = (platform: string, isrc: string) => {
    const r = byKey.get(`${platform}:${isrc}`);
    if (!r) throw new Error(`No August figures for ${isrc} on ${platform}`);
    return r;
  };
  const firstBulk = rows.find((r) => r.isrc.startsWith("INB0K") && r.platform === "SPOTIFY")!;

  // tracks that appear only as a messy line on a platform
  const messy: Record<string, Set<string>> = {
    SPOTIFY: new Set(["INM0R2500009", firstBulk.isrc]),
    YT_MUSIC: new Set(["INM0R2500007", "INM0R2500002", "INM0R2500010"]),
    JIOSAAVN: new Set(["INM0R2500004", "INM0R2500005", "INM0R1900001", "INM0R2500006"]),
  };
  const clean = (platform: string, keep: (r: TrackRow) => boolean) =>
    rows.filter((r) => r.platform === platform && !messy[platform].has(r.isrc) && keep(r));

  await mkdir(outDir, { recursive: true });
  const written: string[] = [];

  // ---------- Spotify: flat CSV with a TOTAL footer ----------
  {
    const lines: (string | number)[][] = clean("SPOTIFY", () => true).map((r) => [
      r.isrc, r.title, r.artists.join(", "), r.streams, rupees(r.paise),
    ]);
    const rc = get("SPOTIFY", "INM0R2500009");
    lines.push(["INM0R25000O9", rc.title, rc.artists.join(", "), rc.streams, rupees(rc.paise)]); // letter O, not zero
    const bk = get("SPOTIFY", firstBulk.isrc);
    lines.push(["", `${bk.title} (Slowed + Reverb)`, bk.artists.join(", "), bk.streams, rupees(bk.paise)]);

    const streams = lines.reduce((n, l) => n + Number(l[3]), 0);
    const paise = lines.reduce((n, l) => n + Math.round(Number(l[4]) * 100), 0);
    // the footer counts one more line than the file contains (a truncated export)
    lines.push(["TOTAL", "", "", streams + 12345, rupees(paise + 104933)]);

    const file = path.join(outDir, "spotify_2026_10.csv");
    await writeFile(file, csv(["isrc", "track_name", "artist_name", "streams", "net_revenue_inr"], lines));
    written.push(file);
  }

  // ---------- YouTube Music: nested JSON with a summary ----------
  {
    const item = (title: string, isrc: string | null, channel: string, views: number, paise: number) => ({
      asset: { title, isrc },
      channel,
      metrics: { views, revenue: Number(rupees(paise)) },
    });
    const items = clean("YT_MUSIC", (r) => r.track_id % 2 === 0 || r.isrc.startsWith("INM0R")).map((r) =>
      item(r.title, r.isrc, `${r.artists[0]} - Topic`, r.streams, r.paise),
    );
    const tn = get("YT_MUSIC", "INM0R2500007");
    items.push(item("Terrace Nights (Official Audio)", null, "Arjun N - Topic", tn.streams, tn.paise));
    const pb = get("YT_MUSIC", "INM0R2500002");
    items.push(item("Paper Boats | Aarav | Monsoon EP", null, "Monsoon Records", pb.streams, pb.paise));
    const cp = get("YT_MUSIC", "INM0R2500010");
    items.push(item("Chai Pe Charcha (Lyric Video)", null, "Meera - Topic", cp.streams, cp.paise));
    items.push(item("Diwali Mashup 2026 (Fan Upload)", null, "DJ Random", 8800, 39600)); // not ours

    const json = {
      report: { content_owner: "Monsoon Records", period: "2026-10", currency: "INR", generated_at: "2026-11-04T06:00:00Z" },
      summary: {
        total_views: items.reduce((n, i) => n + i.metrics.views, 0),
        total_revenue: Number(rupees(items.reduce((n, i) => n + Math.round(i.metrics.revenue * 100), 0))),
      },
      items,
    };
    const file = path.join(outDir, "yt_music_2026_10.json");
    await writeFile(file, JSON.stringify(json, null, 2) + "\n");
    written.push(file);
  }

  // ---------- JioSaavn: CSV, capitalised headers, artists joined with '|', no totals ----------
  {
    const lines: (string | number)[][] = clean("JIOSAAVN", (r) => r.track_id % 3 !== 0 || r.isrc.startsWith("INM0R")).map(
      (r) => [r.isrc, r.title, r.artists.join("|"), r.streams, rupees(r.paise)],
    );
    const add = (isrc: string, song: string, artists: string) => {
      const r = get("JIOSAAVN", isrc);
      lines.push(["", song, artists, r.streams, rupees(r.paise)]);
    };
    add("INM0R2500004", "Monsoon Letters - Lofi Flip", "Kabir Beats|Aarav");
    add("INM0R2500005", 'Neon Chai (From "City Lights")', "ZOYA|RoGu");
    add("INM0R1900001", "Raag Megh Revival", "Leela Krishnan|Vik");
    add("INM0R2500006", "Local Train Dreamz", "Zoya Khan");

    const file = path.join(outDir, "jiosaavn_2026_10.csv");
    await writeFile(file, csv(["ISRC", "Song", "Artists", "Plays", "Amount"], lines));
    written.push(file);
  }

  return written;
}
