-- =====================================================================
-- 02_seed.sql — hand-crafted demo data for "Monsoon Records"
--
-- A small, realistic catalogue used in the demo: a split that changed
-- over time (F1), a three-level sample chain (F2), pending approvals,
-- advances and account managers. All people are fictional.
--
-- Rows are linked by natural keys (email, ISRC, UPC) through joins and
-- subqueries, never by hard-coded surrogate ids.
--
-- Needs psql variable seed_password (setup.sh passes it from .env);
-- it is stored only as a bcrypt hash.
-- =====================================================================

BEGIN;

-- ---------- lookup data ----------
INSERT INTO platforms (code, name) VALUES
    ('SPOTIFY',     'Spotify'),
    ('YT_MUSIC',    'YouTube Music'),
    ('JIOSAAVN',    'JioSaavn'),
    ('APPLE_MUSIC', 'Apple Music'),
    ('GAANA',       'Gaana');

INSERT INTO genres (name) VALUES
    ('Indie'), ('Lo-fi'), ('Hip-Hop'), ('Pop'), ('Bollywood'),
    ('Folk'), ('Electronic'), ('Hindustani Classical'), ('Fusion'), ('Ghazal');

-- ---------- contributors ----------
INSERT INTO contributors (legal_name, stage_name, email, pan, tds_rate) VALUES
    ('Aarav Mehta',     'Aarav',       'aarav.mehta@example.com',     'ABCPM1234F', 10.00),
    ('Kabir Rao',       'Kabir Beats', 'kabir.rao@example.com',       'PQRPR5678K', 10.00),
    ('Meera Iyer',      'Meera',       'meera.iyer@example.com',      'MNOPI2345L', 10.00),
    ('Zoya Khan',       'ZOYA',        'zoya.khan@example.com',       'KLMPK3456Z', 10.00),
    ('Arjun Nair',      'Arjun N',     'arjun.nair@example.com',      'NOPPN4567Q', 10.00),
    ('Ishaan Verma',    NULL,          'ishaan.verma@example.com',    'VERPV5678R', 10.00),
    ('Tara D''Souza',   'Tara',        'tara.dsouza@example.com',     'DSOPD6789S', 10.00),
    ('Rohan Gupta',     'RoGu',        'rohan.gupta@example.com',     'GUPPG7890T', 10.00),
    ('Ananya Sharma',   NULL,          'ananya.sharma@example.com',   'SHAPS8901U', 10.00),
    ('Vikram Singh',    'Vik',         'vikram.singh@example.com',    'SINPS9012V', 10.00),
    ('Leela Krishnan',  NULL,          'leela.krishnan@example.com',  'KRIPK0123W', 10.00),
    -- overseas collaborator without a PAN: higher withholding rate (F6, NULL handling)
    ('Neil Fernandes',  'Neil F',      'neil.fernandes@example.com',  NULL,         20.00);

-- ---------- users (bcrypt via pgcrypto) ----------
INSERT INTO users (email, password_hash, full_name, role, contributor_id)
SELECT v.email, crypt(:'seed_password', gen_salt('bf', 10)), v.full_name, v.role, c.contributor_id
FROM (VALUES
    ('admin@monsoonrecords.test',        'Label Admin',    'admin',       NULL),
    ('riya.spotify@monsoonrecords.test', 'Riya Kapoor',    'staff',       NULL),
    ('sana.youtube@monsoonrecords.test', 'Sana Mirza',     'staff',       NULL),
    ('dev.jiosaavn@monsoonrecords.test', 'Dev Malhotra',   'staff',       NULL),
    ('aarav.mehta@example.com',          'Aarav Mehta',    'contributor', 'aarav.mehta@example.com'),
    ('kabir.rao@example.com',            'Kabir Rao',      'contributor', 'kabir.rao@example.com'),
    ('meera.iyer@example.com',           'Meera Iyer',     'contributor', 'meera.iyer@example.com'),
    ('zoya.khan@example.com',            'Zoya Khan',      'contributor', 'zoya.khan@example.com')
) AS v(email, full_name, role, contributor_email)
LEFT JOIN contributors c ON c.email = v.contributor_email;

