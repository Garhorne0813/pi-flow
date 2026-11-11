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
    "ERROR",
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
