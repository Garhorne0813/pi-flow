import test from "node:test";
import assert from "node:assert/strict";
import { jobsFixture } from "./eval-job-fixture.js";
import { databaseUrl } from "./eval-fixture.js";
import { buildAPI } from "../src/api/server.js";
import { PersonalService } from "../src/domain/personal-service.js";
import { personalStore } from "../src/storage/personal.js";
import { MemoryStore } from "../src/storage/store.js";
import { SandboxManager, DemoSandbox } from "../src/sandbox/manager.js";
test(
  "eval HTTP APIs enforce private tenant ACL including reports/compare/cancel and SSE replay expires",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture(),
      backing = new MemoryStore(),
      normal = new PersonalService(
        personalStore(backing, f.registry),
        f.registry,
      );
    const otherId = await f.registry.identify("test", "other");
    const app = buildAPI(
      normal,
      async (header) =>
        header === "Bearer other"
          ? {
              ...f.actor,
              userId: otherId,
              tenantId: otherId,
              subject: "other",
              admin: true,
            }
          : header === "Bearer expiring"
            ? { ...f.actor, expiresAt: Date.now() + 300 }
            : f.actor,
      new SandboxManager(backing, new DemoSandbox()),
      undefined,
      undefined,
      undefined,
      f.service,
    );
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/evals/jobs",
        headers: { "idempotency-key": "api" },
        payload: f.request,
      });
      assert.equal(created.statusCode, 202);
      const job = created.json();
      for (const path of [
        "/jobs/" + job.jobId,
        "/jobs/" + job.jobId + "/cases",
        "/jobs/" + job.jobId + "/report",
        "/suites/" + f.request.suiteId + "/versions/1",
      ]) {
        const r = await app.inject({
          url: "/api/v1/evals" + path,
          headers: { authorization: "Bearer other" },
        });
        assert.equal(r.statusCode, 404, path);
      }
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/evals/jobs/" + job.jobId + "/cancel",
            headers: { authorization: "Bearer other" },
            payload: {},
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/evals/compare",
            headers: { authorization: "Bearer other" },
            payload: { baselineJobId: job.jobId, candidateJobId: job.jobId },
          })
        ).statusCode,
        404,
      );
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(
        address + "/api/v1/evals/jobs/" + job.jobId + "/events",
        {
          headers: { authorization: "Bearer expiring", "Last-Event-ID": "0" },
          signal: AbortSignal.timeout(3000),
        },
      );
      const reader = response.body!.getReader();
      let text = "";
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          text += new TextDecoder().decode(r.value);
        }
      } catch {}
      assert.match(text, /id: 1/);
      assert.match(text, /eval.job.created/);
      const other = await fetch(
        address + "/api/v1/evals/jobs/" + job.jobId + "/events",
        { headers: { authorization: "Bearer other" } },
      );
      assert.equal(other.status, 404);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/evals/jobs",
            payload: f.request,
          })
        ).statusCode,
        400,
      );
    } finally {
      await app.close();
      await f.close();
    }
  },
);
