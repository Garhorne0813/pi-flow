import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { PersonalPostgresStore } from "../src/storage/personal-postgres-store.js";
import { PostgresRegistry, principal } from "../src/storage/registry.js";
import { personalStore } from "../src/storage/personal.js";
import { PersonalService } from "../src/domain/personal-service.js";
import { replaceAgents } from "../src/config/agents.js";
import type { State, Actor } from "../src/domain/model.js";
function configure(
  s: State,
  input: { agents: unknown[]; policy: { disabledTools: string[] } },
  a: Actor,
) {
  s.policy = input.policy;
  return replaceAgents(s, input.agents, a);
}
import { AgentConfig, id, event, emptyState } from "../src/domain/model.js";
import { Worker } from "../src/execution/worker.js";
import { DemoSandbox, SandboxManager } from "../src/sandbox/manager.js";
import { DemoRuntime } from "../src/execution/runtime.js";
import { MCPManager } from "../src/mcp/manager.js";
const url = process.env.TEST_DATABASE_URL;
test(
  "personal PostgreSQL persists isolated identities, catalog, claims, checkpoints and event cursors across clients",
  { skip: !url },
  async () => {
    const admin = new pg.Pool({ connectionString: url }),
      schema = "personal_" + id().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const a = new PersonalPostgresStore(scoped.toString()),
      b = new PersonalPostgresStore(scoped.toString());
    let worker: Worker | undefined;
    try {
      for (const n of (await readdir("migrations"))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await a.pool.query(await readFile("migrations/" + n, "utf8"));
      await a.ready();
      await b.ready();
      const ar = new PostgresRegistry(a.pool),
        br = new PostgresRegistry(b.pool),
        sa = personalStore(a, ar),
        sb = personalStore(b, br),
        service = new PersonalService(sa, ar),
        other = new PersonalService(sb, br);
      const [alice, again] = await Promise.all([
        principal(ar, {
          tenantId: "identity-provider",
          issuer: "urn:ucs",
          userId: "a",
          admin: true,
        }),
        principal(br, {
          tenantId: "identity-provider",
          issuer: "urn:ucs",
          userId: "a",
          admin: true,
        }),
      ]);
      assert.equal(alice.userId, again.userId);
      const bob = await principal(br, {
        tenantId: "identity-provider",
        issuer: "urn:ucs",
        userId: "b",
        admin: false,
      });
      await ar.tx((s) =>
        configure(
          s,
          {
            agents: [
              {
                key: "assistant",
                config: AgentConfig.parse({
                  name: "a",
                  systemPrompt: "one",
                  model: { provider: "demo", modelId: "demo" },
                  tools: [],
                }),
              },
            ],
            policy: { disabledTools: [] },
          },
          alice,
        ),
      );
      assert.equal(
        await br.read((s) => Object.keys(s.managedAgents ?? {}).length),
        1,
      );
      assert.equal(
        Number(
          (await a.pool.query("SELECT count(*) FROM personal_agent_versions"))
            .rows[0].count,
        ),
        0,
      );
      const ses = await service.createPersonalSession(alice, {
        agentId: "assistant",
      });
      const [r1, r2] = await Promise.all([
        service.submit(alice, ses.id, "hello", "same"),
        other.submit(alice, ses.id, "hello", "same"),
      ]);
      assert.equal(r1.id, r2.id);
      await assert.rejects(other.submit(bob, ses.id, "steal"), {
        code: "SESSION_NOT_FOUND",
      });
      const sandbox = new SandboxManager(sa, new DemoSandbox());
      worker = new Worker(
        service,
        new DemoRuntime(),
        sandbox,
        new MCPManager(sa, {}),
      );
      for (let i = 0; i < 100; i++) {
        await worker.tick();
        const r = await sb.readRun(alice.tenantId, r1.id, (s) => s.runs[r1.id]);
        if (r?.state === "COMPLETED" && !r.lease) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const result = await sb.readRun(
        alice.tenantId,
        r1.id,
        (s) => ({ r: s.runs[r1.id], ses: s.sessions[ses.id] }),
        true,
      );
      assert.equal(result.r?.state, "COMPLETED");
      assert.ok(result.ses!.entries.length);
      const page = await sb.eventPage(
        alice.tenantId,
        r1.id,
        0,
        100,
        (s) => s.runs[r1.id]!.state,
      );
      assert.equal(page.state, "COMPLETED");
      assert.deepEqual(
        page.events.map((e) => e.seq),
        page.events.map((_, i) => i + 1),
      );
      assert.deepEqual(
        page.events.map((e) => e.eventId),
        page.events.map((_, i) => i + 1),
      );
      const before = page.events.length;
      await assert.rejects(
        sa.tx(alice.tenantId, (s) => {
          event(s, s.runs[r1.id]!, "rollback");
          throw new Error("rollback");
        }),
      );
      assert.equal(
        (
          await sb.eventPage(
            alice.tenantId,
            r1.id,
            0,
            100,
            (s) => s.runs[r1.id]!.state,
          )
        ).events.length,
        before,
      );
      assert.equal(
        Number(
          (await a.pool.query("SELECT count(*) FROM harness_runs")).rows[0]
            .count,
        ),
        0,
      );
      await ar.tx((s) =>
        replaceAgents(s, [], alice, s.configRevisions!.agents),
      );
      assert.equal(
        await br.read((s) => s.managedAgents!.assistant!.enabled),
        false,
      );
      await assert.rejects(
        other.createPersonalSession(alice, { agentId: "assistant" }),
        { code: "AGENT_NOT_FOUND" },
      );
    } finally {
      await worker?.stop();
      await a.close();
      await b.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  "v5 migration preserves waiting Run snapshots, converts Sessions, and does not require the old version registry",
  { skip: !url },
  async () => {
    const control = new pg.Pool({ connectionString: url }),
      schema = "editable_" + id().replaceAll("-", "");
    await control.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const backing = new PersonalPostgresStore(scoped.toString());
    let worker: Worker | undefined;
    try {
      const names = (await readdir("migrations"))
        .filter((n) => n.endsWith(".sql"))
        .sort();
      for (const name of names.filter((n) => n < "008"))
        await backing.pool.query(await readFile("migrations/" + name, "utf8"));
      const registry = new PostgresRegistry(backing.pool),
        actor = await principal(registry, {
          tenantId: "external",
          userId: "migration-user",
          admin: true,
        });
      const version = id(),
        sid = id(),
        rid = id(),
        iid = id(),
        now = new Date().toISOString();
      const config = AgentConfig.parse({
        name: "Assistant",
        systemPrompt: "original waiting snapshot",
        model: { provider: "demo", modelId: "demo" },
        tools: [],
      });
      await backing.pool.query(
        "INSERT INTO personal_agent_versions(id,agent_id,digest,config,published_at,enabled) VALUES($1,'assistant','old',$2,$3,true)",
        [version, JSON.stringify(config), now],
      );
      await backing.pool.query(
        "INSERT INTO platform_config(scope,document,revision) VALUES('runtime',$1,1)",
        [
          JSON.stringify({
            agents: {
              [version]: {
                id: version,
                agentId: "assistant",
                config,
                digest: "old",
                enabled: true,
                publishedAt: now,
              },
            },
            definitions: {
              assistant: {
                id: "assistant",
                key: "assistant",
                activeVersionId: version,
                enabled: true,
              },
            },
            publications: [{ revision: 1, digest: "old", publishedAt: now }],
            configRevisions: { agents: 1, global: 1 },
          }),
        ],
      );
      const seedLegacy = async (user: string, fn: (s: State) => void) => {
        const state = emptyState();
        fn(state);
        const { sessions, runs, events, ...meta } = state;
        await backing.pool.query(
          "INSERT INTO personal_user_state(user_id,state) VALUES($1,$2)",
          [user, JSON.stringify(meta)],
        );
        for (const v of Object.values(sessions))
          await backing.pool.query(
            "INSERT INTO personal_sessions(user_id,session_id,workspace_id,data) VALUES($1,$2,$3,$4)",
            [user, v.id, v.workspaceId, JSON.stringify(v)],
          );
        const { saveRun } = await import(
          "../src/storage/personal-run-store.js"
        );
        const c = await backing.pool.connect();
        try {
          for (const r of Object.values(runs)) await saveRun(c, user, r);
        } finally {
          c.release();
        }
      };
      await seedLegacy(actor.tenantId, (s) => {
        s.workspaces[actor.userId] = {
          id: actor.userId,
          name: "Personal",
          ownerId: actor.userId,
          members: { [actor.userId]: "owner" },
          bundle: "default",
        };
        s.sessions[sid] = {
          id: sid,
          workspaceId: actor.userId,
          userId: actor.userId,
          agentId: "assistant",
          agentVersionId: version,
          entries: [],
          createdAt: now,
          ...{ effectiveVersionId: version },
        };
        s.runs[rid] = {
          id: rid,
          sessionId: sid,
          actor,
          prompt: "original",
          state: "WAITING_INPUT",
          requestDigest: "old",
          createdAt: now,
          depth: 0,
          steps: 1,
          children: 0,
          taskId: rid,
          rootRunId: rid,
          agentVersionId: version,
          model: config.model,
        };
        s.interactions[iid] = {
          id: iid,
          runId: rid,
          kind: "question",
          payload: { question: "Continue?" },
          resolved: false,
        };
      });
      await backing.pool.query(
        await readFile("migrations/008_editable_agents.sql", "utf8"),
      );
      await assert.rejects(backing.ready(), /SCHEMA_MISMATCH/);
      await backing.pool.query(
        await readFile("migrations/009_personal_execution_indexes.sql", "utf8"),
      );
      await assert.rejects(backing.ready(), /SCHEMA_MISMATCH/);
      await backing.pool.query(
        await readFile(
          "migrations/010_personal_session_pagination.sql",
          "utf8",
        ),
      );
      await assert.rejects(backing.ready(), /SCHEMA_MISMATCH/);
      await backing.pool.query(
        await readFile("migrations/011_personal_runtime_hot_paths.sql", "utf8"),
      );
      await assert.rejects(backing.ready(), /SCHEMA_MISMATCH/);
      await backing.pool.query(
        await readFile("migrations/012_personal_queue_frontiers.sql", "utf8"),
      );
      await backing.pool.query(
        await readFile(
          "migrations/013_personal_dispatchable_sessions.sql",
          "utf8",
        ),
      );
      await backing.pool.query(
        await readFile("migrations/014_personal_control_paths.sql", "utf8"),
      );
      await backing.pool.query(
        (await readFile(
          "migrations/015_personal_legacy_tasks_stats.sql",
          "utf8",
        )) +
          "\n" +
          (await readFile("migrations/016_personal_evaluations.sql", "utf8")),
      );
      await backing.ready();
      const store = personalStore(backing, registry),
        service = new PersonalService(store, registry);
      const session = await store.read(actor.tenantId, (s) => s.sessions[sid]!);
      assert.equal(session.agentId, "assistant");
      assert.equal(session.agentVersionId, undefined);
      assert.equal("effectiveVersionId" in session, false);
      await registry.tx((s) =>
        replaceAgents(
          s,
          [
            {
              key: "assistant",
              config: {
                ...config,
                systemPrompt: "current edited configuration",
              },
            },
          ],
          actor,
          1,
        ),
      );
      // Historical enable flags no longer participate in execution authorization.
      await backing.pool.query(
        "UPDATE personal_agent_versions SET enabled=false",
      );
      const resumed = (await service.respond(actor, iid, "continue"))!;
      assert.equal(resumed.capabilities!.systemPrompt, config.systemPrompt);
      assert.equal(resumed.agentId, "assistant");
      const observed: string[] = [],
        runtime = new DemoRuntime();
      worker = new Worker(
        service,
        {
          execute: async (c) => {
            observed.push(c.config.systemPrompt);
            await runtime.execute(c);
          },
        },
        new SandboxManager(store, new DemoSandbox()),
        new MCPManager(store, {}),
      );
      async function complete(runId: string) {
        for (let i = 0; i < 100; i++) {
          await worker!.tick();
          const r = await store.readRun(
            actor.tenantId,
            runId,
            (s) => s.runs[runId]!,
          );
          if (["COMPLETED", "FAILED"].includes(r.state) && !r.lease) return r;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("Run did not finish");
      }
      assert.equal((await complete(resumed.id)).state, "COMPLETED");
      const next = await service.submit(actor, sid, "new root");
      assert.equal((await complete(next.id)).state, "COMPLETED");
      assert.deepEqual(observed, [
        config.systemPrompt,
        "current edited configuration",
      ]);
      for (const name of names)
        await backing.pool.query(await readFile("migrations/" + name, "utf8"));
      await backing.ready();
      assert.equal(
        await registry.read(
          (s) => s.managedAgents!.assistant!.config.systemPrompt,
        ),
        "current edited configuration",
      );
      assert.equal(
        Number(
          (
            await backing.pool.query(
              "SELECT count(*) FROM personal_agent_versions",
            )
          ).rows[0].count,
        ),
        1,
      );
      assert.equal(
        Number(
          (
            await backing.pool.query(
              "SELECT count(*) FROM platform_config_publications",
            )
          ).rows[0].count,
        ),
        0,
      );
    } finally {
      await worker?.stop();
      await backing.close();
      await control.query(`DROP SCHEMA ${schema} CASCADE`);
      await control.end();
    }
  },
);

async function reviewDatabase(includeExecutionMigration = true) {
  const control = new pg.Pool({ connectionString: url }),
    schema = "review_" + id().replaceAll("-", "");
  await control.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url!);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const a = new PersonalPostgresStore(scoped.toString()),
    b = new PersonalPostgresStore(scoped.toString());
  for (const name of (await readdir("migrations"))
    .filter(
      (n) =>
        n.endsWith(".sql") &&
        (includeExecutionMigration || Number(n.slice(0, 3)) < 9),
    )
    .sort())
    await a.pool.query(await readFile("migrations/" + name, "utf8"));
  const ar = new PostgresRegistry(a.pool),
    br = new PostgresRegistry(b.pool),
    sa = personalStore(a, ar),
    sb = personalStore(b, br);
  const actor = await principal(ar, {
    tenantId: "review",
    userId: "review",
    admin: true,
  });
  const config = AgentConfig.parse({
    name: "review",
    systemPrompt: "a",
    model: { provider: "demo", modelId: "demo" },
    tools: [],
  });
  await ar.tx((s) =>
    replaceAgents(
      s,
      [
        { key: "a", config },
        { key: "b", config: { ...config, systemPrompt: "b" } },
      ],
      actor,
    ),
  );
  return {
    a,
    b,
    ar,
    br,
    sa,
    sb,
    actor,
    config,
    service: new PersonalService(sa, ar),
    other: new PersonalService(sb, br),
    close: async () => {
      await a.close();
      await b.close();
      await control.query(`DROP SCHEMA ${schema} CASCADE`);
      await control.end();
    },
  };
}

test(
  "personal targeted claims preserve per-user serialization across clients and a saturated connection pool",
  { skip: !url },
  async () => {
    const f = await reviewDatabase();
    try {
      const runs = [];
      for (let i = 0; i < 12; i++) {
        const ses = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        });
        runs.push(await f.service.submit(f.actor, ses.id, "claim"));
      }
      const claimed = await Promise.all(
        runs.map((run, i) =>
          (i % 2 ? f.sa : f.sb).claimRun!(f.actor.userId, run.id, (s) => {
            const r = s.runs[run.id]!;
            if (
              Object.values(s.runs).some(
                (other) => other.id !== r.id && other.state === "RUNNING",
              )
            )
              return;
            r.state = "RUNNING";
            r.lease = { owner: "claim", expires: Date.now() + 30000 };
            event(s, r, "run.started");
            return r.id;
          }),
        ),
      );
      assert.equal(claimed.filter(Boolean).length, 1);
      assert.equal(
        Number(
          (
            await f.a.pool.query(
              "SELECT count(*) FROM personal_runs WHERE user_id=$1 AND state='RUNNING'",
              [f.actor.userId],
            )
          ).rows[0].count,
        ),
        1,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "scheduler targets normalized rows, settles across clients and creates one new Session after Agent/cwd edits",
  { skip: !url },
  async () => {
    const { ScheduleService } = await import("../src/schedules/service.js");
    const f = await reviewDatabase();
    try {
      const one = new ScheduleService(f.service),
        two = new ScheduleService(f.other);
      const task = await one.create(f.actor, {
        agentId: "a",
        // Explicitly force each due time below; avoid a real minute boundary
        // introducing an unrelated cron Fire during the settlement assertions.
        cron: "0 0 1 1 *",
        prompt: "tick",
      });
      let dueTime = 0;
      const due = () =>
        f.a.pool.query(
          "UPDATE personal_scheduled_tasks SET data=jsonb_set(data,'{nextFireAt}',$3::jsonb) WHERE user_id=$1 AND schedule_id=$2",
          [f.actor.userId, task.id, String(++dueTime)],
        );
      await due();
      await Promise.all([one.tick(), two.tick()]);
      let state = await f.sb.read(f.actor.userId, (s) => s);
      assert.equal(Object.values(state.scheduleFires!).length, 1);
      const first = Object.values(state.runs)[0]!;
      await f.sb.runTx(f.actor.userId, first.id, (s) => {
        s.runs[first.id]!.state = "COMPLETED";
      });
      await two.tick();
      assert.equal(
        await f.sa.read(
          f.actor.userId,
          (s) => Object.values(s.scheduleFires!)[0]!.state,
        ),
        "completed",
      );
      await two.update(f.actor, task.id, { agentId: "b", cwd: "changed" });
      await due();
      await Promise.all([one.tick(), two.tick()]);
      state = await f.sa.read(f.actor.userId, (s) => s);
      assert.equal(Object.keys(state.scheduleFires!).length, 2);
      const next = Object.values(state.runs).find((r) => r.id !== first.id)!;
      assert.notEqual(next.sessionId, first.sessionId);
      assert.equal(next.agentId, "b");
      assert.equal(next.cwd, "/workspace/changed");
      const metadata = (
        await f.a.pool.query(
          "SELECT state FROM personal_user_state WHERE user_id=$1",
          [f.actor.userId],
        )
      ).rows[0].state;
      assert.equal("schedules" in metadata, false);
      assert.equal("scheduleFires" in metadata, false);
      const scheduled = await f.sb.readMetadata(
        f.actor.userId,
        ["schedules", "scheduleFires"],
        (s) => ({
          task: s.schedules![task.id],
          fires: Object.values(s.scheduleFires!),
        }),
      );
      assert.equal(scheduled.task!.agentId, "b");
      assert.equal(scheduled.fires.length, 2);
      // Replay the normalization migration on a legacy metadata-only schedule.
      const legacy = { ...task, id: id(), prompt: "legacy", enabled: false },
        oldFire = {
          id: id(),
          scheduleId: legacy.id,
          trigger: "cron",
          scheduledFor: 1,
          state: "completed",
        };
      await f.a.pool.query(
        "UPDATE personal_user_state SET state=state||jsonb_build_object('schedules',$2::jsonb,'scheduleFires',$3::jsonb) WHERE user_id=$1",
        [
          f.actor.userId,
          JSON.stringify({ [legacy.id]: legacy }),
          JSON.stringify({ old: oldFire }),
        ],
      );
      const sql = await readFile(
        "migrations/009_personal_execution_indexes.sql",
        "utf8",
      );
      await f.a.pool.query(sql);
      await f.a.pool.query(sql);
      state = await f.sa.read(f.actor.userId, (s) => s);
      assert.equal(state.schedules![legacy.id]!.prompt, "legacy");
      assert.ok(
        Object.values(state.scheduleFires!).some((f) => f.id === oldFire.id),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "gateway and credential versions survive catalog replacement across PostgreSQL clients",
  { skip: !url },
  async () => {
    const { versionModelCatalog } = await import("../src/config/models.js"),
      { sealToken } = await import("../src/security/token-vault.js");
    const previous = process.env.CONFIG_SECRET_KEY;
    process.env.CONFIG_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");
    const f = await reviewDatabase();
    let worker: Worker | undefined;
    try {
      const catalog = async (modelId: string, key: string) =>
        f.ar.tx((s) => {
          s.managedAgents!.a!.config.model = {
            provider: "default",
            modelId: "default",
          };
          s.modelCatalog = [
            {
              provider: "test",
              modelId,
              baseUrl: `https://${modelId}.example/v1`,
              secretRef: "key",
              default: true,
            },
          ];
          s.secrets = {
            key: sealToken(key, "platform:key", "CONFIG_SECRET_KEY"),
          };
          versionModelCatalog(s);
        });
      await catalog("first", "first-key");
      const ses = await f.service.createPersonalSession(f.actor, {
        agentId: "a",
      });
      const queued = await f.service.submit(f.actor, ses.id, "queued");
      await catalog("second", "second-key");
      let gateway: unknown;
      worker = new Worker(
        f.other,
        {
          execute: async (c) => {
            gateway = c.gateway;
          },
        },
        new SandboxManager(f.sb, new DemoSandbox()),
        new MCPManager(f.sb, {}),
      );
      for (let i = 0; i < 100; i++) {
        await worker.tick();
        if (
          await f.sb.readRun(
            f.actor.userId,
            queued.id,
            (s) => s.runs[queued.id]!.state === "COMPLETED",
          )
        )
          break;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.deepEqual(gateway, {
        baseUrl: "https://first.example/v1",
        apiKey: "first-key",
      });
      assert.equal(
        await f.sb.readRun(
          f.actor.userId,
          queued.id,
          (s) => s.runs[queued.id]!.state,
        ),
        "COMPLETED",
      );
      const current = await f.other.submit(f.actor, ses.id, "new");
      assert.deepEqual(await f.other.gatewayFor(current), {
        baseUrl: "https://second.example/v1",
        apiKey: "second-key",
      });
    } finally {
      await worker?.stop();
      await f.close();
      if (previous === undefined) delete process.env.CONFIG_SECRET_KEY;
      else process.env.CONFIG_SECRET_KEY = previous;
    }
  },
);

test(
  "approval refresh persists task-bound tokens across PostgreSQL clients and dispatches bash with refreshed credentials",
  { skip: !url },
  async () => {
    const { openToken } = await import("../src/security/token-vault.js");
    const previous = process.env.RUN_TOKEN_KEY;
    process.env.RUN_TOKEN_KEY = Buffer.alloc(32, 12).toString("base64");
    const f = await reviewDatabase(),
      provider = new DemoSandbox();
    const worker = new Worker(
      f.service,
      {
        execute: async (c) => {
          await c.call("bash", { command: "user-api" });
        },
      },
      new SandboxManager(f.sa, provider),
      new MCPManager(f.sa, {}),
    );
    const seen: string[] = [];
    const execute = provider.execute.bind(provider);
    provider.execute = async (sid, op, args) => {
      if (op === "bash") {
        seen.push(String(args._userToken));
        if (args._userToken !== "new-postgres-token")
          throw new Error("USER_API_TOKEN_EXPIRED");
        return { stdout: "ok", exitCode: 0 };
      }
      return execute(sid, op, args);
    };
    const otherWorker = new Worker(
      f.other,
      new DemoRuntime(),
      new SandboxManager(f.sb, provider),
      new MCPManager(f.sb, {}),
    );
    const finish = async (w: Worker, rid: string) => {
      for (let i = 0; i < 200; i++) {
        await w.tick();
        const r = await f.sb.readRun(f.actor.userId, rid, (s) => s.runs[rid]!);
        if (
          ["WAITING_INPUT", "COMPLETED", "FAILED"].includes(r.state) &&
          !r.lease
        )
          return r;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("Run did not settle");
    };
    try {
      await f.ar.tx((s) => {
        s.managedAgents!.a!.config = AgentConfig.parse({
          ...f.config,
          tools: ["bash"],
          userTokenAccess: true,
        });
      });
      const ses = await f.service.createPersonalSession(f.actor, {
        agentId: "a",
      });
      const root = await f.service.submit(
        f.actor,
        ses.id,
        "call",
        undefined,
        undefined,
        undefined,
        "old-postgres-token",
      );
      assert.equal((await finish(worker, root.id)).state, "WAITING_INPUT");
      await worker.stop();
      const iid = await f.sb.read(
        f.actor.userId,
        (s) => Object.values(s.interactions)[0]!.id,
      );
      await f.sb.runTx(f.actor.userId, root.id, (s) => {
        s.runs[root.id]!.actor.expiresAt = Date.now() - 1;
      });
      await f.br.tx((s) => {
        s.managedAgents!.a!.config.userTokenAccess = false;
        s.managedAgents!.a!.config.systemPrompt = "changed";
      });
      const next = (await f.other.respond(
        { ...f.actor, expiresAt: Date.now() + 60000 },
        iid,
        "approve",
        "new-postgres-token",
      ))!;
      const stored = await f.sa.readRun(
        f.actor.userId,
        next.id,
        (s) => s.runs[next.id]!,
      );
      assert.equal(
        openToken(stored.userTokenRef!, f.actor.userId + ":" + root.taskId),
        "new-postgres-token",
      );
      assert.deepEqual(stored.capabilities, root.capabilities);
      assert.equal((await finish(otherWorker, next.id)).state, "COMPLETED");
      assert.deepEqual(seen, ["new-postgres-token"]);
      assert.equal(
        await f.sa.readRun(
          f.actor.userId,
          root.id,
          (s) => s.runs[root.id]!.userTokenRef,
        ),
        undefined,
      );
      assert.equal(
        await f.sa.readRun(
          f.actor.userId,
          next.id,
          (s) => s.runs[next.id]!.userTokenRef,
        ),
        undefined,
      );
      const rows = await f.a.pool.query(
        "SELECT data FROM personal_runs WHERE user_id=$1",
        [f.actor.userId],
      );
      assert.doesNotMatch(
        JSON.stringify(rows.rows),
        /old-postgres-token|new-postgres-token/,
      );
    } finally {
      await worker.stop();
      await otherWorker.stop();
      await f.close();
      if (previous === undefined) delete process.env.RUN_TOKEN_KEY;
      else process.env.RUN_TOKEN_KEY = previous;
    }
  },
);

test(
  "personal readiness requires committed migrations 009/010/011/012/013/014/015, normalized schedules and all valid hot-path indexes",
  { skip: !url },
  async () => {
    const { ScheduleService } = await import("../src/schedules/service.js"),
      { buildAPI } = await import("../src/api/server.js");
    const f = await reviewDatabase(false),
      scheduler = new ScheduleService(f.service);
    const app = buildAPI(
      f.service,
      async () => f.actor,
      new SandboxManager(f.sa, new DemoSandbox()),
    );
    try {
      const { ScheduleInput } = await import("../src/schedules/service.js");
      const task = {
        ...ScheduleInput.parse({
          agentId: "a",
          cron: "* * * * *",
          prompt: "legacy",
        }),
        id: id(),
        userId: f.actor.userId,
        actor: f.actor,
        nextFireAt: Date.now(),
        failures: 0,
        createdAt: new Date().toISOString(),
      };
      await f.a.pool.query(
        "INSERT INTO personal_user_state(user_id,state) VALUES($1,$2)",
        [f.actor.userId, JSON.stringify(emptyState())],
      );
      const fire = {
        id: id(),
        scheduleId: task.id,
        trigger: "cron",
        scheduledFor: 1,
        state: "completed",
      };
      await f.a.pool.query(
        "DELETE FROM personal_scheduled_tasks WHERE user_id=$1 AND schedule_id=$2",
        [f.actor.userId, task.id],
      );
      await f.a.pool.query(
        "UPDATE personal_user_state SET state=state||jsonb_build_object('schedules',$2::jsonb,'scheduleFires',$3::jsonb) WHERE user_id=$1",
        [
          f.actor.userId,
          JSON.stringify({ [task.id]: task }),
          JSON.stringify({ legacy: fire }),
        ],
      );
      await assert.rejects(f.a.ready(), /SCHEMA_MISMATCH/);
      assert.equal(
        (await app.inject({ url: "/health/ready" })).statusCode,
        503,
      );
      const migration =
        (await readFile(
          "migrations/009_personal_execution_indexes.sql",
          "utf8",
        )) +
        "\n" +
        (await readFile(
          "migrations/010_personal_session_pagination.sql",
          "utf8",
        )) +
        "\n" +
        (await readFile(
          "migrations/011_personal_runtime_hot_paths.sql",
          "utf8",
        )) +
        "\n" +
        (await readFile(
          "migrations/012_personal_queue_frontiers.sql",
          "utf8",
        )) +
        "\n" +
        (await readFile(
          "migrations/013_personal_dispatchable_sessions.sql",
          "utf8",
        )) +
        "\n" +
        (await readFile("migrations/014_personal_control_paths.sql", "utf8")) +
        "\n" +
        ((await readFile(
          "migrations/015_personal_legacy_tasks_stats.sql",
          "utf8",
        )) +
          "\n" +
          (await readFile("migrations/016_personal_evaluations.sql", "utf8")));
      const c = await f.a.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(migration);
        await assert.rejects(f.a.ready(), /SCHEMA_MISMATCH/);
        await c.query("ROLLBACK");
        await assert.rejects(f.a.ready(), /SCHEMA_MISMATCH/);
        await c.query("BEGIN");
        await c.query(migration);
        await c.query("COMMIT");
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
      await f.a.ready();
      assert.equal(
        (await app.inject({ url: "/health/ready" })).statusCode,
        200,
      );
      const migrated = await f.sb.readMetadata(
        f.actor.userId,
        ["schedules", "scheduleFires"],
        (s) => ({
          task: s.schedules![task.id],
          fires: Object.values(s.scheduleFires!),
        }),
      );
      assert.equal(migrated.task!.prompt, "legacy");
      assert.equal(migrated.fires[0]!.id, fire.id);
      assert.equal(
        Number(
          (
            await f.a.pool.query(
              "SELECT version FROM personal_schema WHERE id=1",
            )
          ).rows[0].version,
        ),
        14,
      );
      for (const index of [
        "personal_runs_running",
        "personal_scheduled_tasks_due",
        "personal_schedule_fires_pending",
        "personal_sessions_list",
        "personal_runs_task",
        "personal_runs_global_queued",
        "personal_usage_period",
        "personal_usage_run",
        "personal_resources_user",
        "personal_workspace_idle",
        "personal_run_work_queued",
        "personal_run_work_expired",
        "personal_workspace_rotation",
        "personal_schedule_fires_history",
        "personal_run_work_dispatchable",
        "personal_audit_page",
        "personal_runs_task_identity",
        "personal_tool_failures",
      ]) {
        await f.a.pool.query(`DROP INDEX ${index}`);
        await assert.rejects(f.a.ready(), /SCHEMA_INDEXES_INCOMPLETE/);
        assert.equal(
          (await app.inject({ url: "/health/ready" })).statusCode,
          503,
        );
        await f.a.pool.query(migration);
        await f.a.ready();
      }
      await f.a.pool.query("DROP TABLE personal_schedule_fires");
      await assert.rejects(f.a.ready(), /SCHEMA_INCOMPLETE/);
    } finally {
      await app.close();
      await f.close();
    }
  },
);

for (const paused of [false, true])
  test(
    `personal SSE revokes a disabled database account on an existing ${paused ? "backpressured" : "idle"} connection`,
    { skip: !url },
    async () => {
      const { buildAPI } = await import("../src/api/server.js"),
        { get } = await import("node:http");
      const f = await reviewDatabase();
      const session = await f.service.createPersonalSession(f.actor, {
        agentId: "a",
      });
      const run = await f.service.submit(f.actor, session.id, "stream");
      await f.sa.runTx(f.actor.tenantId, run.id, (s) => {
        s.runs[run.id]!.state = "RUNNING";
        if (paused)
          for (let i = 0; i < 100; i++)
            event(s, s.runs[run.id]!, "message.delta", {
              delta: "x".repeat(256 * 1024),
            });
      });
      const app = buildAPI(
        f.service,
        async () => ({
          ...f.actor,
          personal: false,
          expiresAt: Date.now() + 60000,
        }),
        new SandboxManager(f.sa, new DemoSandbox()),
      );
      let closed = false,
        blocked = false,
        body = "";
      let raw: import("node:http").ServerResponse | undefined;
      app.addHook("onRequest", async (_req, reply) => {
        raw = reply.raw;
        reply.raw.once("close", () => {
          closed = true;
        });
      });
      const base = await app.listen({ host: "127.0.0.1", port: 0 });
      const request = get(
        `${base}/api/v1/runs/${run.id}/events`,
        (response) => {
          response.on("error", () => {});
          if (paused) response.pause();
          else
            response.on("data", (chunk) => {
              body += chunk;
            });
        },
      );
      request.on("error", () => {});
      try {
        const startDeadline = Date.now() + 5000;
        while (Date.now() < startDeadline) {
          blocked = raw?.writableNeedDrain ?? false;
          if (paused ? blocked : body.includes("run.queued")) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(closed, false);
        if (paused) assert.equal(blocked, true);
        else assert.match(body, /run.queued/);
        await f.b.pool.query(
          "UPDATE personal_users SET enabled=false WHERE id=$1",
          [f.actor.userId],
        );
        const deadline = Date.now() + 3000;
        while (!closed && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 20));
        assert.equal(
          closed,
          true,
          "disable must close SSE without waiting for JWT expiry or new events",
        );
        if (!paused) {
          await new Promise((r) => setTimeout(r, 20));
          assert.match(body, /"code":"ACCESS_REVOKED"/);
        }
        const denied = await app.inject({
          method: "GET",
          url: `/api/v1/runs/${run.id}/events`,
        });
        assert.equal(denied.statusCode, 403);
      } finally {
        request.destroy();
        await app.close();
        await f.close();
      }
    },
  );

test(
  "workspace initialization and file leases preserve unrelated metadata and reject active Runs across clients",
  { skip: !url },
  async () => {
    const { buildAPI } = await import("../src/api/server.js");
    const f = await reviewDatabase();
    const app = buildAPI(
      f.other,
      async () => ({ ...f.actor, personal: false }),
      new SandboxManager(f.sb, new DemoSandbox()),
    );
    try {
      const workspaces = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? f.service : f.other).ensureWorkspace(f.actor),
        ),
      );
      assert.equal(new Set(workspaces.map((w) => w.id)).size, 1);
      await f.a.pool.query(
        "UPDATE personal_user_state SET state=state||$2::jsonb WHERE user_id=$1",
        [
          f.actor.userId,
          JSON.stringify({
            custom: { preserved: true },
          }),
        ],
      );
      await f.sa.tx(f.actor.userId, (s) => {
        s.audit.push({
          id: "old-audit",
          timestamp: new Date().toISOString(),
          actorId: f.actor.userId,
          action: "seed",
          resource: "seed",
          result: "ok",
        });
        (s.usage ??= { requests: {}, resources: [] }).resources.push({
          state: "released",
          sandboxId: "old-resource",
          at: 0,
          workspaceId: f.actor.userId,
        });
      });
      const session = await f.service.createPersonalSession(f.actor, {
        agentId: "a",
      });
      const r = await f.service.submit(f.actor, session.id, "active");
      await f.sa.runTx(f.actor.userId, r.id, (s) => {
        s.runs[r.id]!.state = "RUNNING";
      });
      const blocked = await app.inject({
        method: "PUT",
        url: "/api/v1/me/files",
        payload: { path: "test.txt", content: "no" },
      });
      assert.equal(blocked.statusCode, 409, blocked.body);
      await f.sa.runTx(f.actor.userId, r.id, (s) => {
        s.runs[r.id]!.state = "COMPLETED";
      });
      const written = await app.inject({
        method: "PUT",
        url: "/api/v1/me/files",
        payload: { path: "test.txt", content: "yes" },
      });
      assert.equal(written.statusCode, 200, written.body);
      const row = (
        await f.a.pool.query(
          "SELECT state FROM personal_user_state WHERE user_id=$1",
          [f.actor.userId],
        )
      ).rows[0].state;
      assert.deepEqual(row.custom, { preserved: true });
      const records = await f.sa.readMetadata(
        f.actor.userId,
        ["audit", "usage"],
        (s) => ({ audit: s.audit, usage: s.usage }),
      );
      assert.ok(
        records.audit.some((a: { id: string }) => a.id === "old-audit"),
      );
      assert.ok(
        records.audit.some(
          (a: { action: string }) => a.action === "sandbox.creation.dispatched",
        ),
      );
      assert.ok(
        records.usage!.resources.some(
          (r: { sandboxId?: string }) => r.sandboxId === "old-resource",
        ),
      );
      assert.ok(
        records.usage!.resources.some(
          (r: { state: string }) => r.state === "active",
        ),
      );
      assert.equal(
        (await f.sa.readRun(f.actor.userId, r.id, (s) => s.runs[r.id]!)).state,
        "COMPLETED",
      );
    } finally {
      await app.close();
      await f.close();
    }
  },
);

test(
  "concurrent personal SSE identity checks perform SELECT only, preserve row versions, and revoke every connection",
  { skip: !url },
  async () => {
    const { buildAPI } = await import("../src/api/server.js");
    const f = await reviewDatabase();
    const ses = await f.service.createPersonalSession(f.actor, {
        agentId: "a",
      }),
      r = await f.service.submit(f.actor, ses.id, "stream");
    await f.sa.runTx(f.actor.userId, r.id, (s) => {
      s.runs[r.id]!.state = "RUNNING";
    });
    const app = buildAPI(
      f.service,
      async () => ({
        ...f.actor,
        personal: false,
        expiresAt: Date.now() + 60000,
      }),
      new SandboxManager(f.sa, new DemoSandbox()),
    );
    let connected = 0,
      checks = 0;
    app.addHook("onRequest", async () => {
      connected++;
    });
    const verify = f.ar.verifyIdentity.bind(f.ar);
    f.ar.verifyIdentity = async (...args) => {
      await verify(...args);
      checks++;
    };
    const streams = Array.from({ length: 8 }, () =>
      app
        .inject({ method: "GET", url: `/api/v1/runs/${r.id}/events` })
        .then((r) => r),
    );
    try {
      const deadline = Date.now() + 5000;
      while (connected < 8 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(connected, 8);
      const version = async () =>
        (
          await f.b.pool.query(
            "SELECT xmin::text FROM personal_users WHERE id=$1",
            [f.actor.userId],
          )
        ).rows[0].xmin;
      const before = await version();
      while (checks < 16 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      assert.ok(
        checks >= 16,
        "each open connection must recheck identity repeatedly",
      );
      assert.equal(
        await version(),
        before,
        "periodic checks must not UPDATE the user row",
      );
      const count = (
        await f.b.pool.query("SELECT count(*)::int AS n FROM personal_users")
      ).rows[0].n;
      await assert.rejects(
        f.ar.verifyIdentity("missing", "missing", f.actor.userId),
        { code: "USER_DISABLED" },
      );
      await assert.rejects(
        f.ar.verifyIdentity(f.actor.issuer!, f.actor.subject!, id()),
        { code: "USER_DISABLED" },
      );
      assert.equal(
        (await f.b.pool.query("SELECT count(*)::int AS n FROM personal_users"))
          .rows[0].n,
        count,
      );
      await f.b.pool.query(
        "UPDATE personal_users SET enabled=false WHERE id=$1",
        [f.actor.userId],
      );
      for (const response of await Promise.all(streams))
        assert.match(response.body, /"code":"ACCESS_REVOKED"/);
    } finally {
      await f.b.pool.query(
        "UPDATE personal_users SET enabled=false WHERE id=$1",
        [f.actor.userId],
      );
      await Promise.all(streams);
      await app.close();
      await f.close();
    }
  },
);

test(
  "personal Session HTTP pagination excludes transcripts, deleted Sessions and other users with stable timestamp ties",
  { skip: !url },
  async () => {
    const { buildAPI } = await import("../src/api/server.js");
    const f = await reviewDatabase(),
      ids = Array.from({ length: 6 }, () => id())
        .sort()
        .reverse();
    const other = await principal(f.ar, {
      tenantId: "external",
      userId: "other",
      admin: false,
    });
    await f.service.ensureWorkspace(f.actor);
    await f.service.ensureWorkspace(other);
    const createdAt = "2026-01-01T00:00:00.000Z";
    for (let i = 0; i < ids.length; i++) {
      const user = i === 5 ? other : f.actor;
      await f.a.pool.query(
        "INSERT INTO personal_sessions(user_id,session_id,workspace_id,data) VALUES($1,$2,$1,$3)",
        [
          user.userId,
          ids[i],
          JSON.stringify({
            id: ids[i],
            workspaceId: user.userId,
            userId: user.userId,
            createdAt,
            title: "session",
            entries: ["transcript".repeat(10000)],
            ...(i === 4 ? { deletedAt: createdAt } : {}),
          }),
        ],
      );
    }
    const app = buildAPI(
      f.service,
      async () => ({ ...f.actor, personal: false }),
      new SandboxManager(f.sa, new DemoSandbox()),
    );
    try {
      for (let offset = 0; offset < 4; offset++) {
        const response = await app.inject({
          url: `/api/v1/sessions?offset=${offset}&limit=1`,
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(
          response.json().items.map((s: { id: string }) => s.id),
          [ids[offset]],
        );
        assert.equal(response.json().items[0].entries, undefined);
        assert.doesNotMatch(response.body, /transcript/);
      }
      assert.deepEqual(
        (await app.inject({ url: "/api/v1/sessions?offset=4&limit=1" })).json()
          .items,
        [],
      );
      assert.deepEqual(
        (await f.sb.listSessions!(other.userId, other.userId, 0, 100)).map(
          (s) => s.id,
        ),
        [ids[5]],
      );
      const c = await f.a.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL enable_seqscan=off");
        const plan = await c.query(
          "EXPLAIN (FORMAT JSON) SELECT data-'entries' FROM personal_sessions WHERE user_id=$1 AND data->>'userId'=$1 AND COALESCE(data->>'deletedAt','')='' ORDER BY data->>'createdAt' DESC,session_id DESC LIMIT 1",
          [f.actor.userId],
        );
        assert.match(JSON.stringify(plan.rows), /personal_sessions_list/);
        assert.doesNotMatch(
          JSON.stringify(plan.rows),
          /\"Node Type\":\"Sort\"/,
        );
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    } finally {
      await app.close();
      await f.close();
    }
  },
);

test(
  "Memory quota reservations and failed-write refunds persist across PostgreSQL clients",
  { skip: !url },
  async () => {
    const { MemoryManager } = await import("../src/execution/memory.js"),
      { Fault } = await import("../src/domain/model.js");
    const f = await reviewDatabase(),
      provider = new DemoSandbox();
    const m1 = new MemoryManager(f.sa, new SandboxManager(f.sa, provider)),
      m2 = new MemoryManager(f.sb, new SandboxManager(f.sb, provider));
    const cfg = AgentConfig.parse({
      ...f.config,
      memory: { enabled: true, maxWritesPerRun: 1 },
    });
    const ses = await f.service.createPersonalSession(f.actor, {
        agentId: "a",
      }),
      run = await f.service.submit(f.actor, ses.id, "remember");
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const execute = provider.execute.bind(provider);
    let block = true;
    provider.execute = async (sid, op, args) => {
      if (block && op === "find") {
        entered();
        await gate;
        throw new Fault(502, "TEST_WRITE_FAILED");
      }
      return execute(sid, op, args);
    };
    const write = (m: typeof m1) =>
      m.write(
        f.actor,
        f.actor.userId,
        run.id,
        cfg,
        "/workspace",
        "/workspace/memory/note.md",
        "hello",
        new AbortController().signal,
      );
    const first = assert.rejects(write(m1), { code: "TEST_WRITE_FAILED" });
    try {
      await ready;
      await assert.rejects(write(m2), { code: "MEMORY_WRITE_LIMIT" });
      release();
      await first;
      const refunded = await f.sb.readRun(
        f.actor.userId,
        run.id,
        (s) => s.runs[run.id]!,
      );
      assert.equal(refunded.memoryWrites ?? 0, 0);
      assert.equal(refunded.memoryWriteReservations, undefined);
      block = false;
      await write(m2);
      const current = await f.sa.readRun(
        f.actor.userId,
        run.id,
        (s) => s.runs[run.id]!,
      );
      assert.equal(current.memoryWrites, 1);
      assert.equal(current.memoryWriteReservations, undefined);
      await assert.rejects(write(m1), { code: "MEMORY_WRITE_LIMIT" });
      assert.equal(
        (
          await f.sa.readMetadata(f.actor.userId, ["audit"], (s) =>
            s.audit.filter((a) => a.action === "memory.write"),
          )
        ).length,
        1,
      );
    } finally {
      release();
      await first;
      await f.close();
    }
  },
);

test(
  "existing identity lookup never rewrites users and concurrent first registration creates one identity",
  { skip: !url },
  async () => {
    const f = await reviewDatabase();
    try {
      const initial = (
        await f.a.pool.query(
          "SELECT xmin::text FROM personal_users WHERE id=$1",
          [f.actor.userId],
        )
      ).rows[0].xmin;
      await Promise.all(
        Array.from({ length: 20 }, () =>
          f.ar.identify(f.actor.issuer!, f.actor.subject!),
        ),
      );
      assert.equal(
        (
          await f.a.pool.query(
            "SELECT xmin::text FROM personal_users WHERE id=$1",
            [f.actor.userId],
          )
        ).rows[0].xmin,
        initial,
      );
      const ids = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 ? f.ar : f.br).identify("urn:race", "new-user"),
        ),
      );
      assert.equal(new Set(ids).size, 1);
      assert.equal(
        (
          await f.a.pool.query(
            "SELECT count(*)::int n FROM personal_users WHERE issuer='urn:race'",
          )
        ).rows[0].n,
        1,
      );
      await f.a.pool.query(
        "UPDATE personal_users SET enabled=false WHERE id=$1",
        [ids[0]],
      );
      await assert.rejects(f.ar.identify("urn:race", "new-user"), {
        code: "USER_DISABLED",
      });
    } finally {
      await f.close();
    }
  },
);
test(
  "normalized model budgets include other tasks, reserve atomically and settle idempotently across clients",
  { skip: !url },
  async () => {
    const { UsageLedger, UsagePolicy } = await import("../src/domain/usage.js");
    const f = await reviewDatabase();
    try {
      const ses = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        }),
        r = await f.service.submit(f.actor, ses.id, "budget");
      await f.sa.runTx(f.actor.userId, r.id, (s) => {
        s.runs[r.id]!.state = "RUNNING";
        s.runs[r.id]!.lease = { owner: "owner", expires: Date.now() + 30000 };
      });
      const prior = {
        id: "previous",
        runId: "previous-task",
        userId: f.actor.userId,
        workspaceId: f.actor.userId,
        agentId: "a",
        model: "demo/demo",
        at: new Date().toISOString(),
        status: "confirmed",
        tokens: 400,
        estimatedTokens: 400,
        maxOutputTokens: 400,
        costMicros: null,
        estimatedCostMicros: null,
        pricingVersion: null,
      };
      await f.a.pool.query(
        "INSERT INTO personal_usage_requests(user_id,id,run_id,at,data) VALUES($1,$2,$3,$4,$5)",
        [
          f.actor.userId,
          prior.id,
          prior.runId,
          prior.at,
          JSON.stringify(prior),
        ],
      );
      const ledger = new UsageLedger(
          f.sa,
          UsagePolicy.parse({ userDailyTokens: 500 }),
        ),
        other = new UsageLedger(
          f.sb,
          UsagePolicy.parse({ userDailyTokens: 500 }),
        );
      const reserved = await ledger.reserve(f.actor.userId, r.id, 10, "owner");
      assert.equal(reserved.maxOutputTokens, 90);
      await assert.rejects(other.reserve(f.actor.userId, r.id, 1, "owner"), {
        code: "MODEL_BUDGET_EXCEEDED",
      });
      await other.settle(
        f.actor.userId,
        reserved.id,
        { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
        10,
      );
      await ledger.settle(
        f.actor.userId,
        reserved.id,
        {
          input: 100,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 200,
        },
        100,
      );
      const next = await ledger.reserve(f.actor.userId, r.id, 10, "owner");
      assert.equal(next.maxOutputTokens, 60);
      const record = await f.sa.readMetadata(
        f.actor.userId,
        ["usage"],
        (s) => s.usage!.requests[reserved.id]!,
      );
      assert.equal(record.tokens, 30);
    } finally {
      await f.close();
    }
  },
);
test(
  "batched stream events preserve per-Run order without rewriting Runs and notifications cover the query/wait race",
  { skip: !url },
  async () => {
    const f = await reviewDatabase();
    let watch: Awaited<ReturnType<typeof f.a.watchEvents>> | undefined;
    try {
      const ses = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        }),
        r = await f.service.submit(f.actor, ses.id, "stream");
      await f.sa.runTx(f.actor.userId, r.id, (s) => {
        s.runs[r.id]!.state = "RUNNING";
        s.runs[r.id]!.lease = { owner: "owner", expires: Date.now() + 30000 };
      });
      const before = (
        await f.a.pool.query(
          "SELECT xmin::text,data FROM personal_runs WHERE user_id=$1 AND run_id=$2",
          [f.actor.userId, r.id],
        )
      ).rows[0];
      watch = await f.a.watchEvents(f.actor.userId, r.id);
      const initial = await f.sa.eventPage(
        f.actor.userId,
        r.id,
        0,
        100,
        (s) => s.runs[r.id]!.state,
      );
      const cursor = initial.events.at(-1)!.eventId;
      await Promise.all(
        [f.a, f.b].map((store) =>
          store.appendRunEvents(
            f.actor.userId,
            r.id,
            "owner",
            Array.from({ length: 50 }, (_, n) => ({
              type: "message.delta",
              data: { delta: String(n) },
            })),
          ),
        ),
      );
      const start = Date.now();
      await watch.wait(5000);
      assert.ok(
        Date.now() - start < 4000,
        "a notification before wait must remain pending",
      );
      const listener = (f.a as unknown as { listener: { processID: number } })
        .listener;
      await f.b.pool.query("SELECT pg_terminate_backend($1)", [
        listener.processID,
      ]);
      await watch.wait(5000); // disconnect wake plus reconnect before the next page
      await f.b.appendRunEvents(f.actor.userId, r.id, "owner", [
        { type: "test.after-reconnect", data: {} },
      ]);
      const reconnected = Date.now();
      await watch.wait(5000);
      assert.ok(Date.now() - reconnected < 4000);
      const after = (
        await f.a.pool.query(
          "SELECT xmin::text,data FROM personal_runs WHERE user_id=$1 AND run_id=$2",
          [f.actor.userId, r.id],
        )
      ).rows[0];
      assert.deepEqual(after, before);
      const events = (
        await f.sa.eventPage(
          f.actor.userId,
          r.id,
          cursor,
          100,
          (s) => s.runs[r.id]!.state,
        )
      ).events;
      assert.equal(events.length, 100);
      assert.deepEqual(
        events.map((e) => e.seq),
        Array.from({ length: 100 }, (_, i) => i + 2),
      );
      await assert.rejects(
        f.b.appendRunEvents(f.actor.userId, r.id, "wrong-owner", [
          { type: "message.delta", data: { delta: "bad" } },
        ]),
        { code: "LEASE_LOST" },
      );
      assert.equal(
        await f.b.renewRunLease(
          f.actor.userId,
          r.id,
          "wrong-owner",
          Date.now(),
        ),
        false,
      );
      assert.equal(
        await f.b.renewRunLease(f.actor.userId, r.id, "owner", Date.now()),
        true,
      );
      await f.sb.runTx(f.actor.userId, r.id, (s) => {
        s.runs[r.id]!.cancelRequested = true;
      });
      assert.equal(
        await f.a.renewRunLease(f.actor.userId, r.id, "owner", Date.now()),
        false,
      );
    } finally {
      watch?.close();
      await f.close();
    }
  },
);
test(
  "011 atomically migrates JSONB audit, model/resource records and active sandbox bindings, and replays without duplicates",
  { skip: !url },
  async () => {
    const f = await reviewDatabase(false);
    try {
      await f.a.pool.query(
        await readFile("migrations/009_personal_execution_indexes.sql", "utf8"),
      );
      await f.a.pool.query(
        await readFile(
          "migrations/010_personal_session_pagination.sql",
          "utf8",
        ),
      );
      const w = {
        id: f.actor.userId,
        name: "legacy",
        ownerId: f.actor.userId,
        members: { [f.actor.userId]: "owner" },
        sandboxId: "legacy-box",
        sandboxState: "active",
        sandboxLastUsedAt: 1,
      };
      const request = {
        id: "request",
        runId: "run",
        at: new Date().toISOString(),
        tokens: 10,
      };
      await f.a.pool.query(
        "INSERT INTO personal_user_state(user_id,state) VALUES($1,$2)",
        [
          f.actor.userId,
          JSON.stringify({
            ...emptyState(),
            workspaces: { [w.id]: w },
            audit: [{ id: "audit", action: "test" }],
            usage: {
              requests: { request },
              resources: [
                {
                  workspaceId: w.id,
                  sandboxId: "legacy-box",
                  state: "active",
                  at: 1,
                },
              ],
            },
          }),
        ],
      );
      await assert.rejects(f.a.ready(), /SCHEMA_MISMATCH/);
      const migration = await readFile(
          "migrations/011_personal_runtime_hot_paths.sql",
          "utf8",
        ),
        c = await f.a.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(migration);
        await assert.rejects(f.a.ready(), /SCHEMA_MISMATCH/);
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
      await f.a.pool.query(migration);
      await assert.rejects(f.a.ready(), /SCHEMA_MISMATCH/);
      await f.a.pool.query(
        await readFile("migrations/012_personal_queue_frontiers.sql", "utf8"),
      );
      await f.a.pool.query(
        await readFile(
          "migrations/013_personal_dispatchable_sessions.sql",
          "utf8",
        ),
      );
      await f.a.pool.query(
        await readFile("migrations/014_personal_control_paths.sql", "utf8"),
      );
      await f.a.pool.query(
        (await readFile(
          "migrations/015_personal_legacy_tasks_stats.sql",
          "utf8",
        )) +
          "\n" +
          (await readFile("migrations/016_personal_evaluations.sql", "utf8")),
      );
      await f.a.ready();
      await f.a.pool.query(migration);
      await f.a.pool.query(
        await readFile("migrations/012_personal_queue_frontiers.sql", "utf8"),
      );
      await f.a.pool.query(
        await readFile(
          "migrations/013_personal_dispatchable_sessions.sql",
          "utf8",
        ),
      );
      await f.a.pool.query(
        await readFile("migrations/014_personal_control_paths.sql", "utf8"),
      );
      await f.a.pool.query(
        (await readFile(
          "migrations/015_personal_legacy_tasks_stats.sql",
          "utf8",
        )) +
          "\n" +
          (await readFile("migrations/016_personal_evaluations.sql", "utf8")),
      );
      const records = await f.sb.readMetadata(
        f.actor.userId,
        ["audit", "usage"],
        (s) => ({ audit: s.audit, usage: s.usage }),
      );
      assert.equal(records.audit.length, 1);
      assert.equal(records.usage!.requests.request!.tokens, 10);
      assert.equal(records.usage!.resources.length, 1);
      const metadata = (
        await f.a.pool.query(
          "SELECT state FROM personal_user_state WHERE user_id=$1",
          [f.actor.userId],
        )
      ).rows[0].state;
      assert.equal("audit" in metadata, false);
      assert.equal("usage" in metadata, false);
      assert.equal(
        (
          await f.a.pool.query(
            "SELECT sandbox_id FROM personal_sandbox_leases WHERE tenant_id=$1 AND workspace_id=$1",
            [f.actor.userId],
          )
        ).rows[0].sandbox_id,
        "legacy-box",
      );
      await f.a.pool.query("DROP INDEX personal_workspace_idle");
      await assert.rejects(f.b.ready(), /SCHEMA_INDEXES_INCOMPLETE/);
    } finally {
      await f.close();
    }
  },
);

test(
  "Schedule firing and settlement persist audit only in personal_audit without metadata rewrites",
  { skip: !url },
  async () => {
    const { ScheduleService } = await import("../src/schedules/service.js");
    const f = await reviewDatabase(),
      scheduler = new ScheduleService(f.service);
    try {
      const task = await scheduler.create(f.actor, {
        agentId: "a",
        cron: "0 0 1 1 *",
        prompt: "tick",
      });
      await f.a.pool.query(
        "UPDATE personal_scheduled_tasks SET data=jsonb_set(data,'{nextFireAt}','1'::jsonb) WHERE user_id=$1 AND schedule_id=$2",
        [f.actor.userId, task.id],
      );
      const state = async () =>
        (
          await f.a.pool.query(
            "SELECT xmin::text,state FROM personal_user_state WHERE user_id=$1",
            [f.actor.userId],
          )
        ).rows[0];
      const before = await state();
      assert.equal("audit" in before.state, false);
      await scheduler.tick();
      const fire = (
        await f.sa.readMetadata(f.actor.userId, ["scheduleFires"], (s) =>
          Object.values(s.scheduleFires!),
        )
      )[0]!;
      assert.equal(fire.state, "submitted");
      assert.deepEqual(await state(), before);
      await f.sa.runTx(f.actor.userId, fire.runId!, (s) => {
        s.runs[fire.runId!]!.state = "COMPLETED";
      });
      await scheduler.tick();
      assert.deepEqual(await state(), before);
      assert.equal(
        (
          await f.a.pool.query(
            "SELECT count(*)::int AS n FROM personal_audit WHERE user_id=$1 AND data->>'action'='schedule.fire'",
            [f.actor.userId],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await f.sa.readMetadata(f.actor.userId, ["scheduleFires"], (s) =>
            Object.values(s.scheduleFires!),
          )
        )[0]!.state,
        "completed",
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "Run frontiers track concurrent enqueue, CAS/expiry, cancellation, rollback and deletion across clients",
  { skip: !url },
  async () => {
    const f = await reviewDatabase();
    try {
      const runs = [];
      for (let i = 0; i < 3; i++) {
        const ses = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        });
        runs.push(await f.service.submit(f.actor, ses.id, "queue"));
      }
      const [first, second, third] = runs;
      const work = () => f.a.listRunWork(Date.now(), 64);
      assert.deepEqual(
        (await work()).map((w) => w.runId),
        [first!.id],
      );
      await Promise.all([
        f.sa.runTx(f.actor.userId, first!.id, (s) => {
          s.runs[first!.id]!.state = "RUNNING";
          s.runs[first!.id]!.lease = {
            owner: "owner",
            expires: Date.now() + 30000,
          };
        }),
        f.sb.runTx(f.actor.userId, second!.id, (s) => {
          s.runs[second!.id]!.state = "CANCELLED";
        }),
      ]);
      assert.deepEqual(
        (await work()).map((w) => w.runId),
        [],
      );
      assert.equal(
        await f.b.renewRunLease(f.actor.userId, first!.id, "owner", Date.now()),
        true,
      );
      await f.sa.runTx(f.actor.userId, first!.id, (s) => {
        s.runs[first!.id]!.lease!.expires = Date.now() - 1;
      });
      assert.deepEqual(
        (await work()).map((w) => w.runId),
        [first!.id],
      );
      await f.sb.runTx(f.actor.userId, first!.id, (s) => {
        s.runs[first!.id]!.state = "FAILED";
        delete s.runs[first!.id]!.lease;
      });
      const c = await f.a.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "UPDATE personal_runs SET state='CANCELLED' WHERE user_id=$1 AND run_id=$2",
          [f.actor.userId, third!.id],
        );
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
      assert.deepEqual(
        (await work()).map((w) => w.runId),
        [third!.id],
      );
      await f.a.pool.query(
        "DELETE FROM personal_runs WHERE user_id=$1 AND run_id=$2",
        [f.actor.userId, third!.id],
      );
      assert.deepEqual(await work(), []);
    } finally {
      await f.close();
    }
  },
);
test(
  "012 repairs legacy Schedule audits once, backfills Run heads and detects disabled frontier triggers",
  { skip: !url },
  async () => {
    const f = await reviewDatabase();
    try {
      const ses = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        }),
        run = await f.service.submit(f.actor, ses.id, "head");
      const canonical = { id: "canonical", action: "canonical" },
        fresh = { id: "legacy-only", action: "legacy-only" };
      await f.a.pool.query(
        "INSERT INTO personal_audit(user_id,id,data) VALUES($1,$2,$3)",
        [f.actor.userId, canonical.id, JSON.stringify(canonical)],
      );
      await f.a.pool.query(
        "UPDATE personal_user_state SET state=jsonb_set(state,'{audit}',$2::jsonb) WHERE user_id=$1",
        [
          f.actor.userId,
          JSON.stringify([{ ...canonical, action: "duplicate" }, fresh]),
        ],
      );
      for (const name of ["insert", "update", "delete"])
        await f.a.pool.query(
          `ALTER TABLE personal_runs DISABLE TRIGGER personal_runs_work_${name}`,
        );
      await f.a.pool.query("TRUNCATE personal_run_work");
      await f.a.pool.query("UPDATE personal_schema SET version=9 WHERE id=1");
      const migration =
          (await readFile(
            "migrations/012_personal_queue_frontiers.sql",
            "utf8",
          )) +
          "\n" +
          (await readFile(
            "migrations/013_personal_dispatchable_sessions.sql",
            "utf8",
          )) +
          "\n" +
          (await readFile(
            "migrations/014_personal_control_paths.sql",
            "utf8",
          )) +
          "\n" +
          ((await readFile(
            "migrations/015_personal_legacy_tasks_stats.sql",
            "utf8",
          )) +
            "\n" +
            (await readFile(
              "migrations/016_personal_evaluations.sql",
              "utf8",
            ))),
        c = await f.a.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(migration);
        await assert.rejects(f.b.ready(), /SCHEMA_MISMATCH/);
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
      assert.equal(
        (
          await f.a.pool.query(
            "SELECT state ? 'audit' AS old FROM personal_user_state WHERE user_id=$1",
            [f.actor.userId],
          )
        ).rows[0].old,
        true,
      );
      await f.a.pool.query(migration);
      await f.a.ready();
      await f.a.pool.query(migration);
      const audits = (
        await f.sa.readMetadata(f.actor.userId, ["audit"], (s) => s.audit)
      ).filter((a) => [canonical.id, fresh.id].includes(a.id));
      assert.equal(audits.length, 2);
      assert.equal(
        audits.find((a) => a.id === canonical.id)!.action,
        "canonical",
      );
      assert.equal(
        (
          await f.a.pool.query(
            "SELECT state ? 'audit' AS old FROM personal_user_state WHERE user_id=$1",
            [f.actor.userId],
          )
        ).rows[0].old,
        false,
      );
      assert.deepEqual(
        (await f.a.listRunWork(Date.now(), 64)).map((w) => w.runId),
        [run.id],
      );
      await f.a.pool.query(
        "ALTER TABLE personal_runs DISABLE TRIGGER personal_runs_work_insert",
      );
      await assert.rejects(f.b.ready(), /SCHEMA_TRIGGERS_INCOMPLETE/);
      await f.a.pool.query(migration);
      await f.a.ready();
    } finally {
      await f.close();
    }
  },
);
test(
  "Schedule history is isolated, indexed and keyset-paged across ties without reading 100k other Fires",
  { skip: !url },
  async () => {
    const { ScheduleService } = await import("../src/schedules/service.js"),
      { buildAPI } = await import("../src/api/server.js");
    const f = await reviewDatabase(),
      scheduler = new ScheduleService(f.service),
      other = await principal(f.ar, {
        tenantId: "other",
        userId: "other",
        admin: false,
      });
    const make = (actor: Actor) =>
      scheduler.create(actor, {
        agentId: "a",
        cron: "0 0 1 1 *",
        prompt: "history",
      });
    const target = await make(f.actor),
      noise = await make(f.actor),
      foreign = await make(other);
    const times = [100, 100, 90, 80, 80, 70, 60],
      fires = times.map((scheduledFor, index) => ({
        id: id(),
        scheduleId: target.id,
        trigger: index % 2 ? "manual" : "cron",
        scheduledFor,
        state: "completed",
      }));
    for (const fire of fires)
      await f.a.pool.query(
        "INSERT INTO personal_schedule_fires(user_id,id,schedule_id,trigger,scheduled_for,data) VALUES($1,$2,$3,$4,$5,$6)",
        [
          f.actor.userId,
          fire.id,
          target.id,
          fire.trigger,
          fire.scheduledFor,
          JSON.stringify(fire),
        ],
      );
    await f.a.pool.query(
      "INSERT INTO personal_schedule_fires(user_id,id,schedule_id,trigger,scheduled_for,data) SELECT $1,'noise-'||n,$2,'cron',n,jsonb_build_object('id','noise-'||n,'scheduleId',$2::text,'trigger','cron','scheduledFor',n,'state','completed','payload',repeat('x',1024)) FROM generate_series(1,100000)n",
      [f.actor.userId, noise.id],
    );
    const expected = [...fires]
      .sort((a, b) => b.scheduledFor - a.scheduledFor || (a.id < b.id ? 1 : -1))
      .map((f) => f.id);
    const previous = process.env.SCHEDULES_ENABLED;
    process.env.SCHEDULES_ENABLED = "true";
    const app = buildAPI(
      f.service,
      async (h) => ({
        ...(h === "Bearer other" ? other : f.actor),
        personal: false,
      }),
      new SandboxManager(f.sa, new DemoSandbox()),
    );
    const client = await f.a.pool.connect(),
      query = client.query.bind(client);
    let bytes = 0;
    client.query = ((...args: any[]) => {
      const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
      const capture = (r: any) => {
        if (/FROM personal_schedule_fires/.test(sql)) {
          bytes += Buffer.byteLength(JSON.stringify(r.rows));
          assert.ok(r.rows.length <= 3);
          assert.match(sql, /schedule_id=\$2/);
        }
        return r;
      };
      const cb = args.at(-1);
      if (typeof cb === "function") {
        args[args.length - 1] = (e: unknown, r: unknown) => {
          if (!e) capture(r);
          cb(e, r);
        };
        return (query as any)(...args);
      }
      return (query as any)(...args).then(capture);
    }) as typeof client.query;
    client.release();
    try {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const response = await app.inject({
          url: `/api/v1/schedules/${target.id}/runs?limit=2${cursor ? "&cursor=" + cursor : ""}`,
        });
        assert.equal(response.statusCode, 200, response.body);
        const page = response.json();
        seen.push(...page.items.map((f: { id: string }) => f.id));
        cursor = page.nextCursor;
        if (seen.length === 2) {
          const fire = {
            id: id(),
            scheduleId: target.id,
            trigger: "cron",
            scheduledFor: 110,
            state: "completed",
          };
          await f.b.pool.query(
            "INSERT INTO personal_schedule_fires(user_id,id,schedule_id,trigger,scheduled_for,data) VALUES($1,$2,$3,$4,$5,$6)",
            [
              f.actor.userId,
              fire.id,
              target.id,
              fire.trigger,
              fire.scheduledFor,
              JSON.stringify(fire),
            ],
          );
        }
      } while (cursor);
      assert.deepEqual(seen, expected);
      assert.ok(bytes < 20000, `history returned ${bytes} bytes`);
      assert.equal(
        (
          await app.inject({
            url: `/api/v1/schedules/${target.id}/runs?cursor=bad`,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            url: `/api/v1/schedules/${target.id}/runs?limit=101`,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (await app.inject({ url: `/api/v1/schedules/${foreign.id}/runs` }))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            url: `/api/v1/schedules/${target.id}/runs`,
            headers: { authorization: "Bearer other" },
          })
        ).statusCode,
        404,
      );
    } finally {
      await app.close();
      await f.close();
      if (previous === undefined) delete process.env.SCHEDULES_ENABLED;
      else process.env.SCHEDULES_ENABLED = previous;
    }
  },
);

async function largeSessionHistory(
  f: Awaited<ReturnType<typeof reviewDatabase>>,
) {
  const { ScheduleService } = await import("../src/schedules/service.js");
  const history = await f.service.createPersonalSession(f.actor, {
      agentId: "a",
    }),
    base = await f.service.submit(
      f.actor,
      history.id,
      "history",
      undefined,
      undefined,
      undefined,
      "history-token",
    );
  await f.sa.runTx(f.actor.userId, base.id, (s) => {
    s.runs[base.id]!.state = "COMPLETED";
  });
  const noise = await new ScheduleService(f.service).create(f.actor, {
    agentId: "a",
    cron: "0 0 1 1 *",
    prompt: "old",
  });
  await f.a.pool.query(
    `INSERT INTO personal_runs(user_id,run_id,session_id,actor_id,state,created_at,data)
  SELECT $1,'history-'||n,$2,$1,'COMPLETED',now(),$3::jsonb||jsonb_build_object('id','history-'||n,'taskId','history-'||n,'rootRunId','history-'||n,'state','COMPLETED') FROM generate_series(1,5000)n`,
    [f.actor.userId, history.id, JSON.stringify(base)],
  );
  const cursor = Number(
    (
      await f.a.pool.query(
        "SELECT cursor FROM personal_event_sequences WHERE user_id=$1",
        [f.actor.userId],
      )
    ).rows[0].cursor,
  );
  await f.a.pool.query(
    `INSERT INTO personal_run_events(user_id,run_id,event_id,data)
  SELECT $1,'history-'||((n-1)%5000+1),$2::bigint+n,jsonb_build_object('eventId',$2::bigint+n,'runId','history-'||((n-1)%5000+1),'seq',n,'type','history','data',repeat('x',1024)) FROM generate_series(1,50000)n`,
    [f.actor.userId, cursor],
  );
  await f.a.pool.query(
    "UPDATE personal_event_sequences SET cursor=cursor+50000 WHERE user_id=$1",
    [f.actor.userId],
  );
  await f.a.pool.query(
    "INSERT INTO personal_audit(user_id,id,data) SELECT $1,'audit-'||n,jsonb_build_object('id','audit-'||n,'timestamp','2020-01-01T00:00:00.000Z','action','old','payload',repeat('x',1024)) FROM generate_series(1,5000)n",
    [f.actor.userId],
  );
  await f.a.pool.query(
    "INSERT INTO personal_usage_requests(user_id,id,run_id,at,data) SELECT $1,'usage-'||n,'history-'||n,'2020-01-01',jsonb_build_object('id','usage-'||n,'runId','history-'||n,'at','2020-01-01','tokens',1,'status','confirmed') FROM generate_series(1,5000)n",
    [f.actor.userId],
  );
  await f.a.pool.query(
    "INSERT INTO personal_schedule_fires(user_id,id,schedule_id,trigger,scheduled_for,data) SELECT $1,'fire-'||n,$2,'cron',n,jsonb_build_object('id','fire-'||n,'scheduleId',$2::text,'trigger','cron','scheduledFor',n,'state','completed','payload',repeat('x',1024)) FROM generate_series(1,5000)n",
    [f.actor.userId, noise.id],
  );
}
test(
  "idle Workers do not claim a busy user queue, but still recover expired leases and resume queued work",
  { skip: !url },
  async () => {
    const { sqlMetrics } = await import("./personal-sql-metrics.js");
    const f = await reviewDatabase(),
      provider = new DemoSandbox();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    const owner = new Worker(
      f.service,
      {
        execute: async () => {
          entered();
          await gate;
        },
      },
      new SandboxManager(f.sa, provider),
      new MCPManager(f.sa, {}),
    );
    const idle = [
      new Worker(
        f.service,
        { execute: async () => {} },
        new SandboxManager(f.sa, provider),
        new MCPManager(f.sa, {}),
      ),
      new Worker(
        f.other,
        { execute: async () => {} },
        new SandboxManager(f.sb, provider),
        new MCPManager(f.sb, {}),
      ),
    ];
    try {
      const a = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        }),
        running = await f.service.submit(f.actor, a.id, "long");
      await owner.tick();
      await ready;
      const b = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        }),
        queued = await f.service.submit(f.actor, b.id, "next");
      for (const w of idle) await w.tick();
      const m1 = await sqlMetrics(f.a.pool),
        m2 = await sqlMetrics(f.b.pool);
      let claims = 0;
      for (const store of [f.a, f.b]) {
        const original = store.claimRun.bind(store);
        store.claimRun = async (...args) => {
          claims++;
          return original(...args);
        };
      }
      m1.start();
      m2.start();
      for (let i = 0; i < 10; i++) await Promise.all(idle.map((w) => w.tick()));
      const reads = [...m1.stop(), ...m2.stop()];
      assert.equal(claims, 0);
      const { runWorkQuery } = await import(
        "../src/storage/personal-work-queries.js"
      );
      assert.equal(reads.filter((r) => r.sql === runWorkQuery).length, 20);
      assert.equal(
        reads.filter((r) => r.sql === "BEGIN").length,
        0,
        "no pointless claim transaction may lock user/Run rows",
      );
      console.log(
        JSON.stringify({
          round6BusyWorkers: {
            ticks: 20,
            sql: reads.length,
            candidateSelects: 20,
            claims,
          },
        }),
      );
      release();
      for (let i = 0; i < 100; i++) {
        if (
          (
            await f.sa.readRun(
              f.actor.userId,
              running.id,
              (s) => s.runs[running.id]!,
            )
          ).state === "COMPLETED"
        )
          break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await idle[0]!.tick();
      for (let i = 0; i < 100; i++) {
        if (
          (
            await f.sa.readRun(
              f.actor.userId,
              queued.id,
              (s) => s.runs[queued.id]!,
            )
          ).state === "COMPLETED"
        )
          break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(
        (
          await f.sa.readRun(
            f.actor.userId,
            queued.id,
            (s) => s.runs[queued.id]!,
          )
        ).state,
        "COMPLETED",
      );
      const c = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        }),
        waiting = await f.service.submit(f.actor, c.id, "after recovery");
      await f.sa.runTx(f.actor.userId, queued.id, (s) => {
        const r = s.runs[queued.id]!;
        r.state = "RUNNING";
        r.lease = { owner: "lost", expires: Date.now() - 1 };
      });
      assert.deepEqual(
        (await f.a.listRunWork(Date.now(), 64)).map((w) => w.runId),
        [queued.id],
      );
      await idle[0]!.tick();
      assert.equal(
        (
          await f.sa.readRun(
            f.actor.userId,
            queued.id,
            (s) => s.runs[queued.id]!,
          )
        ).state,
        "FAILED",
      );
      await idle[1]!.tick();
      for (let i = 0; i < 100; i++) {
        if (
          (
            await f.sa.readRun(
              f.actor.userId,
              waiting.id,
              (s) => s.runs[waiting.id]!,
            )
          ).state === "COMPLETED"
        )
          break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(
        (
          await f.sa.readRun(
            f.actor.userId,
            waiting.id,
            (s) => s.runs[waiting.id]!,
          )
        ).state,
        "COMPLETED",
      );
    } finally {
      release();
      await owner.stop();
      for (const w of idle) await w.stop();
      await f.close();
    }
  },
);
test(
  "Session create/update/delete/fork HTTP writes avoid unrelated execution, audit, usage and schedule history",
  { skip: !url },
  async () => {
    const { buildAPI } = await import("../src/api/server.js"),
      { sqlMetrics } = await import("./personal-sql-metrics.js");
    const f = await reviewDatabase();
    const app = buildAPI(
      f.service,
      async () => ({ ...f.actor, personal: false }),
      new SandboxManager(f.sa, new DemoSandbox()),
    );
    try {
      await largeSessionHistory(f);
      const m = await sqlMetrics(f.a.pool);
      const check = () => {
        const records = m.stop();
        assert.ok(
          !records.some((r) =>
            /FROM personal_(run_events|audit|usage_requests|resource_transitions)\b/.test(
              r.sql,
            ),
          ),
        );
        const bytes = records.reduce((n, r) => n + r.bytes, 0);
        assert.ok(bytes < 20000, `returned ${bytes} bytes`);
        return { queries: records.length, bytes };
      };
      m.start();
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        payload: { agentId: "a", title: "new" },
      });
      assert.equal(created.statusCode, 201, created.body);
      const creation = check(),
        sid = created.json().id;
      await f.a.pool.query(
        "UPDATE personal_sessions SET data=jsonb_set(data,'{entries}',$3::jsonb) WHERE user_id=$1 AND session_id=$2",
        [
          f.actor.userId,
          sid,
          JSON.stringify([{ role: "assistant", content: "preserve me" }]),
        ],
      );
      m.start();
      const updated = await app.inject({
        method: "PATCH",
        url: `/api/v1/sessions/${sid}`,
        payload: { title: "renamed", cwd: "nested" },
      });
      assert.equal(updated.statusCode, 200, updated.body);
      assert.deepEqual(updated.json().entries, [
        { role: "assistant", content: "preserve me" },
      ]);
      const update = check();
      m.start();
      const forked = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sid}/fork`,
      });
      assert.equal(forked.statusCode, 201, forked.body);
      assert.deepEqual(forked.json().entries, updated.json().entries);
      assert.equal(forked.json().title, "renamed");
      const fork = check();
      m.start();
      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/v1/sessions/${sid}`,
      });
      assert.equal(deleted.statusCode, 200, deleted.body);
      const deletion = check();
      const old = (
        await f.a.pool.query(
          "SELECT data FROM personal_sessions WHERE user_id=$1 AND session_id=$2",
          [f.actor.userId, sid],
        )
      ).rows[0].data;
      assert.deepEqual(old.entries, updated.json().entries);
      assert.ok(old.deletedAt);
      console.log(
        JSON.stringify({
          round6SessionWrites: { creation, update, fork, deletion },
        }),
      );
      const active = await f.service.submit(
        f.actor,
        forked.json().id,
        "queued",
      );
      await assert.rejects(
        f.other.updateSession(f.actor, forked.json().id, { cwd: "busy" }),
        { code: "SESSION_BUSY" },
      );
      await assert.rejects(f.other.deleteSession(f.actor, forked.json().id), {
        code: "SESSION_BUSY",
      });
      await assert.rejects(f.other.forkSession(f.actor, forked.json().id), {
        code: "SESSION_BUSY",
      });
      const title = await f.other.updateSession(f.actor, forked.json().id, {
        title: "allowed while busy",
      });
      assert.equal(title.title, "allowed while busy");
      await f.sb.runTx(f.actor.userId, active.id, (s) => {
        s.runs[active.id]!.state = "CANCELLED";
      });
    } finally {
      await app.close();
      await f.close();
    }
  },
);
test(
  "Session mutations serialize with admission and preserve transcripts when rejecting busy/cross-user access",
  { skip: !url },
  async () => {
    const f = await reviewDatabase();
    try {
      for (const action of ["delete", "fork", "cwd"] as const) {
        const ses = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        });
        const mutation = () =>
          action === "delete"
            ? f.other.deleteSession(f.actor, ses.id)
            : action === "fork"
              ? f.other.forkSession(f.actor, ses.id)
              : f.other.updateSession(f.actor, ses.id, { cwd: "changed" });
        const results = await Promise.allSettled([
          f.service.submit(f.actor, ses.id, "race"),
          mutation(),
        ]);
        assert.ok(results.some((r) => r.status === "fulfilled"));
        if (
          results[0]!.status === "fulfilled" &&
          results[1]!.status === "fulfilled"
        ) {
          assert.notEqual(
            action,
            "delete",
            "deleted Session cannot admit a Run",
          );
          if (action === "cwd")
            assert.equal(results[0]!.value.cwd, "/workspace/changed");
        }
        if (results[1]!.status === "rejected")
          assert.equal(results[1]!.reason.code, "SESSION_BUSY");
        if (results[1]!.status === "fulfilled" && action === "delete")
          assert.equal(
            results[0]!.status,
            "rejected",
            "deletion winning must prevent admission",
          );
      }
      const other = await principal(f.ar, {
        tenantId: "outside",
        userId: "other",
        admin: false,
      });
      const own = await f.service.createPersonalSession(f.actor, {
        agentId: "a",
      });
      await assert.rejects(
        f.other.updateSession(other, own.id, { title: "steal" }),
        { code: "SESSION_NOT_FOUND" },
      );
      await assert.rejects(f.other.deleteSession(other, own.id), {
        code: "SESSION_NOT_FOUND",
      });
      await assert.rejects(f.other.forkSession(other, own.id), {
        code: "SESSION_NOT_FOUND",
      });
    } finally {
      await f.close();
    }
  },
);
test(
  "manual Schedule HTTP uses bounded scheduleTx and retains same-timestamp deduplication under large history",
  { skip: !url },
  async () => {
    const { buildAPI } = await import("../src/api/server.js"),
      { ScheduleService } = await import("../src/schedules/service.js"),
      { sqlMetrics } = await import("./personal-sql-metrics.js");
    const f = await reviewDatabase();
    const task = await new ScheduleService(f.service).create(f.actor, {
      agentId: "a",
      cron: "0 0 1 1 *",
      prompt: "manual",
      sessionMode: "new",
    });
    const before = process.env.SCHEDULES_ENABLED;
    process.env.SCHEDULES_ENABLED = "true";
    const app = buildAPI(
      f.service,
      async () => ({ ...f.actor, personal: false }),
      new SandboxManager(f.sa, new DemoSandbox()),
    );
    const originalNow = Date.now;
    try {
      await largeSessionHistory(f);
      const metrics = await sqlMetrics(f.a.pool),
        now = originalNow();
      Date.now = () => now;
      metrics.start();
      const responses = await Promise.all(
        [1, 2].map(() =>
          app.inject({
            method: "POST",
            url: `/api/v1/schedules/${task.id}/run`,
          }),
        ),
      );
      const records = metrics.stop();
      Date.now = originalNow;
      for (const response of responses)
        assert.equal(response.statusCode, 202, response.body);
      assert.equal(responses[0]!.json().id, responses[1]!.json().id);
      assert.equal(responses[0]!.json().runId, responses[1]!.json().runId);
      assert.ok(
        !records.some((r) =>
          /FROM personal_(run_events|audit|usage_requests|resource_transitions)\b/.test(
            r.sql,
          ),
        ),
      );
      const bytes = records.reduce((n, r) => n + r.bytes, 0);
      assert.ok(bytes < 30000, `returned ${bytes} bytes`);
      assert.equal(
        (
          await f.a.pool.query(
            "SELECT count(*)::int n FROM personal_schedule_fires WHERE user_id=$1 AND schedule_id=$2",
            [f.actor.userId, task.id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await f.a.pool.query(
            "SELECT count(*)::int n FROM personal_runs WHERE user_id=$1 AND data->'schedule'->>'id'=$2",
            [f.actor.userId, task.id],
          )
        ).rows[0].n,
        1,
      );
      console.log(
        JSON.stringify({
          round6ManualSchedule: {
            requests: 2,
            queries: records.length,
            bytes,
            fires: 1,
          },
        }),
      );
    } finally {
      Date.now = originalNow;
      await app.close();
      await f.close();
      if (before === undefined) delete process.env.SCHEDULES_ENABLED;
      else process.env.SCHEDULES_ENABLED = before;
    }
  },
);

test(
  "013 backfills busy users and tracks RUNNING transitions without leases",
  { skip: !url },
  async () => {
    const f = await reviewDatabase();
    try {
      const ses = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        }),
        first = await f.service.submit(f.actor, ses.id, "running"),
        other = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        }),
        queued = await f.service.submit(f.actor, other.id, "queued");
      await f.a.pool.query(
        "UPDATE personal_runs SET state='RUNNING',data=jsonb_set(data,'{state}','\"RUNNING\"') WHERE user_id=$1 AND run_id=$2",
        [f.actor.userId, first.id],
      );
      // Simulate the old projection before upgrading an already busy database.
      await f.a.pool.query(
        "UPDATE personal_run_work SET running=false WHERE user_id=$1",
        [f.actor.userId],
      );
      await f.a.pool.query("UPDATE personal_schema SET version=10 WHERE id=1");
      await assert.rejects(f.a.ready(), /SCHEMA_MISMATCH/);
      await f.a.pool.query(
        await readFile(
          "migrations/013_personal_dispatchable_sessions.sql",
          "utf8",
        ),
      );
      await f.a.pool.query(
        await readFile("migrations/014_personal_control_paths.sql", "utf8"),
      );
      await f.a.pool.query(
        (await readFile(
          "migrations/015_personal_legacy_tasks_stats.sql",
          "utf8",
        )) +
          "\n" +
          (await readFile("migrations/016_personal_evaluations.sql", "utf8")),
      );
      await f.a.ready();
      assert.deepEqual(
        (await f.a.listRunWork(Date.now(), 10)).map((r) => r.runId),
        [],
      );
      await f.a.pool.query(
        "DELETE FROM personal_runs WHERE user_id=$1 AND run_id=$2",
        [f.actor.userId, first.id],
      );
      assert.deepEqual(
        (await f.a.listRunWork(Date.now(), 10)).map((r) => r.runId),
        [queued.id],
      );
      // INSERT and DELETE must update the flag even for RUNNING records without leases.
      await f.a.pool.query(
        "INSERT INTO personal_runs(user_id,run_id,session_id,actor_id,state,created_at,data) VALUES($1,$2,$3,$1,'RUNNING',now(),$4)",
        [
          f.actor.userId,
          first.id,
          ses.id,
          JSON.stringify({ ...first, state: "RUNNING" }),
        ],
      );
      assert.deepEqual(
        (await f.a.listRunWork(Date.now(), 10)).map((r) => r.runId),
        [],
      );
      await f.a.pool.query(
        "DELETE FROM personal_runs WHERE user_id=$1 AND run_id=$2",
        [f.actor.userId, first.id],
      );
      assert.deepEqual(
        (await f.a.listRunWork(Date.now(), 10)).map((r) => r.runId),
        [queued.id],
      );
    } finally {
      await f.close();
    }
  },
);

