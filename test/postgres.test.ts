import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PostgresStore } from "../src/store.js";
import { HarnessService } from "../src/service.js";
import { AgentConfig, id, type Actor } from "../src/domain.js";
import {
  SandboxCapacity,
  SandboxPolicySchema,
} from "../src/adapters/sandbox-policy.js";
import { DemoSandbox, SandboxManager } from "../src/adapters/sandbox.js";
const url = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL workspace tool waiters serialize across independent Store clients",
  { skip: !url },
  async () => {
    const actor = {
      tenantId: "tool-queue-" + id(),
      userId: "owner",
      admin: true,
    };
    const stores = [new PostgresStore(url!), new PostgresStore(url!)];
    const provider = new DemoSandbox();
    const managers = stores.map((store) => new SandboxManager(store, provider));
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const began = new Promise<void>((r) => (entered = r));
    let first: Promise<unknown> | undefined,
      second: Promise<unknown> | undefined;
    try {
      await stores[0]!.pool.query(
        (await readFile("migrations/001_initial.sql", "utf8")) +
          (await readFile("migrations/002_sandbox_leases.sql", "utf8")) +
          (await readFile("migrations/003_runs_sessions_events.sql", "utf8")),
      );
      const service = new HarnessService(stores[0]!, [], ["default"]);
      const w = await service.createWorkspace(actor, "tools");
      let calls = 0;
      provider.execute = async () => {
        if (++calls === 1) {
          entered();
          await gate;
        }
        return { text: "result" };
      };
      first = managers[0]!.execute(
        actor,
        w.id,
        "run-one",
        "default",
        "grep",
        {},
      );
      await began;
      // The second client loads the durable lock; it shares no in-memory state.
      assert.equal(
        await stores[1]!.read(
          actor.tenantId,
          (s) => s.workspaces[w.id]!.lock?.kind,
        ),
        "agent",
      );
      second = managers[1]!.execute(
        actor,
        w.id,
        "run-two",
        "default",
        "find",
        {},
      );
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(calls, 1);
      release();
      assert.deepEqual(await Promise.all([first, second]), [
        { text: "result" },
        { text: "result" },
      ]);
      assert.equal(calls, 2);
      assert.equal(provider.boxes.size, 1);
      assert.equal((await managers[0]!.capacity.usage(actor)).user.active, 1);
      assert.equal(
        await stores[1]!.read(actor.tenantId, (s) => s.workspaces[w.id]!.lock),
        undefined,
      );
    } finally {
      release();
      await Promise.allSettled([first, second]);
      await stores[0]!.capacityTx((s) => {
        for (const [key, entry] of Object.entries(s.entries))
          if (entry.tenantId === actor.tenantId) delete s.entries[key];
      });
      await stores[0]!.pool.query(
        "DELETE FROM harness_tenants WHERE tenant_id=$1",
        [actor.tenantId],
      );
      await Promise.all(stores.map((store) => store.close()));
    }
  },
);
test(
  "PostgreSQL restart persistence, multi-client serialization and transaction rollback",
  { skip: !url },
  async () => {
    const a: Actor = { tenantId: "pg-" + id(), userId: "test", admin: true };
    const s1 = new PostgresStore(url!),
      s2 = new PostgresStore(url!);
    try {
      await s1.pool.query(
        (await readFile("migrations/001_initial.sql", "utf8")) +
          (await readFile("migrations/002_sandbox_leases.sql", "utf8")) +
          (await readFile("migrations/003_runs_sessions_events.sql", "utf8")),
      );
      const service = new HarnessService(s1, [], ["default"]);
      const av = await service.publish(
        a,
        AgentConfig.parse({
          name: "pg",
          systemPrompt: "test",
          model: { provider: "demo", modelId: "demo" },
          tools: [],
          skillBundle: "default",
        }),
      );
      const w = await service.createWorkspace(a, "pg");
      const ses = await service.createSession(a, w.id, av.id);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 ? s1 : s2).tx(a.tenantId, (s) => {
            s.sequence++;
          }),
        ),
      );
      assert.equal(await s2.tx(a.tenantId, (s) => s.sequence), 20);
      await assert.rejects(
        s1.tx(a.tenantId, (s) => {
          s.sequence = 999;
          throw new Error("rollback");
        }),
      );
      assert.equal(await s2.tx(a.tenantId, (s) => s.sequence), 20);
      const svc2 = new HarnessService(s2, [], ["default"]);
      const [r1, r2] = await Promise.all([
        service.submit(a, ses.id, "persist", "key"),
        svc2.submit(a, ses.id, "persist", "key"),
      ]);
      assert.equal(r1.id, r2.id);
      await s1.close();
      const s3 = new PostgresStore(url!);
      try {
        const stored = await s3.tx(a.tenantId, (s) => s.runs[r1.id]);
        assert.equal(stored!.prompt, "persist");
        assert.equal(stored!.state, "QUEUED");
        assert.equal(stored!.id, r1.id);
      } finally {
        await s3.close();
      }
    } finally {
      await s2.pool.query("DELETE FROM harness_tenants WHERE tenant_id=$1", [
        a.tenantId,
      ]);
      await s1.close().catch(() => {});
      await s2.close();
    }
  },
);
test(
  "PostgreSQL global Sandbox reservations serialize across workers, persist restart, and roll back on failure",
  { skip: !url },
  async () => {
    const stores = [new PostgresStore(url!), new PostgresStore(url!)];
    const prefix = "capacity-" + id();
    const tenants = Array.from({ length: 8 }, (_, i) => prefix + "-" + i);
    const workspaces = tenants.map((tenant, i) => ({
      id: id(),
      name: "quota",
      ownerId: "user",
      members: { user: "owner" as const },
    }));
    const policy = SandboxPolicySchema.parse({
      maxActivePerUser: 2,
      maxActiveTotal: 2,
    });
    const managers = stores.map((store) => new SandboxCapacity(store, policy));
    try {
      await stores[0]!.pool.query(
        (await readFile("migrations/001_initial.sql", "utf8")) +
          (await readFile("migrations/002_sandbox_leases.sql", "utf8")) +
          (await readFile("migrations/003_runs_sessions_events.sql", "utf8")),
      );
      const results = await Promise.allSettled(
        workspaces.map((w, i) =>
          managers[i % 2]!.reserve(tenants[i]!, w, "op-" + i, undefined),
        ),
      );
      const successes = results.flatMap((r, i) =>
        r.status === "fulfilled" ? [i] : [],
      );
      assert.equal(successes.length, 2);
      for (const result of results)
        if (result.status === "rejected")
          assert.equal(result.reason.code, "GLOBAL_SANDBOX_LIMIT");
      for (const i of successes)
        await managers[i % 2]!.active(
          tenants[i]!,
          workspaces[i]!.id,
          "op-" + i,
          "box-" + i,
        );
      await assert.rejects(
        stores[0]!.capacityTx((s) => {
          s.entries = {};
          throw new Error("rollback");
        }),
        /rollback/,
      );
      assert.equal(
        (
          await managers[1]!.usage({
            tenantId: tenants[0]!,
            userId: "user",
            admin: true,
          })
        ).global.active,
        2,
      );
      const restarted = new PostgresStore(url!);
      try {
        const capacity = new SandboxCapacity(restarted, policy);
        assert.equal(
          (
            await capacity.usage({
              tenantId: tenants[0]!,
              userId: "user",
              admin: true,
            })
          ).global.active,
          2,
        );
        const released = successes[0]!;
        await capacity.paused(
          tenants[released]!,
          workspaces[released]!.id,
          "op-" + released,
        );
        const next = results.findIndex((r) => r.status === "rejected");
        await capacity.reserve(
          tenants[next]!,
          workspaces[next]!,
          "resumed",
          undefined,
        );
        assert.equal(
          (
            await capacity.usage({
              tenantId: tenants[next]!,
              userId: "user",
              admin: true,
            })
          ).global.active,
          2,
        );
        await assert.rejects(
          capacity.reserve(
            tenants[released]!,
            { ...workspaces[released]!, sandboxId: "box-" + released },
            "resume",
            await capacity.inspect(
              tenants[released]!,
              workspaces[released]!.id,
            ),
          ),
          { code: "GLOBAL_SANDBOX_LIMIT" },
        );
      } finally {
        await restarted.close();
      }
    } finally {
      await stores[0]!
        .capacityTx((s) => {
          for (const [key, entry] of Object.entries(s.entries))
            if (tenants.includes(entry.tenantId)) delete s.entries[key];
        })
        .catch(() => {});
      await Promise.all(stores.map((s) => s.close()));
    }
  },
);

