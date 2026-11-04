# 4. Normalization: from the label's Excel sheet to our schema

This is the answer to "why not just use Excel?" from the design side. We start from the single
spreadsheet a small label typically keeps, list its functional dependencies, and normalize it step by
step. Every table in our schema comes out of this process.

## 4.1 The starting point: `Royalty_Master.xlsx`

One sheet, one row per *period × platform × track × contributor role*, with lists packed into cells.

| Period | Platform | ISRC | Track Title | UPC | Release Title | Release Date | Genres | Available On | Contributor Email | Contributor Name | PAN | Role | Share % | Account Manager | Streams | Revenue (₹) | Advance Balance (₹) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09 | Spotify | INX0A2600001 | Monsoon Letters | 8901234567890 | Monsoon EP | 2026-06-01 | Indie, Lo-fi | Spotify, JioSaavn | aarav@mail.in | Aarav Mehta | ABCDE1234F | artist | 60 | Riya (Spotify desk) | 120000 | 4,200.00 | 25,000 |
| 2026-09 | Spotify | INX0A2600001 | Monsoon Letters | 8901234567890 | Monsoon EP | 2026-06-01 | Indie, Lo-fi | Spotify, JioSaavn | kabir@mail.in | Kabir Rao | PQRSX5678K | producer | 40 | Riya (Spotify desk) | 120000 | 4,200.00 | 0 |
| 2026-09 | JioSaavn | INX0A2600001 | Monsoon Letters | 8901234567890 | Monsoon EP | 2026-06-01 | Indie, Lo-fi | Spotify, JioSaavn | aarav@mail.in | Aarav Mehta | ABCDE1234F | artist | 60 | Dev (JioSaavn desk) | 45000 | 1,350.00 | 25,000 |
| 2026-09 | JioSaavn | INX0A2600001 | Monsoon Letters | 8901234567890 | Monsoon EP | 2026-06-01 | Indie, Lo-fi | Spotify, JioSaavn | kabir@mail.in | Kabir Rao | PQRSX5678K | producer | 40 | Dev (JioSaavn desk) | 45000 | 1,350.00 | 0 |

### Anomalies in this sheet

| Anomaly | Example |
|---|---|
| **Update** | Renaming "Monsoon Letters" means editing every row for every period, platform and contributor. Miss one and the sheet contradicts itself. Same for Aarav's advance balance. |
| **Insertion** | A new contributor or an unreleased track can't be recorded until it has streams in some period, because Period, Platform and ISRC are needed to make a row. |
| **Deletion** | Deleting a track's last stream row also deletes the only record of its split and of who its contributors are. |
| **Redundancy** | Streams and revenue (one fact per period × platform × track) are repeated once per contributor role, so `SUM(Revenue)` double-counts. |

## 4.2 Functional dependencies

Assumptions taken from how the label works: one track belongs to one release; a contributor is
identified by email and also by PAN; each account manager handles exactly one platform; a contributor
has one manager per platform.

| # | Functional dependency | Meaning |
|---|---|---|
| FD1 | ISRC → TrackTitle, UPC | A recording has one title and is on one release |
| FD2 | UPC → ReleaseTitle, ReleaseDate | |
| FD3 | Email → ContributorName, PAN, AdvanceBalance | |
| FD4 | PAN → Email | PAN identifies a person too |
| FD5 | {ISRC, Email, Role} → Share% | |
| FD6 | {Period, Platform, ISRC} → Streams, Revenue | One reported figure per track per platform per month |
| FD7 | AccountManager → Platform | Each manager sits on one platform desk |
| FD8 | {Email, Platform} → AccountManager | One manager per contributor per platform |

Multivalued dependencies (independent lists), relevant for 4NF:

| # | MVD | Meaning |
|---|---|---|
| MVD1 | ISRC ↠ Genre | A track's genres don't depend on anything else in the row |
| MVD2 | ISRC ↠ AvailableOn | Neither do the platforms it is distributed on |

## 4.3 Inference rules: finding the candidate keys

Armstrong's axioms: **reflexivity** (if Y ⊆ X then X → Y), **augmentation** (if X → Y then XZ → YZ),
**transitivity** (if X → Y and Y → Z then X → Z). Derived rules used below: **decomposition**,
**union**, **pseudo-transitivity**.

**Derived dependencies used later**

1. ISRC → ReleaseDate
   ISRC → UPC (FD1, decomposition); UPC → ReleaseDate (FD2, decomposition); so ISRC → ReleaseDate (transitivity).
   This transitive dependency is what 3NF removes.
2. {ISRC, PAN, Role} → Share%
   PAN → Email (FD4); augment with {ISRC, Role}: {ISRC, PAN, Role} → {ISRC, Email, Role}; with FD5 by transitivity, {ISRC, PAN, Role} → Share%.
   So a split can be keyed by PAN as well as email.
3. {Email, AccountManager} → Platform
   AccountManager → Platform (FD7); augmentation gives {Email, AccountManager} → {Email, Platform}, and decomposition gives the result.

**Candidate keys of the 1NF relation** (attributes after 1NF, below):