function controlReads(records: { sql: string; bytes: number }[]) {
  assert.ok(
    !records.some((r) =>
      /FROM personal_(run_events|audit|usage_requests|resource_transitions)\b/.test(
        r.sql,
      ),
    ),
    "control requests must not select unrelated history",
  );
  const bytes = records.reduce((n, r) => n + r.bytes, 0);
  assert.ok(bytes < 64000, `control request returned ${bytes} bytes`);
  return { queries: records.length, bytes };
}
async function waitingInteraction(
  f: Awaited<ReturnType<typeof reviewDatabase>>,
  kind: "approval" | "question" = "question",
  token?: string,
) {
  const ses = await f.service.createPersonalSession(f.actor, { agentId: "a" }),
    root = await f.service.submit(
      f.actor,
      ses.id,
      "wait",
      undefined,
      undefined,
      undefined,
      token,
    ),
    iid = id();
  await f.sa.executionTx!(f.actor.userId, root.id, (s) => {
    s.runs[root.id]!.state = "WAITING_INPUT";
    s.interactions[iid] = {
      id: iid,
      runId: root.id,
      kind,
      payload: { question: "Continue?" },
      resolved: false,
    };
  });
  return { ses, root, iid };
}

test(
  "cancel HTTP reads only its task chain at 5k Runs/50k Events and serializes concurrent cancellation",
  { skip: !url },
  async () => {
    const { buildAPI } = await import("../src/api/server.js"),
      { sqlMetrics } = await import("./personal-sql-metrics.js");
    const f = await reviewDatabase(),
      app = buildAPI(
        f.service,
        async () => ({ ...f.actor, personal: false }),
        new SandboxManager(f.sa, new DemoSandbox()),
      );
    try {
      const ses = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        }),
        root = await f.service.submit(f.actor, ses.id, "cancel");
      const m = await sqlMetrics(f.a.pool),
        samples = [];
      for (const history of [false, true]) {
        if (history) await largeSessionHistory(f);
        await f.sa.executionTx!(f.actor.userId, root.id, (s) => {
          s.runs[root.id]!.state = "QUEUED";
          delete s.runs[root.id]!.cancelRequested;
        });
        m.start();
        const start = performance.now();
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/runs/${root.id}/cancel`,
        });
        const ms = performance.now() - start,
          stats = controlReads(m.stop());
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().state, "CANCELLED");
        samples.push({ history, ...stats, ms });
      }
      assert.equal(samples[0]!.queries, samples[1]!.queries);
      await f.a.pool.query("ANALYZE personal_runs");
      const plan = (
        await f.a.pool.query(
          "EXPLAIN (ANALYZE,FORMAT JSON) SELECT data FROM personal_runs WHERE user_id=$1 AND (COALESCE(data->>'taskId',data->>'rootRunId',run_id)=$2 OR run_id=ANY($3::text[])) ORDER BY run_id FOR UPDATE",
          [f.actor.userId, root.taskId, [root.id]],
        )
      ).rows[0]["QUERY PLAN"];
      assert.match(JSON.stringify(plan), /personal_runs_task_identity/);
      const children = [];
      for (const state of ["QUEUED", "WAITING_INPUT", "COMPLETED"]) {
        const childSession = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        });
        children.push({
          ...root,
          id: id(),
          sessionId: childSession.id,
          state,
          parentRunId: root.id,
        });
        if (state === "WAITING_INPUT") delete children.at(-1)!.taskId;
      }
      await f.sa.executionTx!(f.actor.userId, root.id, (s) => {
        const r = s.runs[root.id]!;
        r.state = "RUNNING";
        delete r.cancelRequested;
        r.lease = { owner: "live", expires: Date.now() + 30000 };
        for (const child of children) s.runs[child.id] = child as typeof root;
      });
      await Promise.all([
        f.service.cancel(f.actor, children[0]!.id),
        f.other.cancel(f.actor, root.id),
      ]);
      await f.sa.executionTx!(f.actor.userId, root.id, (s) => {
        assert.equal(s.runs[root.id]!.state, "RUNNING");
        assert.equal(s.runs[root.id]!.cancelRequested, true);
        for (const child of children.slice(0, 2))
          assert.equal(s.runs[child.id]!.state, "CANCELLED");
        assert.equal(s.runs[children[2]!.id]!.state, "COMPLETED");
      });
      const counts = await f.a.pool.query(
        "SELECT run_id,count(*)::int AS n FROM personal_run_events WHERE user_id=$1 AND run_id=ANY($2::text[]) AND data->>'type'='run.cancelled' GROUP BY run_id",
        [f.actor.userId, children.slice(0, 2).map((r) => r.id)],
      );
      assert.equal(counts.rows.length, 2);
      assert.ok(counts.rows.every((r) => r.n === 1));
      const foreign = await principal(f.ar, {
        tenantId: "outside",
        userId: "outside",
        admin: false,
      });
      await assert.rejects(f.other.cancel(foreign, root.id), {
        code: "RUN_NOT_FOUND",
      });
      console.log(JSON.stringify({ round7Cancel: samples }));
    } finally {
      await app.close();
      await f.close();
    }
  },
);

test(
  "Interaction HTTP resumes with bounded history reads, fresh sealed credentials and concurrent response idempotency",
  { skip: !url },
  async () => {
    const { buildAPI } = await import("../src/api/server.js"),
      { sqlMetrics } = await import("./personal-sql-metrics.js"),
      { openToken } = await import("../src/security/token-vault.js");
    const oldKey = process.env.RUN_TOKEN_KEY;
    process.env.RUN_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
    const f = await reviewDatabase(),
      app = buildAPI(
        f.service,
        async () => ({
          ...f.actor,
          personal: false,
          expiresAt: Date.now() + 60000,
        }),
        new SandboxManager(f.sa, new DemoSandbox()),
      );
    try {
      await f.ar.tx((s) => {
        s.managedAgents!.a!.config.userTokenAccess = true;
      });
      const pending = await waitingInteraction(f, "approval", "expired-token");
      await f.sa.executionTx!(f.actor.userId, pending.root.id, (s) => {
        s.runs[pending.root.id]!.actor.expiresAt = Date.now() - 1;
      });
      await f.ar.tx((s) => {
        s.managedAgents!.a!.config.userTokenAccess = false;
      });
      await largeSessionHistory(f);
      await f.ar.tx((s) => {
        s.managedAgents!.a!.config.userTokenAccess = true;
        s.managedAgents!.a!.config.systemPrompt = "new-config";
      });
      const m = await sqlMetrics(f.a.pool);
      m.start();
      const start = performance.now();
      const send = () =>
        app.inject({
          method: "POST",
          url: `/api/v1/interactions/${pending.iid}/response`,
          headers: { authorization: "Bearer refreshed-token" },
          payload: { response: "approve" },
        });
      const replies = await Promise.all([send(), send()]),
        stats = controlReads(m.stop()),
        ms = performance.now() - start;
      for (const r of replies) assert.equal(r.statusCode, 202, r.body);
      assert.equal(replies[0]!.json().id, replies[1]!.json().id);
      const next = await f.sa.readRun(
        f.actor.userId,
        replies[0]!.json().id,
        (s) => s.runs[replies[0]!.json().id]!,
      );
      assert.deepEqual(next.capabilities, pending.root.capabilities);
      assert.equal(
        openToken(
          next.userTokenRef!,
          f.actor.userId + ":" + pending.root.taskId,
        ),
        "refreshed-token",
      );
      const sealed = next.userTokenRef;
      assert.equal(
        (await f.other.respond(
          f.actor,
          pending.iid,
          "approve",
          "another-token",
        ))!.userTokenRef,
        sealed,
      );
      await assert.rejects(
        f.other.respond(f.actor, pending.iid, "deny", "another-token"),
        { code: "INTERACTION_ALREADY_RESOLVED" },
      );
      assert.equal(
        (
          await f.a.pool.query(
            "SELECT count(*)::int AS n FROM personal_runs WHERE user_id=$1 AND data->>'resumedFrom'=$2",
            [f.actor.userId, pending.iid],
          )
        ).rows[0].n,
        1,
      );
      const question = await waitingInteraction(f, "question", "old-token");
      await assert.rejects(f.other.respond(f.actor, question.iid, "answer"), {
        code: "USER_TOKEN_REQUIRED",
      });
      await f.sa.executionTx!(f.actor.userId, question.root.id, (s) => {
        assert.equal(s.interactions[question.iid]!.resolved, false);
        assert.equal(s.runs[question.root.id]!.state, "WAITING_INPUT");
      });
      assert.equal(
        (await f.other.respond(
          f.actor,
          question.iid,
          "answer",
          "question-token",
        ))!.taskId,
        question.root.taskId,
      );
      console.log(
        JSON.stringify({
          round7Interaction: { ...stats, ms, continuations: 1 },
        }),
      );
    } finally {
      await app.close();
      await f.close();
      if (oldKey === undefined) delete process.env.RUN_TOKEN_KEY;
      else process.env.RUN_TOKEN_KEY = oldKey;
    }
  },
);

test(
  "Interaction control transactions retain checkpoint, live-policy and admission guards and serialize cancellation",
  { skip: !url },
  async () => {
    const f = await reviewDatabase();
    try {
      const pending = await waitingInteraction(f);
      await f.sa.executionTx!(f.actor.userId, pending.root.id, (s) => {
        s.runs[pending.root.id]!.lease = {
          owner: "checkpoint",
          expires: Date.now() + 30000,
        };
      });
      await assert.rejects(f.other.respond(f.actor, pending.iid, "answer"), {
        code: "CHECKPOINT_PENDING",
      });
      await f.sa.executionTx!(f.actor.userId, pending.root.id, (s) => {
        delete s.runs[pending.root.id]!.lease;
      });
      await f.ar.tx((s) => {
        s.managedAgents!.a!.enabled = false;
      });
      await assert.rejects(f.other.respond(f.actor, pending.iid, "answer"), {
        code: "AGENT_REVOKED",
      });
      await f.ar.tx((s) => {
        s.managedAgents!.a!.enabled = true;
      });
      const [admission, resumed] = await Promise.allSettled([
        f.service.submit(f.actor, pending.ses.id, "competing root"),
        f.other.respond(f.actor, pending.iid, "answer"),
      ]);
      assert.equal(admission.status, "rejected");
      if (admission.status === "rejected")
        assert.equal(admission.reason.code, "SESSION_BUSY");
      assert.equal(resumed.status, "fulfilled");
      const foreign = await principal(f.ar, {
        tenantId: "foreign",
        userId: "foreign",
        admin: false,
      });
      await assert.rejects(f.other.respond(foreign, pending.iid, "answer"), {
        code: "INTERACTION_NOT_FOUND",
      });
      for (let n = 0; n < 4; n++) {
        const p = await waitingInteraction(f, n % 2 ? "approval" : "question"),
          answer = n % 2 ? "approve" : "answer";
        const [c, r] = await Promise.allSettled([
          f.service.cancel(f.actor, p.root.id),
          f.other.respond(f.actor, p.iid, answer),
        ]);
        assert.equal(c.status, "fulfilled");
        if (r.status === "rejected")
          assert.equal(r.reason.code, "RUN_NOT_WAITING");
        await f.sa.executionTx!(f.actor.userId, p.root.id, (s) => {
          assert.ok(
            Object.values(s.runs).every((r) =>
              ["COMPLETED", "CANCELLED"].includes(r.state),
            ),
          );
        });
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "Audit HTTP pages use indexed tenant-local SQL, stable timestamp cursors and compatible offsets under large history",
  { skip: !url },
  async () => {
    const { buildAPI } = await import("../src/api/server.js"),
      { sqlMetrics } = await import("./personal-sql-metrics.js");
    const f = await reviewDatabase(),
      app = buildAPI(
        f.service,
        async (header) => ({
          ...f.actor,
          personal: false,
          admin: header !== "Bearer ordinary",
        }),
        new SandboxManager(f.sa, new DemoSandbox()),
      );
    try {
      await largeSessionHistory(f);
      for (let n = 0; n < 6; n++)
        await f.sa.appendAudit(f.actor.userId, {
          id: `page-${n}`,
          timestamp: "1990-01-01T00:00:00.000Z",
          actorId: f.actor.userId,
          action: "test",
          resource: "test",
          result: "allowed",
        });
      const m = await sqlMetrics(f.a.pool);
      let cursor: string | undefined;
      const seen: string[] = [];
      const samples = [];
      for (let n = 0; n < 3; n++) {
        m.start();
        const r = await app.inject({
          url: `/api/v1/admin/audit?limit=2${cursor ? "&cursor=" + cursor : ""}`,
        });
        const records = m.stop();
        assert.equal(r.statusCode, 200, r.body);
        const p = r.json();
        seen.push(...p.items.map((a: { id: string }) => a.id));
        cursor = p.nextCursor;
        const selects = records.filter((r) =>
          /FROM personal_audit\b/.test(r.sql),
        );
        assert.equal(selects.length, 1);
        assert.equal(selects[0]!.rows, 3);
        assert.ok(
          !records.some((r) =>
            /FROM personal_(runs|sessions|run_events|usage_requests|resource_transitions)\b/.test(
              r.sql,
            ),
          ),
        );
        const bytes = records.reduce((n, r) => n + r.bytes, 0);
        assert.ok(bytes < 3000);
        samples.push({ queries: records.length, bytes });
        if (n === 0)
          await f.sb.appendAudit(f.actor.userId, {
            id: "earlier",
            timestamp: "1980-01-01T00:00:00.000Z",
            actorId: f.actor.userId,
            action: "insert",
            resource: "test",
            result: "allowed",
          });
      }
      assert.deepEqual(
        seen,
        Array.from({ length: 6 }, (_, n) => `page-${n}`),
      );
      assert.deepEqual(
        (await app.inject({ url: "/api/v1/admin/audit?offset=2&limit=2" }))
          .json()
          .items.map((a: { id: string }) => a.id),
        ["page-1", "page-2"],
      );
      for (const query of ["cursor=bad", `cursor=${cursor}&offset=1`])
        assert.equal(
          (await app.inject({ url: "/api/v1/admin/audit?" + query }))
            .statusCode,
          400,
        );
      assert.equal(
        (
          await app.inject({
            url: "/api/v1/admin/audit",
            headers: { authorization: "Bearer ordinary" },
          })
        ).statusCode,
        403,
      );
      assert.deepEqual(await f.a.listAudit("foreign", 0, 10), []);
      await f.a.pool.query("ANALYZE personal_audit");
      const plan = (
        await f.a.pool.query(
          "EXPLAIN (ANALYZE,FORMAT JSON) SELECT data FROM personal_audit WHERE user_id=$1 AND (data->>'timestamp',id)>($2,$3) ORDER BY data->>'timestamp',id LIMIT 3",
          [f.actor.userId, "1990-01-01T00:00:00.000Z", "page-1"],
        )
      ).rows[0]["QUERY PLAN"];
      assert.match(JSON.stringify(plan), /personal_audit_page/);
      assert.doesNotMatch(JSON.stringify(plan), /"Node Type":"Sort"/);
      console.log(JSON.stringify({ round7Audit: samples }));
    } finally {
      await app.close();
      await f.close();
    }
  },
);

test(
  "manual Memory HTTP appends attempt/success/failure audits and scopes sandbox lifecycle without historical reads",
  { skip: !url },
  async () => {
    const { buildAPI } = await import("../src/api/server.js"),
      { sqlMetrics } = await import("./personal-sql-metrics.js"),
      { Fault } = await import("../src/domain/model.js");
    const f = await reviewDatabase(),
      provider = new DemoSandbox(),
      sandbox = new SandboxManager(f.sa, provider),
      app = buildAPI(
        f.service,
        async () => ({ ...f.actor, personal: false }),
        sandbox,
      );
    try {
      await largeSessionHistory(f);
      const execute = provider.execute.bind(provider);
      let fail = false;
      provider.execute = async (sid, op, args) => {
        if (fail && op === "write")
          throw new Fault(503, "MEMORY_SANDBOX_FAILURE");
        return execute(sid, op, args);
      };
      const m = await sqlMetrics(f.a.pool),
        samples = [];
      // Any accidental fallback would reintroduce the history load even if audit appends were fixed.
      f.a.tx = async () => {
        throw new Error("manual Memory used full tx");
      };
      for (const failure of [false, true]) {
        fail = failure;
        m.start();
        const r = await app.inject({
          method: "PUT",
          url: "/api/v1/me/memory/note.md",
          payload: { content: "remember this" },
        });
        const stats = controlReads(m.stop());
        assert.equal(r.statusCode, failure ? 503 : 200, r.body);
        samples.push({ failure, ...stats });
      }
      const rows = await f.a.pool.query(
        "SELECT data FROM personal_audit WHERE user_id=$1 AND data->>'resource'='/workspace/memory/note.md' ORDER BY data->>'timestamp',id",
        [f.actor.userId],
      );
      const actions = rows.rows.map((r) => r.data.action);
      assert.equal(
        actions.filter((a) => a === "memory.write.attempt").length,
        2,
      );
      assert.equal(actions.filter((a) => a === "memory.write").length, 1);
      assert.equal(
        actions.filter((a) => a === "memory.write.failed").length,
        1,
      );
      assert.equal(
        rows.rows.find((r) => r.data.action === "memory.write.failed")!.data
          .result,
        "MEMORY_SANDBOX_FAILURE",
      );
      fail = false;
      const read = await app.inject({ url: "/api/v1/me/memory/note.md" });
      assert.equal(read.statusCode, 200, read.body);
      assert.match(read.json().text, /remember this/);
      console.log(JSON.stringify({ round7ManualMemory: samples }));
    } finally {
      await app.close();
      await f.close();
    }
  },
);

test(
  "015 backfills parent/resumedFrom-only task identities atomically and cancels whole legacy chains from root or child",
  { skip: !url },
  async () => {
    const { taskIdentity } = await import("../src/domain/service.js");
    const f = await reviewDatabase();
    try {
      const rootSession = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        }),
        root = await f.service.submit(f.actor, rootSession.id, "legacy root");
      const runs = [root],
        iids = [id(), id()];
      for (let n = 0; n < 3; n++) {
        const ses = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        });
        runs.push({
          ...root,
          id: id(),
          sessionId: ses.id,
          prompt: `legacy ${n}`,
          parentRunId: n === 0 ? root.id : undefined,
          resumedFrom: n > 0 ? iids[n - 1] : undefined,
        });
      }
      await f.sa.executionTx!(f.actor.userId, root.id, (s) => {
        for (const r of runs) s.runs[r.id] = { ...r };
        s.interactions[iids[0]!] = {
          id: iids[0]!,
          runId: runs[1]!.id,
          kind: "question",
          resolved: true,
          payload: {},
          response: "yes",
          continuationRunId: runs[2]!.id,
        };
        s.interactions[iids[1]!] = {
          id: iids[1]!,
          runId: runs[2]!.id,
          kind: "approval",
          resolved: true,
          payload: {},
          response: "approve",
          continuationRunId: runs[3]!.id,
        };
      });
      await f.a.pool.query(
        "UPDATE personal_runs SET data=data-'taskId'-'rootRunId' WHERE user_id=$1 AND run_id=ANY($2::text[])",
        [f.actor.userId, runs.map((r) => r.id)],
      );
      const before = await f.sa.read(f.actor.userId, (s) => {
        for (const r of runs)
          assert.equal(taskIdentity(s, s.runs[r.id]!), root.id);
        return Object.fromEntries(runs.map((r) => [r.id, s.runs[r.id]]));
      });
      await f.a.pool.query("UPDATE personal_schema SET version=12 WHERE id=1");
      const migration =
          (await readFile(
            "migrations/015_personal_legacy_tasks_stats.sql",
            "utf8",
          )) +
          "\n" +
          (await readFile("migrations/016_personal_evaluations.sql", "utf8")),
        c = await f.a.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(migration);
        await assert.rejects(f.b.ready(), /SCHEMA_MISMATCH/);
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
      const rolled = await f.a.pool.query(
        "SELECT data FROM personal_runs WHERE user_id=$1 AND run_id=ANY($2::text[])",
        [f.actor.userId, runs.map((r) => r.id)],
      );
      assert.ok(rolled.rows.every((r) => !r.data.taskId && !r.data.rootRunId));
      await f.a.pool.query(migration);
      await f.a.ready();
      await f.a.pool.query(migration);
      await f.sa.executionTx!(f.actor.userId, root.id, (s) => {
        for (const r of runs) {
          const actual = s.runs[r.id]!;
          assert.equal(actual.taskId, root.id);
          assert.equal(actual.rootRunId, root.id);
          const { taskId, rootRunId, ...rest } = actual;
          assert.deepEqual(rest, before[r.id]);
        }
      });
      await f.other.cancel(f.actor, root.id);
      await f.sa.executionTx!(f.actor.userId, root.id, (s) => {
        for (const r of runs) {
          assert.equal(s.runs[r.id]!.state, "CANCELLED");
          s.runs[r.id]!.state = "QUEUED";
          delete s.runs[r.id]!.cancelRequested;
        }
      });
      await f.other.cancel(f.actor, runs[3]!.id);
      await f.sa.executionTx!(f.actor.userId, root.id, (s) => {
        assert.equal(Object.keys(s.runs).length, 4);
        assert.ok(Object.values(s.runs).every((r) => r.state === "CANCELLED"));
      });
    } finally {
      await f.close();
    }
  },
);

test(
  "015 rejects cyclic legacy ancestry without partial backfill and preserves dangling/cross-user parent semantics",
  { skip: !url },
  async () => {
    const f = await reviewDatabase();
    try {
      const roots = [];
      for (let n = 0; n < 3; n++) {
        const ses = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        });
        roots.push(await f.service.submit(f.actor, ses.id, "legacy"));
      }
      for (let n = 0; n < 3; n++)
        await f.a.pool.query(
          "UPDATE personal_runs SET data=(data-'taskId'-'rootRunId')||jsonb_build_object('parentRunId',$3::text) WHERE user_id=$1 AND run_id=$2",
          [
            f.actor.userId,
            roots[n]!.id,
            n < 2 ? roots[1 - n]!.id : "missing-parent",
          ],
        );
      await f.a.pool.query("UPDATE personal_schema SET version=12 WHERE id=1");
      const migration =
        (await readFile(
          "migrations/015_personal_legacy_tasks_stats.sql",
          "utf8",
        )) +
        "\n" +
        (await readFile("migrations/016_personal_evaluations.sql", "utf8"));
      await assert.rejects(
        f.a.pool.query(migration),
        /Legacy personal Run cycle detected/,
      );
      assert.equal(
        (await f.a.pool.query("SELECT version FROM personal_schema WHERE id=1"))
          .rows[0].version,
        12,
      );
      assert.equal(
        (
          await f.a.pool.query(
            "SELECT count(*)::int AS n FROM personal_runs WHERE user_id=$1 AND data->>'taskId' IS NOT NULL",
            [f.actor.userId],
          )
        ).rows[0].n,
        0,
      );
      const foreign = await principal(f.ar, {
          tenantId: "foreign",
          userId: "foreign",
          admin: false,
        }),
        ses = await f.service.createPersonalSession(foreign, { agentId: "a" }),
        other = await f.service.submit(foreign, ses.id, "foreign root");
      await f.a.pool.query(
        "UPDATE personal_runs SET data=jsonb_set(data,'{parentRunId}',$3::jsonb) WHERE user_id=$1 AND run_id=$2",
        [f.actor.userId, roots[1]!.id, JSON.stringify(other.id)],
      );
      await f.a.pool.query(migration);
      await f.a.ready();
      const r = await f.a.pool.query(
        "SELECT run_id,data FROM personal_runs WHERE user_id=$1",
        [f.actor.userId],
      );
      const expected = new Map([
        [roots[0]!.id, roots[1]!.id],
        [roots[1]!.id, roots[1]!.id],
        [roots[2]!.id, roots[2]!.id],
      ]);
      for (const row of r.rows)
        assert.equal(row.data.taskId, expected.get(row.run_id));
      await f.other.cancel(f.actor, roots[0]!.id);
      assert.equal(
        (await f.sa.readRun(foreign.userId, other.id, (s) => s.runs[other.id]!))
          .state,
        "QUEUED",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "manual Memory batches file steps under one lease and serializes concurrent note/index updates",
  { skip: !url },
  async () => {
    const { buildAPI } = await import("../src/api/server.js"),
      { sqlMetrics } = await import("./personal-sql-metrics.js");
    const f = await reviewDatabase(),
      provider = new DemoSandbox(),
      app = buildAPI(
        f.service,
        async () => ({ ...f.actor, personal: false }),
        new SandboxManager(f.sa, provider),
      );
    let release!: () => void, enter!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (enter = r));
    try {
      await largeSessionHistory(f);
      const execute = provider.execute.bind(provider),
        owners: string[] = [],
        steps: string[] = [];
      let hold = true;
      provider.execute = async (sid, op, args) => {
        const w = (
          await f.b.pool.query(
            "SELECT state->'workspaces'->$2::text AS w FROM personal_user_state WHERE user_id=$1",
            [f.actor.userId, f.actor.userId],
          )
        ).rows[0].w;
        owners.push(w.lock.owner);
        steps.push(`${op}:${args.path}`);
        if (hold && op === "find") {
          hold = false;
          enter();
          await gate;
        }
        return execute(sid, op, args);
      };
      const m = await sqlMetrics(f.a.pool);
      m.start();
      const first = app.inject({
        method: "PUT",
        url: "/api/v1/me/memory/one.md",
        payload: { content: "one" },
      });
      await ready;
      const second = app.inject({
        method: "PUT",
        url: "/api/v1/me/memory/two.md",
        payload: { content: "two" },
      });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(new Set(owners).size, 1);
      assert.equal(steps.length, 2);
      release();
      const replies = await Promise.all([first, second]);
      for (const r of replies) assert.equal(r.statusCode, 200, r.body);
      const stats = controlReads(m.stop());
      assert.ok(stats.queries < 400, `${stats.queries} queries for two writes`);
      const groups = owners.filter((o, i) => i === 0 || o !== owners[i - 1]);
      assert.equal(groups.length, 2);
      assert.equal(new Set(groups).size, 2);
      assert.equal(
        steps.filter((s) => s === "write:/workspace/memory/MEMORY.md").length,
        2,
      );
      const w = await f.sa.readMetadata(
        f.actor.userId,
        ["workspaces"],
        (s) => s.workspaces[f.actor.userId]!,
      );
      const files = provider.volumes.get(w.volumeId!)!;
      assert.match(files.get("/workspace/memory/MEMORY.md")!, /one\.md/);
      assert.match(files.get("/workspace/memory/MEMORY.md")!, /two\.md/);
      assert.equal(w.lock, undefined);
      console.log(
        JSON.stringify({
          round8MemoryBatch: {
            ...stats,
            requests: 2,
            leaseOwners: groups.length,
          },
        }),
      );
    } finally {
      release?.();
      await app.close();
      await f.close();
    }
  },
);

test(
  "manual Memory rechecks policy, account, workspace ACL and grants before each remote write and cleans aborts",
  { skip: !url },
  async () => {
    const { MemoryManager } = await import("../src/execution/memory.js");
    const f = await reviewDatabase(),
      provider = new DemoSandbox();
    let granted = true;
    const sandbox = new SandboxManager(f.sa, provider, {}, () => granted),
      memory = new MemoryManager(f.sa, sandbox),
      config = AgentConfig.parse({ ...f.config, memory: { enabled: true } });
    try {
      await f.service.ensureWorkspace(f.actor);
      const execute = provider.execute.bind(provider);
      for (const revocation of ["policy", "account", "acl", "grant", "abort"]) {
        const ac = new AbortController();
        let fired = false,
          indexWrites = 0;
        provider.execute = async (sid, op, args) => {
          if (op === "write" && String(args.path).endsWith("/MEMORY.md"))
            indexWrites++;
          const result = await execute(sid, op, args);
          if (!fired && op === "write") {
            fired = true;
            if (revocation === "policy")
              await f.br.tx((s) => {
                s.policy = { disabledTools: ["write"] };
              });
            if (revocation === "account")
              await f.b.pool.query(
                "UPDATE personal_users SET enabled=false WHERE id=$1",
                [f.actor.userId],
              );
            if (revocation === "acl")
              await f.sb.workspaceTx!(f.actor.userId, (s) => {
                s.workspaces[f.actor.userId]!.members[f.actor.userId] =
                  "viewer";
              });
            if (revocation === "grant") granted = false;
            if (revocation === "abort") ac.abort();
          }
          return result;
        };
        const expected = {
          policy: "TOOL_DISABLED",
          account: "USER_DISABLED",
          acl: "READ_ONLY",
          grant: "BUNDLE_NOT_GRANTED",
        }[revocation];
        await assert.rejects(
          memory.write(
            f.actor,
            f.actor.userId,
            id(),
            config,
            "/workspace",
            `/workspace/memory/${revocation}.md`,
            revocation,
            ac.signal,
            true,
          ),
          (e) =>
            revocation === "abort"
              ? (e as Error).name === "AbortError"
              : (e as { code: string }).code === expected,
        );
        assert.equal(fired, true);
        assert.equal(indexWrites, 0, "revocation must stop the index write");
        granted = true;
        await f.br.tx((s) => {
          s.policy = { disabledTools: [] };
        });
        await f.b.pool.query(
          "UPDATE personal_users SET enabled=true WHERE id=$1",
          [f.actor.userId],
        );
        await f.sb.workspaceTx!(f.actor.userId, (s) => {
          s.workspaces[f.actor.userId]!.members[f.actor.userId] = "owner";
        });
        const w = await f.sa.readMetadata(
          f.actor.userId,
          ["workspaces"],
          (s) => s.workspaces[f.actor.userId]!,
        );
        assert.equal(w.lock, undefined);
      }
      const ac = new AbortController();
      const expired = { ...f.actor, expiresAt: Date.now() - 1 };
      let calls = 0;
      provider.execute = async (...args) => {
        calls++;
        return execute(...args);
      };
      await assert.rejects(
        memory.write(
          expired,
          f.actor.userId,
          id(),
          config,
          "/workspace",
          "/workspace/memory/expired.md",
          "expired",
          ac.signal,
          true,
        ),
        { code: "ACTOR_TOKEN_EXPIRED" },
      );
      assert.equal(calls, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "admin stats aggregate in SQL with an indexed failure count and bounded HTTP payload under 50k historical Events",
  { skip: !url },
  async () => {
    const { buildAPI } = await import("../src/api/server.js"),
      { sqlMetrics } = await import("./personal-sql-metrics.js");
    const f = await reviewDatabase(),
      app = buildAPI(
        f.service,
        async (h) => ({
          ...f.actor,
          personal: false,
          admin: h !== "Bearer ordinary",
        }),
        new SandboxManager(f.sa, new DemoSandbox()),
      );
    try {
      const zero = {
        runs: {},
        pendingInteractions: 0,
        averageRunDurationMs: 0,
        toolFailures: 0,
      };
      assert.deepEqual(await f.a.adminStats("absent"), zero);
      assert.deepEqual(await f.a.adminStats(f.actor.userId), zero);
      const pending = await waitingInteraction(f),
        resolved = await waitingInteraction(f),
        ended = await waitingInteraction(f);
      await f.sa.executionTx!(f.actor.userId, resolved.root.id, (s) => {
        s.interactions[resolved.iid]!.resolved = true;
      });
      await f.sa.executionTx!(f.actor.userId, ended.root.id, (s) => {
        s.runs[ended.root.id]!.state = "COMPLETED";
        s.runs[ended.root.id]!.startedAt = "2020-01-01T00:00:00.000Z";
        s.runs[ended.root.id]!.endedAt = "2020-01-01T00:00:01.000Z";
        event(s, s.runs[ended.root.id]!, "tool.failed");
      });
      const ses = await f.service.createPersonalSession(f.actor, {
          agentId: "a",
        }),
        failed = await f.service.submit(f.actor, ses.id, "failure");
      await f.sa.executionTx!(f.actor.userId, failed.id, (s) => {
        const r = s.runs[failed.id]!;
        r.state = "FAILED";
        r.startedAt = "2020-01-01T00:00:00.000Z";
        r.endedAt = "2020-01-01T00:00:03.000Z";
        event(s, r, "tool.failed");
        event(s, r, "tool.failed");
      });
      const base = {
        runs: { WAITING_INPUT: 2, COMPLETED: 1, FAILED: 1 },
        pendingInteractions: 1,
        averageRunDurationMs: 2000,
        toolFailures: 3,
      };
      assert.deepEqual(await f.a.adminStats(f.actor.userId), base);
      const m = await sqlMetrics(f.a.pool),
        samples = [];
      let statsSQL = "";
      for (const history of [false, true]) {
        if (history) await largeSessionHistory(f);
        m.start();
        const started = performance.now();
        const r = await app.inject({ url: "/api/v1/admin/stats" });
        const ms = performance.now() - started;
        const records = m.stop();
        statsSQL = records.find((r) => r.sql.startsWith("WITH summaries"))!.sql;
        assert.equal(r.statusCode, 200, r.body);
        assert.deepEqual(r.json(), {
          ...base,
          runs: { ...base.runs, COMPLETED: history ? 5002 : 1 },
        });
        assert.equal(records.length, 2);
        assert.equal(
          records.filter((r) => r.sql.startsWith("WITH summaries")).length,
          1,
        );
        assert.ok(
          !records.some((r) => /^SELECT data FROM personal_/.test(r.sql)),
        );
        const bytes = records.reduce((n, r) => n + r.bytes, 0);
        assert.ok(bytes < 1000);
        samples.push({ history, queries: records.length, bytes, ms });
      }
      const foreign = await principal(f.ar, {
          tenantId: "other-stats",
          userId: "other-stats",
          admin: false,
        }),
        fs = await f.service.createPersonalSession(foreign, { agentId: "a" }),
        fr = await f.service.submit(foreign, fs.id, "outside");
      await f.sa.executionTx!(foreign.userId, fr.id, (s) =>
        event(s, s.runs[fr.id]!, "tool.failed"),
      );
      assert.equal((await f.a.adminStats(f.actor.userId)).toolFailures, 3);
      assert.equal(
        (
          await app.inject({
            url: "/api/v1/admin/stats",
            headers: { authorization: "Bearer ordinary" },
          })
        ).statusCode,
        403,
      );
      await f.a.pool.query("ANALYZE personal_run_events");
      const plan = (
        await f.a.pool.query(
          "EXPLAIN (ANALYZE,FORMAT JSON) SELECT count(*) FROM personal_run_events WHERE user_id=$1 AND data->>'type'='tool.failed'",
          [f.actor.userId],
        )
      ).rows[0]["QUERY PLAN"];
      assert.match(JSON.stringify(plan), /personal_tool_failures/);
      assert.doesNotMatch(JSON.stringify(plan), /"Node Type":"Seq Scan"/);
      const allPlan = (
        await f.a.pool.query(
          "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + statsSQL,
          [f.actor.userId],
        )
      ).rows[0]["QUERY PLAN"];
      const scans: unknown[] = [];
      const walk = (p: any) => {
        if (p["Relation Name"])
          scans.push({
            relation: p["Relation Name"],
            index: p["Index Name"],
            rows: p["Actual Rows"],
            loops: p["Actual Loops"],
            ms: p["Actual Total Time"],
          });
        for (const n of p.Plans ?? []) walk(n);
      };
      walk(allPlan[0].Plan);
      console.log(
        JSON.stringify({
          round8Stats: samples,
          statsPlan: { ms: allPlan[0]["Execution Time"], scans },
        }),
      );
    } finally {
      await app.close();
      await f.close();
    }
  },
);

test(
  "workspace lease observation and assertOwned dispatch checks stay read-only through nested SandboxManagers",
  { skip: !url },
  async () => {
    const { sqlMetrics } = await import("./personal-sql-metrics.js");
    const f = await reviewDatabase(),
      provider = new DemoSandbox(),
      first = new SandboxManager(f.sa, provider),
      second = new SandboxManager(f.sb, provider);
    let release!: () => void, entered!: () => void, observed!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (entered = r)),
      observations = new Promise<void>((r) => (observed = r));
    let active: Promise<unknown> | undefined,
      waiting: Promise<unknown> | undefined;
    try {
      await f.service.ensureWorkspace(f.actor);
      active = first.withWorkspaceLease(
        f.actor,
        f.actor.userId,
        "holder",
        "default",
        async () => {
          entered();
          await gate;
        },
      );
      await ready;
      const m = await sqlMetrics(f.b.pool),
        read = f.b.readMetadata.bind(f.b);
      let probes = 0;
      f.b.readMetadata = async (user, keys, fn) => {
        const result = await read(user, keys, fn);
        if (
          keys.length === 2 &&
          keys.includes("workspaces") &&
          keys.includes("skills") &&
          ++probes === 3
        )
          observed();
        return result;
      };
      const assertReadOnly = (rows: { sql: string }[]) => {
        assert.ok(rows.length > 0);
        assert.ok(
          !rows.some((r) =>
            /^(BEGIN|INSERT|UPDATE|DELETE)|FOR (NO KEY UPDATE|UPDATE|SHARE)/.test(
              r.sql,
            ),
          ),
          JSON.stringify(rows.map((r) => r.sql)),
        );
      };
      m.start();
      let checks: ReturnType<typeof m.stop> = [];
      waiting = second.withWorkspaceLease(
        f.actor,
        f.actor.userId,
        "waiter",
        "default",
        async (execute) => {
          m.start();
          await execute("find", { path: "/workspace/memory" });
          checks = m.stop();
          assertReadOnly(checks);
        },
      );
      await observations;
      const observing = m.stop();
      assertReadOnly(observing);
      assert.ok(probes >= 3);
      release();
      await Promise.all([active, waiting]);
      assert.ok(checks.some((r) => r.sql.includes("personal_user_state")));
      assert.ok(checks.some((r) => r.sql.includes("personal_users")));
      console.log(
        JSON.stringify({
          round9ReadOnly: {
            observationSQL: observing.length,
            dispatchSQL: checks.length,
            begin: 0,
            lockingReads: 0,
          },
        }),
      );
    } finally {
      release?.();
      await Promise.allSettled([active, waiting].filter(Boolean));
      await f.close();
    }
  },
);
