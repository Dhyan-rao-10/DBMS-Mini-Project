# 3. Data Dictionary

PostgreSQL 16 + pgvector. Conventions:

- `id` columns are `INT GENERATED ALWAYS AS IDENTITY` unless noted (`BIGINT` for high-volume tables).
- Money is `NUMERIC(14,2)` (rupees and paise, exact). Per-stream revenue is `NUMERIC(14,4)` and is rounded to paise only at payout.
- Percentages are `NUMERIC(5,2)` (0.00–100.00).
- Timestamps are `TIMESTAMPTZ DEFAULT now()`.
- Fixed value sets use `VARCHAR` + `CHECK (col IN (…))`.
- "Null?" means the column allows NULL.

Rule numbers (R1…) refer to [02-relational-schema.md §2.3](02-relational-schema.md#23-business-rules-enforced-in-the-database).
Constraint names (`pk_…`, `fk_…`, `uq_…`, `chk_…`) are in `db/postgres/01_schema.sql`; the app shows them in error messages.

**Schema versions.** `01_schema.sql` creates v1.0. `04_migration_alter_drop.sql` upgrades it to v1.1 on live data:
adds `contributors.phone` and `tracks.language` (marked *(v1.1)* below), widens `platforms.name` to
`VARCHAR(80)`, and drops `releases.label_name` (v1.0 repeated the same label name on every release).

---

## People and access

### contributors
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| contributor_id | INT identity | no | PK | |
| legal_name | VARCHAR(120) | no | `CHECK (length(trim(legal_name)) > 0)` | Name for statements and tax |
| stage_name | VARCHAR(120) | yes | | Artist name shown publicly |
| email | VARCHAR(254) | no | UNIQUE, `CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')` | |
| pan | CHAR(10) | yes | UNIQUE, `CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')` | Indian PAN. NULL for contributors without one, who are taxed at the higher no-PAN rate (F6) |
| tds_rate | NUMERIC(5,2) | no | DEFAULT 10.00, `CHECK (tds_rate BETWEEN 0 AND 100)` | TDS % withheld from payouts |
| search_vector | TSVECTOR | no | GENERATED ALWAYS AS (`to_tsvector('simple', legal_name ‖ ' ' ‖ coalesce(stage_name, ''))`) STORED | Full-text search on names |
| created_at | TIMESTAMPTZ | no | DEFAULT now() | |
| phone *(v1.1)* | VARCHAR(15) | yes | `CHECK (phone ~ '^\+?[0-9]{10,14}$')` | Contact number for payout queries |

### users
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| user_id | INT identity | no | PK | |
| email | VARCHAR(254) | no | UNIQUE | Login name |
| password_hash | TEXT | no | | bcrypt hash; plain passwords are never stored |
| full_name | VARCHAR(120) | no | | |
| role | VARCHAR(12) | no | `CHECK (role IN ('admin','staff','contributor'))` | |
| contributor_id | INT | yes | FK → contributors RESTRICT, UNIQUE | Set only for contributor logins |
| is_active | BOOLEAN | no | DEFAULT true | Users are deactivated, never deleted |
| created_at | TIMESTAMPTZ | no | DEFAULT now() | |
| | | | `CHECK ((role = 'contributor') = (contributor_id IS NOT NULL))` | A contributor login must point to a contributor, and only those may |

### staff_platforms
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| user_id | INT | no | PK, FK → users CASCADE | Staff member (R13) |
| platform_id | INT | no | FK → platforms RESTRICT | The one platform this staff member handles |

### contributor_managers
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| contributor_id | INT | no | PK, FK → contributors CASCADE | |
| user_id | INT | no | PK, FK → users CASCADE | Staff account manager. R12: at most one per contributor per platform |

---

## Catalogue

### releases
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| release_id | INT identity | no | PK | |
| upc | VARCHAR(13) | no | UNIQUE, `CHECK (upc ~ '^[0-9]{12,13}$')` | Universal Product Code |
| title | VARCHAR(200) | no | | |
| release_type | VARCHAR(10) | no | `CHECK (release_type IN ('single','ep','album'))` | |
| release_date | DATE | no | | |

### tracks
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| track_id | INT identity | no | PK | |
| isrc | CHAR(12) | no | UNIQUE, `CHECK (isrc ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$')` | International Standard Recording Code |
| title | VARCHAR(200) | no | | |
| release_id | INT | no | FK → releases RESTRICT | |
| duration_sec | INT | no | `CHECK (duration_sec BETWEEN 1 AND 3599)` | |
| status | VARCHAR(10) | no | DEFAULT 'draft', `CHECK (status IN ('draft','active','retired'))` | `active` requires an active split version (R6) |
| search_vector | TSVECTOR | no | GENERATED ALWAYS AS (`to_tsvector('simple', title)`) STORED; GIN index | Full-text search |
| created_at | TIMESTAMPTZ | no | DEFAULT now() | |
| language *(v1.1)* | VARCHAR(20) | no | DEFAULT 'Hindi', `CHECK (language IN ('Hindi','English','Tamil','Telugu','Punjabi','Marathi','Bengali','Kannada','Malayalam','Instrumental'))` | Recording language |

### genres
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| genre_id | INT identity | no | PK | |
| name | VARCHAR(40) | no | UNIQUE | |

### track_genres
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| track_id | INT | no | PK, FK → tracks CASCADE | |
| genre_id | INT | no | PK, FK → genres RESTRICT | |

### platforms
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| platform_id | INT identity | no | PK | |
| code | VARCHAR(20) | no | UNIQUE, `CHECK (code ~ '^[A-Z_]+$')` | e.g. `SPOTIFY`, `YT_MUSIC`, `JIOSAAVN` — matches the `platform` field in MongoDB |
| name | VARCHAR(80) | no | UNIQUE | Display name (VARCHAR(60) in v1.0) |

### track_platforms
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| track_id | INT | no | PK, FK → tracks CASCADE | |
| platform_id | INT | no | PK, FK → platforms RESTRICT | |
| available_from | DATE | no | | Distribution start date |

### track_embeddings
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| track_id | INT | no | PK, FK → tracks CASCADE | |
| embedding | VECTOR(384) | no | HNSW index (`vector_cosine_ops`) | all-MiniLM-L6-v2 embedding of `source_text` |
| source_text | TEXT | no | | What was embedded: "title — artist names" |
| model | VARCHAR(60) | no | | Model name, so embeddings can be rebuilt if it changes |
| embedded_at | TIMESTAMPTZ | no | DEFAULT now() | |

---

## Ownership

### split_versions
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| version_id | INT identity | no | PK | |
| track_id | INT | no | FK → tracks RESTRICT | |
| valid_from | DATE | no | R5 | First day this split applies |
| valid_to | DATE | yes | `CHECK (valid_to IS NULL OR valid_to > valid_from)` | Exclusive end; NULL = open-ended. Set when superseded (R3). No overlaps (R2) |
| status | VARCHAR(12) | no | DEFAULT 'proposed', `CHECK (status IN ('proposed','active','superseded','rejected'))` | |
| proposed_by | INT | no | FK → users RESTRICT | Staff or admin who proposed it |
| created_at | TIMESTAMPTZ | no | DEFAULT now() | |
| activated_at | TIMESTAMPTZ | yes | `CHECK ((status IN ('active','superseded')) = (activated_at IS NOT NULL))` | When the last approval came in |

### split_shares
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| version_id | INT | no | PK, FK → split_versions CASCADE | |
| contributor_id | INT | no | PK, FK → contributors RESTRICT | |
| role | VARCHAR(16) | no | PK, `CHECK (role IN ('artist','featured_artist','producer','songwriter','composer','lyricist'))` | One person can hold several roles on a track |
| share_pct | NUMERIC(5,2) | no | `CHECK (share_pct > 0 AND share_pct <= 100)` | Sum per version = 100.00 (R1). Frozen once not `proposed` (R4) |

### split_approvals
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| version_id | INT | no | PK, FK → split_versions CASCADE | |
| contributor_id | INT | no | PK, FK → contributors RESTRICT | One row per distinct contributor in the version's shares, created automatically |
| decision | VARCHAR(10) | no | DEFAULT 'pending', `CHECK (decision IN ('pending','approved','rejected'))` | Last approval activates the version (R3); any rejection rejects it |
| decided_at | TIMESTAMPTZ | yes | `CHECK ((decision = 'pending') = (decided_at IS NULL))` | |

### samples
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| sampling_track_id | INT | no | PK, FK → tracks RESTRICT | The newer track that uses the sample |
| sampled_track_id | INT | no | PK, FK → tracks RESTRICT, `CHECK (sampled_track_id <> sampling_track_id)` | The original track |
| upstream_pct | NUMERIC(5,2) | no | `CHECK (upstream_pct > 0 AND upstream_pct < 100)` | % of the sampling track's revenue owed upstream. Total per sampling track < 100 (R8); no cycles (R7) |
| cleared_on | DATE | no | | Date the sample was licensed |

---

## Revenue intake

### royalty_periods
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| period_id | INT identity | no | PK | |
| period_start | DATE | no | UNIQUE | First day of the month |
| period_end | DATE | no | `CHECK (period_end > period_start)` | Last day of the month |
| status | VARCHAR(8) | no | DEFAULT 'open', `CHECK (status IN ('open','locked','paid'))` | `open` accepts reports (R10), `locked` = ready to pay, `paid` = done (R14) |
| processed_by | INT | yes | FK → users RESTRICT | Admin who ran the payout |
| processed_at | TIMESTAMPTZ | yes | `CHECK ((status = 'paid') = (processed_at IS NOT NULL))` | |

### stream_stats
Largest table (~2 lakh rows in test data).

| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| period_id | INT | no | PK, FK → royalty_periods RESTRICT | |
| platform_id | INT | no | PK, FK → platforms RESTRICT | |
| track_id | INT | no | PK, FK → tracks RESTRICT; index (track_id, period_id) | |
| streams | BIGINT | no | `CHECK (streams >= 0)` | |
| revenue | NUMERIC(14,4) | no | `CHECK (revenue >= 0)` | INR, as reported |
| source_report_id | CHAR(24) | yes | | MongoDB ObjectId (hex) of the raw report; NULL for seed data |

### unmatched_lines
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| line_id | BIGINT identity | no | PK | |
| period_id | INT | no | FK → royalty_periods RESTRICT | |
| platform_id | INT | no | FK → platforms RESTRICT | |
| raw_title | VARCHAR(300) | no | | Title exactly as the platform sent it |
| raw_artist | VARCHAR(300) | yes | | |
| streams | BIGINT | no | `CHECK (streams >= 0)` | |
| revenue | NUMERIC(14,4) | no | `CHECK (revenue >= 0)` | |
| source_report_id | CHAR(24) | no | | MongoDB report it came from |
| embedding | VECTOR(384) | yes | | Embedding of "raw_title — raw_artist"; filled after load |
| status | VARCHAR(12) | no | DEFAULT 'unmatched', `CHECK (status IN ('unmatched','matched','written_off'))` | |
| matched_track_id | INT | yes | FK → tracks RESTRICT, `CHECK ((status = 'matched') = (matched_track_id IS NOT NULL))` | Confirmed by staff; confirming adds the streams/revenue to `stream_stats` |
| matched_by | INT | yes | FK → users RESTRICT | |
| matched_at | TIMESTAMPTZ | yes | `CHECK ((status = 'unmatched') = (matched_at IS NULL))` | Also set when written off |

### fraud_flags
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| flag_id | INT identity | no | PK | |
| track_id | INT | no | FK → tracks RESTRICT | |
| period_id | INT | no | FK → royalty_periods RESTRICT | |
| platform_id | INT | yes | FK → platforms RESTRICT, `CHECK ((rule = 'platform_concentration') = (platform_id IS NOT NULL))` | The dominant platform, for the concentration rule only |
| rule | VARCHAR(24) | no | `CHECK (rule IN ('stream_spike','platform_concentration'))`; UNIQUE (track_id, period_id, rule) | |
| observed_value | NUMERIC(12,4) | no | | z-score for spikes, share (0–1) for concentration |
| threshold_value | NUMERIC(12,4) | no | | Threshold in force when the flag was raised |
| status | VARCHAR(10) | no | DEFAULT 'open', `CHECK (status IN ('open','cleared','confirmed'))` | `cleared` releases held money; `confirmed` forfeits it |
| reviewed_by | INT | yes | FK → users RESTRICT | |
| reviewed_at | TIMESTAMPTZ | yes | `CHECK ((status = 'open') = (reviewed_at IS NULL))` | |
| note | TEXT | yes | | Reviewer's reasoning |
| created_at | TIMESTAMPTZ | no | DEFAULT now() | |

---

## Payouts

### held_earnings
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| hold_id | INT identity | no | PK | |
| flag_id | INT | no | FK → fraud_flags RESTRICT | Why it is held (the flag gives the track) |
| contributor_id | INT | no | FK → contributors RESTRICT | |
| period_id | INT | no | FK → royalty_periods RESTRICT | Period the money was earned in |
| amount | NUMERIC(14,2) | no | `CHECK (amount > 0)` | |
| status | VARCHAR(10) | no | DEFAULT 'held', `CHECK (status IN ('held','released','forfeited'))` | |
| released_in_period_id | INT | yes | FK → royalty_periods RESTRICT, `CHECK ((status = 'released') = (released_in_period_id IS NOT NULL))` | Payout run that paid it out |

### advances
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| advance_id | INT identity | no | PK | |
| contributor_id | INT | no | FK → contributors RESTRICT | |
| amount | NUMERIC(14,2) | no | `CHECK (amount > 0)` | |
| issued_on | DATE | no | | Recouped oldest first |
| note | TEXT | yes | | |

### advance_recoupments
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| advance_id | INT | no | PK, FK → advances RESTRICT | |
| period_id | INT | no | PK, FK → royalty_periods RESTRICT | |
| amount | NUMERIC(14,2) | no | `CHECK (amount > 0)` | Sum per advance ≤ advance amount (R9) |

### statements
A statement is a **snapshot**: its figures are stored, not recomputed, because a paid statement must
never change even if splits or rates change later.

| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| statement_id | INT identity | no | PK | |
| period_id | INT | no | FK → royalty_periods RESTRICT; UNIQUE (period_id, contributor_id) | One statement per contributor per period (R14) |
| contributor_id | INT | no | FK → contributors RESTRICT | |
| gross_earned | NUMERIC(14,2) | no | `CHECK (≥ 0)` | Sum of this period's statement lines |
| held_amount | NUMERIC(14,2) | no | DEFAULT 0, `CHECK (≥ 0)` | Withheld because of open fraud flags |
| released_amount | NUMERIC(14,2) | no | DEFAULT 0, `CHECK (≥ 0)` | Earlier holds cleared since the last run |
| recouped_amount | NUMERIC(14,2) | no | DEFAULT 0, `CHECK (≥ 0)` | Taken against advances |
| tds_rate_applied | NUMERIC(5,2) | no | `CHECK (BETWEEN 0 AND 100)` | Rate at the time of payout |
| tds_amount | NUMERIC(14,2) | no | `CHECK (≥ 0)` | |
| net_payable | NUMERIC(14,2) | no | `CHECK (net_payable >= 0)`, `CHECK (net_payable = gross_earned - held_amount + released_amount - recouped_amount - tds_amount)` | |
| generated_at | TIMESTAMPTZ | no | DEFAULT now() | |

### statement_lines
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| statement_id | INT | no | PK, FK → statements CASCADE | |
| line_no | SMALLINT | no | PK, `CHECK (line_no > 0)` | |
| version_id | INT | no | FK → split_versions RESTRICT | Which split version paid this line (the track is reached through it) |
| role | VARCHAR(16) | no | | Role in that version the money is for |
| via_track_id | INT | yes | FK → tracks RESTRICT | The track whose streams produced this money, when it came up the sample chain (F2); NULL for direct earnings |
| amount | NUMERIC(14,2) | no | `CHECK (amount >= 0)` | Exact paise after largest-remainder rounding (F6) |
| is_held | BOOLEAN | no | DEFAULT false | Line is part of `held_amount` |

### payments
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| payment_id | INT identity | no | PK | |
| statement_id | INT | no | FK → statements RESTRICT, UNIQUE | One payment per statement (R14) |
| amount | NUMERIC(14,2) | no | `CHECK (amount > 0)` | Equals statement `net_payable` (R11) |
| paid_at | TIMESTAMPTZ | no | DEFAULT now() | |
| reference | VARCHAR(40) | no | UNIQUE | Bank / UTR reference |

---

## Audit

### audit_log
| Column | Type | Null? | Constraints | Description |
|---|---|---|---|---|
| audit_id | BIGINT identity | no | PK | |
| table_name | VARCHAR(63) | no | | |
| operation | VARCHAR(6) | no | `CHECK (operation IN ('INSERT','UPDATE','DELETE'))` | |
| row_key | JSONB | no | | Primary key of the affected row, e.g. `{"version_id": 7, "contributor_id": 3, "role": "producer"}` |
| old_row | JSONB | yes | NULL for INSERT | Full row before the change |
| new_row | JSONB | yes | NULL for DELETE | Full row after the change |
| changed_by | INT | yes | *no FK on purpose* | App user, read from `current_setting('app.user_id', true)`; NULL for direct DB changes |
| changed_at | TIMESTAMPTZ | no | DEFAULT now() | |
| tx_id | BIGINT | no | DEFAULT `txid_current()` | Groups all rows changed in one transaction (e.g. one payout run) |
