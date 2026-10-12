import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PostgresStore } from "../src/store.js";
import { emptyState, id, event, type Run, AgentConfig } from "../src/domain.js";
const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_TESTS === "true" && !url)
  throw new Error("TEST_DATABASE_URL required");
async function isolated() {
  const control = new PostgresStore(url!),
    schema = "roundtrip_" + id().replaceAll("-", "");
  await control.pool.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url!);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const store = new PostgresStore(scoped.toString());
  return {
    store,
    async close() {
      await store.close();
      await control.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await control.close();
    },
  };
}
async function migrate(store: PostgresStore) {
  const c = await store.pool.connect();
  try {
    await c.query("BEGIN");
    for (const n of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await c.query(await readFile("migrations/" + n, "utf8"));
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
test(
  "001–006 upgrade and offline rollback preserve current Runs, checkpoints, event IDs, unknown capacity and generations",
  { skip: !url },
  async () => {
    const f = await isolated();
    try {
      await f.store.pool.query(
        await readFile("migrations/001_initial.sql", "utf8"),
      );
      const state = emptyState(),
        actor = { tenantId: "legacy", userId: "u", admin: true };
      state.agents.a = {
        id: "a",
        enabled: true,
        digest: "legacy",
        publishedAt: new Date().toISOString(),
        config: AgentConfig.parse({
          name: "legacy",
          systemPrompt: "legacy",
          model: { provider: "demo", modelId: "demo" },
          tools: [],
          skillBundle: "default",
        }),
      };
      state.sessions.s = {
        id: "s",
        workspaceId: "w",
        agentVersionId: "a",
        entries: [{ checkpoint: "before" }],
        createdAt: new Date().toISOString(),
      };
      const r: Run = {
        id: "r",
        sessionId: "s",
        actor,
        prompt: "preserve",
        state: "RUNNING",
        lease: { owner: "old", expires: 10 },
        createdAt: new Date().toISOString(),
        requestDigest: "hash",
        depth: 0,
        steps: 1,
      };
      state.runs.r = r;
      event(state, r, "run.started");
      state.sequence = 40;
      state.audit = [
        {
          id: "audit",
          actorId: "u",
          timestamp: new Date().toISOString(),
          action: "old",
          resource: "r",
          result: "allowed",
        },
      ];
      state.usage = {
        requests: {},
        resources: [{ workspaceId: "w", state: "unknown", at: 1 }],
      };
      const entries = Object.fromEntries(
        ["reserved", "active", "paused", "unknown", "released"].map(
          (status, i) => [
            JSON.stringify(["legacy", "w" + i]),
            {
              tenantId: "legacy",
              workspaceId: "w" + i,
              userId: "u",
              state: status,
              operation: "op" + i,
              sandboxId: "box" + i,
              updatedAt: 10,
            },
          ],
        ),
      );
      await f.store.pool.query(
        "INSERT INTO harness_tenants(tenant_id,state) VALUES($1,$2)",
        ["legacy", JSON.stringify(state)],
      );
      await f.store.pool.query(
        "INSERT INTO harness_sandbox_capacity VALUES(1,$1)",
        [JSON.stringify({ entries })],
      );
      await migrate(f.store);
      await f.store.ready();
      state.agents.a!.agentId = "a";
      state.logicalAgents.a = {
        id: "a",
        activeVersionId: "a",
        allowedUsers: [],
      };
      state.sessions.s!.agentId = "a";
      state.sessions.s!.effectiveVersionId = "a";
      Object.assign(state.runs.r!, {
        agentVersionId: "a",
        taskId: "r",
        rootRunId: "r",
        capabilities: state.agents.a!.config,
      });
      assert.deepEqual(await f.store.read("legacy", (s) => s), state);
      assert.deepEqual(await f.store.capacityRead((s) => s.entries), entries);
      await migrate(f.store);
      assert.deepEqual(await f.store.read("legacy", (s) => s), state);
      await f.store.tx("legacy", (s) => {
        s.runs.r!.state = "FAILED";
        s.runs.r!.error = "WORKER_LOST_UNKNOWN_TOOL_OUTCOME";
        delete s.runs.r!.lease;
        s.sessions.s!.entries = [{ checkpoint: "after" }];
        event(s, s.runs.r!, "run.failed", { unknown: true });
      });
      await f.store.capacityTx((s) => {
        const e = s.entries[JSON.stringify(["legacy", "w0"])]!;
        e.operation = "new-generation";
        e.state = "unknown";
        e.sandboxId = "new-box";
        e.updatedAt = 20;
      });
      const current = await f.store.read("legacy", (s) => s),
        capacity = await f.store.capacityRead((s) => s);
      assert.deepEqual(
        current.events.map((e) => e.eventId),
        [1, 41],
      );
      await f.store.pool.query(
        await readFile("scripts/rollback-normalized.sql", "utf8"),
      );
      const restored = (
        await f.store.pool.query(
          "SELECT state FROM harness_tenants WHERE tenant_id='legacy'",
        )
      ).rows[0].state;
      assert.deepEqual(
        restored,
        current,
        "rollback uses current normalized data, not migration-time JSON",
      );
      assert.deepEqual(
        (
          await f.store.pool.query(
            "SELECT state FROM harness_sandbox_capacity WHERE id=1",
          )
        ).rows[0].state,
        capacity,
      );
      await assert.rejects(f.store.ready(), /SCHEMA_MISMATCH/);
      assert.equal(
        (
          await f.store.pool.query(
            "SELECT version FROM harness_schema WHERE id=1",
          )
        ).rows[0].version,
        1,
      );
      // Prevent a repeated upgrade from silently using retained stale normalized tables.
      await assert.rejects(migrate(f.store), /Legacy aggregates detected/);
      assert.deepEqual(
        (
          await f.store.pool.query(
            "SELECT state FROM harness_tenants WHERE tenant_id='legacy'",
          )
        ).rows[0].state,
        restored,
      );
      assert.equal(
        (
          await f.store.pool.query(
            "SELECT version FROM harness_schema WHERE id=1",
          )
        ).rows[0].version,
        1,
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "001–006 migration failure rolls back all partial tables, flags and legacy JSON changes",
  { skip: !url },
  async () => {
    const f = await isolated();
    try {
      await f.store.pool.query(
        await readFile("migrations/001_initial.sql", "utf8"),
      );
      const state = emptyState();
      state.runs.broken = {
        id: "broken",
        sessionId: "missing",
        actor: { tenantId: "broken", userId: "u", admin: false },
        state: "QUEUED",
        prompt: "bad",
        createdAt: new Date().toISOString(),
        requestDigest: "bad",
        depth: 0,
        steps: 0,
      };
      await f.store.pool.query(
        "INSERT INTO harness_tenants(tenant_id,state) VALUES($1,$2)",
        ["broken", JSON.stringify(state)],
      );
      await assert.rejects(migrate(f.store), /foreign key/);
      assert.deepEqual(
        (
          await f.store.pool.query(
            "SELECT state FROM harness_tenants WHERE tenant_id='broken'",
          )
        ).rows[0].state,
        state,
      );
      assert.deepEqual(
        (
          await f.store.pool.query(
            "SELECT to_regclass('harness_runs') AS runs,to_regclass('harness_sandbox_leases') AS leases,to_regclass('harness_migration_flags') AS flags",
          )
        ).rows[0],
        { runs: null, leases: null, flags: null },
      );
      assert.equal(
        (
          await f.store.pool.query(
            "SELECT version FROM harness_schema WHERE id=1",
          )
        ).rows[0].version,
        1,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "005 reconstructs waiting continuations and subagent task chains, with immutable Run authorization snapshots",
  { skip: !url },
  async () => {
    const f = await isolated();
    try {
      for (const name of [
        "001_initial.sql",
        "002_sandbox_leases.sql",
        "003_runs_sessions_events.sql",
        "004_schema_readiness.sql",
      ])
        await f.store.pool.query(await readFile("migrations/" + name, "utf8"));
      const actor = { tenantId: "legacy-chain", userId: "u", admin: true };
      const cfg = AgentConfig.parse({
        name: "old",
        systemPrompt: "V1",
        model: { provider: "demo", modelId: "demo" },
        tools: [],
        skillBundle: "default",
      });
      await f.store.tx(actor.tenantId, (s) => {
        s.agents.a = {
          id: "a",
          config: cfg,
          digest: "old",
          publishedAt: new Date().toISOString(),
          enabled: true,
        };
        s.workspaces.w = {
          id: "w",
          name: "w",
          ownerId: "u",
          members: { u: "owner" },
        };
        s.sessions.s = {
          id: "s",
          workspaceId: "w",
          agentVersionId: "a",
          entries: [{ checkpoint: true }],
          createdAt: new Date().toISOString(),
        };
        s.sessions.child = { ...s.sessions.s, id: "child" };
        for (const [rid, sid, state, extra] of [
          ["root", "s", "COMPLETED", {}],
          ["continued", "s", "WAITING_INPUT", { resumedFrom: "i" }],
          [
            "child",
            "child",
            "WAITING_INPUT",
            { parentRunId: "continued", capabilities: cfg },
          ],
        ] as const)
          s.runs[rid] = {
            id: rid,
            sessionId: sid,
            state,
            actor,
            prompt: rid,
            requestDigest: rid,
            createdAt: new Date().toISOString(),
            depth: 0,
            steps: 0,
            ...extra,
          };
        s.interactions.i = {
          id: "i",
          runId: "root",
          kind: "question",
          resolved: true,
          response: "answer",
          continuationRunId: "continued",
          payload: {},
        };
      });
      await migrate(f.store);
      await migrate(f.store);
      await f.store.read(actor.tenantId, (s) => {
        assert.equal(s.logicalAgents.a!.activeVersionId, "a");
        assert.equal(s.sessions.s!.effectiveVersionId, "a");
        for (const r of Object.values(s.runs)) {
          assert.equal(r.taskId, "root");
          assert.equal(r.rootRunId, "root");
          assert.equal(r.agentVersionId, "a");
          assert.deepEqual(r.capabilities, cfg);
        }
        assert.deepEqual(s.sessions.s!.entries, [{ checkpoint: true }]);
      });
      // Optimized reads must use Run versions, even when Session observations differ.
      await f.store.tx(actor.tenantId, (s) => {
        s.agents.b = {
          ...s.agents.a!,
          id: "b",
          config: { ...cfg, systemPrompt: "V2" },
        };
        s.sessions.s!.agentVersionId = "b";
      });
      const { authorizedRun } = await import("../src/service.js");
      assert.equal(
        await f.store.readRun(
          actor.tenantId,
          "continued",
          (s) => authorizedRun(s, s.runs.continued!).config.systemPrompt,
        ),
        "V1",
      );
      await f.store.pool.query(
        await readFile("migrations/005_agent_task_versions.sql", "utf8"),
      );
      assert.equal(
        await f.store.read(
          actor.tenantId,
          (s) => s.runs.continued!.agentVersionId,
        ),
        "a",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "006 migrates current ACL once; rollback and optimized Worker snapshots enforce the logical policy",
  { skip: !url },
  async () => {
    const f = await isolated();
    try {
      await migrate(f.store);
      const actor = { tenantId: "acl-migration", userId: "alice", admin: true };
      const cfg = AgentConfig.parse({
        name: "agent",
        systemPrompt: "V1",
        model: { provider: "demo", modelId: "demo" },
        tools: [],
        skillBundle: "default",
      });
      await f.store.tx(actor.tenantId, (s) => {
        s.agents.v1 = {
          id: "v1",
          agentId: "logical",
          config: cfg,
          digest: "v1",
          publishedAt: new Date().toISOString(),
          enabled: true,
          allowedUsers: ["alice", "bob"],
        };
        s.agents.v2 = {
          ...s.agents.v1,
          id: "v2",
          config: { ...cfg, systemPrompt: "V2" },
          allowedUsers: ["alice"],
        };
        s.logicalAgents.logical = { id: "logical", activeVersionId: "v2" };
        s.workspaces.w = {
          id: "w",
          name: "w",
          ownerId: "alice",
          members: { alice: "owner", bob: "editor" },
        };
        s.sessions.s = {
          id: "s",
          workspaceId: "w",
          agentVersionId: "v1",
          agentId: "logical",
          effectiveVersionId: "v1",
          entries: [],
          createdAt: new Date().toISOString(),
        };
        s.runs.r = {
          id: "r",
          sessionId: "s",
          agentVersionId: "v1",
          taskId: "r",
          rootRunId: "r",
          actor: { ...actor, userId: "bob", admin: false },
          prompt: "old",
          state: "QUEUED",
          createdAt: new Date().toISOString(),
          requestDigest: "old",
          depth: 0,
          steps: 0,
        };
      });
      const migration = await readFile(
        "migrations/006_logical_agent_acl.sql",
        "utf8",
      );
      await f.store.pool.query(migration);
      const { HarnessService, authorizedRun } = await import(
        "../src/service.js"
      );
      const service = new HarnessService(f.store, [], ["default"]);
      assert.deepEqual(
        await f.store.read(
          actor.tenantId,
          (s) => s.logicalAgents.logical!.allowedUsers,
        ),
        ["alice"],
      );
      await service.activate(actor, "logical", "v1");
      await assert.rejects(
        f.store.readRun(actor.tenantId, "r", (s) =>
          authorizedRun(s, s.runs.r!),
        ),
        { code: "AGENT_REVOKED" },
      );
      await f.store.pool.query(migration);
      assert.deepEqual(
        await f.store.read(
          actor.tenantId,
          (s) => s.logicalAgents.logical!.allowedUsers,
        ),
        ["alice"],
      );
      await service.setAccess(actor, "v1", ["alice", "bob"]);
      assert.equal(
        await f.store.readRun(
          actor.tenantId,
          "r",
          (s) => authorizedRun(s, s.runs.r!).config.systemPrompt,
        ),
        "V1",
      );
      await service.setAccess(actor, "logical", ["charlie"]);
      await f.store.pool.query(migration);
      assert.deepEqual(
        await f.store.read(
          actor.tenantId,
          (s) => s.logicalAgents.logical!.allowedUsers,
        ),
        ["charlie"],
      );
      await f.store.ready();
    } finally {
      await f.close();
    }
  },
);
