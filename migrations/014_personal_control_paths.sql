-- Stable Audit keyset/offset pages and task-local control/execution snapshots.
CREATE INDEX IF NOT EXISTS personal_audit_page
 ON personal_audit(user_id,(data->>'timestamp'),id);
CREATE INDEX IF NOT EXISTS personal_runs_task_identity
 ON personal_runs(user_id,(COALESCE(data->>'taskId',data->>'rootRunId',run_id)),run_id);
UPDATE personal_schema SET version=12 WHERE id=1;
