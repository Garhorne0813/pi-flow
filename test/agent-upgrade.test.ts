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

test("publication and rollback preserve the logical ACL; historical queries and execution enforce it", async () => {
  const f = await fixture();
  const bob = { ...actor, userId: "bob", admin: false };
  await f.store.tx(actor.tenantId, (s) => {
    s.workspaces[f.w.id]!.members.bob = "editor";
  });
  const users = [actor.userId, "bob"];
  await f.service.setAccess(actor, f.v1.id, users);
  users.push("unexpected");
  const bobSession = await f.service.createSession(bob, f.w.id, f.v1.id);
  const old = await f.service.submit(bob, bobSession.id, "before restriction");
  const v2 = await f.service.publish(
    actor,
    config({ systemPrompt: "V2" }),
    f.v1.agentId,
  );
  assert.equal(v2.allowedUsers, undefined);
  await f.service.setAccess(actor, v2.id, [actor.userId]);
  await f.service.activate(actor, f.v1.agentId!, f.v1.id);
  await assert.rejects(f.service.createSession(bob, f.w.id, f.v1.id), {
    code: "AGENT_NOT_FOUND",
  });
  await assert.rejects(f.service.submit(bob, f.ses.id, "unauthorized"), {
    code: "AGENT_DISABLED_OR_DENIED",
  });
  await f.store.read(actor.tenantId, (s) => {
    assert.throws(() => authorizedRun(s, s.runs[old.id]!), {
      code: "AGENT_REVOKED",
    });
  });
  const v3 = await f.service.publish(
    actor,
    config({ systemPrompt: "V3" }),
    f.v1.agentId,
  );
  assert.equal(v3.agentId, f.v1.agentId);
  assert.deepEqual(
    await f.store.read(
      actor.tenantId,
      (s) => s.logicalAgents[f.v1.agentId!]!.allowedUsers,
    ),
    [actor.userId],
  );
  const app = buildAPI(
    f.service,
    async (header) => (header === "Bearer bob" ? bob : actor),
    f.sandbox,
  );
  for (const path of ["/api/v1/agents", "/api/v1/logical-agents"]) {
    const denied = await app.inject({
      method: "GET",
      url: path,
      headers: { authorization: "Bearer bob" },
    });
    assert.deepEqual(denied.json().items, []);
    const allowed = await app.inject({
      method: "GET",
      url: path,
      headers: { authorization: "Bearer alice" },
    });
    assert.ok(allowed.json().items.length > 0);
  }
  const access = await app.inject({
    method: "PUT",
    url: `/api/v1/admin/logical-agents/${f.v1.agentId}/access`,
    headers: { authorization: "Bearer alice" },
    payload: { allowedUsers: [actor.userId, "bob"] },
  });
  assert.equal(access.statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/agents",
        headers: { authorization: "Bearer bob" },
      })
    ).json().items.length,
    3,
  );
  // Legacy version access route is an alias for the SAME logical policy.
  await app.inject({
    method: "PUT",
    url: `/api/v1/admin/agents/${f.v1.id}/access`,
    headers: { authorization: "Bearer alice" },
    payload: { allowedUsers: [actor.userId] },
  });
  assert.deepEqual(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/agents",
        headers: { authorization: "Bearer bob" },
      })
    ).json().items,
    [],
  );
  await app.close();
});

