import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { evalFixture, databaseUrl } from "./eval-fixture.js";
import { PostgresRegistry } from "../src/storage/registry.js";
import { MemoryStore } from "../src/storage/store.js";
import { PersonalService } from "../src/domain/personal-service.js";
import { AgentConfig, Fault } from "../src/domain/model.js";
import { EvalService } from "../src/evals/service.js";
import { EvalAccess } from "../src/evals/access.js";
import { EvalJobStore } from "../src/evals/job-store.js";
import { EvalWorker, EvalDemoRuntime } from "../src/evals/worker.js";
import { EvalExecutor } from "../src/evals/executor.js";
import { jobsFixture } from "./eval-job-fixture.js";

test(
  "native-only jobs ignore broken or configured global Judge settings and reserve no Judge cost",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture();
    const saved = Object.fromEntries(
      ["EVAL_JUDGE_ENABLED", "EVAL_JUDGE_MODEL", "USAGE_POLICY_JSON"].map(
        (k) => [k, process.env[k]],
      ),
    );
    try {
      process.env.EVAL_JUDGE_ENABLED = "true";
      process.env.EVAL_JUDGE_MODEL = "missing/model";
      process.env.USAGE_POLICY_JSON = JSON.stringify({
        userDailyCostMicros: 1,
      });
      const native = await f.jobs.create(
        f.actor,
        f.request,
        "native-without-judge",
      );
      assert.equal(native.snapshot.judge, undefined);
      await new EvalWorker(
        f.jobs,
        new EvalExecutor(new EvalDemoRuntime()),
      ).tick();
      assert.equal(
        (await f.jobs.job(f.actor.userId, native.jobId)).state,
        "COMPLETED",
      );
      await f.registry.tx((s) => {
        s.modelCatalog = [
          {
            provider: "demo",
            modelId: "judge",
            gatewayRef: "judge-ref",
            baseUrl: "https://example.com",
            secretRef: "test",
            default: false,
          },
        ];
      });
      process.env.EVAL_JUDGE_MODEL = "demo/judge";
      const second = await f.jobs.create(
        f.actor,
        f.request,
        "native-with-valid-judge",
      );
      assert.equal(second.snapshot.judge, undefined);
      assert.equal(
        (
          await f.pool.query(
            "SELECT sum((data->>'costMicros')::int)::int AS cost FROM personal_usage_requests",
          )
        ).rows[0].cost,
        0,
      );
      const suite = await f.service.createSuite(f.actor, {
        name: "judge",
        cases: [
          {
            caseId: "j",
            inputs: "hi",
            graders: [{ id: "j", type: "llm_judge", rubric: "quality" }],
          },
        ],
      });
      await f.jobs.publish(f.actor.userId, suite.id, 1);
      process.env.EVAL_JUDGE_MODEL = "missing/model";
      await assert.rejects(
        f.jobs.create(
          f.actor,
          { ...f.request, suiteId: suite.id, limits: { maxJudgeCalls: 1 } },
          "needs-judge",
        ),
        /EVAL_JUDGE_MODEL_NOT_APPROVED/,
      );
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await f.close();
    }
  },
);