-- each staff member sits on one platform desk (BCNF: AccountManager -> Platform)
INSERT INTO staff_platforms (user_id, platform_id)
SELECT u.user_id, p.platform_id
FROM (VALUES
    ('riya.spotify@monsoonrecords.test', 'SPOTIFY'),
    ('sana.youtube@monsoonrecords.test', 'YT_MUSIC'),
    ('dev.jiosaavn@monsoonrecords.test', 'JIOSAAVN')
) AS v(email, code)
JOIN users u     ON u.email = v.email
JOIN platforms p ON p.code  = v.code;

INSERT INTO contributor_managers (contributor_id, user_id)
SELECT c.contributor_id, u.user_id
FROM (VALUES
    ('aarav.mehta@example.com', 'riya.spotify@monsoonrecords.test'),
    ('aarav.mehta@example.com', 'dev.jiosaavn@monsoonrecords.test'),
    ('zoya.khan@example.com',   'riya.spotify@monsoonrecords.test'),
    ('kabir.rao@example.com',   'sana.youtube@monsoonrecords.test'),
    ('arjun.nair@example.com',  'sana.youtube@monsoonrecords.test')
) AS v(contributor_email, manager_email)
JOIN contributors c ON c.email = v.contributor_email
JOIN users u        ON u.email = v.manager_email;

-- ---------- catalogue ----------
INSERT INTO releases (upc, title, release_type, release_date) VALUES
    ('8901234567890', 'Monsoon EP',                    'ep',     DATE '2025-06-01'),
    ('8901234567891', 'Monsoon Letters (Lofi Flip)',   'single', DATE '2025-08-15'),
    ('8901234567892', 'City Lights',                   'album',  DATE '2025-03-10'),
    ('8901234567893', 'Rain Cypher',                   'single', DATE '2025-09-01'),
    ('8901234567894', 'Raag Revival',                  'single', DATE '2019-01-26'),
    ('8901234567895', 'Unreleased Demos',              'ep',     DATE '2026-11-01');

INSERT INTO tracks (isrc, title, release_id, duration_sec, status)
SELECT v.isrc, v.title, r.release_id, v.duration_sec, v.status
FROM (VALUES
    ('INM0R2500001', 'Monsoon Letters',             '8901234567890', 214, 'active'),
    ('INM0R2500002', 'Paper Boats',                 '8901234567890', 198, 'active'),
    ('INM0R2500003', 'Petrichor',                   '8901234567890', 241, 'active'),
    ('INM0R2500004', 'Monsoon Letters (Lofi Flip)', '8901234567891', 176, 'active'),
    ('INM0R2500005', 'Neon Chai',                   '8901234567892', 205, 'active'),
    ('INM0R2500006', 'Local Train Dreams',          '8901234567892', 232, 'active'),
    ('INM0R2500007', 'Terrace Nights',              '8901234567892', 219, 'active'),
    ('INM0R2500008', 'Bandra Blues',                '8901234567892', 247, 'active'),
    ('INM0R2500009', 'Rain Cypher',                 '8901234567893', 189, 'active'),
    ('INM0R1900001', 'Raag Megh (Revival)',         '8901234567894', 402, 'active'),
    ('INM0R2500010', 'Chai Pe Charcha',             '8901234567892', 201, 'active'),
    ('INM0R2600001', 'Untitled Demo 1',             '8901234567895', 150, 'draft')
) AS v(isrc, title, upc, duration_sec, status)
JOIN releases r ON r.upc = v.upc;

INSERT INTO track_genres (track_id, genre_id)
SELECT t.track_id, g.genre_id
FROM (VALUES
    ('INM0R2500001', 'Indie'), ('INM0R2500001', 'Lo-fi'),
    ('INM0R2500002', 'Indie'), ('INM0R2500002', 'Folk'),
    ('INM0R2500003', 'Indie'),
    ('INM0R2500004', 'Lo-fi'), ('INM0R2500004', 'Electronic'),
    ('INM0R2500005', 'Pop'),   ('INM0R2500005', 'Electronic'),
    ('INM0R2500006', 'Pop'),
    ('INM0R2500007', 'Pop'),   ('INM0R2500007', 'Hip-Hop'),
    ('INM0R2500008', 'Fusion'),
    ('INM0R2500009', 'Hip-Hop'),
    ('INM0R1900001', 'Hindustani Classical'),
    ('INM0R2500010', 'Bollywood'), ('INM0R2500010', 'Pop'),
    ('INM0R2600001', 'Indie')
) AS v(isrc, genre)
JOIN tracks t ON t.isrc = v.isrc
JOIN genres g ON g.name = v.genre;