for (const backend of ["volume", "host"] as const) {
  for (const legacy of [false, true]) {
    test(`Cube ${backend} scope permits compatible submission during a tool lease (${legacy ? "legacy" : "recorded"} logical scope)`, async (t) => {
      const f = await fixture();
      const { CubeProvider } = await import("../src/adapters/sandbox.js");
      const { skillScope } = await import("../src/adapters/skill-mounts.js");
      const sk = {
        id: "s@1",
        name: "s",
        description: "s",
        bundle: "default",
        path: "/skills/s/SKILL.md",
        digest: "a".repeat(64),
        enabled: true,
      };
      await f.store.tx(actor.tenantId, (s) => {
        s.skills[sk.id] = sk;
      });
      const v1 = await f.service.publish(
        actor,
        config({ skills: [sk.id] }),
        f.v1.agentId,
      );
      const second = await f.service.createSession(actor, f.w.id, v1.agentId!);
      const root = await f.service.submit(actor, f.ses.id, "holding lease");
      const binding =
        backend === "volume"
          ? { bundle: "default", path: sk.path, volume: "skill-volume" }
          : { bundle: "default", path: sk.path, hostPath: "/approved/s" };
      const cube = new CubeProvider({ [sk.id]: binding }, "sandbox", "nfs", [
        "/approved",
      ]);
      // Keep the actual Cube scope algorithm (including Volume/Host binding),
      // replace only remote operations with a deterministic in-memory transport.
      t.mock.method(
        cube,
        "createVolume",
        f.provider.createVolume.bind(f.provider),
      );
      t.mock.method(
        cube,
        "create",
        async (...args: Parameters<typeof cube.create>) => ({
          ...(await f.provider.create(args[0], args[1], args[2])),
          trafficToken: "test-only",
        }),
      );
      t.mock.method(cube, "connect", f.provider.connect.bind(f.provider));
      t.mock.method(cube, "kill", f.provider.kill.bind(f.provider));
      const sandbox = new SandboxManager(f.store, cube);
      await sandbox.withLease(
        actor,
        f.w.id,
        "seed",
        "default",
        async () => {},
        [sk.id],
      );
      await f.store.tx(actor.tenantId, (s) => {
        const w = s.workspaces[f.w.id]!;
        assert.equal(w.sandboxSkillScope, cube.scope("default", [sk]));
        assert.notEqual(w.sandboxSkillScope, skillScope("default", [sk]));
        assert.equal(w.sandboxLogicalSkillScope, skillScope("default", [sk]));
        if (legacy) delete w.sandboxLogicalSkillScope;
        s.runs[root.id]!.state = "RUNNING";
      });
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = sandbox.withLease(
        actor,
        f.w.id,
        "hold",
        "default",
        async () => {
          entered();
          await gate;
        },
        [sk.id],
      );
      await ready;
      try {
        const v2 = await f.service.publish(
          actor,
          config({ skills: [sk.id], systemPrompt: "V2" }),
          v1.agentId,
        );
        const accepted = await f.service.submit(
          actor,
          second.id,
          "compatible concurrent task",
        );
        assert.equal(accepted.agentVersionId, v2.id);
        assert.equal(accepted.state, "QUEUED");
      } finally {
        release();
        await holding;
      }
    });
  }
}

for (const state of ["paused", "released"] as const) {
  test(`explicit Resume after skill revocation restores a skill-free ${state} environment without upgrading Session`, async () => {
    const f = await fixture();
    await f.store.tx(actor.tenantId, (s) => {
      for (const name of ["a", "b"])
        s.skills[`${name}@1`] = {
          id: `${name}@1`,
          name,
          description: name,
          bundle: "default",
          path: `/skills/${name}/SKILL.md`,
          digest: "a".repeat(64),
          enabled: true,
        };
    });
    const v1 = await f.service.publish(
      actor,
      config({ skills: ["a@1"] }),
      f.v1.agentId,
    );
    await f.service.submit(actor, f.ses.id, "old");
    await f.store.tx(actor.tenantId, (s) => {
      for (const r of Object.values(s.runs)) r.state = "COMPLETED";
    });
    await f.sandbox.execute(
      actor,
      f.w.id,
      "seed",
      "default",
      "write",
      { path: "file.txt", content: "persistent" },
      undefined,
      ["a@1"],
    );
    const before = await f.store.read(
      actor.tenantId,
      (s) => s.workspaces[f.w.id]!,
    );
    if (state === "paused") await f.sandbox.pause(actor, f.w.id);
    else await f.sandbox.release(actor, f.w.id);
    const v2 = await f.service.publish(
      actor,
      config({ skills: ["b@1"] }),
      v1.agentId,
    );
    await f.store.tx(actor.tenantId, (s) => {
      s.skills["a@1"]!.enabled = false;
    });
    assert.equal((await f.sandbox.resume(actor, f.w.id)).state, "active");
    await f.store.read(actor.tenantId, (s) => {
      assert.equal(s.sessions[f.ses.id]!.effectiveVersionId, v1.id);
      assert.equal(s.workspaces[f.w.id]!.volumeId, before.volumeId);
      assert.deepEqual(s.workspaces[f.w.id]!.sandboxSkills, []);
    });
    const next = await f.service.submit(actor, f.ses.id, "new");
    assert.equal(next.agentVersionId, v2.id);
    const result = await f.sandbox.execute(
      actor,
      f.w.id,
      "new",
      "default",
      "read",
      { path: "file.txt" },
      undefined,
      ["b@1"],
    );
    assert.equal((result as { text: string }).text, "persistent");
    assert.deepEqual(
      await f.store.read(
        actor.tenantId,
        (s) => s.workspaces[f.w.id]!.sandboxSkills,
      ),
      ["b@1"],
    );
  });
}

