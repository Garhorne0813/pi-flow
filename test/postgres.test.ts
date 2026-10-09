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
const url = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL restart persistence, multi-client serialization and transaction rollback",
  { skip: !url },
  async () => {
    const a: Actor = { tenantId: "pg-" + id(), userId: "test", admin: true };
    const s1 = new PostgresStore(url!),
      s2 = new PostgresStore(url!);
    try {
      await s1.pool.query(await readFile("migrations/001_initial.sql", "utf8"));
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
        await readFile("migrations/001_initial.sql", "utf8"),
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
        await readFile("migrations/001_initial.sql", "utf8"),
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
        await readFile("migrations/001_initial.sql", "utf8"),
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
        await readFile("migrations/001_initial.sql", "utf8"),
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
