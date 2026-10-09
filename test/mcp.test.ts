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
  const server = createServer(
    { key: await readFile("work/mcp-tls/key.pem"), cert },
    async (req, res) => {
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
  });
  try {
    const mgr = new MCPManager(store, {
      trusted: {
        url: `https://localhost:${port}/mcp`,
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
