import assert from "node:assert/strict";
import pg from "pg";
import { PostgresStore } from "../../src/store.js";
import { HarnessService } from "../../src/service.js";
import { buildAPI } from "../../src/api.js";
import { DemoSandbox, SandboxManager } from "../../src/adapters/sandbox.js";
import { event, id } from "../../src/domain.js";
import { fixture } from "./fixture.js";

// Dedicated disposable PG only. All backend termination targets belong to this
// script's tagged Store; the schema lock is held briefly on the test database.
const f = await fixture();
const url = new URL(process.env.TEST_DATABASE_URL!);
const tag = `fault-${id()}`;
url.searchParams.set("application_name", tag);
const store = new PostgresStore(url.toString());
const control = new pg.Client({
  connectionString: process.env.TEST_DATABASE_URL,
});
const service = new HarnessService(store, [], ["default"]);
const app = buildAPI(
  service,
  async () => f.actor,
  new SandboxManager(store, new DemoSandbox()),
);
const held: pg.PoolClient[] = [];
let base = "";
const probe = async (url: string) => ({
  statusCode: (await fetch(base + url, { signal: AbortSignal.timeout(3000) }))
    .status,
});
let locked = false;
const report: Record<string, unknown> = {
  tier: "synthetic-state-real-postgres-http",
  commit: process.env.GITHUB_SHA ?? "local",
};
async function readyWithinDeadline(expected: number) {
  const start = performance.now();
  const r = await probe("/health/ready");
  const ms = performance.now() - start;
  assert.equal(r.statusCode, expected);
  assert.ok(ms < 2500, `readiness took ${ms}ms`);
  return ms;
}
async function until(fn: () => Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!(await fn())) {
    assert.ok(Date.now() < end, "database recovery timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
try {
  await control.connect();
  base = await app.listen({ host: "127.0.0.1", port: 0 });
  await readyWithinDeadline(200);

  // Saturate the application's pool without consuming its independent probe pool.
  for (let i = 0; i < 10; i++) held.push(await store.pool.connect());
  let finished = false;
  const queued = store
    .read(f.actor.tenantId, (s) => s.runs[f.run.id]!.state)
    .then((state) => {
      finished = true;
      return state;
    });
  await until(async () => store.pool.waitingCount === 1);
  assert.equal(finished, false);
  report.poolSaturationReadyMs = await readyWithinDeadline(200);
  assert.equal((await probe("/health/live")).statusCode, 200);
  held.pop()!.release();
  assert.equal(await queued, "QUEUED");
  while (held.length) held.pop()!.release();
  report.poolQueueRecovered = true;

  // Deny readiness a schema read, exercising real server-side query blocking.
  await control.query("BEGIN");
  locked = true;
  await control.query("SET LOCAL lock_timeout = '2s'");
  await control.query("LOCK TABLE harness_schema IN ACCESS EXCLUSIVE MODE");
  report.blockedReadyMs = await readyWithinDeadline(503);
  assert.equal((await probe("/health/live")).statusCode, 200);
  await control.query("ROLLBACK");
  locked = false;
  await until(async () => (await probe("/health/ready")).statusCode === 200);
  report.readinessRecovered = true;

  // Kill only a tagged transaction backend after loading state, before commit.
  // Mutations must not become durable, and no callback is automatically retried.
  for (const kind of ["tx", "runTx"] as const) {
    const before = await store.read(f.actor.tenantId, (s) => s);
    let callbacks = 0;
    const mutate = async (s: import("../../src/domain.js").State) => {
      callbacks++;
      s.runs[f.run.id]!.state = "COMPLETED";
      event(s, s.runs[f.run.id]!, "run.completed");
      const backend = await control.query(
        "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'",
        [tag],
      );
      assert.equal(backend.rows.length, 1);
      await control.query("SELECT pg_terminate_backend($1)", [
        backend.rows[0].pid,
      ]);
      // Wait for the client socket to receive the actual server termination.
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    await assert.rejects(
      kind === "tx"
        ? store.tx(f.actor.tenantId, mutate)
        : store.runTx(f.actor.tenantId, f.run.id, mutate),
    );
    assert.equal(callbacks, 1);
    assert.deepEqual(await store.read(f.actor.tenantId, (s) => s), before);
    report[`${kind}RollbackAfterConnectionLoss`] = true;
  }

  // Drop an idle probe socket and then LISTEN. Both pools must replace failed
  // clients; notification loss must leave the persistent event cursor intact.
  const idle = await control.query(
    "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle'",
    [tag],
  );
  assert.ok(idle.rows.length > 0);
  for (const { pid } of idle.rows)
    await control.query("SELECT pg_terminate_backend($1)", [pid]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await until(async () => (await probe("/health/ready")).statusCode === 200);
  const waiting = store.waitForEvents(f.actor.tenantId, f.run.id, 2000);
  let listener: number | undefined;
  await until(async () => {
    const r = await control.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query='LISTEN harness_run_event'",
      [tag],
    );
    listener = r.rows[0]?.pid;
    return listener !== undefined;
  });
  await control.query("SELECT pg_terminate_backend($1)", [listener]);
  await waiting;
  const wakeStart = performance.now();
  const recoveredWait = store.waitForEvents(f.actor.tenantId, f.run.id, 2000);
  await until(async () => {
    const r = await control.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query='LISTEN harness_run_event'",
      [tag],
    );
    return r.rows.some((row) => row.pid !== listener);
  });
  const expected = await store.runTx(f.actor.tenantId, f.run.id, (s) => {
    event(s, s.runs[f.run.id]!, "message.delta", {
      delta: "durable after disconnect",
    });
    return s.sequence;
  });
  const page = await store.eventPage(
    f.actor.tenantId,
    f.run.id,
    0,
    100,
    (s) => s.runs[f.run.id]!.state,
  );
  assert.equal(page.events.at(-1)!.eventId, expected);
  assert.equal(page.events.at(-1)!.data?.delta, "durable after disconnect");
  assert.equal(
    new Set(page.events.map((e) => e.eventId)).size,
    page.events.length,
  );
  await recoveredWait;
  assert.ok(
    performance.now() - wakeStart < 1500,
    "notification must wake recovered listener before fallback",
  );
  report.listenerReconnected = true;
  report.durableReplayAfterNotificationLoss = true;
  report.status = "passed";
  console.log(JSON.stringify(report));
} finally {
  while (held.length) held.pop()!.release();
  if (locked) await control.query("ROLLBACK");
  await app.close();
  await store.close();
  await control.end();
  await f.close();
}
