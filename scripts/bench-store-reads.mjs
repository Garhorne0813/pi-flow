// Compare the former SSE polling write path with snapshot reads on a real DB.
// Uses unique test tenants, deletes them afterward, and does not run migrations.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PostgresStore } from "../dist/store.js";
import { HarnessService, authorizedRun } from "../dist/service.js";
import { AgentConfig, event, id, run } from "../dist/domain.js";

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error("Set TEST_DATABASE_URL to a migrated test PostgreSQL database");
const durationMs = Number(process.env.BENCH_DURATION_MS ?? 5000);
if (!Number.isInteger(durationMs) || durationMs < 2500)
  throw Error("BENCH_DURATION_MS must be >= 2500");
const readers = 100,
  heartbeatWorkers = 4;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (samples) =>
  samples.sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1] ?? 0;
const payloads = Array.from({ length: 512 }, () =>
  randomBytes(512).toString("hex"),
);
async function benchmark(mode) {
  const store = new PostgresStore(url),
    monitor = new PostgresStore(url);
  const actor = { tenantId: "bench-" + id(), userId: "bench", admin: true };
  try {
    const service = new HarnessService(store, [], ["default"]);
    const agent = await service.publish(
      actor,
      AgentConfig.parse({
        name: "bench",
        systemPrompt: "bench",
        model: { provider: "demo", modelId: "demo" },
        tools: [],
        skillBundle: "default",
      }),
    );
    const workspace = await service.createWorkspace(actor, "bench");
    const runs = [];
    for (let i = 0; i < heartbeatWorkers; i++) {
      const session = await service.createSession(
        actor,
        workspace.id,
        agent.id,
      );
      runs.push(await service.submit(actor, session.id, "bench"));
    }
    const cursor = await store.tx(actor.tenantId, (s) => {
      for (const r of runs) {
        s.runs[r.id].state = "RUNNING";
        s.runs[r.id].lease = { owner: "bench", expires: Date.now() + 30000 };
      }
      for (const payload of payloads)
        event(s, s.runs[runs[0].id], "history", { payload });
      return s.sequence;
    });
    const revision = async () =>
      Number(
        (
          await monitor.pool.query(
            "SELECT revision FROM harness_tenants WHERE tenant_id=$1",
            [actor.tenantId],
          )
        ).rows[0].revision,
      );
    const stateBytes = Number(
      (
        await monitor.pool.query(
          "SELECT octet_length(state::text) AS bytes FROM harness_tenants WHERE tenant_id=$1",
          [actor.tenantId],
        )
      ).rows[0].bytes,
    );
    const before = await revision();
    const pollTimes = [],
      heartbeatTimes = [];
    let heartbeatCount = 0,
      lockSamples = 0,
      lockSamplesWithWaiters = 0,
      maxWaitingBackends = 0,
      estimatedBackendLockWaitMs = 0;
    const started = performance.now(),
      deadline = started + durationMs;
    const poll =
      mode === "legacy-tx" ? store.tx.bind(store) : store.read.bind(store);
    const workers = Array.from({ length: readers }, async (_, i) => {
      while (performance.now() < deadline) {
        const begin = performance.now(),
          next = begin + 250;
        await poll(actor.tenantId, (s) => {
          run(s, actor, runs[i % runs.length].id); // Same ACL and event filtering as SSE.
          return s.events
            .filter(
              (e) => e.runId === runs[i % runs.length].id && e.eventId > cursor,
            )
            .slice(0, 100);
        });
        pollTimes.push(performance.now() - begin);
        await pause(Math.max(0, next - performance.now()));
      }
    });
    workers.push(
      ...runs.map((r) =>
        (async () => {
          while (performance.now() < deadline) {
            const begin = performance.now(),
              next = begin + 1000;
            await store.tx(actor.tenantId, (s) => {
              authorizedRun(s, s.runs[r.id]);
              s.runs[r.id].lease.expires = Date.now() + 30000;
            });
            heartbeatCount++;
            heartbeatTimes.push(performance.now() - begin);
            await pause(Math.max(0, next - performance.now()));
          }
        })(),
      ),
    );
    let done = false;
    const sampling = (async () => {
      let last = performance.now();
      while (!done) {
        const row = await monitor.pool.query(
          "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%harness_tenants%'",
        );
        const now = performance.now(),
          waiting = row.rows[0].waiting;
        lockSamples++;
        if (waiting > 0) lockSamplesWithWaiters++;
        maxWaitingBackends = Math.max(maxWaitingBackends, waiting);
        estimatedBackendLockWaitMs += waiting * (now - last);
        last = now;
        await pause(20);
      }
    })();
    try {
      await Promise.all(workers);
    } finally {
      done = true;
      await sampling;
    }
    const elapsedMs = performance.now() - started;
    const tenantUpdates = (await revision()) - before;
    // Runs/Sessions/Events are split tables; run heartbeats update harness_runs
    // directly and no longer rewrite the tenant row.
    if (mode === "snapshot-read")
      assert.equal(
        tenantUpdates,
        0,
        "read polls and run heartbeats must not rewrite the tenant row",
      );
    return {
      mode,
      stateBytes,
      readers,
      heartbeatWorkers,
      requestedDurationMs: durationMs,
      elapsedMs: Math.round(elapsedMs),
      polls: pollTimes.length,
      pollsPerSecond: Number(
        (pollTimes.length / (elapsedMs / 1000)).toFixed(1),
      ),
      pollP95Ms: Number(percentile(pollTimes).toFixed(1)),
      heartbeatP95Ms: Number(percentile(heartbeatTimes).toFixed(1)),
      heartbeatUpdates: heartbeatCount,
      tenantUpdates,
      // Heartbeats no longer reach the tenant row, so its updates come from
      // the read path itself.
      pollUpdates: tenantUpdates,
      lockSamples,
      lockSamplesWithWaiters,
      maxWaitingBackends,
      estimatedBackendLockWaitMs: Math.round(estimatedBackendLockWaitMs),
    };
  } finally {
    await store.pool.query("DELETE FROM harness_tenants WHERE tenant_id=$1", [
      actor.tenantId,
    ]);
    await Promise.all([store.close(), monitor.close()]);
  }
}
console.log(
  JSON.stringify(
    {
      postgres: "See server version in test environment",
      workload:
        "100 SSE-equivalent readers at 250 ms + 4 Run heartbeats at 1 s; one ~600 KB tenant; pool max=10; audits excluded; sampled lock waits are approximate",
      results: [await benchmark("legacy-tx"), await benchmark("snapshot-read")],
    },
    null,
    2,
  ),
);
