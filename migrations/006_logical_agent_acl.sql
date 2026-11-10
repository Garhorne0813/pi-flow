-- ACL is governance of the logical Agent, not an immutable execution version.
-- Preserve an existing logical policy; legacy deployments inherit the CURRENT
-- active version's ACL, never a historical version selected during rollback.
UPDATE harness_tenants t SET state=jsonb_set(t.state,'{logicalAgents}',
 COALESCE((SELECT jsonb_object_agg(k, CASE WHEN v ? 'allowedUsers' THEN v ELSE
   v || jsonb_build_object('allowedUsers',COALESCE(t.state->'agents'->(v->>'activeVersionId')->'allowedUsers','[]'::jsonb)) END)
   FROM jsonb_each(COALESCE(t.state->'logicalAgents','{}'::jsonb)) l(k,v)), '{}'::jsonb));
UPDATE harness_schema SET version=6 WHERE id=1;
