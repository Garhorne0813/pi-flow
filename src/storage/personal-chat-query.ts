import type pg from "pg";
import { Fault } from "../domain/model.js";

// Page each source independently before merging; never load a user's full State.
export async function chatSources(
  pool: pg.Pool,
  user: string,
  sid: string,
  limit: number,
  before?: string[],
) {
  const access = await pool.query(
    `SELECT 1 FROM personal_sessions WHERE user_id=$1 AND session_id=$2 AND COALESCE(data->>'deletedAt','')=''`,
    [user, sid],
  );
  if (!access.rowCount) throw new Fault(404, "SESSION_NOT_FOUND");
  const result = await pool.query(
    `WITH roots AS (
    SELECT data->>'createdAt' AS at,'run:'||run_id AS id,jsonb_build_object('kind','user','id','run:'||run_id,'runId',run_id,'taskId',COALESCE(data->>'taskId',run_id),'text',left(data->>'prompt',32000),'createdAt',data->>'createdAt') AS item
    FROM personal_runs WHERE user_id=$1 AND session_id=$2 AND data->>'parentRunId' IS NULL AND data->>'resumedFrom' IS NULL AND data->>'schedule' IS NULL
    AND ($3::text IS NULL OR (data->>'createdAt','run:'||run_id)<($3,$4)) ORDER BY data->>'createdAt' DESC,run_id DESC LIMIT $5
  ), events AS (
    SELECT e.data->>'timestamp' AS at,'event:'||e.event_id AS id,e.data AS item
    FROM personal_runs r JOIN personal_run_events e USING(user_id,run_id)
    WHERE r.user_id=$1 AND r.session_id=$2 AND e.data->>'type' IN ('message.completed','tool.started','tool.completed','tool.failed','interaction.required','interaction.resolved','run.failed','run.cancelled','subagent.completed')
    AND ($3::text IS NULL OR (e.data->>'timestamp','event:'||e.event_id)<($3,$4))
    ORDER BY e.data->>'timestamp' DESC,('event:'||e.event_id) DESC LIMIT $5
  ) SELECT * FROM (SELECT * FROM roots UNION ALL SELECT * FROM events) sources ORDER BY at DESC,id DESC LIMIT $5`,
    [user, sid, before?.[0] ?? null, before?.[1] ?? null, limit + 1],
  );
  const rows = result.rows.slice(0, limit);
  return {
    rows,
    next:
      result.rows.length > limit ? [rows.at(-1)!.at, rows.at(-1)!.id] : null,
  };
}
export async function activeChatTask(pool: pg.Pool, user: string, sid: string) {
  const result = await pool.query(
    `SELECT r.run_id AS id,r.state,r.data->>'taskId' AS "taskId",r.data->>'createdAt' AS "createdAt"
    FROM personal_runs r JOIN personal_sessions s USING(user_id,session_id)
    WHERE r.user_id=$1 AND r.session_id=$2 AND COALESCE(s.data->>'deletedAt','')='' AND r.state IN ('QUEUED','RUNNING','WAITING_INPUT') AND r.data->>'parentRunId' IS NULL
    ORDER BY r.created_at DESC,r.run_id DESC LIMIT 1`,
    [user, sid],
  );
  return result.rows[0] ?? null;
}
