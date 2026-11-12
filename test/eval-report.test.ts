import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AgentConfig } from "../src/domain/model.js";
import { EvalCase } from "../src/evals/types.js";
import { JobRequest, type EvalJob, type CaseRun } from "../src/evals/jobs.js";
import { report, compare } from "../src/evals/report.js";
const job: EvalJob = {
  jobId: randomUUID(),
  userId: "u",
  actor: { tenantId: "u", userId: "u", admin: false },
  request: JobRequest.parse({
    suiteId: randomUUID(),
    suiteVersion: 1,
    agentId: "assistant",
    repeat: 3,
  }),
  requestDigest: "r",
  configDigest: "c",
  suiteDigest: "s",
  state: "COMPLETED",
  createdAt: new Date().toISOString(),
  snapshot: {
    config: AgentConfig.parse({
      name: "agent",
      systemPrompt: "",
      model: { provider: "demo", modelId: "demo" },
      tools: [],
    }),
    gatewayRef: null,
    skillDigests: {},
    bundleDigest: "b",
    graderVersion: "3",
    profile: "mocked",
    prices: {},
  },
};
function row(
  caseId: string,
  weight: number,
  score: number | null,
  state: CaseRun["state"] = "PASSED",
  repeatIndex = 0,
): CaseRun {
  return {
    userId: "u",
    jobId: job.jobId,
    caseRunId: randomUUID(),
    caseId,
    repeatIndex,
    state,
    case: EvalCase.parse({
      caseId,
      weight,
      inputs: "test",
      graders: [{ id: "g", type: "exact", expected: "test" }],
    }),
    result: { score },
  };
}
test("case weights affect Suite quality and gates while raw denominators remain explicit", () => {
  const rows = [
    row("heavy", 9, 1),
    row("light", 1, 0, "FAILED_ASSERTION"),
    row("observe", 0, 0, "FAILED_ASSERTION"),
  ];
  const r = report(job, rows, []);
  assert.equal(r.passRate, 0.9);
  assert.equal(r.avgScoreOnGraded, 0.9);
  assert.equal(r.unweightedPassRate, 1 / 3);
  assert.equal(r.denominators.total, 3);
  assert.equal(r.denominators.weightedTotal, 10);
  const before = [row("heavy", 1, 1), row("observe", 0, 1)];
  for (const state of [
    "FAILED_ASSERTION",
    "EXECUTION_ERROR",
    "GRADING_ERROR",
    "CANCELLED",
  ] as const) {
    assert.equal(
      compare(job, job, before, [before[0]!, row("observe", 0, null, state)])
        .gate,
      true,
    );
  }
  assert.equal(
    compare(
      job,
      job,
      [row("observe", 0, 1)],
      [row("observe", 0, 0, "FAILED_ASSERTION")],
    ).gate,
    null,
  );
  assert.equal(report(job, [row("observe", 0, 1)], []).passRate, null);
  assert.equal(
    compare(job, job, before, [
      row("heavy", 1, 0, "FAILED_ASSERTION"),
      before[1]!,
    ]).gate,
    false,
  );
});
test("repeat statistics disclose incomplete and ungraded runs, including all-error groups", () => {
  const rows = [
    row("unstable", 1, 1),
    row("unstable", 1, null, "EXECUTION_ERROR", 1),
    row("unstable", 1, null, "CANCELLED", 2),
    row("errors", 1, null, "GRADING_ERROR"),
  ];
  const repeats = report(job, rows, []).repeats;
  const r = repeats.find((r) => r.caseId === "unstable")!;
  assert.equal(r.requested, 3);
  assert.equal(r.count, 1);
  assert.equal(r.ungraded, 2);
  assert.equal(r.executionErrors, 1);
  assert.equal(r.cancelled, 1);
  assert.equal(r.complete, false);
  assert.equal(r.mean, 1);
  assert.equal(r.variance, null);
  const errors = repeats.find((r) => r.caseId === "errors")!;
  assert.equal(errors.requested, 3);
  assert.equal(errors.count, 0);
  assert.equal(errors.ungraded, 3);
  assert.equal(errors.gradingErrors, 1);
  assert.equal(errors.mean, null);
  const complete = report(
    job,
    [0, 1, 2].map((i) => row("stable", 1, 1, "PASSED", i)),
    [],
  ).repeats[0]!;
  assert.equal(complete.complete, true);
  assert.equal(complete.variance, 0);
});
