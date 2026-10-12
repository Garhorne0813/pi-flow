-- Stop old writers before upgrading. Every legacy version becomes its own logical
-- Agent; an administrator can then publish successors against that stable ID.
UPDATE harness_tenants t SET state = jsonb_set(
 jsonb_set(t.state, '{logicalAgents}', COALESCE(t.state->'logicalAgents','{}'::jsonb) ||
   COALESCE((SELECT jsonb_object_agg(k,jsonb_build_object('id',k,'activeVersionId',k))
     FROM jsonb_each(t.state->'agents') a(k,v)
     WHERE NOT (v ? 'agentId') AND NOT (COALESCE(t.state->'logicalAgents','{}'::jsonb) ? k)), '{}'::jsonb)),
 '{agents}', COALESCE((SELECT jsonb_object_agg(k,CASE WHEN v ? 'agentId' THEN v
   ELSE v || jsonb_build_object('agentId',k) END)
   FROM jsonb_each(t.state->'agents') a(k,v)), '{}'::jsonb));
UPDATE harness_sessions s SET data = s.data || jsonb_build_object(
 'agentId',COALESCE(s.data->>'agentId',t.state->'agents'->(s.data->>'agentVersionId')->>'agentId',s.data->>'agentVersionId'),
 'effectiveVersionId',COALESCE(s.data->>'effectiveVersionId',s.data->>'agentVersionId'))
 FROM harness_tenants t WHERE t.tenant_id=s.tenant_id;
UPDATE harness_runs r SET data=r.data || jsonb_build_object(
 'agentVersionId',COALESCE(r.data->>'agentVersionId',s.data->>'agentVersionId'),
 'capabilities',COALESCE(r.data->'capabilities',t.state->'agents'->(s.data->>'agentVersionId')->'config'))
 FROM harness_sessions s,harness_tenants t
 WHERE s.tenant_id=r.tenant_id AND s.session_id=r.session_id AND t.tenant_id=r.tenant_id;
-- Continuations follow Interaction.runId, children follow parentRunId. Traverse
-- both edges to preserve complete pre-upgrade task chains, including waiting ones.
WITH RECURSIVE edges AS (
 SELECT r.tenant_id,r.run_id,COALESCE(r.data->>'parentRunId',
   t.state->'interactions'->(r.data->>'resumedFrom')->>'runId') AS predecessor
 FROM harness_runs r JOIN harness_tenants t USING(tenant_id)
), chains AS (
 SELECT tenant_id,run_id,run_id AS root,ARRAY[run_id] AS path FROM edges WHERE predecessor IS NULL
 UNION ALL
 SELECT e.tenant_id,e.run_id,c.root,c.path || e.run_id FROM edges e JOIN chains c
 ON e.tenant_id=c.tenant_id AND e.predecessor=c.run_id WHERE NOT e.run_id=ANY(c.path)
)
UPDATE harness_runs r SET data=r.data || jsonb_build_object(
 'taskId',COALESCE(r.data->>'taskId',c.root),'rootRunId',COALESCE(r.data->>'rootRunId',c.root))
 FROM chains c WHERE r.tenant_id=c.tenant_id AND r.run_id=c.run_id;
UPDATE harness_schema SET version=5 WHERE id=1;
