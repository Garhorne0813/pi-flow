import test from "node:test";
import assert from "node:assert/strict";
import { jobsFixture } from "./eval-job-fixture.js";
import { databaseUrl } from "./eval-fixture.js";
import { EvalWorker, EvalDemoRuntime } from "../src/evals/worker.js";
import { EvalExecutor } from "../src/evals/executor.js";
import type { EvalJobStore } from "../src/evals/job-store.js";
import { telemetry } from "../src/observability/telemetry.js";

test(
  "Eval Worker backs off after transient recovery/claim errors and executes queued work once",
  { skip: !databaseUrl, timeout: 15000 },
  async (t) => {
    const f = await jobsFixture();
    const records: Record<string, unknown>[] = [];
    t.mock.method(telemetry, "sink", (r) => records.push(r));
    try {
      const job = await f.jobs.create(f.actor, f.request, "retry");
      const recover = f.jobs.recover.bind(f.jobs),
        claim = f.jobs.claim.bind(f.jobs);
      let recoverAttempts = 0,
        claimAttempts = 0,
        calls = 0;
      const worker = new EvalWorker(
        f.jobs,
        new EvalExecutor({
          async execute(ctx) {
            calls++;
            await new EvalDemoRuntime().execute(ctx);
          },
        }),
      );
      t.mock.method(f.jobs, "recover", async () => {
        if (++recoverAttempts === 1)
          throw Object.assign(Error("credential-must-not-be-logged"), {
            code: "ECONNRESET",
          });
        await recover();
      });
      t.mock.method(f.jobs, "claim", async (owner: string) => {
        if (++claimAttempts === 1)
          throw Object.assign(Error("credential-must-not-be-logged"), {
            code: "57P03",
          });
        const result = await claim(owner);
        if (!result) worker.stop();
        return result;
      });
      await worker.start();
      assert.equal(calls, 1);
      assert.equal(
        (await f.jobs.job(f.actor.userId, job.jobId)).state,
        "COMPLETED",
      );
      assert.equal(records.length, 2);
      assert.ok(records.every((r) => r.code === "EVAL_DATABASE_TRANSIENT"));
      assert.doesNotMatch(
        JSON.stringify(records),
        /credential-must-not-be-logged/,
      );
    } finally {
      await f.close();
    }
  },
);
test("Eval Worker does not retry permanent schema errors", async () => {
  const fatal = Object.assign(Error("schema unavailable"), { code: "42P01" });
  let calls = 0;
  const store = {
    async recover() {
      calls++;
      throw fatal;
    },
  } as unknown as EvalJobStore;
  const worker = new EvalWorker(store, new EvalExecutor(new EvalDemoRuntime()));
  await assert.rejects(worker.start(), (e) => e === fatal);
  assert.equal(calls, 1);
});
