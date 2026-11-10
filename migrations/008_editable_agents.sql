-- Agent configuration is mutable. Historical execution semantics live on Runs.
-- Keep v5 version/publication tables as archives; the runtime stops writing them.
CREATE TABLE IF NOT EXISTS personal_agents(id text PRIMARY KEY,data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS personal_migration_flags(name text PRIMARY KEY);
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM personal_migration_flags WHERE name='editable-agents-v6') THEN
  INSERT INTO personal_agents(id,data)
  SELECT d.key,jsonb_build_object(
   'id',d.key,'config',v.config,
   'enabled',COALESCE((d.value->>'enabled')::boolean,false) AND v.enabled,
   'allowedUsers',t.document->'agents'->v.id::text->'allowedUsers',
   'updatedAt',v.published_at)
  FROM platform_config t CROSS JOIN LATERAL jsonb_each(COALESCE(t.document->'definitions','{}'::jsonb)) d
  JOIN personal_agent_versions v ON v.id::text=d.value->>'activeVersionId'
  WHERE t.scope='runtime'
  ON CONFLICT(id) DO NOTHING;

  -- Preserve any previously resolved model in the Run snapshot.
  UPDATE personal_runs r SET data=r.data || jsonb_build_object(
   'agentId',COALESCE(r.data->>'agentId',v.agent_id,s.data->>'agentId'),
   'capabilities',COALESCE(NULLIF(r.data->'capabilities','null'::jsonb),
     v.config || CASE WHEN jsonb_typeof(r.data->'model')='object' THEN jsonb_build_object('model',r.data->'model') ELSE '{}'::jsonb END))
  FROM personal_sessions s,personal_agent_versions v
  WHERE s.user_id=r.user_id AND s.session_id=r.session_id
   AND v.id::text=COALESCE(r.data->>'agentVersionId',s.data->>'agentVersionId');

  UPDATE personal_sessions s SET data=(s.data-'agentVersionId'-'effectiveVersionId') ||
    jsonb_build_object('agentId',COALESCE(s.data->>'agentId',v.agent_id))
  FROM personal_agent_versions v WHERE v.id::text=s.data->>'agentVersionId';

  UPDATE platform_config SET document=document-'agents'-'definitions'-'publications'-'managedAgents'
   WHERE scope='runtime';
  INSERT INTO personal_migration_flags VALUES('editable-agents-v6');
 END IF;
END $$;
UPDATE personal_schema SET version=6 WHERE id=1;
