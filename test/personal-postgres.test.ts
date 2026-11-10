import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { PersonalPostgresStore } from "../src/personal-postgres-store.js";
import { PostgresRegistry, principal } from "../src/store/registry.js";
import { personalStore } from "../src/store/personal.js";
import { PersonalService } from "../src/personal-service.js";
import { replaceAgents } from "../src/config/agents.js";
import type { State, Actor } from "../src/domain.js";
function configure(
  s: State,
  input: { agents: unknown[]; policy: { disabledTools: string[] } },
  a: Actor,
) {
  s.policy = input.policy;
  return replaceAgents(s, input.agents, a);
}
import { AgentConfig, id, event } from "../src/domain.js";
import { Worker } from "../src/worker.js";
import { DemoSandbox, SandboxManager } from "../src/adapters/sandbox.js";
import { DemoRuntime } from "../src/runtime.js";
import { MCPManager } from "../src/adapters/mcp.js";
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
      await backing.tx(actor.tenantId, (s) => {
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
        (includeExecutionMigration || !n.startsWith("009")),
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
        cron: "* * * * *",
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
  "personal readiness requires committed migration 009, normalized schedules and all valid hot-path indexes",
  { skip: !url },
  async () => {
    const { ScheduleService } = await import("../src/schedules/service.js"),
      { buildAPI } = await import("../src/api.js");
    const f = await reviewDatabase(false),
      scheduler = new ScheduleService(f.service);
    const app = buildAPI(
      f.service,
      async () => f.actor,
      new SandboxManager(f.sa, new DemoSandbox()),
    );
    try {
      const task = await scheduler.create(f.actor, {
        agentId: "a",
        cron: "* * * * *",
        prompt: "legacy",
      });
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
      const migration = await readFile(
        "migrations/009_personal_execution_indexes.sql",
        "utf8",
      );
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
        7,
      );
      for (const index of [
        "personal_runs_running",
        "personal_scheduled_tasks_due",
        "personal_schedule_fires_pending",
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
      const { buildAPI } = await import("../src/api.js"),
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
    const { buildAPI } = await import("../src/api.js");
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
            audit: [{ id: "old-audit" }],
            usage: { requests: {}, resources: [{ state: "old-resource" }] },
          }),
        ],
      );
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
      assert.ok(row.audit.some((a: { id: string }) => a.id === "old-audit"));
      assert.ok(
        row.audit.some(
          (a: { action: string }) => a.action === "sandbox.creation.dispatched",
        ),
      );
      assert.ok(
        row.usage.resources.some(
          (r: { state: string }) => r.state === "old-resource",
        ),
      );
      assert.ok(
        row.usage.resources.some(
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