test(
  "PostgreSQL reads preserve revisions, overlap, and see committed snapshots without waiting for a writer lock",
  { skip: !url },
  async () => {
    const store = new PostgresStore(url!);
    const tenant = "read-" + id();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const writer = await store.pool.connect();
    try {
      await store.pool.query(
        (await readFile("migrations/001_initial.sql", "utf8")) +
          (await readFile("migrations/002_sandbox_leases.sql", "utf8")) +
          (await readFile("migrations/003_runs_sessions_events.sql", "utf8")),
      );
      await store.tx(tenant, (s) => {
        s.sequence = 7;
      });
      const revision = async () =>
        Number(
          (
            await store.pool.query(
              "SELECT revision FROM harness_tenants WHERE tenant_id=$1",
              [tenant],
            )
          ).rows[0].revision,
        );
      const before = await revision();
      await writer.query("BEGIN");
      await writer.query(
        "SELECT state FROM harness_tenants WHERE tenant_id=$1 FOR UPDATE",
        [tenant],
      );
      let entered = 0;
      const reads = [1, 2].map(() =>
        store.read(tenant, async (s) => {
          entered++;
          assert.equal(s.sequence, 7);
          await gate;
          s.sequence = 999;
          return s.sequence;
        }),
      );
      const deadline = Date.now() + 1000;
      while (entered < 2 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 5));
      assert.equal(
        entered,
        2,
        "readers must not wait on the writer row lock or each other",
      );
      release();
      await Promise.all(reads);
      assert.equal(await revision(), before);
      assert.equal(await store.read(tenant, (s) => s.sequence), 7);
      const missing = tenant + "-absent";
      await store.read(missing, (s) => {
        s.sequence = 100;
      });
      assert.equal(
        (
          await store.pool.query(
            "SELECT tenant_id FROM harness_tenants WHERE tenant_id=$1",
            [missing],
          )
        ).rowCount,
        0,
      );
    } finally {
      release();
      await writer.query("ROLLBACK");
      writer.release();
      await store.pool.query("DELETE FROM harness_tenants WHERE tenant_id=$1", [
        tenant,
      ]);
      await store.close();
    }
  },
);

