import test from "node:test";
import assert from "node:assert/strict";
import { grade, aggregate } from "../src/evals/graders/registry.js";
import {
  EvalCase,
  EvalScore,
  GraderConfig,
  type EvalInput,
} from "../src/evals/types.js";
import { digest, freezeDataset } from "../src/evals/dataset.js";
import { EvalToolGateway } from "../src/evals/tool-gateway.js";
const input: EvalInput = {
  caseId: "c",
  input: "hello",
  output: "Hello",
  trajectory: [],
  metrics: { durationMs: 100, tokens: 20 },
};
const run = (config: unknown, changes: Partial<EvalInput> = {}) =>
  grade({ ...input, ...changes }, config, {
    signal: new AbortController().signal,
  });
test("json_match expected strings stay JSON values rather than serialized JSON text", async () => {
  for (const expected of [
    "42",
    "hello",
    "null",
    "true",
    '{"a":1}',
    "",
    '"quoted"',
  ]) {
    const grader = { id: "g", type: "json_match", expected };
    assert.equal(
      (await run(grader, { output: JSON.stringify(expected) })).status,
      "PASSED",
      expected,
    );
    assert.equal(
      (await run(grader, { output: '{"a":1}' })).status,
      "FAILED",
      expected,
    );
  }
});
test("positive tool assertions count completed calls while negative checks include denied/failed attempts", async () => {
  for (const status of ["DENIED", "FAILED", "COMPLETED"] as const) {
    const trajectory = [
      { sequence: 1, callId: "one", name: "read", args: { path: "x" }, status },
    ];
    assert.equal(
      (
        await run(
          { id: "g", type: "tool_called", name: "read", args: { path: "x" } },
          { trajectory },
        )
      ).pass,
      status === "COMPLETED",
    );
    assert.equal(
      (
        await run(
          {
            id: "g",
            type: "tool_not_called",
            name: "read",
            args: { path: "x" },
          },
          { trajectory },
        )
      ).pass,
      false,
    );
  }
});
test("tool assertions compare original argument digests while traces stay redacted", async () => {
  const tools = new EvalToolGateway(
    { read: "fixture" },
    ["read"],
    async () => {},
  );
  const args = { path: "a".repeat(1100), token: "fixture-secret" };
  await tools.call("read", args, "read-1");
  await assert.rejects(tools.call("bash", { command: "env" }, "denied"));
  const trajectory = tools.trace.calls;
  assert.equal(trajectory[0]!.args!.token, "[REDACTED]");
  assert.equal(JSON.stringify(trajectory).includes("fixture-secret"), false);
  assert.equal(
    (
      await run(
        { id: "g", type: "tool_called", name: "read", args },
        { trajectory },
      )
    ).pass,
    true,
  );
  assert.equal(
    (
      await run(
        {
          id: "g",
          type: "tool_called",
          name: "read",
          args: { ...args, token: "wrong" },
        },
        { trajectory },
      )
    ).pass,
    false,
  );
  // A redacted display value must never satisfy an assertion for a different raw value.
  assert.equal(
    (
      await run(
        {
          id: "g",
          type: "tool_called",
          name: "read",
          args: trajectory[0]!.args,
        },
        { trajectory },
      )
    ).pass,
    false,
  );
  assert.equal(
    (
      await run(
        {
          id: "g",
          type: "tool_not_called",
          name: "bash",
          args: { command: "env" },
        },
        { trajectory },
      )
    ).pass,
    false,
  );
  for (const mode of ["strict", "unordered", "subset", "superset"]) {
    assert.equal(
      (
        await run(
          {
            id: "g",
            type: "trajectory",
            mode,
            calls: [{ name: "read", args }],
          },
          { trajectory: trajectory.slice(0, 1) },
        )
      ).pass,
      true,
      mode,
    );
  }
});
test("eval exact and JSON retain types and missing fields, normalize object order", async () => {
  assert.equal(
    (await run({ id: "g", type: "exact", expected: "hello" })).status,
    "FAILED",
  );
  assert.equal(
    (
      await run(
        { id: "g", type: "exact", expected: { b: 2, a: 1 } },
        { output: { a: 1, b: 2 } },
      )
    ).pass,
    true,
  );
  assert.equal(
    (
      await run(
        { id: "g", type: "json_match", expected: { a: 1, b: 2 } },
        { output: '{"a":1}' },
      )
    ).pass,
    false,
  );
  assert.equal(
    (
      await run(
        {
          id: "g",
          type: "json_match",
          expected: { a: 1, t: 2 },
          ignoreFields: ["t"],
        },
        { output: '{"a":1,"t":3}' },
      )
    ).pass,
    true,
  );
  assert.equal(
    (
      await run(
        { id: "g", type: "json_match", expected: {} },
        { output: "invalid" },
      )
    ).status,
    "FAILED",
  );
});
test("eval contains is explicitly case sensitive; schemas reject remote refs", async () => {
  assert.equal(
    (await run({ id: "g", type: "contains", value: "hello" })).pass,
    false,
  );
  assert.equal(
    (
      await run({
        id: "g",
        type: "contains",
        value: "hello",
        caseSensitive: false,
      })
    ).pass,
    true,
  );
  assert.equal(
    (
      await run(
        {
          id: "g",
          type: "json_schema",
          schema: {
            type: "object",
            properties: { a: { type: "number" } },
            required: ["a"],
          },
        },
        { output: "{}" },
      )
    ).pass,
    false,
  );
  assert.equal(
    (
      await run({
        id: "g",
        type: "json_schema",
        schema: { $ref: "https://example.com/schema" },
      })
    ).status,
    "ERROR",
  );
});
test("schema restrictions apply to keywords, not property names or literal JSON data", async () => {
  const schema = {
    type: "object",
    properties: {
      format: { type: "string" },
      pattern: { type: "string" },
      literal: { const: { pattern: "data", $ref: "https://example.com/data" } },
    },
    required: ["format", "pattern", "literal"],
  };
  assert.equal(
    (
      await run(
        { id: "g", type: "json_schema", schema },
        {
          output: JSON.stringify({
            format: "json",
            pattern: "plain",
            literal: { pattern: "data", $ref: "https://example.com/data" },
          }),
        },
      )
    ).status,
    "PASSED",
  );
  for (const nested of [
    { properties: { value: { type: "string", pattern: "(a+)+$" } } },
    { definitions: { x: { $ref: "https://example.com/schema" } } },
    { items: [{ type: "string", format: "email" }] },
    { allOf: [{ properties: { x: { patternProperties: {} } } }] },
  ]) {
    assert.equal(
      (await run({ id: "g", type: "json_schema", schema: nested })).status,
      "ERROR",
    );
  }
});
const trajectory: EvalInput["trajectory"] = [
  { sequence: 2, callId: "b", name: "ls", status: "COMPLETED" },
  {
    sequence: 1,
    callId: "a",
    name: "read",
    args: { path: "/fixture" },
    status: "COMPLETED",
  },
];
test("eval trajectory uses sequence, arguments and multiset cardinality", async () => {
  const calls = [{ name: "read", args: { path: "/fixture" } }, { name: "ls" }];
  assert.equal(
    (
      await run(
        { id: "g", type: "trajectory", mode: "strict", calls },
        { trajectory },
      )
    ).pass,
    true,
  );
  assert.equal(
    (
      await run(
        {
          id: "g",
          type: "trajectory",
          mode: "strict",
          calls: [...calls].reverse(),
        },
        { trajectory },
      )
    ).pass,
    false,
  );
  assert.equal(
    (
      await run(
        {
          id: "g",
          type: "trajectory",
          mode: "unordered",
          calls: [...calls].reverse(),
        },
        { trajectory },
      )
    ).pass,
    true,
  );
  assert.equal(
    (
      await run(
        {
          id: "g",
          type: "trajectory",
          mode: "subset",
          calls: [calls[0], calls[0]],
        },
        { trajectory },
      )
    ).pass,
    false,
  );
  assert.equal(
    (
      await run(
        {
          id: "g",
          type: "tool_called",
          name: "read",
          args: { path: "/other" },
        },
        { trajectory },
      )
    ).pass,
    false,
  );
  assert.equal(
    (
      await run(
        { id: "g", type: "tool_not_called", name: "bash", hard: true },
        { trajectory },
      )
    ).pass,
    true,
  );
  assert.equal((await run({ id: "g", type: "cost", max: 1 })).status, "ERROR");
});
test("eval aggregation never turns grader failures or observation-only checks into passes", async () => {
  const configs = [
    GraderConfig.parse({
      id: "g",
      type: "exact",
      expected: "Hello",
      weight: 0,
    }),
  ];
  const scores = [await run(configs[0])];
  assert.equal(aggregate(scores, configs).state, "GRADING_ERROR");
  assert.equal(
    EvalScore.safeParse({
      graderId: "g",
      graderVersion: "1",
      status: "ERROR",
      pass: false,
      score: 0,
    }).success,
    false,
  );
  configs[0]!.weight = 1;
  const hard = GraderConfig.parse({
    id: "hard",
    type: "tool_not_called",
    name: "read",
    hard: true,
    weight: 0,
  });
  assert.equal(
    aggregate(
      [...scores, await run(hard, { trajectory })],
      [...configs, hard],
      0,
    ).state,
    "FAILED_ASSERTION",
  );
});
test("eval cases are bounded single-turn data and versions are detached", () => {
  const c = EvalCase.parse({
    caseId: "c",
    inputs: "hi",
    graders: [{ id: "g", type: "exact", expected: "hi" }],
  });
  assert.throws(() => freezeDataset([]));
  assert.throws(() => freezeDataset([c, c]));
  assert.equal(
    EvalCase.safeParse({ ...c, inputs: [{ role: "user", content: "hi" }] })
      .success,
    false,
  );
  const frozen = freezeDataset([c]);
  c.inputs = "changed";
  assert.equal(frozen.cases[0]!.inputs, "hi");
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.equal(
    GraderConfig.safeParse({ id: "g", type: "javascript", code: "return true" })
      .success,
    false,
  );
});

