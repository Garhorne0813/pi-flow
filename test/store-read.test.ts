import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";

test("Memory reads are detached snapshots, do not create tenants, and callbacks can overlap", async () => {
  const store = new MemoryStore();
  await store.read("absent", (s) => {
    s.sequence = 99;
  });
  assert.deepEqual(await store.tenants(), []);
  await store.tx("tenant", (s) => {
    s.sequence = 7;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered = 0;
  const reads = [1, 2].map(() =>
    store.read("tenant", async (s) => {
      entered++;
      await gate;
      s.sequence = 123;
      return s;
    }),
  );
  try {
    for (let i = 0; i < 20 && entered < 2; i++)
      await new Promise<void>((r) => setImmediate(r));
    assert.equal(entered, 2);
    await store.tx("tenant", (s) => {
      s.sequence = 8;
    });
  } finally {
    release();
  }
  const snapshots = await Promise.all(reads);
  snapshots[0]!.sequence = 500;
  assert.equal(await store.read("tenant", (s) => s.sequence), 8);
  await assert.rejects(
    store.read("tenant", (s) => {
      s.sequence = 999;
      throw Error("read failure");
    }),
  );
  assert.equal(await store.read("tenant", (s) => s.sequence), 8);
});