test("Resume retains authorized skills and never upgrades a WAITING_INPUT task", async () => {
  const f = await fixture();
  await f.store.tx(actor.tenantId, (s) => {
    s.skills["a@1"] = {
      id: "a@1",
      name: "a",
      description: "a",
      bundle: "default",
      path: "/skills/a/SKILL.md",
      digest: "a".repeat(64),
      enabled: true,
    };
  });
  const v1 = await f.service.publish(
    actor,
    config({ skills: ["a@1"] }),
    f.v1.agentId,
  );
  const root = await f.service.submit(actor, f.ses.id, "old");
  const iid = await waiting(f, root.id);
  await f.sandbox.withLease(actor, f.w.id, "seed", "default", async () => {}, [
    "a@1",
  ]);
  const before = await f.store.read(
    actor.tenantId,
    (s) => s.workspaces[f.w.id]!.sandboxId,
  );
  await f.sandbox.pause(actor, f.w.id);
  await f.service.publish(actor, config(), v1.agentId);
  await f.sandbox.resume(actor, f.w.id);
  assert.equal(
    await f.store.read(actor.tenantId, (s) => s.workspaces[f.w.id]!.sandboxId),
    before,
  );
  assert.equal(
    (await f.service.respond(actor, iid, "answer"))!.agentVersionId,
    v1.id,
  );
});

for (const revoke of ["skill", "agent", "acl", "mcp"] as const) {
  test(`new root invalidates a ${revoke}-revoked waiting task without requiring manual cancellation`, async () => {
    const f = await fixture();
    await f.store.tx(actor.tenantId, (s) => {
      for (const name of ["a", "b"])
        s.skills[`${name}@1`] = {
          id: `${name}@1`,
          name,
          description: name,
          bundle: "default",
          path: `/skills/${name}/SKILL.md`,
          digest: "a".repeat(64),
          enabled: true,
        };
      s.mcp.m = {
        id: "m",
        endpointRef: "endpoint",
        allowedTools: ["read"],
        enabled: true,
      };
    });
    const service = new HarnessService(f.store, ["endpoint"], ["default"]);
    const v1 = await service.publish(
      actor,
      config({
        skills: ["a@1"],
        ...(revoke === "mcp" ? { mcpServers: ["m"] } : {}),
      }),
      f.v1.agentId,
    );
    const root = await service.submit(actor, f.ses.id, "old");
    const iid = await waiting(f, root.id);
    // Expired UCS token must not hide a true Skill/Agent/MCP revocation.
    await f.store.tx(actor.tenantId, (s) => {
      s.runs[root.id]!.actor.expiresAt = Date.now() - 1;
    });
    const v2 = await service.publish(
      actor,
      config({ skills: ["b@1"] }),
      v1.agentId,
    );
    let target = v2;
    await f.store.tx(actor.tenantId, (s) => {
      if (revoke === "skill") s.skills["a@1"]!.enabled = false;
      if (revoke === "agent") s.agents[v1.id]!.enabled = false;
      if (revoke === "mcp") s.mcp.m!.enabled = false;
    });
    if (revoke === "acl") {
      await service.setAccess(actor, v1.id, ["other-user"]);
      target = await service.publish(actor, config({ skills: ["b@1"] }));
    }
    const second = await service.createSession(actor, f.w.id, target.agentId!);
    const next = await service.submit(actor, second.id, "new");
    assert.equal(next.agentVersionId, target.id);
    await f.store.read(actor.tenantId, (s) => {
      assert.equal(s.runs[root.id]!.state, "FAILED");
      const failed = s.events.find(
        (e) => e.runId === root.id && e.type === "run.failed",
      );
      assert.equal((failed!.data as { reason: string }).reason, "task_revoked");
      assert.ok(s.audit.some((e) => e.action === "task.revoked"));
    });
    await assert.rejects(service.respond(actor, iid, "late answer"), {
      code: "RUN_NOT_WAITING",
    });
  });
}

test("JWT expiry alone preserves a waiting task; static history identity does not grant revoked Skills", async () => {
  const f = await fixture();
  const root = await f.service.submit(actor, f.ses.id, "old");
  const iid = await waiting(f, root.id);
  await f.store.tx(actor.tenantId, (s) => {
    s.runs[root.id]!.actor.expiresAt = Date.now() - 1;
  });
  const second = await f.service.createSession(actor, f.w.id, f.v1.id);
  await f.service.submit(actor, second.id, "other session");
  assert.equal(
    await f.store.read(actor.tenantId, (s) => s.runs[root.id]!.state),
    "WAITING_INPUT",
  );
  assert.equal(
    (await f.service.respond(actor, iid, "refreshed subject"))!.agentVersionId,
    f.v1.id,
  );
  const { skillScope, skillIdentityScope } = await import(
    "../src/adapters/skill-mounts.js"
  );
  const sk = {
    id: "a@1",
    name: "a",
    description: "a",
    bundle: "default",
    path: "/skills/a/SKILL.md",
    digest: "a".repeat(64),
    enabled: true,
  };
  assert.equal(
    skillIdentityScope("default", [{ ...sk, enabled: false }]),
    skillScope("default", [sk]),
  );
  assert.throws(() => skillScope("default", [{ ...sk, enabled: false }]), {
    code: "SKILL_DENIED",
  });
});

