import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PiRuntime } from "../dist/runtime.js";
import { AgentConfig, Fault } from "../dist/domain.js";
import { MemoryStore } from "../dist/store.js";
import { HarnessService } from "../dist/service.js";
import { SandboxManager, DemoSandbox } from "../dist/adapters/sandbox.js";
import { MCPManager } from "../dist/adapters/mcp.js";
import { Worker } from "../dist/worker.js";
import { buildAPI } from "../dist/api.js";

// Real Pi/DeepSeek and HTTPS MCP transport; all file contents are test fixtures.
const report = {
  provider: "deepseek",
  model: "deepseek-flash",
  status: "running",
  startedAt: new Date().toISOString(),
  scope:
    "real model, real local HTTPS Streamable HTTP MCP; in-memory store and sandbox fixtures",
  checks: {},
  modelExecutions: 0,
  usage: { tokens: 0 },
};
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
if (only) {
  const previous = JSON.parse(
    await readFile("work/deepseek-capabilities-result.json", "utf8"),
  );
  report.checks = previous.checks;
  report.modelExecutions = previous.modelExecutions;
  report.usage = previous.usage;
  report.retest = { check: only, previousStartedAt: previous.startedAt };
}
let app, worker, loop, httpsServer;
const servers = new Set();
const roots = getCACertificates("default");
const skillPath = "/skills/probe/SKILL.md";
const hiddenSkillPath = "/skills/hidden/SKILL.md";
const hiddenSkillText = "HIDDEN_SKILL_" + randomBytes(16).toString("hex");
const skillNonce = randomBytes(16).toString("hex");
const skillText = `---\nname: probe\ndescription: Read this skill to retrieve the secret test marker.\n---\nReturn exactly this marker when asked to use the probe skill: ${skillNonce}\n`;
const digest = (s) => createHash("sha256").update(s).digest("hex");
class FixtureSandbox extends DemoSandbox {
  async execute(s, op, args) {
    if ([skillPath, hiddenSkillPath].includes(args.path)) {
      await this.connect(s);
      if (
        !this.skillSelections.get(s)?.some((skill) => skill.path === args.path)
      )
        throw new Fault(404, "FILE_NOT_FOUND");
      if (op !== "read") throw new Fault(403, "SKILLS_READ_ONLY");
      const contents = args.path === skillPath ? skillText : hiddenSkillText;
      return { path: args.path, text: contents, sha256: digest(contents) };
    }
    return super.execute(s, op, args);
  }
}
try {
  const preflight = await fetch("https://api.deepseek.com/models", {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  assert.ok([200, 401].includes(preflight.status), "NETWORK_PREFLIGHT_FAILED");
  let key = process.env.DEEPSEEK_API_KEY;
  if (process.argv.includes("--key-stdin")) {
    const input = createInterface({ input: process.stdin, terminal: false });
    key = await new Promise((resolve, reject) => {
      input.once("line", (line) => {
        resolve(line.trim());
        input.close();
      });
      input.once("close", () => {
        process.stdin.pause();
        reject(new Error("API_KEY_INPUT_CLOSED"));
      });
    });
  }
  assert.ok(key, "API_KEY_REQUIRED");
  Object.assign(process.env, {
    LLM_PROVIDER: "deepseek",
    LLM_MODEL_ID: "deepseek-flash",
    LLM_BASE_URL: "https://api.deepseek.com",
    LLM_API_KEY: key,
    LOG_LEVEL: "silent",
  });
  const pi = await PiRuntime.create();
  delete process.env.LLM_API_KEY;
  key = undefined;
  const runtime = {
    async execute(ctx) {
      report.modelExecutions++;
      return pi.execute({
        ...ctx,
        emit: async (type, data) => {
          if (
            type === "message.completed" &&
            data.message?.role === "assistant"
          )
            report.usage.tokens += data.message.usage?.totalTokens ?? 0;
          await ctx.emit(type, data);
        },
      });
    },
  };
  await mkdir("work/capabilities-tls", { recursive: true });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "work/capabilities-tls/key.pem",
      "-out",
      "work/capabilities-tls/cert.pem",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile("work/capabilities-tls/cert.pem", "utf8");
  setDefaultCACertificates([...roots, cert]);
  const mcpNonce = randomBytes(16).toString("hex");
  const mcpCalls = [];
  let hiddenMcpRequests = 0;
  httpsServer = createServer(
    { key: await readFile("work/capabilities-tls/key.pem"), cert },
    async (req, res) => {
      if (req.url === "/hidden") {
        hiddenMcpRequests++;
        res.writeHead(500);
        res.end();
        return;
      }
      const s = new Server(
        { name: "live-probe", version: "1" },
        { capabilities: { tools: {} } },
      );
      servers.add(s);
      s.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "lookup",
            description: "Retrieve the test marker for a query.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          },
          {
            name: "forbidden",
            description: "Not authorized",
            inputSchema: { type: "object" },
          },
        ],
      }));
      s.setRequestHandler(CallToolRequestSchema, async (r) => {
        assert.equal(r.params.name, "lookup");
        mcpCalls.push(r.params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                marker: mcpNonce,
                query: r.params.arguments?.query,
              }),
            },
          ],
        };
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      try {
        await s.connect(transport);
        let body = "";
        for await (const c of req) body += c;
        await transport.handleRequest(
          req,
          res,
          body ? JSON.parse(body) : undefined,
        );
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    },
  );
  await new Promise((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
  const store = new MemoryStore();
  const actor = {
    tenantId: "capabilities-live",
    userId: "tester",
    admin: true,
  };
  const service = new HarnessService(
    store,
    ["probe", "hidden"],
    ["default"],
    [{ provider: "deepseek", modelId: "deepseek-flash" }],
  );
  const sandbox = new SandboxManager(store, new FixtureSandbox());
  const mcp = new MCPManager(store, {
    probe: { url: `https://localhost:${httpsServer.address().port}/mcp` },
    hidden: { url: `https://localhost:${httpsServer.address().port}/hidden` },
  });
  const token = randomBytes(24).toString("hex");
  app = buildAPI(
    service,
    async (h) => {
      assert.equal(h, `Bearer ${token}`);
      return actor;
    },
    sandbox,
  );
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const api = async (
    path,
    body,
    method = body === undefined ? "GET" : "POST",
    expected = undefined,
  ) => {
    const r = await fetch(address + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (expected) assert.equal(r.status, expected);
    else assert.ok(r.ok, `LOCAL_API_${r.status}`);
    return r.json();
  };
  const events = (runId) =>
    store.tx(actor.tenantId, (s) => s.events.filter((e) => e.runId === runId));
  const text = (es) =>
    es
      .filter((e) => e.type === "message.delta")
      .map((e) => e.data.delta)
      .join("");
  const wait = async (r, expected = "COMPLETED") => {
    const deadline = Date.now() + 135000;
    while (Date.now() < deadline) {
      const current = await api(`/api/v1/runs/${r.id}`);
      if (
        ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"].includes(
          current.state,
        )
      ) {
        const settled = await store.tx(
          actor.tenantId,
          (s) => !s.runs[r.id].lease,
        );
        if (settled) {
          assert.equal(
            current.state,
            expected,
            current.error ?? "UNEXPECTED_RUN_STATE",
          );
          return current;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("LIVE_RUN_TIMEOUT");
  };
  const config = (extra) =>
    AgentConfig.parse({
      name: "Live capabilities probe",
      systemPrompt:
        "Follow the explicit test instructions. Call the requested tool before replying. Never guess an unread marker. After a user response or approval, finish using the supplied response or recorded result; do not repeat an already completed operation.",
      model: { provider: "deepseek", modelId: "deepseek-flash" },
      tools: [],
      skillBundle: "default",
      maxTokens: 30000,
      maxSteps: 30,
      timeoutSeconds: 120,
      ...extra,
    });
  const session = async (extra) => {
    const agent = await api("/api/v1/admin/agents", config(extra));
    const w = await api("/api/v1/workspaces", { name: "Capabilities fixture" });
    return api(`/api/v1/workspaces/${w.id}/sessions`, {
      agentVersionId: agent.id,
    });
  };
  const turn = (ses, message) =>
    api(`/api/v1/sessions/${ses.id}/runs`, { message });
  const check = async (name, fn) => {
    if (only && name !== only) return;
    const started = Date.now();
    try {
      const details = await fn();
      report.checks[name] = {
        status: "passed",
        durationMs: Date.now() - started,
        ...details,
      };
    } catch (e) {
      report.checks[name] = {
        status: "failed",
        durationMs: Date.now() - started,
        reason:
          e.code ??
          (typeof e.message === "string" && /^[A-Z_]+$/.test(e.message)
            ? e.message
            : "ASSERTION_OR_RUN_FAILED"),
        assertion:
          e.code === "ERR_ASSERTION"
            ? {
                actual: e.actual,
                expected: e.expected,
                operator: e.operator,
                at: e.stack
                  ?.split("\n")
                  .find((line) =>
                    line.includes("smoke-deepseek-capabilities.mjs:"),
                  )
                  ?.trim(),
              }
            : undefined,
      };
    }
    console.log(JSON.stringify({ check: name, ...report.checks[name] }));
  };
  const respond = (iid, response) =>
    api(`/api/v1/interactions/${iid}/response`, { response });
  const interaction = async (runId, kind) => {
    const i = await store.tx(actor.tenantId, (s) =>
      Object.values(s.interactions).find((i) => i.runId === runId),
    );
    assert.equal(i?.kind, kind);
    return i;
  };
  worker = new Worker(service, runtime, sandbox, mcp, 1);
  loop = worker.start();

  await check("todo", async () => {
    const ses = await session({ tools: ["todo"] });
    const r = await turn(
      ses,
      'Call todo with exactly [{"text":"verify-live-todo","status":"in_progress"}], then reply TODO_SAVED.',
    );
    await wait(r);
    const state = await api(`/api/v1/sessions/${ses.id}`);
    assert.deepEqual(state.todos, [
      { text: "verify-live-todo", status: "in_progress" },
    ]);
    assert.ok((await events(r.id)).some((e) => e.type === "todo.updated"));
    const done = await turn(
      ses,
      'Call todo with exactly [{"text":"verify-live-todo","status":"completed"}], then reply TODO_DONE.',
    );
    await wait(done);
    assert.deepEqual((await api(`/api/v1/sessions/${ses.id}`)).todos, [
      { text: "verify-live-todo", status: "completed" },
    ]);
    return { persistedViaSessionApi: true, statusUpdate: true };
  });
  await check("askUser", async () => {
    const ses = await session({ tools: ["ask_user_question"] });
    const r = await turn(
      ses,
      'Call ask_user_question with question "Choose a test color?". After the user responds, reply only with the supplied response. Do not ask again.',
    );
    await wait(r, "WAITING_INPUT");
    const i = await interaction(r.id, "question");
    assert.equal(i.payload.question, "Choose a test color?");
    await worker.stop();
    await loop;
    worker = new Worker(service, runtime, sandbox, mcp, 1);
    loop = worker.start();
    const answer = "COLOR_" + randomBytes(12).toString("hex");
    const resumed = await respond(i.id, answer);
    assert.notEqual(resumed.id, r.id);
    assert.equal((await respond(i.id, answer)).id, resumed.id);
    await wait(resumed);
    assert.ok(text(await events(resumed.id)).includes(answer));
    await api(
      `/api/v1/interactions/${i.id}/response`,
      { response: "different" },
      "POST",
      409,
    );
    return {
      waitingInput: true,
      workerRestart: true,
      answerRestored: true,
      idempotentResponse: true,
      conflictRejected: true,
    };
  });
  await check("skills", async () => {
    await api("/api/v1/admin/skills", {
      id: "probe@v1",
      name: "probe",
      description: "Read to obtain the hidden test marker",
      bundle: "default",
      path: skillPath,
      digest: digest(skillText),
    });
    const ses = await session({ tools: ["read"], skills: ["probe@v1"] });
    await api("/api/v1/admin/skills", {
      id: "hidden@v1",
      name: "hidden",
      description: "Not owned by the probe agent",
      bundle: "default",
      path: hiddenSkillPath,
      digest: digest(hiddenSkillText),
    });
    const r = await turn(
      ses,
      "Use the registered probe skill. Read its SKILL.md using remote_read and return only the marker it contains.",
    );
    await wait(r);
    const es = await events(r.id);
    assert.ok(
      es.some(
        (e) =>
          e.type === "tool.completed" &&
          e.data.name === "remote_read" &&
          e.data.result.sha256 === digest(skillText),
      ),
    );
    assert.ok(text(es).includes(skillNonce));
    const hidden = await turn(
      ses,
      `Call remote_read exactly once with path ${hiddenSkillPath}. If the file is unavailable reply SKILL_ACCESS_DENIED and do not retry.`,
    );
    await wait(hidden);
    const hiddenEvents = await events(hidden.id);
    assert.ok(
      hiddenEvents.some(
        (e) => e.type === "tool.failed" && e.data.code === "FILE_NOT_FOUND",
      ),
    );
    assert.ok(!text(hiddenEvents).includes(hiddenSkillText));
    await api("/api/v1/admin/skills", {
      id: "probe@bad",
      name: "probe-bad",
      description: "Bad digest test",
      bundle: "default",
      path: skillPath,
      digest: "0".repeat(64),
    });
    const bad = await session({ tools: ["read"], skills: ["probe@bad"] });
    const badRun = await turn(
      bad,
      `Call remote_read once with path ${skillPath}; if it fails report the error and do not retry.`,
    );
    await wait(badRun);
    assert.ok(
      (await events(badRun.id)).some(
        (e) =>
          e.type === "tool.failed" && e.data.code === "SKILL_DIGEST_MISMATCH",
      ),
    );
    await api(
      "/api/v1/admin/skills/probe%40v1/status",
      { enabled: false },
      "PUT",
    );
    const executionsBeforeRevocation = report.modelExecutions;
    const revoked = await turn(ses, "Use probe again");
    const rejected = await wait(revoked, "FAILED");
    assert.equal(rejected.error, "SKILL_REVOKED");
    assert.equal(report.modelExecutions, executionsBeforeRevocation);
    return {
      metadataDiscovered: true,
      explicitRemoteRead: true,
      digestVerified: true,
      badDigestRejected: true,
      revocationRejected: true,
      revocationEnforcedAtWorker: true,
      unownedSkillNotMounted: true,
    };
  });
  await check("subagent", async () => {
    const child = await api(
      "/api/v1/admin/agents",
      config({ name: "Child probe", tools: ["todo", "bash"] }),
    );
    const ses = await session({
      tools: ["delegate_to_agent", "todo"],
      subagents: [child.id],
      maxSubagents: 1,
      maxDepth: 1,
    });
    const marker = "CHILD_" + randomBytes(12).toString("hex");
    const r = await turn(
      ses,
      `Call delegate_to_agent exactly once with agentVersionId "${child.id}" and task 'Call todo with one completed item whose text is "${marker}", then reply only ${marker}'. When the child finishes return its marker; do not call todo yourself.`,
    );
    await wait(r);
    const es = await events(r.id);
    const start = es.find((e) => e.type === "subagent.started");
    assert.ok(start);
    const childRun = await store.tx(
      actor.tenantId,
      (s) => s.runs[start.data.childRunId],
    );
    assert.equal(childRun.state, "COMPLETED");
    assert.notEqual(childRun.sessionId, ses.id);
    assert.deepEqual(childRun.capabilities.tools, ["todo"]);
    assert.ok(
      (await events(childRun.id)).some((e) => e.type === "todo.updated"),
    );
    assert.deepEqual(
      (await api(`/api/v1/sessions/${childRun.sessionId}`)).todos,
      [{ text: marker, status: "completed" }],
    );
    assert.ok(text(es).includes(marker));
    return {
      independentSession: true,
      childRealModel: true,
      capabilityIntersection: true,
      childTodoPersisted: true,
      resultReturnedToParent: true,
    };
  });
  await check("mcp", async () => {
    await api("/api/v1/admin/mcp-servers", {
      id: "hidden",
      endpointRef: "hidden",
      allowedTools: ["lookup"],
    });
    await api("/api/v1/admin/mcp-servers", {
      id: "probe",
      endpointRef: "probe",
      allowedTools: ["lookup"],
    });
    const ses = await session({ mcpServers: ["probe"] });
    const r = await turn(
      ses,
      'Call mcp_probe_lookup exactly once with query "live-probe". After approval, return only the marker in the recorded result; do not call it again.',
    );
    await wait(r, "WAITING_INPUT");
    const i = await interaction(r.id, "approval");
    assert.equal(i.payload.name, "mcp_probe_lookup");
    assert.equal(mcpCalls.length, 0);
    const resumed = await respond(i.id, "approve");
    await wait(resumed);
    assert.equal(mcpCalls.length, 1);
    assert.equal(mcpCalls[0].arguments.query, "live-probe");
    assert.ok(text(await events(resumed.id)).includes(mcpNonce));
    const load = await mcp.discover(actor, config({ mcpServers: ["probe"] }));
    assert.deepEqual(
      load.specs.map((t) => t.name),
      ["mcp_probe_lookup"],
    );
    await assert.rejects(
      load.call("mcp_probe_forbidden", {}, new AbortController().signal),
      { code: "MCP_TOOL_DENIED" },
    );
    await assert.rejects(load.authorize("mcp_hidden_lookup"), {
      code: "MCP_TOOL_DENIED",
    });
    await assert.rejects(
      load.call("mcp_hidden_lookup", {}, new AbortController().signal),
      { code: "MCP_TOOL_DENIED" },
    );
    assert.equal(hiddenMcpRequests, 0);
    const denySes = await session({ mcpServers: ["probe"] });
    const denyRun = await turn(
      denySes,
      'Call mcp_probe_lookup with query "denial-test". If approval is denied, acknowledge denial and do not call any tool again.',
    );
    await wait(denyRun, "WAITING_INPUT");
    const denial = await interaction(denyRun.id, "approval");
    const denied = await respond(denial.id, "deny");
    await wait(denied);
    assert.equal(mcpCalls.length, 1);
    await api(
      "/api/v1/admin/mcp-servers/probe/status",
      { enabled: false },
      "PUT",
    );
    await assert.rejects(
      load.call(
        "mcp_probe_lookup",
        { query: "revoked" },
        new AbortController().signal,
      ),
      { code: "MCP_REVOKED" },
    );
    assert.equal(mcpCalls.length, 1);
    return {
      realHttpsTransport: true,
      toolDiscovery: true,
      approvalBeforeExecution: true,
      approvedExactlyOnce: true,
      modelReadServerResult: true,
      deniedNoSideEffect: true,
      whitelistEnforced: true,
      revocationEnforced: true,
      unownedServerNotDiscoveredOrCalled: true,
    };
  });
  report.status = Object.values(report.checks).every(
    (c) => c.status === "passed",
  )
    ? "passed"
    : "failed";
  if (report.status !== "passed") process.exitCode = 1;
} catch (e) {
  report.status = "failed";
  report.reason = e.code ?? "CAPABILITIES_SETUP_FAILED";
  process.exitCode = 1;
} finally {
  delete process.env.LLM_API_KEY;
  if (worker) await worker.stop();
  if (loop) await loop;
  if (app) await app.close();
  for (const s of servers) await s.close();
  if (httpsServer) await new Promise((resolve) => httpsServer.close(resolve));
  setDefaultCACertificates(roots);
  report.finishedAt = new Date().toISOString();
  await mkdir("work", { recursive: true });
  await writeFile(
    "work/deepseek-capabilities-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
