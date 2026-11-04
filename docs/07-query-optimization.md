# 7. Query processing and optimization

How PostgreSQL executes our heaviest queries, and what each secondary index changes. All plans come from
`db/postgres/explain_compare.sql`, which runs each query with its index and then, inside
`BEGIN … ROLLBACK`, without it (`DROP INDEX` is transactional in PostgreSQL, so the index is back
afterwards). Timings are from a laptop with warm caches, so compare them with each other, not as
absolutes. The *buffers* count (8 KB pages touched) is the steadier measure.

## 7.1 How a query is processed

1. **Parse** the SQL into a parse tree, then **analyze** it (resolve names and types).
2. **Rewrite**: views are expanded into their defining queries (so `v_my_statements` becomes a join over
   `statements`, `payments`, …).
3. **Plan / optimize**: the planner enumerates access paths (sequential scan, index scan, index-only
   scan, bitmap scan) and join methods (nested loop, hash join, merge join), estimates each one's cost from
   table statistics (`ANALYZE`), and picks the cheapest.
4. **Execute** the plan tree, pulling rows up from the leaves.

`EXPLAIN` shows step 3's choice with estimated costs; `EXPLAIN ANALYZE` also runs it and reports actual
rows and time; `BUFFERS` adds pages read.

## 7.2 Results

| Query | Table size | Without the index | With it | Speed-up |
|---|---|---|---|---|
| Q1 one track's monthly history | `stream_stats` 2,09,940 rows | Parallel Seq Scan, 1,545 buffers, 21.3 ms | **Index Only Scan**, 5 buffers, 0 heap fetches, 0.30 ms | ≈ 70× |
| Q2 statement lines for one split version | `statement_lines` 1,15,617 rows | Seq Scan, 983 buffers, 9.3 ms | Bitmap Index Scan, 46 buffers, 2.0 ms | ≈ 4.6× |
| Q3 full-text prefix search on titles | `tracks` 3,500 rows | Seq Scan, 128 buffers, 1.0 ms | GIN Bitmap Index Scan, 7 buffers, 0.06 ms | ≈ 17× |
| Q4 top 10 earners across 11 months | `statements` 4,532 rows | — | Seq Scan + Hash Join + HashAggregate + top-N heapsort, 3.2 ms | (no index helps) |

### Q1: why the primary key doesn't help, and why the new index is "covering"

```sql
SELECT rp.period_start, sum(s.streams), sum(s.revenue)
FROM stream_stats s JOIN royalty_periods rp USING (period_id)
WHERE s.track_id = $1
GROUP BY rp.period_start ORDER BY rp.period_start;
```

`stream_stats`' primary key is `(period_id, platform_id, track_id)`. A B-tree can only be searched by a
**leading** prefix of its columns, and `track_id` is last, so the PK is useless here. Without another index
the planner reads every page (1,545 buffers, two parallel workers each discarding about 1,05,000 rows).

`ix_stream_stats_track_period ON stream_stats (track_id, period_id) INCLUDE (streams, revenue)` leads
with `track_id`, and the `INCLUDE` columns make it **covering**: everything the query needs is in the
index. After `VACUUM` marks pages all-visible, Postgres answers from the index alone:

```
->  Index Only Scan using ix_stream_stats_track_period on stream_stats s
      Index Cond: (track_id = 1246)
      Heap Fetches: 0
      Buffers: shared hit=5
```

The join to the 12-row `royalty_periods` is a **hash join**: the small side is hashed, and the 60 index
rows probe it. The fraud-detection window functions and every track page use this same access path.

### Q2: index on a foreign key

PostgreSQL indexes primary and unique keys automatically, but **not foreign keys**. Without
`ix_statement_lines_version`, finding the 44 lines of one version scans all 1,15,617. With it, a bitmap
index scan finds their row locations first, then reads only those heap pages. `08_indexes.sql` adds an
index for each foreign key that is used in joins.

### Q3: GIN index for full-text search

`tracks.search_vector` is a generated `tsvector`. A GIN (generalized inverted) index maps each lexeme to
the rows containing it, so `search_vector @@ to_tsquery('monsoon:* & letter:*')` looks up two posting lists
instead of evaluating the match on every row.

### Q4: when *not* to use an index

The top-earners query (JOIN + GROUP BY + HAVING + ORDER BY + LIMIT) needs every statement in 11 of 12
periods, about 100% of the table. An index scan would add random I/O for no gain, so the planner correctly
picks a **sequential scan**, builds a hash table on `contributors` for a **hash join**, aggregates with
**HashAggregate** (with `HAVING` applied as a filter on the groups), and uses a **top-N heapsort** that
keeps only 10 rows in memory instead of sorting all 127 groups.

## 7.3 Other indexes and why

| Index | Type | Why |
|---|---|---|
| `uq_split_versions_one_active` | **partial unique** B-tree `(track_id) WHERE status = 'active'` | A *constraint*: at most one active version per track, checked by the index |
| `ix_split_approvals_contributor` | partial `WHERE decision = 'pending'` | The "waiting for you" list only ever looks at pending rows; the index stays tiny |
| `ix_held_earnings_open` | partial `WHERE status = 'held'` | The payout only looks for money still held |
| `ix_contributors_search` | GIN | Full-text search on contributor names |
| `ix_track_embeddings_hnsw` | HNSW (`vector_cosine_ops`) | Approximate nearest-neighbour search for F4 vector matching |
| `ix_audit_log_table_time`, `ix_audit_log_tx` | B-tree | Audit page filters by table and time, and groups by transaction |

**Cost of indexes.** Every index slows `INSERT`/`UPDATE` slightly and uses disk, so we add one only where a
real query needs it. `stream_stats` is written once per monthly report load and read on every page view,
which makes the trade worth it.
