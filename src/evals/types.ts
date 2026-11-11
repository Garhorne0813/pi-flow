import { z } from "zod";

export const JsonValue: z.ZodType<unknown> = z.json();
const text = z.string().max(64000);
const tool = z.string().min(1).max(128);
const expectedCall = z
  .object({ name: tool, args: z.record(z.string(), JsonValue).optional() })
  .strict();
const common = {
  id: z.string().min(1).max(128),
  weight: z.number().finite().min(0).max(100).default(1),
  hard: z.boolean().default(false),
};
export const GraderConfig = z.discriminatedUnion("type", [
  z
    .object({ ...common, type: z.literal("exact"), expected: JsonValue })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("contains"),
      value: text,
      caseSensitive: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("json_match"),
      expected: JsonValue,
      ignoreFields: z.array(z.string().min(1).max(128)).max(100).default([]),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("json_schema"),
      schema: z.union([z.boolean(), z.record(z.string(), JsonValue)]),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.enum(["tool_called", "tool_not_called"]),
      name: tool,
      min: z.number().int().nonnegative().default(1),
      max: z.number().int().nonnegative().optional(),
      args: z.record(z.string(), JsonValue).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("trajectory"),
      mode: z.enum(["strict", "unordered", "subset", "superset"]),
      calls: z.array(expectedCall).max(100),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.enum(["latency", "tokens", "cost"]),
      max: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("llm_judge"),
      rubric: text.min(1),
      threshold: z.number().min(0).max(1).default(0.5),
    })
    .strict(),
]);
export type GraderConfig = z.infer<typeof GraderConfig>;
export const EvalCase = z
  .object({
    caseId: z.string().min(1).max(128),
    inputs: text,
    mocks: z
      .object({
        read: JsonValue.optional(),
        ls: JsonValue.optional(),
        grep: JsonValue.optional(),
        find: JsonValue.optional(),
      })
      .strict()
      .default({}),
    reference: JsonValue.optional(),
    graders: z.array(GraderConfig).min(1).max(32),
    tags: z.array(z.string().max(64)).max(32).default([]),
    weight: z.number().finite().min(0).max(100).default(1),
    passThreshold: z.number().finite().min(0).max(1).default(0.5),
    timeoutMs: z.number().int().min(100).max(120000).default(60000),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (new Set(c.graders.map((g) => g.id)).size !== c.graders.length)
      ctx.addIssue({ code: "custom", message: "Duplicate grader IDs" });
  });
export type EvalCase = z.infer<typeof EvalCase>;
export interface ToolCallRecord {
  sequence: number;
  callId: string;
  name: string;
  args?: Record<string, unknown>;
  argsDigest?: string;
  status: "COMPLETED" | "FAILED" | "DENIED";
  errorCode?: string;
}
export interface EvalInput {
  caseId: string;
  input: unknown;
  output: unknown;
  reference?: unknown;
  trajectory: ToolCallRecord[];
  metrics: { durationMs: number; tokens: number; costEstimate?: number };
}
export const EvalScore = z
  .object({
    graderId: z.string(),
    graderVersion: z.string(),
    status: z.enum(["PASSED", "FAILED", "ERROR", "SKIPPED"]),
    score: z.number().finite().min(0).max(1).nullable(),
    pass: z.boolean().nullable(),
    reason: z.string().max(2000).optional(),
    metadata: z.record(z.string(), JsonValue).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const scored = s.status === "PASSED" || s.status === "FAILED";
    if (
      scored
        ? s.score === null || s.pass !== (s.status === "PASSED")
        : s.score !== null || s.pass !== null
    )
      ctx.addIssue({ code: "custom", message: "Inconsistent score status" });
  });
export type EvalScore = z.infer<typeof EvalScore>;
export interface EvalGrader {
  type: string;
  version: string;
  grade(
    input: EvalInput,
    config: GraderConfig,
    context: { signal: AbortSignal },
  ): Promise<EvalScore>;
}
