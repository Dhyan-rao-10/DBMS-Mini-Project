# MongoDB: raw platform reports

Database `royalty_raw`. The collections, validators, indexes and aggregation pipelines live in code so
the app and the scripts share them:

| What | Where |
|---|---|
| Collections + `$jsonSchema` validators + indexes | `web/src/lib/db/mongo.ts` → `ensureMongoCollections()` |
| Parsing each platform's file format | `web/src/lib/stores/reports.ts` → `parseReportFile()` |
| Normalisation pipeline (`$switch`, `$ifNull`, `$split`/`$reduce`, `$convert`, `$group`) | `reports.ts` → `normalizeLineStages()`, `normalizeReportPipeline()` |
| Load into Postgres, reconciliation | `reports.ts` → `loadReport()`, `reconcilePeriod()` |

`sample_reports/` holds October 2026 reports in each platform's own format, generated from the Postgres
data by `npm run stores -- sample-reports`. They contain deliberate problems for the demo: no ISRC, a
mistyped ISRC, reworded titles, a track the label doesn't own, and a Spotify footer whose totals include
a line missing from the file.

| File | Format |
|---|---|
| `spotify_2026_10.csv` | Flat CSV `isrc,track_name,artist_name,streams,net_revenue_inr` + `TOTAL` footer row |
| `yt_music_2026_10.json` | Nested JSON: `items[].asset.{title,isrc}`, `items[].channel`, `items[].metrics.{views,revenue}`, plus `summary` totals |
| `jiosaavn_2026_10.csv` | CSV `ISRC,Song,Artists,Plays,Amount`, artists joined with `|`, no totals |

Load them (and everything else) with `bash db/setup_all.sh`, or one at a time:

```bash
cd web
npm run stores -- ingest SPOTIFY ../db/mongo/sample_reports/spotify_2026_10.csv 2026-10 riya.spotify@monsoonrecords.test
npm run stores -- reconcile 2026-10
```

Inspect in the shell:

```bash
docker exec -it royalty-mongo mongosh -u royalty_admin -p --authenticationDatabase admin royalty_raw
```

```js
db.reports.find({}, { file_name: 1, status: 1, line_count: 1, declared_totals: 1 })
db.report_lines.findOne({ platform: "YT_MUSIC" })
```
