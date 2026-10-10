import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, PostgresStore, type Store } from "../src/store.js";
import { HarnessService } from "../src/service.js";
import { AgentConfig, id } from "../src/domain.js";
import { UsageLedger, UsagePolicy, usageReport } from "../src/usage.js";
import { readFile } from "node:fs/promises";
async function setup(store: Store) {
  const actor = { tenantId: "usage-" + id(), userId: "owner", admin: true },
    service = new HarnessService(store, [], ["default"]);
  const av = await service.publish(
      actor,
      AgentConfig.parse({
        name: "usage",
        systemPrompt: "private",
        model: { provider: "gateway", modelId: "model" },
        tools: [],
        skillBundle: "default",
        maxTokens: 1000,
      }),
    ),
    w = await service.createWorkspace(actor, "usage"),
    runs = [];
  for (let i = 0; i < 3; i++) {
    const s = await service.createSession(actor, w.id, av.id);
    runs.push(await service.submit(actor, s.id, "private"));
  }
  await store.tx(actor.tenantId, (s) => {
    for (const r of runs)
      s.runs[r.id]!.lease = { owner: "worker", expires: Date.now() + 60000 };
  });
  return { actor, runs, w };
}
test("persistent model reservations constrain concurrent daily budgets and missing usage remains charged", async () => {
  const store = new MemoryStore(),
    f = await setup(store),
    policy = UsagePolicy.parse({
      tenantDailyTokens: 1500,
      userDailyTokens: 1500,
    }),
    ledger = new UsageLedger(store, policy);
  const result = await Promise.all(
    f.runs
      .slice(0, 2)
      .map((r) => ledger.reserve(f.actor.tenantId, r.id, 100, "worker")),
  );
  assert.equal(
    result.reduce((s, r) => s + r.maxOutputTokens + 100, 0),
    1500,
  );
  await assert.rejects(
    ledger.reserve(f.actor.tenantId, f.runs[2]!.id, 1, "worker"),
    { code: "MODEL_BUDGET_EXCEEDED" },
  );
  await ledger.settle(f.actor.tenantId, result[0]!.id, undefined, 10);
  await assert.rejects(
    ledger.reserve(f.actor.tenantId, f.runs[2]!.id, 1, "worker"),
    { code: "MODEL_BUDGET_EXCEEDED" },
  );
  await ledger.settle(
    f.actor.tenantId,
    result[1]!.id,
    { input: 50, output: 20, cacheRead: 10, cacheWrite: 0, totalTokens: 80 },
    25,
  );
  const next = await ledger.reserve(
    f.actor.tenantId,
    f.runs[2]!.id,
    1,
    "worker",
  );
  assert.ok(next.maxOutputTokens > 0);
  const report = await store.read(f.actor.tenantId, (s) =>
    usageReport(s, policy),
  );
  assert.equal(
    report.records.find((r) => r.id === result[0]!.id)?.status,
    "unknown",
  );
  assert.equal(report.costMicros, null);
});
test("server pricing snapshots, cost caps, malformed usage and resource transitions are explicit estimates", async () => {
  const store = new MemoryStore(),
    f = await setup(store),
    policy = UsagePolicy.parse({
      tenantDailyCostMicros: 250,
      prices: { "gateway/model": { version: "v1", input: 1, output: 2 } },
    }),
    ledger = new UsageLedger(store, policy);
  const r = await ledger.reserve(
    f.actor.tenantId,
    f.runs[0]!.id,
    100,
    "worker",
  );
  assert.equal(r.maxOutputTokens, 75);
  await assert.rejects(
    ledger.reserve(f.actor.tenantId, f.runs[1]!.id, 10, "worker"),
    { code: "MODEL_COST_BUDGET_EXCEEDED" },
  );
  await ledger.settle(
    f.actor.tenantId,
    r.id,
    { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    1,
  );
  assert.equal(
    await store.read(f.actor.tenantId, (s) => s.usage!.requests[r.id]!.status),
    "unknown",
  );
  policy.prices["gateway/model"]!.version = "new";
  policy.prices["gateway/model"]!.output = 99;
  await ledger.settle(
    f.actor.tenantId,
    r.id,
    { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
    1,
  );
  assert.equal(
    await store.read(
      f.actor.tenantId,
      (s) => s.usage!.requests[r.id]!.costMicros,
    ),
    30,
  );
  await store.tx(f.actor.tenantId, (s) => {
    s.workspaces[f.w.id]!.sandboxId = "box";
    s.workspaces[f.w.id]!.sandboxState = "active";
  });
  await store.tx(f.actor.tenantId, (s) => {
    s.workspaces[f.w.id]!.sandboxState = "unknown";
  });
  await store.tx(f.actor.tenantId, (s) => {
    s.usage!.resources[0]!.at -= 1000;
  });
  const report = await store.read(f.actor.tenantId, (s) =>
    usageReport(s, policy),
  );
  assert.equal(report.sandbox.observedCreates, 1);
  assert.ok(report.sandbox.activeMs >= 1000);
  assert.equal(report.records[0]?.pricingVersion, "v1");
  assert.equal(
    (await store.read("foreign", (s) => usageReport(s, policy))).records.length,
    0,
  );
});
test(
  "PostgreSQL independent ledger clients enforce a shared persisted budget",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const a = new PostgresStore(process.env.TEST_DATABASE_URL!),
      b = new PostgresStore(process.env.TEST_DATABASE_URL!);
    let tenant: string | undefined;
    try {
      await a.pool.query(await readFile("migrations/001_initial.sql", "utf8"));
      const f = await setup(a);
      tenant = f.actor.tenantId;
      const policy = UsagePolicy.parse({ tenantDailyTokens: 1000 }),
        la = new UsageLedger(a, policy),
        lb = new UsageLedger(b, policy);
      const result = await Promise.allSettled([
        la.reserve(tenant, f.runs[0]!.id, 100, "worker"),
        lb.reserve(tenant, f.runs[1]!.id, 100, "worker"),
      ]);
      assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        (await b.read(tenant, (s) => usageReport(s, policy))).tokens,
        1000,
      );
    } finally {
      if (tenant)
        await a.pool.query("DELETE FROM harness_tenants WHERE tenant_id=$1", [
          tenant,
        ]);
      await a.close();
      await b.close();
    }
  },
);
