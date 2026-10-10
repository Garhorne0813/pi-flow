import type pg from "pg";
import { emptyState, type State, type Run, type Event } from "./domain.js";
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
  const sessionIds = [...new Set(Object.values(s.runs).map(r => r.sessionId))];
  const sessions = await c.query(
    "SELECT " + (runId && !targetLock ? "data - 'entries' AS data" : "data") +
      " FROM harness_sessions WHERE tenant_id=$1" +
      (runId ? " AND session_id=ANY($2::text[])" : lock ? " ORDER BY session_id FOR UPDATE" : ""),
    runId ? [tenant, sessionIds] : [tenant],
  );
  s.sessions = Object.fromEntries(sessions.rows.map(row => [row.data.id, row.data]));
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
