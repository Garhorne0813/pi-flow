import test from "node:test";
import assert from "node:assert/strict";
import {
  telemetry,
  traceContext,
  withContext,
  currentTraceparent,
} from "../src/telemetry.js";
import { MemoryStore } from "../src/store.js";
import { HarnessService } from "../src/service.js";
import { DemoSandbox, SandboxManager } from "../src/adapters/sandbox.js";
import { MCPManager } from "../src/adapters/mcp.js";
import { Worker } from "../src/worker.js";
import { AgentConfig } from "../src/domain.js";
test("worker task, maintenance and database errors are correlated without sensitive output", async () => {
  const logs: Record<string, unknown>[] = [];
  const old = telemetry.sink;
  telemetry.sink = (record) => logs.push(record);
  const store = new MemoryStore(),
    service = new HarnessService(store, [], ["default"]),
    sandbox = new SandboxManager(store, new DemoSandbox());
  const actor = { tenantId: "trace", userId: "admin", admin: true };
  const agent = await service.publish(
    actor,
    AgentConfig.parse({
      name: "test",
      systemPrompt: "secret prompt",
      model: { provider: "demo", modelId: "demo" },
      tools: [],
      skillBundle: "default",
    }),
  );
  const w = await service.createWorkspace(actor, "trace"),
    ses = await service.createSession(actor, w.id, agent.id);
  const parent = "00-12345678901234567890123456789012-1234567890123456-01";
  const run = await service.submit(
    actor,
    ses.id,
    "secret tool args",
    undefined,
    "request-test",
    parent,
  );
  sandbox.sweepIfDue = async () => {
    throw new Error("Authorization: Bearer secret-credential");
  };
  const worker = new Worker(
    service,
    {
      execute: async () => {
        assert.match(currentTraceparent()!, /12345678901234567890123456789012/);
        throw new Error("model key and sensitive output");
      },
    },
    sandbox,
    new MCPManager(store, {}),
  );
  try {
    await worker.tick();
    for (let i = 0; i < 100; i++) {
      if (
        await store.read(
          "trace",
          (s) => s.runs[run.id]?.state === "FAILED" && !s.runs[run.id]?.lease,
        )
      )
        break;
      await new Promise<void>((r) => setImmediate(r));
    }
    await worker.stop();
    assert.ok(
      logs.some(
        (l) => l.operation === "maintenance" && l.workerId === worker.owner,
      ),
    );
    assert.ok(
      logs.some(
        (l) =>
          l.operation === "run_execute" &&
          l.runId === run.id &&
          l.traceId === "12345678901234567890123456789012",
      ),
    );
    store.tenants = async () => {
      throw new Error("postgres://secret:password");
    };
    const another = new Worker(
      service,
      { execute: async () => {} },
      sandbox,
      new MCPManager(store, {}),
    );
    await assert.rejects(another.tick());
    await new Promise<void>((r) => setImmediate(r));
    assert.ok(
      logs.some(
        (l) => l.operation === "worker_tick" && l.workerId === another.owner,
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(logs),
      /secret|password|Bearer|model key/,
    );
    assert.ok(telemetry.snapshot().maintenance_errors_total! >= 1);
  } finally {
    telemetry.sink = old;
  }
});
test("trace context is isolated between concurrent operations", async () => {
  const a = traceContext(),
    b = traceContext();
  const result = await Promise.all(
    [a, b].map((c) =>
      withContext(c, async () => {
        await new Promise<void>((r) => setImmediate(r));
        return currentTraceparent();
      }),
    ),
  );
  assert.notEqual(result[0], result[1]);
  assert.equal(currentTraceparent(), undefined);
});