test(
  "PostgreSQL independent workers never claim the same Run twice",
  { skip: !url },
  async () => {
    const { Worker } = await import("../src/worker.js");
    const { SandboxManager, DemoSandbox } = await import(
      "../src/adapters/sandbox.js"
    );
    const { MCPManager } = await import("../src/adapters/mcp.js");
    const stores = [new PostgresStore(url!), new PostgresStore(url!)];
    const actor = { tenantId: "worker-" + id(), userId: "user", admin: true };
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let executions = 0;
    const services = stores.map(
      (store) => new HarnessService(store, [], ["default"]),
    );
    const workers = services.map(
      (service) =>
        new Worker(
          service,
          {
            execute: async (ctx) => {
              executions++;
              ctx.signal.addEventListener("abort", release, { once: true });
              await gate;
            },
          },
          new SandboxManager(service.store, new DemoSandbox()),
          new MCPManager(service.store, {}),
          1,
        ),
    );
    try {
      await stores[0]!.pool.query(
        (await readFile("migrations/001_initial.sql", "utf8")) +
          (await readFile("migrations/002_sandbox_leases.sql", "utf8")) +
          (await readFile("migrations/003_runs_sessions_events.sql", "utf8")),
      );
      const agent = await services[0]!.publish(
        actor,
        AgentConfig.parse({
          name: "worker",
          systemPrompt: "probe",
          model: { provider: "demo", modelId: "demo" },
          skillBundle: "default",
          tools: [],
        }),
      );
      const workspace = await services[0]!.createWorkspace(actor, "worker");
      const session = await services[0]!.createSession(
        actor,
        workspace.id,
        agent.id,
      );
      const r = await services[0]!.submit(actor, session.id, "race");
      await Promise.all(
        workers.flatMap((worker) => [worker.tick(), worker.tick()]),
      );
      const deadline = Date.now() + 1000;
      while (executions < 1 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 5));
      assert.equal(executions, 1);
      assert.equal(
        await stores[0]!.read(
          actor.tenantId,
          (s) =>
            s.events.filter((e) => e.runId === r.id && e.type === "run.started")
              .length,
        ),
        1,
      );
    } finally {
      release();
      await Promise.all(workers.map((w) => w.stop()));
      await stores[0]!.pool.query(
        "DELETE FROM harness_tenants WHERE tenant_id=$1",
        [actor.tenantId],
      );
      await Promise.all(stores.map((s) => s.close()));
    }
  },
);