Let K = {Period, Platform, ISRC, Email, Role, Genre, AvailableOn}. Attribute closure K⁺:

| Step | Applied | Adds |
|---|---|---|
| start | K | Period, Platform, ISRC, Email, Role, Genre, AvailableOn |
| 1 | FD6 | Streams, Revenue |
| 2 | FD1 | TrackTitle, UPC |
| 3 | FD2 | ReleaseTitle, ReleaseDate |
| 4 | FD3 | ContributorName, PAN, AdvanceBalance |
| 5 | FD5 | Share% |
| 6 | FD8 | AccountManager |

K⁺ contains all 18 attributes, so K is a superkey. It is minimal: Period, Platform, ISRC, Role, Genre
and AvailableOn appear on no right-hand side, so none can be dropped. Email can be dropped only if PAN is
added (FD4). That gives **two candidate keys**:

- K₁ = {Period, Platform, ISRC, **Email**, Role, Genre, AvailableOn}
- K₂ = {Period, Platform, ISRC, **PAN**, Role, Genre, AvailableOn}

**Prime attributes**: Period, Platform, ISRC, Email, PAN, Role, Genre, AvailableOn.
**Non-prime**: TrackTitle, UPC, ReleaseTitle, ReleaseDate, ContributorName, AdvanceBalance, Share%, AccountManager, Streams, Revenue.

## 4.4 First Normal Form

**Violation:** `Genres` and `Available On` hold lists ("Indie, Lo-fi"). 1NF requires atomic values.

**Fix:** one value per cell, so each original row becomes one row per (genre, platform-available-on)
combination:

R1(Period, Platform, ISRC, TrackTitle, UPC, ReleaseTitle, ReleaseDate, **Genre**, **AvailableOn**,
Email, ContributorName, PAN, Role, Share%, AccountManager, Streams, Revenue, AdvanceBalance)

R1 is in 1NF, but the first data row alone now turns into 2 genres × 2 platforms = **4 rows**, which
makes the redundancy worse. That is expected; the next steps remove it.

## 4.5 Second Normal Form

2NF: no non-prime attribute may depend on only *part* of a candidate key.

Partial dependencies in R1 (all keys contain ISRC, Email/PAN, Period, Platform):

| Dependency | Depends on part of the key |
|---|---|
| ISRC → TrackTitle, UPC (and through UPC, ReleaseTitle, ReleaseDate) | ISRC only |
| Email → ContributorName, AdvanceBalance | Email only |
| {ISRC, Email, Role} → Share% | Three of the seven key attributes |
| {Period, Platform, ISRC} → Streams, Revenue | Three of the seven |
| {Email, Platform} → AccountManager | Two of the seven |

**Decompose** each determinant with its dependents into its own relation:

| Relation | Key |
|---|---|
| TRACK(<u>ISRC</u>, TrackTitle, UPC, ReleaseTitle, ReleaseDate) | ISRC |
| CONTRIBUTOR(<u>Email</u>, ContributorName, PAN, AdvanceBalance) | Email (PAN also a candidate key) |
| SPLIT(<u>ISRC, Email, Role</u>, Share%) | |
| STREAMS(<u>Period, Platform, ISRC</u>, Streams, Revenue) | |
| MANAGER(<u>Email, Platform</u>, AccountManager) | |
| REST(<u>Period, Platform, ISRC, Email, Role, Genre, AvailableOn</u>) | all-key |

Each decomposition is **lossless**: every split shares a key of one side (e.g. TRACK and R1 share ISRC,
which is a key of TRACK).

## 4.6 Third Normal Form

3NF: for every non-trivial X → A, either X is a superkey or A is prime. Equivalently, no non-prime
attribute depends transitively on a key.

