import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { PersonalPostgresStore } from "../src/storage/personal-postgres-store.js";
import { PostgresRegistry, principal } from "../src/storage/registry.js";
import { personalStore } from "../src/storage/personal.js";
import { PersonalService } from "../src/domain/personal-service.js";
import { seedDemo } from "../src/config/agents.js";
import { buildAPI } from "../src/api/server.js";
import { DemoSandbox, SandboxManager } from "../src/sandbox/manager.js";
import { Worker } from "../src/execution/worker.js";
import { DemoRuntime } from "../src/execution/runtime.js";
import { MCPManager } from "../src/mcp/manager.js";
const url = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL chat keyset history, active task, authorization and soft deletion",
  { skip: !url },
  async () => {
    const pool = new pg.Pool({ connectionString: url }),
      schema = "chat_" + crypto.randomUUID().replaceAll("-", "");
    await pool.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const backing = new PersonalPostgresStore(scoped.toString()),
      registry = new PostgresRegistry(backing.pool),
      store = personalStore(backing, registry),
      service = new PersonalService(store, registry),
      sandbox = new SandboxManager(store, new DemoSandbox()),
      worker = new Worker(
        service,
        new DemoRuntime(),
        sandbox,
        new MCPManager(store, {}),
      );
    const identity = {
      tenantId: "idp",
      userId: "alice",
      admin: false,
      issuer: "urn:test",
      subject: "alice",
    };
    const app = buildAPI(
      service,
      async (header) =>
        header === "bob"
          ? { ...identity, userId: "bob", subject: "bob" }
          : identity,
      sandbox,
    );
    try {
      for (const file of (await readdir("migrations"))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await backing.pool.query(await readFile("migrations/" + file, "utf8"));
      await registry.tx(seedDemo);
      const actor = await principal(registry, identity);
      const session = await service.createPersonalSession(actor, {
          agentId: "assistant",
        }),
        run = await service.submit(actor, session.id, "hello", "once");
      const active = await app.inject({
        url: `/api/v1/sessions/${session.id}/active-task`,
      });
      assert.equal(active.json().activeRun.id, run.id);
      for (let i = 0; i < 200; i++) {
        await worker.tick();
        const r = await store.readRun(
          actor.tenantId,
          run.id,
          (s) => s.runs[run.id],
        );
        if (r?.state === "COMPLETED" && !r.lease) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      let cursor: string | null = null;
      const ids: string[] = [];
      const kinds: string[] = [];
      do {
        const page = await app.inject({
          url: `/api/v1/sessions/${session.id}/timeline?limit=1${cursor ? "&cursor=" + cursor : ""}`,
        });
        assert.equal(page.statusCode, 200, page.body);
        for (const item of page.json().items) {
          ids.push(item.id);
          kinds.push(item.kind);
        }
        cursor = page.json().nextCursor;
      } while (cursor);
      assert.equal(new Set(ids).size, ids.length);
      assert.deepEqual(kinds.sort(), ["assistant", "user"]);
      assert.equal(
        (
          await app.inject({
            url: `/api/v1/sessions/${session.id}/active-task`,
          })
        ).json().activeRun,
        null,
      );
      assert.equal(
        (
          await app.inject({
            url: `/api/v1/sessions/${session.id}/timeline`,
            headers: { authorization: "bob" },
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            url: `/api/v1/sessions/${session.id}/timeline?cursor=invalid`,
          })
        ).statusCode,
        400,
      );
      await service.deleteSession(actor, session.id);
      assert.equal(
        (await app.inject({ url: `/api/v1/sessions/${session.id}/timeline` }))
          .statusCode,
        404,
      );
    } finally {
      await worker.stop();
      await app.close();
      await backing.close();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  },
);
