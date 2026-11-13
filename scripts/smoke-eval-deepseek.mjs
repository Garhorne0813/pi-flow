// Opt-in real DeepSeek acceptance. Credentials are read from stdin, sealed in a
// disposable schema, never put in snapshots, logs, the report, or child argv.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { AgentConfig } from "../dist/domain/model.js";
import { PersonalService } from "../dist/domain/personal-service.js";
import { PersonalPostgresStore } from "../dist/storage/personal-postgres-store.js";
import { PostgresRegistry } from "../dist/storage/registry.js";
import { personalStore } from "../dist/storage/personal.js";
import { versionModelCatalog } from "../dist/config/models.js";
import { sealToken } from "../dist/security/token-vault.js";
import { createEvals } from "../dist/evals/factory.js";
import { buildAPI } from "../dist/api/server.js";
import { SandboxManager, DemoSandbox } from "../dist/sandbox/manager.js";
const source = process.env.TEST_DATABASE_URL;
if (!source)
  throw Error("TEST_DATABASE_URL required; use a disposable database");
const input = createInterface({ input: process.stdin, terminal: false });
console.log("KEY_INPUT_READY");
let key = await new Promise((resolve, reject) => {
  input.once("line", (line) => {
    resolve(line.trim());
    input.close();
    process.stdin.pause();
  });
  input.once("close", () => reject(Error("API_KEY_INPUT_CLOSED")));
});
if (!key) throw Error("API_KEY_REQUIRED");
const provider = "deepseek",
  model = "deepseek-flash",
  reasoningEffort = "high",
  endpoint = "https://api.deepseek.com";
