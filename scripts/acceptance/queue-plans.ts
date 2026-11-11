import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { id, emptyState } from "../../src/domain/model.js";
import {
  runWorkQuery,
  sandboxMaintenanceQuery,
} from "../../src/storage/personal-work-queries.js";
export const previousRunWorkQuery = `WITH candidates AS (
 (SELECT DISTINCT ON(user_id) user_id,run_id,0 AS priority FROM personal_runs WHERE lease_owner IS NOT NULL AND lease_expires<$1 AND state<>'QUEUED' ORDER BY user_id,lease_expires,run_id)
 UNION ALL (SELECT DISTINCT ON(user_id) user_id,run_id,1 AS priority FROM personal_runs WHERE state='QUEUED' ORDER BY user_id,created_at,run_id)
) SELECT user_id AS "user",run_id AS "runId" FROM candidates ORDER BY (user_id>$2) DESC,user_id,priority LIMIT $3`;
const previousSandboxMaintenanceQuery = `WITH due AS (SELECT user_id,workspace_id FROM personal_workspace_runtime WHERE sandbox_id IS NOT NULL AND NOT COALESCE((data->>'deleting')::boolean,false)
 AND (last_used_at IS NULL OR last_used_at<=$1::bigint-$3::bigint OR (last_used_at<=$1::bigint-$2::bigint AND COALESCE(data->>'sandboxState','active') NOT IN ('paused','unknown')))
 ORDER BY checked_at,last_used_at NULLS FIRST,user_id,workspace_id LIMIT 128 FOR UPDATE SKIP LOCKED)
 UPDATE personal_workspace_runtime w SET checked_at=$1 FROM due d WHERE w.user_id=d.user_id AND w.workspace_id=d.workspace_id RETURNING w.user_id AS "user",w.data AS workspace`;
