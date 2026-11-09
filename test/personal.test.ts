import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { MemoryRegistry, principal } from "../src/store/registry.js";
import { personalStore } from "../src/store/personal.js";
import { PersonalService } from "../src/personal-service.js";
import {
  AgentConfig,
  type Actor,
  type Run,
  type State,
} from "../src/domain.js";
import { replaceAgents } from "../src/config/agents.js";
import { loadDirectoryConfig, importDirectory } from "../src/config/import.js";
function configure(
  s: State,
  input: { agents: unknown[]; policy: { disabledTools: string[] } },
  a: Actor,
) {
  const result = replaceAgents(s, input.agents, a);
  s.policy = input.policy;
  s.configRevisions!.global++;
  return result;
}
import { buildAPI } from "../src/api.js";
import { DemoSandbox, SandboxManager } from "../src/adapters/sandbox.js";
import { MCPManager } from "../src/adapters/mcp.js";
import { Worker } from "../src/worker.js";
import { DemoRuntime, type Runtime } from "../src/runtime.js";
const admin: Actor = { tenantId: "external", userId: "alice", admin: true };
const config = (extra: Record<string, unknown> = {}) =>
  AgentConfig.parse({
    name: "Assistant",
    systemPrompt: "version one",
    model: { provider: "demo", modelId: "demo" },
    tools: ["read", "write", "ls"],
    ...extra,
  });