-- every released track is on every platform from its release date
INSERT INTO track_platforms (track_id, platform_id, available_from)
SELECT t.track_id, p.platform_id, r.release_date
FROM tracks t
JOIN releases r USING (release_id)
CROSS JOIN platforms p
WHERE t.status = 'active';

-- ---------- royalty periods: Oct 2025 .. Sep 2026 ----------
INSERT INTO royalty_periods (period_start, period_end)
SELECT m::date, (m + INTERVAL '1 month - 1 day')::date
FROM generate_series(DATE '2025-10-01', DATE '2026-09-01', INTERVAL '1 month') AS m;

-- ---------- split versions (F1) ----------
INSERT INTO split_versions (track_id, valid_from, valid_to, status, proposed_by, activated_at)
SELECT t.track_id, v.valid_from, v.valid_to, v.status, u.user_id, v.activated_at
FROM (VALUES
    -- Monsoon Letters: lyricist Ishaan added from March 2026, everyone else diluted
    ('INM0R2500001', DATE '2025-06-01', DATE '2026-03-01', 'superseded', 'admin@monsoonrecords.test',        TIMESTAMPTZ '2025-05-28 11:00+05:30'),
    ('INM0R2500001', DATE '2026-03-01', NULL,              'active',     'riya.spotify@monsoonrecords.test', TIMESTAMPTZ '2026-02-24 16:30+05:30'),
    ('INM0R2500002', DATE '2025-06-01', NULL,              'active',     'admin@monsoonrecords.test',        TIMESTAMPTZ '2025-05-28 11:05+05:30'),
    ('INM0R2500003', DATE '2025-06-01', NULL,              'active',     'admin@monsoonrecords.test',        TIMESTAMPTZ '2025-05-28 11:10+05:30'),
    ('INM0R2500004', DATE '2025-08-15', NULL,              'active',     'sana.youtube@monsoonrecords.test', TIMESTAMPTZ '2025-08-10 12:00+05:30'),
    ('INM0R2500005', DATE '2025-03-10', NULL,              'active',     'admin@monsoonrecords.test',        TIMESTAMPTZ '2025-03-05 10:00+05:30'),
    ('INM0R2500006', DATE '2025-03-10', NULL,              'active',     'admin@monsoonrecords.test',        TIMESTAMPTZ '2025-03-05 10:05+05:30'),
    ('INM0R2500007', DATE '2025-03-10', NULL,              'active',     'admin@monsoonrecords.test',        TIMESTAMPTZ '2025-03-05 10:10+05:30'),
    ('INM0R2500008', DATE '2025-03-10', NULL,              'active',     'admin@monsoonrecords.test',        TIMESTAMPTZ '2025-03-05 10:15+05:30'),
    ('INM0R2500009', DATE '2025-09-01', NULL,              'active',     'sana.youtube@monsoonrecords.test', TIMESTAMPTZ '2025-08-29 18:00+05:30'),
    ('INM0R1900001', DATE '2019-01-26', NULL,              'active',     'admin@monsoonrecords.test',        TIMESTAMPTZ '2019-01-20 10:00+05:30'),
    ('INM0R2500010', DATE '2025-03-10', NULL,              'active',     'admin@monsoonrecords.test',        TIMESTAMPTZ '2025-03-05 10:20+05:30'),
    -- pending proposals for the approval demo
    ('INM0R2500005', DATE '2026-11-01', NULL,              'proposed',   'riya.spotify@monsoonrecords.test', NULL),
    ('INM0R2600001', DATE '2026-11-01', NULL,              'proposed',   'dev.jiosaavn@monsoonrecords.test', NULL)
) AS v(isrc, valid_from, valid_to, status, proposer_email, activated_at)
JOIN tracks t ON t.isrc  = v.isrc
JOIN users u  ON u.email = v.proposer_email;