const report = {
  provider,
  model,
  reasoningEffort,
  status: "running",
  checks: {},
  scope:
    "real model and Judge; PostgreSQL, HTTP/SSE, dedicated Eval Worker; fixed mock tools, no real Sandbox",
  startedAt: new Date().toISOString(),
};
let control, backing, app, worker, schema;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const preflight = await fetch(endpoint + "/models", {
    headers: { Authorization: "Bearer " + key },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(preflight.status, 200, "MODEL_AUTHENTICATION_FAILED");
  const models = await preflight.json();
  assert.ok(
    models.data.some((m) => m.id === model),
    "MODEL_UNAVAILABLE",
  );
  report.checks.authenticatedModel = true;
  schema = "eval_deepseek_" + randomUUID().replaceAll("-", "");
  control = new pg.Pool({ connectionString: source });
  await control.query(`CREATE SCHEMA ${schema}`);
  const database = new URL(source);
  database.searchParams.set("options", `-c search_path=${schema}`);
  backing = new PersonalPostgresStore(database.toString());
  const c = await backing.pool.connect();
  try {
    await c.query("BEGIN");
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await c.query(await readFile("migrations/" + file, "utf8"));
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  Object.assign(process.env, {
    CONFIG_SECRET_KEY: randomBytes(32).toString("base64"),
    EVALS_ENABLED: "true",
    EVAL_JUDGE_ENABLED: "true",
    EVAL_JUDGE_MODEL: provider + "/" + model,
    EVAL_JUDGE_REASONING_EFFORT: reasoningEffort,
    LOG_LEVEL: "silent",
    USAGE_POLICY_JSON: JSON.stringify({
      userDailyTokens: 100000,
      userDailyCostMicros: 200000,
      prices: {
        [provider + "/" + model]: {
          version: "pi-native-deepseek-flash-0.99.2",
          input: 0.3,
          output: 1.2,
          cacheRead: 0.006,
          cacheWrite: 0,
        },
      },
    }),
  });
  const registry = new PostgresRegistry(backing.pool),
    subject = randomUUID(),
    userId = await registry.identify("urn:eval-live", subject);
  const actor = {
      tenantId: userId,
      userId,
      issuer: "urn:eval-live",
      subject,
      admin: false,
    },
    otherSubject = randomUUID(),
    otherId = await registry.identify("urn:eval-live", otherSubject);
  await registry.tx((s) => {
    s.secrets = {
      "deepseek-live": sealToken(
        key,
        "platform:deepseek-live",
        "CONFIG_SECRET_KEY",
      ),
    };
    s.modelCatalog = [
      {
        provider,
        modelId: model,
        baseUrl: endpoint,
        secretRef: "deepseek-live",
        default: true,
      },
    ];
    versionModelCatalog(s);
    s.managedAgents = {
      assistant: {
        id: "assistant",
        enabled: true,
        allowedUsers: [userId],
        updatedAt: new Date().toISOString(),
        config: AgentConfig.parse({
          name: "DeepSeek Eval acceptance",
          systemPrompt:
            "Follow the test input precisely. Tools are fixed evaluation mocks, never production resources. Do not claim to read anything without using the tool.",
          model: { provider, modelId: model },
          reasoningEffort,
          tools: ["read"],
          maxTokens: 12000,
          maxSteps: 8,
          timeoutSeconds: 120,
          maxSubagents: 0,
          maxDepth: 0,
        }),
      },
    };
  });
  const store = personalStore(backing, registry),
    service = new PersonalService(
      store,
      registry,
      [],
      ["default"],
      [{ provider, modelId: model }],
    ),
    evals = createEvals(service, backing, false),
    token = randomUUID();
  app = buildAPI(
    service,
    async (header) => {
      if (header === "Bearer " + token) return actor;
      if (header === "Bearer other")
        return {
          ...actor,
          userId: otherId,
          tenantId: otherId,
          subject: otherSubject,
          admin: true,
        };
      throw Error("UNAUTHENTICATED_TEST_REQUEST");
    },
    new SandboxManager(store, new DemoSandbox()),
    undefined,
    undefined,
    undefined,
    evals,
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  async function request(path, body, headers = {}, expected = undefined) {
    const response = await fetch(address + "/api/v1/evals" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (expected !== undefined) {
      assert.equal(response.status, expected);
      return;
    }
    assert.ok(response.ok, "LOCAL_EVAL_API_" + response.status);
    return response.json();
  }
  const marker = "eval-marker-" + randomBytes(8).toString("hex");
  const suite = await request("/suites", {
    name: "DeepSeek high reasoning live acceptance",
    cases: [
      {
        caseId: "exact",
        inputs:
          "Calculate 6*7. Return exactly 42, without punctuation or explanation.",
        timeoutMs: 120000,
        graders: [{ id: "exact", type: "exact", expected: "42" }],
      },
      {
        caseId: "mock-read",
        inputs:
          'Call read exactly once with arguments {"path":"/fixture/marker.txt"}. Return only the marker in the tool response, without punctuation or explanation. Never guess.',
        mocks: { read: { marker } },
        timeoutMs: 120000,
        graders: [
          { id: "output", type: "exact", expected: marker },
          {
            id: "read",
            type: "tool_called",
            name: "read",
            args: { path: "/fixture/marker.txt" },
            min: 1,
            max: 1,
            hard: true,
          },
          {
            id: "order",
            type: "trajectory",
            mode: "strict",
            calls: [{ name: "read", args: { path: "/fixture/marker.txt" } }],
            hard: true,
          },
          { id: "no-shell", type: "tool_not_called", name: "bash", hard: true },
        ],
      },
      {
        caseId: "judge",
        inputs:
          "用一句中文解释为什么 Agent 评测必须隔离生产工作区，包含文件污染和凭据泄露两项风险。",
        timeoutMs: 120000,
        passThreshold: 0.7,
        graders: [
          {
            id: "quality",
            type: "llm_judge",
            rubric:
              "回答必须用中文说明：隔离评测以防止污染真实用户文件，并防止泄露生产凭据。两项均清楚覆盖得1分，仅一项得0.5分，均未覆盖得0分。只按实际回答评分。",
            threshold: 0.7,
          },
        ],
      },
    ],
  });
  await request(`/suites/${suite.id}/versions`, {
    revision: suite.draftRevision,
  });
  const basic = await request("/suites", {
    name: "Budget and cancellation",
    cases: [
      {
        caseId: "budget",
        inputs: "Return exactly OK.",
        graders: [{ id: "exact", type: "exact", expected: "OK" }],
      },
    ],
  });
  await request(`/suites/${basic.id}/versions`, {
    revision: basic.draftRevision,
  });
  const basicRequest = {
    suiteId: basic.id,
    suiteVersion: 1,
    agentId: "assistant",
    limits: {
      maxTokens: 100,
      maxModelCalls: 1,
      maxJudgeCalls: 0,
      maxCostEstimateUsd: 0.01,
      maxDurationSeconds: 120,
    },
  };
  const cancelled = await request("/jobs", basicRequest, {
    "Idempotency-Key": "cancel",
  });
  assert.equal(
    (await request(`/jobs/${cancelled.jobId}/cancel`, {})).state,
    "CANCELLED",
  );
  report.checks.cancellation = true;
  const jobRequest = {
    suiteId: suite.id,
    suiteVersion: 1,
    agentId: "assistant",
    limits: {
      maxTokens: 60000,
      maxModelCalls: 8,
      maxJudgeCalls: 2,
      maxCostEstimateUsd: 0.1,
      maxDurationSeconds: 600,
    },
  };
  await request(
    "/jobs",
    { ...jobRequest, executionProfile: "isolated_readonly" },
    { "Idempotency-Key": "denied" },
    400,
  );
  report.checks.readonlyRejected = true;
  const job = await request("/jobs", jobRequest, { "Idempotency-Key": "live" });
  assert.equal(
    (await request("/jobs", jobRequest, { "Idempotency-Key": "live" })).jobId,
    job.jobId,
  );
  report.checks.idempotency = true;
  assert.equal(job.snapshot.config.reasoningEffort, "high");
  assert.equal(job.snapshot.judge.config.reasoningEffort, "high");
  assert.ok(!JSON.stringify(job).includes(key));
  report.checks.frozenReasoningAndSecretBoundary = true;
  const env = {
    ...process.env,
    DATABASE_URL: database.toString(),
    HARNESS_MODE: "production",
    EVALS_ENABLED: "true",
    EVAL_WORKER_ENABLED: "true",
  };
  delete env.SMOKE_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  delete env.LLM_API_KEY;
  worker = spawn(process.execPath, ["dist/eval-worker-main.js"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let workerError = "";
  worker.stderr.on("data", (data) => {
    workerError = (workerError + data).slice(-8000);
  });
  async function finish(id, seconds) {
    const expires = Date.now() + seconds * 1000;
    while (Date.now() < expires) {
      if (worker.exitCode !== null)
        throw Error(
          workerError.match(/(?:EVAL|MODEL|SCHEMA)_[A-Z_]+/)?.[0] ??
            "EVAL_WORKER_EXIT",
        );
      const current = await request(`/jobs/${id}`);
      if (!["QUEUED", "RUNNING"].includes(current.state)) return current;
      await delay(500);
    }
    throw Error("LIVE_EVAL_TIMEOUT");
  }
  const terminal = await finish(job.jobId, 600),
    cases = await request(`/jobs/${job.jobId}/cases?limit=100`),
    summary = await request(`/jobs/${job.jobId}/report`);
  report.jobState = terminal.state;
  report.cases = cases.map((c) => ({
    caseId: c.caseId,
    state: c.state,
    output: c.result?.output,
    errorCode: c.result?.errorCode,
    scores: c.result?.scores,
    trace: c.result?.trajectory?.map((t) => ({
      name: t.name,
      callId: t.callId,
      sequence: t.sequence,
      status: t.status,
    })),
  }));
  report.target = summary.target;
  report.judge = summary.judge;
  assert.equal(terminal.state, "COMPLETED", "REAL_EXECUTION_OR_GRADING_ERROR");
  assert.ok(
    cases.every((c) => c.state === "PASSED"),
    "REAL_ASSERTION_FAILED",
  );
  report.checks.realAgentAndJudge = true;
  assert.ok(summary.target.requests >= 4);
  assert.ok(summary.judge.requests >= 1);
  assert.equal(summary.target.unknownRequests, 0);
  assert.equal(summary.judge.unknownRequests, 0);
  report.checks.confirmedSeparateUsage = true;
  const comparison = await request("/compare", {
    baselineJobId: job.jobId,
    candidateJobId: job.jobId,
  });
  assert.equal(comparison.gate, true);
  report.checks.comparison = true;
  const stream = await fetch(
    address + `/api/v1/evals/jobs/${job.jobId}/events`,
    {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(5000),
    },
  );
  const events = await stream.text();
  assert.match(events, /eval.case.tool_completed/);
  assert.match(events, /eval.job.completed/);
  assert.ok(!events.includes(key));
  report.checks.sseAndToolTrace = true;
  await request(
    `/jobs/${job.jobId}/report`,
    undefined,
    { Authorization: "Bearer other" },
    404,
  );
  report.checks.crossUserIsolation = true;
  const budget = await request("/jobs", basicRequest, {
    "Idempotency-Key": "budget",
  });
  await finish(budget.jobId, 60);
  const budgetCases = await request(`/jobs/${budget.jobId}/cases`),
    budgetReport = await request(`/jobs/${budget.jobId}/report`);
  assert.equal(budgetCases[0].result.errorCode, "MODEL_BUDGET_EXCEEDED");
  assert.equal(budgetReport.target.requests, 0);
  report.checks.budgetBeforeRemoteCall = true;
  await registry.tx((s) => {
    s.managedAgents.assistant.enabled = false;
  });
  await request(`/jobs/${job.jobId}/report`, undefined, {}, 403);
  report.checks.liveAgentRevocation = true;
  assert.equal(
    (
      await backing.pool.query(
        "SELECT (SELECT count(*) FROM personal_sessions)+(SELECT count(*) FROM personal_runs) AS n",
      )
    ).rows[0].n,
    "0",
  );
  report.checks.noProductionSessionsOrRuns = true;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.errorCode =
    error instanceof assert.AssertionError
      ? error.message
      : typeof error?.message === "string" && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "LIVE_TEST_ERROR";
  process.exitCode = 1;
} finally {
  key = undefined;
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    worker.kill("SIGTERM");
    const timer = setTimeout(() => worker.kill("SIGKILL"), 5000);
    await once(worker, "exit").catch(() => {});
    clearTimeout(timer);
  }
  if (app) await app.close();
  if (backing) await backing.close();
  if (control) {
    if (schema) await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
  }
  report.finishedAt = new Date().toISOString();
  await mkdir("work", { recursive: true });
  await writeFile(
    "work/eval-deepseek-report.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
