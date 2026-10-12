import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MemoryStore } from "../src/store.js";
import { MCPManager } from "../src/adapters/mcp.js";
import { AgentConfig, Fault, id } from "../src/domain.js";
import { HarnessService } from "../src/service.js";
import { Worker } from "../src/worker.js";
import { DemoSandbox, SandboxManager } from "../src/adapters/sandbox.js";

const actor = { tenantId: "mcp-abort", userId: "user", admin: true };
async function fixture() {
  const store = new MemoryStore();
  await store.tx(actor.tenantId, (s) => {
    for (const server of ["a", "b"])
      s.mcp[server] = {
        id: server,
        enabled: true,
        endpointRef: server,
        allowedTools: ["one", "two"],
      };
  });
  const config = AgentConfig.parse({
    name: "mcp",
    systemPrompt: "test",
    model: { provider: "demo", modelId: "demo" },
    tools: [],
    mcpServers: ["a", "b"],
    skillBundle: "default",
  });
  const mcp = new MCPManager(
    store,
    {
      a: { url: "https://example.test/a" },
      b: { url: "https://example.test/b" },
    },
    undefined,
    { discoveryTimeoutMs: 80, cleanupTimeoutMs: 15 },
  );
  return { store, config, mcp };
}
const tool = (name = "one") => ({
  name,
  inputSchema: { type: "object" as const },
});
const never = () => new Promise<never>(() => {});
async function until(fn: () => boolean | Promise<boolean>, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Expected state did not settle");
}

for (const stage of ["connect", "page"] as const)
  test(`MCP abort during stalled ${stage} stops subsequent servers/pages and bounds failing cleanup`, async (t) => {
    const f = await fixture(),
      controller = new AbortController();
    let connected = 0,
      pages = 0,
      transportClosed = 0;
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    t.mock.method(Client.prototype, "connect", async (_transport, options) => {
      connected++;
      assert.ok(options.signal instanceof AbortSignal);
      if (stage === "connect") {
        started();
        await never();
      }
    });
    t.mock.method(Client.prototype, "listTools", async (_params, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      pages++;
      if (pages === 1) return { tools: [tool()], nextCursor: "page2" };
      started();
      await never();
    });
    t.mock.method(Client.prototype, "close", async () => {
      throw Error("close failed");
    });
    t.mock.method(
      StreamableHTTPClientTransport.prototype,
      "close",
      async () => {
        transportClosed++;
        await never();
      },
    );
    const load = f.mcp.discover(actor, f.config, controller.signal);
    const checked = assert.rejects(load, { code: "TEST_CANCEL" });
    await begun;
    const begin = Date.now();
    controller.abort(new Fault(409, "TEST_CANCEL"));
    await checked;
    assert.ok(Date.now() - begin < 500);
    assert.equal(connected, 1);
    assert.equal(pages, stage === "page" ? 2 : 0);
    assert.ok(transportClosed >= 1);
  });

test("MCP total budget ends discovery across pages and prevents later server connections", async (t) => {
  const f = await fixture();
  let connected = 0,
    pages = 0;
  t.mock.method(Client.prototype, "connect", async () => {
    connected++;
  });
  t.mock.method(Client.prototype, "close", async () => {});
  t.mock.method(
    StreamableHTTPClientTransport.prototype,
    "close",
    async () => {},
  );
  t.mock.method(Client.prototype, "listTools", async () => {
    pages++;
    await new Promise((resolve) => setTimeout(resolve, 35));
    return { tools: [], nextCursor: "more" };
  });
  const begin = Date.now();
  await assert.rejects(f.mcp.discover(actor, f.config), {
    code: "MCP_DISCOVERY_TIMEOUT",
  });
  assert.ok(Date.now() - begin < 500);
  assert.equal(connected, 1);
  assert.ok(pages >= 2 && pages <= 3);
});

