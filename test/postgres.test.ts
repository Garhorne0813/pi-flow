import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PostgresStore } from "../src/store.js";
import { HarnessService } from "../src/service.js";
import { AgentConfig, id, type Actor } from "../src/domain.js";
const url = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL restart persistence, multi-client serialization and transaction rollback",
  { skip: !url },
  async () => {
    const a: Actor = { tenantId: "pg-" + id(), userId: "test", admin: true };
    const s1 = new PostgresStore(url!),
      s2 = new PostgresStore(url!);
    try {
      await s1.pool.query(await readFile("migrations/001_initial.sql", "utf8"));
      const service = new HarnessService(s1, [], ["default"]);
      const av = await service.publish(
        a,
        AgentConfig.parse({
          name: "pg",
          systemPrompt: "test",
          model: { provider: "demo", modelId: "demo" },
          tools: [],
          skillBundle: "default",
        }),
      );
      const w = await service.createWorkspace(a, "pg");
      const ses = await service.createSession(a, w.id, av.id);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 ? s1 : s2).tx(a.tenantId, (s) => {
            s.sequence++;
          }),
        ),
      );
      assert.equal(await s2.tx(a.tenantId, (s) => s.sequence), 20);
      await assert.rejects(
        s1.tx(a.tenantId, (s) => {
          s.sequence = 999;
          throw new Error("rollback");
        }),
      );
      assert.equal(await s2.tx(a.tenantId, (s) => s.sequence), 20);
      const svc2 = new HarnessService(s2, [], ["default"]);
      const [r1, r2] = await Promise.all([
        service.submit(a, ses.id, "persist", "key"),
        svc2.submit(a, ses.id, "persist", "key"),
      ]);
      assert.equal(r1.id, r2.id);
      await s1.close();
      const s3 = new PostgresStore(url!);
      try {
        const stored = await s3.tx(a.tenantId, (s) => s.runs[r1.id]);
        assert.equal(stored!.prompt, "persist");
        assert.equal(stored!.state, "QUEUED");
        assert.equal(stored!.id, r1.id);
      } finally {
        await s3.close();
      }
    } finally {
      await s2.pool.query("DELETE FROM harness_tenants WHERE tenant_id=$1", [
        a.tenantId,
      ]);
      await s1.close().catch(() => {});
      await s2.close();
    }
  },
);
