-- Suppress ordinary queue discovery while any Run of the user is RUNNING.
-- Expired leases remain a separate recovery source.
ALTER TABLE personal_run_work ADD COLUMN IF NOT EXISTS running boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION personal_refresh_run_work(p_user text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q record; l record; busy boolean;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM personal_user_state WHERE user_id=p_user) THEN RETURN; END IF;
 INSERT INTO personal_run_work(user_id) VALUES(p_user) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM personal_run_work WHERE user_id=p_user FOR UPDATE;
 SELECT run_id,created_at INTO q FROM personal_runs WHERE user_id=p_user AND state='QUEUED' ORDER BY created_at,run_id LIMIT 1;
 SELECT run_id,lease_expires INTO l FROM personal_runs WHERE user_id=p_user AND lease_owner IS NOT NULL AND state<>'QUEUED' ORDER BY lease_expires,run_id LIMIT 1;
 SELECT EXISTS(SELECT 1 FROM personal_runs WHERE user_id=p_user AND state='RUNNING') INTO busy;
 UPDATE personal_run_work SET queued_run_id=q.run_id,queued_at=q.created_at,lease_run_id=l.run_id,lease_expires=l.lease_expires,running=busy
 WHERE user_id=p_user AND (queued_run_id,queued_at,lease_run_id,personal_run_work.lease_expires,running) IS DISTINCT FROM (q.run_id,q.created_at,l.run_id,l.lease_expires,busy);
END $$;
CREATE OR REPLACE FUNCTION personal_run_work_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u text;
BEGIN
 FOR u IN SELECT DISTINCT user_id FROM new_runs WHERE state IN ('QUEUED','RUNNING') OR (lease_owner IS NOT NULL AND state<>'QUEUED') ORDER BY user_id LOOP
  PERFORM personal_refresh_run_work(u);
 END LOOP;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION personal_run_work_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u text;
BEGIN
 FOR u IN SELECT DISTINCT user_id FROM old_runs WHERE state IN ('QUEUED','RUNNING') OR (lease_owner IS NOT NULL AND state<>'QUEUED') ORDER BY user_id LOOP
  PERFORM personal_refresh_run_work(u);
 END LOOP;
 RETURN NULL;
END $$;
UPDATE personal_run_work w SET running=EXISTS(SELECT 1 FROM personal_runs r WHERE r.user_id=w.user_id AND r.state='RUNNING');
DO $$ DECLARE u text; BEGIN
 FOR u IN SELECT DISTINCT user_id FROM personal_runs WHERE state='RUNNING' ORDER BY user_id LOOP
  PERFORM personal_refresh_run_work(u);
 END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS personal_run_work_dispatchable ON personal_run_work(user_id) WHERE queued_run_id IS NOT NULL AND NOT running;
ANALYZE personal_run_work;
UPDATE personal_schema SET version=11 WHERE id=1;
