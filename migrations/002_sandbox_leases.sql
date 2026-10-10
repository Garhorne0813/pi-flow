-- Offline cutover: stop all old API/Workers before applying this migration.
CREATE TABLE IF NOT EXISTS harness_sandbox_leases (
 tenant_id text NOT NULL,
 workspace_id text NOT NULL,
 user_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('reserved','active','paused','unknown','released')),
 sandbox_id text,
 operation text,
 updated_at bigint NOT NULL,
 PRIMARY KEY(tenant_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS harness_sandbox_leases_user_state ON harness_sandbox_leases(tenant_id,user_id,state);
CREATE INDEX IF NOT EXISTS harness_sandbox_leases_charged ON harness_sandbox_leases(state) WHERE state IN ('reserved','active','unknown');
CREATE INDEX IF NOT EXISTS harness_sandbox_leases_reconcile ON harness_sandbox_leases(state,updated_at);
CREATE INDEX IF NOT EXISTS harness_sandbox_leases_operation ON harness_sandbox_leases(operation) WHERE operation IS NOT NULL;
-- Marker prevents a subsequent migrate from resurrecting deleted/released rows.
CREATE TABLE IF NOT EXISTS harness_migration_flags(name text PRIMARY KEY);
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM harness_migration_flags WHERE name='capacity-v2') THEN
  INSERT INTO harness_sandbox_leases
  SELECT e->>'tenantId',e->>'workspaceId',e->>'userId',e->>'state',e->>'sandboxId',e->>'operation',(e->>'updatedAt')::bigint
  FROM harness_sandbox_capacity, jsonb_each(state->'entries') AS j(k,e)
  ON CONFLICT(tenant_id,workspace_id) DO NOTHING;
  IF EXISTS(
   SELECT 1 FROM harness_sandbox_capacity,jsonb_each(state->'entries') j(k,e)
   LEFT JOIN harness_sandbox_leases l ON l.tenant_id=e->>'tenantId' AND l.workspace_id=e->>'workspaceId'
   WHERE l.tenant_id IS NULL OR l.user_id IS DISTINCT FROM e->>'userId' OR l.state IS DISTINCT FROM e->>'state'
    OR l.sandbox_id IS DISTINCT FROM e->>'sandboxId' OR l.operation IS DISTINCT FROM e->>'operation' OR l.updated_at IS DISTINCT FROM (e->>'updatedAt')::bigint
  ) THEN RAISE EXCEPTION 'Capacity backfill mismatch'; END IF;
  INSERT INTO harness_migration_flags VALUES('capacity-v2');
 END IF;
END $$;

UPDATE harness_schema SET version=2 WHERE id=1;
