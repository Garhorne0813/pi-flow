import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { HarnessService } from "../src/service.js";
import { AgentConfig } from "../src/domain.js";
import { Worker } from "../src/worker.js";
import { SandboxManager, DemoSandbox } from "../src/adapters/sandbox.js";
import { MCPManager } from "../src/adapters/mcp.js";

async function until(fn: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  assert.fail("Expected state did not settle");
}
async function setup() {
  const store = new MemoryStore();
  const service = new HarnessService(store, [], ["default"]);
  const actors = ["a", "b"].map((tenantId) => ({
    tenantId,
    userId: "user",
    admin: true,
  }));
  const runs: { id: string; tenant: string }[] = [];
  for (const actor of actors) {
    const agent = await service.publish(
      actor,
      AgentConfig.parse({
        name: "probe",
        systemPrompt: "test",
        model: { provider: "demo", modelId: "demo" },
        tools: [],
        skillBundle: "default",
      }),
    );
    const w = await service.createWorkspace(actor, "probe");
    for (let i = 0; i < 5; i++) {
      const session = await service.createSession(actor, w.id, agent.id);
      const run = await service.submit(actor, session.id, actor.tenantId + i);
      runs.push({ id: run.id, tenant: actor.tenantId });
    }
  }
  const started: string[] = [];
  const releases: (() => void)[] = [];
  const makeWorker = () =>
    new Worker(
      service,
      {
        execute: async (ctx) => {
          started.push(ctx.prompt);
          await new Promise<void>((r) => {
            releases.push(r);
            ctx.signal.addEventListener("abort", () => r(), { once: true });
          });
        },
      },
      new SandboxManager(store, new DemoSandbox()),
      new MCPManager(store, {}),
      1,
    );
  return { store, runs, started, releases, makeWorker };
}

test("round-robin across ticks schedules both continuously queued tenants at concurrency=1", async () => {
  const f = await setup();
  const worker = f.makeWorker();
  try {
    for (let i = 0; i < 6; i++) {
      await worker.tick();
      await until(() => f.started.length === i + 1);
      assert.equal(f.started[i], (i % 2 ? "b" : "a") + Math.floor(i / 2));
      f.releases[i]!();
      const target = f.runs.filter((r) => r.tenant === (i % 2 ? "b" : "a"))[
        Math.floor(i / 2)
      ]!;
      await until(() =>
        f.store.read(
          target.tenant,
          (s) =>
            s.runs[target.id]!.state === "COMPLETED" &&
            !s.runs[target.id]!.lease,
        ),
      );
      await new Promise<void>((r) => setImmediate(r));
    }
  } finally {
    await worker.stop();
  }
});

test("concurrent ticks and multiple workers claim each queued Run once", async () => {
  const f = await setup();
  // Keep a single Run, so both workers and overlapping ticks contend for it.
  for (const tenant of ["a", "b"])
    await f.store.tx(tenant, (s) => {
      for (const r of Object.values(s.runs))
        if (r.id !== f.runs[0]!.id) r.state = "CANCELLED";
    });
  const workers = [f.makeWorker(), f.makeWorker()];
  try {
    await Promise.all([
      workers[0]!.tick(),
      workers[0]!.tick(),
      workers[1]!.tick(),
    ]);
    await until(() => f.started.length === 1);
    assert.deepEqual(f.started, ["a0"]);
    assert.equal(
      await f.store.read(
        "a",
        (s) => s.events.filter((e) => e.type === "run.started").length,
      ),
      1,
    );
    f.releases[0]!();
  } finally {
    for (const release of f.releases) release();
    await Promise.all(workers.map((w) => w.stop()));
  }
});