export function summarize(result: any) {
  const nodes: any[] = [];
  const visit = (node: any) => {
    nodes.push(node);
    for (const p of node.Plans ?? []) visit(p);
  };
  visit(result.Plan);
  const scans = nodes
    .filter((n) => n["Relation Name"] && n["Node Type"].endsWith("Scan"))
    .map((n) => ({
      relation: n["Relation Name"],
      node: n["Node Type"],
      index: n["Index Name"],
      rows: n["Actual Rows"],
      loops: n["Actual Loops"],
      filtered: n["Rows Removed by Filter"] ?? 0,
      rechecked: n["Rows Removed by Index Recheck"] ?? 0,
      heapFetches: n["Heap Fetches"] ?? 0,
    }));
  const scanned = (relations: string[]) =>
    scans
      .filter((n) => relations.includes(n.relation))
      .reduce(
        (sum, n) => sum + (n.rows + n.filtered + n.rechecked) * n.loops,
        0,
      );
  return {
    executionMs: result["Execution Time"],
    planningMs: result["Planning Time"],
    returned: result.Plan["Actual Rows"],
    sharedHitBlocks: result.Plan["Shared Hit Blocks"],
    sharedReadBlocks: result.Plan["Shared Read Blocks"],
    runScanRows: scanned(["personal_runs"]),
    frontierScanRows: scanned(["personal_run_work"]),
    workspaceScanRows: scanned(["personal_workspace_runtime"]),
    sortInputRows: nodes
      .filter((n) => n["Node Type"] === "Sort")
      .map(
        (n) =>
          (n.Plans?.[0]?.["Actual Rows"] ?? 0) *
          (n.Plans?.[0]?.["Actual Loops"] ?? 1),
      ),
    scans,
  };
}
export async function queuePlans(url: string, rows = 100000) {
  const control = new pg.Pool({ connectionString: url }),
    schema = "queue_plans_" + id().replaceAll("-", "");
  await control.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: scoped.toString() });
  const result: any = {
    rows,
    postgres: (await control.query("SHOW server_version")).rows[0]
      .server_version,
    notes:
      "EXPLAIN ANALYZE BUFFERS with the default planner. Freshly inserted data, no forced index hints. Scan-row counts include returned/filtered rows at relation nodes, not invisible/dead index tuples or buffer-level work.",
    queues: [],
    workspaces: [],
  };
  const explain = async (sql: string, params: any[]) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const plan = (
        await c.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + sql, params)
      ).rows[0]["QUERY PLAN"][0];
      return { summary: summarize(plan), plan };
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  };
  try {
    for (const n of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await pool.query(await readFile("migrations/" + n, "utf8"));
    await pool.query(
      "INSERT INTO personal_users(id,issuer,subject) SELECT md5('plan-user-'||n)::uuid::text,'urn:plans',n::text FROM generate_series(0,999)n",
    );
    await pool.query(
      "INSERT INTO personal_user_state(user_id,state) SELECT id,$1 FROM personal_users",
      [JSON.stringify(emptyState())],
    );
    await pool.query(
      "INSERT INTO personal_sessions(user_id,session_id,workspace_id,data) SELECT id,'s-'||id,id,jsonb_build_object('id','s-'||id) FROM personal_users",
    );
    const now = Date.now(),
      cursor = (
        await pool.query(
          "SELECT id FROM personal_users ORDER BY id OFFSET 499 LIMIT 1",
        )
      ).rows[0].id;
    for (const users of [1, 1000]) {
      await pool.query("TRUNCATE personal_runs,personal_sessions CASCADE");
      await pool.query("TRUNCATE personal_run_work");
      await pool.query(
        "INSERT INTO personal_sessions(user_id,session_id,workspace_id,data) SELECT md5('plan-user-'||((n-1)%$2))::uuid::text,'sq-'||n,md5('plan-user-'||((n-1)%$2))::uuid::text,jsonb_build_object('id','sq-'||n) FROM generate_series(1,$1::int)n",
        [rows, users],
      );
      await pool.query(
        `INSERT INTO personal_runs(user_id,run_id,session_id,actor_id,state,created_at,data)
    SELECT md5('plan-user-'||((n-1)%$2))::uuid::text,'q-'||n,'sq-'||n,md5('plan-user-'||((n-1)%$2))::uuid::text,'QUEUED','2026-01-01'::timestamptz+n*interval '1 millisecond',jsonb_build_object('id','q-'||n,'state','QUEUED') FROM generate_series(1,$1::int)n`,
        [rows, users],
      );
      await pool.query("ANALYZE personal_runs");
      await pool.query("ANALYZE personal_run_work");
      const before = await explain(previousRunWorkQuery, [now, cursor, 64]),
        after = await explain(runWorkQuery, [now, cursor, 64]);
      assert.ok(
        before.summary.runScanRows >= rows,
        "baseline must expose the DISTINCT backlog scan",
      );
      assert.equal(after.summary.runScanRows, 0);
      assert.ok(
        after.summary.frontierScanRows <= 256,
        "candidate scan must touch only the bounded frontier branches",
      );
      assert.ok(after.summary.sortInputRows.every((n) => n <= 192));
      const entry = { users, before, after };
      result.queues.push(entry);
      console.log(
        JSON.stringify({
          case: "queue",
          users,
          rows,
          before: before.summary,
          after: after.summary,
        }),
      );
    }
    for (const count of [Math.min(10000, rows), rows]) {
      for (const distribution of ["all-due", "mixed", "adversarial"] as const) {
        await pool.query("TRUNCATE personal_workspace_runtime");
        await pool.query(
          `INSERT INTO personal_workspace_runtime(user_id,workspace_id,data,last_used_at,sandbox_id,checked_at)
     SELECT md5('plan-user-'||((n-1)%1000))::uuid::text,'w-'||n,jsonb_build_object('id','w-'||n,'sandboxState','active','sandboxId','box-'||n),
      CASE WHEN $2='all-due' OR n%10=0 THEN 0 ELSE $3::bigint END,'box-'||n,
      CASE WHEN $2='adversarial' AND n%10=0 THEN 1 ELSE 0 END FROM generate_series(1,$1::int)n`,
          [count, distribution, now],
        );
        await pool.query("ANALYZE personal_workspace_runtime");
        await pool.query("DROP INDEX personal_workspace_rotation");
        const before = await explain(previousSandboxMaintenanceQuery, [
          now,
          600000,
          3600000,
        ]);
        await pool.query(
          "CREATE INDEX personal_workspace_rotation ON personal_workspace_runtime(checked_at,last_used_at NULLS FIRST,user_id,workspace_id) WHERE sandbox_id IS NOT NULL AND NOT COALESCE((data->>'deleting')::boolean,false)",
        );
        await pool.query("ANALYZE personal_workspace_runtime");
        const after = await explain(sandboxMaintenanceQuery, [
          now,
          600000,
          3600000,
        ]);
        assert.equal(after.summary.returned, 128);
        assert.equal(
          after.summary.sortInputRows.length,
          0,
          "rotation must not sort the eligible population",
        );
        if (distribution !== "adversarial")
          assert.ok(
            after.summary.workspaceScanRows <= 512,
            "ordinary due distributions should visit only the bounded selected batch plus PK updates",
          );
        const entry = { rows: count, distribution, before, after };
        result.workspaces.push(entry);
        console.log(
          JSON.stringify({
            case: "workspace",
            rows: count,
            distribution,
            before: before.summary,
            after: after.summary,
          }),
        );
      }
    }
    return result;
  } finally {
    await pool.end();
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("TEST_DATABASE_URL required");
  console.log(
    JSON.stringify({
      queuePlans: await queuePlans(process.env.TEST_DATABASE_URL),
    }),
  );
}
