import test from "node:test";
import assert from "node:assert/strict";
import { buildAPI } from "../src/api/server.js";
import { MemoryRegistry } from "../src/storage/registry.js";
import { MemoryStore } from "../src/storage/store.js";
import { personalStore } from "../src/storage/personal.js";
import { PersonalService } from "../src/domain/personal-service.js";
import { SandboxManager, DemoSandbox } from "../src/sandbox/manager.js";
import { seedDemo } from "../src/config/agents.js";
import { Fault } from "../src/domain/model.js";
test("trusted identity exposes role without credentials; non-admin global reads/writes are forbidden", async () => {
  const registry = new MemoryRegistry();
  await registry.tx(seedDemo);
  const store = personalStore(new MemoryStore(), registry),
    service = new PersonalService(store, registry);
  const app = buildAPI(
    service,
    async (header) => {
      if (!header) throw new Fault(401, "UNAUTHENTICATED");
      return {
        tenantId: "idp",
        issuer: "urn:test",
        subject: header,
        userId: header,
        admin: header === "admin",
        expiresAt: Date.now() + 60000,
      };
    },
    new SandboxManager(store, new DemoSandbox()),
  );
  try {
    assert.equal((await app.inject({ url: "/api/v1/me" })).statusCode, 401);
    const user = await app.inject({
      url: "/api/v1/me",
      headers: { authorization: "user" },
    });
    assert.equal(user.statusCode, 200);
    assert.equal(user.headers["cache-control"], "no-store");
    assert.equal(user.json().role, "user");
    assert.equal(user.json().admin, false);
    assert.deepEqual(Object.keys(user.json()).sort(), [
      "admin",
      "expiresAt",
      "role",
      "userId",
    ]);
    assert.equal(
      (
        await app.inject({
          url: "/api/v1/me",
          headers: { authorization: "admin" },
        })
      ).json().admin,
      true,
    );
    for (const [method, url, payload] of [
      ["GET", "/api/v1/admin/config/global", undefined],
      [
        "POST",
        "/api/v1/admin/config/global",
        { revision: 0, policy: { disabledTools: [] } },
      ],
      ["GET", "/api/v1/admin/configuration", undefined],
      ["PUT", "/api/v1/admin/configuration/defaults", {}],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { authorization: "user" },
        ...(payload ? { payload } : {}),
      });
      assert.equal(response.statusCode, 403, response.body);
    }
    const global = await app.inject({
      url: "/api/v1/admin/config/global",
      headers: { authorization: "admin" },
    });
    assert.equal(global.statusCode, 200);
    const revision = global.json().revision;
    const save = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/admin/config/global",
        headers: { authorization: "admin" },
        payload: { revision, policy: { disabledTools: ["bash"] } },
      });
    assert.equal((await save()).statusCode, 200);
    assert.equal((await save()).statusCode, 409);
    assert.deepEqual(
      (
        await app.inject({
          url: "/api/v1/admin/config/global",
          headers: { authorization: "admin" },
        })
      ).json().policy.disabledTools,
      ["bash"],
    );
  } finally {
    await app.close();
  }
});
