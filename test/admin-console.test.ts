import assert from "node:assert/strict";
import test from "node:test";
import { buildAPI } from "../src/api.js";
import { AgentDefaults, Fault, type Actor } from "../src/domain.js";
import { HarnessService } from "../src/service.js";
import { MemoryStore, PostgresStore, type Store } from "../src/store.js";
import { metadata, snapshotState } from "../src/run-store.js";
import { DemoSandbox, SandboxManager } from "../src/adapters/sandbox.js";
import type { MCPManager } from "../src/adapters/mcp.js";

function fixture(mcp?: MCPManager, store: Store = new MemoryStore()) {
  const service = new HarnessService(
    store,
    ["docs", "private"],
    ["default", "private"],
    [{ provider: "enterprise", modelId: "coding" }],
    {
      one: { bundles: ["default"], endpoints: ["docs"] },
      two: { bundles: ["private"], endpoints: ["private"] },
    },
  );
  const app = buildAPI(
    service,
    async (header) => {
      if (!header) throw new Fault(401, "UNAUTHENTICATED");
      return {
        tenantId: header === "other" ? "two" : "one",
        userId: "admin",
        admin: header !== "user",
      };
    },
    new SandboxManager(store, new DemoSandbox()),
    mcp,
  );
  return { app, store, service };
}
const defaults = AgentDefaults.parse({
  model: { provider: "enterprise", modelId: "coding" },
  skillBundle: "default",
  tools: ["read"],
  maxSteps: 42,
});

test("configuration is admin-only, filters tenant grants and stores isolated defaults", async () => {
  const { app, store } = fixture();
  try {
    assert.equal((await app.inject({ url: "/admin/ui" })).statusCode, 302);
    assert.equal(
      (await app.inject({ url: "/api/v1/admin/configuration" })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/v1/admin/configuration",
          headers: { authorization: "user" },
        })
      ).statusCode,
      403,
    );
    const before = await app.inject({
      url: "/api/v1/admin/configuration",
      headers: { authorization: "admin" },
    });
    assert.match(before.headers["cache-control"] as string, /no-store/);
    assert.deepEqual(before.json().deployment.bundles, ["default"]);
    assert.deepEqual(before.json().deployment.endpoints, ["docs"]);
    assert.equal(before.json().deployment.editable, false);
    assert.equal(before.json().deployment.sandbox.maxActivePerUser, 3);
    const save = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/configuration/defaults",
      headers: { authorization: "admin" },
      payload: { ...defaults, expectedRevision: 0 },
    });
    assert.equal(save.statusCode, 200);
    const after = (
      await app.inject({
        url: "/api/v1/admin/configuration",
        headers: { authorization: "admin" },
      })
    ).json();
    assert.deepEqual(after.agentDefaults, defaults);
    const other = (
      await app.inject({
        url: "/api/v1/admin/configuration",
        headers: { authorization: "other" },
      })
    ).json();
    assert.equal(other.agentDefaults.maxSteps, 30);
    assert.equal(other.agentDefaults.skillBundle, "private");
    const persisted = await store.read("one", (s) => metadata(s));
    assert.deepEqual(
      snapshotState({ state: persisted, runs: [], sessions: [] }).agentDefaults,
      defaults,
    );
    assert.ok(
      await store.read("one", (s) =>
        s.audit.some((e) => e.action === "configuration.defaults"),
      ),
    );
    assert.doesNotMatch(JSON.stringify(after), /API_KEY|tokenEnv|https:\/\//);
  } finally {
    await app.close();
  }
});

test("defaults reject unapproved models, ungranted bundles and unknown deployment fields", async () => {
  const { app } = fixture();
  try {
    for (const [payload, status, code] of [
      [
        { ...defaults, model: { provider: "external", modelId: "other" } },
        403,
        "MODEL_NOT_APPROVED",
      ],
      [{ ...defaults, skillBundle: "private" }, 400, "UNKNOWN_SKILL_BUNDLE"],
      [{ ...defaults, maxSteps: 101 }, 400, "INVALID_REQUEST"],
      [{ ...defaults, apiKey: "not-accepted" }, 400, "INVALID_REQUEST"],
    ] as const) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/admin/configuration/defaults",
        headers: { authorization: "admin" },
        payload: { ...payload, expectedRevision: 0 },
      });
      assert.equal(response.statusCode, status);
      assert.equal(response.json().error.code, code);
    }
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/admin/configuration/defaults",
          headers: { authorization: "user" },
          payload: { ...defaults, expectedRevision: 0 },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});

