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
          tenantId: "cop",
          issuer: "urn:ucs",
          userId: "a",
          admin: true,
        }),
        principal(br, {
          tenantId: "cop",
          issuer: "urn:ucs",
          userId: "a",
          admin: true,
        }),
      ]);
      assert.equal(alice.userId, again.userId);
      const bob = await principal(br, {
        tenantId: "cop",
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
      for (const name of names.filter((n) => n < "006"))
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
        await readFile("migrations/006_editable_agents.sql", "utf8"),
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
