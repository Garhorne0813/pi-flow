import type pg from "pg";
import { emptyState, Fault, type State } from "./domain.js";
export type ExecutionScope = {
  usage?: boolean;
  interactionId?: string;
  admission?: boolean;
  requestId?: string;
  completionEvents?: boolean;
};
export async function executionState(
  c: pg.PoolClient,
  user: string,
  runId: string,
  scope: ExecutionScope = {},
): Promise<State> {
  const meta = await c.query(
    "SELECT jsonb_build_object('workspaces',state->'workspaces') AS state, state->'interactions'->$2::text AS interaction FROM personal_user_state WHERE user_id=$1 FOR NO KEY UPDATE",
    [user, scope.interactionId ?? null],
  );
  if (scope.interactionId) {
    const interaction = meta.rows[0]?.interaction;
    if (!interaction) throw new Fault(404, "INTERACTION_NOT_FOUND");
    runId = interaction.runId;
  }
  if (scope.requestId)
    runId =
      (
        await c.query(
          "SELECT run_id FROM personal_usage_requests WHERE user_id=$1 AND id=$2",
          [user, scope.requestId],
        )
      ).rows[0]?.run_id ?? runId;
  const target = (
    await c.query(
      "SELECT data FROM personal_runs WHERE user_id=$1 AND run_id=$2",
      [user, runId],
    )
  ).rows[0]?.data;
  const s: State = { ...emptyState(), ...meta.rows[0]?.state };
  if (scope.interactionId)
    s.interactions[scope.interactionId] = meta.rows[0].interaction;
  if (!target) return s;
  const task = target.taskId ?? target.rootRunId ?? target.id;
  const runs = await c.query(
    "SELECT data FROM personal_runs WHERE user_id=$1 AND (COALESCE(data->>'taskId',data->>'rootRunId',run_id)=$2 OR run_id=ANY($3::text[])) ORDER BY run_id FOR UPDATE",
    [user, task, [runId, target.rootRunId, target.parentRunId].filter(Boolean)],
  );
  s.runs = Object.fromEntries(runs.rows.map(({ data }) => [data.id, data]));
  if (scope.admission) {
    const busy = await c.query(
      "SELECT data FROM personal_runs WHERE user_id=$1 AND session_id=$2 AND state IN ('QUEUED','RUNNING','WAITING_INPUT') ORDER BY run_id FOR UPDATE",
      [user, target.sessionId],
    );
    for (const { data } of busy.rows) s.runs[data.id] = data;
  }
  const sessionIds = [
    ...new Set(Object.values(s.runs).map((r) => r.sessionId)),
  ];
  const sessions = await c.query(
    "SELECT data-'entries' AS data FROM personal_sessions WHERE user_id=$1 AND session_id=ANY($2::text[]) ORDER BY session_id FOR UPDATE",
    [user, sessionIds],
  );
  s.sessions = Object.fromEntries(
    sessions.rows.map(({ data }) => [data.id, data]),
  );
  const aux = await c.query(
    `SELECT jsonb_build_object('todos',COALESCE((SELECT jsonb_object_agg(k,v) FROM jsonb_each(COALESCE(state->'todos','{}'::jsonb)) e(k,v) WHERE k=ANY($2::text[])),'{}'::jsonb),
    'interactions',CASE WHEN $4::text IS NOT NULL THEN jsonb_build_object($4::text,state->'interactions'->$4::text) ELSE COALESCE((SELECT jsonb_object_agg(k,v) FROM jsonb_each(COALESCE(state->'interactions','{}'::jsonb)) e(k,v) WHERE v->>'runId'=ANY($3::text[])),'{}'::jsonb) END) AS state FROM personal_user_state WHERE user_id=$1`,
    [user, sessionIds, Object.keys(s.runs), scope.interactionId ?? null],
  );
  Object.assign(s, aux.rows[0]?.state);
  if (scope.completionEvents)
    s.events = (
      await c.query(
        "SELECT data FROM personal_run_events WHERE user_id=$1 AND run_id=ANY($2::text[]) AND data->>'type'='message.completed' ORDER BY event_id",
        [user, Object.keys(s.runs)],
      )
    ).rows.map((r) => r.data);
  if (scope.usage) {
    const records = await c.query(
      scope.requestId
        ? "SELECT data FROM personal_usage_requests WHERE user_id=$1 AND id=$2 FOR UPDATE"
        : "SELECT data FROM personal_usage_requests WHERE user_id=$1 AND run_id=ANY($2::text[])",
      [user, scope.requestId ?? Object.keys(s.runs)],
    );
    s.usage = {
      requests: Object.fromEntries(
        records.rows.map(({ data }) => [data.id, data]),
      ),
      resources: [],
    };
    if (!scope.requestId) {
      const other = await c.query(
        `SELECT left(at,10) AS day,SUM((data->>'tokens')::bigint)::float8 AS tokens,
        CASE WHEN bool_or(data->>'costMicros' IS NULL) THEN NULL ELSE SUM(COALESCE((data->>'costMicros')::bigint,(data->>'estimatedCostMicros')::bigint,0))::float8 END AS cost
        FROM personal_usage_requests WHERE user_id=$1 AND at >= $2 AND NOT(run_id=ANY($3::text[])) GROUP BY left(at,10)`,
        [user, new Date().toISOString().slice(0, 7), Object.keys(s.runs)],
      );
      for (const r of other.rows) {
        const key = "budget:" + r.day;
        s.usage.requests[key] = {
          id: key,
          runId: "outside-task",
          userId: target.actor.userId,
          workspaceId: "",
          agentId: "",
          model: "",
          at: r.day,
          status: "confirmed",
          estimatedTokens: r.tokens,
          tokens: r.tokens,
          maxOutputTokens: 0,
          estimatedCostMicros: r.cost,
          costMicros: r.cost,
          pricingVersion: null,
        };
      }
    }
  }
  return s;
}
export async function saveExecutionMetadata(
  c: pg.PoolClient,
  user: string,
  before: State,
  after: State,
) {
  for (const key of ["workspaces", "todos", "interactions"] as const) {
    const changed = Object.fromEntries(
      Object.entries(after[key]).filter(
        ([id, v]) => JSON.stringify(before[key][id]) !== JSON.stringify(v),
      ),
    );
    if (Object.keys(changed).length)
      await c.query(
        "UPDATE personal_user_state SET state=jsonb_set(state,ARRAY[$2],COALESCE(state->$2,'{}'::jsonb)||$3::jsonb),revision=revision+1 WHERE user_id=$1",
        [user, key, JSON.stringify(changed)],
      );
  }
}
