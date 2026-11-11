import type pg from "pg";
import { loadRecords, saveRecords } from "./personal-records.js";
import { emptyState, type State, type Run } from "../domain/model.js";
export function metadata(s: State) {
  const {
    runs,
    sessions,
    events,
    schedules,
    scheduleFires,
    audit,
    usage,
    ...rest
  } = s;
  return rest;
}
export async function loadState(
  c: pg.PoolClient,
  tenant: string,
  lock = false,
  runId?: string,
  targetLock = true,
  options: { claim?: boolean; workspaceOnly?: boolean; entries?: boolean } = {},
): Promise<State> {
  const row = await c.query(
    (options.claim || options.workspaceOnly || runId
      ? "SELECT jsonb_build_object('workspaces',state->'workspaces') AS state"
      : "SELECT state") +
      " FROM personal_user_state WHERE user_id=$1" +
      (lock ? " FOR NO KEY UPDATE" : runId && targetLock ? " FOR SHARE" : ""),
    [tenant],
  );
  const s = { ...emptyState(), ...row.rows[0]?.state } as State;
  if (options.workspaceOnly) {
    // Same metadata row lock as Run admission, so file lease acquisition and
    // the active-Run check remain atomic across API/Worker clients.
    const active = await c.query(
      `WITH RECURSIVE active AS (
      SELECT data FROM personal_runs WHERE user_id=$1 AND state NOT IN ('COMPLETED','FAILED','CANCELLED')
      UNION SELECT p.data FROM personal_runs p JOIN active a ON p.run_id=a.data->>'parentRunId' OR p.run_id=a.data->>'rootRunId' WHERE p.user_id=$1
    ) SELECT data FROM active`,
      [tenant],
    );
    s.runs = Object.fromEntries(active.rows.map(({ data }) => [data.id, data]));
    const sessions = await c.query(
      "SELECT data-'entries' AS data FROM personal_sessions WHERE user_id=$1 AND session_id=ANY($2::text[])",
      [tenant, [...new Set(active.rows.map((r) => r.data.sessionId))]],
    );
    s.sessions = Object.fromEntries(
      sessions.rows.map(({ data }) => [data.id, data]),
    );
    return s;
  }
  const runs = await c.query(
    "SELECT data FROM personal_runs WHERE user_id=$1" +
      (runId
        ? " AND run_id=$2" + (targetLock ? " FOR UPDATE" : "")
        : lock
          ? " ORDER BY run_id FOR UPDATE"
          : ""),
    runId ? [tenant, runId] : [tenant],
  );
  s.runs = Object.fromEntries(runs.rows.map((row) => [row.data.id, row.data]));
  if (runId && s.runs[runId]) {
    const parents = await c.query(
      `WITH RECURSIVE chain AS (
      SELECT run_id,data FROM personal_runs WHERE user_id=$1 AND run_id=$2
      UNION
      SELECT p.run_id,p.data FROM personal_runs p JOIN chain child ON (child.data->>'parentRunId'=p.run_id OR child.data->>'rootRunId'=p.run_id) WHERE p.user_id=$1
    ) SELECT data FROM chain`,
      [tenant, runId],
    );
    for (const row of parents.rows)
      if (row.data.id !== runId) s.runs[row.data.id] = row.data;
  }
  const sessionIds = [
    ...new Set(Object.values(s.runs).map((r) => r.sessionId)),
  ];
  const sessions = await c.query(
    "SELECT " +
      (options.claim || (runId && !options.entries)
        ? "data - 'entries' AS data"
        : "data") +
      " FROM personal_sessions WHERE user_id=$1" +
      (runId
        ? " AND session_id=ANY($2::text[])"
        : lock
          ? " ORDER BY session_id FOR UPDATE"
          : ""),
    runId ? [tenant, sessionIds] : [tenant],
  );
  s.sessions = Object.fromEntries(
    sessions.rows.map((row) => [row.data.id, row.data]),
  );
  s.events = runId
    ? []
    : (
        await c.query(
          "SELECT data FROM personal_run_events WHERE user_id=$1" +
            (runId ? " AND run_id=$2" : "") +
            " ORDER BY event_id",
          runId ? [tenant, runId] : [tenant],
        )
      ).rows.map((row) => row.data);
  if (!runId) {
    await loadRecords(c, tenant, s, ["audit", "usage"]);
    const tasks = await c.query(
      "SELECT data FROM personal_scheduled_tasks WHERE user_id=$1",
      [tenant],
    );
    const fires = await c.query(
      "SELECT data FROM personal_schedule_fires WHERE user_id=$1",
      [tenant],
    );
    s.schedules = Object.fromEntries(
      tasks.rows.map(({ data }) => [data.id, data]),
    );
    s.scheduleFires = Object.fromEntries(
      fires.rows.map(({ data }) => [fireKey(data), data]),
    );
  }
  const seq = await c.query(
    "SELECT cursor FROM personal_event_sequences WHERE user_id=$1",
    [tenant],
  );
  s.sequence = Math.max(s.sequence, Number(seq.rows[0]?.cursor ?? 0));
  return s;
}
export async function saveRun(c: pg.PoolClient, tenant: string, r: Run) {
  await c.query(
    `INSERT INTO personal_runs(user_id,run_id,session_id,actor_id,idempotency_key,state,lease_owner,lease_expires,created_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id,run_id) DO UPDATE SET state=excluded.state,lease_owner=excluded.lease_owner,lease_expires=excluded.lease_expires,data=excluded.data`,
    [
      tenant,
      r.id,
      r.sessionId,
      r.actor.userId,
      r.key ?? null,
      r.state,
      r.lease?.owner ?? null,
      r.lease?.expires ?? null,
      r.createdAt,
      JSON.stringify(r),
    ],
  );
}
export async function saveEvents(
  c: pg.PoolClient,
  tenant: string,
  before: State,
  after: State,
) {
  const ids = new Set(before.events.map((e) => e.eventId)),
    newEvents = after.events.filter((e) => !ids.has(e.eventId));
  if (!newEvents.length) return;
  const allocated = await c.query(
    "INSERT INTO personal_event_sequences(user_id,cursor) VALUES($1,$2::bigint+$3::bigint) ON CONFLICT(user_id) DO UPDATE SET cursor=GREATEST(personal_event_sequences.cursor,$2::bigint)+$3::bigint RETURNING cursor",
    [tenant, before.sequence, newEvents.length],
  );
  let cursor = Number(allocated.rows[0].cursor) - newEvents.length;
  for (const runId of new Set(newEvents.map((e) => e.runId))) {
    const group = newEvents.filter((e) => e.runId === runId);
    const allocated = await c.query(
      "INSERT INTO personal_run_event_counters(user_id,run_id,cursor) VALUES($1,$2,$3) ON CONFLICT(user_id,run_id) DO UPDATE SET cursor=personal_run_event_counters.cursor+$3 RETURNING cursor",
      [tenant, runId, group.length],
    );
    let seq = Number(allocated.rows[0].cursor) - group.length;
    for (const e of group) e.seq = ++seq;
  }
  for (const e of newEvents) e.eventId = ++cursor;
  await c.query(
    "INSERT INTO personal_run_events(user_id,run_id,event_id,data) SELECT $1,v->>'runId',(v->>'eventId')::bigint,v FROM jsonb_array_elements($2::jsonb) v",
    [tenant, JSON.stringify(newEvents)],
  );
  after.sequence = Math.max(after.sequence, cursor);
  for (const runId of new Set(newEvents.map((e) => e.runId)))
    await c.query("SELECT pg_notify('harness_run_event',$1)", [
      JSON.stringify([tenant, runId]),
    ]);
}
export async function saveState(
  c: pg.PoolClient,
  tenant: string,
  before: State,
  after: State,
  skipMetadata = false,
) {
  for (const [sid, s] of Object.entries(after.sessions))
    if (JSON.stringify(before.sessions[sid]) !== JSON.stringify(s))
      await c.query(
        "INSERT INTO personal_sessions(user_id,session_id,workspace_id,data) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,session_id) DO UPDATE SET data=excluded.data",
        [tenant, sid, s.workspaceId, JSON.stringify(s)],
      );
  for (const [rid, r] of Object.entries(after.runs)) {
    if (before.runs[rid]?.eventSeq === undefined) delete r.eventSeq;
    else r.eventSeq = before.runs[rid]!.eventSeq;
  }
  for (const [rid, r] of Object.entries(after.runs))
    if (JSON.stringify(before.runs[rid]) !== JSON.stringify(r))
      await saveRun(c, tenant, r);
  for (const task of Object.values(after.schedules ?? {}))
    if (JSON.stringify(task) !== JSON.stringify(before.schedules?.[task.id]))
      await c.query(
        "INSERT INTO personal_scheduled_tasks(user_id,schedule_id,data) VALUES($1,$2,$3) ON CONFLICT(user_id,schedule_id) DO UPDATE SET data=excluded.data",
        [tenant, task.id, JSON.stringify(task)],
      );
  for (const sid of Object.keys(before.schedules ?? {}))
    if (!after.schedules?.[sid])
      await c.query(
        "DELETE FROM personal_scheduled_tasks WHERE user_id=$1 AND schedule_id=$2",
        [tenant, sid],
      );
  const oldFires = new Map(
    Object.values(before.scheduleFires ?? {}).map((f) => [f.id, f]),
  );
  for (const fire of Object.values(after.scheduleFires ?? {}))
    if (JSON.stringify(fire) !== JSON.stringify(oldFires.get(fire.id)))
      await c.query(
        "INSERT INTO personal_schedule_fires(user_id,id,schedule_id,trigger,scheduled_for,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data",
        [
          tenant,
          fire.id,
          fire.scheduleId,
          fire.trigger,
          fire.scheduledFor,
          JSON.stringify(fire),
        ],
      );
  await saveEvents(c, tenant, before, after);
  await saveRecords(c, tenant, before, after);
  if (
    !skipMetadata &&
    JSON.stringify(metadata(before)) !== JSON.stringify(metadata(after))
  )
    await c.query(
      "UPDATE personal_user_state SET state=$2,revision=revision+1 WHERE user_id=$1",
      [tenant, JSON.stringify(metadata(after))],
    );
}
export const fireKey = (f: import("../schedules/service.js").Fire) =>
  `${f.scheduleId}:${f.trigger}:${f.scheduledFor}`;