test("revoked waiting task with a running descendant preserves the active lease and retries after the descendant terminates", async () => {
  const f = await fixture();
  await f.store.tx(actor.tenantId, (s) => {
    for (const name of ["a", "b"])
      s.skills[`${name}@1`] = {
        id: `${name}@1`,
        name,
        description: name,
        bundle: "default",
        path: `/skills/${name}/SKILL.md`,
        digest: "a".repeat(64),
        enabled: true,
      };
  });
  const v1 = await f.service.publish(
    actor,
    config({ skills: ["a@1"] }),
    f.v1.agentId,
  );
  const root = await f.service.submit(actor, f.ses.id, "old");
  await waiting(f, root.id);
  const child = id();
  await f.store.tx(actor.tenantId, (s) => {
    const sid = id();
    s.sessions[sid] = { ...s.sessions[f.ses.id]!, id: sid };
    s.runs[child] = {
      ...s.runs[root.id]!,
      id: child,
      sessionId: sid,
      parentRunId: root.id,
      state: "RUNNING",
      lease: { owner: "live", expires: Date.now() + 30000 },
    };
    s.skills["a@1"]!.enabled = false;
  });
  const v2 = await f.service.publish(
    actor,
    config({ skills: ["b@1"] }),
    v1.agentId,
  );
  const second = await f.service.createSession(actor, f.w.id, v2.id);
  await assert.rejects(f.service.submit(actor, second.id, "new"), {
    code: "WORKSPACE_VERSION_BUSY",
  });
  assert.equal(
    await f.store.read(actor.tenantId, (s) => s.runs[child]!.state),
    "RUNNING",
  );
  await f.store.tx(actor.tenantId, (s) => {
    s.runs[child]!.state = "FAILED";
    delete s.runs[child]!.lease;
  });
  assert.equal(
    (await f.service.submit(actor, second.id, "retry")).agentVersionId,
    v2.id,
  );
});

test("cancel by original root or continuation cancels the entire task, including continuations and subagents, without touching another task", async () => {
  const f = await fixture();
  const root = await f.service.submit(actor, f.ses.id, "old");
  const iid = await waiting(f, root.id, "approval");
  const next = (await f.service.respond(actor, iid, "approve"))!;
  const secondIid = await waiting(f, next.id);
  const final = (await f.service.respond(actor, secondIid, "answer"))!;
  const child = id();
  await f.store.tx(actor.tenantId, (s) => {
    s.runs[final.id]!.state = "RUNNING";
    s.runs[final.id]!.lease = { owner: "live", expires: Date.now() + 30000 };
    const sid = id();
    s.sessions[sid] = { ...s.sessions[f.ses.id]!, id: sid };
    s.runs[child] = {
      ...s.runs[final.id]!,
      id: child,
      sessionId: sid,
      parentRunId: final.id,
      state: "WAITING_INPUT",
      lease: undefined,
    };
  });
  const otherSes = await f.service.createSession(actor, f.w.id, f.v1.id);
  const unrelated = await f.service.submit(actor, otherSes.id, "other task");
  await f.service.cancel(actor, root.id);
  await f.service.cancel(actor, next.id);
  await f.store.read(actor.tenantId, (s) => {
    assert.equal(s.runs[root.id]!.state, "COMPLETED");
    assert.equal(s.runs[final.id]!.cancelRequested, true);
    assert.equal(s.runs[final.id]!.state, "RUNNING");
    assert.equal(s.runs[child]!.state, "CANCELLED");
    assert.equal(s.runs[unrelated.id]!.state, "QUEUED");
    assert.equal(s.runs[unrelated.id]!.cancelRequested, undefined);
    assert.equal(
      s.events.filter((e) => e.runId === child && e.type === "run.cancelled")
        .length,
      1,
    );
    assert.throws(() => authorizedRun(s, s.runs[final.id]!), {
      code: "RUN_CANCELLED",
    });
  });
});
