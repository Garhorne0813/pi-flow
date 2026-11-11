import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectCollectionStorage,
  collectionInventoryAlerts,
} from "../src/skills/collection-inventory.js";
import { collectionPath } from "../src/skills/collection.js";

function fixture() {
  const prefix = "/pi-flow/collections";
  const location = { selectionId: "a".repeat(64), artifact: "b".repeat(32) };
  const orphan = { selectionId: "c".repeat(64), artifact: "d".repeat(32) };
  const root = prefix.slice(1) + "/";
  const marker = root + `ready/${location.selectionId}.json`;
  const data = new Map([
    [marker, Buffer.from(JSON.stringify(location))],
    [
      collectionPath(prefix, location).slice(1) + "/SKILL.md",
      Buffer.from("manifest"),
    ],
    [
      collectionPath(prefix, location).slice(1) + "/script.sh",
      Buffer.from("script"),
    ],
    [
      collectionPath(prefix, orphan).slice(1) + "/script.sh",
      Buffer.from("unreferenced"),
    ],
    ["outside/private.txt", Buffer.from("private content")],
  ]);
  const gets: string[] = [],
    lists: string[] = [];
  const io = {
    async list(under: string) {
      lists.push(under);
      return {
        files: [...data]
          .filter(([key]) => key.startsWith(under))
          .map(([key, value]) => ({ key, size: value.length })),
        cursor: undefined as string | undefined,
      };
    },
    async get(key: string) {
      gets.push(key);
      const value = data.get(key);
      return value ? { data: value, executable: false } : undefined;
    },
    async put() {
      throw Error("inspection must never write");
    },
    async remove() {
      throw Error("inspection must never delete");
    },
  };
  return { prefix, location, orphan, root, marker, data, io, gets, lists };
}

test("collection inspection reports actual current objects without reading Skill contents or deleting candidates", async () => {
  const f = fixture();
  const report = await inspectCollectionStorage(f.prefix, f.io);
  assert.equal(report.complete, true);
  assert.equal(report.readyCollections, 1);
  assert.equal(report.artifacts, 2);
  assert.equal(report.observedObjects, 4);
  assert.equal(
    report.logicalBytes,
    [...f.data]
      .filter(([key]) => key.startsWith(f.root))
      .reduce((sum, [, data]) => sum + data.length, 0),
  );
  assert.equal(report.unreferencedArtifacts, 1);
  assert.equal(report.unreferencedBytes, Buffer.byteLength("unreferenced"));
  assert.deepEqual(report.candidates[0], {
    ...f.orphan,
    files: 1,
    bytes: Buffer.byteLength("unreferenced"),
  });
  assert.deepEqual(f.gets, [f.marker]);
  assert.deepEqual(f.lists, [f.root]);
  assert.equal(f.data.size, 5);
  assert.ok(!JSON.stringify(report).includes("private content"));
  assert.deepEqual(
    collectionInventoryAlerts(report, { warnBytes: 1, warnCollections: 1 }),
    [
      "collection_bytes_threshold",
      "collection_count_threshold",
      "unreferenced_artifacts_require_reconciliation",
    ],
  );
});

test("incomplete, corrupt and interrupted inspections cannot report a healthy storage inventory", async () => {
  const f = fixture();
  const partial = await inspectCollectionStorage(f.prefix, f.io, {
    maxObjects: 1,
  });
  assert.equal(partial.complete, false);
  assert.equal(partial.observedObjects, 1);
  assert.ok(
    collectionInventoryAlerts(partial, {
      warnBytes: 100000,
      warnCollections: 1000,
    }).includes("inspection_incomplete"),
  );
  f.data.set(f.marker, Buffer.from("invalid JSON"));
  const corrupt = await inspectCollectionStorage(f.prefix, f.io);
  assert.equal(corrupt.complete, false);
  assert.equal(corrupt.invalidReadyPointers, 1);
  f.io.list = async () => {
    throw Error("SDK credential details must not be exposed");
  };
  const failed = await inspectCollectionStorage(f.prefix, f.io);
  assert.equal(failed.complete, false);
  assert.ok(!JSON.stringify(failed).includes("credential"));
  await assert.rejects(
    inspectCollectionStorage(f.prefix, f.io, { maxObjects: 0 }),
  );
  assert.throws(() =>
    collectionInventoryAlerts(failed, { warnBytes: NaN, warnCollections: 1 }),
  );
});

test("inventory pagination loops and unclassified objects require manual reconciliation", async () => {
  const f = fixture();
  f.io.list = async () => ({ files: [], cursor: "repeated" });
  assert.equal(
    (await inspectCollectionStorage(f.prefix, f.io)).complete,
    false,
  );
  const g = fixture();
  g.data.set(g.root + "unknown-file", Buffer.from("unknown"));
  const result = await inspectCollectionStorage(g.prefix, g.io);
  assert.equal(result.unclassifiedObjects, 1);
  assert.ok(
    collectionInventoryAlerts(result, {
      warnBytes: 100000,
      warnCollections: 1000,
    }).includes("unclassified_objects_require_reconciliation"),
  );
});
