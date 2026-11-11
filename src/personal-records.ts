import type pg from "pg";
import { type State } from "./domain.js";

export async function loadRecords(
  c: pg.Pool | pg.PoolClient,
  user: string,
  s: State,
  keys: readonly string[],
  runId?: string,
) {
  if (keys.includes("audit"))
    s.audit = (
      await c.query(
        "SELECT data FROM personal_audit WHERE user_id=$1 ORDER BY data->>'timestamp',id",
        [user],
      )
    ).rows.map((r) => r.data);
  if (keys.includes("usage")) {
    const requests = await c.query(
      "SELECT data FROM personal_usage_requests WHERE user_id=$1" +
        (runId ? " AND run_id=$2" : ""),
      runId ? [user, runId] : [user],
    );
    const resources = await c.query(
      "SELECT data FROM personal_resource_transitions WHERE user_id=$1" +
        (runId ? " AND data->>'workspaceId'=$2" : "") +
        " ORDER BY id",
      runId
        ? [user, s.sessions[s.runs[runId]?.sessionId ?? ""]?.workspaceId ?? ""]
        : [user],
    );
    s.usage = {
      requests: Object.fromEntries(
        requests.rows.map(({ data }) => [data.id, data]),
      ),
      resources: resources.rows.map((r) => r.data),
    };
  }
}
export async function saveRecords(
  c: pg.PoolClient,
  user: string,
  before: State,
  after: State,
) {
  const oldAudit = new Set(before.audit.map((a) => a.id));
  const added = after.audit.filter((a) => !oldAudit.has(a.id));
  if (added.length)
    await c.query(
      "INSERT INTO personal_audit(user_id,id,data) SELECT $1,v->>'id',v FROM jsonb_array_elements($2::jsonb) v ON CONFLICT DO NOTHING",
      [user, JSON.stringify(added)],
    );
  const changed = Object.values(after.usage?.requests ?? {}).filter(
    (r) => JSON.stringify(before.usage?.requests[r.id]) !== JSON.stringify(r),
  );
  for (const r of changed)
    await c.query(
      "INSERT INTO personal_usage_requests(user_id,id,run_id,at,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data",
      [user, r.id, r.runId, r.at, JSON.stringify(r)],
    );
  const resources = (after.usage?.resources ?? []).slice(
    before.usage?.resources.length ?? 0,
  );
  if (resources.length)
    await c.query(
      "INSERT INTO personal_resource_transitions(user_id,data) SELECT $1,v FROM jsonb_array_elements($2::jsonb) v",
      [user, JSON.stringify(resources)],
    );
  for (const [wid, w] of Object.entries(after.workspaces))
    if (JSON.stringify(w) !== JSON.stringify(before.workspaces[wid]))
      await c.query(
        "INSERT INTO personal_workspace_runtime(user_id,workspace_id,data,last_used_at,sandbox_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,workspace_id) DO UPDATE SET data=excluded.data,last_used_at=excluded.last_used_at,sandbox_id=excluded.sandbox_id",
        [
          user,
          wid,
          JSON.stringify(w),
          w.sandboxLastUsedAt ?? null,
          w.sandboxId ?? null,
        ],
      );
  for (const wid of Object.keys(before.workspaces))
    if (!after.workspaces[wid])
      await c.query(
        "DELETE FROM personal_workspace_runtime WHERE user_id=$1 AND workspace_id=$2",
        [user, wid],
      );
}
export async function appendRecordAudit(
  c: pg.Pool,
  user: string,
  entry: State["audit"][number],
) {
  await c.query(
    "INSERT INTO personal_audit(user_id,id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [user, entry.id, JSON.stringify(entry)],
  );
}
