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
export async function jobsFixture() {
  const f = await evalFixture(),
    registry = new PostgresRegistry(f.pool);
  const uid = await registry.identify("test", "u");
  await registry.tx((s) => {
    s.managedAgents = {
      assistant: {
        id: "assistant",
        enabled: true,
        updatedAt: new Date().toISOString(),
        config: AgentConfig.parse({
          name: "test",
          systemPrompt: "test",
          model: { provider: "demo", modelId: "demo" },
          tools: ["read"],
        }),
      },
    };
  });
  const actor = {
    tenantId: uid,
    userId: uid,
    issuer: "test",
    subject: "u",
    admin: false,
  };
  const access = new EvalAccess(
      new PersonalService(new MemoryStore(), registry),
      true,
    ),
    jobs = new EvalJobStore(f.pool, access),
    service = new EvalService(
      jobs,
      async (a) => registry.verifyIdentity(a.issuer!, a.subject!, a.userId),
      jobs,
    );
  const suite = await service.createSuite(actor, {
    name: "test",
    cases: [
      {
        caseId: "c",
        inputs: "hi",
        graders: [
          { id: "g", type: "exact", expected: "Demo harness response: hi" },
        ],
      },
    ],
  });
  await jobs.publish(uid, suite.id, 1);
  const request = { suiteId: suite.id, suiteVersion: 1, agentId: "assistant" };
  return { ...f, registry, actor, access, jobs, service, request };
}
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
