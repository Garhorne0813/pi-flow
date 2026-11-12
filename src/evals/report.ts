import type { CaseRun, EvalJob } from "./jobs.js";
import { digest } from "./dataset.js";
const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const quantile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!
    : null;
};
type Usage = {
  role: string;
  status: string;
  tokens: number;
  costMicros: number | null;
  durationMs?: number;
};
export function report(job: EvalJob, cases: CaseRun[], usage: Usage[]) {
  const total = cases.length,
    count = (state: string) => cases.filter((r) => r.state === state).length;
  const graded = cases.filter((r) =>
      ["PASSED", "FAILED_ASSERTION"].includes(r.state),
    ),
    scores = graded.flatMap((r) =>
      r.result?.score !== null && r.result?.score !== undefined
        ? [r.result.score]
        : [],
    );
  const weightedTotal = cases.reduce((n, r) => n + r.case.weight, 0);
  const weightedGraded = graded.reduce(
    (n, r) => n + (typeof r.result?.score === "number" ? r.case.weight : 0),
    0,
  );
  const weightedScore = graded.reduce(
    (n, r) => n + (r.result?.score ?? 0) * r.case.weight,
    0,
  );
  const byGrader: Record<
    string,
    { count: number; errors: number; avgScore: number | null }
  > = {};
  for (const r of cases)
    for (const s of r.result?.scores ?? []) {
      const key = s.graderId + "@" + s.graderVersion;
      const g = (byGrader[key] ??= { count: 0, errors: 0, avgScore: null });
      if (s.status === "ERROR") g.errors++;
      if (s.score !== null) {
        g.avgScore = ((g.avgScore ?? 0) * g.count + s.score) / (g.count + 1);
        g.count++;
      }
    }
  const performance = (role: string) => {
    const rows = usage.filter((u) => u.role === role);
    return {
      requests: rows.length,
      tokens: rows.reduce((n, u) => n + u.tokens, 0),
      costEstimateUsd: rows.some((u) => u.costMicros === null)
        ? null
        : rows.reduce((n, u) => n + (u.costMicros ?? 0), 0) / 1000000,
      estimated: rows.some((u) => u.status !== "confirmed"),
      unknownRequests: rows.filter((u) => u.status !== "confirmed").length,
      durationP50Ms: quantile(
        rows.flatMap((u) => (u.durationMs !== undefined ? [u.durationMs] : [])),
        0.5,
      ),
      durationP95Ms: quantile(
        rows.flatMap((u) => (u.durationMs !== undefined ? [u.durationMs] : [])),
        0.95,
      ),
    };
  };
  const repeatGroups = new Map<string, CaseRun[]>();
  for (const r of cases) {
    const rows = repeatGroups.get(r.caseId) ?? [];
    rows.push(r);
    repeatGroups.set(r.caseId, rows);
  }
  return {
    jobId: job.jobId,
    state: job.state,
    denominators: {
      total,
      graded: graded.length,
      weightedTotal,
      weightedGraded,
    },
    passed: count("PASSED"),
    passRate: weightedTotal
      ? cases.reduce(
          (n, r) => n + (r.state === "PASSED" ? r.case.weight : 0),
          0,
        ) / weightedTotal
      : null,
    unweightedPassRate: total ? count("PASSED") / total : null,
    executionErrorRate: total ? count("EXECUTION_ERROR") / total : null,
    gradingErrorRate: total ? count("GRADING_ERROR") / total : null,
    cancellationRate: total ? count("CANCELLED") / total : null,
    completedCaseCount: graded.length,
    terminalCaseCount: cases.filter(
      (r) => !["QUEUED", "RUNNING", "GRADING"].includes(r.state),
    ).length,
    avgScoreOnGraded: weightedGraded ? weightedScore / weightedGraded : null,
    unweightedAvgScoreOnGraded: mean(scores),
    timeoutCount: cases.filter((r) => r.result?.errorCode?.includes("TIMEOUT"))
      .length,
    unknownOutcomeCount: cases.filter(
      (r) => r.result?.errorCode === "LEASE_LOST",
    ).length,
    deniedToolCalls: cases.reduce(
      (n, r) =>
        n +
        (r.result?.trajectory?.filter((t) => t.status === "DENIED").length ??
          0),
      0,
    ),
    caseDurationP50Ms: quantile(
      cases.flatMap((r) =>
        r.result?.metrics ? [r.result.metrics.durationMs] : [],
      ),
      0.5,
    ),
    caseDurationP95Ms: quantile(
      cases.flatMap((r) =>
        r.result?.metrics ? [r.result.metrics.durationMs] : [],
      ),
      0.95,
    ),
    target: performance("target"),
    judge: performance("judge"),
    graders: byGrader,
    repeats: [...repeatGroups].map(([caseId, rows]) => {
      const values = rows.flatMap((r) =>
        ["PASSED", "FAILED_ASSERTION"].includes(r.state) &&
        typeof r.result?.score === "number"
          ? [r.result.score]
          : [],
      );
      const requested = Math.max(job.request.repeat, rows.length);
      const complete = values.length === requested;
      const avg = mean(values);
      return {
        caseId,
        requested,
        count: values.length,
        ungraded: requested - values.length,
        executionErrors: rows.filter((r) => r.state === "EXECUTION_ERROR")
          .length,
        gradingErrors: rows.filter((r) => r.state === "GRADING_ERROR").length,
        cancelled: rows.filter((r) => r.state === "CANCELLED").length,
        pending:
          requested -
          rows.length +
          rows.filter((r) => ["QUEUED", "RUNNING", "GRADING"].includes(r.state))
            .length,
        complete,
        mean: avg,
        variance:
          complete && avg !== null
            ? mean(values.map((v) => (v - avg) ** 2))
            : null,
      };
    }),
    execution: {
      profile: job.snapshot.profile,
      skillsLoaded: false,
      networkTools: false,
      productionWorkspace: false,
    },
    failures: cases
      .filter((r) =>
        ["EXECUTION_ERROR", "GRADING_ERROR", "FAILED_ASSERTION"].includes(
          r.state,
        ),
      )
      .map((r) => ({
        caseRunId: r.caseRunId,
        caseId: r.caseId,
        repeatIndex: r.repeatIndex,
        state: r.state,
        errorCode: r.result?.errorCode,
      })),
  };
}
export function compare(
  baseline: EvalJob,
  candidate: EvalJob,
  before: CaseRun[],
  after: CaseRun[],
) {
  const warnings: string[] = [];
  if (
    baseline.suiteDigest !== candidate.suiteDigest ||
    baseline.request.suiteId !== candidate.request.suiteId ||
    baseline.request.suiteVersion !== candidate.request.suiteVersion
  )
    warnings.push("SUITE_VERSION_DIFFERS");
  if (baseline.snapshot.graderVersion !== candidate.snapshot.graderVersion)
    warnings.push("GRADER_VERSION_DIFFERS");
  if (baseline.snapshot.judge?.version !== candidate.snapshot.judge?.version)
    warnings.push("JUDGE_CONFIGURATION_DIFFERS");
  if (
    digest({
      profile: baseline.snapshot.profile,
      skills: baseline.snapshot.skillDigests,
      bundle: baseline.snapshot.bundleDigest,
    }) !==
    digest({
      profile: candidate.snapshot.profile,
      skills: candidate.snapshot.skillDigests,
      bundle: candidate.snapshot.bundleDigest,
    })
  )
    warnings.push("EXECUTION_ENVIRONMENT_DIFFERS");
  if (baseline.request.repeat !== candidate.request.repeat)
    warnings.push("REPEAT_COUNT_DIFFERS");
  if (
    [baseline, candidate].some((j) => ["RUNNING", "QUEUED"].includes(j.state))
  )
    warnings.push("JOB_INCOMPLETE");
  const key = (r: CaseRun) => JSON.stringify([r.caseId, r.repeatIndex]);
  const old = new Map(before.map((r) => [key(r), r])),
    next = new Map(after.map((r) => [key(r), r]));
  const pairs = [...new Set([...old.keys(), ...next.keys()])].map((k) => {
    const b = old.get(k),
      a = next.get(k);
    return {
      caseId: (a ?? b)!.caseId,
      repeatIndex: (a ?? b)!.repeatIndex,
      weight: (a ?? b)!.case.weight,
      baselineState: b?.state ?? "MISSING",
      candidateState: a?.state ?? "MISSING",
      scoreDelta:
        typeof a?.result?.score === "number" &&
        typeof b?.result?.score === "number"
          ? a.result.score - b.result.score
          : null,
      regression:
        (a ?? b)!.case.weight > 0 &&
        b?.state === "PASSED" &&
        a?.state !== "PASSED",
      improvement:
        (a ?? b)!.case.weight > 0 &&
        b !== undefined &&
        ["PASSED", "FAILED_ASSERTION"].includes(b.state) &&
        typeof b.result?.score === "number" &&
        Number.isFinite(b.result.score) &&
        a?.state === "PASSED" &&
        b?.state !== "PASSED",
    };
  });
  if (
    pairs.some(
      (p) => p.baselineState === "MISSING" || p.candidateState === "MISSING",
    )
  )
    warnings.push("CASE_SET_DIFFERS");
  if (!pairs.some((p) => p.weight > 0)) warnings.push("NO_WEIGHTED_CASES");
  if (
    baseline.state === "CANCELLED" ||
    baseline.state === "FAILED" ||
    before.some(
      (r) =>
        r.case.weight > 0 &&
        (!["PASSED", "FAILED_ASSERTION"].includes(r.state) ||
          typeof r.result?.score !== "number" ||
          !Number.isFinite(r.result.score)),
    )
  )
    warnings.push("BASELINE_NOT_GRADED");
  const comparable = warnings.length === 0;
  const candidateErrors = after.some(
    (r) =>
      r.case.weight > 0 &&
      ["EXECUTION_ERROR", "GRADING_ERROR", "CANCELLED"].includes(r.state),
  );
  return {
    baselineJobId: baseline.jobId,
    candidateJobId: candidate.jobId,
    comparable,
    warnings,
    pairs,
    gate: comparable
      ? !candidateErrors &&
        !pairs.some(
          (p) =>
            p.weight > 0 &&
            (p.regression || (p.scoreDelta !== null && p.scoreDelta < 0)),
        )
      : null,
  };
}
