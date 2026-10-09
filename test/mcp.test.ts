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
import { AgentConfig, type Actor } from "../src/domain.js";
test("real Streamable HTTP MCP uses trusted HTTPS endpoint, filters tools and checks revocation", async () => {
  await mkdir("work/mcp-tls", { recursive: true });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "work/mcp-tls/key.pem",
      "-out",
      "work/mcp-tls/cert.pem",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile("work/mcp-tls/cert.pem", "utf8");
  const oldRoots = getCACertificates("default");
  setDefaultCACertificates([...oldRoots, cert]);
  const sessions: Server[] = [];
  let invocations = 0;
  let hiddenRequests = 0;
  const server = createServer(
    { key: await readFile("work/mcp-tls/key.pem"), cert },
    async (req, res) => {
      if (req.url === "/hidden") {
        hiddenRequests++;
        res.writeHead(500);
        res.end();
        return;
      }
      assert.equal(req.headers.authorization, "Bearer local-test-only");
      const s = new Server(
        { name: "test-mcp", version: "1" },
        { capabilities: { tools: {} } },
      );
      sessions.push(s);
      s.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "search",
            description: "Search",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
          { name: "delete", inputSchema: { type: "object" } },
        ],
      }));
      s.setRequestHandler(CallToolRequestSchema, async (r) => {
        invocations++;
        return {
          content: [
            { type: "text", text: `found ${r.params.arguments?.query}` },
          ],
        };
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      try {
        await s.connect(transport);
        let data = "";
        for await (const c of req) data += c;
        await transport.handleRequest(
          req,
          res,
          data ? JSON.parse(data) : undefined,
        );
      } catch {
        res.writeHead(500);
        res.end();
      }
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.MCP_TEST_TOKEN = "local-test-only";
  const store = new MemoryStore();
  const a: Actor = { tenantId: "one", userId: "u", admin: true };
  await store.tx("one", (s) => {
    s.mcp.kb = {
      id: "kb",
      endpointRef: "trusted",
      allowedTools: ["search"],
      enabled: true,
    };
    s.mcp.hidden = {
      id: "hidden",
      endpointRef: "private",
      allowedTools: ["search"],
      enabled: true,
    };
  });
  try {
    const mgr = new MCPManager(store, {
      trusted: {
        url: `https://localhost:${port}/mcp`,
        tokenEnv: "MCP_TEST_TOKEN",
      },
      private: {
        url: `https://localhost:${port}/hidden`,
        tokenEnv: "MCP_TEST_TOKEN",
      },
    });
    const config = AgentConfig.parse({
      name: "mcp",
      systemPrompt: "test",
      model: { provider: "demo", modelId: "demo" },
      tools: [],
      mcpServers: ["kb"],
      skillBundle: "default",
    });
    const load = await mgr.discover(a, config);
    assert.equal(hiddenRequests, 0);
    assert.deepEqual(
      load.specs.map((x) => x.name),
      ["mcp_kb_search"],
    );
    const result = await load.call(
      "mcp_kb_search",
      { query: "hello" },
      new AbortController().signal,
    );
    assert.deepEqual((result as any).content, [
      { type: "text", text: "found hello" },
    ]);
    assert.equal(invocations, 1);
    await assert.rejects(load.authorize("mcp_hidden_search"), {
      code: "MCP_TOOL_DENIED",
    });
    await assert.rejects(
      load.call("mcp_hidden_search", {}, new AbortController().signal),
      { code: "MCP_TOOL_DENIED" },
    );
    const empty = await mgr.discover(
      a,
      AgentConfig.parse({ ...config, mcpServers: [] }),
    );
    assert.deepEqual(empty.specs, []);
    await assert.rejects(
      empty.call("mcp_kb_search", {}, new AbortController().signal),
      { code: "MCP_TOOL_DENIED" },
    );
    assert.equal(hiddenRequests, 0);
    await store.tx("one", (s) => {
      s.mcp.kb!.endpointRef = "private";
    });
    await assert.rejects(
      load.call("mcp_kb_search", {}, new AbortController().signal),
      { code: "MCP_REVOKED" },
    );
    assert.equal(hiddenRequests, 0);
    await store.tx("one", (s) => {
      s.mcp.kb!.endpointRef = "trusted";
    });
    await assert.rejects(
      load.call("mcp_kb_delete", {}, new AbortController().signal),
      { code: "MCP_TOOL_DENIED" },
    );
    await store.tx("one", (s) => {
      s.mcp.kb!.enabled = false;
    });
    await assert.rejects(
      load.call("mcp_kb_search", {}, new AbortController().signal),
      { code: "MCP_REVOKED" },
    );
    assert.equal(invocations, 1);
    await assert.rejects(mgr.discover(a, config), { code: "MCP_DISABLED" });
  } finally {
    delete process.env.MCP_TEST_TOKEN;
    for (const s of sessions) await s.close();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    setDefaultCACertificates(oldRoots);
  }
});

test("real HTTPS MCP stalled tools/list is aborted at transport level without discovering the next server", async () => {
  const directory = "work/mcp-abort-tls";
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
      directory + "/key.pem",
      "-out",
      directory + "/cert.pem",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile(directory + "/cert.pem", "utf8"),
    roots = getCACertificates("default");
  setDefaultCACertificates([...roots, cert]);
  let started!: () => void;
  const begun = new Promise<void>((r) => {
    started = r;
  });
  let closed = 0,
    nextRequests = 0;
  const server = createServer(
    { key: await readFile(directory + "/key.pem"), cert },
    async (req, res) => {
      if (req.url === "/next") {
        nextRequests++;
        res.writeHead(500);
        res.end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      let text = "";
      for await (const chunk of req) text += chunk;
      const message = JSON.parse(text);
      if (message.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "slow", version: "1" },
            },
          }),
        );
      } else if (message.method === "tools/list") {
        res.once("close", () => {
          closed++;
        });
        started(); // Deliberately never send a response.
      } else {
        res.writeHead(202);
        res.end();
      }
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const store = new MemoryStore();
  const actor = { tenantId: "slow", userId: "user", admin: true };
  await store.tx(actor.tenantId, (s) => {
    s.mcp.slow = {
      id: "slow",
      endpointRef: "slow",
      allowedTools: ["search"],
      enabled: true,
    };
    s.mcp.next = {
      id: "next",
      endpointRef: "next",
      allowedTools: ["search"],
      enabled: true,
    };
  });
  const mgr = new MCPManager(store, {
    slow: { url: `https://localhost:${port}/slow` },
    next: { url: `https://localhost:${port}/next` },
  });
  const controller = new AbortController();
  const config = AgentConfig.parse({
    name: "slow",
    systemPrompt: "slow",
    model: { provider: "demo", modelId: "demo" },
    tools: [],
    mcpServers: ["slow", "next"],
    skillBundle: "default",
  });
  const load = mgr.discover(actor, config, controller.signal);
  const checked = assert.rejects(load, { name: "AbortError" });
  try {
    await Promise.race([
      begun,
      new Promise<void>((_, reject) => {
        const timer = setTimeout(
          () => reject(Error("Discovery did not start")),
          3000,
        );
        timer.unref();
      }),
    ]);
    const begin = Date.now();
    controller.abort();
    await checked;
    assert.ok(Date.now() - begin < 1000);
    const deadline = Date.now() + 1000;
    while (!closed && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(closed, 1);
    assert.equal(nextRequests, 0);
  } finally {
    controller.abort();
    await checked;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    setDefaultCACertificates(roots);
  }
});
