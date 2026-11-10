-- Offline upgrade: preserve taskIdentity's legacy parent/Interaction ancestry.
DO $$
BEGIN
 CREATE TEMP TABLE personal_legacy_task_roots ON COMMIT DROP AS
 WITH RECURSIVE ancestry AS (
  SELECT r.user_id,r.run_id AS target_id,r.run_id AS current_id,r.data,
   ARRAY[r.run_id]::text[] AS path,false AS cycle
  FROM personal_runs r WHERE r.data->>'taskId' IS NULL OR r.data->>'rootRunId' IS NULL
  UNION ALL
  SELECT a.user_id,a.target_id,p.run_id,p.data,a.path||p.run_id,p.run_id=ANY(a.path)
  FROM ancestry a JOIN personal_user_state u ON u.user_id=a.user_id
  JOIN personal_runs p ON p.user_id=a.user_id AND p.run_id=COALESCE(a.data->>'parentRunId',u.state->'interactions'->(a.data->>'resumedFrom')->>'runId')
  WHERE COALESCE(a.data->>'taskId',a.data->>'rootRunId') IS NULL AND NOT a.cycle
 ) SELECT DISTINCT ON (user_id,target_id) user_id,target_id,
 COALESCE(data->>'taskId',data->>'rootRunId',current_id) AS identity,cycle
 FROM ancestry ORDER BY user_id,target_id,cardinality(path) DESC;
 IF EXISTS(SELECT 1 FROM personal_legacy_task_roots WHERE cycle) THEN
  RAISE EXCEPTION 'Legacy personal Run cycle detected; repair before migration 015';
 END IF;
 UPDATE personal_runs r SET data=r.data||jsonb_build_object(
  'taskId',COALESCE(r.data->>'taskId',m.identity),
  'rootRunId',COALESCE(r.data->>'rootRunId',m.identity))
 FROM personal_legacy_task_roots m WHERE r.user_id=m.user_id AND r.run_id=m.target_id;
END $$;
-- Count failures without scanning successful/text/history event rows.
CREATE INDEX IF NOT EXISTS personal_tool_failures ON personal_run_events(user_id,event_id)
 WHERE data->>'type'='tool.failed';
UPDATE personal_schema SET version=13 WHERE id=1;
