-- =====================================================================
-- 03_bulk_generate.sql — scale test data, generated entirely in SQL
--
-- Adds 400 contributors, 1,400 releases and 3,488 tracks (3,500 in all)
-- with valid 100% splits, then about 2.1 lakh stream_stats rows
-- (tracks x 5 platforms x 12 months). Finally plants a few stream
-- spikes for the fraud-detection demo (F3).
--
-- Deterministic: names and keys come from generate_series arithmetic,
-- and random() is seeded, so every run produces the same data.
-- Run after 02_seed.sql.
-- =====================================================================

BEGIN;

SELECT setseed(0.42) AS seeded \gset

-- ---------- contributors ----------
INSERT INTO contributors (legal_name, stage_name, email, pan, tds_rate)
SELECT n.first_name || ' ' || n.last_name,
       CASE WHEN i % 3 = 0 THEN n.first_name || ' ' || (ARRAY['MC','Beats','Live','Sound','Wave'])[1 + i % 5] END,
       lower(n.first_name || '.' || n.last_name || '.' || i) || '@example.com',
       -- every 15th contributor has no PAN and is withheld at 20%
       CASE WHEN i % 15 = 0 THEN NULL
            ELSE 'B' || chr(65 + (i / 676) % 26) || chr(65 + (i / 26) % 26) || 'P'
                     || chr(65 + i % 26) || lpad(i::text, 4, '0') || 'K' END,
       CASE WHEN i % 15 = 0 THEN 20.00 ELSE 10.00 END
FROM generate_series(1, 400) AS i
CROSS JOIN LATERAL (
    SELECT (ARRAY['Aditi','Rahul','Priya','Siddharth','Kavya','Nikhil','Pooja','Varun','Sneha','Karan',
                  'Diya','Aman','Ritika','Yash','Nisha','Harsh','Tanvi','Kunal','Shreya','Manav',
                  'Ira','Dhruv','Anika','Parth','Mahi','Rehan','Sara','Vivaan','Kiara','Advait',
                  'Myra','Reyansh','Saanvi','Ayaan','Navya','Atharv','Pari','Shaurya','Anvi','Kabir']
           )[1 + (i * 7) % 40] AS first_name,
           (ARRAY['Patel','Shah','Reddy','Joshi','Bose','Chopra','Das','Ghosh','Kulkarni','Menon',
                  'Pillai','Bhat','Saxena','Agarwal','Banerjee','Desai','Hegde','Jain','Kaur','Mishra',
                  'Naidu','Pandey','Qureshi','Rana','Sen','Thakur','Upadhyay','Wadhwa','Yadav','Zaveri']
           )[1 + (i * 11) % 30] AS last_name
) AS n;

-- ---------- releases ----------
INSERT INTO releases (upc, title, release_type, release_date)
SELECT '890' || lpad(i::text, 10, '0'),
       (ARRAY['Midnight','Velvet','Paper','Golden','Silent','Electric','Dusty','Saffron','Neon','Monsoon',
              'Hidden','Broken','Summer','Lost','Wild'])[1 + i % 15]
         || ' ' ||
       (ARRAY['Rickshaw','Skyline','Letters','Rooftops','Tapes','Highway','Bazaar','Echoes','Harbour','Lanterns',
              'Signals','Gardens','Postcards','Shadows','Tides','Rivers','Stories','Circuits'])[1 + (i / 15) % 18],
       CASE WHEN i % 10 = 0 THEN 'album' WHEN i % 4 = 0 THEN 'ep' ELSE 'single' END,
       DATE '2023-01-01' + (i * 997) % 975          -- spread over Jan 2023 .. Sep 2025
FROM generate_series(1, 1400) AS i;

-- ---------- tracks ----------
INSERT INTO tracks (isrc, title, release_id, duration_sec, status)
SELECT 'INB0K24' || lpad(i::text, 5, '0'),
       (ARRAY['Chasing','Dancing','Waiting','Falling','Running','Dreaming','Burning','Floating','Fading','Calling',
              'Holding','Breaking','Drifting','Glowing','Hiding','Singing','Counting','Walking','Painting','Turning',
              'Missing','Finding','Losing','Watching','Writing'])[1 + i % 25]
         || ' ' ||
       (ARRAY['Stars','Rain','Ghosts','Trains','Mangoes','Kites','Lights','Waves','Clouds','Streets',
              'Fireflies','Mirrors','Embers','Petals','Sparrows','Moons','Rooftops','Oceans','Whispers','Colours',
              'Heartbeats','Monsoons','Shadows','Horizons','Tea Stalls'])[1 + (i / 25) % 25]
         || (ARRAY['', ' (Acoustic)', ' (Remix)', ' (Reprise)', ' Pt. 2', ' (Live)', ' (Unplugged)', ' (Slowed)']
            )[1 + (i / 625) % 8],
       r.release_id,
       120 + (i * 37) % 240,
       'active'
FROM generate_series(1, 3488) AS i
JOIN releases r ON r.upc = '890' || lpad((1 + i % 1400)::text, 10, '0');

-- bulk tracks are those with the INB0K prefix
CREATE TEMP TABLE bulk_tracks ON COMMIT DROP AS
SELECT t.track_id, r.release_date,
       row_number() OVER (ORDER BY t.track_id) AS n
FROM tracks t JOIN releases r USING (release_id)
WHERE t.isrc LIKE 'INB0K%';

