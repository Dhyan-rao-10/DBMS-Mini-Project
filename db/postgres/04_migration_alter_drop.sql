-- =====================================================================
-- 04_migration_alter_drop.sql — schema v1.0 -> v1.1 on live data
--
-- Shows ALTER and DROP against tables that already hold data:
--   1. add contributors.phone with a CHECK
--   2. add tracks.language in three steps (add NULL-able column,
--      backfill with UPDATE, then make it NOT NULL with a CHECK)
--   3. widen platforms.name (ALTER COLUMN ... TYPE)
--   4. drop releases.label_name: the system serves one label, so the
--      column repeated the same value on every row
--   5. rename a constraint to the project's naming convention
-- All in one transaction: if any step fails, nothing changes.
-- =====================================================================

BEGIN;

-- 1. contact number for payout queries (optional)
ALTER TABLE contributors
    ADD COLUMN phone VARCHAR(15),
    ADD CONSTRAINT chk_contributors_phone CHECK (phone ~ '^\+?[0-9]{10,14}$');

UPDATE contributors
SET phone = '+9198' || lpad((contributor_id * 7919 % 100000000)::text, 8, '0')
WHERE email IN ('aarav.mehta@example.com', 'zoya.khan@example.com', 'kabir.rao@example.com');

-- 2. language of the recording, needed for platform metadata
ALTER TABLE tracks ADD COLUMN language VARCHAR(20);

UPDATE tracks t
SET language = CASE
        WHEN g.has_classical THEN 'Instrumental'
        WHEN g.has_bollywood THEN 'Hindi'
        WHEN t.track_id % 4 = 0 THEN 'English'
        WHEN t.track_id % 7 = 0 THEN 'Tamil'
        ELSE 'Hindi'
    END
FROM (
    SELECT tg.track_id,
           bool_or(gn.name = 'Hindustani Classical') AS has_classical,
           bool_or(gn.name = 'Bollywood')            AS has_bollywood
    FROM track_genres tg JOIN genres gn USING (genre_id)
    GROUP BY tg.track_id
) AS g
WHERE g.track_id = t.track_id;

UPDATE tracks SET language = 'Hindi' WHERE language IS NULL;   -- tracks with no genre yet

ALTER TABLE tracks
    ALTER COLUMN language SET NOT NULL,
    ALTER COLUMN language SET DEFAULT 'Hindi',
    ADD CONSTRAINT chk_tracks_language
        CHECK (language IN ('Hindi', 'English', 'Tamil', 'Telugu', 'Punjabi',
                            'Marathi', 'Bengali', 'Kannada', 'Malayalam', 'Instrumental'));

-- 3. some platform display names are longer than 60 characters
ALTER TABLE platforms ALTER COLUMN name TYPE VARCHAR(80);

-- 4. remove the redundant label name
ALTER TABLE releases DROP COLUMN label_name;

-- 5. naming convention: fk_<table>_<column>
ALTER TABLE contributor_managers
    RENAME CONSTRAINT fk_contrib_managers_contrib TO fk_contributor_managers_contributor;
ALTER TABLE contributor_managers
    RENAME CONSTRAINT fk_contrib_managers_user TO fk_contributor_managers_user;

COMMIT;
