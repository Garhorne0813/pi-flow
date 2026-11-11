import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { get, Agent } from "node:http";
import pg from "pg";
import { PersonalPostgresStore } from "../../src/storage/personal-postgres-store.js";
import { PostgresRegistry, principal } from "../../src/storage/registry.js";
import { personalStore } from "../../src/storage/personal.js";
import { PersonalService } from "../../src/domain/personal-service.js";
import { AgentConfig, emptyState, id, type Actor } from "../../src/domain/model.js";
import { replaceAgents } from "../../src/config/agents.js";
import { SandboxManager, DemoSandbox } from "../../src/sandbox/manager.js";
import { MCPManager } from "../../src/mcp/manager.js";
import { Worker } from "../../src/execution/worker.js";
import { buildAPI } from "../../src/api/server.js";
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const p95 = (v: number[]) =>
  v.sort((a, b) => a - b)[Math.max(0, Math.ceil(v.length * 0.95) - 1)] ?? 0;
type Sample = {
  queries: number;
  reads: number;
  writeStatements: number;
  writeRows: number;
  returnedRows: number;
  returnedBytes: number;
  eventReads: number;
  fullHistoryReads: number;
  agentPayloads: number;
  sqlMs: number[];
  txMs: number[];
};
const sample = (): Sample => ({
  queries: 0,
  reads: 0,
  writeStatements: 0,
  writeRows: 0,
  returnedRows: 0,
  returnedBytes: 0,
  eventReads: 0,
  fullHistoryReads: 0,
  agentPayloads: 0,
  sqlMs: [],
  txMs: [],
});
export async function runtimeHotpaths(
  url: string,
  options: {
    httpDurationMs?: number;
    idleUsers?: number;
    activeRuns?: number;
    sseConnections?: number;
    sseDurationMs?: number;
  } = {},
) {
  const settings = {
    httpDurationMs: 300000,
    idleUsers: 1000,
    activeRuns: 100,
    sseConnections: 500,
    sseDurationMs: 10000,
    ...options,
  };
  const control = new pg.Pool({ connectionString: url });
  const schema = "runtime_bench_" + id().replaceAll("-", "");
  await control.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  scoped.searchParams.set("application_name", schema);
  const backing = new PersonalPostgresStore(scoped.toString());
  let current: Sample | undefined;
  backing.pool.on("connect", (c) => {
    const query = c.query.bind(c);
    let began = 0;
    c.query = ((...args: any[]) => {
      const sql = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
      const started = performance.now(),
        measured = current;
      if (/^BEGIN/i.test(sql)) began = started;
      const capture = (r: any) => {
        if (measured) {
          measured.queries++;
          measured.sqlMs.push(performance.now() - started);
          if (r.command === "SELECT") {
            measured.reads++;
            measured.returnedRows += r.rows?.length ?? 0;
            measured.returnedBytes += Buffer.byteLength(
              JSON.stringify(r.rows ?? []),
            );
          }
          if (["INSERT", "UPDATE", "DELETE"].includes(r.command)) {
            measured.writeStatements++;
            measured.writeRows += r.rowCount ?? 0;
          }
          if (/FROM personal_run_events/i.test(sql)) measured.eventReads++;
          if (
            /FROM personal_runs WHERE user_id=\$1\s+(ORDER BY run_id|FOR UPDATE)/i.test(
              sql,
            ) ||
            /SELECT user_id FROM personal_user_state/i.test(sql)
          )
            measured.fullHistoryReads++;
          if (r.rows?.some((row: any) => row.agents != null))
            measured.agentPayloads++;
          if (/^COMMIT/i.test(sql) && began)
            measured.txMs.push(performance.now() - began);
        }
        return r;
      };
      const cb = args.at(-1);
      if (typeof cb === "function") {
        args[args.length - 1] = (error: unknown, r: unknown) => {
          if (!error) capture(r);
          cb(error, r);
        };
        return (query as any)(...args);
      }
      return (query as any)(...args).then(capture);
    }) as typeof c.query;
  });
  let app: ReturnType<typeof buildAPI> | undefined;
  let worker: Worker | undefined;
  const httpAgent = new Agent({ keepAlive: false, maxSockets: Infinity });
  const requests: ReturnType<typeof get>[] = [];
  const oldSchedules = process.env.SCHEDULES_ENABLED;
  process.env.SCHEDULES_ENABLED = "true";
  let pgStats = false;
  try {
    for (const name of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await backing.pool.query(await readFile("migrations/" + name, "utf8"));
    await backing.ready();
    try {
      await control.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
      await control.query("SELECT 1 FROM public.pg_stat_statements LIMIT 1");
      pgStats = true;
    } catch {
      /* still report actual client SQL and cluster WAL; never invent extension metrics */
    }
    if (pgStats && process.env.BENCH_RESET_STATS === "true")
      await control.query("SELECT public.pg_stat_statements_reset()");
    const statements = async () =>
      pgStats
        ? (
            await control.query(
              "SELECT queryid::text,calls::float8,rows::float8,wal_bytes::float8,total_exec_time,query FROM public.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query LIKE '%personal_%'",
            )
          ).rows
        : [];
    const registry = new PostgresRegistry(backing.pool),
      store = personalStore(backing, registry),
      service = new PersonalService(store, registry);
    const actor = await principal(registry, {
      tenantId: "bench",
      userId: "bench",
      issuer: "urn:runtime-bench",
      subject: "base",
      admin: true,
    });
    const cfg = AgentConfig.parse({
      name: "bench",
      systemPrompt: "bench",
      model: { provider: "demo", modelId: "demo" },
      tools: ["ls", "todo"],
      approval: { mode: "auto" },
    });
    await registry.tx((s) =>
      replaceAgents(s, [{ key: "assistant", config: cfg }], actor),
    );
    const provider = new DemoSandbox(),
      sandbox = new SandboxManager(store, provider);
    const ses = await service.createPersonalSession(actor, {
        agentId: "assistant",
      }),
      statusRun = await service.submit(actor, ses.id, "status");
    await store.runTx(actor.userId, statusRun.id, (s) => {
      s.runs[statusRun.id]!.state = "COMPLETED";
    });
    app = buildAPI(
      service,
      async () => ({
        ...actor,
        personal: false,
        expiresAt: Date.now() + 600000,
      }),
      sandbox,
    );
    const results: Record<string, unknown> = {
      settings,
      pgStatStatements: pgStats,
      limitations:
        "WAL LSN is cluster-wide; SQL rows/timings are client observations. Lock-wait time is sampled, and timings are not production SLAs.",
    };
    const measure = async (name: string, fn: () => Promise<unknown>) => {
      const before = await statements(),
        lsn = (await control.query("SELECT pg_current_wal_insert_lsn() AS lsn"))
          .rows[0].lsn;
      const metrics = sample();
      let done = false,
        lockSamples = 0,
        waitingSamples = 0,
        maxWaiters = 0,
        lockWaitMs = 0;
      const started = performance.now();
      current = metrics;
      const sampler = (async () => {
        let last = performance.now();
        while (!done) {
          const n = Number(
            (
              await control.query(
                "SELECT count(*) AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
                [schema],
              )
            ).rows[0].n,
          );
          const now = performance.now();
          lockSamples++;
          if (n) waitingSamples++;
          maxWaiters = Math.max(maxWaiters, n);
          lockWaitMs += n * (now - last);
          last = now;
          await pause(100);
        }
      })();
      let detail: unknown;
      try {
        detail = await fn();
      } finally {
        current = undefined;
        done = true;
        await sampler;
      }
      const elapsedMs = performance.now() - started,
        walBytes = Number(
          (
            await control.query(
              "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1) AS bytes",
              [lsn],
            )
          ).rows[0].bytes,
        );
      const after = await statements(),
        previous = new Map(before.map((r) => [r.queryid, r]));
      const delta = after
        .map((r) => {
          const old = previous.get(r.queryid);
          return {
            query: r.query.slice(0, 1000),
            calls: r.calls - (old?.calls ?? 0),
            rows: r.rows - (old?.rows ?? 0),
            walBytes: r.wal_bytes - (old?.wal_bytes ?? 0),
            execMs: r.total_exec_time - (old?.total_exec_time ?? 0),
          };
        })
        .filter((r) => r.calls > 0)
        .sort((a, b) => b.calls - a.calls);
      const { sqlMs, txMs, ...counts } = metrics;
      const value = {
        ...counts,
        elapsedMs,
        sqlP95Ms: p95(sqlMs),
        transactionP95Ms: p95(txMs),
        walBytes,
        lockSamples,
        waitingSamples,
        maxWaiters,
        estimatedLockWaitMs: lockWaitMs,
        statementTotals: pgStats
          ? delta.reduce(
              (s, r) => ({
                calls: s.calls + r.calls,
                rows: s.rows + r.rows,
                walBytes: s.walBytes + r.walBytes,
              }),
              { calls: 0, rows: 0, walBytes: 0 },
            )
          : null,
        topStatements: delta.slice(0, 12),
        detail,
      };
      results[name] = value;
      console.log(
        JSON.stringify({ phase: name, ...value, topStatements: undefined }),
      );
      return value;
    };
    const idle = async (name: string) => {
      const w = new Worker(
        service,
        {
          execute: async () => {
            throw new Error("idle Worker must have no work");
          },
        },
        sandbox,
        new MCPManager(store, {}),
      );
      await w.tick();
      await pause(100);
      const value = await measure(name, async () => {
        for (let i = 0; i < 20; i++) await w.tick();
        return { ticks: 20 };
      });
      await w.stop();
      assert.ok(
        value.reads <= 22,
        "idle queries must not scale with user count",
      );
      assert.equal(value.fullHistoryReads, 0);
      return value;
    };
    const smallIdle = await idle("idle-single-user");
    const users = Array.from({ length: settings.idleUsers }, (_, i) => ({
      id: id(),
      subject: "u-" + i,
    }));
    await backing.pool.query(
      "INSERT INTO personal_users(id,issuer,subject) SELECT v->>'id','urn:runtime-bench',v->>'subject' FROM jsonb_array_elements($1::jsonb) v",
      [JSON.stringify(users)],
    );
    await backing.pool.query(
      "INSERT INTO personal_user_state(user_id,state) SELECT id,$1::jsonb FROM personal_users WHERE issuer='urn:runtime-bench' AND subject<>'base'",
      [JSON.stringify(emptyState())],
    );
    const largeIdle = await idle("idle-1000-users");
    assert.equal(largeIdle.reads, smallIdle.reads);
    const historySession = await service.createPersonalSession(actor, {
      agentId: "assistant",
    });
    await backing.pool.query(
      `INSERT INTO personal_runs(user_id,run_id,session_id,actor_id,state,created_at,data) SELECT $1,'history-'||n,$2,$1,'COMPLETED',now(),$3::jsonb||jsonb_build_object('id','history-'||n,'sessionId',$2::text,'state','COMPLETED') FROM generate_series(1,5000)n`,
      [actor.userId, historySession.id, JSON.stringify(statusRun)],
    );
    const seq = Number(
      (
        await backing.pool.query(
          "SELECT cursor FROM personal_event_sequences WHERE user_id=$1",
          [actor.userId],
        )
      ).rows[0].cursor,
    );
    await backing.pool.query(
      `INSERT INTO personal_run_events(user_id,run_id,event_id,data) SELECT $1,'history-'||((n-1)%5000+1),$2::bigint+n,jsonb_build_object('eventId',$2::bigint+n,'seq',n,'runId','history-'||((n-1)%5000+1),'type','history','data',repeat('x',1024)) FROM generate_series(1,50000)n`,
      [actor.userId, seq],
    );
    await backing.pool.query(
      "UPDATE personal_event_sequences SET cursor=cursor+50000 WHERE user_id=$1",
      [actor.userId],
    );
    const reads = await measure("targeted-get", async () => {
      for (let i = 0; i < 10; i++)
        for (const route of [
          `/api/v1/runs/${statusRun.id}`,
          `/api/v1/sessions/${ses.id}`,
          "/api/v1/usage",
          "/api/v1/schedules",
          "/api/v1/me/sandbox",
        ]) {
          const r = await app!.inject({ url: route });
          assert.equal(r.statusCode, 200, r.body);
        }
      return { requests: 50 };
    });
    assert.equal(reads.writeStatements, 0);
    assert.equal(reads.eventReads, 0);
    assert.equal(reads.fullHistoryReads, 0);
    const polling = await measure("http-status-polling", async () => {
      const times: number[] = [];
      let count = 0;
      const until = performance.now() + settings.httpDurationMs;
      do {
        const start = performance.now(),
          r = await app!.inject({ url: `/api/v1/runs/${statusRun.id}` });
        assert.equal(r.statusCode, 200, r.body);
        times.push(performance.now() - start);
        count++;
        if (count % 600 === 0)
          console.log(
            JSON.stringify({
              phase: "http-status-progress",
              requests: count,
              elapsedMs: settings.httpDurationMs - (until - performance.now()),
            }),
          );
        await pause(Math.max(0, 100 - (performance.now() - start)));
      } while (performance.now() < until);
      return {
        requests: count,
        responseP95Ms: p95(times),
        writesPerRequest: 0,
      };
    });
    assert.equal(polling.writeStatements, 0);
    assert.equal(polling.eventReads, 0);
    await store.runTx(actor.userId, statusRun.id, (s) => {
      s.runs[statusRun.id]!.state = "RUNNING";
    });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    let connected = 0;
    for (let i = 0; i < settings.sseConnections; i++)
      requests.push(
        get(
          `${base}/api/v1/runs/${statusRun.id}/events`,
          { agent: httpAgent },
          (response) => {
            let first = true;
            response.on("data", () => {
              if (first) {
                first = false;
                connected++;
              }
            });
            response.on("error", () => {});
          },
        ).on("error", () => {}),
      );
    const deadline = Date.now() + 30000;
    while (connected < settings.sseConnections && Date.now() < deadline)
      await pause(20);
    assert.equal(connected, settings.sseConnections);
    const sse = await measure("idle-sse", async () => {
      await pause(settings.sseDurationMs);
      return { connections: connected };
    });
    assert.equal(sse.writeStatements, 0);
    assert.ok(
      sse.eventReads <=
        settings.sseConnections *
          (Math.ceil(settings.sseDurationMs / 5000) + 1),
      "notifications must replace 250ms polling",
    );
    requests.forEach((r) => r.destroy());
    requests.length = 0;
    await pause(100);
    await store.runTx(actor.userId, statusRun.id, (s) => {
      s.runs[statusRun.id]!.state = "COMPLETED";
    });
    await sandbox.executeFile(actor, actor.userId, "bench", "write", {
      path: "/workspace/warm.txt",
      content: "hello",
    });
    await store.workspaceTx!(actor.userId, (s) => {
      s.workspaces[actor.userId]!.sandboxLastUsedAt = Date.now() - 20000000;
    });
    await backing.pool.query(
      "DELETE FROM personal_maintenance WHERE name='sandbox'",
    );
    const maintenance = await measure("sandbox-maintenance", async () =>
      Promise.all([
        sandbox.reapIdle(),
        new SandboxManager(store, provider).reapIdle(),
      ]),
    );
    assert.equal(maintenance.fullHistoryReads, 0);
    assert.equal(maintenance.eventReads, 0);
    let entered = 0,
      peak = 0,
      running = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const actors: Actor[] = [
      actor,
      ...users.slice(0, settings.activeRuns - 1).map((u) => ({
        userId: u.id,
        tenantId: u.id,
        issuer: "urn:runtime-bench",
        subject: u.subject,
        personal: true,
        admin: false,
      })),
    ];
    const runIds: string[] = [];
    for (const a of actors) {
      const session = await service.createPersonalSession(a, {
        agentId: "assistant",
      });
      runIds.push((await service.submit(a, session.id, "model")).id);
    }
    worker = new Worker(
      service,
      {
        execute: async (c) => {
          running++;
          peak = Math.max(peak, running);
          if (++entered === settings.activeRuns) release();
          await gate;
          try {
            await c.consume(0, true);
            const reserved = await c.beforeModelRequest!(100);
            for (let i = 0; i < 20; i++) {
              await c.emit("message.delta", { delta: "x".repeat(50) });
              await pause(10);
            }
            await c.call("ls", { path: "/workspace" });
            await c.checkpoint([{ role: "assistant", content: "done" }]);
            await c.consume(20, false);
            await c.recordModelUsage!(
              reserved.id,
              {
                input: 100,
                output: 20,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 120,
              },
              200,
            );
            await c.emit("message.completed", { text: "done" });
          } finally {
            running--;
          }
        },
      },
      sandbox,
      new MCPManager(store, {}),
      settings.activeRuns,
    );
    const execution = await measure("model-execution", async () => {
      const deadline = Date.now() + 120000;
      while (entered < settings.activeRuns && Date.now() < deadline) {
        await worker!.tick();
        await pause(5);
      }
      assert.equal(entered, settings.activeRuns);
      let states = await backing.pool.query(
        "SELECT run_id,state,lease_owner,data->>'error' AS error FROM personal_runs WHERE run_id=ANY($1::text[])",
        [runIds],
      );
      while (
        states.rows.some((r) => r.state !== "COMPLETED" || r.lease_owner) &&
        Date.now() < deadline
      ) {
        if (
          states.rows.some(
            (r) => r.state === "FAILED" || r.state === "CANCELLED",
          )
        )
          break;
        await pause(20);
        states = await backing.pool.query(
          "SELECT run_id,state,lease_owner,data->>'error' AS error FROM personal_runs WHERE run_id=ANY($1::text[])",
          [runIds],
        );
      }
      assert.ok(
        states.rows.every((r) => r.state === "COMPLETED"),
        JSON.stringify(states.rows.filter((r) => r.state !== "COMPLETED")),
      );
      return {
        runs: settings.activeRuns,
        peak,
        sqlCallsPerRun: current!.queries / settings.activeRuns,
        writesPerRun: current!.writeRows / settings.activeRuns,
      };
    });
    assert.equal(peak, settings.activeRuns);
    assert.equal(execution.fullHistoryReads, 0);
    assert.equal(execution.eventReads, 0);
    assert.equal(execution.agentPayloads, 0);
    results["model-execution"] = {
      ...execution,
      clusterWalBytesPerRun: execution.walBytes / settings.activeRuns,
      statementWalBytesPerRun: execution.statementTotals
        ? execution.statementTotals.walBytes / settings.activeRuns
        : null,
    };
    await worker.stop();
    worker = undefined;
    return results;
  } finally {
    current = undefined;
    requests.forEach((r) => r.destroy());
    httpAgent.destroy();
    await worker?.stop();
    await app?.close();
    await backing.close();
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
    if (oldSchedules === undefined) delete process.env.SCHEDULES_ENABLED;
    else process.env.SCHEDULES_ENABLED = oldSchedules;
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
      runtimeHotpaths: await runtimeHotpaths(process.env.TEST_DATABASE_URL, {
        httpDurationMs: Number(process.env.HTTP_DURATION_MS ?? 300000),
        activeRuns: Number(process.env.ACTIVE_RUNS ?? 100),
        sseConnections: Number(process.env.SSE_CONNECTIONS ?? 500),
        sseDurationMs: Number(process.env.SSE_DURATION_MS ?? 10000),
      }),
    }),
  );
}
