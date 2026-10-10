import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildAPI } from "../src/api.js";
import { MemoryStore, PostgresStore } from "../src/store.js";
import { HarnessService } from "../src/service.js";
import { DemoSandbox, SandboxManager } from "../src/adapters/sandbox.js";
import { MCPManager } from "../src/adapters/mcp.js";
import { Worker } from "../src/worker.js";
import { DemoRuntime } from "../src/runtime.js";
const admin = { tenantId: "health", userId: "admin", admin: true };
function api(store: MemoryStore | PostgresStore) {
  const service = new HarnessService(store, [], ["default"]);
  const sandbox = new SandboxManager(store, new DemoSandbox());
  return {
    app: buildAPI(
      service,
      async (h) => ({ ...admin, admin: h === "Bearer admin" }),
      sandbox,
    ),
    worker: new Worker(
      service,
      new DemoRuntime(),
      sandbox,
      new MCPManager(store, {}),
    ),
  };
}
test("health distinguishes liveness, bounded readiness, and independently stalled workers", async () => {
  const store = new MemoryStore();
  const { app, worker } = api(store);
  try {
    assert.equal((await app.inject("/health/live")).statusCode, 200);
    assert.equal((await app.inject("/health/ready")).statusCode, 200);
    const request = () =>
      app.inject({
        method: "GET",
        url: "/api/v1/admin/health/workers",
        headers: { authorization: "Bearer admin" },
      });
    assert.equal((await request()).statusCode, 503);
    await worker.tick();
    const healthy = await request();
    assert.equal(healthy.statusCode, 200);
    assert.equal(healthy.json().workers[0].workerId, worker.owner);
    await store.workerHeartbeat({
      workerId: worker.owner,
      heartbeatAt: Date.now(),
      lastSuccessfulTick: Date.now() - 30000,
      activeTasks: 0,
      stopping: false,
      maintenance: "failed",
    });
    assert.equal((await request()).statusCode, 503);
    assert.equal(
      (await app.inject("/api/v1/admin/health/workers")).statusCode,
      403,
    );
    store.ready = async () => {
      throw new Error("secret database URL");
    };
    const bad = await app.inject("/health/ready");
    assert.equal(bad.statusCode, 503);
    assert.doesNotMatch(bad.body, /secret/);
    assert.equal((await app.inject("/health")).statusCode, 200);
    store.ready = () => new Promise(() => {});
    const started = Date.now();
    assert.equal((await app.inject("/health/ready")).statusCode, 503);
    assert.ok(Date.now() - started < 2000);
  } finally {
    await app.close();
  }
});
test(
  "PostgreSQL readiness rejects missing migration and schema mismatch",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const store = new PostgresStore(process.env.TEST_DATABASE_URL!);
    try {
      await store.pool.query(
        await readFile("migrations/001_initial.sql", "utf8"),
      );
      await store.ready();
      await store.pool.query(
        "UPDATE harness_schema SET version=999 WHERE id=1",
      );
      await assert.rejects(store.ready(), /SCHEMA_MISMATCH/);
      await store.pool.query("UPDATE harness_schema SET version=1 WHERE id=1");
      await store.workerHeartbeat({
        workerId: "health-test",
        heartbeatAt: Date.now(),
        lastSuccessfulTick: Date.now(),
        activeTasks: 2,
        stopping: false,
        maintenance: "ok",
      });
      assert.equal(
        (await store.workerHealth()).find((w) => w.workerId === "health-test")
          ?.activeTasks,
        2,
      );
    } finally {
      await store.pool.query("UPDATE harness_schema SET version=1 WHERE id=1");
      await store.pool.query(
        "DELETE FROM harness_worker_health WHERE worker_id='health-test'",
      );
      await store.close();
    }
    const absent = new PostgresStore(
      "postgres://harness:test-only@127.0.0.1:1/absent",
    );
    try {
      await assert.rejects(absent.ready());
    } finally {
      await absent.close();
    }
  },
);