test(
  "PostgreSQL fencing atomically elects takeover and rejects stale capacity transitions",
  { skip: !url },
  async () => {
    const stores = [new PostgresStore(url!), new PostgresStore(url!)];
    const tenant = "fence-" + id(),
      wid = id();
    const w = {
      id: wid,
      ownerId: "user",
      name: "fence",
      members: { user: "owner" as const },
    };
    const managers = stores.map(
      (s) =>
        new SandboxCapacity(
          s,
          SandboxPolicySchema.parse({
            maxActivePerUser: 1,
            maxActiveTotal: 100,
          }),
        ),
    );
    try {
      await stores[0]!.pool.query(
        (await readFile("migrations/001_initial.sql", "utf8")) +
          (await readFile("migrations/002_sandbox_leases.sql", "utf8")) +
          (await readFile("migrations/003_runs_sessions_events.sql", "utf8")),
      );
      await managers[0]!.reserve(tenant, w, "A", undefined);
      await managers[0]!.active(tenant, wid, "A", "sid-A");
      const old = (await managers[0]!.get(tenant, wid))!;
      const claims = await Promise.allSettled(
        managers.map((m, i) => m.claim(tenant, wid, old, "B" + i)),
      );
      assert.equal(claims.filter((c) => c.status === "fulfilled").length, 1);
      const winner = claims.findIndex((c) => c.status === "fulfilled"),
        token = "B" + winner;
      const manager = managers[winner]!;
      await manager.pending(tenant, wid, token, "sid-B");
      await manager.active(tenant, wid, token, "sid-B");
      const before = await manager.get(tenant, wid);
      const stale = await Promise.all([
        managers[0]!.released(tenant, wid, "A"),
        managers[1]!.unknown(tenant, wid, "A", "sid-A"),
        managers[0]!.paused(tenant, wid, "A"),
      ]);
      assert.deepEqual(stale, [false, false, false]);
      assert.deepEqual(await managers[1]!.get(tenant, wid), before);
      await assert.rejects(managers[0]!.active(tenant, wid, "A", "sid-A"), {
        code: "CAPACITY_LEASE_LOST",
      });
      await assert.rejects(
        managers[1]!.reserve(
          tenant,
          { ...w, sandboxId: "sid-A" },
          "late-A",
          old,
        ),
        { code: "CAPACITY_LEASE_LOST" },
      );
      await manager.unknown(tenant, wid, token, "sid-B");
      assert.equal((await manager.get(tenant, wid))!.sandboxId, "sid-B");
      assert.equal(
        (await manager.usage({ tenantId: tenant, userId: "user", admin: true }))
          .user.active,
        1,
      );
    } finally {
      await stores[0]!.capacityTx((s) => {
        for (const [k, e] of Object.entries(s.entries))
          if (e.tenantId === tenant) delete s.entries[k];
      });
      await Promise.all(stores.map((s) => s.close()));
    }
  },
);

