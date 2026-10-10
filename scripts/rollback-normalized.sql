-- OFFLINE ONLY: stop every API/Worker and take a verified backup first.
-- Retains normalized tables/markers as evidence. Re-upgrade requires explicit
-- reconciliation; migrations reject restored nonempty legacy aggregates.
BEGIN;
SELECT pg_advisory_xact_lock(134697,13);
LOCK TABLE harness_tenants,harness_sessions,harness_runs,harness_run_events,
 harness_event_sequences,harness_sandbox_capacity,harness_sandbox_leases IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF (SELECT version FROM harness_schema WHERE id=1) IS DISTINCT FROM 4 THEN
  RAISE EXCEPTION 'Rollback requires normalized schema version 4';
 END IF;
END $$;
UPDATE harness_tenants t SET state=t.state || jsonb_build_object(
 'sessions',COALESCE((SELECT jsonb_object_agg(session_id,data) FROM harness_sessions s WHERE s.tenant_id=t.tenant_id),'{}'::jsonb),
 'runs',COALESCE((SELECT jsonb_object_agg(run_id,data) FROM harness_runs r WHERE r.tenant_id=t.tenant_id),'{}'::jsonb),
 'events',COALESCE((SELECT jsonb_agg(data ORDER BY event_id) FROM harness_run_events e WHERE e.tenant_id=t.tenant_id),'[]'::jsonb),
 'sequence',GREATEST(COALESCE((t.state->>'sequence')::bigint,0),
  COALESCE((SELECT cursor FROM harness_event_sequences s WHERE s.tenant_id=t.tenant_id),0),
  COALESCE((SELECT max(event_id) FROM harness_run_events e WHERE e.tenant_id=t.tenant_id),0))
),revision=revision+1;
INSERT INTO harness_sandbox_capacity(id,state)
SELECT 1,jsonb_build_object('entries',COALESCE(jsonb_object_agg(
 '['||to_jsonb(tenant_id)::text||','||to_jsonb(workspace_id)::text||']',
 jsonb_strip_nulls(jsonb_build_object('tenantId',tenant_id,'workspaceId',workspace_id,
 'userId',user_id,'state',state,'sandboxId',sandbox_id,'operation',operation,'updatedAt',updated_at))
),'{}'::jsonb)) FROM harness_sandbox_leases
ON CONFLICT(id) DO UPDATE SET state=excluded.state;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM harness_tenants t JOIN harness_sessions s ON s.tenant_id=t.tenant_id
   WHERE t.state->'sessions'->s.session_id IS DISTINCT FROM s.data) OR
 EXISTS(SELECT 1 FROM harness_tenants t JOIN harness_runs r ON r.tenant_id=t.tenant_id
   WHERE t.state->'runs'->r.run_id IS DISTINCT FROM r.data) OR
 EXISTS(SELECT 1 FROM harness_tenants t WHERE
   jsonb_array_length(t.state->'events')<>(SELECT count(*) FROM harness_run_events e WHERE e.tenant_id=t.tenant_id)) THEN
   RAISE EXCEPTION 'Rollback aggregate verification failed';
 END IF;
END $$;
UPDATE harness_schema SET version=1 WHERE id=1;
COMMIT;
