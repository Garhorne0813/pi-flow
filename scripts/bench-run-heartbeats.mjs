import { PostgresStore } from "../dist/store.js";
import { HarnessService } from "../dist/service.js";
import { AgentConfig } from "../dist/domain.js";
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
if (!process.env.TEST_DATABASE_URL)
  throw new Error("TEST_DATABASE_URL required");
const store = new PostgresStore(process.env.TEST_DATABASE_URL),
  service = new HarnessService(store, [], ["default"]),
  tenant = "run-bench-" + crypto.randomUUID(),
  actor = { tenantId: tenant, userId: "bench", admin: true };
const runCount = Number(process.env.BENCH_RUNS ?? 100),
  requests = Number(process.env.BENCH_REQUESTS ?? 200),
  concurrency = Number(process.env.BENCH_CONCURRENCY ?? 10);
try {
  const av = await service.publish(
      actor,
      AgentConfig.parse({
        name: "bench",
        systemPrompt: "bench",
        model: { provider: "demo", modelId: "demo" },
        tools: [],
        skillBundle: "default",
      }),
    ),
    w = await service.createWorkspace(actor, "bench"),
    runs = [];
  for (let i = 0; i < runCount; i++) {
    const s = await service.createSession(actor, w.id, av.id);
    runs.push(await service.submit(actor, s.id, "bench"));
  }
  const state = await store.read(tenant, (s) => s);
  await store.pool.query(
    "CREATE TABLE IF NOT EXISTS harness_run_benchmark(id text PRIMARY KEY,state jsonb NOT NULL)",
  );
  await store.pool.query("INSERT INTO harness_run_benchmark VALUES($1,$2)", [
    tenant,
    JSON.stringify(state),
  ]);
  const result = {
    kind: "local PostgreSQL synthetic heartbeat benchmark",
    runCount,
    requests,
    concurrency,
    node: process.version,
  };
  for (const mode of ["aggregate", "perRun"]) {
    let next = 0;
    const times = [],
      started = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < requests) {
          const i = next++,
            rid = runs[i % runs.length].id,
            t = performance.now();
          if (mode === "perRun")
            await store.runTx(tenant, rid, (s) => {
              s.runs[rid].lease = {
                owner: "bench",
                expires: Date.now() + 30000,
              };
            });
          else {
            const c = await store.pool.connect();
            try {
              await c.query("BEGIN");
              const { rows } = await c.query(
                "SELECT state FROM harness_run_benchmark WHERE id=$1 FOR UPDATE",
                [tenant],
              );
              rows[0].state.runs[rid].lease = {
                owner: "bench",
                expires: Date.now() + 30000,
              };
              await c.query(
                "UPDATE harness_run_benchmark SET state=$2 WHERE id=$1",
                [tenant, JSON.stringify(rows[0].state)],
              );
              await c.query("COMMIT");
            } finally {
              c.release();
            }
          }
          times.push(performance.now() - t);
        }
      }),
    );
    times.sort((a, b) => a - b);
    result[mode] = {
      elapsedMs: performance.now() - started,
      p95Ms: times[Math.floor(times.length * 0.95)],
      p99Ms: times[Math.floor(times.length * 0.99)],
    };
  }
  mkdirSync("work", { recursive: true });
  writeFileSync(
    "work/run-heartbeat-benchmark.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await store.pool.query("DELETE FROM harness_tenants WHERE tenant_id=$1", [
    tenant,
  ]);
  await store.pool.query("DELETE FROM harness_run_benchmark WHERE id=$1", [
    tenant,
  ]);
  await store.close();
}