test("MCP discovery succeeds across servers/pages despite a throwing close and keeps whitelist/revocation", async (t) => {
  const f = await fixture();
  const clients = new WeakMap<Client, number>();
  let connected = 0;
  t.mock.method(Client.prototype, "connect", async function (this: Client) {
    clients.set(this, ++connected);
  });
  t.mock.method(Client.prototype, "close", async () => {
    throw Error("close failure");
  });
  t.mock.method(
    StreamableHTTPClientTransport.prototype,
    "close",
    async () => {},
  );
  t.mock.method(
    Client.prototype,
    "listTools",
    async function (this: Client, params) {
      if (clients.get(this) === 1 && !params?.cursor)
        return { tools: [tool("one"), tool("hidden")], nextCursor: "p2" };
      return { tools: [tool("two")] };
    },
  );
  const load = await f.mcp.discover(actor, f.config);
  assert.deepEqual(
    load.specs.map((s) => s.name),
    ["mcp_a_one", "mcp_a_two", "mcp_b_two"],
  );
  await assert.rejects(load.authorize("mcp_a_hidden"), {
    code: "MCP_TOOL_DENIED",
  });
  await f.store.tx(actor.tenantId, (s) => {
    s.mcp.a!.enabled = false;
  });
  await assert.rejects(load.authorize("mcp_a_one"), { code: "MCP_REVOKED" });
});

test("MCP pre-abort, expired Run deadline and server limit avoid any connection", async (t) => {
  const f = await fixture();
  let connected = 0;
  t.mock.method(Client.prototype, "connect", async () => {
    connected++;
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.mcp.discover(actor, f.config, controller.signal), {
    name: "AbortError",
  });
  await assert.rejects(
    f.mcp.discover(actor, f.config, undefined, Date.now() - 1),
    { code: "RUN_TIMEOUT" },
  );
  assert.throws(() =>
    AgentConfig.parse({ ...f.config, mcpServers: Array(17).fill("a") }),
  );
  await assert.rejects(
    f.mcp.discover(actor, { ...f.config, mcpServers: Array(17).fill("a") }),
    { code: "MCP_SERVER_LIMIT" },
  );
  assert.equal(connected, 0);
});

for (const cause of ["cancel", "deadline"] as const)
  test(`Worker ${cause} during MCP discovery releases lease/slot and schedules next Run`, async (t) => {
    const f = await fixture();
    let pages = 0,
      connected = 0,
      runtimeCalls = 0;
    t.mock.method(Client.prototype, "connect", async () => {
      connected++;
    });
    t.mock.method(Client.prototype, "listTools", async () => {
      pages++;
      return never();
    });
    t.mock.method(Client.prototype, "close", async () => never());
    t.mock.method(
      StreamableHTTPClientTransport.prototype,
      "close",
      async () => {},
    );
    // Use the production 30 s budget, so cancellation comes from the Worker.
    const mcp = new MCPManager(f.store, {
      a: { url: "https://example.test/a" },
      b: { url: "https://example.test/b" },
    });
    const service = new HarnessService(f.store, ["a", "b"], ["default"]);
    const slow = await service.publish(actor, {
      ...f.config,
      timeoutSeconds: cause === "cancel" ? 10 : 1,
    });
    const fast = await service.publish(actor, { ...f.config, mcpServers: [] });
    const w = await service.createWorkspace(actor, "worker");
    const s1 = await service.createSession(actor, w.id, slow.id),
      s2 = await service.createSession(actor, w.id, fast.id);
    const r1 = await service.submit(actor, s1.id, "slow"),
      r2 = await service.submit(actor, s2.id, "next");
    const worker = new Worker(
      service,
      {
        execute: async () => {
          runtimeCalls++;
        },
      },
      new SandboxManager(f.store, new DemoSandbox()),
      mcp,
      1,
    );
    try {
      await worker.tick();
      await until(() => pages === 1);
      const begin = Date.now();
      if (cause === "cancel") await service.cancel(actor, r1.id);
      await until(() =>
        f.store.read(
          actor.tenantId,
          (s) =>
            ["CANCELLED", "FAILED"].includes(s.runs[r1.id]!.state) &&
            !s.runs[r1.id]!.lease,
        ),
      );
      assert.ok(Date.now() - begin < 2000);
      const result = await f.store.read(actor.tenantId, (s) => s.runs[r1.id]!);
      assert.equal(result.state, cause === "cancel" ? "CANCELLED" : "FAILED");
      assert.equal(
        result.error,
        cause === "cancel" ? "RUN_CANCELLED" : "RUN_TIMEOUT",
      );
      assert.equal(connected, 1);
      assert.equal(pages, 1);
      assert.equal(runtimeCalls, 0);
      await worker.tick();
      await until(() =>
        f.store.read(
          actor.tenantId,
          (s) => s.runs[r2.id]!.state === "COMPLETED" && !s.runs[r2.id]!.lease,
        ),
      );
      assert.equal(runtimeCalls, 1);
    } finally {
      await worker.stop();
    }
  });
