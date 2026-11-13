import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import pg from "pg";
const source = process.env.TEST_DATABASE_URL;
if (!source)
  throw Error("TEST_DATABASE_URL required: use a disposable database");
const control = new pg.Pool({ connectionString: source }),
  schema = "eval_smoke_" + randomUUID().replaceAll("-", "");
await control.query(`CREATE SCHEMA ${schema}`);
const url = new URL(source);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = new pg.Pool({ connectionString: url.toString() }),
  children = [],
  token = randomUUID(),
  base = "http://127.0.0.1:18084";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  HARNESS_MODE: "demo",
  SANDBOX_PROVIDER: "demo",
  DEV_TOKEN: token,
  HOST: "127.0.0.1",
  PORT: "18084",
  EVALS_ENABLED: "true",
  EVAL_WORKER_ENABLED: "true",
  EVAL_JUDGE_ENABLED: "false",
  LOG_LEVEL: "silent",
  CONFIG_DIR: "/nonexistent/pi-flow-optional-import",
};
function start(file) {
  const child = spawn(process.execPath, [file], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  children.push(child);
  return child;
}
async function api(path, body, headers = {}) {
  const r = await fetch(base + "/api/v1/evals" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  assert.ok(
    r.ok,
    `HTTP ${r.status}: ${await (r.ok ? Promise.resolve("") : r.text())}`,
  );
  return r.json();
}
try {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const name of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await c.query(await readFile("migrations/" + name, "utf8"));
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  start("dist/main.js");
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      if (
        (
          await fetch(base + "/health/ready", {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await wait(50);
  }
  assert.ok(ready, "API readiness timed out");
  const suite = await api("/suites", {
    name: "Demo lifecycle",
    cases: [
      {
        caseId: "hello",
        inputs: "Hello",
        graders: [
          {
            id: "exact",
            type: "exact",
            expected: "Demo harness response: Hello",
          },
        ],
      },
    ],
  });
  await api(`/suites/${suite.id}/versions`, { revision: 1 });
  const request = { suiteId: suite.id, suiteVersion: 1, agentId: "assistant" },
    job = await api("/jobs", request, { "Idempotency-Key": "smoke" });
  assert.equal(
    (await api("/jobs", request, { "Idempotency-Key": "smoke" })).jobId,
    job.jobId,
  );
  const cancelled = await api("/jobs", request, {
    "Idempotency-Key": "cancel",
  });
  assert.equal(
    (await api(`/jobs/${cancelled.jobId}/cancel`, {})).state,
    "CANCELLED",
  );
  start("dist/eval-worker-main.js");
  let final;
  for (let i = 0; i < 150; i++) {
    final = await api(`/jobs/${job.jobId}`);
    if (!["QUEUED", "RUNNING"].includes(final.state)) break;
    await wait(50);
  }
  assert.equal(final.state, "COMPLETED");
  const cases = await api(`/jobs/${job.jobId}/cases`),
    report = await api(`/jobs/${job.jobId}/report`);
  assert.equal(cases[0].state, "PASSED");
  assert.equal(report.passRate, 1);
  assert.equal(report.target.estimated, true);
  assert.equal(
    (
      await api("/compare", {
        baselineJobId: job.jobId,
        candidateJobId: job.jobId,
      })
    ).gate,
    true,
  );
  const events = await fetch(base + `/api/v1/evals/jobs/${job.jobId}/events`, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(5000),
  });
  assert.match(await events.text(), /eval.job.completed/);
  assert.equal(
    (
      await pool.query(
        "SELECT (SELECT count(*) FROM personal_runs)+(SELECT count(*) FROM personal_sessions) AS n",
      )
    ).rows[0].n,
    "0",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      dedicatedWorker: true,
      jobState: final.state,
      idempotency: true,
      cancellation: true,
      report: true,
      compare: true,
      sse: true,
      productionRecords: 0,
    }),
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await once(child, "exit").catch(() => {});
      clearTimeout(timer);
    }
  }
  await pool.end();
  await control.query(`DROP SCHEMA ${schema} CASCADE`);
  await control.end();
}