test(
  "explicit target request limits allow the 31st call and reject calls past the chosen cap",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture();
    try {
      await f.jobs.create(
        f.actor,
        { ...f.request, limits: { maxTokens: 10000, maxModelCalls: 31 } },
        "calls-31",
      );
      const claim = (await f.jobs.claim("worker"))!;
      for (let i = 0; i < 31; i++) {
        const ticket = await f.jobs.reserve(claim.run, "target", 1);
        await f.jobs.settle(
          f.actor.userId,
          ticket.id,
          { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          1,
        );
      }
      await assert.rejects(
        f.jobs.reserve(claim.run, "target", 1),
        /EVAL_REQUEST_LIMIT/,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "idempotent POST returns the same live cancellation projection as GET",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture();
    try {
      const j = await f.jobs.create(f.actor, f.request, "cancel-view");
      const claim = (await f.jobs.claim("worker"))!;
      await f.jobs.cancel(f.actor.userId, j.jobId);
      const replay = await f.jobs.create(f.actor, f.request, "cancel-view");
      assert.equal(replay.state, "RUNNING");
      assert.equal(replay.cancelRequested, true);
      assert.deepEqual(replay, await f.jobs.job(f.actor.userId, j.jobId));
      await f.jobs.finish(claim.run, "PASSED", {});
      assert.deepEqual(
        await f.jobs.create(f.actor, f.request, "cancel-view"),
        await f.jobs.job(f.actor.userId, j.jobId),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "Eval reservations recheck shared period caps when a hold predates today or this month",
  { skip: !databaseUrl },
  async () => {
    const previous = process.env.USAGE_POLICY_JSON;
    process.env.USAGE_POLICY_JSON = JSON.stringify({
      userDailyTokens: 5000,
      userMonthlyTokens: 10000,
    });
    const f = await jobsFixture();
    try {
      const job = await f.jobs.create(
        f.actor,
        { ...f.request, limits: { maxTokens: 5000 } },
        "old-hold",
      );
      const claim = (await f.jobs.claim("worker"))!;
      for (const [at, policy] of [
        [
          new Date(Date.now() - 86400000).toISOString(),
          { userDailyTokens: 5000, userMonthlyTokens: 10000 },
        ],
        [
          "2000-01-01T00:00:00.000Z",
          { userDailyTokens: 10000, userMonthlyTokens: 5000 },
        ],
      ] as const) {
        process.env.USAGE_POLICY_JSON = JSON.stringify(policy);
        await f.pool.query(
          "UPDATE personal_usage_requests SET at=$2,data=jsonb_set(data,'{at}',to_jsonb($2::text)) WHERE user_id=$1 AND id=$3",
          [f.actor.userId, at, "eval-hold:" + job.jobId],
        );
        const other = await f.jobs.create(
          f.actor,
          { ...f.request, limits: { maxTokens: 5000 } },
          at,
        );
        await assert.rejects(
          f.jobs.reserve(claim.run, "target", 10),
          /MODEL_BUDGET_EXCEEDED/,
        );
        assert.equal((await f.jobs.usage(f.actor.userId, job.jobId)).length, 0);
        await f.jobs.cancel(f.actor.userId, other.jobId);
      }
      // A same-day transfer consumes the already charged hold exactly once.
      const at = new Date().toISOString();
      await f.pool.query(
        "UPDATE personal_usage_requests SET at=$2,data=jsonb_set(data,'{at}',to_jsonb($2::text)) WHERE user_id=$1 AND id=$3",
        [f.actor.userId, at, "eval-hold:" + job.jobId],
      );
      await f.jobs.reserve(claim.run, "target", 10);
    } finally {
      if (previous === undefined) delete process.env.USAGE_POLICY_JSON;
      else process.env.USAGE_POLICY_JSON = previous;
      await f.close();
    }
  },
);

test(
  "a worker rejects unavailable frozen grader versions before calling a model",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture();
    try {
      const job = await f.jobs.create(f.actor, f.request, "old-version");
      job.snapshot.graderVersion = "1";
      await f.pool.query(
        "UPDATE personal_eval_jobs SET data=$3 WHERE user_id=$1 AND job_id=$2",
        [f.actor.userId, job.jobId, JSON.stringify(job)],
      );
      let calls = 0;
      await new EvalWorker(
        f.jobs,
        new EvalExecutor({
          async execute() {
            calls++;
          },
        }),
      ).tick();
      const rows = await f.jobs.caseRuns(f.actor.userId, job.jobId, {
        offset: 0,
        limit: 100,
      });
      assert.equal(calls, 0);
      assert.equal(rows[0]!.state, "EXECUTION_ERROR");
      assert.equal(
        rows[0]!.result!.errorCode,
        "EVAL_GRADER_VERSION_UNAVAILABLE",
      );
      assert.equal((await f.jobs.usage(f.actor.userId, job.jobId)).length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "Judge case allowance excludes target usage but the job hold remains shared",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture();
    try {
      const job = await f.jobs.create(
        f.actor,
        { ...f.request, limits: { maxTokens: 5000, maxJudgeCalls: 2 } },
        "separate-roles",
      );
      job.snapshot.config.maxTokens = 100;
      job.snapshot.judge = {
        config: { ...job.snapshot.config },
        gatewayRef: null,
        version: "test",
      };
      await f.pool.query(
        "UPDATE personal_eval_jobs SET data=$3 WHERE user_id=$1 AND job_id=$2",
        [f.actor.userId, job.jobId, JSON.stringify(job)],
      );
      const claim = (await f.jobs.claim("worker"))!;
      const target = await f.jobs.reserve(claim.run, "target", 10);
      await f.jobs.settle(
        f.actor.userId,
        target.id,
        { input: 10, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 90 },
        1,
      );
      const judge = await f.jobs.reserve(claim.run, "judge", 10);
      assert.equal(judge.maxOutputTokens, 90);
      await f.jobs.settle(
        f.actor.userId,
        judge.id,
        { input: 10, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 90 },
        1,
      );
      await assert.rejects(
        f.jobs.reserve(claim.run, "target", 10),
        /MODEL_BUDGET_EXCEEDED/,
      );
      await assert.rejects(
        f.jobs.reserve(claim.run, "judge", 10),
        /MODEL_BUDGET_EXCEEDED/,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "eval jobs atomically freeze/idempotently reserve, two workers claim once, fence stale writes and recover without replay",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture();
    try {
      const j = await f.jobs.create(f.actor, f.request, "key");
      assert.equal(
        (await f.jobs.create(f.actor, f.request, "key")).jobId,
        j.jobId,
      );
      await assert.rejects(
        f.jobs.create(f.actor, { ...f.request, repeat: 2 }, "key"),
        (e) => e instanceof Fault && e.status === 409,
      );
      const claims = await Promise.all([
        f.jobs.claim("one"),
        f.jobs.claim("two"),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      const claim = claims.find(Boolean)!;
      await assert.rejects(
        f.jobs.finish({ ...claim.run, generation: randomUUID() }, "PASSED", {}),
        /EVAL_LEASE_LOST/,
      );
      const ticket = await f.jobs.reserve(claim.run, "target", 10);
      await f.jobs.settle(f.actor.userId, ticket.id, undefined, 1);
      await f.pool.query(
        "UPDATE personal_eval_case_runs SET lease_expires_at=now()-interval '1 second'",
      );
      await f.jobs.recover();
      assert.equal(
        (
          await f.jobs.caseRuns(f.actor.userId, j.jobId, {
            offset: 0,
            limit: 10,
          })
        )[0]!.result!.errorCode,
        "LEASE_LOST",
      );
      assert.equal(await f.jobs.claim("three"), undefined);
      assert.equal(
        (await f.jobs.usage(f.actor.userId, j.jobId))[0]!.status,
        "unknown",
      );
      assert.equal(
        (await f.pool.query("SELECT count(*)::int AS n FROM personal_sessions"))
          .rows[0].n,
        0,
      );
      assert.equal(
        (await f.pool.query("SELECT count(*)::int AS n FROM personal_runs"))
          .rows[0].n,
        0,
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "eval worker completes, cancellation is terminal, event replay ordered and access revoked live",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture();
    try {
      const job = await f.jobs.create(f.actor, f.request, "key"),
        worker = new EvalWorker(
          f.jobs,
          new EvalExecutor(new EvalDemoRuntime()),
        );
      await worker.tick();
      assert.equal(
        (await f.jobs.job(f.actor.userId, job.jobId)).state,
        "COMPLETED",
      );
      assert.equal(
        (
          await f.jobs.caseRuns(f.actor.userId, job.jobId, {
            offset: 0,
            limit: 10,
          })
        )[0]!.state,
        "PASSED",
      );
      const events = await f.jobs.events(f.actor.userId, job.jobId, 0);
      assert.deepEqual(
        events.map((e) => e.eventId),
        events.map((_, i) => i + 1),
      );
      assert.deepEqual(
        await f.jobs.events(f.actor.userId, job.jobId, events.at(-1)!.eventId),
        [],
      );
      const second = await f.jobs.create(f.actor, f.request, "next");
      await f.jobs.cancel(f.actor.userId, second.jobId);
      assert.equal(await worker.tick(), false);
      assert.equal(
        (await f.jobs.job(f.actor.userId, second.jobId)).state,
        "CANCELLED",
      );
      await f.registry.tx((s) => {
        s.managedAgents!.assistant!.enabled = false;
      });
      await assert.rejects(
        f.service.authorizeJob(f.actor, job.jobId),
        /EVAL_ACCESS_REVOKED/,
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "eval hold is charged to the shared normal budget and cannot be bypassed by a second job",
  { skip: !databaseUrl },
  async () => {
    const before = process.env.USAGE_POLICY_JSON;
    process.env.USAGE_POLICY_JSON = '{"userDailyTokens":20000}';
    const f = await jobsFixture();
    try {
      const j = await f.jobs.create(f.actor, f.request, "a");
      await assert.rejects(
        f.jobs.create(f.actor, f.request, "b"),
        /MODEL_BUDGET_EXCEEDED/,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT sum((data->>'tokens')::int)::int AS n FROM personal_usage_requests WHERE user_id=$1",
            [f.actor.userId],
          )
        ).rows[0].n,
        20000,
      );
      await f.jobs.cancel(f.actor.userId, j.jobId);
      await f.jobs.create(f.actor, f.request, "b");
    } finally {
      if (before === undefined) delete process.env.USAGE_POLICY_JSON;
      else process.env.USAGE_POLICY_JSON = before;
      await f.close();
    }
  },
);

test(
  "normal Run reservation and Eval job compete under one persisted user budget",
  { skip: !databaseUrl },
  async () => {
    const { PersonalPostgresStore } = await import(
      "../src/storage/personal-postgres-store.js"
    );
    const { personalStore } = await import("../src/storage/personal.js");
    const { UsageLedger, UsagePolicy } = await import("../src/domain/usage.js");
    const previous = process.env.USAGE_POLICY_JSON;
    process.env.USAGE_POLICY_JSON = '{"userDailyTokens":5000}';
    const f = await jobsFixture(),
      backing = new PersonalPostgresStore(f.url),
      store = personalStore(backing, f.registry);
    try {
      const normal = new PersonalService(
        store,
        f.registry,
        [],
        ["default"],
        [{ provider: "demo", modelId: "demo" }],
      );
      const session = await normal.createPersonalSession(f.actor, {
          agentId: "assistant",
        }),
        run = await normal.submit(f.actor, session.id, "normal work");
      await store.runTx!(f.actor.userId, run.id, (s) => {
        s.runs[run.id]!.state = "RUNNING";
        s.runs[run.id]!.lease = {
          owner: "normal",
          expires: Date.now() + 60000,
        };
      });
      const ledger = new UsageLedger(
        store,
        UsagePolicy.parse({ userDailyTokens: 5000 }),
      );
      const outcomes = await Promise.allSettled([
        ledger.reserve(f.actor.userId, run.id, 10, "normal"),
        f.jobs.create(
          f.actor,
          { ...f.request, limits: { maxTokens: 5000 } },
          "race",
        ),
      ]);
      assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
      const sum = (
        await f.pool.query(
          "SELECT sum((data->>'tokens')::int)::int AS n FROM personal_usage_requests WHERE user_id=$1",
          [f.actor.userId],
        )
      ).rows[0].n;
      assert.ok(sum > 0 && sum <= 5000);
    } finally {
      if (previous === undefined) delete process.env.USAGE_POLICY_JSON;
      else process.env.USAGE_POLICY_JSON = previous;
      await backing.close();
      await f.close();
    }
  },
);

test(
  "target and Judge gateway rotations reject new model budget tickets before charging",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture();
    try {
      await f.registry.tx((s) => {
        s.modelCatalog = [
          {
            provider: "demo",
            modelId: "demo",
            gatewayRef: "G1",
            baseUrl: "https://example.com",
            secretRef: "placeholder",
            default: false,
          },
        ];
      });
      const j = await f.jobs.create(f.actor, f.request, "gateway-live");
      const claim = (await f.jobs.claim("worker"))!;
      await f.jobs.reserve(claim.run, "target", 1);
      await f.registry.tx((s) => {
        s.modelCatalog![0]!.gatewayRef = "G2";
      });
      await assert.rejects(
        f.jobs.reserve(claim.run, "target", 1),
        /EVAL_GATEWAY_REVOKED/,
      );
      const current = await f.jobs.job(f.actor.userId, j.jobId);
      current.snapshot.judge = {
        config: {
          ...current.snapshot.config,
          model: { provider: "demo", modelId: "judge" },
        },
        gatewayRef: "J1",
        version: "frozen",
      };
      await f.pool.query(
        "UPDATE personal_eval_jobs SET data=$3 WHERE user_id=$1 AND job_id=$2",
        [f.actor.userId, j.jobId, JSON.stringify(current)],
      );
      await f.registry.tx((s) => {
        s.modelCatalog![0]!.gatewayRef = "G1";
        s.modelCatalog!.push({
          provider: "demo",
          modelId: "judge",
          gatewayRef: "J2",
          baseUrl: "https://example.com",
          secretRef: "placeholder",
          default: false,
        });
      });
      await assert.rejects(
        f.jobs.reserve(claim.run, "target", 1),
        /EVAL_GATEWAY_REVOKED/,
      );
      assert.equal((await f.jobs.usage(f.actor.userId, j.jobId)).length, 1);
    } finally {
      await f.close();
    }
  },
);