test("trajectory inclusion matches overlapping constraints without reusing observations", async () => {
  const trajectory: EvalInput["trajectory"] = [
    {
      sequence: 1,
      callId: "1",
      name: "read",
      args: { path: "a" },
      status: "COMPLETED",
    },
    {
      sequence: 2,
      callId: "2",
      name: "read",
      args: { path: "b" },
      status: "COMPLETED",
    },
  ];
  assert.equal(
    (
      await run(
        {
          id: "g",
          type: "trajectory",
          mode: "subset",
          calls: [{ name: "read" }, { name: "read", args: { path: "a" } }],
        },
        { trajectory },
      )
    ).pass,
    true,
  );
  assert.equal(
    (
      await run(
        {
          id: "g",
          type: "trajectory",
          mode: "superset",
          calls: [{ name: "read" }],
        },
        { trajectory: trajectory.slice(0, 1) },
      )
    ).pass,
    true,
  );
  assert.equal(
    (
      await run(
        {
          id: "g",
          type: "trajectory",
          mode: "superset",
          calls: [{ name: "read" }],
        },
        { trajectory },
      )
    ).pass,
    false,
  );
  assert.equal(
    (
      await run({
        id: "g",
        type: "json_schema",
        schema: { type: "string", pattern: "(a+)+$" },
      })
    ).status,
    "ERROR",
  );
});

