import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { PiRuntime } from "../dist/runtime.js";
import { AgentConfig } from "../dist/domain.js";
import { MemoryStore } from "../dist/store.js";
import { HarnessService } from "../dist/service.js";
import { SandboxManager, DemoSandbox } from "../dist/adapters/sandbox.js";
import { MCPManager } from "../dist/adapters/mcp.js";
import { Worker } from "../dist/worker.js";
import { buildAPI } from "../dist/api.js";
// DeepSeek by default; these settings also support other OpenAI-compatible
// gateways for the same live smoke flow.
const provider = process.env.SMOKE_PROVIDER ?? "deepseek";
const model = process.env.SMOKE_MODEL ?? "deepseek-flash";
const endpoint = process.env.SMOKE_BASE_URL ?? "https://api.deepseek.com";
const report = {
  provider,
  model,
  endpoint,
  status: "running",
  realModelRequested: true,
  realModelRunsConfirmed: 0,
  sandbox: "in-memory test fixture; NOT real CubeSandbox",
  checks: {},
  usage: { tokens: 0 },
  startedAt: new Date().toISOString(),
};
let app, worker, loop, key;
try {
  // Check the existing proxy path before acquiring a credential. No Authorization header.
  try {
    const r = await fetch(endpoint + "/models", {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 403) {
      report.networkStatus = 403;
      throw new Error("ENDPOINT_FORBIDDEN");
    }
    if (![200, 401].includes(r.status))
      throw new Error("UNEXPECTED_PREFLIGHT_STATUS");
  } catch {
    report.status = "blocked";
    report.reason = "NETWORK_PREFLIGHT_FAILED";
    throw new Error("NETWORK_PREFLIGHT_FAILED");
  }
  if (process.argv.includes("--key-stdin")) {
    const input = createInterface({ input: process.stdin, terminal: false });
    key = await new Promise((resolve, reject) => {
      input.once("line", (line) => {
        resolve(line.trim());
        input.close();
      });
      input.once("close", () => {
        reject(new Error("API_KEY_INPUT_CLOSED"));
        process.stdin.pause();
      });
      input.once("error", reject);
    });
  } else
    key =
      process.env.SMOKE_API_KEY ??
      (provider === "deepseek" ? process.env.DEEPSEEK_API_KEY : undefined) ??
      (process.env.LLM_PROVIDER === provider
        ? process.env.LLM_API_KEY
        : undefined);
  if (!key) throw new Error("API_KEY_REQUIRED");
  process.env.LLM_PROVIDER = provider;
  process.env.LLM_MODEL_ID = model;
  process.env.LLM_BASE_URL = endpoint;
  process.env.LLM_API_KEY = key;
  process.env.LOG_LEVEL = "silent";
  const runtime = await PiRuntime.create();
  delete process.env.LLM_API_KEY;
  key = undefined;
  const store = new MemoryStore();
  const service = new HarnessService(
    store,
    [],
    ["default"],
    [{ provider, modelId: model }],
  );
  const sandbox = new SandboxManager(store, new DemoSandbox());
  worker = new Worker(service, runtime, sandbox, new MCPManager(store, {}), 1);
  const actor = { tenantId: "live-test", userId: "tester", admin: true };
  const token = randomBytes(24).toString("hex");
  app = buildAPI(
    service,
    async (h) => {
      if (h !== `Bearer ${token}`) throw new Error("UNAUTHORIZED_TEST_REQUEST");
      return actor;
    },
    sandbox,
  );
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  loop = worker.start();
  async function api(path, body, headers = {}) {
    const r = await fetch(address + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(r.ok, `LOCAL_API_${r.status}`);
    return r.json();
  }
  const config = AgentConfig.parse({
    name: "DeepSeek live test",
    systemPrompt:
      "You are a concise test agent. Follow the user. Use read when requested. Never guess unread file contents.",
    model: { provider, modelId: model },
    tools: ["read"],
    skillBundle: "default",
    maxTokens: 20000,
    maxSteps: 12,
    timeoutSeconds: 120,
    maxSubagents: 0,
    maxDepth: 0,
  });
  const agent = await service.publish(actor, config);
  const w = await api("/api/v1/workspaces", { name: "DeepSeek live fixture" });
  const ses = await api(`/api/v1/workspaces/${w.id}/sessions`, {
    agentVersionId: agent.id,
  });
  async function turn(message, key) {
    const run = await api(
      `/api/v1/sessions/${ses.id}/runs`,
      { message },
      { "Idempotency-Key": key },
    );
    const again = await api(
      `/api/v1/sessions/${ses.id}/runs`,
      { message },
      { "Idempotency-Key": key },
    );
    assert.equal(run.id, again.id);
    const stream = await (
      await fetch(address + `/api/v1/runs/${run.id}/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(130000),
      })
    ).text();
    const final = await api(`/api/v1/runs/${run.id}`);
    if (final.state !== "COMPLETED")
      throw new Error(final.error ?? "RUN_NOT_COMPLETED");
    report.usage.tokens += final.tokens ?? 0;
    report.realModelRunsConfirmed++;
    assert.match(stream, /event: message.delta/);
    assert.match(stream, /event: run.completed/);
    const events = await store.tx(actor.tenantId, (s) =>
      s.events.filter((e) => e.runId === run.id),
    );
    return {
      events,
      text: events
        .filter((e) => e.type === "message.delta")
        .map((e) => e.data.delta)
        .join(""),
    };
  }
  const plain = await turn("Only reply DEEPSEEK_LIVE_OK.", "plain");
  assert.match(plain.text, /DEEPSEEK_LIVE_OK/);
  report.checks.realStreaming = true;
  report.checks.httpSse = true;
  report.checks.idempotency = true;
  const nonce = randomBytes(16).toString("hex");
  await sandbox.execute(actor, w.id, "fixture-seed", "default", "write", {
    path: "live-probe.txt",
    content: JSON.stringify({ nonce }),
  });
  const tool = await turn(
    "Use read to read live-probe.txt. Reply only with the nonce field from that file.",
    "tool",
  );
  assert.ok(
    tool.events.some(
      (e) => e.type === "tool.completed" && e.data.name === "read",
    ),
  );
  assert.match(tool.text, new RegExp(nonce));
  report.checks.toolCallWithRealModel = true;
  // Start a separate Worker and Pi session objects while keeping durable canonical history in the Store.
  await worker.stop();
  await loop;
  // Reuse runtime for restart below to test SessionManager restoration, not credential persistence.
  worker = new Worker(service, runtime, sandbox, new MCPManager(store, {}), 1);
  loop = worker.start();
  const restored = await turn(
    "Without calling tools again, what nonce did the file contain? Reply only with that nonce.",
    "restored",
  );
  assert.match(restored.text, new RegExp(nonce));
  assert.ok(!restored.events.some((e) => e.type === "tool.started"));
  report.checks.workerAndSessionRestore = true;
  report.status = "passed";
} catch (e) {
  if (report.status !== "blocked") {
    report.status = "failed";
    report.reason =
      e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
        ? e.message
        : "LIVE_TEST_FAILED";
  }
  process.exitCode = 1;
} finally {
  key = undefined;
  delete process.env.LLM_API_KEY;
  if (worker) await worker.stop();
  if (loop) await loop;
  if (app) await app.close();
  report.finishedAt = new Date().toISOString();
  await mkdir("work", { recursive: true });
  await writeFile(
    "work/deepseek-live-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
