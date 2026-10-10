import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../scripts/acceptance/fixture.js";
import { workerHistoryBenchmark } from "../scripts/acceptance/worker-history.js";
import { authorizedRun } from "../src/service.js";
import { run } from "../src/domain.js";
const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_TESTS === "true" && !url)
  throw new Error("TEST_DATABASE_URL required");
test(
  "idle Worker uses bounded indexes with 20k historical Runs and 100k Events",
  { skip: !url },
  async () => {
    const report = await workerHistoryBenchmark();
    console.log(JSON.stringify(report));
  },
);
test(
  "Run snapshots retain target and ancestor ACLs but omit unrelated runs, session/event, audit and usage history",
  { skip: !url },
  async () => {
    const f = await fixture();
    try {
      const parentSession = await f.service.createSession(
        f.actor,
        await f.store.readRun(
          f.actor.tenantId,
          f.run.id,
          (s) => s.sessions[f.run.sessionId]!.workspaceId,
        ),
        await f.store.readRun(
          f.actor.tenantId,
          f.run.id,
          (s) => s.sessions[f.run.sessionId]!.agentVersionId,
        ),
      );
      const parent = await f.service.submit(
        f.actor,
        parentSession.id,
        "parent",
      );
      await f.store.tx(f.actor.tenantId, (s) => {
        s.runs[f.run.id]!.parentRunId = parent.id;
        s.sessions[f.run.sessionId]!.entries = [{ checkpoint: "target" }];
        s.audit = Array.from({ length: 10000 }, (_, i) => ({
          id: String(i),
          actorId: "user",
          action: "history",
          resource: "history",
          result: "allowed",
          timestamp: new Date().toISOString(),
        }));
        (s as any).usage = {
          requests: {},
          resources: Array.from({ length: 10000 }, () => ({
            workspaceId: "irrelevant",
            state: "unknown" as const,
            at: 1,
          })),
        };
      });
      const state = await f.store.readRun(
        f.actor.tenantId,
        f.run.id,
        (s) => s,
        true,
      );
      assert.deepEqual(
        Object.keys(state.runs).sort(),
        [f.run.id, parent.id].sort(),
      );
      assert.deepEqual(state.sessions[f.run.sessionId]!.entries, [
        { checkpoint: "target" },
      ]);
      assert.deepEqual(state.audit, []);
      assert.deepEqual(state.events, []);
      assert.equal((state as any).usage, undefined);
      await f.store.readRun(f.actor.tenantId, f.run.id, (s) =>
        authorizedRun(s, s.runs[f.run.id]!),
      );
      await assert.rejects(
        f.store.readRun("foreign", f.run.id, (s) => run(s, f.actor, f.run.id)),
        { code: "RUN_NOT_FOUND" },
      );
      await assert.rejects(
        f.store.readRun(f.actor.tenantId, f.run.id, (s) =>
          run(s, { ...f.actor, userId: "foreign" }, f.run.id),
        ),
        { code: "WORKSPACE_NOT_FOUND" },
      );
      await f.store.tx(f.actor.tenantId, (s) => {
        s.runs[parent.id]!.cancelRequested = true;
      });
      await assert.rejects(
        f.store.readRun(f.actor.tenantId, f.run.id, (s) =>
          authorizedRun(s, s.runs[f.run.id]!),
        ),
        { code: "RUN_CANCELLED" },
      );
      await f.store.tx(f.actor.tenantId, (s) => {
        delete s.runs[parent.id]!.cancelRequested;
        s.agents[parentSession.agentVersionId]!.enabled = false;
      });
      await assert.rejects(
        f.store.readRun(f.actor.tenantId, f.run.id, (s) =>
          authorizedRun(s, s.runs[f.run.id]!),
        ),
        { code: "AGENT_REVOKED" },
      );
      await f.store.tx(f.actor.tenantId, (s) => {
        delete s.workspaces[parentSession.workspaceId]!.members[f.actor.userId];
      });
      await assert.rejects(
        f.store.readRun(
          f.actor.tenantId,
          f.run.id,
          (s) => run(s, f.actor, f.run.id).state,
        ),
        { code: "WORKSPACE_NOT_FOUND" },
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "claimable IDs are bounded and tenant scoped; expired leases precede queued work",
  { skip: !url },
  async () => {
    const f = await fixture();
    try {
      await f.store.pool.query(
        `INSERT INTO harness_runs(tenant_id,run_id,session_id,user_id,state,lease_owner,lease_expires,created_at,data)
   SELECT $1,'expired-'||n,$2,$3,'FAILED','lost',n,now(),$4::jsonb || jsonb_build_object('id','expired-'||n,'state','FAILED','lease',jsonb_build_object('owner','lost','expires',n))
   FROM generate_series(1,80) n`,
        [
          f.actor.tenantId,
          f.run.sessionId,
          f.actor.userId,
          JSON.stringify(f.run),
        ],
      );
      const ids = await f.store.listClaimableRuns(f.actor.tenantId, 100, 64);
      assert.equal(ids.length, 64);
      assert.equal(ids[0], "expired-1");
      assert.equal(ids.at(-1), "expired-64");
      assert.ok(!ids.includes(f.run.id));
      assert.deepEqual(await f.store.listClaimableRuns("foreign", 100, 64), []);
      await f.store.pool.query(
        "UPDATE harness_runs SET lease_owner=NULL,lease_expires=NULL,data=data-'lease' WHERE tenant_id=$1 AND state='FAILED'",
        [f.actor.tenantId],
      );
      assert.deepEqual(
        await f.store.listClaimableRuns(f.actor.tenantId, 100, 64),
        [f.run.id],
      );
      await assert.rejects(
        f.store.listClaimableRuns(f.actor.tenantId, 100, 0),
        /Invalid candidate limit/,
      );
      await assert.rejects(
        f.store.listClaimableRuns(f.actor.tenantId, 100, 101),
        /Invalid candidate limit/,
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "response audit appends atomically without hydrating historical entities",
  { skip: !url },
  async () => {
    const f = await fixture();
    const writer = await f.store.pool.connect();
    try {
      const before = (
        await f.store.pool.query(
          "SELECT state,revision FROM harness_tenants WHERE tenant_id=$1",
          [f.actor.tenantId],
        )
      ).rows[0];
      await writer.query("BEGIN");
      await writer.query(
        "UPDATE harness_tenants SET state=jsonb_set(state,'{todos}', '{\"preserve\":true}'::jsonb) WHERE tenant_id=$1",
        [f.actor.tenantId],
      );
      const append = (n: number) =>
        f.store.appendAudit(f.actor.tenantId, {
          id: "audit-" + n,
          timestamp: new Date().toISOString(),
          actorId: f.actor.userId,
          action: "GET /run",
          resource: f.run.id,
          result: "200",
        });
      f.store.read = async () => {
        throw new Error("unexpected full read");
      };
      f.store.tx = async () => {
        throw new Error("unexpected full transaction");
      };
      const pending = [append(1), append(2)];
      await writer.query("COMMIT");
      await Promise.all(pending);
      const after = (
        await f.store.pool.query(
          "SELECT state,revision FROM harness_tenants WHERE tenant_id=$1",
          [f.actor.tenantId],
        )
      ).rows[0];
      assert.deepEqual(after.state.todos, { preserve: true });
      assert.deepEqual(
        after.state.audit.slice(0, before.state.audit.length),
        before.state.audit,
      );
      assert.deepEqual(
        after.state.audit
          .slice(-2)
          .map((a: any) => a.id)
          .sort(),
        ["audit-1", "audit-2"],
      );
      assert.equal(Number(after.revision), Number(before.revision) + 2);
      assert.equal(
        (
          await f.store.pool.query(
            "SELECT count(*)::int AS n FROM harness_run_events WHERE tenant_id=$1",
            [f.actor.tenantId],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await f.close();
    }
  },
);
