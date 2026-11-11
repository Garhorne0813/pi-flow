import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { PersonalPostgresStore } from "../../src/storage/personal-postgres-store.js";
import { PostgresRegistry, principal } from "../../src/storage/registry.js";
import { personalStore } from "../../src/storage/personal.js";
import { PersonalService } from "../../src/domain/personal-service.js";
import { buildAPI } from "../../src/api/server.js";
import { DemoSandbox, SandboxManager } from "../../src/sandbox/manager.js";
import { ScheduleService } from "../../src/schedules/service.js";
import { AgentConfig, event, id, type State } from "../../src/domain/model.js";
import { replaceAgents } from "../../src/config/agents.js";

export async function personalHistoryBenchmark(url: string) {
  const control = new pg.Pool({ connectionString: url }),
    schema = "personal_bench_" + id().replaceAll("-", "");
  await control.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const backing = new PersonalPostgresStore(scoped.toString());
  let measured = false,
    rows = 0,
    bytes = 0;
  backing.pool.on("connect", (c) => {
    const query = c.query.bind(c);
    // Capture actual SELECT rows/bytes returned to the app, not just SQL text.
    c.query = ((...args: any[]) => {
      const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
      const capture = (r: any) => {
        if (measured && /^\s*(SELECT|WITH)/i.test(sql ?? "")) {
          rows += r.rows?.length ?? 0;
          bytes += Buffer.byteLength(JSON.stringify(r.rows ?? []));
          assert.ok(
            !/FROM personal_run_events/i.test(sql),
            "claim/scheduler/files/session lists must not read historical events",
          );
        }
        return r;
      };
      const last = args.at(-1);
      if (typeof last === "function") {
        args[args.length - 1] = (e: unknown, r: unknown) => {
          if (!e) capture(r);
          last(e, r);
        };
        return (query as any)(...args);
      }
      return (query as any)(...args).then(capture);
    }) as typeof c.query;
  });
  let app: ReturnType<typeof buildAPI> | undefined;
  try {
    for (const name of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await backing.pool.query(await readFile("migrations/" + name, "utf8"));
    const registry = new PostgresRegistry(backing.pool),
      store = personalStore(backing, registry);
    const actor = await principal(registry, {
      tenantId: "bench",
      userId: "bench",
      admin: true,
    });
    const cfg = AgentConfig.parse({
      name: "bench",
      systemPrompt: "bench",
      model: { provider: "demo", modelId: "demo" },
      tools: [],
    });
    await registry.tx((s) =>
      replaceAgents(s, [{ key: "assistant", config: cfg }], actor),
    );
    const service = new PersonalService(store, registry),
      scheduler = new ScheduleService(service);
    const session = await service.createPersonalSession(actor, {
      agentId: "assistant",
    });
    const run = await service.submit(actor, session.id, "claim");
    const task = await scheduler.create(actor, {
      agentId: "assistant",
      cron: "* * * * *",
      prompt: "tick",
      sessionMode: "new",
    });
    const historySession = await service.createPersonalSession(actor, {
      agentId: "assistant",
    });
    const p95 = (v: number[]) =>
      v.sort((a, b) => a - b)[Math.ceil(v.length * 0.95) - 1]!;
    const results: {
      runs: number;
      events: number;
      claimP95Ms: number;
      scheduleP95Ms: number;
      filesP95Ms: number;
      sessionsP95Ms: number;
      sessionsRows: number;
      sessionsBytes: number;
      filesRows: number;
      filesBytes: number;
      claimRows: number;
      scheduleRows: number;
      claimBytes: number;
      scheduleBytes: number;
    }[] = [];
    app = buildAPI(
      service,
      async () => ({ ...actor, personal: false }),
      new SandboxManager(store, new DemoSandbox()),
    );
    let fireTime = 1;
    const sample = async (runs: number, events: number) => {
      const claimTimes: number[] = [],
        scheduleTimes: number[] = [],
        filesTimes: number[] = [],
        sessionsTimes: number[] = [];
      const totals = {
        claimRows: 0,
        scheduleRows: 0,
        claimBytes: 0,
        scheduleBytes: 0,
        filesRows: 0,
        filesBytes: 0,
        sessionsRows: 0,
        sessionsBytes: 0,
      };
      for (let i = 0; i < 25; i++) {
        await backing.pool.query(
          "UPDATE personal_runs SET state='QUEUED',lease_owner=NULL,lease_expires=NULL,data=(data-'lease')||'{\"state\":\"QUEUED\"}'::jsonb WHERE user_id=$1 AND run_id=$2",
          [actor.userId, run.id],
        );
        rows = bytes = 0;
        measured = true;
        let begin = performance.now();
        await store.claimRun!(actor.userId, run.id, (s) => {
          assert.equal(Object.keys(s.runs).length, 1);
          assert.equal(s.events.length, 0);
          assert.equal(s.sessions[session.id]!.entries, undefined);
          const target = s.runs[run.id]!;
          target.state = "RUNNING";
          target.lease = { owner: "bench", expires: Date.now() + 30000 };
          event(s, target, "run.started");
        });
        measured = false;
        if (i >= 5) {
          claimTimes.push(performance.now() - begin);
          totals.claimRows = Math.max(totals.claimRows, rows);
          totals.claimBytes = Math.max(totals.claimBytes, bytes);
        }
        await store.runTx(actor.userId, run.id, (s) => {
          const r = s.runs[run.id]!;
          r.state = "COMPLETED";
          delete r.lease;
        });
        await backing.pool.query(
          "UPDATE personal_scheduled_tasks SET data=jsonb_set(data,'{nextFireAt}',$3::jsonb) WHERE user_id=$1 AND schedule_id=$2",
          [actor.userId, task.id, String(fireTime++)],
        );
        rows = bytes = 0;
        measured = true;
        begin = performance.now();
        await scheduler.tick();
        measured = false;
        if (i >= 5) {
          scheduleTimes.push(performance.now() - begin);
          totals.scheduleRows = Math.max(totals.scheduleRows, rows);
          totals.scheduleBytes = Math.max(totals.scheduleBytes, bytes);
        }
        await backing.pool.query(
          "UPDATE personal_runs SET state='COMPLETED',data=data||'{\"state\":\"COMPLETED\"}'::jsonb WHERE user_id=$1 AND state='QUEUED' AND data->'schedule'->>'id'=$2",
          [actor.userId, task.id],
        );
      }
      // Exercise the actual HTTP path, including workspace initialization,
      // sandbox lease/volume lifecycle, capacity, and completion audit.
      for (let i = 0; i < 25; i++) {
        rows = bytes = 0;
        measured = true;
        const begin = performance.now();
        try {
          const put = await app!.inject({
            method: "PUT",
            url: "/api/v1/me/files",
            payload: { path: "bench.txt", content: "hello" },
          });
          assert.equal(put.statusCode, 200, put.body);
          const get = await app!.inject({
            method: "GET",
            url: "/api/v1/me/files?operation=read&path=bench.txt",
          });
          assert.equal(get.statusCode, 200, get.body);
          assert.deepEqual(get.json(), { text: "hello" });
          const del = await app!.inject({
            method: "DELETE",
            url: "/api/v1/me/files?path=bench.txt",
          });
          assert.equal(del.statusCode, 200, del.body);
        } finally {
          measured = false;
        }
        if (i >= 5) {
          filesTimes.push(performance.now() - begin);
          totals.filesRows = Math.max(totals.filesRows, rows);
          totals.filesBytes = Math.max(totals.filesBytes, bytes);
        }
      }
      for (let i = 0; i < 25; i++) {
        rows = bytes = 0;
        measured = true;
        const begin = performance.now();
        try {
          const page = await app!.inject({ url: "/api/v1/sessions?limit=1" });
          assert.equal(page.statusCode, 200, page.body);
          assert.equal(page.json().items.length, 1);
          assert.equal(page.json().items[0].entries, undefined);
        } finally {
          measured = false;
        }
        if (i >= 5) {
          sessionsTimes.push(performance.now() - begin);
          totals.sessionsRows = Math.max(totals.sessionsRows, rows);
          totals.sessionsBytes = Math.max(totals.sessionsBytes, bytes);
        }
      }
      results.push({
        runs,
        events,
        claimP95Ms: p95(claimTimes),
        scheduleP95Ms: p95(scheduleTimes),
        filesP95Ms: p95(filesTimes),
        sessionsP95Ms: p95(sessionsTimes),
        ...totals,
      });
    };
    await sample(0, 0);
    await backing.pool.query(
      `INSERT INTO personal_runs(user_id,run_id,session_id,actor_id,state,created_at,data)
      SELECT $1,'history-'||n,$2,$1,'COMPLETED',now(),$3::jsonb||jsonb_build_object('id','history-'||n,'sessionId',$2::text,'state','COMPLETED') FROM generate_series(1,5000) n`,
      [actor.userId, historySession.id, JSON.stringify(run)],
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
      `INSERT INTO personal_run_events(user_id,run_id,event_id,data)
      SELECT $1,'history-'||((n-1)%5000+1),$2::bigint+n,jsonb_build_object('eventId',$2::bigint+n,'runId','history-'||((n-1)%5000+1),'type','message.delta','data',repeat('x',1024)) FROM generate_series(1,50000) n`,
      [actor.userId, seq],
    );
    await backing.pool.query(
      "UPDATE personal_event_sequences SET cursor=cursor+50000 WHERE user_id=$1",
      [actor.userId],
    );
    await backing.pool.query(
      `INSERT INTO personal_schedule_fires(user_id,id,schedule_id,trigger,scheduled_for,data)
      SELECT $1,'past-'||n,$2,'cron',-n,jsonb_build_object('id','past-'||n,'scheduleId',$2::text,'trigger','cron','scheduledFor',-n,'state','completed') FROM generate_series(1,5000) n`,
      [actor.userId, task.id],
    );
    await backing.pool.query(
      `INSERT INTO personal_sessions(user_id,session_id,workspace_id,data)
       SELECT $1,'past-session-'||n,$1,jsonb_build_object('id','past-session-'||n,'workspaceId',$1::text,'userId',$1::text,'createdAt','2020-01-01T00:00:00.000Z','entries',jsonb_build_array(repeat('x',1024))) FROM generate_series(1,5000) n`,
      [actor.userId],
    );
    await backing.pool.query("ANALYZE personal_sessions");
    await backing.pool.query("ANALYZE personal_runs");
    await backing.pool.query("ANALYZE personal_schedule_fires");
    await sample(5000, 50000);
    const [small, large] = results;
    assert.equal(large!.claimRows, small!.claimRows);
    assert.equal(large!.scheduleRows, small!.scheduleRows);
    assert.equal(large!.filesRows, small!.filesRows);
    assert.equal(large!.sessionsRows, small!.sessionsRows);
    assert.ok(large!.sessionsBytes < small!.sessionsBytes * 1.2 + 1000);
    assert.ok(large!.filesBytes < small!.filesBytes * 1.2 + 1000);
    assert.ok(large!.claimBytes < small!.claimBytes * 1.2 + 1000);
    assert.ok(large!.scheduleBytes < small!.scheduleBytes * 1.2 + 1000);

    return results;
  } finally {
    measured = false;
    await app?.close();
    await backing.close();
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
      personalHistory: await personalHistoryBenchmark(
        process.env.TEST_DATABASE_URL,
      ),
    }),
  );
}
