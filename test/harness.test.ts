import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { HarnessService } from "../src/service.js";
import { AgentConfig, Fault, id, type Actor } from "../src/domain.js";
import { DemoSandbox, SandboxManager } from "../src/adapters/sandbox.js";
import { MCPManager } from "../src/adapters/mcp.js";
import { Worker } from "../src/worker.js";
import { DemoRuntime, type Runtime } from "../src/runtime.js";
import { buildAPI } from "../src/api.js";
const alice: Actor = { tenantId: "one", userId: "alice", admin: true };
const bob: Actor = { tenantId: "one", userId: "bob", admin: false };
const outsider: Actor = { tenantId: "two", userId: "alice", admin: true };
function config(extra: Record<string, unknown> = {}) {
  return AgentConfig.parse({
    name: "test",
    systemPrompt: "safe",
    model: { provider: "demo", modelId: "demo" },
    tools: ["read", "write", "ls"],
    skillBundle: "default",
    ...extra,
  });
}
async function fixture(runtime: Runtime = new DemoRuntime()) {
  const store = new MemoryStore();
  const service = new HarnessService(store, [], ["default"]);
  const provider = new DemoSandbox();
  const sandbox = new SandboxManager(store, provider);
  const mcp = new MCPManager(store, {});
  const worker = new Worker(service, runtime, sandbox, mcp);
  const agent = await service.publish(alice, config());
  const w = await service.createWorkspace(alice, "work");
  const ses = await service.createSession(alice, w.id, agent.id);
  return { store, service, provider, sandbox, worker, agent, w, ses };
}
async function drain(f: Awaited<ReturnType<typeof fixture>>, rid: string) {
  for (let i = 0; i < 150; i++) {
    await f.worker.tick();
    const r = await f.store.tx(alice.tenantId, (s) => s.runs[rid]!);
    if (
      ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"].includes(r.state) &&
      !r.lease
    )
      return r;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Run never settled");
}
test("tenant and member isolation, immutable versions, exact idempotency and session lock", async () => {
  const f = await fixture();
  await assert.rejects(
    f.store.tx(outsider.tenantId, (s) => {
      if (!s.workspaces[f.w.id]) throw new Fault(404, "missing");
    }),
  );
  await assert.rejects(f.service.createSession(bob, f.w.id, f.agent.id), {
    code: "WORKSPACE_NOT_FOUND",
  });
  const [a, b] = await Promise.all([
    f.service.submit(alice, f.ses.id, "hello", "same"),
    f.service.submit(alice, f.ses.id, "hello", "same"),
  ]);
  assert.equal(a.id, b.id);
  await assert.rejects(f.service.submit(alice, f.ses.id, "different", "same"), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  await assert.rejects(f.service.submit(alice, f.ses.id, "hello", "other"), {
    code: "SESSION_BUSY",
  });
  assert.equal((await drain(f, a.id)).state, "COMPLETED");
  const nextAgent = await f.service.publish(
    alice,
    config({ systemPrompt: "new" }),
  );
  assert.notEqual(nextAgent.id, f.agent.id);
  assert.equal(
    (await f.store.tx("one", (s) => s.sessions[f.ses.id]!)).agentVersionId,
    f.agent.id,
  );
});
test("API auth, RBAC, validation and cross-tenant resource hiding", async () => {
  const f = await fixture();
  const app = buildAPI(
    f.service,
    async (header) => {
      if (header === "Bearer alice") return alice;
      if (header === "Bearer bob") return bob;
      if (header === "Bearer outsider") return outsider;
      throw new Fault(401, "UNAUTHENTICATED");
    },
    f.sandbox,
  );
  const req = (method: string, url: string, body?: unknown, token = "alice") =>
    app.inject({
      method: method as "GET",
      url,
      payload: body,
      headers: { authorization: `Bearer ${token}` },
    });
  assert.equal((await app.inject("/api/v1/agents")).statusCode, 401);
  assert.equal(
    (await req("GET", `/api/v1/workspaces/${f.w.id}`, undefined, "outsider"))
      .statusCode,
    404,
  );
  assert.equal(
    (await req("POST", "/api/v1/admin/agents", config(), "bob")).statusCode,
    403,
  );
  assert.equal(
    (
      await req("POST", "/api/v1/admin/agents", {
        ...config(),
        extensionCode: "bad",
      })
    ).statusCode,
    400,
  );
  await req("PUT", `/api/v1/workspaces/${f.w.id}/members/bob`, {
    role: "viewer",
  });
  assert.equal(
    (await req("GET", `/api/v1/workspaces/${f.w.id}`, undefined, "bob"))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await req(
        "POST",
        `/api/v1/workspaces/${f.w.id}/sessions`,
        { agentVersionId: f.agent.id },
        "bob",
      )
    ).statusCode,
    403,
  );
  const r = await f.service.submit(alice, f.ses.id, "hello");
  await drain(f, r.id);
  const stream = await req("GET", `/api/v1/runs/${r.id}/events`);
  assert.match(stream.body, /event: run.completed/);
  const events = await f.store.tx("one", (s) =>
    s.events.filter((e) => e.runId === r.id),
  );
  const cursor = events.at(-2)!.eventId;
  const replay = await req(
    "GET",
    `/api/v1/runs/${r.id}/events?after=${cursor}`,
  );
  assert.match(replay.body, /run.completed/);
  assert.doesNotMatch(replay.body, /event: run.started/);
  await app.close();
});
test("write approval resumes in a new Run and executes exactly once", async () => {
  let calls = 0;
  const runtime: Runtime = {
    execute: async (c) => {
      if (c.prompt === "write")
        await c.call("write", { path: "report.txt", content: "saved" });
      else await c.emit("message.completed", { message: "done" });
      await c.checkpoint(c.entries);
    },
  };
  const f = await fixture(runtime);
  const original = f.provider.execute.bind(f.provider);
  f.provider.execute = async (...args) => {
    if (args[1] === "write") calls++;
    return original(...args);
  };
  const r = await f.service.submit(alice, f.ses.id, "write");
  assert.equal((await drain(f, r.id)).state, "WAITING_INPUT");
  assert.equal(calls, 0);
  const interaction = await f.store.tx(
    "one",
    (s) => Object.values(s.interactions)[0]!,
  );
  assert.equal((interaction.payload as { name: string }).name, "write");
  const next = await f.service.respond(alice, interaction.id, "approve");
  assert.notEqual(next!.id, r.id);
  assert.equal(
    (await f.service.respond(alice, interaction.id, "approve"))!.id,
    next!.id,
  );
  assert.equal((await drain(f, next!.id)).state, "COMPLETED");
  assert.equal(calls, 1);
  assert.deepEqual(
    await f.sandbox.execute(alice, f.w.id, "read", "default", "read", {
      path: "report.txt",
    }),
    { text: "saved" },
  );
  await assert.rejects(f.service.respond(alice, interaction.id, "deny"), {
    code: "INTERACTION_ALREADY_RESOLVED",
  });
});
test("bash requires approval and dispatches to the sandbox provider", async () => {
  const f = await fixture({
    execute: async (c) => {
      if (c.prompt === "shell") await c.call("bash", { command: "exit 73" });
    },
  });
  const agent = await f.service.publish(alice, config({ tools: ["bash"] }));
  const session = await f.service.createSession(alice, f.w.id, agent.id);
  let calls = 0;
  f.provider.execute = async (sandboxId, operation, args) => {
    assert.ok(f.provider.boxes.has(sandboxId));
    assert.equal(operation, "bash");
    assert.equal(args.command, "exit 73");
    assert.equal(args.timeoutSeconds, 60);
    calls++;
    return { text: "sandbox shell result" };
  };
  const run = await f.service.submit(alice, session.id, "shell");
  assert.equal((await drain(f, run.id)).state, "WAITING_INPUT");
  assert.equal(calls, 0);
  const interaction = await f.store.tx(
    "one",
    (s) => Object.values(s.interactions)[0]!,
  );
  assert.equal((interaction.payload as { name: string }).name, "bash");
  const resumed = await f.service.respond(alice, interaction.id, "approve");
  assert.equal((await drain(f, resumed!.id)).state, "COMPLETED");
  assert.equal(calls, 1);
});

test("bash cannot bypass the configured tool allowlist", async () => {
  const f = await fixture({
    execute: async (c) => {
      await c.call("bash", { command: "exit 73" });
    },
  });
  const run = await f.service.submit(alice, f.ses.id, "shell");
  assert.equal((await drain(f, run.id)).error, "TOOL_DENIED");
  assert.equal(f.provider.boxes.size, 0);
  assert.deepEqual(
    await f.store.tx("one", (s) => Object.values(s.interactions)),
    [],
  );
});

test("denied approval performs no side effect; a revoked actor cannot approve", async () => {
  const f = await fixture({
    execute: async (c) => {
      if (c.prompt === "write")
        await c.call("write", { path: "x", content: "a" });
    },
  });
  const r = await f.service.submit(alice, f.ses.id, "write");
  await drain(f, r.id);
  const i = await f.store.tx("one", (s) => Object.values(s.interactions)[0]!);
  await assert.rejects(f.service.respond(bob, i.id, "approve"));
  const next = await f.service.respond(alice, i.id, "deny");
  await drain(f, next!.id);
  assert.equal(f.provider.boxes.size, 0);
});
test("unknown tool and model supplied sandbox identifiers are rejected", async () => {
  const f = await fixture({
    execute: async (c) => {
      await c.call("write", {
        path: "x",
        content: "a",
        sandboxId: "other",
      });
    },
  });
  const r = await f.service.submit(alice, f.ses.id, "write");
  assert.equal((await drain(f, r.id)).state, "FAILED");
  assert.equal(f.provider.boxes.size, 0);
});
test("forged unowned MCP tool is rejected before creating approval or executing a server", async () => {
  const f = await fixture({
    execute: async (c) => {
      await c.call("mcp_hidden_search", { query: "secret" });
    },
  });
  const r = await f.service.submit(alice, f.ses.id, "forge");
  assert.equal((await drain(f, r.id)).error, "MCP_TOOL_DENIED");
  assert.deepEqual(
    await f.store.tx("one", (s) => Object.values(s.interactions)),
    [],
  );
});
test("Cube lifecycle adapter preserves a workspace volume across sandbox destruction", async () => {
  const f = await fixture();
  await f.sandbox.execute(alice, f.w.id, "a", "default", "write", {
    path: "file",
    content: "persistent",
  });
  const w = await f.store.tx("one", (s) => s.workspaces[f.w.id]!);
  await f.provider.kill(w.sandboxId!);
  assert.deepEqual(
    await f.sandbox.execute(alice, f.w.id, "b", "default", "read", {
      path: "file",
    }),
    { text: "persistent" },
  );
  const w2 = await f.store.tx("one", (s) => s.workspaces[f.w.id]!);
  assert.equal(w.volumeId, w2.volumeId);
  assert.notEqual(w.sandboxId, w2.sandboxId);
  await assert.rejects(
    f.sandbox.execute(alice, f.w.id, "c", "default", "read", {
      path: "/etc/passwd",
    }),
    { code: "PATH_DENIED" },
  );
});
test("worker crash fails uncertain work without replay; waiting lease is released", async () => {
  const f = await fixture();
  const r = await f.service.submit(alice, f.ses.id, "work");
  await f.store.tx("one", (s) => {
    s.runs[r.id]!.state = "RUNNING";
    s.runs[r.id]!.lease = { owner: "dead-worker", expires: 0 };
  });
  await f.worker.tick();
  const result = await f.store.tx("one", (s) => s.runs[r.id]!);
  assert.equal(result.state, "FAILED");
  assert.equal(result.error, "WORKER_LOST_UNKNOWN_TOOL_OUTCOME");
  assert.equal(f.provider.boxes.size, 0);
});
test("cancellation and immediate authorization checks stop later tools", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const f = await fixture({
    execute: async (c) => {
      await blocked;
      await c.call("read", { path: "x" });
    },
  });
  const r = await f.service.submit(alice, f.ses.id, "work");
  await f.worker.tick();
  await f.service.cancel(alice, r.id);
  release();
  assert.equal((await drain(f, r.id)).state, "CANCELLED");
  assert.equal(f.provider.boxes.size, 0);
});
test("member removal is checked when queued work starts", async () => {
  const f = await fixture();
  await f.store.tx("one", (s) => {
    s.workspaces[f.w.id]!.members.bob = "editor";
  });
  const r = await f.service.submit(bob, f.ses.id, "work");
  await f.store.tx("one", (s) => {
    delete s.workspaces[f.w.id]!.members.bob;
  });
  assert.equal((await drain(f, r.id)).state, "FAILED");
});
test("question is durable and resumes through an independent Run", async () => {
  const f = await fixture({
    execute: async (c) => {
      if (c.prompt === "ask")
        await c.call("ask_user_question", { question: "Choose a color" });
      else await c.emit("message.completed", { answer: c.prompt });
    },
  });
  const av = await f.service.publish(
    alice,
    config({ tools: ["ask_user_question"] }),
  );
  const ses = await f.service.createSession(alice, f.w.id, av.id);
  const r = await f.service.submit(alice, ses.id, "ask");
  assert.equal((await drain(f, r.id)).state, "WAITING_INPUT");
  const i = await f.store.tx("one", (s) => Object.values(s.interactions)[0]!);
  const next = await f.service.respond(alice, i.id, "blue");
  assert.equal((await drain(f, next!.id)).state, "COMPLETED");
});
test("subagent capability intersection, independent session and root step budget", async () => {
  const f = await fixture({
    execute: async (c) => {
      if (c.prompt === "parent") {
        await c.call("delegate_to_agent", {
          agentVersionId: c.config.subagents[0],
          task: "child",
        });
      } else {
        assert.deepEqual(c.config.tools, ["todo"]);
        await c.call("todo", { items: [] });
      }
    },
  });
  const child = await f.service.publish(
    alice,
    config({ tools: ["todo", "bash"] }),
  );
  const parent = await f.service.publish(
    alice,
    config({ tools: ["delegate_to_agent", "todo"], subagents: [child.id] }),
  );
  const ses = await f.service.createSession(alice, f.w.id, parent.id);
  const r = await f.service.submit(alice, ses.id, "parent");
  assert.equal((await drain(f, r.id)).state, "COMPLETED");
  const state = await f.store.tx("one", (s) => s);
  const children = Object.values(state.runs).filter(
    (x) => x.parentRunId === r.id,
  );
  assert.equal(children.length, 1);
  assert.notEqual(children[0]!.sessionId, ses.id);
  assert.equal(children[0]!.state, "COMPLETED");
  assert.equal(state.runs[r.id]!.steps, 2);
});
test("runtime config cannot inject code or transport endpoints", async () => {
  const f = await fixture();
  await assert.rejects(
    f.service.publish(alice, { ...config(), extensions: ["file.js"] }),
  );
  await assert.rejects(
    f.service.publish(alice, config({ mcpServers: ["arbitrary"] })),
    { code: "INVALID_MCP" },
  );
  await assert.rejects(
    f.service.publish(alice, config({ skillBundle: "other" })),
    { code: "UNKNOWN_SKILL_BUNDLE" },
  );
});