test("observation errors remain evidence without vetoing weighted quality", async () => {
  const quality = GraderConfig.parse({
    id: "quality",
    type: "exact",
    expected: "Hello",
  });
  const observed = GraderConfig.parse({
    id: "observe",
    type: "llm_judge",
    rubric: "quality",
    weight: 0,
  });
  const scores: EvalScore[] = [
    await run(quality),
    {
      graderId: "observe",
      graderVersion: "test",
      status: "ERROR",
      score: null,
      pass: null,
    },
  ];
  assert.equal(aggregate(scores, [quality, observed]).state, "PASSED");
  assert.equal(
    aggregate(scores, [quality, { ...observed, hard: true }]).state,
    "GRADING_ERROR",
  );
  assert.equal(
    aggregate(scores, [quality, { ...observed, weight: 1 }]).state,
    "GRADING_ERROR",
  );
  assert.equal(aggregate([scores[1]!], [observed]).state, "GRADING_ERROR");
});
test("unknown usage cannot be used for precise token/cost assertions", async () => {
  for (const type of ["tokens", "cost"]) {
    assert.equal(
      (
        await run(
          { id: "g", type, max: 20 },
          {
            metrics: {
              durationMs: 1,
              tokens: 10,
              costEstimate: 0,
              usageConfirmed: false,
            },
          },
        )
      ).status,
      "ERROR",
    );
    assert.equal(
      (
        await run(
          { id: "g", type, max: 20 },
          {
            metrics: {
              durationMs: 1,
              tokens: 10,
              costEstimate: 0,
              usageConfirmed: true,
            },
          },
        )
      ).status,
      "PASSED",
    );
  }
});
