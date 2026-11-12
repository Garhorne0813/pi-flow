import type pg from "pg";
import { randomUUID } from "node:crypto";
import { Fault, type Actor } from "../domain/model.js";
import {
  policyFromEnv,
  type UsageRecord,
  type ModelUsage,
} from "../domain/usage.js";
import { checkUsageCaps } from "../domain/usage-budget.js";
import { personalConnection } from "../execution/personal-context.js";
import { PostgresEvalStore } from "./postgres-store.js";
import { digest } from "./dataset.js";
import {
  JobRequest,
  type EvalJob,
  type EvalSnapshot,
  type CaseRun,
  type CaseResult,
  type CaseState,
  type EvalEvent,
} from "./jobs.js";
import type { Page } from "./store.js";
import type { EvalAccess } from "./access.js";
const terminal = (s: string) => !["QUEUED", "RUNNING", "GRADING"].includes(s);
const micros = (
  u: ModelUsage,
  p: { input: number; output: number; cacheRead: number; cacheWrite: number },
) =>
  Math.ceil(
    u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.cacheRead +
      u.cacheWrite * p.cacheWrite,
  );
export class EvalJobStore extends PostgresEvalStore {
  constructor(
    pool: pg.Pool,
    readonly access: EvalAccess,
  ) {
    super(pool);
  }
  private async userLock(c: pg.PoolClient, user: string) {
    const r = await c.query(
      "SELECT user_id FROM personal_user_state WHERE user_id=$1 FOR NO KEY UPDATE",
      [user],
    );
    if (!r.rowCount) throw new Fault(404, "EVAL_USER_NOT_FOUND");
  }
  private scoped<T>(c: pg.PoolClient, fn: () => Promise<T>) {
    return personalConnection.run({ pool: this.pool, client: c }, fn);
  }
  private async event(
    c: pg.PoolClient,
    user: string,
    job: string,
    type: string,
    data: Record<string, unknown> = {},
  ) {
    const count = await c.query(
      "INSERT INTO personal_eval_event_counters(user_id,job_id,cursor) VALUES($1,$2,1) ON CONFLICT(user_id,job_id) DO UPDATE SET cursor=personal_eval_event_counters.cursor+1 RETURNING cursor",
      [user, job],
    );
    const event = {
      eventId: Number(count.rows[0].cursor),
      type,
      at: new Date().toISOString(),
      data,
    };
    await c.query(
      "INSERT INTO personal_eval_events(user_id,job_id,event_id,data) VALUES($1,$2,$3,$4)",
      [user, job, event.eventId, JSON.stringify(event)],
    );
  }
  private async saveUsage(c: pg.PoolClient, user: string, r: UsageRecord) {
    await c.query(
      "INSERT INTO personal_usage_requests(user_id,id,run_id,at,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data",
      [user, r.id, r.runId, r.at, JSON.stringify(r)],
    );
  }
  async create(a: Actor, raw: unknown, key: string) {
    const request = JobRequest.parse(raw),
      requestDigest = digest(request);
    const caseCap = Math.min(
        100,
        Number(process.env.EVAL_MAX_CASES_PER_JOB ?? 100),
      ),
      repeatCap = Math.min(3, Number(process.env.EVAL_MAX_REPEATS ?? 3));
    if (
      !Number.isInteger(caseCap) ||
      caseCap < 1 ||
      !Number.isInteger(repeatCap) ||
      repeatCap < 1
    )
      throw new Fault(503, "EVAL_INVALID_LIMITS");
    if (request.repeat > repeatCap) throw new Fault(400, "EVAL_REPEAT_LIMIT");
    return this.transaction((c) =>
      this.scoped(c, async () => {
        await this.userLock(c, a.userId);
        const old = (
          await c.query(
            "SELECT data,request_digest FROM personal_eval_jobs WHERE user_id=$1 AND idempotency_key=$2",
            [a.userId, key],
          )
        ).rows[0];
        if (old) {
          if (old.request_digest !== requestDigest)
            throw new Fault(409, "EVAL_IDEMPOTENCY_CONFLICT");
          await this.access.authorize(old.data);
          return old.data as EvalJob;
        }
        const snapshot = await this.access.snapshot(a, request.agentId);
        const version = (
          await c.query(
            "SELECT v.data FROM personal_eval_suite_versions v JOIN personal_eval_suites s USING(user_id,suite_id) WHERE v.user_id=$1 AND v.suite_id=$2 AND v.version=$3 AND NOT s.deleted",
            [a.userId, request.suiteId, request.suiteVersion],
          )
        ).rows[0]?.data;
        if (!version) throw new Fault(404, "EVAL_VERSION_NOT_FOUND");
        const cases = (
          await c.query(
            "SELECT data FROM personal_eval_cases WHERE user_id=$1 AND suite_id=$2 AND version=$3 ORDER BY position LIMIT 101",
            [a.userId, request.suiteId, request.suiteVersion],
          )
        ).rows.map((r) => r.data);
        if (
          !cases.length ||
          cases.length > 100 ||
          cases.length * request.repeat > caseCap
        )
          throw new Fault(400, "EVAL_CASE_LIMIT");
        if (
          cases.some((item) =>
            item.graders.some((g: { type: string }) => g.type === "llm_judge"),
          ) &&
          (!snapshot.judge || request.limits.maxJudgeCalls < 1)
        )
          throw new Fault(400, "EVAL_JUDGE_NOT_CONFIGURED");
        const jobId = randomUUID(),
          now = new Date().toISOString();
        // Identity is retained for live revocation; the API bearer token is never persisted.
        const actor: Actor = {
          tenantId: a.userId,
          userId: a.userId,
          issuer: a.issuer,
          subject: a.subject,
          admin: false,
        };
        const job: EvalJob = {
          jobId,
          userId: a.userId,
          actor,
          request,
          requestDigest,
          suiteDigest: version.specDigest,
          snapshot,
          configDigest: digest(snapshot),
          state: "QUEUED",
          createdAt: now,
        };
        const model =
            snapshot.config.model.provider +
            "/" +
            snapshot.config.model.modelId,
          price = snapshot.prices[model];
        if (!price) throw new Fault(503, "MODEL_PRICE_REQUIRED");
        const cost =
          price.input === 0 && price.output === 0 && !snapshot.judge
            ? 0
            : Math.ceil(request.limits.maxCostEstimateUsd * 1000000);
        const records = (
          await c.query(
            "SELECT data FROM personal_usage_requests WHERE user_id=$1 AND at >= $2",
            [a.userId, now.slice(0, 7)],
          )
        ).rows.map((r) => r.data);
        checkUsageCaps(
          records,
          policyFromEnv(),
          a.userId,
          request.limits.maxTokens,
          cost,
        );
        const hold: UsageRecord = {
          id: "eval-hold:" + jobId,
          runId: jobId,
          userId: a.userId,
          workspaceId: "",
          agentId: request.agentId,
          model,
          at: now,
          status: "reserved",
          estimatedTokens: request.limits.maxTokens,
          tokens: request.limits.maxTokens,
          maxOutputTokens: 0,
          estimatedCostMicros: cost,
          costMicros: cost,
          pricingVersion: price.version,
        };
        await this.saveUsage(c, a.userId, hold);
        await c.query(
          "INSERT INTO personal_eval_jobs(user_id,job_id,suite_id,suite_version,agent_id,state,request_digest,idempotency_key,data) VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7,$8)",
          [
            a.userId,
            jobId,
            request.suiteId,
            request.suiteVersion,
            request.agentId,
            requestDigest,
            key,
            JSON.stringify(job),
          ],
        );
        for (const item of cases)
          for (
            let repeatIndex = 0;
            repeatIndex < request.repeat;
            repeatIndex++
          ) {
            const run: CaseRun = {
              userId: a.userId,
              caseRunId: randomUUID(),
              jobId,
              caseId: item.caseId,
              repeatIndex,
              state: "QUEUED",
              case: item,
            };
            await c.query(
              "INSERT INTO personal_eval_case_runs(user_id,case_run_id,job_id,case_id,repeat_index,state,data) VALUES($1,$2,$3,$4,$5,'QUEUED',$6)",
              [
                a.userId,
                run.caseRunId,
                jobId,
                item.caseId,
                repeatIndex,
                JSON.stringify(run),
              ],
            );
          }
        await this.event(c, a.userId, jobId, "eval.job.created", {
          total: cases.length * request.repeat,
        });
        return job;
      }),
    );
  }
  async job(user: string, id: string): Promise<EvalJob> {
    const r = (
      await this.pool.query(
        "SELECT data,state,cancel_requested FROM personal_eval_jobs WHERE user_id=$1 AND job_id=$2",
        [user, id],
      )
    ).rows[0];
    if (!r) throw new Fault(404, "EVAL_JOB_NOT_FOUND");
    return { ...r.data, state: r.state, cancelRequested: r.cancel_requested };
  }
  async jobs(user: string, p: Page) {
    return (
      await this.pool.query(
        "SELECT data||jsonb_build_object('state',state,'cancelRequested',cancel_requested) AS data FROM personal_eval_jobs WHERE user_id=$1 ORDER BY created_at DESC,job_id LIMIT $2 OFFSET $3",
        [user, p.limit, p.offset],
      )
    ).rows.map((r) => r.data as EvalJob);
  }
  async caseRuns(user: string, id: string, p: Page): Promise<CaseRun[]> {
    await this.job(user, id);
    return (
      await this.pool.query(
        "SELECT data,state,result FROM personal_eval_case_runs WHERE user_id=$1 AND job_id=$2 ORDER BY created_at,case_run_id LIMIT $3 OFFSET $4",
        [user, id, p.limit, p.offset],
      )
    ).rows.map((r) => ({ ...r.data, state: r.state, result: r.result }));
  }
  async events(user: string, id: string, after: number): Promise<EvalEvent[]> {
    await this.job(user, id);
    return (
      await this.pool.query(
        "SELECT data FROM personal_eval_events WHERE user_id=$1 AND job_id=$2 AND event_id>$3 ORDER BY event_id LIMIT 100",
        [user, id, after],
      )
    ).rows.map((r) => r.data);
  }
  async claim(
    owner: string,
    leaseMs = 10000,
  ): Promise<{ job: EvalJob; run: CaseRun } | undefined> {
    return this.transaction((c) =>
      this.scoped(c, async () => {
        // Lock the same user frontier as budget writers; a locked user is skipped.
        const user = (
          await c.query(`SELECT u.user_id FROM personal_user_state u WHERE EXISTS(
    SELECT 1 FROM personal_eval_case_runs r JOIN personal_eval_jobs j USING(user_id,job_id)
    WHERE r.user_id=u.user_id AND r.state='QUEUED' AND j.state IN ('QUEUED','RUNNING') AND NOT j.cancel_requested
    AND NOT EXISTS(SELECT 1 FROM personal_eval_case_runs active WHERE active.user_id=u.user_id AND active.state IN ('RUNNING','GRADING')))
    ORDER BY (SELECT min(created_at) FROM personal_eval_case_runs q WHERE q.user_id=u.user_id AND q.state='QUEUED'),u.user_id FOR NO KEY UPDATE OF u SKIP LOCKED LIMIT 1`)
        ).rows[0]?.user_id;
        if (!user) return;
        const row = (
          await c.query(
            `SELECT r.data,j.data AS job FROM personal_eval_case_runs r JOIN personal_eval_jobs j USING(user_id,job_id)
    WHERE r.user_id=$1 AND r.state='QUEUED' AND j.state IN ('QUEUED','RUNNING') AND NOT j.cancel_requested
    ORDER BY (j.state='RUNNING') DESC,j.created_at,j.job_id,r.created_at,r.case_run_id FOR UPDATE OF r,j SKIP LOCKED LIMIT 1`,
            [user],
          )
        ).rows[0];
        if (!row) return;
        const job: EvalJob = row.job,
          run: CaseRun = row.data;
        run.state = "RUNNING";
        run.generation = randomUUID();
        run.leaseOwner = owner;
        job.state = "RUNNING";
        job.startedAt ??= new Date().toISOString();
        await c.query(
          "UPDATE personal_eval_jobs SET state='RUNNING',data=$3 WHERE user_id=$1 AND job_id=$2",
          [user, job.jobId, JSON.stringify(job)],
        );
        await c.query(
          "UPDATE personal_eval_case_runs SET state='RUNNING',lease_owner=$3,lease_generation=$4,lease_expires_at=now()+$5*interval '1 millisecond',data=$6 WHERE user_id=$1 AND case_run_id=$2",
          [
            user,
            run.caseRunId,
            owner,
            run.generation,
            leaseMs,
            JSON.stringify(run),
          ],
        );
        await this.event(c, user, job.jobId, "eval.case.started", {
          caseRunId: run.caseRunId,
        });
        return { job, run };
      }),
    );
  }
  private async fenced(c: pg.PoolClient, run: CaseRun) {
    const row = (
      await c.query(
        "SELECT r.state,j.cancel_requested,j.data AS job FROM personal_eval_case_runs r JOIN personal_eval_jobs j USING(user_id,job_id) WHERE r.user_id=$1 AND r.case_run_id=$2 AND r.lease_generation=$3 AND r.lease_owner=$4 AND r.lease_expires_at>now() AND r.state IN ('RUNNING','GRADING') FOR UPDATE OF r,j",
        [run.userId, run.caseRunId, run.generation, run.leaseOwner],
      )
    ).rows[0];
    if (!row) throw new Fault(409, "EVAL_LEASE_LOST");
    return row as { state: string; cancel_requested: boolean; job: EvalJob };
  }
  async heartbeat(run: CaseRun) {
    return this.transaction(async (c) => {
      await this.userLock(c, run.userId);
      const row = await this.fenced(c, run);
      if (row.cancel_requested) throw new Fault(409, "EVAL_CANCELLED");
      await c.query(
        "UPDATE personal_eval_case_runs SET lease_expires_at=now()+interval '10 seconds' WHERE user_id=$1 AND case_run_id=$2",
        [run.userId, run.caseRunId],
      );
    });
  }
  async grading(run: CaseRun) {
    await this.transaction(async (c) => {
      await this.userLock(c, run.userId);
      await this.fenced(c, run);
      await c.query(
        "UPDATE personal_eval_case_runs SET state='GRADING' WHERE user_id=$1 AND case_run_id=$2",
        [run.userId, run.caseRunId],
      );
      await this.event(
        c,
        run.userId,
        run.jobId,
        "eval.case.execution_completed",
        { caseRunId: run.caseRunId },
      );
    });
  }
  private async finishJob(c: pg.PoolClient, user: string, id: string) {
    const counts = (
      await c.query(
        "SELECT state,count(*)::int AS n FROM personal_eval_case_runs WHERE user_id=$1 AND job_id=$2 GROUP BY state",
        [user, id],
      )
    ).rows;
    if (counts.some((r) => !terminal(r.state))) return;
    const row = (
      await c.query(
        "SELECT data,cancel_requested FROM personal_eval_jobs WHERE user_id=$1 AND job_id=$2 FOR UPDATE",
        [user, id],
      )
    ).rows[0];
    const job: EvalJob = row.data;
    const total = counts.reduce((n, r) => n + r.n, 0),
      errors = counts
        .filter((r) => ["EXECUTION_ERROR", "GRADING_ERROR"].includes(r.state))
        .reduce((n, r) => n + r.n, 0);
    job.state = row.cancel_requested
      ? "CANCELLED"
      : errors === total
        ? "FAILED"
        : errors
          ? "PARTIAL"
          : "COMPLETED";
    job.endedAt = new Date().toISOString();
    await c.query(
      "UPDATE personal_eval_jobs SET state=$3,data=$4 WHERE user_id=$1 AND job_id=$2",
      [user, id, job.state, JSON.stringify(job)],
    );
    // Release only the unspent hold. Unknown request reservations remain charged.
    const hold = (
      await c.query(
        "SELECT data FROM personal_usage_requests WHERE user_id=$1 AND id=$2",
        [user, "eval-hold:" + id],
      )
    ).rows[0]?.data;
    if (hold) {
      hold.tokens = 0;
      hold.costMicros = 0;
      hold.status = "confirmed";
      await this.saveUsage(c, user, hold);
    }
    await this.event(
      c,
      user,
      id,
      job.state === "CANCELLED" ? "eval.job.cancelled" : "eval.job.completed",
      { state: job.state, total },
    );
  }
  async finish(run: CaseRun, state: CaseState, result: CaseResult) {
    if (!terminal(state)) throw new Error("INVALID_EVAL_TERMINAL_STATE");
    await this.transaction(async (c) => {
      await this.userLock(c, run.userId);
      const row = await this.fenced(c, run);
      if (row.cancel_requested) {
        state = "CANCELLED";
        result = { ...result, errorCode: "EVAL_CANCELLED" };
      }
      await c.query(
        "UPDATE personal_eval_case_runs SET state=$3,result=$4,lease_owner=NULL,lease_generation=NULL,lease_expires_at=NULL WHERE user_id=$1 AND case_run_id=$2",
        [run.userId, run.caseRunId, state, JSON.stringify(result)],
      );
      await c.query(
        "UPDATE personal_usage_requests SET data=jsonb_set(data,'{status}','\"unknown\"') WHERE user_id=$1 AND run_id=$2 AND data->>'caseRunId'=$3 AND data->>'status'='reserved'",
        [run.userId, run.jobId, run.caseRunId],
      );
      for (const score of result.scores ?? [])
        await c.query(
          "INSERT INTO personal_eval_scores(user_id,case_run_id,grader_id,data) VALUES($1,$2,$3,$4)",
          [run.userId, run.caseRunId, score.graderId, JSON.stringify(score)],
        );
      await this.event(c, run.userId, run.jobId, "eval.job.progress", {
        caseRunId: run.caseRunId,
        state,
      });
      await this.finishJob(c, run.userId, run.jobId);
    });
  }
  async cancel(user: string, id: string) {
    await this.transaction(async (c) => {
      await this.userLock(c, user);
      const row = (
        await c.query(
          "SELECT state FROM personal_eval_jobs WHERE user_id=$1 AND job_id=$2 FOR UPDATE",
          [user, id],
        )
      ).rows[0];
      if (!row) throw new Fault(404, "EVAL_JOB_NOT_FOUND");
      if (terminal(row.state)) return;
      await c.query(
        "UPDATE personal_eval_jobs SET cancel_requested=true WHERE user_id=$1 AND job_id=$2",
        [user, id],
      );
      await c.query(
        "UPDATE personal_eval_case_runs SET state='CANCELLED' WHERE user_id=$1 AND job_id=$2 AND state='QUEUED'",
        [user, id],
      );
      await this.event(c, user, id, "eval.job.cancel_requested");
      await this.finishJob(c, user, id);
    });
    return this.job(user, id);
  }
  async recover() {
    const rows = (
      await this.pool.query(
        "SELECT user_id,case_run_id FROM personal_eval_case_runs WHERE lease_expires_at<=now() ORDER BY lease_expires_at LIMIT 100",
      )
    ).rows;
    for (const r of rows)
      await this.transaction(async (c) => {
        await this.userLock(c, r.user_id);
        const row = (
          await c.query(
            "UPDATE personal_eval_case_runs SET state='EXECUTION_ERROR',result='{\"errorCode\":\"LEASE_LOST\"}',lease_owner=NULL,lease_generation=NULL,lease_expires_at=NULL WHERE user_id=$1 AND case_run_id=$2 AND lease_expires_at<=now() RETURNING job_id",
            [r.user_id, r.case_run_id],
          )
        ).rows[0];
        if (row) {
          await c.query(
            "UPDATE personal_usage_requests SET data=jsonb_set(data,'{status}','\"unknown\"') WHERE user_id=$1 AND run_id=$2 AND data->>'caseRunId'=$3 AND data->>'status'='reserved'",
            [r.user_id, row.job_id, r.case_run_id],
          );
          await this.event(c, r.user_id, row.job_id, "eval.case.failed", {
            caseRunId: r.case_run_id,
            errorCode: "LEASE_LOST",
          });
          await this.finishJob(c, r.user_id, row.job_id);
        }
      });
  }
  async reserve(run: CaseRun, role: "target" | "judge", input: number) {
    if (!Number.isSafeInteger(input) || input < 0)
      throw new Fault(500, "INVALID_USAGE_ESTIMATE");
    return this.transaction((c) =>
      this.scoped(c, async () => {
        await this.userLock(c, run.userId);
        const row = await this.fenced(c, run);
        if (row.cancel_requested) throw new Fault(409, "EVAL_CANCELLED");
        const job = row.job;
        await this.access.authorize(job);
        if (
          Date.now() >
          Date.parse(job.startedAt!) +
            job.request.limits.maxDurationSeconds * 1000
        )
          throw new Fault(429, "EVAL_JOB_DEADLINE");
        const prefix = `eval-${role}:${job.jobId}:`;
        const records = (
          await c.query(
            "SELECT data FROM personal_usage_requests WHERE user_id=$1 AND run_id=$2",
            [run.userId, job.jobId],
          )
        ).rows.map((r) => r.data as UsageRecord);
        if (
          records.filter((r) => r.id.startsWith(prefix)).length >=
          (role === "target"
            ? job.request.limits.maxModelCalls
            : job.request.limits.maxJudgeCalls)
        )
          throw new Fault(429, "EVAL_REQUEST_LIMIT");
        const snapshot = role === "judge" ? job.snapshot.judge : job.snapshot;
        if (!snapshot) throw new Fault(400, "EVAL_JUDGE_NOT_CONFIGURED");
        const model =
            snapshot.config.model.provider +
            "/" +
            snapshot.config.model.modelId,
          price = job.snapshot.prices[model];
        if (!price) throw new Fault(503, "MODEL_PRICE_REQUIRED");
        const hold = records.find((r) => r.id === "eval-hold:" + job.jobId)!;
        const caseUsed = records
          .filter(
            (r) =>
              (r as UsageRecord & { caseRunId?: string }).caseRunId ===
              run.caseRunId,
          )
          .reduce((n, r) => n + r.tokens, 0);
        const maxOutput = Math.min(
          4096,
          hold.tokens - input,
          snapshot.config.maxTokens - caseUsed - input,
        );
        if (maxOutput < 1) throw new Fault(429, "MODEL_BUDGET_EXCEEDED");
        const estimate: ModelUsage = {
            input,
            output: maxOutput,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: input + maxOutput,
          },
          cost = micros(estimate, price);
        if (cost > (hold.costMicros ?? 0))
          throw new Fault(429, "MODEL_COST_BUDGET_EXCEEDED");
        const record: UsageRecord & { caseRunId: string } = {
          id: prefix + randomUUID(),
          runId: job.jobId,
          userId: run.userId,
          workspaceId: "",
          agentId: job.request.agentId,
          model,
          at: new Date().toISOString(),
          status: "reserved",
          estimatedTokens: estimate.totalTokens,
          tokens: estimate.totalTokens,
          maxOutputTokens: maxOutput,
          estimatedCostMicros: cost,
          costMicros: cost,
          pricingVersion: price.version,
          price,
          caseRunId: run.caseRunId,
        };
        hold.tokens -= record.tokens;
        hold.costMicros = (hold.costMicros ?? 0) - cost;
        await this.saveUsage(c, run.userId, hold);
        await this.saveUsage(c, run.userId, record);
        return { id: record.id, maxOutputTokens: maxOutput };
      }),
    );
  }
  async settle(
    user: string,
    id: string,
    usage: ModelUsage | undefined,
    durationMs: number,
  ) {
    await this.transaction(async (c) => {
      await this.userLock(c, user);
      const row = (
        await c.query(
          "SELECT data FROM personal_usage_requests WHERE user_id=$1 AND id=$2 FOR UPDATE",
          [user, id],
        )
      ).rows[0];
      if (!row) throw new Fault(404, "USAGE_REQUEST_NOT_FOUND");
      const r: UsageRecord = row.data;
      if (r.status === "confirmed") return;
      const valid =
        usage &&
        [
          usage.input,
          usage.output,
          usage.cacheRead,
          usage.cacheWrite,
          usage.totalTokens,
        ].every((v) => Number.isSafeInteger(v) && v >= 0) &&
        usage.totalTokens > 0;
      r.durationMs = durationMs;
      if (!valid) r.status = "unknown";
      else {
        const oldTokens = r.tokens,
          oldCost = r.costMicros ?? 0;
        r.status = "confirmed";
        r.usage = {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          totalTokens: usage.totalTokens,
        };
        r.tokens = Math.max(
          usage.totalTokens,
          usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        );
        r.costMicros = r.price ? micros(usage, r.price) : null;
        const job = (
          await c.query(
            "SELECT state FROM personal_eval_jobs WHERE user_id=$1 AND job_id=$2",
            [user, r.runId],
          )
        ).rows[0];
        if (job && !terminal(job.state)) {
          const hold = (
            await c.query(
              "SELECT data FROM personal_usage_requests WHERE user_id=$1 AND id=$2",
              [user, "eval-hold:" + r.runId],
            )
          ).rows[0].data;
          hold.tokens = Math.max(0, hold.tokens + oldTokens - r.tokens);
          hold.costMicros = Math.max(
            0,
            hold.costMicros + oldCost - (r.costMicros ?? oldCost),
          );
          await this.saveUsage(c, user, hold);
        }
      }
      await this.saveUsage(c, user, r);
    });
  }
  async usage(user: string, id: string) {
    await this.job(user, id);
    return (
      await this.pool.query(
        "SELECT data FROM personal_usage_requests WHERE user_id=$1 AND run_id=$2 AND id<>$3 ORDER BY at,id",
        [user, id, "eval-hold:" + id],
      )
    ).rows.map((r) => {
      const v: UsageRecord = r.data;
      return {
        id: v.id,
        role: v.id.startsWith("eval-judge:") ? "judge" : "target",
        status: v.status,
        tokens: v.tokens,
        costMicros: v.costMicros,
        durationMs: v.durationMs,
        caseRunId: r.data.caseRunId,
      };
    });
  }
}