CREATE TEMP TABLE bulk_contributors ON COMMIT DROP AS
SELECT contributor_id, row_number() OVER (ORDER BY contributor_id) - 1 AS k
FROM contributors
WHERE email ~ '\.[0-9]+@example\.com$';

-- 1 or 2 genres per track
INSERT INTO track_genres (track_id, genre_id)
SELECT bt.track_id, g.genre_id
FROM bulk_tracks bt
JOIN (SELECT genre_id, row_number() OVER (ORDER BY genre_id) AS gn FROM genres) g
  ON g.gn = 1 + bt.n % 10
  OR (bt.n % 3 = 0 AND g.gn = 1 + (bt.n + 3) % 10);

INSERT INTO track_platforms (track_id, platform_id, available_from)
SELECT bt.track_id, p.platform_id, bt.release_date
FROM bulk_tracks bt CROSS JOIN platforms p;

-- ---------- one active, fully approved split version per bulk track ----------
INSERT INTO split_versions (track_id, valid_from, status, proposed_by, activated_at)
SELECT bt.track_id, bt.release_date, 'active',
       (SELECT user_id FROM users WHERE email = 'admin@monsoonrecords.test'),
       bt.release_date::timestamptz
FROM bulk_tracks bt;

-- 2, 3 or 4 contributors per track; share patterns each total exactly 100
INSERT INTO split_shares (version_id, contributor_id, role, share_pct)
SELECT sv.version_id, bc.contributor_id,
       (ARRAY['artist','producer','songwriter','composer'])[j + 1],
       CASE 2 + bt.n % 3
            WHEN 2 THEN (ARRAY[60, 40])[j + 1]
            WHEN 3 THEN (ARRAY[50, 30, 20])[j + 1]
            ELSE        (ARRAY[40, 25, 20, 15])[j + 1]
       END
FROM bulk_tracks bt
JOIN split_versions sv ON sv.track_id = bt.track_id
CROSS JOIN generate_series(0, 3) AS j
JOIN bulk_contributors bc ON bc.k = (bt.n * 13 + j * 97) % 400   -- j*97 mod 400 is distinct for j = 0..3
WHERE j < 2 + bt.n % 3;

INSERT INTO split_approvals (version_id, contributor_id, decision, decided_at)
SELECT DISTINCT ss.version_id, ss.contributor_id, 'approved', sv.activated_at
FROM split_shares ss
JOIN split_versions sv USING (version_id)
JOIN bulk_tracks bt USING (track_id);

-- a few bulk contributors received advances
INSERT INTO advances (contributor_id, amount, issued_on, note)
SELECT bc.contributor_id, 5000 + (bc.k * 1733) % 45000, DATE '2025-01-15' + ((bc.k * 13) % 240)::int, 'Signing advance'
FROM bulk_contributors bc
WHERE bc.k % 25 = 0;

-- ---------- streams: every active track x platform x period ----------
-- Each track gets a random popularity (log-uniform, ~50 to ~55,000 streams/month on the
-- lead platform) and a monthly growth trend; each platform has its own audience weight
-- and per-stream rate in INR.
INSERT INTO stream_stats (period_id, platform_id, track_id, streams, revenue)
WITH popularity AS (
    SELECT t.track_id,
           exp(random() * 7) * 50 * CASE WHEN t.isrc LIKE 'INM0R%' THEN 20 ELSE 1 END AS base,
           random() * 0.10 - 0.03 AS growth
    FROM tracks t
    WHERE t.status = 'active'
),
platform_profile AS (
    SELECT platform_id, weight, rate
    FROM platforms
    JOIN (VALUES ('SPOTIFY', 1.00, 0.085), ('YT_MUSIC', 0.80, 0.045), ('JIOSAAVN', 0.90, 0.060),
                 ('APPLE_MUSIC', 0.25, 0.250), ('GAANA', 0.40, 0.040)) AS v(code, weight, rate)
      USING (code)
),
periods AS (
    SELECT period_id, period_start,
           row_number() OVER (ORDER BY period_start) - 1 AS month_idx
    FROM royalty_periods
),
counts AS (
    SELECT pe.period_id, pp.platform_id, po.track_id, pp.rate,
           floor(po.base * pp.weight * power(1 + po.growth, pe.month_idx)
                 * (0.85 + 0.30 * random()))::bigint AS streams
    FROM popularity po
    JOIN track_platforms tp ON tp.track_id = po.track_id
    JOIN platform_profile pp ON pp.platform_id = tp.platform_id
    JOIN periods pe ON pe.period_start >= date_trunc('month', tp.available_from)
)
SELECT period_id, platform_id, track_id, streams,
       round(streams * rate * (0.95 + 0.10 * random())::numeric, 4)
FROM counts;

-- ---------- plant suspicious spikes in September 2026 (F3 demo) ----------
-- 8 bulk tracks jump 15x on one platform, plus the hand-crafted "Terrace Nights" on JioSaavn.
UPDATE stream_stats s
SET streams = s.streams * 15,
    revenue = s.revenue * 15
FROM tracks t, platforms p, royalty_periods rp
WHERE s.track_id = t.track_id
  AND s.platform_id = p.platform_id
  AND s.period_id = rp.period_id
  AND rp.period_start = DATE '2026-09-01'
  AND (   (t.isrc LIKE 'INB0K%' AND t.track_id % 437 = 0 AND p.code = 'SPOTIFY')
       OR (t.isrc = 'INM0R2500007' AND p.code = 'JIOSAAVN'));

COMMIT;

ANALYZE;   -- refresh planner statistics after the bulk load
