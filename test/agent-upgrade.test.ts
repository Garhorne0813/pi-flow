import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { HarnessService, authorizedRun } from "../src/service.js";
import { AgentConfig, id, type Actor } from "../src/domain.js";
import { DemoSandbox, SandboxManager } from "../src/adapters/sandbox.js";
import { Worker } from "../src/worker.js";
import { MCPManager } from "../src/adapters/mcp.js";
import { DemoRuntime } from "../src/runtime.js";
import { buildAPI } from "../src/api.js";
const actor: Actor = { tenantId: "upgrade", userId: "u", admin: true };
const config = (extra = {}) =>
  AgentConfig.parse({
    name: "agent",
    systemPrompt: "V1",
    model: { provider: "demo", modelId: "demo" },
    tools: ["read"],
    skillBundle: "default",
    ...extra,
  });
async function fixture() {
  const store = new MemoryStore(),
    service = new HarnessService(store, [], ["default", "other"]);
  const v1 = await service.publish(actor, config());
  const w = await service.createWorkspace(actor, "persistent");
  const ses = await service.createSession(actor, w.id, v1.id);
  const provider = new DemoSandbox(),
    sandbox = new SandboxManager(store, provider);
  return { store, service, v1, w, ses, provider, sandbox };
}
async function waiting(
  f: Awaited<ReturnType<typeof fixture>>,
  rid: string,
  kind: "approval" | "question" = "question",
) {
  const iid = id();
  await f.store.tx(actor.tenantId, (s) => {
    s.runs[rid]!.state = "WAITING_INPUT";
    s.interactions[iid] = {
      id: iid,
      runId: rid,
      kind,
      payload: {},
      resolved: false,
    };
  });
  return iid;
}
test("queued version stays pinned; new roots upgrade atomically and preserve conversation, Todo and Workspace", async () => {
  const f = await fixture();
  await f.store.tx(actor.tenantId, (s) => {
    s.sessions[f.ses.id]!.entries = [{ history: true }];
    s.todos[f.ses.id] = ["todo"];
  });
  const old = await f.service.submit(actor, f.ses.id, "old", "key");
  const v2 = await f.service.publish(
    actor,
    config({ systemPrompt: "V2" }),
    f.v1.agentId,
  );
  assert.equal(old.agentVersionId, f.v1.id);
  assert.equal(
    (await f.service.submit(actor, f.ses.id, "old", "key")).id,
    old.id,
  );
  await assert.rejects(f.service.submit(actor, f.ses.id, "new"), {
    code: "SESSION_BUSY",
  });
  const second = await f.service.createSession(actor, f.w.id, f.v1.id);
  const newRoot = await f.service.submit(actor, second.id, "new");
  assert.equal(newRoot.agentVersionId, v2.id);
  await f.store.tx(actor.tenantId, (s) => {
    assert.equal(authorizedRun(s, s.runs[old.id]!).config.systemPrompt, "V1");
    s.runs[old.id]!.state = "COMPLETED";
    s.runs[newRoot.id]!.state = "COMPLETED";
  });
  const results = await Promise.all([
    f.service.submit(actor, f.ses.id, "latest", "latest"),
    f.service.submit(actor, f.ses.id, "latest", "latest"),
  ]);
  assert.equal(results[0]!.id, results[1]!.id);
  assert.equal(results[0]!.agentVersionId, v2.id);
  assert.equal(results[0]!.taskId, results[0]!.id);
  await f.store.read(actor.tenantId, (s) => {
    assert.equal(s.sessions[f.ses.id]!.effectiveVersionId, v2.id);
    assert.deepEqual(s.sessions[f.ses.id]!.entries, [{ history: true }]);
    assert.deepEqual(s.todos[f.ses.id], ["todo"]);
    assert.equal(s.sessions[f.ses.id]!.workspaceId, f.w.id);
    assert.equal(
      s.events.filter((e) => e.type === "session.version.upgraded").length,
      1,
    );
    assert.equal(s.agents[f.v1.id]!.enabled, true);
  });
  await f.store.tx(actor.tenantId, (s) => {
    s.agents[v2.id]!.enabled = false;
  });
  assert.equal(
    (await f.service.submit(actor, f.ses.id, "latest", "latest")).id,
    results[0]!.id,
  );
});
for (const lifecycle of ["active", "paused", "released"] as const) {
  for (const kind of ["approval", "question"] as const) {
    test(`${kind} continuation remains V1 after V2 publish and Sandbox ${lifecycle}`, async () => {
      const f = await fixture();
      await f.sandbox.execute(actor, f.w.id, "seed", "default", "write", {
        path: "file.txt",
        content: "persistent",
      });
      const root = await f.service.submit(actor, f.ses.id, "old");
      const iid = await waiting(f, root.id, kind);
      const v2 = await f.service.publish(
        actor,
        config({ systemPrompt: "V2" }),
        f.v1.agentId,
      );
      if (lifecycle === "paused") await f.sandbox.pause(actor, f.w.id);
      if (lifecycle === "released") await f.sandbox.release(actor, f.w.id);
      const next = await f.service.respond(
        actor,
        iid,
        kind === "approval" ? "approve" : "answer",
      );
      assert.equal(next!.agentVersionId, f.v1.id);
      assert.equal(next!.taskId, root.taskId);
      assert.equal(next!.rootRunId, root.id);
      assert.equal(
        (await f.service.respond(
          actor,
          iid,
          kind === "approval" ? "approve" : "answer",
        ))!.id,
        next!.id,
      );
      assert.deepEqual(
        await f.sandbox.execute(actor, f.w.id, "read", "default", "read", {
          path: "file.txt",
        }),
        { text: "persistent" },
      );
      await f.store.tx(actor.tenantId, (s) => {
        s.runs[next!.id]!.state = "COMPLETED";
      });
      assert.equal(
        (await f.service.submit(actor, f.ses.id, "new")).agentVersionId,
        v2.id,
      );
    });
  }
}
test("delegation and child continuations inherit task identity and immutable child versions", async () => {
  const f = await fixture();
  const child = await f.service.publish(actor, config());
  const parent = await f.service.publish(
    actor,
    config({ subagents: [child.id], maxDepth: 2 }),
  );
  const ses = await f.service.createSession(actor, f.w.id, parent.id);
  const root = await f.service.submit(actor, ses.id, "parent");
  await f.service.publish(
    actor,
    config({ systemPrompt: "new parent" }),
    parent.agentId,
  );
  const delegated = await f.service.delegate(
    actor.tenantId,
    root.id,
    child.id,
    "child",
    "owner",
  );
  assert.equal(delegated.taskId, root.taskId);
  assert.equal(delegated.rootRunId, root.id);
  await f.service.publish(
    actor,
    config({ systemPrompt: "new child" }),
    child.agentId,
  );
  await f.store.tx(actor.tenantId, (s) => {
    delete s.runs[delegated.id]!.lease;
    s.runs[root.id]!.state = "COMPLETED";
  });
  const iid = await waiting(f, delegated.id);
  await assert.rejects(f.service.submit(actor, ses.id, "premature"), {
    code: "SESSION_BUSY",
  });
  const continuation = await f.service.respond(actor, iid, "answer");
  assert.equal(continuation!.agentVersionId, child.id);
  assert.equal(continuation!.taskId, root.taskId);
  await f.store.tx(actor.tenantId, (s) => {
    s.agents[parent.id]!.enabled = false;
    assert.throws(() => authorizedRun(s, s.runs[continuation!.id]!), {
      code: "AGENT_REVOKED",
    });
  });
});
test("bundle mismatch and incompatible shared Workspace tasks reject without changing Session", async () => {
  const f = await fixture();
  const old = await f.service.submit(actor, f.ses.id, "old");
  await waiting(f, old.id);
  await f.store.tx(actor.tenantId, (s) => {
    s.skills["s@1"] = {
      id: "s@1",
      name: "s",
      description: "s",
      bundle: "default",
      path: "/skills/s/SKILL.md",
      digest: "a".repeat(64),
      enabled: true,
    };
  });
  const v2 = await f.service.publish(
    actor,
    config({ skills: ["s@1"] }),
    f.v1.agentId,
  );
  const other = await f.service.createSession(actor, f.w.id, v2.agentId!);
  await assert.rejects(f.service.submit(actor, other.id, "new"), {
    code: "WORKSPACE_VERSION_BUSY",
  });
  await f.store.tx(actor.tenantId, (s) => {
    s.runs[old.id]!.state = "COMPLETED";
    s.workspaces[f.w.id]!.lock = { owner: "tool", expires: Date.now() + 10000 };
  });
  await assert.rejects(f.service.submit(actor, f.ses.id, "new"), {
    code: "WORKSPACE_BUSY",
  });
  await f.store.tx(actor.tenantId, (s) => {
    delete s.workspaces[f.w.id]!.lock;
  });
  await f.service.publish(
    actor,
    config({ skillBundle: "other" }),
    f.v1.agentId,
  );
  await assert.rejects(f.service.submit(actor, f.ses.id, "new"), {
    code: "WORKSPACE_BUNDLE_MIGRATION_REQUIRED",
  });
  assert.equal(
    (await f.store.read(actor.tenantId, (s) => s.sessions[f.ses.id]!))
      .agentVersionId,
    f.v1.id,
  );
});
for (const lifecycle of ["active", "paused", "released"] as const) {
  test(`changed skills rebuild ${lifecycle} Sandbox with persistent Volume`, async () => {
    const f = await fixture();
    await f.sandbox.execute(actor, f.w.id, "seed", "default", "write", {
      path: "file.txt",
      content: "persistent",
    });
    const before = await f.store.read(
      actor.tenantId,
      (s) => s.workspaces[f.w.id]!,
    );
    if (lifecycle === "paused") await f.sandbox.pause(actor, f.w.id);
    if (lifecycle === "released") await f.sandbox.release(actor, f.w.id);
    await f.store.tx(actor.tenantId, (s) => {
      s.skills["s@1"] = {
        id: "s@1",
        name: "s",
        description: "s",
        bundle: "default",
        path: "/skills/s/SKILL.md",
        digest: "a".repeat(64),
        enabled: true,
      };
    });
    const v2 = await f.service.publish(
      actor,
      config({ skills: ["s@1"] }),
      f.v1.agentId,
    );
    const root = await f.service.submit(actor, f.ses.id, "new");
    assert.equal(root.agentVersionId, v2.id);
    await f.sandbox.execute(
      actor,
      f.w.id,
      "new",
      "default",
      "read",
      { path: "file.txt" },
      undefined,
      ["s@1"],
    );
    const after = await f.store.read(
      actor.tenantId,
      (s) => s.workspaces[f.w.id]!,
    );
    assert.equal(after.volumeId, before.volumeId);
    assert.notEqual(after.sandboxId, before.sandboxId);
    assert.deepEqual(after.sandboxSkills, ["s@1"]);
  });
}
test("Worker executes pinned version even after Session effective version changes", async () => {
  const f = await fixture();
  const root = await f.service.submit(actor, f.ses.id, "hello");
  const v2 = await f.service.publish(
    actor,
    config({ systemPrompt: "V2" }),
    f.v1.agentId,
  );
  await f.store.tx(actor.tenantId, (s) => {
    s.sessions[f.ses.id]!.agentVersionId = v2.id;
  });
  const seen: string[] = [];
  const demo = new DemoRuntime();
  const worker = new Worker(
    f.service,
    {
      async execute(input) {
        seen.push(input.config.systemPrompt);
        return demo.execute(input);
      },
    },
    f.sandbox,
    new MCPManager(f.store, {}),
  );
  for (let i = 0; i < 100; i++) {
    await worker.tick();
    if (
      await f.store.read(
        actor.tenantId,
        (s) => s.runs[root.id]!.state === "COMPLETED",
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(seen, ["V1"]);
});
test("API publishes successors, activates versions, and creates Sessions through either selector", async () => {
  const f = await fixture(),
    app = buildAPI(f.service, async () => actor, f.sandbox);
  const headers = { authorization: "Bearer test" };
  const published = await app.inject({
    method: "POST",
    url: `/api/v1/admin/agents/${f.v1.agentId}/versions`,
    headers,
    payload: config({ systemPrompt: "V2" }),
  });
  assert.equal(published.statusCode, 201);
  const v2 = published.json();
  const sessions = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${f.w.id}/sessions`,
    headers,
    payload: { agentVersionId: f.v1.id },
  });
  assert.equal(sessions.json().agentVersionId, v2.id);
  const listed = await app.inject({
    method: "GET",
    url: "/api/v1/logical-agents",
    headers,
  });
  assert.equal(listed.json().items[0].activeVersionId, v2.id);
  const activated = await app.inject({
    method: "PUT",
    url: `/api/v1/admin/agents/${f.v1.agentId}/active-version`,
    headers,
    payload: { agentVersionId: f.v1.id },
  });
  assert.equal(activated.statusCode, 200);
  const logical = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${f.w.id}/sessions`,
    headers,
    payload: { agentId: f.v1.agentId },
  });
  assert.equal(logical.json().agentVersionId, f.v1.id);
  await app.close();
});

test("compatible ACTIVE Sandbox is reused across versions; publication races bind one whole version", async () => {
  const f = await fixture();
  await f.sandbox.execute(actor, f.w.id, "seed", "default", "write", {
    path: "file.txt",
    content: "persistent",
  });
  const before = await f.store.read(
    actor.tenantId,
    (s) => s.workspaces[f.w.id]!.sandboxId,
  );
  const [v2, root] = await Promise.all([
    f.service.publish(
      actor,
      config({ systemPrompt: "V2", tools: ["ls"] }),
      f.v1.agentId,
    ),
    f.service.submit(actor, f.ses.id, "racing"),
  ]);
  assert.equal(root.agentVersionId, v2.id);
  assert.equal(root.capabilities!.systemPrompt, "V2");
  assert.deepEqual(root.capabilities!.tools, ["ls"]);
  await f.sandbox.execute(actor, f.w.id, "new", "default", "ls", {});
  assert.equal(
    await f.store.read(actor.tenantId, (s) => s.workspaces[f.w.id]!.sandboxId),
    before,
  );
  await f.store.tx(actor.tenantId, (s) => {
    s.runs[root.id]!.state = "COMPLETED";
  });
  const [accepted, v3] = await Promise.all([
    f.service.submit(actor, f.ses.id, "accepted before publication"),
    f.service.publish(actor, config({ systemPrompt: "V3" }), f.v1.agentId),
  ]);
  assert.equal(accepted.agentVersionId, v2.id);
  assert.notEqual(accepted.agentVersionId, v3.id);
});

test("latest Skill/MCP revocation is checked before acceptance and rolls back Session upgrades", async () => {
  const f = await fixture();
  const service = new HarnessService(f.store, ["endpoint"], ["default"]);
  await f.store.tx(actor.tenantId, (s) => {
    s.mcp.m = {
      id: "m",
      endpointRef: "endpoint",
      allowedTools: ["read"],
      enabled: true,
    };
  });
  const v2 = await service.publish(
    actor,
    config({ mcpServers: ["m"] }),
    f.v1.agentId,
  );
  await f.store.tx(actor.tenantId, (s) => {
    s.mcp.m!.enabled = false;
  });
  await assert.rejects(service.submit(actor, f.ses.id, "new"), {
    code: "MCP_REVOKED",
  });
  assert.equal(
    await f.store.read(
      actor.tenantId,
      (s) => s.sessions[f.ses.id]!.agentVersionId,
    ),
    f.v1.id,
  );
  await f.store.tx(actor.tenantId, (s) => {
    s.mcp.m!.enabled = true;
  });
  const accepted = await service.submit(actor, f.ses.id, "new");
  assert.equal(accepted.agentVersionId, v2.id);
  await f.store.tx(actor.tenantId, (s) => {
    s.mcp.m!.enabled = false;
    assert.throws(() => authorizedRun(s, s.runs[accepted.id]!), {
      code: "MCP_REVOKED",
    });
  });
});
