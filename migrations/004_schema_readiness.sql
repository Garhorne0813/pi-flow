-- The combined runtime needs all normalized tables before traffic is accepted.
DO $$ BEGIN
 IF to_regclass('harness_runs') IS NULL OR to_regclass('harness_sessions') IS NULL
 OR to_regclass('harness_run_events') IS NULL OR to_regclass('harness_event_sequences') IS NULL
 OR to_regclass('harness_sandbox_leases') IS NULL THEN
   RAISE EXCEPTION 'Normalized schema incomplete';
 END IF;
 UPDATE harness_schema SET version=4 WHERE id=1;
END $$;
