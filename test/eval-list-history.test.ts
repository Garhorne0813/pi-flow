import test from "node:test";
import assert from "node:assert/strict";
import { jobsFixture } from "./eval-job-fixture.js";
import { databaseUrl } from "./eval-fixture.js";
test(
  "100k revoked jobs use one indexed visible-page query and no per-job authorization scan",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture();
    try {
      const visible = await f.jobs.create(f.actor, f.request, "visible");
      await f.pool.query(
        `INSERT INTO personal_eval_jobs(user_id,job_id,suite_id,suite_version,agent_id,state,request_digest,idempotency_key,data)
      SELECT $1,id,$2,1,'revoked','QUEUED','r',id::text,jsonb_set(jsonb_set($3::jsonb,'{jobId}',to_jsonb(id::text)),'{request,agentId}','"revoked"')
      FROM (SELECT gen_random_uuid() AS id FROM generate_series(1,100000)) q`,
        [f.actor.userId, f.request.suiteId, JSON.stringify(visible)],
      );
      await f.pool.query("ANALYZE personal_eval_jobs");
      const query = f.pool.query.bind(f.pool);
      const queries: { sql: string; values: unknown[] }[] = [];
      f.pool.query = ((sql: string, ...args: any[]) => {
        if (
          typeof sql === "string" &&
          sql.includes("FROM personal_eval_jobs WHERE user_id=")
        )
          queries.push({ sql, values: args[0] });
        return (query as any)(sql, ...args);
      }) as typeof f.pool.query;
      f.jobs.access.authorize = async () => {
        throw Error("unexpected per-job authorization");
      };
      f.jobs.jobs = async () => {
        throw Error("unexpected history scan");
      };
      assert.deepEqual(
        (await f.service.listJobs(f.actor, { offset: 0, limit: 50 })).map(
          (j) => j.jobId,
        ),
        [visible.jobId],
      );
      assert.equal(queries.length, 1);
      const plan = (
        await query(
          "EXPLAIN (ANALYZE, FORMAT JSON) " + queries[0]!.sql,
          queries[0]!.values,
        )
      ).rows[0]["QUERY PLAN"];
      assert.match(JSON.stringify(plan), /personal_eval_jobs_agent_history/);
      assert.deepEqual(
        await f.service.listJobs(f.actor, { offset: 1, limit: 50 }),
        [],
      );
      await f.registry.tx((s) => {
        s.modelCatalog = [
          {
            provider: "demo",
            modelId: "demo",
            gatewayRef: "old",
            baseUrl: "https://example.com",
            secretRef: "placeholder",
            default: false,
          },
        ];
      });
      const frozen = await f.jobs.create(f.actor, f.request, "old-gateway");
      assert.equal(
        (await f.service.listJobs(f.actor, { offset: 0, limit: 50 })).length,
        2,
      );
      await f.registry.tx((s) => {
        s.modelCatalog![0]!.gatewayRef = "new";
      });
      assert.equal(
        (await f.service.listJobs(f.actor, { offset: 0, limit: 50 })).some(
          (j) => j.jobId === frozen.jobId,
        ),
        true,
      );
      await f.registry.tx((s) => {
        s.managedAgents!.assistant!.enabled = false;
      });
      queries.length = 0;
      assert.deepEqual(
        await f.service.listJobs(f.actor, { offset: 0, limit: 50 }),
        [],
      );
      assert.equal(queries.length, 0);
    } finally {
      await f.close();
    }
  },
);
