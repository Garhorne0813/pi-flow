import type pg from "pg";
import { emptyState, type State, type Run } from "./domain.js";
export function metadata(s: State) {
  const { runs, sessions, events, ...rest } = s;
  return rest;
}
export async function loadState(
  c: pg.PoolClient,
  tenant: string,
  lock = false,
  runId?: string,
  targetLock = true,
): Promise<State> {
  const row = await c.query(
    "SELECT state FROM harness_tenants WHERE tenant_id=$1" +
      (lock ? " FOR UPDATE" : runId && targetLock ? " FOR SHARE" : ""),
    [tenant],
  );
  const s = { ...emptyState(), ...row.rows[0]?.state } as State;
  const runs = await c.query(
    "SELECT data FROM harness_runs WHERE tenant_id=$1" +
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
      SELECT run_id,data FROM harness_runs WHERE tenant_id=$1 AND run_id=$2
      UNION
      SELECT p.run_id,p.data FROM harness_runs p JOIN chain child ON child.data->>'parentRunId'=p.run_id WHERE p.tenant_id=$1
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
      (runId && !targetLock ? "data - 'entries' AS data" : "data") +
      " FROM harness_sessions WHERE tenant_id=$1" +
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
          "SELECT data FROM harness_run_events WHERE tenant_id=$1" +
            (runId ? " AND run_id=$2" : "") +
            " ORDER BY event_id",
          runId ? [tenant, runId] : [tenant],
        )
      ).rows.map((row) => row.data);
  const seq = await c.query(
    "SELECT cursor FROM harness_event_sequences WHERE tenant_id=$1",
    [tenant],
  );
  s.sequence = Math.max(s.sequence, Number(seq.rows[0]?.cursor ?? 0));
  return s;
}
export async function saveRun(c: pg.PoolClient, tenant: string, r: Run) {
  await c.query(
    `INSERT INTO harness_runs(tenant_id,run_id,session_id,user_id,idempotency_key,state,lease_owner,lease_expires,created_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,run_id) DO UPDATE SET state=excluded.state,lease_owner=excluded.lease_owner,lease_expires=excluded.lease_expires,data=excluded.data`,
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
    "INSERT INTO harness_event_sequences(tenant_id,cursor) VALUES($1,$2::bigint+$3::bigint) ON CONFLICT(tenant_id) DO UPDATE SET cursor=GREATEST(harness_event_sequences.cursor,$2::bigint)+$3::bigint RETURNING cursor",
    [tenant, before.sequence, newEvents.length],
  );
  let cursor = Number(allocated.rows[0].cursor) - newEvents.length;
  for (const e of newEvents) {
    e.eventId = ++cursor;
    await c.query(
      "INSERT INTO harness_run_events(tenant_id,run_id,event_id,data) VALUES($1,$2,$3,$4)",
      [tenant, e.runId, e.eventId, JSON.stringify(e)],
    );
  }
  after.sequence = Math.max(after.sequence, cursor);
}
export async function saveState(
  c: pg.PoolClient,
  tenant: string,
  before: State,
  after: State,
) {
  for (const [sid, s] of Object.entries(after.sessions))
    if (JSON.stringify(before.sessions[sid]) !== JSON.stringify(s))
      await c.query(
        "INSERT INTO harness_sessions(tenant_id,session_id,workspace_id,data) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,session_id) DO UPDATE SET data=excluded.data",
        [tenant, sid, s.workspaceId, JSON.stringify(s)],
      );
  for (const [rid, r] of Object.entries(after.runs))
    if (JSON.stringify(before.runs[rid]) !== JSON.stringify(r))
      await saveRun(c, tenant, r);
  await saveEvents(c, tenant, before, after);
  if (JSON.stringify(metadata(before)) !== JSON.stringify(metadata(after)))
    await c.query(
      "UPDATE harness_tenants SET state=$2,revision=revision+1 WHERE tenant_id=$1",
      [tenant, JSON.stringify(metadata(after))],
    );
}

// One MVCC snapshot of the target/ancestors and only their authorization inputs.
// JSONB extraction still incurs server-side TOAST work until ACL metadata is split.
export const runSnapshotQuery = `
WITH RECURSIVE chain AS (
 SELECT data FROM harness_runs WHERE tenant_id=$1 AND run_id=$2
 UNION
 SELECT p.data FROM harness_runs p JOIN chain child
 ON p.run_id=child.data->>'parentRunId' WHERE p.tenant_id=$1
), sessions AS (
 SELECT data FROM harness_sessions WHERE tenant_id=$1
 AND session_id IN (SELECT data->>'sessionId' FROM chain)
)
SELECT jsonb_build_object(
 'workspaces', COALESCE((SELECT jsonb_object_agg(wid,
   jsonb_build_object('id',wid,'members',t.state->'workspaces'->wid->'members',
     'deleting',t.state->'workspaces'->wid->'deleting'))
   FROM (SELECT DISTINCT data->>'workspaceId' AS wid FROM sessions) w
   WHERE t.state->'workspaces' ? wid), '{}'::jsonb)
) || CASE WHEN $6 THEN jsonb_build_object(
 'agents', COALESCE((SELECT jsonb_object_agg(aid,t.state->'agents'->aid)
   FROM (SELECT DISTINCT data->>'agentVersionId' AS aid FROM sessions) a
   WHERE t.state->'agents' ? aid), '{}'::jsonb),
 'skills', COALESCE((SELECT jsonb_object_agg(sk,t.state->'skills'->sk)
   FROM (SELECT DISTINCT jsonb_array_elements_text(COALESCE(
     COALESCE(c.data->'capabilities',t.state->'agents'->(s.data->>'agentVersionId')->'config')->'skills',
     '[]'::jsonb)) AS sk FROM chain c JOIN sessions s ON s.data->>'id'=c.data->>'sessionId') keys
   WHERE t.state->'skills' ? sk), '{}'::jsonb)
) ELSE '{}'::jsonb END AS state,
 COALESCE((SELECT jsonb_agg(CASE WHEN $6 THEN data ELSE jsonb_build_object(
 'id',data->'id','sessionId',data->'sessionId','state',data->'state') END) FROM chain), '[]'::jsonb) AS runs,
 COALESCE((SELECT jsonb_agg(CASE WHEN $5 THEN data ELSE data - 'entries' END)
   FROM sessions), '[]'::jsonb) AS sessions,
 COALESCE((SELECT jsonb_agg(page.data ORDER BY page.event_id) FROM (
   SELECT data,event_id FROM harness_run_events WHERE tenant_id=$1 AND run_id=$2
   AND event_id>$3 ORDER BY event_id LIMIT $4
 ) page), '[]'::jsonb) AS events
FROM harness_tenants t WHERE t.tenant_id=$1`;
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
 (SELECT run_id, 0 AS priority, lease_expires AS due FROM harness_runs
  WHERE tenant_id=$1 AND lease_owner IS NOT NULL AND lease_expires<$2 AND state<>'QUEUED'
  ORDER BY lease_expires,run_id LIMIT $3)
 UNION ALL
 (SELECT run_id, 1 AS priority, (extract(epoch FROM created_at)*1000)::bigint AS due FROM harness_runs
  WHERE tenant_id=$1 AND state='QUEUED' ORDER BY created_at,run_id LIMIT $3)
) candidates ORDER BY priority,due,run_id LIMIT $3`;