INSERT INTO split_shares (version_id, contributor_id, role, share_pct)
SELECT sv.version_id, c.contributor_id, v.role, v.share_pct
FROM (VALUES
    ('INM0R2500001', DATE '2025-06-01', 'aarav.mehta@example.com',    'artist',          70.00),
    ('INM0R2500001', DATE '2025-06-01', 'kabir.rao@example.com',      'producer',        30.00),
    ('INM0R2500001', DATE '2026-03-01', 'aarav.mehta@example.com',    'artist',          60.00),
    ('INM0R2500001', DATE '2026-03-01', 'kabir.rao@example.com',      'producer',        30.00),
    ('INM0R2500001', DATE '2026-03-01', 'ishaan.verma@example.com',   'lyricist',        10.00),
    ('INM0R2500002', DATE '2025-06-01', 'aarav.mehta@example.com',    'artist',          50.00),
    ('INM0R2500002', DATE '2025-06-01', 'ananya.sharma@example.com',  'songwriter',      30.00),
    ('INM0R2500002', DATE '2025-06-01', 'kabir.rao@example.com',      'producer',        20.00),
    ('INM0R2500003', DATE '2025-06-01', 'aarav.mehta@example.com',    'artist',          55.00),
    ('INM0R2500003', DATE '2025-06-01', 'kabir.rao@example.com',      'producer',        25.00),
    ('INM0R2500003', DATE '2025-06-01', 'vikram.singh@example.com',   'composer',        20.00),
    -- same person, two roles: why role is part of the key
    ('INM0R2500004', DATE '2025-08-15', 'kabir.rao@example.com',      'artist',          40.00),
    ('INM0R2500004', DATE '2025-08-15', 'kabir.rao@example.com',      'producer',        30.00),
    ('INM0R2500004', DATE '2025-08-15', 'aarav.mehta@example.com',    'featured_artist', 30.00),
    ('INM0R2500005', DATE '2025-03-10', 'zoya.khan@example.com',      'artist',          60.00),
    ('INM0R2500005', DATE '2025-03-10', 'rohan.gupta@example.com',    'producer',        40.00),
    ('INM0R2500006', DATE '2025-03-10', 'zoya.khan@example.com',      'artist',          50.00),
    ('INM0R2500006', DATE '2025-03-10', 'rohan.gupta@example.com',    'producer',        25.00),
    ('INM0R2500006', DATE '2025-03-10', 'ananya.sharma@example.com',  'songwriter',      25.00),
    ('INM0R2500007', DATE '2025-03-10', 'arjun.nair@example.com',     'artist',          45.00),
    ('INM0R2500007', DATE '2025-03-10', 'tara.dsouza@example.com',    'featured_artist', 20.00),
    ('INM0R2500007', DATE '2025-03-10', 'rohan.gupta@example.com',    'producer',        35.00),
    ('INM0R2500008', DATE '2025-03-10', 'zoya.khan@example.com',      'artist',          40.00),
    ('INM0R2500008', DATE '2025-03-10', 'neil.fernandes@example.com', 'featured_artist', 20.00),
    ('INM0R2500008', DATE '2025-03-10', 'rohan.gupta@example.com',    'producer',        20.00),
    ('INM0R2500008', DATE '2025-03-10', 'vikram.singh@example.com',   'composer',        20.00),
    ('INM0R2500009', DATE '2025-09-01', 'arjun.nair@example.com',     'artist',          50.00),
    ('INM0R2500009', DATE '2025-09-01', 'tara.dsouza@example.com',    'featured_artist', 25.00),
    ('INM0R2500009', DATE '2025-09-01', 'kabir.rao@example.com',      'producer',        25.00),
    ('INM0R1900001', DATE '2019-01-26', 'leela.krishnan@example.com', 'composer',        70.00),
    ('INM0R1900001', DATE '2019-01-26', 'vikram.singh@example.com',   'composer',        30.00),
    ('INM0R2500010', DATE '2025-03-10', 'meera.iyer@example.com',     'artist',          50.00),
    ('INM0R2500010', DATE '2025-03-10', 'ishaan.verma@example.com',   'lyricist',        25.00),
    ('INM0R2500010', DATE '2025-03-10', 'rohan.gupta@example.com',    'producer',        25.00),
    -- proposed: Neon Chai adds Neil as featured artist from Nov 2026
    ('INM0R2500005', DATE '2026-11-01', 'zoya.khan@example.com',      'artist',          55.00),
    ('INM0R2500005', DATE '2026-11-01', 'rohan.gupta@example.com',    'producer',        35.00),
    ('INM0R2500005', DATE '2026-11-01', 'neil.fernandes@example.com', 'featured_artist', 10.00),
    ('INM0R2600001', DATE '2026-11-01', 'meera.iyer@example.com',     'artist',          60.00),
    ('INM0R2600001', DATE '2026-11-01', 'kabir.rao@example.com',      'producer',        40.00)
) AS v(isrc, valid_from, contributor_email, role, share_pct)
JOIN tracks t          ON t.isrc = v.isrc
JOIN split_versions sv ON sv.track_id = t.track_id AND sv.valid_from = v.valid_from
JOIN contributors c    ON c.email = v.contributor_email;

