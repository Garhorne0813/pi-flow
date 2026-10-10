import test from "node:test";
import assert from "node:assert/strict";
import { DeltaBatcher } from "../src/delta-batcher.js";
test("delta batches preserve text and flush before completion with bounded chunk sizes", async () => {
  const records: { type: string; data: any }[] = [];
  const batcher = new DeltaBatcher(
    async (type, data) => {
      records.push({ type, data });
    },
    () => {},
    32,
    10000,
    10,
  );
  const text = "你好😃 abc".repeat(100);
  for (const char of text) await batcher.emit("message.delta", { delta: char });
  await batcher.emit("message.completed", { final: true });
  assert.equal(
    records
      .slice(0, -1)
      .map((r) => r.data.delta)
      .join(""),
    text,
  );
  assert.equal(records.at(-1)?.type, "message.completed");
  assert.ok(records.length < 100);
  assert.ok(records.slice(0, -1).every((r) => r.data.delta.length <= 32));
});
test("slow persistence has a bounded backlog and errors reject flush rather than dropping text", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const batcher = new DeltaBatcher(
    async () => {
      await gate;
    },
    () => {},
    8,
    32,
    10,
  );
  batcher.push("x".repeat(32));
  assert.throws(() => batcher.push("y"), { code: "STREAM_BACKPRESSURE_LIMIT" });
  release();
  await batcher.flush();
  let failure: unknown;
  const broken = new DeltaBatcher(
    async () => {
      throw new Error("write failed");
    },
    (e) => (failure = e),
    8,
    32,
    1,
  );
  broken.push("text");
  await assert.rejects(broken.flush(), /write failed/);
  assert.ok(failure);
});
