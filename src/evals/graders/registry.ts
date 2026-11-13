import { compileEvalSchema } from "./schema.js";
import { canonical, digest } from "../dataset.js";
import {
  GraderConfig,
  EvalScore,
  type EvalInput,
  type ToolCallRecord,
} from "../types.js";
export const NATIVE_GRADER_VERSION = "5";
const version = NATIVE_GRADER_VERSION;
const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function ignore(v: unknown, fields: string[]): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  return Object.fromEntries(
    Object.entries(v).filter(([k]) => !fields.includes(k)),
  );
}
const matches = (
  actual: ToolCallRecord,
  expected: { name: string; args?: Record<string, unknown> },
) =>
  actual.name === expected.name &&
  (expected.args === undefined ||
    (actual.argsDigest !== undefined
      ? actual.argsDigest === digest(expected.args)
      : same(actual.args, expected.args)));
export async function grade(
  input: EvalInput,
  raw: unknown,
  context: { signal: AbortSignal },
): Promise<EvalScore> {
  let graderId = "invalid";
  try {
    const c = GraderConfig.parse(raw);
    graderId = c.id;
    context.signal.throwIfAborted();
    let pass: boolean;
    const calls = [...input.trajectory].sort((a, b) => a.sequence - b.sequence);
    if (new Set(calls.map((c) => c.sequence)).size !== calls.length)
      throw new Error("INVALID_TRACE_SEQUENCE");
    switch (c.type) {
      case "exact":
        pass = same(input.output, c.expected);
        break;
      case "contains": {
        if (typeof input.output !== "string")
          throw new Error("TEXT_OUTPUT_REQUIRED");
        pass = c.caseSensitive
          ? input.output.includes(c.value)
          : input.output.toLowerCase().includes(c.value.toLowerCase());
        break;
      }
      case "json_match": {
        const expected = c.expected;
        let output: unknown;
        try {
          output = json(input.output);
        } catch {
          pass = false;
          break;
        }
        pass = same(
          ignore(output, c.ignoreFields),
          ignore(expected, c.ignoreFields),
        );
        break;
      }
      case "json_schema": {
        const validate = compileEvalSchema(c.schema);
        let output: unknown;
        try {
          output = json(input.output);
        } catch {
          pass = false;
          break;
        }
        pass = !!validate(output);
        break;
      }
      case "tool_called":
      case "tool_not_called": {
        const count = calls.filter(
          (call) =>
            matches(call, c) &&
            (c.type === "tool_not_called" || call.status === "COMPLETED"),
        ).length;
        pass =
          c.type === "tool_not_called"
            ? count === 0
            : count >= c.min && (c.max === undefined || count <= c.max);
        break;
      }
      case "trajectory": {
        if (c.mode === "strict")
          pass =
            calls.length === c.calls.length &&
            calls.every((a, i) => matches(a, c.calls[i]!));
        else {
          // Bipartite matching preserves multiplicity even with overlapping argument constraints.
          const left = c.mode === "superset" ? calls : c.calls,
            right = c.mode === "superset" ? c.calls : calls;
          const owner = new Map<number, number>();
          const visit = (i: number, seen: Set<number>): boolean => {
            for (let j = 0; j < right.length; j++) {
              const match =
                c.mode === "superset"
                  ? matches(left[i] as ToolCallRecord, right[j]!)
                  : matches(right[j] as ToolCallRecord, left[i]!);
              if (!match || seen.has(j)) continue;
              seen.add(j);
              if (!owner.has(j) || visit(owner.get(j)!, seen)) {
                owner.set(j, i);
                return true;
              }
            }
            return false;
          };
          pass = left.every((_, i) => visit(i, new Set()));
          if (c.mode === "unordered") pass &&= calls.length === c.calls.length;
        }
        break;
      }
      case "latency":
      case "tokens":
      case "cost": {
        if (c.type !== "latency" && input.metrics.usageConfirmed === false)
          throw new Error("METRIC_UNAVAILABLE");
        const value =
          c.type === "latency"
            ? input.metrics.durationMs
            : c.type === "tokens"
              ? input.metrics.tokens
              : input.metrics.costEstimate;
        if (value === undefined || !Number.isFinite(value) || value < 0)
          throw new Error("METRIC_UNAVAILABLE");
        pass = value <= c.max;
        break;
      }
      case "llm_judge":
        throw new Error("JUDGE_NOT_CONFIGURED");
    }
    return EvalScore.parse({
      graderId,
      graderVersion: version,
      status: pass ? "PASSED" : "FAILED",
      score: pass ? 1 : 0,
      pass,
    });
  } catch {
    return {
      graderId,
      graderVersion: version,
      status: "ERROR",
      score: null,
      pass: null,
      reason: context.signal.aborted ? "GRADING_ABORTED" : "GRADER_ERROR",
    };
  }
}
export function aggregate(
  scores: EvalScore[],
  configs: GraderConfig[],
  threshold = 1,
) {
  const weighted = scores.flatMap((s) => {
    const c = configs.find((c) => c.id === s.graderId);
    return c && c.weight > 0 && s.score !== null
      ? [{ score: s.score, weight: c.weight }]
      : [];
  });
  const score = weighted.length
    ? weighted.reduce((n, s) => n + s.score * s.weight, 0) /
      weighted.reduce((n, s) => n + s.weight, 0)
    : null;
  const error =
    scores.length !== configs.length ||
    scores.some((s) => {
      const c = configs.find((c) => c.id === s.graderId);
      return (
        !c ||
        ((c.weight > 0 || c.hard) &&
          (s.status === "ERROR" || s.status === "SKIPPED"))
      );
    }) ||
    score === null;
  const hardFail = scores.some((s) => {
    const c = configs.find((c) => c.id === s.graderId);
    return (
      s.pass === false && (c?.hard || (c?.type === "llm_judge" && c.weight > 0))
    );
  });
  return {
    score,
    pass: !error && !hardFail && score! >= threshold,
    state: error
      ? ("GRADING_ERROR" as const)
      : !hardFail && score! >= threshold
        ? ("PASSED" as const)
        : ("FAILED_ASSERTION" as const),
  };
}
