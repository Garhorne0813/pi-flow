// Bound every candidate source before the small final fairness sort.
export const runWorkQuery = `WITH candidates AS (
 (SELECT user_id,queued_run_id AS run_id,1 AS priority FROM personal_run_work
  WHERE queued_run_id IS NOT NULL AND user_id>$2 ORDER BY user_id LIMIT $3)
 UNION ALL
 (SELECT user_id,queued_run_id AS run_id,1 AS priority FROM personal_run_work
  WHERE queued_run_id IS NOT NULL AND user_id<=$2 ORDER BY user_id LIMIT $3)
 UNION ALL
 (SELECT user_id,lease_run_id AS run_id,0 AS priority FROM personal_run_work
  WHERE lease_run_id IS NOT NULL AND lease_expires<$1 ORDER BY lease_expires,user_id LIMIT $3)
) SELECT user_id AS "user",run_id AS "runId" FROM candidates
 ORDER BY (user_id>$2) DESC,user_id,priority LIMIT $3`;
export const sandboxMaintenanceQuery = `WITH due AS MATERIALIZED (
 SELECT ctid AS row_tid FROM personal_workspace_runtime
 WHERE sandbox_id IS NOT NULL AND NOT COALESCE((data->>'deleting')::boolean,false)
 AND (last_used_at IS NULL OR last_used_at<=$1::bigint-$3::bigint OR
   (last_used_at<=$1::bigint-$2::bigint AND COALESCE(data->>'sandboxState','active') NOT IN ('paused','unknown')))
 ORDER BY checked_at,last_used_at NULLS FIRST,user_id,workspace_id LIMIT 128 FOR UPDATE SKIP LOCKED
) UPDATE personal_workspace_runtime SET checked_at=$1
 WHERE ctid=ANY(ARRAY(SELECT row_tid FROM due))
 RETURNING user_id AS "user",data AS workspace`;
export const scheduleFireHistoryQuery = `SELECT data FROM personal_schedule_fires
 WHERE user_id=$1 AND schedule_id=$2 AND (scheduled_for,id)<($3::bigint,$4::text)
 ORDER BY scheduled_for DESC,id DESC LIMIT $5`;
