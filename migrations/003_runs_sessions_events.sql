-- Offline migration: old JSONB writers must be stopped before cutover.
CREATE TABLE IF NOT EXISTS harness_sessions (
 tenant_id text NOT NULL REFERENCES harness_tenants(tenant_id) ON DELETE CASCADE,
 session_id text NOT NULL, workspace_id text NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(tenant_id,session_id)
);
CREATE TABLE IF NOT EXISTS harness_runs (
 tenant_id text NOT NULL, run_id text NOT NULL, session_id text NOT NULL,
 user_id text NOT NULL, idempotency_key text, state text NOT NULL,
 lease_owner text, lease_expires bigint, created_at timestamptz NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(tenant_id,run_id),
 FOREIGN KEY(tenant_id,session_id) REFERENCES harness_sessions(tenant_id,session_id) ON DELETE CASCADE,
 CHECK(state IN ('QUEUED','RUNNING','WAITING_INPUT','COMPLETED','FAILED','CANCELLED')),
 CHECK((lease_owner IS NULL)=(lease_expires IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS harness_runs_idempotency ON harness_runs(tenant_id,session_id,user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS harness_runs_session_busy ON harness_runs(tenant_id,session_id) WHERE state IN ('QUEUED','RUNNING','WAITING_INPUT');
CREATE INDEX IF NOT EXISTS harness_runs_claim ON harness_runs(tenant_id,state,created_at) WHERE state='QUEUED';
CREATE INDEX IF NOT EXISTS harness_runs_expired ON harness_runs(lease_expires) WHERE lease_owner IS NOT NULL;
CREATE TABLE IF NOT EXISTS harness_run_events (
 tenant_id text NOT NULL, run_id text NOT NULL,event_id bigint NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(tenant_id,event_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES harness_runs(tenant_id,run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS harness_run_events_replay ON harness_run_events(tenant_id,run_id,event_id);
CREATE TABLE IF NOT EXISTS harness_event_sequences (
 tenant_id text PRIMARY KEY REFERENCES harness_tenants(tenant_id) ON DELETE CASCADE,
 cursor bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_migration_flags(name text PRIMARY KEY);
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM harness_migration_flags WHERE name='runs-v3') THEN
  INSERT INTO harness_sessions SELECT tenant_id,j.k,j.e->>'workspaceId',j.e FROM harness_tenants,jsonb_each(state->'sessions') j(k,e);
  INSERT INTO harness_runs
  SELECT tenant_id,j.k,j.e->>'sessionId',j.e->'actor'->>'userId',j.e->>'key',j.e->>'state',j.e->'lease'->>'owner',(j.e->'lease'->>'expires')::bigint,(j.e->>'createdAt')::timestamptz,j.e
  FROM harness_tenants,jsonb_each(state->'runs') j(k,e);
  INSERT INTO harness_run_events SELECT tenant_id,e->>'runId',(e->>'eventId')::bigint,e FROM harness_tenants,jsonb_array_elements(state->'events') e;
  INSERT INTO harness_event_sequences SELECT tenant_id,COALESCE((state->>'sequence')::bigint,0) FROM harness_tenants;
  IF EXISTS(SELECT 1 FROM harness_tenants t WHERE
   (SELECT count(*) FROM harness_sessions s WHERE s.tenant_id=t.tenant_id)<>(SELECT count(*) FROM jsonb_each(t.state->'sessions'))
  ) THEN RAISE EXCEPTION 'Session migration count mismatch'; END IF;
  IF EXISTS(SELECT 1 FROM harness_tenants t CROSS JOIN LATERAL jsonb_each(t.state->'runs') j(k,e) LEFT JOIN harness_runs r ON r.tenant_id=t.tenant_id AND r.run_id=j.k WHERE r.data IS DISTINCT FROM j.e)
   THEN RAISE EXCEPTION 'Run migration data mismatch'; END IF;
  INSERT INTO harness_migration_flags VALUES('runs-v3');
  UPDATE harness_tenants SET state=state-'sessions'-'runs'-'events';
 END IF;
END $$;
