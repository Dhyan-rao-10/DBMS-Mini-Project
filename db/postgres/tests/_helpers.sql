-- =====================================================================
-- tests/_helpers.sql — shared by every test file (\ir _helpers.sql)
--
--   expect_error(name, sqlstate, sql [, role])  sql must fail with sqlstate
--   expect_ok(name, sql [, role])               sql must succeed (then undone)
--   check(name, condition, detail)              record an assertion
--
-- Each case runs in its own subtransaction and is rolled back, so tests
-- never leave data behind. When a role is given the statement runs under
-- SET LOCAL ROLE <role>, which is how the web app runs every request.
-- Deferred constraints (R1) are forced to fire inside the case.
-- =====================================================================

\set QUIET on
SET client_min_messages = warning;

CREATE TEMP TABLE test_results (
    test_no  SERIAL,
    name     TEXT,
    passed   BOOLEAN,
    detail   TEXT
);

CREATE FUNCTION pg_temp.expect_error(p_name TEXT, p_state TEXT, p_sql TEXT, p_role TEXT DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        IF p_role IS NOT NULL THEN
            EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        EXECUTE p_sql;
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'statement succeeded but should have failed' USING ERRCODE = 'P0001';
    EXCEPTION WHEN OTHERS THEN
        INSERT INTO test_results (name, passed, detail)
        VALUES (p_name, SQLSTATE = p_state, SQLSTATE || ': ' || SQLERRM);
    END;
    SET CONSTRAINTS ALL DEFERRED;
END $$;

CREATE FUNCTION pg_temp.expect_ok(p_name TEXT, p_sql TEXT, p_role TEXT DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        IF p_role IS NOT NULL THEN
            EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        EXECUTE p_sql;
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'ok' USING ERRCODE = 'P0002';      -- undo the valid change
    EXCEPTION
        WHEN SQLSTATE 'P0002' THEN
            INSERT INTO test_results (name, passed, detail) VALUES (p_name, true, 'accepted');
        WHEN OTHERS THEN
            INSERT INTO test_results (name, passed, detail) VALUES (p_name, false, SQLSTATE || ': ' || SQLERRM);
    END;
    SET CONSTRAINTS ALL DEFERRED;
END $$;

CREATE FUNCTION pg_temp.check(p_name TEXT, p_ok BOOLEAN, p_detail TEXT DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
    INSERT INTO test_results (name, passed, detail) VALUES (p_name, coalesce(p_ok, false), p_detail);
$$;

-- act as a given app user (what the API does with SET LOCAL app.user_id)
CREATE FUNCTION pg_temp.act_as(p_email TEXT) RETURNS INT
LANGUAGE sql AS $$
    SELECT set_config('app.user_id', user_id::text, false)::int FROM users WHERE email = p_email;
$$;

\o /dev/null