test("agent access revocation blocks new sessions and queued work", async () => {
  const f = await fixture();
  const r = await f.service.submit(alice, f.ses.id, "work");
  await f.store.tx("one", (s) => {
    s.logicalAgents[f.agent.agentId!]!.allowedUsers = ["bob"];
  });
  await assert.rejects(f.service.createSession(alice, f.w.id, f.agent.id), {
    code: "AGENT_NOT_FOUND",
  });
  assert.equal((await drain(f, r.id)).state, "FAILED");
});
test("parallel grep and find in one Run transparently serialize", async () => {
  const f = await fixture({
    execute: async (ctx) => {
      await Promise.all([
        ctx.call("grep", { path: "/workspace", pattern: "TODO" }),
        ctx.call("find", { path: "/workspace" }),
      ]);
    },
  });
  const agent = await f.service.publish(
    alice,
    config({ tools: ["grep", "find"] }),
  );
  const session = await f.service.createSession(alice, f.w.id, agent.id);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const began = new Promise<void>((r) => (entered = r));
  const calls: string[] = [];
  f.provider.execute = async (_sid, op) => {
    calls.push(op);
    if (calls.length === 1) {
      entered();
      await gate;
    }
    return { text: "result" };
  };
  const run = await f.service.submit(alice, session.id, "search");
  try {
    await f.worker.tick();
    await began;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls.length, 1);
    await assert.rejects(f.sandbox.release(alice, f.w.id), {
      code: "WORKSPACE_BUSY",
    });
    release();
    assert.equal((await drain(f, run.id)).state, "COMPLETED");
    assert.deepEqual(calls.sort(), ["find", "grep"]);
    const events = await f.store.read(alice.tenantId, (s) =>
      s.events.filter((e) => e.runId === run.id),
    );
    assert.equal(events.filter((e) => e.type === "tool.completed").length, 2);
    assert.equal(events.filter((e) => e.type === "tool.failed").length, 0);
  } finally {
    release();
    await f.worker.stop();
  }
});
test("queued Worker tools reauthorize a revoked Agent before acquiring the lease", async () => {
  const f = await fixture({
    execute: async (ctx) => {
      await ctx.call("ls", {});
    },
  });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    began = new Promise<void>((r) => (entered = r));
  const held = f.sandbox.withLease(
    alice,
    f.w.id,
    "other-run",
    "default",
    async () => {
      entered();
      await gate;
    },
  );
  let calls = 0;
  f.provider.execute = async () => {
    calls++;
    return {};
  };
  const run = await f.service.submit(alice, f.ses.id, "queued");
  try {
    await began;
    await f.worker.tick();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls, 0);
    await f.store.tx(alice.tenantId, (s) => {
      s.agents[f.agent.id]!.enabled = false;
    });
    release();
    await held;
    const result = await drain(f, run.id);
    assert.equal(result.state, "FAILED");
    assert.equal(result.error, "AGENT_REVOKED");
    assert.equal(calls, 0);
  } finally {
    release();
    await held;
    await f.worker.stop();
  }
});
test("token budget terminates model execution", async () => {
  const f = await fixture({
    execute: async (c) => {
      await c.consume(100001, false);
    },
  });
  const r = await f.service.submit(alice, f.ses.id, "work");
  const result = await drain(f, r.id);
  assert.equal(result.state, "FAILED");
  assert.equal(result.error, "TOKEN_BUDGET_EXCEEDED");
});

