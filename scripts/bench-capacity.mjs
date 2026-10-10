import pg from "pg";
import { performance } from "node:perf_hooks";
import { writeFileSync, mkdirSync } from "node:fs";
if (!process.env.TEST_DATABASE_URL)
  throw new Error("TEST_DATABASE_URL required");
const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 20,
  }),
  prefix = "bench-" + crypto.randomUUID();
const rows = Number(process.env.BENCH_ROWS ?? 1000),
  requests = Number(process.env.BENCH_REQUESTS ?? 200),
  concurrency = Number(process.env.BENCH_CONCURRENCY ?? 10);
const entries = Object.fromEntries(
  Array.from({ length: rows }, (_, i) => [
    i,
    {
      tenantId: prefix,
      workspaceId: "" + i,
      userId: "bench",
      state: "active",
      operation: "o" + i,
      updatedAt: 1,
      sandboxId: "b" + i,
    },
  ]),
);
try {
  await pool.query("CREATE TEMP TABLE unused(x int)");
  await pool.query(
    "CREATE TABLE IF NOT EXISTS harness_capacity_benchmark(id text PRIMARY KEY,state jsonb NOT NULL)",
  );
  await pool.query("INSERT INTO harness_capacity_benchmark VALUES($1,$2)", [
    prefix,
    JSON.stringify({ entries }),
  ]);
  for (const e of Object.values(entries))
    await pool.query(
      "INSERT INTO harness_sandbox_leases VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        e.tenantId,
        e.workspaceId,
        e.userId,
        e.state,
        e.sandboxId,
        e.operation,
        e.updatedAt,
      ],
    );
  const result = {
    kind: "local PostgreSQL synthetic transition benchmark",
    rows,
    requests,
    concurrency,
    node: process.version,
  };
  for (const kind of ["aggregate", "rows"]) {
    let next = 0;
    const times = [];
    const started = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < requests) {
          const index = next++,
            t = performance.now(),
            c = await pool.connect();
          try {
            await c.query("BEGIN");
            if (kind === "aggregate") {
              const r = await c.query(
                "SELECT state FROM harness_capacity_benchmark WHERE id=$1 FOR UPDATE",
                [prefix],
              );
              const s = r.rows[0].state;
              s.entries[index % rows].updatedAt = Date.now();
              await c.query(
                "UPDATE harness_capacity_benchmark SET state=$2 WHERE id=$1",
                [prefix, JSON.stringify(s)],
              );
            } else {
              await c.query("SELECT pg_advisory_xact_lock(134697,13)");
              await c.query(
                "UPDATE harness_sandbox_leases SET updated_at=$3 WHERE tenant_id=$1 AND workspace_id=$2",
                [prefix, "" + (index % rows), Date.now()],
              );
            }
            await c.query("COMMIT");
            times.push(performance.now() - t);
          } finally {
            c.release();
          }
        }
      }),
    );
    times.sort((a, b) => a - b);
    result[kind === "rows" ? "normalized" : kind] = {
      elapsedMs: performance.now() - started,
      p95Ms: times[Math.floor(times.length * 0.95)],
      p99Ms: times[Math.floor(times.length * 0.99)],
    };
  }
  mkdirSync("work", { recursive: true });
  writeFileSync(
    "work/capacity-benchmark.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await pool.query("DELETE FROM harness_sandbox_leases WHERE tenant_id=$1", [
    prefix,
  ]);
  await pool.query("DELETE FROM harness_capacity_benchmark WHERE id=$1", [
    prefix,
  ]);
  await pool.end();
}
