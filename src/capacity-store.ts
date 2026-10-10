import type pg from "pg";
import type {
  CapacityEntry,
  CapacityState,
  CapacityScope,
} from "./adapters/sandbox-policy.js";
const key = (entry: CapacityEntry) =>
  JSON.stringify([entry.tenantId, entry.workspaceId]);
export async function readCapacity(
  c: pg.Pool | pg.PoolClient,
  scope?: CapacityScope,
): Promise<CapacityState> {
  const result = await c.query(
    `SELECT tenant_id AS "tenantId", workspace_id AS "workspaceId", user_id AS "userId", state, sandbox_id AS "sandboxId", operation, updated_at::float8 AS "updatedAt" FROM harness_sandbox_leases ${scope?.workspaceId !== undefined ? "WHERE tenant_id=$1 AND workspace_id=$2" : scope?.usage ? "WHERE tenant_id=$1 AND state IN ('reserved','unknown')" : ""}`,
    scope?.workspaceId !== undefined
      ? [scope.tenant, scope.workspaceId]
      : scope?.usage
        ? [scope.tenant]
        : [],
  );
  const state: CapacityState = { entries: {} };
  for (const row of result.rows) {
    const e = row as CapacityEntry;
    if (e.sandboxId === null) delete e.sandboxId;
    if (e.operation === null) delete e.operation;
    state.entries[key(e)] = e;
  }
  if (scope?.userId) {
    const counts = await c.query(
      "SELECT (SELECT count(*)::int FROM harness_sandbox_leases WHERE state IN ('reserved','active','unknown')) AS global, (SELECT count(*)::int FROM harness_sandbox_leases WHERE state IN ('reserved','active','unknown') AND tenant_id=$1 AND user_id=$2) AS user, (SELECT count(*)::int FROM harness_sandbox_leases WHERE state='paused' AND tenant_id=$1 AND user_id=$2) AS paused",
      [scope.tenant, scope.userId],
    );
    state.counts = counts.rows[0];
  }
  return state;
}
export async function writeCapacity(
  c: pg.PoolClient,
  before: CapacityState,
  after: CapacityState,
  scope?: CapacityScope,
) {
  for (const [k, entry] of Object.entries(after.entries)) {
    if (
      scope?.workspaceId !== undefined &&
      (entry.tenantId !== scope.tenant ||
        entry.workspaceId !== scope.workspaceId)
    )
      throw new Error("Capacity scope violation");
    if (JSON.stringify(before.entries[k]) === JSON.stringify(entry)) continue;
    await c.query(
      `INSERT INTO harness_sandbox_leases(tenant_id,workspace_id,user_id,state,sandbox_id,operation,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,workspace_id) DO UPDATE SET user_id=excluded.user_id,state=excluded.state,sandbox_id=excluded.sandbox_id,operation=excluded.operation,updated_at=excluded.updated_at`,
      [
        entry.tenantId,
        entry.workspaceId,
        entry.userId,
        entry.state,
        entry.sandboxId ?? null,
        entry.operation ?? null,
        entry.updatedAt,
      ],
    );
  }
  for (const [k, e] of Object.entries(before.entries))
    if (!after.entries[k])
      await c.query(
        "DELETE FROM harness_sandbox_leases WHERE tenant_id=$1 AND workspace_id=$2",
        [e.tenantId, e.workspaceId],
      );
}
