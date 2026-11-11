import { z } from "zod";
import type { Actor, AgentConfig } from "../domain/model.js";
import type { Policy, ModelUsage } from "../domain/usage.js";
import type { EvalCase, EvalScore, ToolCallRecord } from "./types.js";
export const JobRequest = z
  .object({
    suiteId: z.uuid(),
    suiteVersion: z.number().int().positive(),
    agentId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    agentConfigSource: z.literal("current").default("current"),
    repeat: z.number().int().min(1).max(3).default(1),
    executionProfile: z.literal("mocked").default("mocked"),
    limits: z
      .object({
        maxTokens: z.number().int().min(100).max(1000000).default(20000),
        maxDurationSeconds: z.number().int().min(1).max(900).default(900),
        maxModelCalls: z.number().int().min(1).max(100).default(30),
        maxJudgeCalls: z.number().int().min(0).max(100).default(0),
        maxCostEstimateUsd: z.number().finite().positive().max(10).default(1),
      })
      .strict()
      .default({
        maxTokens: 20000,
        maxDurationSeconds: 900,
        maxModelCalls: 30,
        maxJudgeCalls: 0,
        maxCostEstimateUsd: 1,
      }),
  })
  .strict();
export type JobRequest = z.infer<typeof JobRequest>;
export type EvalSnapshot = {
  config: AgentConfig;
  gatewayRef: string | null;
  skillDigests: Record<string, string>;
  bundleDigest: string;
  graderVersion: string;
  profile: "mocked";
  prices: Policy["prices"];
  judge?: { config: AgentConfig; gatewayRef: string | null; version: string };
};
export type EvalJob = {
  jobId: string;
  userId: string;
  actor: Actor;
  request: JobRequest;
  requestDigest: string;
  configDigest: string;
  suiteDigest: string;
  snapshot: EvalSnapshot;
  state:
    | "QUEUED"
    | "RUNNING"
    | "COMPLETED"
    | "PARTIAL"
    | "FAILED"
    | "CANCELLED";
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  cancelRequested?: boolean;
  summary?: unknown;
};
export type CaseState =
  | "QUEUED"
  | "RUNNING"
  | "GRADING"
  | "PASSED"
  | "FAILED_ASSERTION"
  | "EXECUTION_ERROR"
  | "GRADING_ERROR"
  | "CANCELLED";
export type CaseResult = {
  output?: string;
  trajectory?: ToolCallRecord[];
  metrics?: { tokens: number; durationMs: number; costEstimate?: number };
  scores?: EvalScore[];
  score?: number | null;
  pass?: boolean;
  errorCode?: string;
};
export type CaseRun = {
  userId: string;
  caseRunId: string;
  jobId: string;
  caseId: string;
  repeatIndex: number;
  state: CaseState;
  generation?: string;
  leaseOwner?: string;
  case: EvalCase;
  result?: CaseResult;
};
export type EvalEvent = {
  eventId: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
};
export type RequestUsage = {
  id: string;
  role: "target" | "judge";
  status: string;
  tokens: number;
  costMicros: number | null;
  usage?: ModelUsage;
};
