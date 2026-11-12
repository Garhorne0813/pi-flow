import test from "node:test";
import assert from "node:assert/strict";
import { MemoryEvalStore } from "../src/evals/memory-store.js";
import { EvalService } from "../src/evals/service.js";
import { Fault } from "../src/domain/model.js";
const actor = { tenantId: "u", userId: "u", admin: true };
const draft = {
  name: "Dataset",
  cases: [
    {
      caseId: "c",
      inputs: "hello",
      graders: [{ id: "g", type: "exact", expected: "hello" }],
    },
  ],
};
test("eval datasets freeze historical versions, reject stale revisions and preserve history after deletion", async () => {
  const store = new MemoryEvalStore(),
    service = new EvalService(store, async () => {});
  const suite = await service.createSuite(actor, draft);
  const v = await store.publish("u", suite.id, 1);
  await assert.rejects(
    store.publish("u", suite.id, 1),
    (e) => e instanceof Fault && e.status === 409,
  );
  await service.patchSuite(actor, suite.id, {
    ...draft,
    revision: 2,
    cases: [{ ...draft.cases[0], inputs: "new" }],
  });
  assert.equal(
    (await store.cases("u", suite.id, 1, { offset: 0, limit: 1 }))[0]!.inputs,
    "hello",
  );
  assert.equal((await store.publish("u", suite.id, 3)).version, 2);
  assert.notEqual(
    v.specDigest,
    (await store.version("u", suite.id, 2)).specDigest,
  );
  await store.deleteSuite("u", suite.id);
  assert.equal(
    (await store.listSuites("u", { offset: 0, limit: 10 })).length,
    0,
  );
  assert.equal((await store.version("u", suite.id, 1)).version, 1);
  assert.deepEqual(
    (await store.versions("u", suite.id, { offset: 0, limit: 1 })).map(
      (v) => v.version,
    ),
    [2],
  );
  assert.deepEqual(
    (await store.versions("u", suite.id, { offset: 1, limit: 1 })).map(
      (v) => v.version,
    ),
    [1],
  );
  await assert.rejects(
    store.versions("other", suite.id, { offset: 0, limit: 10 }),
    /EVAL_SUITE_NOT_FOUND/,
  );
});
test("eval dataset tenant scope ignores administrator privileges and paginates", async () => {
  const store = new MemoryEvalStore(),
    service = new EvalService(store, async () => {});
  const suite = await service.createSuite(actor, draft);
  await store.publish("u", suite.id, 1);
  assert.deepEqual(
    await store.listSuites("other", { offset: 0, limit: 1 }),
    [],
  );
  for (const action of [
    () => store.getSuite("other", suite.id),
    () => store.version("other", suite.id, 1),
    () => store.cases("other", suite.id, 1, { offset: 0, limit: 1 }),
    () => store.deleteSuite("other", suite.id),
  ])
    await assert.rejects(action, (e) => e instanceof Fault && e.status === 404);
  assert.deepEqual(
    await store.cases("u", suite.id, 1, { offset: 1, limit: 1 }),
    [],
  );
  await assert.rejects(
    service.createSuite({ ...actor, expiresAt: 1 }, draft),
    (e) => e instanceof Fault && e.status === 401,
  );
});

test("metadata-only draft PATCH preserves cases and still advances the optimistic revision", async () => {
  const store = new MemoryEvalStore(),
    service = new EvalService(store, async () => {});
  const suite = await service.createSuite(actor, draft);
  const updated = await service.patchSuite(actor, suite.id, {
    revision: 1,
    name: "Renamed",
  });
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.cases.length, 1);
  assert.equal(updated.draftRevision, 2);
});