test(
  "PostgreSQL per-Run transactions overlap without tenant rewrites and reject stale lease owners",
  { skip: !url },
  async () => {
    const stores = [new PostgresStore(url!), new PostgresStore(url!)];
    const actor = { tenantId: "row-" + id(), userId: "user", admin: true };
    let release!: () => void;
    try {
      await stores[0]!.pool.query(
        (await readFile("migrations/001_initial.sql", "utf8")) +
          (await readFile("migrations/002_sandbox_leases.sql", "utf8")) +
          (await readFile("migrations/003_runs_sessions_events.sql", "utf8")),
      );
      const service = new HarnessService(stores[0]!, [], ["default"]);
      const av = await service.publish(
        actor,
        AgentConfig.parse({
          name: "run",
          systemPrompt: "test",
          model: { provider: "demo", modelId: "demo" },
          tools: [],
          skillBundle: "default",
        }),
      );
      const w = await service.createWorkspace(actor, "rows");
      const sessions = await Promise.all(
        [0, 1].map(() => service.createSession(actor, w.id, av.id)),
      );
      const runs = await Promise.all(
        sessions.map((s) => service.submit(actor, s.id, "test")),
      );
      await stores[0]!.tx(actor.tenantId, (s) => {
        for (const r of runs)
          s.runs[r.id]!.lease = { owner: "owner", expires: Date.now() + 60000 };
      });
      const revision = (
        await stores[0]!.pool.query(
          "SELECT revision FROM harness_tenants WHERE tenant_id=$1",
          [actor.tenantId],
        )
      ).rows[0].revision;
      const gate = new Promise<void>((r) => (release = r));
      let entered = false;
      const first = stores[0]!.runTx(actor.tenantId, runs[0]!.id, async (s) => {
        entered = true;
        await gate;
        s.runs[runs[0]!.id]!.lease!.expires = Date.now() + 90000;
      });
      for (let i = 0; i < 100 && !entered; i++)
        await new Promise<void>((r) => setTimeout(r, 5));
      assert.ok(entered);
      await stores[1]!.runTx(actor.tenantId, runs[1]!.id, (s) => {
        s.runs[runs[1]!.id]!.lease!.expires = Date.now() + 90000;
      });
      release();
      await first;
      assert.equal(
        (
          await stores[0]!.pool.query(
            "SELECT revision FROM harness_tenants WHERE tenant_id=$1",
            [actor.tenantId],
          )
        ).rows[0].revision,
        revision,
      );
      await stores[1]!.runTx(actor.tenantId, runs[0]!.id, (s) => {
        s.runs[runs[0]!.id]!.lease = {
          owner: "new",
          expires: Date.now() + 60000,
        };
      });
      await assert.rejects(
        stores[0]!.runTx(actor.tenantId, runs[0]!.id, (s) => {
          if (s.runs[runs[0]!.id]!.lease?.owner !== "owner")
            throw new Error("LEASE_LOST");
        }),
        /LEASE_LOST/,
      );
    } finally {
      release?.();
      await stores[0]!.pool.query(
        "DELETE FROM harness_tenants WHERE tenant_id=$1",
        [actor.tenantId],
      );
      await Promise.all(stores.map((s) => s.close()));
    }
  },
);

test(
  "PostgreSQL historical sessions/runs/events migrate byte-for-byte with stable event IDs",
  { skip: !url },
  async () => {
    const control = new PostgresStore(url!);
    const schema = "run_migrate_" + id().replaceAll("-", "");
    await control.pool.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const store = new PostgresStore(scoped.toString());
    try {
      await store.pool.query(
        await readFile("migrations/001_initial.sql", "utf8"),
      );
      const { emptyState, event } = await import("../src/domain.js");
      const state = emptyState();
      const actor = { tenantId: "old", userId: "u", admin: true };
      state.sessions.s = {
        id: "s",
        workspaceId: "w",
        agentVersionId: "a",
        entries: [{ history: "retained" }],
        createdAt: new Date().toISOString(),
      };
      state.runs.r = {
        id: "r",
        sessionId: "s",
        actor,
        prompt: "persisted",
        state: "FAILED",
        requestDigest: "hash",
        createdAt: new Date().toISOString(),
        depth: 0,
        steps: 0,
        lease: { owner: "lost", expires: 10 },
      };
      event(state, state.runs.r, "run.failed", {
        code: "WORKER_LOST_UNKNOWN_TOOL_OUTCOME",
      });
      await store.pool.query(
        "INSERT INTO harness_tenants(tenant_id,state) VALUES($1,$2)",
        ["old", JSON.stringify(state)],
      );
      const migration = await readFile(
        "migrations/003_runs_sessions_events.sql",
        "utf8",
      );
      await store.pool.query(migration);
      assert.deepEqual(await store.read("old", (s) => s), state);
      await store.pool.query(migration);
      assert.deepEqual(await store.read("old", (s) => s), state);
      await store.runTx("old", "r", (s) => event(s, s.runs.r!, "test.next"));
      assert.deepEqual(
        (await store.read("old", (s) => s.events)).map((e) => e.eventId),
        [1, 2],
      );
    } finally {
      await store.close();
      await control.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await control.close();
    }
  },
);

