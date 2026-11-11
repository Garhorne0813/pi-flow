-- Repair Schedule's pre-012 legacy audit copy without losing any unique record.
INSERT INTO personal_audit(user_id,id,data)
 SELECT user_id,v->>'id',v FROM personal_user_state
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(state->'audit','[]'::jsonb)) v
 ON CONFLICT DO NOTHING;
UPDATE personal_user_state SET state=state-'audit' WHERE state ? 'audit';

-- One frontier per user: polling no longer DISTINCT-scans the Run backlog.
CREATE TABLE IF NOT EXISTS personal_run_work (
 user_id text PRIMARY KEY REFERENCES personal_user_state(user_id) ON DELETE CASCADE,
 queued_run_id text,queued_at timestamptz,lease_run_id text,lease_expires bigint
);
CREATE INDEX IF NOT EXISTS personal_run_work_queued ON personal_run_work(user_id) WHERE queued_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS personal_run_work_expired ON personal_run_work(lease_expires,user_id) WHERE lease_run_id IS NOT NULL;
CREATE OR REPLACE FUNCTION personal_refresh_run_work(p_user text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q record; l record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM personal_user_state WHERE user_id=p_user) THEN RETURN; END IF;
 INSERT INTO personal_run_work(user_id) VALUES(p_user) ON CONFLICT DO NOTHING;
 -- Acquire the frontier before computing heads. Each following SPI statement
 -- takes a fresh READ COMMITTED snapshot after any competing writer commits.
 PERFORM 1 FROM personal_run_work WHERE user_id=p_user FOR UPDATE;
 SELECT run_id,created_at INTO q FROM personal_runs WHERE user_id=p_user AND state='QUEUED' ORDER BY created_at,run_id LIMIT 1;
 SELECT run_id,lease_expires INTO l FROM personal_runs WHERE user_id=p_user AND lease_owner IS NOT NULL AND state<>'QUEUED' ORDER BY lease_expires,run_id LIMIT 1;
 UPDATE personal_run_work SET queued_run_id=q.run_id,queued_at=q.created_at,lease_run_id=l.run_id,lease_expires=l.lease_expires
 WHERE user_id=p_user AND (queued_run_id,queued_at,lease_run_id,personal_run_work.lease_expires) IS DISTINCT FROM (q.run_id,q.created_at,l.run_id,l.lease_expires);
END $$;
CREATE OR REPLACE FUNCTION personal_run_work_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u text;
BEGIN
 FOR u IN SELECT DISTINCT user_id FROM new_runs WHERE state='QUEUED' OR (lease_owner IS NOT NULL AND state<>'QUEUED') ORDER BY user_id LOOP
  PERFORM personal_refresh_run_work(u);
 END LOOP;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION personal_run_work_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u text;
BEGIN
 FOR u IN SELECT DISTINCT user_id FROM old_runs WHERE state='QUEUED' OR (lease_owner IS NOT NULL AND state<>'QUEUED') ORDER BY user_id LOOP
  PERFORM personal_refresh_run_work(u);
 END LOOP;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION personal_run_work_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u text;
BEGIN
 FOR u IN SELECT DISTINCT user_id FROM (
  SELECT n.user_id FROM new_runs n LEFT JOIN old_runs o USING(user_id,run_id)
   WHERE o.run_id IS NULL OR (o.state,o.lease_owner,o.lease_expires,o.created_at) IS DISTINCT FROM (n.state,n.lease_owner,n.lease_expires,n.created_at)
  UNION SELECT o.user_id FROM old_runs o LEFT JOIN new_runs n USING(user_id,run_id) WHERE n.run_id IS NULL
 ) changed ORDER BY user_id LOOP
  PERFORM personal_refresh_run_work(u);
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS personal_runs_work_insert ON personal_runs;
DROP TRIGGER IF EXISTS personal_runs_work_update ON personal_runs;
DROP TRIGGER IF EXISTS personal_runs_work_delete ON personal_runs;
CREATE TRIGGER personal_runs_work_insert AFTER INSERT ON personal_runs REFERENCING NEW TABLE AS new_runs FOR EACH STATEMENT EXECUTE FUNCTION personal_run_work_insert();
CREATE TRIGGER personal_runs_work_update AFTER UPDATE ON personal_runs REFERENCING OLD TABLE AS old_runs NEW TABLE AS new_runs FOR EACH STATEMENT EXECUTE FUNCTION personal_run_work_update();
CREATE TRIGGER personal_runs_work_delete AFTER DELETE ON personal_runs REFERENCING OLD TABLE AS old_runs FOR EACH STATEMENT EXECUTE FUNCTION personal_run_work_delete();
TRUNCATE personal_run_work;
DO $$ DECLARE u text; BEGIN
 FOR u IN SELECT DISTINCT user_id FROM personal_runs WHERE state='QUEUED' OR (lease_owner IS NOT NULL AND state<>'QUEUED') ORDER BY user_id LOOP
  PERFORM personal_refresh_run_work(u);
 END LOOP;
END $$;
-- Match the maintenance rotation's full ORDER BY (including NULLS FIRST).
CREATE INDEX IF NOT EXISTS personal_workspace_rotation
 ON personal_workspace_runtime(checked_at,last_used_at NULLS FIRST,user_id,workspace_id)
 WHERE sandbox_id IS NOT NULL AND NOT COALESCE((data->>'deleting')::boolean,false);
CREATE INDEX IF NOT EXISTS personal_schedule_fires_history
 ON personal_schedule_fires(user_id,schedule_id,scheduled_for DESC,id DESC);
UPDATE personal_schema SET version=10 WHERE id=1;
