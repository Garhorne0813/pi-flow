-- Additive read indexes; no execution schema or readiness version changes.
CREATE INDEX IF NOT EXISTS personal_chat_roots
 ON personal_runs(user_id,session_id,(data->>'createdAt') DESC,run_id DESC)
 WHERE data->>'parentRunId' IS NULL AND data->>'resumedFrom' IS NULL AND data->>'schedule' IS NULL;
CREATE INDEX IF NOT EXISTS personal_chat_events
 ON personal_run_events(user_id,run_id,(data->>'timestamp') DESC,('event:'||event_id) DESC)
 WHERE data->>'type' IN ('message.completed','tool.started','tool.completed','tool.failed','interaction.required','interaction.resolved','run.failed','run.cancelled','subagent.completed');