test("MCP check discovers tools with a deadline, never calls tools and enforces auth/status/grants", async () => {
  let discoveries = 0;
  const mcp = {
    async discover(
      a: Actor,
      config: { mcpServers: string[] },
      signal: unknown,
      deadline: number,
    ) {
      discoveries++;
      assert.equal(a.tenantId, "one");
      assert.deepEqual(config.mcpServers, ["docs"]);
      assert.equal(signal, undefined);
      assert.ok(deadline > Date.now() && deadline <= Date.now() + 10000);
      return {
        specs: [{ name: "mcp_docs_search", description: "Search docs" }],
        call() {
          throw new Error("Check must not call a tool");
        },
      };
    },
  } as unknown as MCPManager;
  const { app, store } = fixture(mcp);
  const url = "/api/v1/admin/mcp-servers/docs/check";
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: "user" },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: "admin" },
          payload: {},
        })
      ).statusCode,
      404,
    );
    await store.tx("one", (s) => {
      s.mcp.docs = {
        id: "docs",
        endpointRef: "docs",
        allowedTools: ["search"],
        enabled: true,
      };
    });
    const response = await app.inject({
      method: "POST",
      url,
      headers: { authorization: "admin" },
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().tools[0].name, "mcp_docs_search");
    assert.equal(discoveries, 1);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: "admin" },
          payload: { url: "https://other" },
        })
      ).statusCode,
      400,
    );
    await store.tx("one", (s) => {
      s.mcp.docs!.enabled = false;
    });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: "admin" },
          payload: {},
        })
      ).statusCode,
      403,
    );
    await store.tx("one", (s) => {
      s.mcp.docs!.enabled = true;
      s.mcp.docs!.endpointRef = "private";
    });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: "admin" },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(discoveries, 1);
  } finally {
    await app.close();
  }
});