test("timeout aborts a stalled model and expired UCS identity cannot start work", async () => {
  const f = await fixture({
    execute: async (c) => {
      await new Promise<void>((resolve) =>
        c.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      c.signal.throwIfAborted();
    },
  });
  const av = await f.service.publish(alice, config({ timeoutSeconds: 1 }));
  const ses = await f.service.createSession(alice, f.w.id, av.id);
  const r = await f.service.submit(alice, ses.id, "stalled");
  const end = await drain(f, r.id);
  assert.equal(end.state, "FAILED");
  assert.equal(end.error, "RUN_TIMEOUT");
  const expired = { ...alice, expiresAt: Date.now() - 1000 };
  const next = await f.service.submit(expired, ses.id, "expired");
  assert.equal((await drain(f, next.id)).error, "ACTOR_TOKEN_EXPIRED");
});

test("unconfirmed remote cancellation is FAILED rather than claiming the command stopped", async () => {
  let active!: () => void;
  const started = new Promise<void>((r) => (active = r));
  let unblock!: () => void;
  const gate = new Promise<void>((r) => (unblock = r));
  const f = await fixture({
    execute: async (c) => {
      await c.call("read", { path: "x" });
    },
  });
  f.provider.execute = async () => {
    active();
    await gate;
    return { text: "unknown" };
  };
  f.provider.kill = async () => {
    unblock();
    throw new Error("remote kill failed");
  };
  const r = await f.service.submit(alice, f.ses.id, "work");
  await f.worker.tick();
  await started;
  await f.service.cancel(alice, r.id);
  const result = await drain(f, r.id);
  assert.equal(result.state, "FAILED");
  assert.equal(result.error, "REMOTE_CANCEL_UNCONFIRMED");
});

test("tenant administrator cannot register capabilities granted only to another tenant", async () => {
  const store = new MemoryStore();
  const grants = {
    one: { bundles: ["a"], endpoints: ["one-endpoint"] },
    two: { bundles: ["b"], endpoints: ["two-endpoint"] },
  };
  const svc = new HarnessService(
    store,
    ["one-endpoint", "two-endpoint"],
    ["a", "b"],
    undefined,
    grants,
  );
  assert.equal(svc.hasBundle("b", "one"), false);
  assert.equal(svc.hasEndpoint("two-endpoint", "one"), false);
  assert.equal(svc.hasBundle("a", "constructor"), false);
  await assert.rejects(svc.publish(alice, config({ skillBundle: "b" })), {
    code: "UNKNOWN_SKILL_BUNDLE",
  });
  assert.ok(await svc.publish(alice, config({ skillBundle: "a" })));
});
test("prototype names do not impersonate a workspace member", async () => {
  const f = await fixture();
  for (const userId of ["constructor", "toString", "__proto__"]) {
    await assert.rejects(
      f.service.createSession({ ...bob, userId }, f.w.id, f.agent.id),
      { code: "WORKSPACE_NOT_FOUND" },
    );
  }
});

test("SSE polls are read-only, replay ordered pages via Last-Event-ID, and recheck ACL on every poll", async () => {
  const { event } = await import("../src/domain.js");
  const f = await fixture();
  const r = await f.service.submit(alice, f.ses.id, "stream");
  await f.store.tx("one", (s) => {
    s.runs[r.id]!.state = "RUNNING";
    s.workspaces[f.w.id]!.members.bob = "viewer";
    for (let i = 0; i < 155; i++)
      event(s, s.runs[r.id]!, "test.event", { index: i });
  });
  let reads = 0,
    writes = 0;
  const originalRead = f.store.read.bind(f.store),
    originalTx = f.store.tx.bind(f.store);
  f.store.read = async (...args) => {
    reads++;
    return originalRead(...args);
  };
  f.store.tx = async (...args) => {
    writes++;
    return originalTx(...args);
  };
  const app = buildAPI(f.service, async () => bob, f.sandbox);
  const stream = app.inject({
    method: "GET",
    url: `/api/v1/runs/${r.id}/events`,
    headers: { authorization: "Bearer bob", "last-event-id": "1" },
  });
  try {
    const deadline = Date.now() + 2000;
    while (reads < 4 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(reads >= 4, "wait for two pages and an idle poll");
    assert.equal(writes, 0, "SSE polling must not issue write transactions");
    await originalTx("one", (s) => {
      delete s.workspaces[f.w.id]!.members.bob;
    });
    const response = await stream;
    const ids = [...response.body.matchAll(/^id: (\d+)$/gm)].map((m) =>
      Number(m[1]),
    );
    assert.deepEqual(
      ids,
      Array.from({ length: 155 }, (_, i) => i + 2),
    );
    assert.match(response.body, /ACCESS_REVOKED_OR_UNAVAILABLE/);
    assert.doesNotMatch(response.body, /event: run.queued/);
    assert.ok(writes <= 1, "only request completion audit may write");
  } finally {
    // Ensure a failed assertion cannot leave a hijacked stream running.
    await originalTx("one", (s) => {
      s.runs[r.id]!.state = "COMPLETED";
    });
    await stream;
    await app.close();
  }
});

test("SSE expires its connection identity and renewed credentials replay missed events", async () => {
  const { event } = await import("../src/domain.js");
  const f = await fixture();
  const r = await f.service.submit(alice, f.ses.id, "expiry");
  await f.store.tx("one", (s) => {
    s.runs[r.id]!.state = "RUNNING";
  });
  const expiresAt = Date.now() + 150;
  const app = buildAPI(
    f.service,
    async (header) => ({
      ...alice,
      expiresAt: header === "Bearer renewed" ? Date.now() + 60000 : expiresAt,
    }),
    f.sandbox,
  );
  try {
    const first = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${r.id}/events`,
      headers: { authorization: "Bearer short" },
    });
    assert.match(first.body, /AUTHENTICATION_EXPIRED/);
    const ids = [...first.body.matchAll(/^id: (\d+)$/gm)].map((m) =>
      Number(m[1]),
    );
    assert.deepEqual(ids, [1]);
    await f.store.tx("one", (s) => {
      event(s, s.runs[r.id]!, "test.after-expiry");
      s.runs[r.id]!.state = "COMPLETED";
    });
    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${r.id}/events`,
      headers: { authorization: "Bearer short" },
    });
    assert.equal(denied.statusCode, 401);
    const replay = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${r.id}/events`,
      headers: { authorization: "Bearer renewed", "last-event-id": "1" },
    });
    assert.match(replay.body, /id: 2/);
    assert.match(replay.body, /test.after-expiry/);
    assert.doesNotMatch(replay.body, /id: 1/);
  } finally {
    await app.close();
  }
});

test("SSE does not send a batch when a pending database read crosses token expiry", async () => {
  const f = await fixture();
  const r = await f.service.submit(alice, f.ses.id, "delayed read");
  const read = f.store.read.bind(f.store);
  let reads = 0;
  f.store.read = async (...args) => {
    if (++reads === 2) await new Promise((resolve) => setTimeout(resolve, 150));
    return read(...args);
  };
  const app = buildAPI(
    f.service,
    async () => ({ ...alice, expiresAt: Date.now() + 50 }),
    f.sandbox,
  );
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${r.id}/events`,
    });
    assert.match(response.body, /AUTHENTICATION_EXPIRED/);
    assert.doesNotMatch(response.body, /^id:/m);
  } finally {
    await app.close();
  }
});
test("SSE token expiry closes a backpressured connection even when the client stops reading", async () => {
  const { get } = await import("node:http");
  const { event } = await import("../src/domain.js");
  const f = await fixture(),
    r = await f.service.submit(alice, f.ses.id, "blocked stream");
  await f.store.tx(alice.tenantId, (s) => {
    for (let i = 0; i < 100; i++)
      event(s, s.runs[r.id]!, "message.delta", {
        delta: "x".repeat(256 * 1024),
      });
  });
  const app = buildAPI(
    f.service,
    async () => ({ ...alice, expiresAt: Date.now() + 500 }),
    f.sandbox,
  );
  let closed = false,
    backpressured = false;
  let probe: ReturnType<typeof setTimeout> | undefined;
  app.addHook("onRequest", async (_req, reply) => {
    reply.raw.once("close", () => {
      closed = true;
    });
    probe = setTimeout(() => {
      backpressured = reply.raw.writableNeedDrain;
    }, 350);
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const request = get(`${base}/api/v1/runs/${r.id}/events`, (response) => {
    response.pause();
    response.on("error", () => {});
  });
  request.on("error", () => {});
  try {
    const end = Date.now() + 2000;
    while (!closed && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      backpressured,
      true,
      "test must reach stalled response backpressure",
    );
    assert.equal(
      closed,
      true,
      "expiry must release the server connection despite an unread response",
    );
  } finally {
    clearTimeout(probe);
    request.destroy();
    await app.close();
  }
});
