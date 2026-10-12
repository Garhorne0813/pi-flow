import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MemoryStore } from "../src/store.js";
import { MCPManager } from "../src/adapters/mcp.js";
import { AgentConfig, Fault } from "../src/domain.js";
import { HarnessService } from "../src/service.js";
import { Worker } from "../src/worker.js";
import { DemoSandbox, SandboxManager } from "../src/adapters/sandbox.js";
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Run did not settle");
}
for (const cause of ["cancel", "deadline"] as const)
  test(`HTTPS MCP writes before stalled response: approved ${cause} is FAILED unknown, never replayed`, async () => {
    const directory = `work/mcp-outcome-${cause}-tls`;
    await mkdir(directory, { recursive: true });
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${directory}/key.pem`,
        "-out",
        `${directory}/cert.pem`,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const cert = await readFile(`${directory}/cert.pem`, "utf8"),
      roots = getCACertificates("default");
    setDefaultCACertificates([...roots, cert]);
    let writes = 0,
      release!: () => void,
      block = false,
      drop = false;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const servers: Server[] = [];
    const correlations: { header: unknown; meta: unknown }[] = [];
    const server = createServer(
      { key: await readFile(`${directory}/key.pem`), cert },
      async (req, res) => {
        const s = new Server(
          { name: "writer", version: "1" },
          { capabilities: { tools: {} } },
        );
        servers.push(s);
        s.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: "write", inputSchema: { type: "object" } }],
        }));
        s.setRequestHandler(CallToolRequestSchema, async (request) => {
          writes++;
          correlations.push({
            header: req.headers["x-harness-call-id"],
            meta: request.params._meta,
          });
          if (drop) req.socket.destroy();
          if (block) await gate;
          return { content: [{ type: "text", text: "committed" }] };
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        try {
          await s.connect(transport);
          let body = "";
          for await (const chunk of req) body += chunk;
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
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const actor = { tenantId: "unknown", userId: "user", admin: true },
      store = new MemoryStore();
    const port = (server.address() as { port: number }).port;
    const service = new HarnessService(store, ["writer"], ["default"]);
    await store.tx(actor.tenantId, (s) => {
      s.mcp.writer = {
        id: "writer",
        enabled: true,
        endpointRef: "writer",
        allowedTools: ["write"],
      };
    });
    const config = AgentConfig.parse({
      name: "writer",
      systemPrompt: "test",
      model: { provider: "demo", modelId: "demo" },
      tools: [],
      mcpServers: ["writer"],
      skillBundle: "default",
      timeoutSeconds: cause === "deadline" ? 1 : 30,
    });
    const mcp = new MCPManager(store, {
      writer: { url: `https://localhost:${port}/mcp` },
    });
    let modelCalls = 0;
    const worker = new Worker(
      service,
      {
        execute: async (ctx) => {
          modelCalls++;
          await ctx.call("mcp_writer_write", {});
        },
      },
      new SandboxManager(store, new DemoSandbox()),
      mcp,
      1,
    );
    try {
      const load = await mcp.discover(actor, config);
      const before = new AbortController();
      before.abort(new Fault(409, "RUN_CANCELLED"));
      await assert.rejects(load.call("mcp_writer_write", {}, before.signal), {
        code: "RUN_CANCELLED",
      });
      assert.equal(writes, 0);
      const confirmed = new AbortController(),
        phases: string[] = [];
      const result = await load.call("mcp_writer_write", {}, confirmed.signal, {
        callId: "known-call",
        runId: "known-run",
        event: async (phase) => {
          phases.push(phase);
          if (phase === "confirmed") confirmed.abort();
        },
      });
      assert.deepEqual((result as { content: unknown }).content, [
        { type: "text", text: "committed" },
      ]);
      assert.deepEqual(phases, ["dispatching", "dispatched", "confirmed"]);
      assert.equal(writes, 1);
      block = true;
      const agent = await service.publish(actor, config),
        workspace = await service.createWorkspace(actor, "test");
      const session = await service.createSession(
        actor,
        workspace.id,
        agent.id,
      );
      const original = await service.submit(actor, session.id, "write");
      await worker.tick();
      await until(
        async () =>
          (await store.read(
            actor.tenantId,
            (s) => s.runs[original.id]!.state,
          )) === "WAITING_INPUT",
      );
      await until(
        async () =>
          !(await store.read(
            actor.tenantId,
            (s) => s.runs[original.id]!.lease,
          )),
      );
      assert.equal(writes, 1);
      const interaction = await store.read(
        actor.tenantId,
        (s) => Object.values(s.interactions)[0]!,
      );
      const next = (await service.respond(actor, interaction.id, "approve"))!;
      await worker.tick();
      await until(async () => writes === 2);
      if (cause === "cancel") await service.cancel(actor, next.id);
      await until(
        async () =>
          (await store.read(actor.tenantId, (s) => s.runs[next.id]!.state)) ===
          "FAILED",
      );
      const saved = await store.read(actor.tenantId, (s) => s.runs[next.id]!);
      assert.equal(saved.error, "MCP_OUTCOME_UNKNOWN");
      const events = await store.read(actor.tenantId, (s) =>
        s.events.filter((e) => e.runId === next.id),
      );
      const dispatched = events.find((e) => e.type === "tool.dispatched")!;
      const unknown = events.find((e) => e.type === "tool.unknown")!;
      assert.ok(dispatched);
      assert.ok(unknown);
      assert.equal(
        (dispatched.data as any).callId,
        (unknown.data as any).callId,
      );
      assert.equal(correlations[1]!.header, (dispatched.data as any).callId);
      assert.equal((correlations[1]!.meta as any).runId, next.id);
      assert.ok(!events.some((e) => e.type === "tool.completed"));
      release();
      await worker.tick();
      assert.equal(writes, 2);
      assert.equal(modelCalls, 1);
      assert.equal(
        (await service.respond(actor, interaction.id, "approve"))!.id,
        next.id,
      );
      await worker.tick();
      assert.equal(writes, 2);
      // A dropped transport response is equally unknown without user cancellation.
      block = false;
      drop = true;
      const lost: string[] = [];
      await assert.rejects(
        load.call("mcp_writer_write", {}, new AbortController().signal, {
          callId: "lost-response",
          runId: "lost-run",
          event: async (phase) => {
            lost.push(phase);
          },
        }),
        { code: "MCP_OUTCOME_UNKNOWN" },
      );
      assert.deepEqual(lost, ["dispatching", "dispatched", "unknown"]);
      assert.equal(writes, 3);
    } finally {
      release();
      await worker.stop();
      await Promise.allSettled(servers.map((s) => s.close()));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      setDefaultCACertificates(roots);
    }
  });
