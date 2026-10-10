import assert from "node:assert/strict";
import { buildAPI } from "../../src/api.js";
import { event, Fault } from "../../src/domain.js";
import { SandboxManager, DemoSandbox } from "../../src/adapters/sandbox.js";
import { fixture } from "./fixture.js";

export async function sseHistoryReplay() {
  const f = await fixture();
  let waits = 0,
    pages = 0;
  const originalPage = f.store.eventPage.bind(f.store);
  f.store.eventPage = async (...args) => {
    pages++;
    return originalPage(...args);
  };
  f.store.waitForEvents = async () => {
    waits++;
    throw new Error("historical replay must not wait for live notifications");
  };
  const app = buildAPI(
    f.service,
    async (h) => {
      if (h !== "Bearer history") throw new Fault(401, "UNAUTHENTICATED");
      return f.actor;
    },
    new SandboxManager(f.store, new DemoSandbox()),
  );
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 30000);
  const start = performance.now();
  try {
    const expected = await f.store.runTx(f.actor.tenantId, f.run.id, (s) => {
      const r = s.runs[f.run.id]!;
      for (let i = 0; i < 4998; i++)
        event(s, r, "message.delta", { delta: `历史😃 ${i}` });
      r.state = "COMPLETED";
      event(s, r, "run.completed");
      return s.sequence;
    });
    assert.equal(expected, 5000, "exercise a full final page");
    f.store.tx = async () => {
      throw new Error(
        "HTTP replay must not hydrate all tenant history for response audit",
      );
    };
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const collect = async (after: number, cutoff?: number) => {
      const response = await fetch(`${base}/api/v1/runs/${f.run.id}/events`, {
        headers: {
          Authorization: "Bearer history",
          "Last-Event-ID": String(after),
        },
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      const ids: number[] = [];
      let buffer = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            assert.ok(!block.includes("event: stream.error"), block);
            const rawId = block.match(/^id: (\d+)$/m)?.[1];
            if (rawId) {
              const eid = Number(rawId),
                payload = JSON.parse(block.match(/^data: (.+)$/m)![1]!);
              assert.equal(payload.eventId, eid);
              ids.push(eid);
              if (ids.length === 1)
                assert.equal((await fetch(`${base}/health`)).status, 200);
              if (eid > 1 && eid < 5000)
                assert.equal(payload.data.delta, `历史😃 ${eid - 2}`);
              if (cutoff && ids.length === cutoff) {
                await reader.cancel();
                return ids;
              }
            }
          }
        }
        return ids;
      } finally {
        reader.releaseLock();
      }
    };
    // Abort mid-page and reconnect using only the last event actually consumed.
    const prefix = await collect(0, 1237);
    const suffix = await collect(prefix.at(-1)!);
    assert.deepEqual(
      [...prefix, ...suffix],
      Array.from({ length: 5000 }, (_, i) => i + 1),
    );
    assert.deepEqual(await collect(5000), []);
    assert.equal(
      waits,
      0,
      "full terminal history must not enter the polling wait",
    );

    return {
      tier: "synthetic-history-real-http-postgres",
      status: "passed",
      events: 5000,
      disconnectAfter: 1237,
      exactFullFinalPage: true,
      reconnectOrdered: true,
      duplicates: 0,
      omissions: 0,
      liveWaitCalls: waits,
      pageQueries: pages,
      elapsedMs: Math.round(performance.now() - start),
      productionSlo: false,
    };
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await app.close();
    await f.close();
  }
}
if (process.argv[1]?.endsWith("sse-history.ts"))
  console.log(JSON.stringify(await sseHistoryReplay()));