export const scheduleWorkQuery = `
SELECT user_id,schedule_id FROM (
 (SELECT user_id,schedule_id FROM personal_scheduled_tasks
  WHERE (data->>'enabled')::boolean AND (data->>'nextFireAt')::bigint <= $1
  ORDER BY (data->>'nextFireAt')::bigint,user_id,schedule_id LIMIT $2)
 UNION
 (SELECT f.user_id,f.schedule_id FROM personal_schedule_fires f
  JOIN personal_runs r ON r.user_id=f.user_id AND r.run_id=f.data->>'runId'
  JOIN personal_scheduled_tasks t ON t.user_id=f.user_id AND t.schedule_id=f.schedule_id
  WHERE f.data->>'state'='submitted' AND r.state IN ('COMPLETED','FAILED','CANCELLED')
  ORDER BY f.user_id,f.schedule_id LIMIT $2)
) work ORDER BY user_id,schedule_id LIMIT $2`;

// One MVCC snapshot of the target/ancestors and only their authorization inputs.
// JSONB extraction still incurs server-side TOAST work until ACL metadata is split.
export const runSnapshotQuery = `
WITH RECURSIVE chain AS (
 SELECT data FROM personal_runs WHERE user_id=$1 AND run_id=$2
 UNION
 SELECT p.data FROM personal_runs p JOIN chain child
 ON (p.run_id=child.data->>'parentRunId' OR p.run_id=child.data->>'rootRunId') WHERE p.user_id=$1
), sessions AS (
 SELECT data FROM personal_sessions WHERE user_id=$1
 AND session_id IN (SELECT data->>'sessionId' FROM chain)
)
SELECT jsonb_build_object(
 'workspaces', COALESCE((SELECT jsonb_object_agg(wid,
   jsonb_build_object('id',wid,'members',t.state->'workspaces'->wid->'members',
     'deleting',t.state->'workspaces'->wid->'deleting'))
   FROM (SELECT DISTINCT data->>'workspaceId' AS wid FROM sessions) w
   WHERE t.state->'workspaces' ? wid), '{}'::jsonb)
) || CASE WHEN $6 THEN jsonb_build_object(
 'skills', COALESCE((SELECT jsonb_object_agg(sk,t.state->'skills'->sk)
   FROM (SELECT DISTINCT jsonb_array_elements_text(COALESCE(
     c.data->'capabilities'->'skills',
     '[]'::jsonb)) AS sk FROM chain c JOIN sessions s ON s.data->>'id'=c.data->>'sessionId') keys
   WHERE t.state->'skills' ? sk), '{}'::jsonb)
) ELSE '{}'::jsonb END AS state,
 COALESCE((SELECT jsonb_agg(CASE WHEN $6 THEN data ELSE jsonb_build_object(
 'id',data->'id','sessionId',data->'sessionId','state',data->'state') END) FROM chain), '[]'::jsonb) AS runs,
 COALESCE((SELECT jsonb_agg(CASE WHEN $5 THEN data ELSE data - 'entries' END)
   FROM sessions), '[]'::jsonb) AS sessions,
 COALESCE((SELECT jsonb_agg(page.data ORDER BY page.event_id) FROM (
   SELECT data,event_id FROM personal_run_events WHERE user_id=$1 AND run_id=$2
   AND event_id>$3 ORDER BY event_id LIMIT $4
 ) page), '[]'::jsonb) AS events
FROM personal_user_state t WHERE t.user_id=$1`;
// Authorization reads never open the Event relation, even for LIMIT 0.
export const authorizationSnapshotQuery = runSnapshotQuery.replace(
  "FROM personal_run_events",
  "FROM (SELECT $1::text AS user_id,$2::text AS run_id,0::bigint AS event_id,'{}'::jsonb AS data WHERE false) no_events",
);
export function snapshotState(row?: {
  state: Partial<State>;
  runs: Run[];
  sessions: State["sessions"][string][];
}) {
  return {
    ...emptyState(),
    ...row?.state,
    runs: Object.fromEntries((row?.runs ?? []).map((r) => [r.id, r])),
    sessions: Object.fromEntries((row?.sessions ?? []).map((s) => [s.id, s])),
  } as State;
}
export const claimableRunsQuery = `
SELECT run_id FROM (
 (SELECT run_id, 0 AS priority, lease_expires AS due FROM personal_runs
  WHERE user_id=$1 AND lease_owner IS NOT NULL AND lease_expires<$2 AND state<>'QUEUED'
  ORDER BY lease_expires,run_id LIMIT $3)
 UNION ALL
 (SELECT run_id, 1 AS priority, (extract(epoch FROM created_at)*1000)::bigint AS due FROM personal_runs
  WHERE user_id=$1 AND state='QUEUED' ORDER BY created_at,run_id LIMIT $3)
) candidates ORDER BY priority,due,run_id LIMIT $3`;