async function fixture(runtime: Runtime = new DemoRuntime()) {
  const registry = new MemoryRegistry(),
    store = personalStore(new MemoryStore(), registry),
    service = new PersonalService(store, registry);
  const alice = await principal(registry, admin),
    bob = await principal(registry, { ...admin, userId: "bob", admin: false });
  await registry.tx((s) =>
    configure(
      s,
      {
        agents: [{ key: "assistant", config: config() }],
        policy: { disabledTools: [] },
      },
      alice,
    ),
  );
  const provider = new DemoSandbox(),
    sandbox = new SandboxManager(store, provider),
    worker = new Worker(service, runtime, sandbox, new MCPManager(store, {}));
  return { registry, store, service, alice, bob, provider, sandbox, worker };
}
async function drain(f: Awaited<ReturnType<typeof fixture>>, r: Run) {
  for (let i = 0; i < 200; i++) {
    await f.worker.tick();
    const current = await f.store.read(r.actor.tenantId, (s) => s.runs[r.id]!);
    if (
      ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"].includes(
        current.state,
      ) &&
      !current.lease
    )
      return current;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("did not settle");
}
test("identity uses issuer and subject, one stable private workspace per user", async () => {
  const f = await fixture();
  assert.equal((await principal(f.registry, admin)).userId, f.alice.userId);
  assert.notEqual(f.bob.userId, f.alice.userId);
  assert.notEqual(
    (await principal(f.registry, { ...admin, issuer: "other" })).userId,
    f.alice.userId,
  );
  const [a, b] = await Promise.all([
    f.service.createPersonalSession(f.alice, { agentId: "assistant" }),
    f.service.createPersonalSession(f.alice, {
      agentId: "assistant",
      cwd: "projects/demo",
    }),
  ]);
  assert.equal(a.workspaceId, b.workspaceId);
  assert.equal(b.cwd, "/workspace/projects/demo");
  await assert.rejects(f.service.submit(f.bob, a.id, "steal"), {
    code: "SESSION_NOT_FOUND",
  });
  await assert.rejects(
    f.service.createPersonalSession(f.alice, {
      agentId: "assistant",
      cwd: "../escape",
    }),
    { code: "INVALID_WORKSPACE_PATH" },
  );
});
test("editable configuration is atomic; queued Runs retain snapshots and new Runs use current configuration", async () => {
  const f = await fixture(),
    ses = await f.service.createPersonalSession(f.alice, {
      agentId: "assistant",
    });
  const r = await f.service.submit(f.alice, ses.id, "first", "key");
  await f.registry.tx((s) =>
    configure(
      s,
      {
        agents: [{ key: "assistant", config: config({ systemPrompt: "two" }) }],
        policy: { disabledTools: [] },
      },
      f.alice,
    ),
  );
  assert.equal(
    (await f.service.submit(f.alice, ses.id, "first", "key")).id,
    r.id,
  );
  assert.equal(r.capabilities?.systemPrompt, "version one");
  assert.equal((await drain(f, r)).state, "COMPLETED");
  const next = await f.service.submit(f.alice, ses.id, "second");
  assert.equal(next.agentId, r.agentId);
  assert.equal(next.agentVersionId, undefined);
  assert.notEqual(next.configDigest, r.configDigest);
  assert.equal(next.capabilities?.systemPrompt, "two");
  const stored = await f.store.read(
    f.alice.tenantId,
    (s) => s.sessions[ses.id]!,
  );
  assert.equal(stored.agentVersionId, undefined);
  assert.ok(!("effectiveVersionId" in stored));
  const data = await f.store.read(f.alice.tenantId, (s) =>
    s.events.filter((e) => e.runId === next.id),
  );
  assert.equal(data[0]?.type, "run.queued");
  assert.equal(data[0]?.seq, 1);
  const before = await f.registry.read((s) => s.configRevisions?.agents);
  await assert.rejects(
    f.registry.tx((s) =>
      configure(
        s,
        {
          agents: [
            { key: "assistant", config: config({ skills: ["missing"] }) },
          ],
          policy: { disabledTools: [] },
        },
        f.alice,
      ),
    ),
    { code: "INVALID_SKILL" },
  );
  assert.equal(await f.registry.read((s) => s.configRevisions?.agents), before);
  await drain(f, next);
  await f.worker.stop();
});
test("approval continuation inherits the original snapshot, task identity and cwd after editing", async () => {
  const f = await fixture({
    execute: async (c) => {
      if (c.prompt === "write")
        await c.call("remote_write", { path: "note.txt", content: "saved" });
    },
  });
  const ses = await f.service.createPersonalSession(f.alice, {
      agentId: "assistant",
      cwd: "projects/test",
    }),
    r = await f.service.submit(f.alice, ses.id, "write");
  assert.equal((await drain(f, r)).state, "WAITING_INPUT");
  const i = await f.store.read(
    f.alice.tenantId,
    (s) => Object.values(s.interactions)[0]!,
  );
  await f.registry.tx((s) =>
    configure(
      s,
      {
        agents: [{ key: "assistant", config: config({ systemPrompt: "two" }) }],
        policy: { disabledTools: [] },
      },
      f.alice,
    ),
  );
  const next = (await f.service.respond(f.alice, i.id, "approve"))!;
  assert.equal(next.agentId, r.agentId);
  assert.deepEqual(next.capabilities, r.capabilities);
  assert.equal(next.taskId, r.taskId);
  assert.equal(next.cwd, r.cwd);
  assert.equal((await drain(f, next)).state, "COMPLETED");
  assert.equal(
    f.provider.volumes
      .get(`ws-${f.alice.userId}`)
      ?.get("/workspace/projects/test/note.txt"),
    "saved",
  );
  await f.worker.stop();
});
test("kill switch applies to existing Run snapshots; auto approvals are audited", async () => {
  const f = await fixture({
    execute: async (c) => {
      await c.call("remote_write", { path: "x", content: "saved" });
    },
  });
  await f.registry.tx((s) =>
    configure(
      s,
      {
        agents: [
          { key: "assistant", config: config({ approval: { mode: "auto" } }) },
        ],
        policy: { disabledTools: [] },
      },
      f.alice,
    ),
  );
  const ses = await f.service.createPersonalSession(f.alice, {
    agentId: "assistant",
  });
  const first = await f.service.submit(f.alice, ses.id, "first");
  assert.equal((await drain(f, first)).state, "COMPLETED");
  assert.equal(
    await f.store.read(f.alice.tenantId, (s) =>
      s.audit.some((a) => a.action === "tool.auto_approved"),
    ),
    true,
  );
  const second = await f.service.submit(f.alice, ses.id, "second");
  await f.registry.tx((s) => {
    s.policy = { disabledTools: ["write"] };
  });
  assert.equal((await drain(f, second)).error, "TOOL_DISABLED");
  await f.worker.stop();
});
test("personal HTTP routes isolate users and keep files across sandbox replacement", async () => {
  const f = await fixture(),
    app = buildAPI(
      f.service,
      async (h) =>
        h === "Bearer alice"
          ? admin
          : { ...admin, userId: "bob", admin: false },
      f.sandbox,
    );
  const req = (method: string, url: string, payload?: unknown, who = "alice") =>
    app.inject({
      method: method as "GET",
      url,
      payload,
      headers: { authorization: `Bearer ${who}` },
    });
  try {
    const created = await req("POST", "/api/v1/sessions", {
      agentId: "assistant",
    });
    assert.equal(created.statusCode, 201, created.body);
    const ses = created.json();
    assert.equal(
      (await req("GET", `/api/v1/sessions/${ses.id}`, undefined, "bob"))
        .statusCode,
      404,
    );
    assert.equal(
      (await req("POST", "/api/v1/workspaces", { name: "shared" })).statusCode,
      404,
    );
    assert.equal(
      (
        await req("PUT", "/api/v1/me/files", {
          path: "hello.txt",
          content: "persistent",
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await req("POST", "/api/v1/me/sandbox/release")).statusCode,
      200,
    );
    assert.deepEqual(
      (
        await req("GET", "/api/v1/me/files?operation=read&path=hello.txt")
      ).json(),
      { text: "persistent" },
    );
    assert.equal(
      (
        await req(
          "GET",
          "/api/v1/me/files?operation=read&path=hello.txt",
          undefined,
          "bob",
        )
      ).statusCode,
      404,
    );
    const cfg = await req("GET", "/api/v1/admin/config/global");
    assert.equal(cfg.statusCode, 200);
    assert.equal(
      (
        await req("POST", "/api/v1/admin/config/global", {
          revision: 0,
          policy: { disabledTools: [] },
        })
      ).statusCode,
      409,
    );
  } finally {
    await app.close();
    await f.worker.stop();
  }
});
test("optional directory import validates without external services", async () => {
  const tree = await loadDirectoryConfig("config");
  assert.ok(tree.agents.length);
  assert.match(tree.agents[0]!.config.systemPrompt, /private workspace/);
});

test("scheduled runs deduplicate fires, fail closed on approval, and never create interactions", async () => {
  const { ScheduleService, nextFire } = await import(
    "../src/schedules/service.js"
  );
  const f = await fixture({
      execute: async (c) => {
        await c.call("remote_write", { path: "x", content: "no" });
      },
    }),
    schedules = new ScheduleService(f.service);
  assert.throws(() => nextFire("* * * * * *", "UTC"), { code: "INVALID_CRON" });
  const task = await schedules.create(f.alice, {
    agentId: "assistant",
    cron: "* * * * *",
    timezone: "Asia/Shanghai",
    prompt: "write",
  });
  const pair = await f.store.tx(f.alice.tenantId, (s) => {
    const t = s.schedules![task.id]!;
    const a = schedules.fire(s, t, Date.now(), "cron");
    t.nextFireAt = a.scheduledFor;
    return [a, schedules.fire(s, t, Date.now(), "cron")];
  });
  assert.equal(pair[0]!.id, pair[1]!.id);
  const r = await f.store.read(
    f.alice.tenantId,
    (s) => s.runs[pair[0]!.runId!]!,
  );
  assert.equal((await drain(f, r)).error, "SCHEDULE_APPROVAL_DENIED");
  assert.equal(
    await f.store.read(
      f.alice.tenantId,
      (s) => Object.keys(s.interactions).length,
    ),
    0,
  );
  await schedules.tick();
  assert.equal(
    await f.store.read(
      f.alice.tenantId,
      (s) => s.schedules![task.id]!.failures,
    ),
    1,
  );
  await f.worker.stop();
});

test("memory topic writes bypass cards, rebuild a bounded index, and reserve the index from model writes", async () => {
  const f = await fixture({
    execute: async (c) => {
      await c.call("remote_write", {
        path:
          c.prompt === "reserved"
            ? "memory/MEMORY.md"
            : "memory/preferences.md",
        content: "Prefers concise responses.",
      });
    },
  });
  await f.registry.tx((s) =>
    configure(
      s,
      {
        agents: [
          {
            key: "assistant",
            config: config({
              memory: { enabled: true, scopes: ["user"], maxWritesPerRun: 1 },
            }),
          },
        ],
        policy: { disabledTools: [] },
      },
      f.alice,
    ),
  );
  const ses = await f.service.createPersonalSession(f.alice, {
      agentId: "assistant",
    }),
    r = await f.service.submit(f.alice, ses.id, "remember");
  assert.equal((await drain(f, r)).state, "COMPLETED");
  assert.match(
    f.provider.volumes
      .get(`ws-${f.alice.userId}`)!
      .get("/workspace/memory/MEMORY.md")!,
    /preferences/,
  );
  const bad = await f.service.submit(f.alice, ses.id, "reserved");
  assert.equal((await drain(f, bad)).error, "MEMORY_PATH_RESERVED");
  await f.worker.stop();
});

test("inline children inherit the parent task and cannot gain capabilities or delegate again", async () => {
  const seen: string[][] = [];
  const f = await fixture({
    execute: async (c) => {
      seen.push(c.config.tools);
      if (c.prompt === "parent")
        await c.call("delegate_to_agent", {
          agentId: "research",
          task: "child",
        });
    },
  });
  await f.registry.tx((s) =>
    configure(
      s,
      {
        agents: [
          {
            key: "assistant",
            config: config({
              tools: ["read", "delegate_to_agent"],
              subagents: ["research"],
              subagentDefinitions: {
                research: {
                  systemPrompt: "Research",
                  tools: ["read", "write", "delegate_to_agent"],
                },
              },
            }),
          },
        ],
        policy: { disabledTools: [] },
      },
      f.alice,
    ),
  );
  const ses = await f.service.createPersonalSession(f.alice, {
      agentId: "assistant",
    }),
    r = await f.service.submit(f.alice, ses.id, "parent");
  assert.equal((await drain(f, r)).state, "COMPLETED");
  const child = await f.store.read(
    f.alice.tenantId,
    (s) => Object.values(s.runs).find((c) => c.parentRunId === r.id)!,
  );
  assert.equal(child.taskId, r.taskId);
  assert.deepEqual(seen[1], ["read"]);
  await f.worker.stop();
});

test("caller tokens are sealed, bound to the task, and erased at terminal state", async () => {
  const { sealToken, openToken } = await import(
    "../src/security/token-vault.js"
  );
  const previous = process.env.RUN_TOKEN_KEY;
  process.env.RUN_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const encrypted = sealToken("secret", "task");
    assert.ok(!encrypted.includes("secret"));
    assert.equal(openToken(encrypted, "task"), "secret");
    assert.throws(() => openToken(encrypted, "other"), {
      code: "RUN_TOKEN_UNAVAILABLE",
    });
    const f = await fixture();
    await f.registry.tx((s) =>
      configure(
        s,
        {
          agents: [
            { key: "assistant", config: config({ userTokenAccess: true }) },
          ],
          policy: { disabledTools: [] },
        },
        f.alice,
      ),
    );
    const ses = await f.service.createPersonalSession(f.alice, {
        agentId: "assistant",
      }),
      r = await f.service.submit(
        f.alice,
        ses.id,
        "hello",
        undefined,
        undefined,
        undefined,
        "secret",
      );
    assert.ok(r.userTokenRef);
    assert.equal((await drain(f, r)).userTokenRef, undefined);
    await f.worker.stop();
  } finally {
    if (previous === undefined) delete process.env.RUN_TOKEN_KEY;
    else process.env.RUN_TOKEN_KEY = previous;
  }
});

test("web tools reject private destinations before HTTP dispatch", async () => {
  const { webFetch, publicAddress } = await import("../src/tools/web.js");
  assert.equal(publicAddress("127.0.0.1"), false);
  assert.equal(publicAddress("::ffff:127.0.0.1"), false);
  assert.equal(publicAddress("8.8.8.8"), true);
  await assert.rejects(
    webFetch("http://127.0.0.1/", new AbortController().signal),
    { code: "WEB_PRIVATE_ADDRESS_DENIED" },
  );
});

test("database model catalog resolves the default per root and keeps secrets out of public config", async () => {
  const previous = process.env.CONFIG_SECRET_KEY;
  process.env.CONFIG_SECRET_KEY = Buffer.alloc(32, 3).toString("base64");
  try {
    const f = await fixture();
    await f.registry.tx((s) =>
      configure(
        s,
        {
          agents: [{ key: "assistant", config: config({ model: "default" }) }],
          policy: { disabledTools: [] },
        },
        f.alice,
      ),
    );
    const app = buildAPI(f.service, async () => admin, f.sandbox);
    try {
      const published = await app.inject({
        method: "POST",
        url: "/api/v1/admin/config/global",
        payload: {
          revision: await f.registry.read((s) => s.configRevisions!.global),
          policy: { disabledTools: [] },
          modelCatalog: [
            {
              provider: "test",
              modelId: "first",
              baseUrl: "https://models.example/v1",
              secretRef: "llm",
              default: true,
            },
          ],
          secrets: { llm: "catalog-secret" },
        },
      });
      assert.equal(published.statusCode, 200, published.body);
      const publicConfig = await app.inject({
        url: "/api/v1/admin/config/global",
      });
      assert.doesNotMatch(publicConfig.body, /catalog-secret/);
      const ses = await f.service.createPersonalSession(f.alice, {
          agentId: "assistant",
        }),
        r = await f.service.submit(f.alice, ses.id, "one");
      assert.deepEqual(r.model, { provider: "test", modelId: "first" });
      assert.equal(
        (await f.service.gatewayFor(r.model!))?.apiKey,
        "catalog-secret",
      );
      await f.registry.tx((s) => {
        s.modelCatalog![0]!.modelId = "second";
      });
      assert.equal(
        (await f.store.read(f.alice.tenantId, (s) => s.runs[r.id]!)).model
          ?.modelId,
        "first",
      );
    } finally {
      await app.close();
      await f.worker.stop();
    }
  } finally {
    if (previous === undefined) delete process.env.CONFIG_SECRET_KEY;
    else process.env.CONFIG_SECRET_KEY = previous;
  }
});

test("optional Skill directory delivery preserves immutable bytes and rejects symlinked archives", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, symlink, rm } = await import(
      "node:fs/promises"
    ),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const { readSkillTree, materializeSkills } = await import(
    "../src/config/skills.js"
  );
  const root = await mkdtemp(join(tmpdir(), "piflow-skills-"));
  try {
    await mkdir(join(root, "source", "review"), { recursive: true });
    await writeFile(
      join(root, "source/review/SKILL.md"),
      "---\nname: review\ndescription: Review code\ndisable-model-invocation: true\n---\nReview carefully.\n",
    );
    const skills = await readSkillTree(join(root, "source"));
    await materializeSkills(skills, join(root, "delivery"));
    assert.equal(skills[0]!.disableModelInvocation, true);
    assert.match(
      await readFile(
        join(root, "delivery/review", skills[0]!.versionDigest!, "SKILL.md"),
        "utf8",
      ),
      /Review carefully/,
    );
    await symlink("SKILL.md", join(root, "source/review/alias.md"));
    await assert.rejects(readSkillTree(join(root, "source")), /symlinks/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("COP verification coalesces requests, caches positive and negative results, and maps administrator grants", async () => {
  const { createServer } = await import("node:http"),
    { copAuth } = await import("../src/security/cop.js");
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.headers.token === "good"
          ? { code: 200, data: { userId: "cop-user", roleKeys: ["ops"] } }
          : { code: 401 },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const oldHttp = process.env.UCS_ALLOW_HTTP,
    oldRoles = process.env.UCS_ADMIN_ROLE_KEYS;
  process.env.UCS_ALLOW_HTTP = "true";
  process.env.UCS_ADMIN_ROLE_KEYS = "ops";
  try {
    const auth = copAuth(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/api/user/verifyToken`,
      ),
      actors = await Promise.all([auth("Bearer good"), auth("Bearer good")]);
    assert.equal(calls, 1);
    assert.equal(actors[0]!.issuer, "urn:ucs");
    assert.equal(actors[0]!.admin, true);
    await assert.rejects(auth("Bearer bad"), { code: "UNAUTHENTICATED" });
    await assert.rejects(auth("Bearer bad"), { code: "UNAUTHENTICATED" });
    assert.equal(calls, 2);
  } finally {
    if (oldHttp === undefined) delete process.env.UCS_ALLOW_HTTP;
    else process.env.UCS_ALLOW_HTTP = oldHttp;
    if (oldRoles === undefined) delete process.env.UCS_ADMIN_ROLE_KEYS;
    else process.env.UCS_ADMIN_ROLE_KEYS = oldRoles;
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
});

test("admin edits update a stable Agent; optimistic revisions and live revocation remain effective", async () => {
  const observed: string[] = [];
  const f = await fixture({
    execute: async (c) => {
      observed.push(c.config.systemPrompt);
    },
  });
  const app = buildAPI(f.service, async () => admin, f.sandbox);
  const request = (method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, payload });
  try {
    const ses = await f.service.createPersonalSession(f.alice, {
      agentId: "assistant",
    });
    const queued = await f.service.submit(f.alice, ses.id, "first");
    const initial = (
      await request("GET", "/api/v1/admin/config/agents")
    ).json();
    assert.equal(initial.items[0].id, "assistant");
    assert.equal(initial.items[0].version, undefined);
    assert.equal(initial.publications, undefined);
    const edited = await request("POST", "/api/v1/admin/config/agents", {
      revision: initial.revision,
      agents: [
        { key: "assistant", config: config({ systemPrompt: "edited" }) },
      ],
    });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(
      (
        await request("POST", "/api/v1/admin/config/agents", {
          revision: initial.revision,
          agents: [],
        })
      ).statusCode,
      409,
    );
    assert.equal((await drain(f, queued)).state, "COMPLETED");
    assert.deepEqual(observed, ["version one"]);
    const next = await f.service.submit(f.alice, ses.id, "second");
    assert.equal((await drain(f, next)).state, "COMPLETED");
    assert.deepEqual(observed, ["version one", "edited"]);
    const agentRevision = await f.registry.read(
      (s) => s.configRevisions!.agents,
    );
    const global = await request("GET", "/api/v1/admin/config/global");
    assert.equal(
      (
        await request("POST", "/api/v1/admin/config/global", {
          revision: global.json().revision,
          policy: { disabledTools: ["write"] },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      await f.registry.read((s) => s.configRevisions!.agents),
      agentRevision,
    );
    const blocked = await f.service.submit(
      f.alice,
      ses.id,
      "third",
      "third-key",
    );
    assert.equal(
      (
        await request("POST", "/api/v1/admin/config/agents", {
          revision: agentRevision,
          agents: [],
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.service.submit(f.alice, ses.id, "third", "third-key")).id,
      blocked.id,
    );
    assert.equal((await drain(f, blocked)).error, "AGENT_REVOKED");
    await assert.rejects(
      f.service.createPersonalSession(f.alice, { agentId: "assistant" }),
      { code: "AGENT_NOT_FOUND" },
    );
  } finally {
    await app.close();
    await f.worker.stop();
  }
});

test("directory import is optional initialization and cannot silently overwrite database edits", async () => {
  const f = await fixture(),
    tree = await loadDirectoryConfig("config");
  await assert.rejects(
    f.registry.tx((s) => importDirectory(s, tree, f.alice)),
    { code: "CONFIG_ALREADY_INITIALIZED" },
  );
  assert.equal(
    await f.registry.read(
      (s) => s.managedAgents!.assistant!.config.systemPrompt,
    ),
    "version one",
  );
  await f.registry.tx((s) => importDirectory(s, tree, f.alice, true));
  assert.match(
    await f.registry.read(
      (s) => s.managedAgents!.assistant!.config.systemPrompt,
    ),
    /private workspace/,
  );
});

test("a personal Run with a missing snapshot fails instead of adopting current configuration", async () => {
  let invoked = false;
  const f = await fixture({
    execute: async () => {
      invoked = true;
    },
  });
  const ses = await f.service.createPersonalSession(f.alice, {
      agentId: "assistant",
    }),
    r = await f.service.submit(f.alice, ses.id, "task");
  await f.store.tx(f.alice.tenantId, (s) => {
    delete s.runs[r.id]!.capabilities;
  });
  await f.registry.tx((s) =>
    replaceAgents(
      s,
      [{ key: "assistant", config: config({ systemPrompt: "changed" }) }],
      f.alice,
    ),
  );
  assert.equal((await drain(f, r)).error, "RUN_CONFIG_MISSING");
  assert.equal(invoked, false);
  await f.worker.stop();
});
