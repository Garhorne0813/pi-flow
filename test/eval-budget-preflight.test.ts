import test from "node:test";
import assert from "node:assert/strict";
import { jobsFixture } from "./eval-job-fixture.js";
import { databaseUrl } from "./eval-fixture.js";
import { EvalAccess } from "../src/evals/access.js";
import { EvalJobStore } from "../src/evals/job-store.js";
import { PersonalService } from "../src/domain/personal-service.js";
import { MemoryStore } from "../src/storage/store.js";
import { report } from "../src/evals/report.js";

test(
  "cache-only prices reserve nonzero holds and worst-case cache costs before model tickets",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture(),
      previous = process.env.USAGE_POLICY_JSON;
    try {
      process.env.USAGE_POLICY_JSON = JSON.stringify({
        userDailyCostMicros: 50,
        prices: {
          "demo/demo": {
            version: "cache",
            input: 0,
            output: 0,
            cacheRead: 1,
            cacheWrite: 2,
          },
        },
      });
      await f.registry.tx((s) => {
        s.modelCatalog = [
          {
            provider: "demo",
            modelId: "demo",
            gatewayRef: "approved",
            baseUrl: "https://example.com",
            secretRef: "placeholder",
            default: false,
          },
        ];
      });
      const jobs = new EvalJobStore(
        f.pool,
        new EvalAccess(new PersonalService(new MemoryStore(), f.registry)),
      );
      const small = await jobs.create(
        f.actor,
        { ...f.request, limits: { maxCostEstimateUsd: 0.000001 } },
        "small",
      );
      const claimed = (await jobs.claim("worker"))!;
      assert.equal(
        (
          await f.pool.query(
            "SELECT data->>'costMicros' AS cost FROM personal_usage_requests WHERE id=$1",
            ["eval-hold:" + small.jobId],
          )
        ).rows[0].cost,
        "1",
      );
      await assert.rejects(
        jobs.reserve(claimed.run, "target", 10),
        /MODEL_COST_BUDGET_EXCEEDED/,
      );
      assert.deepEqual(await jobs.usage(f.actor.userId, small.jobId), []);
      await jobs.finish(claimed.run, "EXECUTION_ERROR", {
        errorCode: "TEST_FINISH",
      });
      for (const field of ["cacheRead", "cacheWrite"] as const) {
        const job = await jobs.create(
          f.actor,
          { ...f.request, limits: { maxCostEstimateUsd: 0.00002 } },
          field,
        );
        const run = (await jobs.claim("worker"))!.run;
        const ticket = await jobs.reserve(run, "target", 10);
        assert.equal(
          (await jobs.usage(f.actor.userId, job.jobId))[0]!.costMicros,
          20,
        );
        await jobs.settle(
          f.actor.userId,
          ticket.id,
          {
            input: 0,
            output: 1,
            cacheRead: field === "cacheRead" ? 10 : 0,
            cacheWrite: field === "cacheWrite" ? 10 : 0,
            totalTokens: 11,
          },
          1,
        );
        const cost = (await jobs.usage(f.actor.userId, job.jobId))[0]!
          .costMicros;
        assert.equal(cost, field === "cacheRead" ? 10 : 20);
        await assert.rejects(
          jobs.reserve(run, "target", 10),
          /MODEL_COST_BUDGET_EXCEEDED/,
        );
        await jobs.finish(run, "EXECUTION_ERROR", { errorCode: "TEST_FINISH" });
      }
      await assert.rejects(
        jobs.create(
          f.actor,
          { ...f.request, limits: { maxCostEstimateUsd: 0.000021 } },
          "over-shared-cap",
        ),
        /MODEL_COST_BUDGET_EXCEEDED/,
      );
    } finally {
      if (previous === undefined) delete process.env.USAGE_POLICY_JSON;
      else process.env.USAGE_POLICY_JSON = previous;
      await f.close();
    }
  },
);

