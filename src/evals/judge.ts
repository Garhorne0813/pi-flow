import { z } from "zod";
import { Fault } from "../domain/model.js";
import type { Runtime } from "../execution/runtime.js";
import { EvalExecutor } from "./executor.js";
import type { EvalJobStore } from "./job-store.js";
import type { Judge } from "./worker.js";
import { JUDGE_TEMPLATE_VERSION } from "./judge-template.js";
import { digest } from "./dataset.js";
const Response = z
  .object({
    score: z.number().finite().min(0).max(1),
    passed: z.boolean(),
    reason: z.string().max(2000),
    evidence: z.array(z.string().max(500)).max(8),
  })
  .strict();
const redact = (s: string) =>
  s.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
export class JudgeGateway {
  constructor(
    private store: EvalJobStore,
    private runtime: Runtime,
  ) {}
  readonly grade: Judge = async (run, job, input, config, signal) => {
    const snapshot = job.snapshot.judge;
    const version = digest({
      template: JUDGE_TEMPLATE_VERSION,
      judge: snapshot?.version,
      rubric: config.type === "llm_judge" ? config.rubric : "",
      threshold: config.type === "llm_judge" ? config.threshold : null,
    });
    const error = (code: string) => ({
      graderId: config.id,
      graderVersion: version,
      status: "ERROR" as const,
      score: null,
      pass: null,
      reason: code,
    });
    if (
      !snapshot ||
      config.type !== "llm_judge" ||
      process.env.EVAL_JUDGE_ENABLED !== "true"
    )
      return error("EVAL_JUDGE_DISABLED");
    const prompt = JSON.stringify({
      rubric: config.rubric,
      threshold: config.threshold,
      input: input.input,
      reference: input.reference,
      output: input.output,
    });
    if (Buffer.byteLength(prompt) > 200000)
      return error("EVAL_JUDGE_INPUT_LIMIT");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.store.access.authorize(job);
        const result = await new EvalExecutor(this.runtime).execute({
          config: snapshot.config,
          case: { ...run.case, inputs: prompt },
          mocks: {},
          signal,
          authorize: () => this.store.access.authorize(job),
          gateway: await this.store.access.gateway(snapshot),
          temperature: 0,
          budget: {
            beforeModelRequest: (n) => this.store.reserve(run, "judge", n),
            recordModelUsage: (id, usage, ms) =>
              this.store.settle(run.userId, id, usage, ms),
          },
        });
        let data: z.infer<typeof Response>;
        try {
          data = Response.parse(JSON.parse(result.output));
        } catch {
          if (attempt === 0) continue;
          return error("EVAL_JUDGE_INVALID_RESPONSE");
        }
        const pass = data.passed && data.score >= config.threshold;
        return {
          graderId: config.id,
          graderVersion: version,
          status: pass ? "PASSED" : "FAILED",
          score: data.score,
          pass,
          reason: redact(data.reason),
          metadata: {
            evidence: data.evidence.map(redact),
            judgeVersion: snapshot.version,
            attempts: attempt + 1,
          },
        };
      } catch (e) {
        return error(
          signal.aborted
            ? "EVAL_JUDGE_TIMEOUT"
            : e instanceof Fault && e.status === 429
              ? "EVAL_JUDGE_BUDGET_EXCEEDED"
              : "EVAL_JUDGE_EXECUTION_FAILED",
        );
      }
    }
    return error("EVAL_JUDGE_INVALID_RESPONSE");
  };
}
