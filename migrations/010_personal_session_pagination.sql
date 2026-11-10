-- Fetch only a page of live Session metadata, with deterministic timestamp ties.
CREATE INDEX IF NOT EXISTS personal_sessions_list
 ON personal_sessions(user_id,((data->>'createdAt')) DESC,session_id DESC)
 WHERE COALESCE(data->>'deletedAt','')='';
UPDATE personal_schema SET version=8 WHERE id=1;
