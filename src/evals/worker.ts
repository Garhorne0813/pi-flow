import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Fault } from "../domain/model.js";
import type { Runtime } from "../execution/runtime.js";
import type { CaseRun, EvalJob } from "./jobs.js";
import type { EvalScore, GraderConfig, EvalInput } from "./types.js";
import { EvalExecutor, EvalExecutionError } from "./executor.js";
import { grade, aggregate, NATIVE_GRADER_VERSION } from "./graders/registry.js";
import type { EvalJobStore } from "./job-store.js";
import { telemetry } from "../observability/telemetry.js";
function transientDatabaseError(error: unknown) {
  let current = error;
  for (
    let depth = 0;
    depth < 3 && current && typeof current === "object";
    depth++
  ) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (
      typeof e.code === "string" &&
      (/^08[A-Z0-9]{3}$/.test(e.code) ||
        [
          "40001",
          "40P01",
          "53300",
          "57P01",
          "57P02",
          "57P03",
          "57014",
          "ECONNRESET",
          "ECONNREFUSED",
          "EPIPE",
          "ETIMEDOUT",
          "ENETUNREACH",
          "EHOSTUNREACH",
        ].includes(e.code))
    )
      return true;
    if (
      typeof e.message === "string" &&
      /^(Connection terminated unexpectedly|Connection terminated due to connection timeout|timeout exceeded when trying to connect)$/.test(
        e.message,
      )
    )
      return true;
    current = e.cause;
  }
  return false;
}
export type Judge = (
  run: CaseRun,
  job: EvalJob,
  input: EvalInput,
  config: GraderConfig,
  signal: AbortSignal,
) => Promise<EvalScore>;
export class EvalWorker {
  readonly owner = randomUUID();
  private stopping = new AbortController();
  constructor(
    readonly store: EvalJobStore,
    private executor: EvalExecutor,
    private judge?: Judge,
  ) {}
  async tick() {
    await this.store.recover();
    if (this.stopping.signal.aborted) return false;
    const claimed = await this.store.claim(this.owner);
    if (!claimed) return false;
    const { job, run } = claimed;
    const remaining =
      Date.parse(job.startedAt!) +
      job.request.limits.maxDurationSeconds * 1000 -
      Date.now();
    const deadline = AbortSignal.timeout(
      Math.max(1, Math.min(run.case.timeoutMs, remaining)),
    );
    const revoked = new AbortController(),
      signal = AbortSignal.any([
        this.stopping.signal,
        deadline,
        revoked.signal,
      ]);
    let checking = false,
      grading = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.store.access
        .authorize(job, undefined, true)
        .then(() => this.store.heartbeat(run))
        .catch((e) => revoked.abort(e))
        .finally(() => {
          checking = false;
        });
    }, 1000);
    const pipeline = async () => {
      if (job.snapshot.graderVersion !== NATIVE_GRADER_VERSION)
        throw new Fault(409, "EVAL_GRADER_VERSION_UNAVAILABLE");
      const result = await this.executor.execute({
        config: job.snapshot.config,
        onTool: (type, data) => this.store.toolEvent(run, type, data),
        case: run.case,
        mocks: run.case.mocks,
        signal,
        authorize: async (tool) => {
          signal.throwIfAborted();
          await this.store.access.authorize(job, tool, true);
          await this.store.heartbeat(run);
        },
        gateway: await this.store.access.gateway(job.snapshot),
        budget: {
          beforeModelRequest: (input) =>
            this.store.reserve(run, "target", input),
          recordModelUsage: (id, usage, ms) =>
            this.store.settle(run.userId, id, usage, ms),
        },
      });
      await this.store.grading(run, result);
      grading = true;
      const targetUsage = (
        await this.store.usage(run.userId, run.jobId)
      ).filter((u) => u.caseRunId === run.caseRunId && u.role === "target");
      const usageConfirmed =
        targetUsage.length > 0 &&
        targetUsage.every((u) => u.status === "confirmed");
      Object.assign(result.metrics, { usageConfirmed });
      const costEstimate =
        usageConfirmed && targetUsage.every((u) => u.costMicros !== null)
          ? targetUsage.reduce((n, u) => n + (u.costMicros ?? 0), 0) / 1000000
          : undefined;
      if (usageConfirmed)
        result.metrics.tokens = targetUsage.reduce((n, u) => n + u.tokens, 0);
      const input: EvalInput = {
        caseId: run.caseId,
        input: run.case.inputs,
        reference: run.case.reference,
        ...result,
        metrics: { ...result.metrics, costEstimate, usageConfirmed },
      };
      const scores: EvalScore[] = [];
      for (const config of run.case.graders) {
        signal.throwIfAborted();
        scores.push(
          config.type === "llm_judge" && this.judge
            ? await this.judge(run, job, input, config, signal)
            : await grade(input, config, { signal }),
        );
      }
      const summary = aggregate(
        scores,
        run.case.graders,
        run.case.passThreshold,
      );
      await this.store.finish(run, summary.state, {
        ...result,
        scores,
        score: summary.score,
        pass: summary.pass,
      });
    };
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(signal.reason);
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    try {
      await Promise.race([pipeline(), aborted]);
    } catch (e) {
      // Keep errors categorical: provider messages may contain request data or credentials.
      const code = deadline.aborted
        ? "EVAL_TIMEOUT"
        : revoked.signal.aborted
          ? "EVAL_ACCESS_OR_LEASE_LOST"
          : e instanceof EvalExecutionError
            ? e.message
            : e instanceof Fault
              ? e.code
              : e instanceof Error && /^EVAL_[A-Z_]+$/.test(e.message)
                ? e.message
                : "EVAL_EXECUTION_FAILED";
      try {
        await this.store.finish(
          run,
          grading ? "GRADING_ERROR" : "EXECUTION_ERROR",
          {
            errorCode: code,
            ...(e instanceof EvalExecutionError
              ? { trajectory: e.trajectory }
              : {}),
          },
        );
      } catch (error) {
        if (!(error instanceof Fault && error.code === "EVAL_LEASE_LOST"))
          throw error;
      }
    } finally {
      clearInterval(timer);
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
    return true;
  }
  async start() {
    let backoff = 250;
    while (!this.stopping.signal.aborted) {
      let pause = 250;
      try {
        const worked = await this.tick();
        backoff = 250;
        if (worked) continue;
      } catch (error) {
        if (this.stopping.signal.aborted) break;
        if (!transientDatabaseError(error)) throw error;
        telemetry.count("eval_database_retries_total");
        telemetry.error(
          "eval_poll",
          new Fault(503, "EVAL_DATABASE_TRANSIENT"),
          { workerId: this.owner },
        );
        pause = backoff;
        backoff = Math.min(5000, backoff * 2);
      }
      await delay(pause, undefined, { signal: this.stopping.signal }).catch(
        (error) => {
          if (!this.stopping.signal.aborted) throw error;
        },
      );
    }
  }
  stop() {
    this.stopping.abort(new Error("EVAL_WORKER_STOPPED"));
  }
}
export class EvalDemoRuntime implements Runtime {
  async execute(ctx: Parameters<Runtime["execute"]>[0]) {
    ctx.signal.throwIfAborted();
    const ticket = await ctx.beforeModelRequest?.(10);
    if (ticket) await ctx.recordModelUsage?.(ticket.id, undefined, 0);
    // Demo deliberately leaves the request reservation unknown: no vendor usage exists.
    await ctx.consume(10, true);
    await ctx.emit("message.completed", {
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "text", text: `Demo harness response: ${ctx.prompt}` },
        ],
      },
    });
  }
}