test(
  "required Judge price is checked before any job or hold is created",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture();
    const previous = Object.fromEntries(
      ["EVAL_JUDGE_ENABLED", "EVAL_JUDGE_MODEL", "USAGE_POLICY_JSON"].map(
        (k) => [k, process.env[k]],
      ),
    );
    try {
      process.env.EVAL_JUDGE_ENABLED = "true";
      process.env.EVAL_JUDGE_MODEL = "demo/judge";
      process.env.USAGE_POLICY_JSON = "{}";
      await f.registry.tx((s) => {
        s.modelCatalog = [
          {
            provider: "demo",
            modelId: "judge",
            gatewayRef: "approved",
            baseUrl: "https://example.com",
            secretRef: "placeholder",
            default: false,
          },
        ];
      });
      const suite = await f.service.createSuite(f.actor, {
        name: "Judge",
        cases: [
          {
            caseId: "c",
            inputs: "hi",
            graders: [{ id: "j", type: "llm_judge", rubric: "correct" }],
          },
        ],
      });
      await f.jobs.publish(f.actor.userId, suite.id, 1);
      const request = {
        ...f.request,
        suiteId: suite.id,
        limits: { maxJudgeCalls: 1 },
      };
      await assert.rejects(
        f.jobs.create(f.actor, request, "missing-price"),
        /MODEL_PRICE_REQUIRED/,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM personal_eval_jobs",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM personal_usage_requests",
          )
        ).rows[0].n,
        0,
      );
      process.env.USAGE_POLICY_JSON = JSON.stringify({
        prices: {
          "demo/judge": {
            version: "free",
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      });
      assert.ok(
        (await f.jobs.create(f.actor, request, "valid-price")).snapshot.judge,
      );
    } finally {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await f.close();
    }
  },
);

test(
  "legacy invalid published schemas fail creation before budget holds",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture();
    try {
      await f.pool.query(
        "UPDATE personal_eval_cases SET data=jsonb_set(data,'{graders}',$1::jsonb)",
        [
          JSON.stringify([
            {
              id: "g",
              type: "json_schema",
              schema: { $ref: "https://example.com/schema" },
              weight: 1,
              hard: false,
            },
          ]),
        ],
      );
      await assert.rejects(
        f.jobs.create(f.actor, f.request, "legacy-schema"),
        /EVAL_INVALID_GRADER_SCHEMA/,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM personal_usage_requests",
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "lease recovery attributes RUNNING and GRADING failures separately and retains target evidence",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture();
    try {
      for (const stage of ["GRADING", "RUNNING"]) {
        const job = await f.jobs.create(f.actor, f.request, stage);
        const run = (await f.jobs.claim("worker"))!.run;
        await f.jobs.reserve(run, "target", 10);
        if (stage === "GRADING")
          await f.jobs.grading(run, {
            output: "complete target",
            trajectory: [
              {
                sequence: 1,
                name: "read",
                callId: "call",
                status: "COMPLETED",
              },
            ],
            metrics: { tokens: 5, durationMs: 10 },
          });
        await f.pool.query(
          "UPDATE personal_eval_case_runs SET lease_expires_at=now()-interval '1 second' WHERE case_run_id=$1",
          [run.caseRunId],
        );
        await f.jobs.recover();
        const rows = await f.jobs.caseRuns(f.actor.userId, job.jobId, {
          offset: 0,
          limit: 100,
        });
        assert.equal(
          rows[0]!.state,
          stage === "GRADING" ? "GRADING_ERROR" : "EXECUTION_ERROR",
        );
        assert.equal(rows[0]!.result!.errorCode, "LEASE_LOST");
        if (stage === "GRADING") {
          assert.equal(rows[0]!.result!.output, "complete target");
          assert.equal(rows[0]!.result!.trajectory![0]!.name, "read");
        }
        const summary = report(
          await f.jobs.job(f.actor.userId, job.jobId),
          rows,
          await f.jobs.usage(f.actor.userId, job.jobId),
        );
        assert.equal(summary.executionErrorRate, stage === "GRADING" ? 0 : 1);
        assert.equal(summary.gradingErrorRate, stage === "GRADING" ? 1 : 0);
        assert.equal(
          (await f.jobs.usage(f.actor.userId, job.jobId))[0]!.status,
          "unknown",
        );
        assert.equal(await f.jobs.claim("another-worker"), undefined);
      }
    } finally {
      await f.close();
    }
  },
);
