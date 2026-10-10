import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Worker } from "../../src/worker.js";
import { DemoSandbox, SandboxManager } from "../../src/adapters/sandbox.js";
import { MCPManager } from "../../src/adapters/mcp.js";
import { claimableRunsQuery } from "../../src/run-store.js";
import { fixture } from "./fixture.js";

// Disposable real-DB experiment, including an actual idle Worker tick. No remote providers.
export async function workerHistoryBenchmark() {
  const f = await fixture();
  const sandbox = new SandboxManager(f.store, new DemoSandbox());
  sandbox.sweepIfDue = async () => undefined;
  const worker = new Worker(
    f.service,
    { execute: async () => assert.fail("idle runtime executed") },
    sandbox,
    new MCPManager(f.store, {}),
    1,
  );
  f.store.tenants = async () => [f.actor.tenantId];
  f.store.read = async () => {
    throw new Error("Worker must not load a tenant snapshot");
  };
  const results: {
    runs: number;
    events: number;
    scanP95Ms: number;
    tickP95Ms: number;
    returnedRows: number;
    returnedJsonBytes: number;
    sharedBlocks: number;
  }[] = [];
  const p95 = (samples: number[]) =>
    samples.sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!;
  try {
    await f.store.pool.query(
      "UPDATE harness_runs SET state='COMPLETED',data=jsonb_set(data,'{state}','\"COMPLETED\"') WHERE tenant_id=$1",
      [f.actor.tenantId],
    );
    const sample = async (runs: number, events: number) => {
      await f.store.pool.query("ANALYZE harness_runs");
      for (let i = 0; i < 10; i++) await worker.tick();
      const scan: number[] = [],
        ticks: number[] = [];
      for (let i = 0; i < 100; i++) {
        let begin = performance.now();
        assert.deepEqual(
          await f.store.listClaimableRuns(f.actor.tenantId, Date.now(), 64),
          [],
        );
        scan.push(performance.now() - begin);
        begin = performance.now();
        await worker.tick();
        ticks.push(performance.now() - begin);
      }
      const args = [f.actor.tenantId, Date.now(), 64];
      const response = await f.store.pool.query(claimableRunsQuery, args);
      const explain = await f.store.pool.query(
        "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + claimableRunsQuery,
        args,
      );
      const plan = explain.rows[0]["QUERY PLAN"][0].Plan;
      const indexes: string[] = [];
      const walk = (p: any) => {
        if (runs > 100 && p["Relation Name"] === "harness_runs") {
          assert.notEqual(
            p["Node Type"],
            "Seq Scan",
            "must not scan completed history",
          );
          assert.equal(p["Actual Rows"], 0);
          assert.equal(p["Rows Removed by Filter"] ?? 0, 0);
          indexes.push(p["Index Name"]);
        }
        for (const child of p.Plans ?? []) walk(child);
      };
      walk(plan);
      if (runs > 100) assert.ok(indexes.includes("harness_runs_claim"));
      if (runs > 100)
        assert.ok(indexes.includes("harness_runs_tenant_expired"));
      results.push({
        runs,
        events,
        scanP95Ms: p95(scan),
        tickP95Ms: p95(ticks),
        returnedRows: response.rowCount!,
        returnedJsonBytes: Buffer.byteLength(JSON.stringify(response.rows)),
        sharedBlocks:
          (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0),
      });
    };
    await sample(1, 1);
    await f.store.pool.query(
      `INSERT INTO harness_runs(tenant_id,run_id,session_id,user_id,state,created_at,data)
      SELECT $1,'history-'||n,$2,$3,'COMPLETED',now(),$4::jsonb || jsonb_build_object('id','history-'||n,'state','COMPLETED')
      FROM generate_series(1,20000) n`,
      [
        f.actor.tenantId,
        f.run.sessionId,
        f.actor.userId,
        JSON.stringify(f.run),
      ],
    );
    await sample(20001, 1);
    for (const count of [10000, 100000]) {
      const old = count === 10000 ? 0 : 10000;
      await f.store.pool.query(
        `INSERT INTO harness_run_events(tenant_id,run_id,event_id,data)
        SELECT $1,'history-'||(1+n%20000),n+1,jsonb_build_object('eventId',n+1,'runId','history-'||(1+n%20000),
          'type','history','data',jsonb_build_object('text',repeat('x',256))) FROM generate_series($2::int,$3::int) n`,
        [f.actor.tenantId, old + 1, count],
      );
      await sample(20001, count + 1);
    }
    const before = results[2]!,
      after = results[3]!;
    assert.equal(after.returnedRows, before.returnedRows);
    assert.equal(after.returnedJsonBytes, before.returnedJsonBytes);
    assert.ok(
      after.sharedBlocks <= before.sharedBlocks + 4,
      "history must not increase scan buffers linearly",
    );
    // Wide allowance for shared CI hosts; structural/index assertions are the primary guard.
    assert.ok(
      after.scanP95Ms <= before.scanP95Ms * 4 + 5,
      "10x events must not cause linear idle-scan growth",
    );
    assert.ok(
      after.tickP95Ms <= before.tickP95Ms * 4 + 5,
      "10x events must not cause linear idle-tick growth",
    );
    return {
      tier: "synthetic-history-real-postgres",
      status: "passed",
      candidateLimit: 64,
      samplesPerStage: 100,
      scope:
        "one tenant, sequential idle scans, warm cache; not a production throughput SLO",
      results,
    };
  } finally {
    await worker.stop();
    await f.store.pool.query(
      "DELETE FROM harness_worker_health WHERE worker_id=$1",
      [(worker as any).owner],
    );
    await f.close();
  }
}
if (process.argv[1]?.endsWith("worker-history.ts"))
  console.log(JSON.stringify(await workerHistoryBenchmark()));
