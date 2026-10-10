import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { PostgresStore } from "../../src/store.js";
import { buildAPI } from "../../src/api.js";
import { DemoSandbox, SandboxManager } from "../../src/adapters/sandbox.js";
import { UsageLedger, UsagePolicy } from "../../src/usage.js";
import { event, id } from "../../src/domain.js";
import { fixture } from "./fixture.js";

// This scenario owns the CI PostgreSQL service container. Never accept a
// production URL or run it on a shared server: it actually stops the database.
const container = process.env.ACCEPTANCE_PG_CONTAINER;
assert.ok(
  container && /^[a-f0-9]{12,64}$/.test(container),
  "Dedicated CI PostgreSQL container ID required",
);
const exec = promisify(execFile);
const url = new URL(process.env.TEST_DATABASE_URL!);
const db = decodeURIComponent(url.pathname.slice(1));
const user = decodeURIComponent(url.username);
const restoreDB = `restore_${id().replaceAll("-", "")}`;
const archive = `/tmp/${restoreDB}.dump`;
const docker = (...args: string[]) =>
  exec("docker", args, { timeout: 30000, maxBuffer: 1024 * 1024 });
const f = await fixture();
const app = buildAPI(
  f.service,
  async () => f.actor,
  new SandboxManager(f.store, new DemoSandbox()),
);
let base = "";
let stopped = false;
let restore: PostgresStore | undefined;
let control: pg.Client | undefined;
async function untilReady() {
  const end = Date.now() + 20000;
  for (;;) {
    const response = await fetch(base + "/health/ready", {
      signal: AbortSignal.timeout(3000),
    });
    if (response.status === 200) return;
    assert.ok(Date.now() < end, "PostgreSQL did not recover");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
try {
  base = await app.listen({ host: "127.0.0.1", port: 0 });
  await f.store.tx(f.actor.tenantId, (s) => {
    s.runs[f.run.id]!.state = "RUNNING";
    s.runs[f.run.id]!.lease = {
      owner: "recovery-fixture",
      expires: Date.now() + 60000,
    };
    s.sessions[f.run.sessionId]!.entries = [{ checkpoint: "before-backup" }];
    event(s, s.runs[f.run.id]!, "message.delta", { delta: "before-backup" });
  });
  const ledger = new UsageLedger(
    f.store,
    UsagePolicy.parse({ tenantDailyTokens: 5000 }),
  );
  const request = await ledger.reserve(
    f.actor.tenantId,
    f.run.id,
    10,
    "recovery-fixture",
  );
  await ledger.settle(f.actor.tenantId, request.id, undefined, 10);
  const workspaceId = await f.store.read(
    f.actor.tenantId,
    (s) => s.sessions[f.run.sessionId]!.workspaceId,
  );
  const capacityKey = JSON.stringify([f.actor.tenantId, workspaceId]);
  await f.store.capacityTx((s) => {
    s.entries[capacityKey] = {
      tenantId: f.actor.tenantId,
      workspaceId,
      userId: f.actor.userId,
      state: "unknown",
      sandboxId: "synthetic-box",
      operation: id(),
      updatedAt: Date.now(),
    };
  });
  const snapshot = await f.store.read(f.actor.tenantId, (s) => s);
  const capacity = await f.store.capacityRead((s) => s.entries[capacityKey]);
  assert.equal(snapshot.usage!.requests[request.id]!.status, "unknown");
  await docker(
    "exec",
    container,
    "pg_dump",
    "-U",
    user,
    "--format=custom",
    `--dbname=${db}`,
    `--file=${archive}`,
  );

  // A subsequent commit is outside the backup's recovery point.
  await f.store.tx(f.actor.tenantId, (s) => {
    s.sessions[f.run.sessionId]!.entries.push({ checkpoint: "after-backup" });
    event(s, s.runs[f.run.id]!, "message.delta", { delta: "after-backup" });
  });
  const afterBackup = await f.store.read(f.actor.tenantId, (s) => s);
  await docker("stop", "--time", "1", container);
  stopped = true;
  const failureStart = performance.now();
  assert.equal(
    (await fetch(base + "/health/ready", { signal: AbortSignal.timeout(3000) }))
      .status,
    503,
  );
  const outageReadyMs = performance.now() - failureStart;
  assert.ok(outageReadyMs < 2500);
  assert.equal((await fetch(base + "/health/live")).status, 200);
  const recoveryStart = performance.now();
  await docker("start", container);
  stopped = false;
  await untilReady();
  const recoveryMs = performance.now() - recoveryStart;
  assert.deepEqual(await f.store.read(f.actor.tenantId, (s) => s), afterBackup);
  assert.deepEqual(
    await f.store.capacityRead((s) => s.entries[capacityKey]),
    capacity,
  );

  // Restore into an independent database, leaving the source intact.
  control = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await control.connect();
  await control.query(`CREATE DATABASE "${restoreDB}" TEMPLATE template0`);
  await docker(
    "exec",
    container,
    "pg_restore",
    "-U",
    user,
    "--exit-on-error",
    `--dbname=${restoreDB}`,
    archive,
  );
  const restoreURL = new URL(url);
  restoreURL.pathname = `/${restoreDB}`;
  restore = new PostgresStore(restoreURL.toString());
  await restore.ready();
  assert.deepEqual(await restore.read(f.actor.tenantId, (s) => s), snapshot);
  assert.deepEqual(
    await restore.capacityRead((s) => s.entries[capacityKey]),
    capacity,
  );
  assert.equal(
    (await restore.read("foreign-recovery-tenant", (s) => Object.keys(s.runs)))
      .length,
    0,
  );
  console.log(
    JSON.stringify({
      tier: "synthetic-state-real-postgres-http",
      commit: process.env.GITHUB_SHA ?? "local",
      status: "passed",
      actualServerRestart: true,
      outageReadyMs,
      recoveryMs,
      committedStateSurvivedRestart: true,
      dumpRestoreIntoIndependentDatabase: true,
      backupRecoveryPointPreserved: true,
      unknownUsageAndCapacityPreserved: true,
      checkpointEventCursorAndLeasePreserved: true,
      tenantIsolationPreserved: true,
    }),
  );
} finally {
  if (stopped) await docker("start", container);
  if (restore) await restore.close();
  if (control) {
    await control.query(`DROP DATABASE IF EXISTS "${restoreDB}" WITH (FORCE)`);
    await control.end();
  }
  await docker("exec", container, "rm", "-f", archive);
  await app.close();
  await f.store.pool.query(
    "DELETE FROM harness_sandbox_leases WHERE tenant_id=$1",
    [f.actor.tenantId],
  );
  await f.close();
}