test(
  "PostgreSQL capacity migration verifies every state and does not resurrect released generations",
  { skip: !url },
  async () => {
    const adminStore = new PostgresStore(url!);
    const schema = "capacity_migrate_" + id().replaceAll("-", "");
    await adminStore.pool.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const store = new PostgresStore(scoped.toString());
    try {
      await store.pool.query(
        await readFile("migrations/001_initial.sql", "utf8"),
      );
      const entries = Object.fromEntries(
        ["reserved", "active", "paused", "unknown", "released"].map(
          (state, i) => [
            JSON.stringify(["tenant", "w" + i]),
            {
              tenantId: "tenant",
              workspaceId: "w" + i,
              userId: "user",
              state,
              operation: "op" + i,
              updatedAt: 10,
              sandboxId: "box" + i,
            },
          ],
        ),
      );
      await store.pool.query(
        "INSERT INTO harness_sandbox_capacity VALUES(1,$1)",
        [JSON.stringify({ entries })],
      );
      const migration = await readFile(
        "migrations/002_sandbox_leases.sql",
        "utf8",
      );
      await store.pool.query(migration);
      assert.deepEqual(await store.capacityRead((s) => s.entries), entries);
      const capacity = new SandboxCapacity(
        store,
        SandboxPolicySchema.parse({ maxActiveTotal: 3, maxActivePerUser: 3 }),
      );
      assert.equal(
        (
          await capacity.usage({
            tenantId: "tenant",
            userId: "user",
            admin: true,
          })
        ).global.active,
        3,
      );
      await capacity.released("tenant", "w0", "op0");
      await store.pool.query(migration);
      assert.equal((await capacity.inspect("tenant", "w0"))?.state, "released");
      await assert.rejects(capacity.active("tenant", "w0", "stale", "new"), {
        code: "CAPACITY_LEASE_LOST",
      });
      const changed = await store.pool.query(
        "SELECT xmin::text FROM harness_sandbox_leases WHERE workspace_id=$1",
        ["w1"],
      );
      await capacity.unknown("tenant", "w3", "op3");
      assert.equal(
        (
          await store.pool.query(
            "SELECT xmin::text FROM harness_sandbox_leases WHERE workspace_id=$1",
            ["w1"],
          )
        ).rows[0].xmin,
        changed.rows[0].xmin,
        "unrelated capacity rows must not be rewritten",
      );
    } finally {
      await store.close();
      await adminStore.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminStore.close();
    }
  },
);

test(
  "PostgreSQL event pages are indexed, notifications are hints, and abort cleans subscription",
  { skip: !url },
  async () => {
    const store = new PostgresStore(url!),
      other = new PostgresStore(url!);
    const actor = { tenantId: "stream-" + id(), userId: "u", admin: true };
    try {
      await store.pool.query(
        (await readFile("migrations/001_initial.sql", "utf8")) +
          (await readFile("migrations/003_runs_sessions_events.sql", "utf8")),
      );
      const service = new HarnessService(store, [], ["default"]),
        av = await service.publish(
          actor,
          AgentConfig.parse({
            name: "events",
            systemPrompt: "test",
            model: { provider: "demo", modelId: "demo" },
            tools: [],
            skillBundle: "default",
          }),
        ),
        w = await service.createWorkspace(actor, "stream"),
        ses = await service.createSession(actor, w.id, av.id),
        r = await service.submit(actor, ses.id, "stream");
      const { event } = await import("../src/domain.js");
      const waiting = store.waitForEvents(actor.tenantId, r.id, 1000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await other.runTx(actor.tenantId, r.id, (s) => {
        for (let i = 0; i < 155; i++)
          event(s, s.runs[r.id]!, "test.delta", { delta: String(i) });
      });
      await waiting;
      const page = await store.eventPage(
        actor.tenantId,
        r.id,
        1,
        100,
        (s) => s.runs[r.id]!.state,
      );
      assert.equal(page.events.length, 100);
      assert.equal(page.events[0]?.eventId, 2);
      const next = await store.eventPage(
        actor.tenantId,
        r.id,
        101,
        100,
        (s) => s.runs[r.id]!.state,
      );
      assert.equal(next.events.length, 55);
      assert.equal(next.events.at(-1)?.eventId, 156);
      // Polling after a missed notification remains authoritative.
      const abort = new AbortController(),
        wait = store.waitForEvents(actor.tenantId, r.id, 10000, abort.signal);
      abort.abort();
      await wait;
      await assert.rejects(
        store.eventPage("foreign", r.id, 0, 100, (s) => {
          if (!s.runs[r.id]) throw new Error("hidden");
          return s.runs[r.id]!.state;
        }),
        /hidden/,
      );
    } finally {
      await store.pool.query("DELETE FROM harness_tenants WHERE tenant_id=$1", [
        actor.tenantId,
      ]);
      await Promise.all([store.close(), other.close()]);
    }
  },
);
