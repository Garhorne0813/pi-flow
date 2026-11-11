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
        await c.call("write", { path: "note.txt", content: "saved" });
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
      await c.call("write", { path: "x", content: "saved" });
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
        await c.call("write", { path: "x", content: "no" });
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
      await c.call("write", {
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
    const gateways: { baseUrl: string; apiKey: string }[] = [];
    const f = await fixture({
      execute: async (c) => {
        gateways.push(c.gateway!);
        if (gateways.length === 1)
          await c.call("write", { path: "catalog.txt", content: "saved" });
      },
    });
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
      assert.equal((await f.service.gatewayFor(r))?.apiKey, "catalog-secret");
      const rotated = await app.inject({
        method: "POST",
        url: "/api/v1/admin/config/global",
        payload: {
          revision: await f.registry.read((s) => s.configRevisions!.global),
          policy: { disabledTools: [] },
          modelCatalog: [
            {
              provider: "test",
              modelId: "second",
              baseUrl: "https://new-models.example/v1",
              secretRef: "llm",
              default: true,
            },
          ],
          secrets: { llm: "rotated-secret" },
        },
      });
      assert.equal(rotated.statusCode, 200, rotated.body);
      assert.equal((await drain(f, r)).state, "WAITING_INPUT");
      const interaction = await f.store.read(
        f.alice.tenantId,
        (s) => Object.values(s.interactions)[0]!,
      );
      const continued = (await f.service.respond(
        f.alice,
        interaction.id,
        "approve",
      ))!;
      assert.equal((await drain(f, continued)).state, "COMPLETED");
      assert.deepEqual(gateways, [
        { baseUrl: "https://models.example/v1", apiKey: "catalog-secret" },
        { baseUrl: "https://models.example/v1", apiKey: "catalog-secret" },
      ]);
      const next = await f.service.submit(f.alice, ses.id, "new root");
      assert.equal((await drain(f, next)).state, "COMPLETED");
      assert.deepEqual(gateways[2], {
        baseUrl: "https://new-models.example/v1",
        apiKey: "rotated-secret",
      });
      const visible = await app.inject({ url: `/api/v1/runs/${r.id}` });
      assert.doesNotMatch(visible.body, /secret|modelGatewayRef|secretVersion/);
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

test("tool kill-switch is rechecked after sandbox preparation for writes, edits, bash and memory", async (t) => {
  for (const op of ["write", "edit", "bash", "memory"] as const)
    await t.test(op, async () => {
      const ready = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const tool = op === "memory" ? "write" : op;
      let toolStarting = false;
      const f = await fixture({
        execute: async (c) => {
          toolStarting = true;
          await c.call(
            tool,
            op === "bash"
              ? { command: "pwd" }
              : op === "edit"
                ? {
                    path: "note.txt",
                    expectedHash: "a".repeat(64),
                    oldText: "old",
                    newText: "new",
                  }
                : {
                    path: op === "memory" ? "memory/topic.md" : "note.txt",
                    content: "saved",
                  },
          );
        },
      });
      await f.registry.tx((s) => {
        s.managedAgents!.assistant!.config = config({
          tools: ["read", "write", "edit", "bash"],
          approval: { mode: "auto" },
          memory: op === "memory" ? { enabled: true } : undefined,
        });
      });
      // Memory index preparation also uses the sandbox, so pause its first create.
      const original = f.provider.create.bind(f.provider);
      f.provider.create = async (...args) => {
        if (op !== "memory") {
          ready.resolve();
          await release.promise;
        }
        return original(...args);
      };
      const connect = f.provider.connect.bind(f.provider);
      f.provider.connect = async (sid) => {
        if (op === "memory" && toolStarting) {
          ready.resolve();
          await release.promise;
        }
        return connect(sid);
      };
      let writes = 0;
      const execute = f.provider.execute.bind(f.provider);
      f.provider.execute = async (sid, operation, args) => {
        if (["write", "edit", "bash"].includes(operation)) writes++;
        return execute(sid, operation, args);
      };
      try {
        const ses = await f.service.createPersonalSession(f.alice, {
          agentId: "assistant",
        });
        const run = await f.service.submit(f.alice, ses.id, "mutate");
        await f.worker.tick();
        await ready.promise;
        await f.registry.tx((s) => {
          s.policy = { disabledTools: [tool] };
        });
        release.resolve();
        const done = await drain(f, run);
        assert.equal(done.state, "FAILED");
        assert.equal(done.error, "TOOL_DISABLED");
        assert.equal(writes, 0);
      } finally {
        release.resolve();
        await f.worker.stop();
      }
    });
});

test("schedule reuse is invalidated by Agent/cwd edits and rejects inaccessible or token-dependent Agents", async () => {
  const { ScheduleService } = await import("../src/schedules/service.js");
  const f = await fixture(),
    schedules = new ScheduleService(f.service);
  await f.registry.tx((s) =>
    replaceAgents(
      s,
      [
        { key: "assistant", config: config() },
        { key: "other", config: config({ systemPrompt: "other agent" }) },
        { key: "token", config: config({ userTokenAccess: true }) },
        { key: "private", config: config(), allowedUsers: [f.bob.userId] },
      ],
      f.alice,
    ),
  );
  const task = await schedules.create(f.alice, {
    agentId: "assistant",
    cron: "* * * * *",
    prompt: "scheduled",
  });
  let time = Date.now();
  const fire = () =>
    f.store.tx(f.alice.tenantId, (s) =>
      schedules.fire(s, s.schedules![task.id]!, ++time, "manual"),
    );
  const first = await fire();
  const old = await f.store.read(
    f.alice.tenantId,
    (s) => s.runs[first.runId!]!,
  );
  await f.store.tx(f.alice.tenantId, (s) => {
    s.runs[old.id]!.state = "COMPLETED";
  });
  await assert.rejects(
    schedules.update(f.alice, task.id, { agentId: "token" }),
    { code: "SCHEDULE_USER_TOKEN_UNSUPPORTED" },
  );
  await assert.rejects(
    schedules.update(f.alice, task.id, { agentId: "private" }),
    { code: "AGENT_NOT_FOUND" },
  );
  const updated = await schedules.update(f.alice, task.id, {
    agentId: "other",
    cwd: "project",
  });
  assert.equal(updated.sessionId, undefined);
  const second = await fire();
  const changed = await f.store.read(
    f.alice.tenantId,
    (s) => s.runs[second.runId!]!,
  );
  assert.notEqual(changed.sessionId, old.sessionId);
  assert.equal(changed.agentId, "other");
  assert.equal(changed.cwd, "/workspace/project");
  assert.equal(changed.capabilities!.systemPrompt, "other agent");
  await f.store.tx(f.alice.tenantId, (s) => {
    s.runs[changed.id]!.state = "COMPLETED";
  });
  await schedules.update(f.alice, task.id, { cwd: "next" });
  const third = await fire();
  const final = await f.store.read(
    f.alice.tenantId,
    (s) => s.runs[third.runId!]!,
  );
  assert.notEqual(final.sessionId, changed.sessionId);
  assert.equal(final.cwd, "/workspace/next");
  await f.worker.stop();
});

test("approval reauthentication seals the fresh caller token for bash without changing the Run snapshot", async () => {
  const { openToken } = await import("../src/security/token-vault.js");
  const previous = process.env.RUN_TOKEN_KEY;
  process.env.RUN_TOKEN_KEY = Buffer.alloc(32, 11).toString("base64");
  let calls = 0,
    expired = false;
  const f = await fixture({
    execute: async (c) => {
      if (calls++ === 0) await c.call("bash", { command: "call-user-api" });
    },
  });
  const original = config({ tools: ["bash"], userTokenAccess: true });
  await f.registry.tx((s) =>
    replaceAgents(s, [{ key: "assistant", config: original }], f.alice),
  );
  const seen: string[] = [];
  const execute = f.provider.execute.bind(f.provider);
  f.provider.execute = async (sid, op, args) => {
    if (op === "bash") {
      seen.push(String(args._userToken));
      if (args._userToken !== "fresh-caller-token")
        throw new Error("USER_API_TOKEN_EXPIRED");
      return { stdout: "authorized", exitCode: 0 };
    }
    return execute(sid, op, args);
  };
  const app = buildAPI(
    f.service,
    async (header) => {
      if (header === "Bearer other-user-token") return f.bob;
      if (header === "Bearer fresh-caller-token")
        return { ...f.alice, expiresAt: Date.now() + 60000 };
      if (header === "Bearer expired-caller-token" && !expired)
        return { ...f.alice, expiresAt: Date.now() + 60000 };
      const { Fault } = await import("../src/domain.js");
      throw new Fault(401, "UNAUTHENTICATED");
    },
    f.sandbox,
  );
  try {
    const ses = await f.service.createPersonalSession(f.alice, {
      agentId: "assistant",
    });
    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${ses.id}/runs`,
      headers: { authorization: "Bearer expired-caller-token" },
      payload: { message: "call" },
    });
    assert.equal(submitted.statusCode, 202, submitted.body);
    const r = await f.store.readRun(
      f.alice.tenantId,
      submitted.json().id,
      (s) => s.runs[submitted.json().id]!,
    );
    assert.equal((await drain(f, r)).state, "WAITING_INPUT");
    const interaction = await f.store.read(
      f.alice.tenantId,
      (s) => Object.values(s.interactions)[0]!,
    );
    expired = true;
    await f.store.tx(f.alice.tenantId, (s) => {
      s.runs[r.id]!.actor.expiresAt = Date.now() - 1;
    });
    const otherSession = await f.service.createPersonalSession(f.alice, {
      agentId: "assistant",
    });
    const unrelated = await f.service.submit(
      f.alice,
      otherSession.id,
      "another task",
      undefined,
      undefined,
      undefined,
      "other-task-token",
    );
    // A later Agent edit cannot turn off the continuation's captured token capability.
    await f.registry.tx((s) =>
      replaceAgents(
        s,
        [
          {
            key: "assistant",
            config: config({
              systemPrompt: "edited",
              tools: [],
              userTokenAccess: false,
            }),
          },
        ],
        f.alice,
      ),
    );
    const endpoint = `/api/v1/interactions/${interaction.id}/response`;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: endpoint,
          headers: { authorization: "Bearer expired-caller-token" },
          payload: { response: "approve" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: endpoint,
          headers: { authorization: "Bearer other-user-token" },
          payload: { response: "approve" },
        })
      ).statusCode,
      404,
    );
    await assert.rejects(
      f.service.respond(f.alice, interaction.id, "approve"),
      { code: "USER_TOKEN_REQUIRED" },
    );
    assert.equal(
      await f.store.read(
        f.alice.tenantId,
        (s) => s.interactions[interaction.id]!.resolved,
      ),
      false,
    );
    assert.equal(
      await f.store.readRun(
        f.alice.tenantId,
        r.id,
        (s) => s.runs[r.id]!.userTokenRef,
      ),
      r.userTokenRef,
    );
    const approved = await app.inject({
      method: "POST",
      url: endpoint,
      headers: { authorization: "Bearer fresh-caller-token" },
      payload: { response: "approve" },
    });
    assert.equal(approved.statusCode, 202, approved.body);
    const next = await f.store.readRun(
      f.alice.tenantId,
      approved.json().id,
      (s) => s.runs[approved.json().id]!,
    );
    assert.deepEqual(next.capabilities, r.capabilities);
    assert.equal(next.configDigest, r.configDigest);
    assert.equal(next.modelGatewayRef, r.modelGatewayRef);
    assert.equal(next.taskId, r.taskId);
    assert.equal(next.rootRunId, r.rootRunId);
    assert.equal(
      await f.store.readRun(
        f.alice.tenantId,
        unrelated.id,
        (s) => s.runs[unrelated.id]!.userTokenRef,
      ),
      unrelated.userTokenRef,
    );
    assert.equal(
      openToken(next.userTokenRef!, f.alice.userId + ":" + next.taskId),
      "fresh-caller-token",
    );
    assert.throws(
      () => openToken(next.userTokenRef!, f.bob.userId + ":" + next.taskId),
      { code: "RUN_TOKEN_UNAVAILABLE" },
    );
    const retry = await app.inject({
      method: "POST",
      url: endpoint,
      headers: { authorization: "Bearer fresh-caller-token" },
      payload: { response: "approve" },
    });
    assert.equal(retry.json().id, next.id);
    assert.equal(
      await f.store.readRun(
        f.alice.tenantId,
        next.id,
        (s) => s.runs[next.id]!.userTokenRef,
      ),
      next.userTokenRef,
    );
    assert.equal((await drain(f, next)).state, "COMPLETED");
    assert.deepEqual(seen, ["fresh-caller-token"]);
    assert.equal(
      await f.store.readRun(
        f.alice.tenantId,
        next.id,
        (s) => s.runs[next.id]!.userTokenRef,
      ),
      undefined,
    );
    assert.equal(
      await f.store.readRun(
        f.alice.tenantId,
        r.id,
        (s) => s.runs[r.id]!.userTokenRef,
      ),
      undefined,
    );
    const persisted = await f.store.read(f.alice.tenantId, (s) =>
      JSON.stringify(s),
    );
    assert.doesNotMatch(persisted, /expired-caller-token|fresh-caller-token/);
    assert.doesNotMatch(approved.body, /userTokenRef|fresh-caller-token/);
  } finally {
    await app.close();
    await f.worker.stop();
    if (previous === undefined) delete process.env.RUN_TOKEN_KEY;
    else process.env.RUN_TOKEN_KEY = previous;
  }
});

test("schedule admission failures count once, busy skips preserve failures, success resets, and cron auto-disables", async () => {
  const { ScheduleService } = await import("../src/schedules/service.js");
  const f = await fixture(),
    scheduler = new ScheduleService(f.service);
  const task = await scheduler.create(f.alice, {
    agentId: "assistant",
    cron: "* * * * *",
    prompt: "tick",
    maxConsecutiveFailures: 3,
  });
  let time = Date.now();
  const fire = () =>
    f.store.tx(f.alice.tenantId, (s) =>
      scheduler.fire(s, s.schedules![task.id]!, ++time, "manual"),
    );
  const failures = () =>
    f.store.readMetadata(
      f.alice.tenantId,
      ["schedules"],
      (s) => s.schedules![task.id]!,
    );
  // Agent is available, but Run creation fails validation before submission.
  await f.registry.tx((s) => {
    s.managedAgents!.assistant!.config.model = {
      provider: "default",
      modelId: "default",
    };
  });
  const first = await fire();
  assert.equal(first.state, "failed");
  assert.equal(first.error, "DEFAULT_MODEL_UNAVAILABLE");
  assert.equal((await failures()).failures, 1);
  await f.store.tx(f.alice.tenantId, (s) =>
    scheduler.fire(s, s.schedules![task.id]!, time, "manual"),
  );
  await scheduler.tick();
  assert.equal(
    (await failures()).failures,
    1,
    "deduplication and settlement must not double-count",
  );
  await f.registry.tx((s) => {
    s.managedAgents!.assistant!.config = config();
  });
  const submitted = await fire();
  assert.equal(submitted.state, "submitted");
  assert.equal((await fire()).state, "skipped");
  assert.equal(
    (await failures()).failures,
    1,
    "SESSION_BUSY neither counts nor resets",
  );
  await f.store.runTx(f.alice.tenantId, submitted.runId!, (s) => {
    s.runs[submitted.runId!]!.state = "COMPLETED";
  });
  await scheduler.tick();
  assert.equal((await failures()).failures, 0);
  await f.registry.tx((s) => {
    s.managedAgents!.assistant!.enabled = false;
  });
  for (let n = 1; n <= 3; n++) {
    await f.store.tx(f.alice.tenantId, (s) => {
      s.schedules![task.id]!.nextFireAt = Date.now() - 1;
    });
    await scheduler.tick();
    assert.equal((await failures()).failures, n);
  }
  assert.equal((await failures()).enabled, false);
  const count = await f.store.read(
    f.alice.tenantId,
    (s) => Object.keys(s.scheduleFires!).length,
  );
  await scheduler.tick();
  assert.equal(
    await f.store.read(
      f.alice.tenantId,
      (s) => Object.keys(s.scheduleFires!).length,
    ),
    count,
  );
  await f.worker.stop();
});

test("failed new-mode schedule admission restores Session bindings and leaves no empty Sessions", async () => {
  const { ScheduleService } = await import("../src/schedules/service.js");
  const f = await fixture(),
    scheduler = new ScheduleService(f.service);
  const task = await scheduler.create(f.alice, {
    agentId: "assistant",
    cron: "* * * * *",
    prompt: "tick",
    sessionMode: "new",
    maxConsecutiveFailures: 3,
  });
  let time = Date.now();
  const fire = () =>
    f.store.tx(f.alice.tenantId, (s) =>
      scheduler.fire(s, s.schedules![task.id]!, ++time, "manual"),
    );
  try {
    await f.registry.tx((s) => {
      s.managedAgents!.assistant!.config.model = {
        provider: "default",
        modelId: "default",
      };
    });
    for (let n = 0; n < 2; n++) {
      assert.equal((await fire()).error, "DEFAULT_MODEL_UNAVAILABLE");
      const snapshot = await f.store.read(f.alice.tenantId, (s) => ({
        sessions: Object.keys(s.sessions),
        task: s.schedules![task.id]!,
      }));
      assert.deepEqual(snapshot.sessions, []);
      assert.equal(snapshot.task.sessionId, undefined);
      assert.equal(snapshot.task.failures, n + 1);
    }
    await f.registry.tx((s) => {
      s.managedAgents!.assistant!.config = config();
    });
    const submitted = await fire();
    const originalSession = await f.store.readRun(
      f.alice.tenantId,
      submitted.runId!,
      (s) => s.runs[submitted.runId!]!.sessionId,
    );
    await f.registry.tx((s) => {
      s.managedAgents!.assistant!.config.model = {
        provider: "default",
        modelId: "default",
      };
    });
    assert.equal((await fire()).error, "DEFAULT_MODEL_UNAVAILABLE");
    const snapshot = await f.store.read(f.alice.tenantId, (s) => ({
      sessions: Object.keys(s.sessions),
      task: s.schedules![task.id]!,
    }));
    assert.deepEqual(snapshot.sessions, [originalSession]);
    assert.equal(snapshot.task.sessionId, originalSession);
    assert.equal(snapshot.task.enabled, false);
  } finally {
    await f.worker.stop();
  }
});

for (const failure of ["total", "sandbox", "topic", "index", "abort"])
  test(`Memory ${failure} failures release successful-write quota and do not emit success audits`, async () => {
    const { MemoryManager } = await import("../src/execution/memory.js"),
      { Fault } = await import("../src/domain.js");
    const f = await fixture(),
      memory = new MemoryManager(f.store, f.sandbox);
    const ses = await f.service.createPersonalSession(f.alice, {
      agentId: "assistant",
    });
    const r = await f.service.submit(f.alice, ses.id, "remember");
    const cfg = config({
      memory: {
        enabled: true,
        scopes: ["user"],
        maxWritesPerRun: 1,
        maxFiles: 1,
      },
    });
    await f.provider.createVolume(`ws-${f.alice.userId}`);
    const files = f.provider.volumes.get(`ws-${f.alice.userId}`)!;
    if (failure === "total") files.set("/workspace/memory/old.md", "old");
    let fail = true;
    const execute = f.provider.execute.bind(f.provider);
    f.provider.execute = async (sid, op, args) => {
      if (
        fail &&
        ((failure === "sandbox" && op === "mkdir") ||
          (failure === "topic" &&
            op === "write" &&
            args.path === "/workspace/memory/note.md") ||
          (failure === "index" &&
            op === "write" &&
            String(args.path).endsWith("/MEMORY.md")))
      )
        throw new Fault(502, "TEST_WRITE_FAILED");
      if (fail && failure === "abort" && op === "find")
        throw new DOMException("aborted", "AbortError");
      return execute(sid, op, args);
    };
    const write = () =>
      memory.write(
        f.alice,
        f.alice.userId,
        r.id,
        cfg,
        "/workspace",
        "/workspace/memory/note.md",
        "remember",
        new AbortController().signal,
      );
    try {
      for (let i = 0; i < (failure === "total" ? 10 : 1); i++)
        await assert.rejects(write());
      const snapshot = await f.store.readRun(
        f.alice.tenantId,
        r.id,
        (s) => s.runs[r.id]!,
      );
      assert.equal(snapshot.memoryWrites ?? 0, 0);
      assert.equal(snapshot.memoryWriteReservations, undefined);
      const audits = await f.store.readMetadata(
        f.alice.tenantId,
        ["audit"],
        (s) => s.audit.filter((a) => a.action.startsWith("memory.write")),
      );
      assert.ok(audits.some((a) => a.action === "memory.write.failed"));
      assert.ok(!audits.some((a) => a.action === "memory.write"));
      fail = false;
      files.delete("/workspace/memory/old.md");
      assert.equal((await write()).written, true);
      assert.equal(
        (await f.store.readRun(f.alice.tenantId, r.id, (s) => s.runs[r.id]!))
          .memoryWrites,
        1,
      );
      await assert.rejects(write(), { code: "MEMORY_WRITE_LIMIT" });
      assert.equal(
        (
          await f.store.readMetadata(f.alice.tenantId, ["audit"], (s) =>
            s.audit.filter((a) => a.action === "memory.write"),
          )
        ).length,
        1,
      );
    } finally {
      await f.worker.stop();
    }
  });

test("Memory quota reservations serialize concurrent managers, release on failure and ignore stale Worker leases", async () => {
  const { MemoryManager } = await import("../src/execution/memory.js"),
    { Fault } = await import("../src/domain.js");
  const f = await fixture(),
    m1 = new MemoryManager(f.store, f.sandbox),
    m2 = new MemoryManager(f.store, f.sandbox);
  const ses = await f.service.createPersonalSession(f.alice, {
      agentId: "assistant",
    }),
    r = await f.service.submit(f.alice, ses.id, "remember");
  const cfg = config({
    memory: { enabled: true, scopes: ["user"], maxWritesPerRun: 1 },
  });
  await f.store.runTx(f.alice.tenantId, r.id, (s) => {
    s.runs[r.id]!.memoryWriteReservations = { stale: { owner: "dead-worker" } };
  });
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const execute = f.provider.execute.bind(f.provider);
  let block = true;
  f.provider.execute = async (sid, op, args) => {
    if (block && op === "find") {
      entered();
      await gate;
      throw new Fault(502, "TEST_WRITE_FAILED");
    }
    return execute(sid, op, args);
  };
  const write = (m: typeof m1) =>
    m.write(
      f.alice,
      f.alice.userId,
      r.id,
      cfg,
      "/workspace",
      "/workspace/memory/note.md",
      "remember",
      new AbortController().signal,
    );
  const first = assert.rejects(write(m1), { code: "TEST_WRITE_FAILED" });
  try {
    await ready;
    await assert.rejects(write(m2), { code: "MEMORY_WRITE_LIMIT" });
    release();
    await first;
    block = false;
    assert.equal((await write(m2)).written, true);
    const current = await f.store.readRun(
      f.alice.tenantId,
      r.id,
      (s) => s.runs[r.id]!,
    );
    assert.equal(current.memoryWrites, 1);
    assert.equal(current.memoryWriteReservations, undefined);
  } finally {
    release();
    await first;
    await f.worker.stop();
  }
});
