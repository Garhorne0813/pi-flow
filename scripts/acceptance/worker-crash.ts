import { fork } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { fixture } from "./fixture.js";
const f = await fixture();
const children = Array.from({ length: 2 }, () =>
  fork(new URL("./worker-child.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    env: process.env,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  }),
);
const messages: { child: number; type: string }[] = [];
children.forEach((child, i) =>
  child.on("message", (m: any) => messages.push({ child: i, type: m.type })),
);
async function until(predicate: () => boolean) {
  const end = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < end, "child operation timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
try {
  await until(() => messages.filter((m) => m.type === "ready").length === 2);
  children.forEach((c) => c.send("tick"));
  await until(
    () =>
      messages.some((m) => m.type === "executing") &&
      messages.filter((m) => m.type === "ticked").length === 2,
  );
  assert.equal(
    messages.filter((m) => m.type === "executing").length,
    1,
    "two processes must not execute the same Run",
  );
  const winner = messages.find((m) => m.type === "executing")!.child;
  const killed = once(children[winner]!, "exit");
  children[winner]!.kill("SIGKILL");
  await killed;
  // Deterministically accelerate the persisted 30-second expiry after the actual process death.
  await f.store.tx(f.actor.tenantId, (s) => {
    s.runs[f.run.id]!.lease!.expires = Date.now() - 1;
  });
  children[1 - winner]!.send("tick");
  await until(() => messages.filter((m) => m.type === "ticked").length === 3);
  const result = await f.store.read(f.actor.tenantId, (s) => ({
    run: s.runs[f.run.id]!,
    entries: s.sessions[f.run.sessionId]!.entries,
    events: s.events.filter((e) => e.runId === f.run.id),
  }));
  assert.equal(result.run.state, "FAILED");
  assert.equal(result.run.error, "WORKER_LOST_UNKNOWN_TOOL_OUTCOME");
  assert.equal(result.run.lease, undefined);
  assert.equal(
    messages.filter((m) => m.type === "executing").length,
    1,
    "unknown execution must never be replayed",
  );
  assert.deepEqual(result.entries, [{ acceptance: "durable-before-crash" }]);
  assert.equal(result.events.filter((e) => e.type === "run.failed").length, 1);
  console.log(
    JSON.stringify({
      tier: "synthetic-runtime-real-postgres",
      status: "passed",
      workers: 2,
      actualSigkill: true,
      expiryAccelerated: true,
      duplicateExecution: false,
      replayedUnknown: false,
      checkpointPersisted: true,
    }),
  );
} finally {
  await Promise.all(
    children.map(async (c) => {
      if (c.exitCode === null && c.signalCode === null) {
        const exited = once(c, "exit");
        c.kill("SIGKILL");
        await exited;
      }
    }),
  );
  await f.close();
}