| Relation | Problem | Fix |
|---|---|---|
| TRACK | ISRC → UPC → ReleaseTitle, ReleaseDate is transitive (derived dependency 1); UPC is not a key of TRACK | TRACK(<u>ISRC</u>, TrackTitle, UPC) + RELEASE(<u>UPC</u>, ReleaseTitle, ReleaseDate) |
| CONTRIBUTOR | AdvanceBalance is a **derived** value (advances given − amounts recouped). Storing it creates update anomalies every payout | Remove it. Record facts instead: ADVANCE(<u>AdvanceID</u>, Email, Amount, IssuedOn) and RECOUPMENT(<u>AdvanceID, Period</u>, Amount). Balance becomes the view `v_advance_balances` |
| CONTRIBUTOR | Email → PAN and PAN → Email | Not a violation: both Email and PAN are candidate keys |
| MANAGER(Email, Platform, AccountManager) | AccountManager → Platform, and AccountManager is not a superkey… | …but Platform is **prime** (MANAGER's keys are {Email, Platform} and {Email, AccountManager}). So MANAGER **is in 3NF**. See BCNF |

## 4.7 Boyce–Codd Normal Form

BCNF: for every non-trivial X → A, X must be a superkey. The "unless A is prime" escape from 3NF is gone.

Every relation so far passes except **MANAGER**:

- FDs: {Email, Platform} → AccountManager (FD8), AccountManager → Platform (FD7)
- AccountManager → Platform has a determinant that is **not a superkey** → BCNF violation
- Anomaly: if Riya moves from the Spotify desk to the YouTube desk, every MANAGER row with Riya has to change; and a manager with no contributors yet can't be recorded

**Decompose on the violating FD** (AccountManager → Platform):

- MANAGER_DESK(<u>AccountManager</u>, Platform)
- CONTRIBUTOR_MANAGER(<u>Email, AccountManager</u>)

**Lossless?** The common attribute AccountManager is a key of MANAGER_DESK. Yes.

**Dependency-preserving?** **No.** FD8, {Email, Platform} → AccountManager, now spans two tables and can't
be checked inside either one. This is the classic BCNF trade-off. We accept BCNF and **enforce FD8 with a
trigger** (rule R12: on insert into `contributor_managers`, reject if the contributor already has a
manager on the same platform). In the final schema these become `staff_platforms` and `contributor_managers`.

## 4.8 Fourth Normal Form

4NF: for every non-trivial MVD X ↠ Y, X must be a superkey.

After 2NF we were left with the all-key relation
REST(Period, Platform, ISRC, Email, Role, Genre, AvailableOn). It is in BCNF (no non-trivial FDs at all)
but it holds **independent** multi-valued facts about a track:

- ISRC ↠ Genre (MVD1)
- ISRC ↠ AvailableOn (MVD2)
- ISRC ↠ {Email, Role} (who is on it; already in SPLIT)
- ISRC ↠ {Period, Platform} (when and where it streamed; already in STREAMS)

ISRC is not a superkey of REST, so REST **violates 4NF**. The cost is real: one track with 2 genres,
3 distribution platforms, 3 contributor roles and 3 platform reports needs 2 × 3 × 3 × 3 = **54 rows per
month** to say what fits in 2 + 3 + 3 + 3 = 11.

**Decompose by each MVD:**

- TRACK_GENRE(<u>ISRC, Genre</u>), which becomes `track_genres`
- TRACK_AVAILABLE_ON(<u>ISRC, AvailableOn</u>), which becomes `track_platforms`
- the {Email, Role} and {Period, Platform} parts are exactly the keys of SPLIT and STREAMS, already decomposed

REST disappears: it was just the join of these relations.

## 4.9 Fifth Normal Form (higher normal forms)

5NF (project–join normal form) asks whether any relation can be split into three or more projections
and joined back without loss, where it could not be split into two. Our only relations with three-part
keys are `stream_stats` (period, platform, track) and `split_shares` (version, contributor, role).
Both are genuine ternary facts: the stream count belongs to the *combination* (see the ternary
relationship in [01-er-model.md](01-er-model.md)), so projecting onto pairs and re-joining would invent
spurious rows. They have no join dependency that isn't implied by their keys, so they are in 5NF.

## 4.10 From the normalized relations to the final schema

| Normalized relation | Final table | What changed and why |
|---|---|---|
| RELEASE(UPC, …) | `releases` | Surrogate `release_id`; UPC kept as UNIQUE |
| TRACK(ISRC, TrackTitle, UPC) | `tracks` | Surrogate `track_id`; ISRC UNIQUE; FK to release |
| CONTRIBUTOR(Email, Name, PAN) | `contributors` | Surrogate `contributor_id`; email and PAN UNIQUE |
| ADVANCE, RECOUPMENT | `advances`, `advance_recoupments` | Replace the derived AdvanceBalance |
| SPLIT(ISRC, Email, Role, Share%) | `split_versions` + `split_shares` | Splits change over time (F1), so a version entity is introduced: {version_id} → track, valid_from, valid_to and {version_id, contributor_id, role} → share_pct |
| STREAMS(Period, Platform, ISRC, …) | `royalty_periods` + `platforms` + `stream_stats` | Period and platform become entities with their own attributes |
| MANAGER_DESK, CONTRIBUTOR_MANAGER | `staff_platforms`, `contributor_managers` | Managers are staff `users`; FD8 kept by trigger R12 |
| TRACK_GENRE, TRACK_AVAILABLE_ON | `track_genres` + `genres`, `track_platforms` | |

The tables added for the new features (`split_approvals`, `samples`, `fraud_flags`, `held_earnings`,
`unmatched_lines`, `track_embeddings`, `statements`, `statement_lines`, `payments`, `audit_log`) were
checked the same way. Each has a single-attribute surrogate key or a composite key whose every
non-key attribute depends on the whole key and nothing else, so all are in BCNF.

Two deliberate, documented exceptions:

- `statements` stores computed totals. It is an immutable **snapshot** of what was paid, not a
  derived attribute of current data, so later changes to splits or tax rates must not alter it.
  A `CHECK` keeps `net_payable` consistent with the other columns.
- `tracks.search_vector` is a generated column (derived from `title`) stored only so it can carry a GIN
  index for full-text search. Postgres recomputes it automatically, so it can't drift.

The query-processing half of Unit 3 (`EXPLAIN ANALYZE`, index choice, join strategies on the ~2 lakh
row `stream_stats` table) is documented in Phase 3 once the data is loaded.