test("registry changes are audited and registration retains strict tenant validation", async () => {
  const { app, store } = fixture();
  try {
    const skill = {
      id: "review@v1",
      name: "Review",
      description: "Review code",
      bundle: "default",
      path: "/skills/review/SKILL.md",
      digest: "a".repeat(64),
    };
    const request = (method: "POST" | "PUT", url: string, payload: object) =>
      app.inject({ method, url, headers: { authorization: "admin" }, payload });
    assert.equal(
      (await request("POST", "/api/v1/admin/skills", skill)).statusCode,
      201,
    );
    assert.equal(
      (await request("POST", "/api/v1/admin/skills", skill)).statusCode,
      409,
    );
    assert.equal(
      (
        await request("POST", "/api/v1/admin/skills", {
          ...skill,
          id: "review@v2",
          bundle: "private",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await request("PUT", "/api/v1/admin/skills/review%40v1/status", {
          enabled: false,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await request("POST", "/api/v1/admin/mcp-servers", {
          id: "docs",
          endpointRef: "docs",
          allowedTools: ["search"],
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await request("PUT", "/api/v1/admin/mcp-servers/docs/status", {
          enabled: false,
        })
      ).statusCode,
      200,
    );
    const actions = await store.read("one", (s) =>
      s.audit.map((e) => e.action),
    );
    assert.ok(actions.includes("skill.status"));
    assert.ok(actions.includes("mcp.status"));
  } finally {
    await app.close();
  }
});

test("two administrators cannot overwrite stale defaults; concurrent writes compare revisions atomically", async () => {
  const { app, store } = fixture();
  const get = async () =>
    (
      await app.inject({
        url: "/api/v1/admin/configuration",
        headers: { authorization: "admin" },
      })
    ).json();
  const save = (expectedRevision: number, maxSteps: number) =>
    app.inject({
      method: "PUT",
      url: "/api/v1/admin/configuration/defaults",
      headers: { authorization: "admin" },
      payload: { ...defaults, expectedRevision, maxSteps },
    });
  try {
    const [a, b] = await Promise.all([get(), get()]);
    assert.equal(a.defaultsRevision, 0);
    assert.equal(b.defaultsRevision, 0);
    const first = await save(a.defaultsRevision, 41);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().defaultsRevision, 1);
    const stale = await save(b.defaultsRevision, 42);
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "DEFAULTS_CONFLICT");
    assert.equal((await get()).agentDefaults.maxSteps, 41);
    assert.equal(
      await store.read(
        "one",
        (s) =>
          s.audit.filter((e) => e.action === "configuration.defaults").length,
      ),
      1,
    );
    assert.equal((await save(1, 42)).statusCode, 200);
    const concurrent = await Promise.all([save(2, 43), save(2, 44)]);
    assert.deepEqual(
      concurrent.map((response) => response.statusCode).sort(),
      [200, 409],
    );
    const final = await get();
    assert.equal(final.defaultsRevision, 3);
    assert.ok([43, 44].includes(final.agentDefaults.maxSteps));
    const persisted = await store.read("one", (s) => metadata(s));
    assert.equal(
      snapshotState({ state: persisted, runs: [], sessions: [] })
        .defaultsRevision,
      3,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/admin/configuration/defaults",
          headers: { authorization: "admin" },
          payload: defaults,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/v1/admin/configuration",
          headers: { authorization: "other" },
        })
      ).json().defaultsRevision,
      0,
    );
  } finally {
    await app.close();
  }
});

test(
  "PostgreSQL defaults CAS persists across clients and does not replace logical Agent metadata",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const store = new PostgresStore(process.env.TEST_DATABASE_URL!);
    const second = new PostgresStore(process.env.TEST_DATABASE_URL!);
    const schema = "console_" + crypto.randomUUID().replaceAll("-", "");
    // Isolate this tenant from all other API fixtures and database tests.
    const actor = { tenantId: schema, userId: "admin", admin: true };
    const makeApp = (db: Store) =>
      buildAPI(
        new HarnessService(
          db,
          [],
          ["default"],
          [{ provider: "enterprise", modelId: "coding" }],
        ),
        async () => actor,
        new SandboxManager(db, new DemoSandbox()),
      );
    const apps = [makeApp(store), makeApp(second)];
    let firstClosed = false;
    try {
      const version = (
        await apps[0]!.inject({
          method: "POST",
          url: "/api/v1/admin/agents",
          payload: { ...defaults, name: "Persisted", systemPrompt: "" },
        })
      ).json();
      assert.ok(version.agentId);
      const payload = { ...defaults, expectedRevision: 0 };
      const writes = await Promise.all(
        apps.map((app) =>
          app.inject({
            method: "PUT",
            url: "/api/v1/admin/configuration/defaults",
            payload,
          }),
        ),
      );
      assert.deepEqual(writes.map((r) => r.statusCode).sort(), [200, 409]);
      await apps[0]!.close();
      await store.close();
      firstClosed = true;
      const persisted = (
        await apps[1]!.inject({ url: "/api/v1/admin/configuration" })
      ).json();
      assert.equal(persisted.defaultsRevision, 1);
      assert.deepEqual(persisted.agentDefaults, defaults);
      const state = await second.readMetadata(
        actor.tenantId,
        ["agents", "logicalAgents"],
        (s) => s,
      );
      assert.equal(
        state.logicalAgents[version.agentId]!.activeVersionId,
        version.id,
      );
      assert.equal(state.agents[version.id]!.config.name, "Persisted");
    } finally {
      await Promise.all(apps.map((app) => app.close()));
      await second.pool.query(
        "DELETE FROM harness_tenants WHERE tenant_id=$1",
        [actor.tenantId],
      );
      await Promise.all([
        ...(firstClosed ? [] : [store.close()]),
        second.close(),
      ]);
    }
  },
);
