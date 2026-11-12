import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Fault } from "../domain/model.js";
import type { Runtime } from "../execution/runtime.js";
import type { CaseRun, EvalJob } from "./jobs.js";
import type { EvalScore, GraderConfig, EvalInput } from "./types.js";
import { EvalExecutor } from "./executor.js";
import { grade, aggregate } from "./graders/registry.js";
import type { EvalJobStore } from "./job-store.js";
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
        .authorize(job)
        .then(() => this.store.heartbeat(run))
        .catch((e) => revoked.abort(e))
        .finally(() => {
          checking = false;
        });
    }, 1000);
    const pipeline = async () => {
      const result = await this.executor.execute({
        config: job.snapshot.config,
        case: run.case,
        mocks: run.case.mocks,
        signal,
        authorize: async (tool) => {
          signal.throwIfAborted();
          await this.store.access.authorize(job, tool);
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
      await this.store.grading(run);
      grading = true;
      const input: EvalInput = {
        caseId: run.caseId,
        input: run.case.inputs,
        reference: run.case.reference,
        ...result,
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
      const summary = aggregate(scores, run.case.graders);
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
          : e instanceof Fault
            ? e.code
            : e instanceof Error && /^EVAL_[A-Z_]+$/.test(e.message)
              ? e.message
              : "EVAL_EXECUTION_FAILED";
      try {
        await this.store.finish(
          run,
          grading ? "GRADING_ERROR" : "EXECUTION_ERROR",
          { errorCode: code },
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
    while (!this.stopping.signal.aborted) {
      if (!(await this.tick()))
        await delay(250, undefined, { signal: this.stopping.signal }).catch(
          () => {},
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
