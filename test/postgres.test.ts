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
          managers[i % 2]!.reserve(tenants[i]!, w, "op-" + i),
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
        await capacity.paused(tenants[released]!, workspaces[released]!.id);
        const next = results.findIndex((r) => r.status === "rejected");
        await capacity.reserve(tenants[next]!, workspaces[next]!, "resumed");
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
          capacity.reserve(tenants[released]!, workspaces[released]!, "resume"),
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