-- one approval row per distinct contributor in each version;
-- versions that went live were approved by everyone when activated
INSERT INTO split_approvals (version_id, contributor_id, decision, decided_at)
SELECT DISTINCT ss.version_id, ss.contributor_id,
       CASE WHEN sv.status = 'proposed' THEN 'pending' ELSE 'approved' END,
       CASE WHEN sv.status = 'proposed' THEN NULL ELSE sv.activated_at END
FROM split_shares ss
JOIN split_versions sv USING (version_id);

-- some proposals already have partial approval
UPDATE split_approvals sa
SET decision = 'approved', decided_at = TIMESTAMPTZ '2026-10-20 09:15+05:30'
FROM split_versions sv, tracks t, contributors c
WHERE sa.version_id = sv.version_id
  AND sv.track_id = t.track_id
  AND sa.contributor_id = c.contributor_id
  AND sv.status = 'proposed'
  AND (t.isrc, c.email) IN (('INM0R2500005', 'zoya.khan@example.com'),
                            ('INM0R2600001', 'meera.iyer@example.com'));

-- ---------- sample chain (F2): Rain Cypher -> Lofi Flip -> Monsoon Letters -> Raag Megh ----------
INSERT INTO samples (sampling_track_id, sampled_track_id, upstream_pct, cleared_on)
SELECT a.track_id, b.track_id, v.upstream_pct, v.cleared_on
FROM (VALUES
    ('INM0R2500004', 'INM0R2500001', 30.00, DATE '2025-08-01'),
    ('INM0R2500009', 'INM0R2500004', 20.00, DATE '2025-08-25'),
    ('INM0R2500001', 'INM0R1900001', 15.00, DATE '2025-05-20')
) AS v(sampling_isrc, sampled_isrc, upstream_pct, cleared_on)
JOIN tracks a ON a.isrc = v.sampling_isrc
JOIN tracks b ON b.isrc = v.sampled_isrc;

-- ---------- advances ----------
INSERT INTO advances (contributor_id, amount, issued_on, note)
SELECT c.contributor_id, v.amount, v.issued_on, v.note
FROM (VALUES
    ('aarav.mehta@example.com', 25000.00, DATE '2025-09-15', 'Monsoon EP signing advance'),
    ('zoya.khan@example.com',   40000.00, DATE '2025-03-01', 'City Lights album advance'),
    ('arjun.nair@example.com',  10000.00, DATE '2025-08-20', 'Rain Cypher single advance'),
    ('zoya.khan@example.com',   75000.00, DATE '2026-04-10', 'Music video advance'),
    ('meera.iyer@example.com',  30000.00, DATE '2026-01-10', 'Debut album advance')
) AS v(email, amount, issued_on, note)
JOIN contributors c ON c.email = v.email;

COMMIT;
