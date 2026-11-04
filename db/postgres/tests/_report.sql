-- tests/_report.sql — prints results; fails the run if any case failed
\o
\set QUIET off
SELECT test_no AS "#", CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result, name, left(detail, 110) AS detail
FROM test_results ORDER BY test_no;

SELECT count(*) FILTER (WHERE passed) AS passed, count(*) FILTER (WHERE NOT passed) AS failed
FROM test_results;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM test_results WHERE NOT passed) THEN
        RAISE EXCEPTION 'some tests failed';
    END IF;
END $$;
