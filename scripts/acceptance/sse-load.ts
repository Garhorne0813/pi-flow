import assert from "node:assert/strict";
import { buildAPI } from "../../src/api.js";
import { event, Fault } from "../../src/domain.js";
import { DemoSandbox, SandboxManager } from "../../src/adapters/sandbox.js";
import { fixture } from "./fixture.js";
process.env.LOG_LEVEL = "silent";
const concurrency = Number(process.env.SSE_CLIENTS ?? 10);
assert.ok(
  [10, 100, 500].includes(concurrency),
  "SSE_CLIENTS must be 10, 100 or 500",
);
const f = await fixture();
const app = buildAPI(
  f.service,
  async (h) => {
    if (h !== "Bearer acceptance") throw new Fault(401, "UNAUTHENTICATED");
    return f.actor;
  },
  new SandboxManager(f.store, new DemoSandbox()),
);
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 120000);
let peakRss = process.memoryUsage().rss;
const memory = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 50);
const latencies: number[] = [];
const begin = performance.now(),
  cpu = process.cpuUsage();
const expected: number[] = [];
try {
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const clients = Array.from({ length: concurrency }, async () => {
    const response = await fetch(`${base}/api/v1/runs/${f.run.id}/events`, {
      headers: { Authorization: "Bearer acceptance" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const ids: number[] = [];
    let buffer = "";
    for await (const chunk of response.body!) {
      buffer += new TextDecoder().decode(chunk);
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.includes("event: stream.error")) throw new Error(block);
        const data = block.match(/^data: (.+)$/m)?.[1];
        const rawId = block.match(/^id: (\d+)$/m)?.[1];
        if (rawId) {
          ids.push(Number(rawId));
          const payload = JSON.parse(data!);
          if (payload.data?.sentAt)
            latencies.push(Date.now() - payload.data.sentAt);
        }
      }
    }
    return ids;
  });
  // Capture the initial run.queued event too; replay makes connection-start races harmless.
  expected.push(
    ...(await f.store.read(f.actor.tenantId, (s) =>
      s.events.filter((e) => e.runId === f.run.id).map((e) => e.eventId),
    )),
  );
  for (let i = 0; i < 20; i++) {
    const eid = await f.store.tx(f.actor.tenantId, (s) => {
      const r = s.runs[f.run.id]!;
      event(s, r, "message.delta", { text: `chunk-${i}`, sentAt: Date.now() });
      return s.sequence;
    });
    expected.push(eid);
    await new Promise((r) => setTimeout(r, 50));
  }
  expected.push(
    await f.store.tx(f.actor.tenantId, (s) => {
      const r = s.runs[f.run.id]!;
      r.state = "COMPLETED";
      event(s, r, "run.completed");
      return s.sequence;
    }),
  );
  const histories = await Promise.all(clients);
  histories.forEach((ids) =>
    assert.deepEqual(
      ids,
      expected,
      "ordered replay without duplicates or omissions",
    ),
  );
  const after = expected[10]!;
  const resumed = await fetch(`${base}/api/v1/runs/${f.run.id}/events`, {
    headers: {
      Authorization: "Bearer acceptance",
      "Last-Event-ID": String(after),
    },
    signal: controller.signal,
  });
  const text = await resumed.text();
  assert.deepEqual(
    Array.from(text.matchAll(/^id: (\d+)$/gm), (m) => Number(m[1])),
    expected.filter((id) => id > after),
  );
  latencies.sort((a, b) => a - b);
  const used = process.cpuUsage(cpu);
  console.log(
    JSON.stringify({
      tier: "synthetic-events-real-postgres",
      status: "passed",
      clients: concurrency,
      eventsPerClient: expected.length,
      elapsedMs: Math.round(performance.now() - begin),
      deliveryP95Ms: latencies[Math.floor(latencies.length * 0.95)],
      deliveryP99Ms: latencies[Math.floor(latencies.length * 0.99)],
      peakRssBytes: peakRss,
      cpuUserMs: used.user / 1000,
      cpuSystemMs: used.system / 1000,
      reconnectOrdered: true,
    }),
  );
} finally {
  clearTimeout(timeout);
  clearInterval(memory);
  controller.abort();
  await app.close();
  await f.close();
}
