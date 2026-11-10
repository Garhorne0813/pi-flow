-- Schedules and fires already have dedicated tables. Keep history out of the
-- metadata row read by Run admission and scheduler transactions.
INSERT INTO personal_scheduled_tasks(user_id,schedule_id,data)
 SELECT user_id,k,v FROM personal_user_state
 CROSS JOIN LATERAL jsonb_each(COALESCE(state->'schedules','{}'::jsonb)) AS e(k,v)
 ON CONFLICT DO NOTHING;
INSERT INTO personal_schedule_fires(user_id,id,schedule_id,trigger,scheduled_for,data)
 SELECT user_id,v->>'id',v->>'scheduleId',v->>'trigger',(v->>'scheduledFor')::bigint,v
 FROM personal_user_state
 CROSS JOIN LATERAL jsonb_each(COALESCE(state->'scheduleFires','{}'::jsonb)) AS e(k,v)
 ON CONFLICT DO NOTHING;
UPDATE personal_user_state SET state=state-'schedules'-'scheduleFires'
 WHERE state ? 'schedules' OR state ? 'scheduleFires';
CREATE INDEX IF NOT EXISTS personal_runs_running ON personal_runs(user_id,run_id) WHERE state='RUNNING';
CREATE INDEX IF NOT EXISTS personal_scheduled_tasks_due
 ON personal_scheduled_tasks(((data->>'nextFireAt')::bigint),user_id,schedule_id) WHERE (data->>'enabled')::boolean;
CREATE INDEX IF NOT EXISTS personal_schedule_fires_pending
 ON personal_schedule_fires(user_id,schedule_id,scheduled_for,id) WHERE data->>'state'='submitted';
