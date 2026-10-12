import test from "node:test";
import assert from "node:assert/strict";
import {
  Sandbox,
  Volume,
  Config,
  ApiError,
  type CreateOptions,
} from "@cubesandbox/sdk";
import { MemoryStore } from "../src/store.js";
import { HarnessService } from "../src/service.js";
import { AgentConfig, Fault, type Actor, type Skill } from "../src/domain.js";
import {
  DemoSandbox,
  CubeProvider,
  SandboxManager,
} from "../src/adapters/sandbox.js";
import {
  SandboxPolicySchema,
  type SandboxPolicy,
} from "../src/adapters/sandbox-policy.js";
import { buildAPI } from "../src/api.js";
import { Worker } from "../src/worker.js";
import { MCPManager } from "../src/adapters/mcp.js";

const alice: Actor = { tenantId: "one", userId: "alice", admin: true };
const bob: Actor = { tenantId: "one", userId: "bob", admin: false };
async function fixture(policy: Partial<SandboxPolicy> = {}) {
  const store = new MemoryStore(),
    provider = new DemoSandbox();
  const service = new HarnessService(store, [], ["default"]);
  const sandbox = new SandboxManager(store, provider, policy);
  const agent = await service.publish(
    alice,
    AgentConfig.parse({
      name: "test",
      systemPrompt: "test",
      model: { provider: "demo", modelId: "demo" },
      tools: [],
      skillBundle: "default",
    }),
  );
  const make = (actor = alice) => service.createWorkspace(actor, "workspace");
  const seed = async (wid: string, actor = alice) =>
    sandbox.execute(actor, wid, "seed-" + wid, "default", "write", {
      path: "file.txt",
      content: "persistent",
    });
  return { store, provider, service, sandbox, agent, make, seed };
}

for (const denial of ["READ_ONLY", "AGENT_REVOKED"] as const)
  for (const existing of ["fresh", "active", "paused"] as const)
    test(`${denial} immediately after reserve restores ${existing} capacity without remote side effects`, async () => {
      const f = await fixture({ maxActivePerUser: 1 });
      const w = await f.make();
      if (existing !== "fresh") await f.seed(w.id);
      if (existing === "paused") await f.sandbox.pause(alice, w.id);
      const before = await f.sandbox.capacity.get("one", w.id);
      const oldWorkspace = await f.store.read(
        "one",
        (s) => s.workspaces[w.id]!,
      );
      const reserve = f.sandbox.capacity.reserve.bind(f.sandbox.capacity);
      let reservations = 0,
        commands = 0,
        calls = 0;
      f.sandbox.capacity.reserve = async (...args) => {
        await reserve(...args);
        reservations++;
        await f.store.tx("one", (s) => {
          if (denial === "READ_ONLY")
            s.workspaces[w.id]!.members.alice = "viewer";
          else s.agents[f.agent.id]!.enabled = false;
        });
      };
      // Any provider action before rollback would invalidate this safe path.
      const createVolume = f.provider.createVolume.bind(f.provider),
        create = f.provider.create.bind(f.provider);
      const connect = f.provider.connect.bind(f.provider),
        kill = f.provider.kill.bind(f.provider);
      f.provider.createVolume = async (...args) => {
        calls++;
        return createVolume(...args);
      };
      f.provider.create = async (...args) => {
        calls++;
        return create(...args);
      };
      f.provider.connect = async (...args) => {
        calls++;
        return connect(...args);
      };
      f.provider.kill = async (...args) => {
        calls++;
        return kill(...args);
      };
      f.provider.execute = async () => {
        commands++;
        return {};
      };
      await assert.rejects(
        f.sandbox.execute(
          alice,
          w.id,
          "denied",
          "default",
          "write",
          {},
          undefined,
          [],
          (s) => {
            if (!s.agents[f.agent.id]!.enabled)
              throw new Fault(403, "AGENT_REVOKED");
          },
        ),
        { code: denial },
      );
      assert.equal(reservations, 1);
      assert.equal(calls, 0);
      assert.equal(commands, 0);
      const current = await f.sandbox.capacity.get("one", w.id);
      if (existing === "fresh") {
        assert.equal(current, undefined);
        assert.equal((await f.sandbox.capacity.usage(alice)).user.active, 0);
      } else {
        assert.equal(current?.state, before!.state);
        assert.equal(current?.sandboxId, before!.sandboxId);
        assert.notEqual(current?.operation, before!.operation);
        assert.equal(f.provider.boxes.has(before!.sandboxId!), true);
        assert.equal(
          f.provider.paused.has(before!.sandboxId!),
          existing === "paused",
        );
        assert.equal(
          (await f.sandbox.capacity.usage(alice)).user.active,
          existing === "paused" ? 0 : 1,
        );
      }
      const after = await f.store.read("one", (s) => s.workspaces[w.id]!);
      assert.equal(after.lock, undefined);
      assert.equal(after.sandboxState, oldWorkspace.sandboxState);
      f.sandbox.capacity.reserve = reserve;
      await f.store.tx("one", (s) => {
        s.workspaces[w.id]!.members.alice = "owner";
        s.agents[f.agent.id]!.enabled = true;
      });
      await f.sandbox.execute(alice, w.id, "retry", "default", "ls", {});
      assert.equal(commands, 1);
      assert.equal(
        (await f.sandbox.capacity.get("one", w.id))?.state,
        "active",
      );
    });

test("reservation rollback cannot overwrite a successor generation", async () => {
  const f = await fixture();
  const w = await f.make();
  await f.sandbox.capacity.reserve("one", w, "old", undefined);
  await f.sandbox.capacity.released("one", w.id, "old");
  await f.sandbox.capacity.reserve(
    "one",
    w,
    "successor",
    await f.sandbox.capacity.inspect("one", w.id),
  );
  const current = await f.sandbox.capacity.inspect("one", w.id);
  assert.equal(
    await f.sandbox.capacity.rollbackReservation("one", w.id, "old", undefined),
    false,
  );
  assert.deepEqual(await f.sandbox.capacity.inspect("one", w.id), current);
});

for (const [stage, killFails] of [
  ["volume", false],
  ["create", false],
  ["create", true],
] as const)
  test(`Agent revoked after confirmed ${stage} ${killFails ? "retains uncertain cleanup" : "releases unused capacity"}`, async () => {
    const f = await fixture({ maxActivePerUser: 1 });
    const w = await f.make();
    const revoke = () =>
      f.store.tx("one", (s) => {
        s.agents[f.agent.id]!.enabled = false;
      });
    const createVolume = f.provider.createVolume.bind(f.provider),
      create = f.provider.create.bind(f.provider);
    const kill = f.provider.kill.bind(f.provider);
    let commands = 0,
      creations = 0;
    f.provider.createVolume = async (...args) => {
      const result = await createVolume(...args);
      if (stage === "volume") await revoke();
      return result;
    };
    f.provider.create = async (...args) => {
      creations++;
      const result = await create(...args);
      if (stage === "create") await revoke();
      return result;
    };
    f.provider.execute = async () => {
      commands++;
      return {};
    };
    if (killFails)
      f.provider.kill = async () => {
        throw new Error("kill unconfirmed");
      };
    await assert.rejects(
      f.sandbox.execute(
        alice,
        w.id,
        "revoked",
        "default",
        "ls",
        {},
        undefined,
        [],
        (s) => {
          if (!s.agents[f.agent.id]!.enabled)
            throw new Fault(403, "AGENT_REVOKED");
        },
      ),
      { code: killFails ? "REMOTE_CANCEL_UNCONFIRMED" : "AGENT_REVOKED" },
    );
    assert.equal(commands, 0);
    assert.equal(creations, stage === "create" ? 1 : 0);
    assert.equal(f.provider.boxes.size, killFails ? 1 : 0);
    assert.equal(
      (await f.sandbox.capacity.usage(alice)).user.active,
      killFails ? 1 : 0,
    );
    const current = await f.sandbox.capacity.get("one", w.id);
    if (killFails) {
      assert.equal(current?.state, "unknown");
      assert.ok(current?.sandboxId);
      // Simulate confirmed operator cleanup before trying again.
      await kill(current!.sandboxId!);
      await f.sandbox.capacity.released("one", w.id, current!.operation!);
    } else assert.equal(current, undefined);
    f.provider.createVolume = createVolume;
    f.provider.create = create;
    f.provider.kill = kill;
    await f.store.tx("one", (s) => {
      s.agents[f.agent.id]!.enabled = true;
    });
    await f.sandbox.execute(alice, w.id, "retry", "default", "ls", {});
    assert.equal(commands, 1);
  });

test("user quota is charged to workspace owner even when a collaborator triggers creation", async () => {
  const f = await fixture({ maxActivePerUser: 1, maxActiveTotal: 2 });
  const w = await f.make(),
    second = await f.make(),
    ownBob = await f.make(bob);
  await f.seed(w.id);
  await f.store.tx("one", (s) => {
    s.workspaces[second.id]!.members.bob = "editor";
  });
  await assert.rejects(f.seed(second.id, bob), { code: "USER_SANDBOX_LIMIT" });
  await f.seed(ownBob.id, bob);
  assert.equal((await f.sandbox.capacity.usage(alice)).global.active, 2);
  assert.equal(f.provider.boxes.size, 2);
});

test("independent managers race across tenants without exceeding global reservation limit", async () => {
  const f = await fixture({ maxActivePerUser: 20, maxActiveTotal: 2 });
  const managers = Array.from(
    { length: 8 },
    () =>
      new SandboxManager(f.store, f.provider, {
        maxActivePerUser: 20,
        maxActiveTotal: 2,
      }),
  );
  const actors = managers.map((_, i) => ({
    tenantId: "tenant-" + i,
    userId: "user",
    admin: true,
  }));
  const workspaces = await Promise.all(actors.map((a) => f.make(a)));
  const results = await Promise.allSettled(
    managers.map((m, i) =>
      m.execute(actors[i]!, workspaces[i]!.id, "op-" + i, "default", "write", {
        path: "file",
        content: "test",
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  for (const r of results.filter((r) => r.status === "rejected"))
    assert.equal(r.reason.code, "GLOBAL_SANDBOX_LIMIT");
  assert.equal(f.provider.boxes.size, 2);
  assert.equal((await f.sandbox.capacity.usage(alice)).global.active, 2);
});

test("pause frees capacity, resume checks quota before auto-resume, release retains workspace files", async () => {
  const f = await fixture({ maxActivePerUser: 1 });
  const w = await f.make(),
    other = await f.make();
  await f.seed(w.id);
  const sid = (await f.sandbox.status(alice, w.id)).sandboxId!;
  await f.sandbox.pause(alice, w.id);
  assert.equal((await f.sandbox.status(alice, w.id)).state, "paused");
  assert.equal((await f.sandbox.capacity.usage(alice)).user.active, 0);
  await f.seed(other.id);
  await assert.rejects(f.sandbox.resume(alice, w.id), {
    code: "USER_SANDBOX_LIMIT",
  });
  assert.ok(f.provider.paused.has(sid));
  await f.sandbox.release(alice, other.id);
  await f.sandbox.resume(alice, w.id);
  assert.equal((await f.sandbox.status(alice, w.id)).state, "active");
  await f.sandbox.release(alice, w.id);
  assert.equal((await f.sandbox.status(alice, w.id)).state, "released");
  assert.deepEqual(
    await f.sandbox.execute(alice, w.id, "read", "default", "read", {
      path: "file.txt",
    }),
    { text: "persistent" },
  );
});

test("idle reaper pauses and later releases, skips queued runs and held tool leases", async () => {
  const f = await fixture({
    maxActivePerUser: 10,
    idlePauseSeconds: 10,
    idleReleaseSeconds: 20,
  });
  const idle = await f.make(),
    queued = await f.make(),
    held = await f.make();
  for (const w of [idle, queued, held]) await f.seed(w.id);
  const ses = await f.service.createSession(alice, queued.id, f.agent.id);
  await f.service.submit(alice, ses.id, "queued");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (entered = r));
  const lease = f.sandbox.withLease(
    alice,
    held.id,
    "hold",
    "default",
    async () => {
      entered();
      await gate;
    },
  );
  await ready;
  const now = Date.now();
  await f.store.tx("one", (s) => {
    for (const w of [idle, queued, held])
      s.workspaces[w.id]!.sandboxLastUsedAt = now - 11000;
  });
  try {
    assert.deepEqual(await f.sandbox.reapIdle(now), {
      paused: 1,
      released: 0,
      failed: 0,
    });
    assert.equal((await f.sandbox.status(alice, idle.id)).state, "paused");
    assert.equal((await f.sandbox.status(alice, queued.id)).state, "active");
    assert.deepEqual(await f.sandbox.reapIdle(now + 10000), {
      paused: 0,
      released: 1,
      failed: 0,
    });
    assert.equal((await f.sandbox.status(alice, idle.id)).state, "released");
    assert.ok(f.provider.volumes.size === 3);
  } finally {
    release();
    await lease;
  }
});

test("unconfirmed kill keeps quota charged and known instance can be released after recovery", async () => {
  const f = await fixture({ maxActivePerUser: 1 });
  const w = await f.make(),
    other = await f.make();
  await f.seed(w.id);
  const kill = f.provider.kill.bind(f.provider);
  f.provider.kill = async () => {
    throw new Error("network failure");
  };
  await assert.rejects(f.sandbox.release(alice, w.id), /network failure/);
  assert.equal((await f.sandbox.status(alice, w.id)).state, "unknown");
  assert.equal((await f.sandbox.capacity.usage(alice)).user.active, 1);
  await assert.rejects(f.seed(other.id), { code: "USER_SANDBOX_LIMIT" });
  f.provider.kill = kill;
  await f.sandbox.release(alice, w.id);
  await f.seed(other.id);
});

test("lost create response holds reservation and is never blindly expired or retried", async () => {
  const f = await fixture({ maxActivePerUser: 1 });
  const w = await f.make(),
    other = await f.make();
  const create = f.provider.create.bind(f.provider);
  f.provider.create = async (...args) => {
    await create(...args);
    throw new Error("response lost");
  };
  await assert.rejects(f.seed(w.id), /response lost/);
  assert.equal(f.provider.boxes.size, 1);
  await assert.rejects(f.seed(w.id), { code: "SANDBOX_OUTCOME_UNKNOWN" });
  await assert.rejects(f.seed(other.id), { code: "USER_SANDBOX_LIMIT" });
  await assert.rejects(f.sandbox.release(alice, w.id), {
    code: "SANDBOX_OUTCOME_UNKNOWN",
  });
  const usage = await f.sandbox.capacity.usage(alice);
  assert.equal(usage.user.active, 1);
  assert.equal(usage.uncertain!.length, 1);
});

test("snapshot create/list/restore/clone/delete preserve authorization and never share workspace volume", async () => {
  const f = await fixture({ maxActivePerUser: 4 });
  const w = await f.make();
  await f.seed(w.id);
  const old = await f.store.tx("one", (s) => s.workspaces[w.id]!);
  const snapshot = await f.sandbox.createSnapshot(alice, w.id, "checkpoint");
  assert.equal(
    (await f.sandbox.listSnapshots(alice, w.id)).items[0]!.id,
    snapshot.id,
  );
  await f.sandbox.release(alice, w.id);
  await f.sandbox.restoreSnapshot(alice, w.id, snapshot.id);
  const restored = await f.store.tx("one", (s) => s.workspaces[w.id]!);
  assert.notEqual(restored.sandboxId, old.sandboxId);
  assert.equal(restored.volumeId, old.volumeId);
  assert.deepEqual(
    await f.sandbox.execute(alice, w.id, "read", "default", "read", {
      path: "file.txt",
    }),
    { text: "persistent" },
  );
  const clone = await f.sandbox.cloneSnapshot(
    alice,
    w.id,
    snapshot.id,
    "clone",
  );
  const cloned = await f.store.tx(
    "one",
    (s) => s.workspaces[clone.workspaceId]!,
  );
  assert.notEqual(cloned.volumeId, restored.volumeId);
  assert.equal(cloned.ownerId, alice.userId);
  assert.deepEqual(cloned.sandboxSkills, snapshot.skills);
  await assert.rejects(
    f.sandbox.execute(alice, cloned.id, "read", "default", "read", {
      path: "file.txt",
    }),
    { code: "FILE_NOT_FOUND" },
  );
  await f.sandbox.deleteSnapshot(alice, w.id, snapshot.id);
  assert.equal(f.provider.snapshots.size, 0);
  await assert.rejects(f.sandbox.restoreSnapshot(alice, w.id, snapshot.id), {
    code: "SNAPSHOT_NOT_FOUND",
  });
});

test("snapshot restore rejects revoked skills, changed deployment scope and missing tenant grants before killing existing instance", async () => {
  const f = await fixture();
  const sk: Skill = {
    id: "a@v1",
    name: "a",
    description: "a",
    bundle: "default",
    path: "/skills/a/SKILL.md",
    digest: "a".repeat(64),
    enabled: true,
  };
  await f.store.tx("one", (s) => {
    s.skills[sk.id] = sk;
  });
  const w = await f.make();
  await f.sandbox.execute(
    alice,
    w.id,
    "seed",
    "default",
    "write",
    { path: "file", content: "test" },
    undefined,
    [sk.id],
  );
  const snapshot = await f.sandbox.createSnapshot(alice, w.id);
  const oldId = (await f.sandbox.status(alice, w.id)).sandboxId!;
  await f.store.tx("one", (s) => {
    s.skills[sk.id]!.enabled = false;
  });
  await assert.rejects(f.sandbox.restoreSnapshot(alice, w.id, snapshot.id), {
    code: "SKILL_DENIED",
  });
  assert.ok(f.provider.boxes.has(oldId));
  await f.store.tx("one", (s) => {
    s.skills[sk.id]!.enabled = true;
  });
  const original = f.provider.scope.bind(f.provider);
  f.provider.scope = (...args) => original(...args) + "changed";
  await assert.rejects(f.sandbox.restoreSnapshot(alice, w.id, snapshot.id), {
    code: "SNAPSHOT_SKILL_SCOPE_MISMATCH",
  });
  f.provider.scope = original;
  const denied = new SandboxManager(f.store, f.provider, {}, () => false);
  await assert.rejects(denied.restoreSnapshot(alice, w.id, snapshot.id), {
    code: "BUNDLE_NOT_GRANTED",
  });
  assert.ok(f.provider.boxes.has(oldId));
});

test("snapshot limits and clone quotas are enforced; workspace deletion cleans snapshots", async () => {
  const f = await fixture({ maxSnapshotsPerWorkspace: 1, maxActivePerUser: 1 });
  const w = await f.make();
  await f.seed(w.id);
  const snapshot = await f.sandbox.createSnapshot(alice, w.id);
  await assert.rejects(f.sandbox.createSnapshot(alice, w.id), {
    code: "SNAPSHOT_LIMIT",
  });
  await assert.rejects(
    f.sandbox.cloneSnapshot(alice, w.id, snapshot.id, "blocked"),
    { code: "USER_SANDBOX_LIMIT" },
  );
  assert.equal(
    (await f.store.tx("one", (s) => Object.values(s.workspaces))).length,
    1,
  );
  await f.sandbox.destroy(alice, w.id);
  assert.equal(f.provider.boxes.size, 0);
  assert.equal(f.provider.snapshots.size, 0);
  assert.equal(f.provider.volumes.size, 0);
  assert.equal((await f.sandbox.capacity.usage(alice)).global.active, 0);
});

test("lifecycle API hides other tenants, rejects viewers and arbitrary snapshot IDs, returns capacity policy", async () => {
  const f = await fixture();
  const w = await f.make();
  await f.seed(w.id);
  const outsider = { tenantId: "two", userId: "alice", admin: true };
  const app = buildAPI(
    f.service,
    async (h) =>
      h === "Bearer bob" ? bob : h === "Bearer outsider" ? outsider : alice,
    f.sandbox,
  );
  const request = (
    method: string,
    url: string,
    body?: unknown,
    token = "alice",
  ) =>
    app.inject({
      method: method as "GET",
      url,
      payload: body,
      headers: { authorization: `Bearer ${token}` },
    });
  try {
    await f.store.tx("one", (s) => {
      s.workspaces[w.id]!.members.bob = "viewer";
    });
    assert.equal(
      (
        await request(
          "GET",
          `/api/v1/workspaces/${w.id}/files/${Buffer.from("file.txt").toString("base64url")}`,
          undefined,
          "bob",
        )
      ).statusCode,
      200,
    );
    const base = `/api/v1/workspaces/${w.id}/sandbox`;
    assert.equal(
      (await request("POST", base + "/pause", undefined, "bob")).statusCode,
      403,
    );
    assert.equal(
      (await request("GET", base, undefined, "outsider")).statusCode,
      404,
    );
    assert.equal(
      (await request("POST", base + "/snapshots", { snapshotId: "arbitrary" }))
        .statusCode,
      400,
    );
    const snap = await request("POST", base + "/snapshots", { name: "api" });
    assert.equal(snap.statusCode, 201);
    assert.equal(
      (await request("POST", base + "/snapshots/arbitrary/restore")).statusCode,
      404,
    );
    assert.equal(
      (
        await request(
          "DELETE",
          base + "/snapshots/" + snap.json().id,
          undefined,
          "bob",
        )
      ).statusCode,
      403,
    );
    const quota = await request(
      "GET",
      "/api/v1/sandbox-capacity",
      undefined,
      "bob",
    );
    assert.equal(quota.json().policy.maxActivePerUser, 3);
    assert.equal(quota.json().uncertain, undefined);
    assert.equal((await request("DELETE", base)).statusCode, 204);
    assert.equal((await request("POST", base + "/resume")).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("Cube snapshot restore uses snapshot mounts, and pause/kill never auto-resume", async (t) => {
  let connections = 0;
  t.mock.method(Sandbox, "connect", async () => {
    connections++;
    throw new Error("must not auto resume");
  });
  t.mock.method(Sandbox.prototype, "kill", async () => {});
  t.mock.method(Sandbox.prototype, "pause", async () => {});
  t.mock.method(Sandbox.prototype, "createSnapshot", async () => ({
    snapshotId: "snapshot-id",
  }));
  t.mock.method(Sandbox, "deleteSnapshot", async () => {});
  t.mock.method(
    Volume,
    "connect",
    async (name: string) => ({ volumeId: name }) as Volume,
  );
  let options: CreateOptions | undefined;
  t.mock.method(Sandbox, "create", async (o: CreateOptions) => {
    options = o;
    return new Sandbox({ sandboxID: "restored" }, new Config());
  });
  const p = new CubeProvider({}, "sandbox", "nfs");
  await p.pause("paused");
  await p.kill("paused");
  assert.equal(await p.snapshot("active"), "snapshot-id");
  await p.deleteSnapshot("snapshot-id");
  await p.create("workspace", "default", [], "snapshot-id");
  assert.equal(connections, 0);
  assert.equal(options!.templateId, "snapshot-id");
  assert.equal(options!.volumeMounts, undefined);
  assert.equal(options!.network!.allowPublicTraffic, false);
});

test("policy rejects invalid quotas and release-before-pause intervals", () => {
  assert.throws(() => SandboxPolicySchema.parse({ maxActivePerUser: 0 }));
  assert.throws(() =>
    SandboxPolicySchema.parse({
      idlePauseSeconds: 100,
      idleReleaseSeconds: 50,
    }),
  );
});
test("partial workspace deletion records confirmed cleanup and permits safe retry", async () => {
  const f = await fixture();
  const w = await f.make();
  await f.seed(w.id);
  const first = await f.sandbox.createSnapshot(alice, w.id, "first"),
    second = await f.sandbox.createSnapshot(alice, w.id, "second");
  const deleteSnapshot = f.provider.deleteSnapshot.bind(f.provider);
  f.provider.deleteSnapshot = async (id) => {
    if (id === second.id) throw new Error("temporary snapshot failure");
    await deleteSnapshot(id);
  };
  await assert.rejects(
    f.sandbox.destroy(alice, w.id),
    /temporary snapshot failure/,
  );
  const state = await f.store.tx("one", (s) => s.workspaces[w.id]!);
  assert.equal(state.sandboxId, undefined);
  assert.equal(state.deleting, false);
  assert.equal(state.sandboxSnapshots![first.id], undefined);
  assert.ok(state.sandboxSnapshots![second.id]);
  assert.equal((await f.sandbox.capacity.usage(alice)).global.active, 0);
  f.provider.deleteSnapshot = deleteSnapshot;
  await f.sandbox.destroy(alice, w.id);
  assert.equal(f.provider.snapshots.size, 0);
  assert.equal(f.provider.volumes.size, 0);
});
test("worker loop waits for in-flight idle maintenance before database shutdown", async () => {
  const f = await fixture();
  let unblock!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (unblock = r)),
    ready = new Promise<void>((r) => (entered = r));
  f.sandbox.sweepIfDue = async () => {
    entered();
    await gate;
    return undefined;
  };
  const worker = new Worker(
    f.service,
    { execute: async () => {} },
    f.sandbox,
    new MCPManager(f.store, {}),
  );
  const loop = worker.start();
  await ready;
  const stopping = worker.stop();
  let finished = false;
  void loop.then(() => {
    finished = true;
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(finished, false);
  } finally {
    unblock();
    await Promise.all([loop, stopping]);
  }
});

for (const lateKillFails of [false, true])
  test(`expired file request cannot ${lateKillFails ? "mark unknown" : "release"} successor capacity`, async () => {
    const f = await fixture();
    const w = await f.make();
    await f.service.createSession(alice, w.id, f.agent.id);
    await f.seed(w.id);
    const agent = (await f.sandbox.status(alice, w.id)).sandboxId;
    let enteredA!: () => void,
      enteredB!: () => void,
      releaseA!: () => void,
      releaseB!: () => void;
    const startedA = new Promise<void>((r) => {
        enteredA = r;
      }),
      startedB = new Promise<void>((r) => {
        enteredB = r;
      });
    const gateA = new Promise<void>((r) => {
        releaseA = r;
      }),
      gateB = new Promise<void>((r) => {
        releaseB = r;
      });
    const execute = f.provider.execute.bind(f.provider),
      kill = f.provider.kill.bind(f.provider);
    let oldSid: string | undefined,
      files = 0,
      rejectOldKill = false;
    f.provider.execute = async (sid, op, args) => {
      if (sid !== agent) {
        if (++files === 1) {
          oldSid = sid;
          enteredA();
          await gateA;
          return { text: "old" };
        }
        enteredB();
        await gateB;
      }
      return execute(sid, op, args);
    };
    f.provider.kill = async (sid) => {
      if (rejectOldKill && sid === oldSid) throw Error("late old Kill unknown");
      return kill(sid);
    };
    const a = f.sandbox.executeFile(alice, w.id, "A", "read", {
      path: "file.txt",
    });
    const checkedA = assert.rejects(a, {
      code: lateKillFails ? "FILE_SANDBOX_CLEANUP_UNCONFIRMED" : "LEASE_LOST",
    });
    let b: Promise<unknown> | undefined;
    try {
      await startedA;
      await f.store.tx("one", (s) => {
        s.workspaces[w.id]!.fileLock!.expires = 0;
      });
      b = f.sandbox.executeFile(alice, w.id, "B", "read", { path: "file.txt" });
      await startedB;
      const before = await f.sandbox.capacity.get("one", w.id + ":files");
      assert.equal(before!.state, "active");
      assert.notEqual(before!.sandboxId, oldSid);
      rejectOldKill = lateKillFails;
      releaseA();
      await checkedA;
      assert.deepEqual(
        await f.sandbox.capacity.get("one", w.id + ":files"),
        before,
      );
      assert.equal((await f.sandbox.capacity.usage(alice)).user.active, 2);
      assert.equal(f.provider.boxes.has(before!.sandboxId!), true);
    } finally {
      releaseA();
      releaseB();
      await checkedA;
      if (b) await b;
    }
    assert.equal((await f.sandbox.capacity.usage(alice)).user.active, 1);
  });

for (const stage of ["before", "create", "connect", "activation"] as const)
  test(`cancellation at ${stage} cleans known instances without running commands`, async () => {
    const f = await fixture();
    const w = await f.make();
    const controller = new AbortController();
    let commands = 0,
      creations = 0;
    const create = f.provider.create.bind(f.provider),
      connect = f.provider.connect.bind(f.provider);
    if (stage === "connect") await f.seed(w.id);
    f.provider.execute = async () => {
      commands++;
      return {};
    };
    f.provider.create = async (...args) => {
      creations++;
      const sid = await create(...args);
      if (stage === "create") controller.abort();
      return sid;
    };
    f.provider.connect = async (sid) => {
      await connect(sid);
      if (stage === "connect") controller.abort();
    };
    if (stage === "activation") {
      const active = f.sandbox.capacity.active.bind(f.sandbox.capacity);
      f.sandbox.capacity.active = async (...args) => {
        await active(...args);
        controller.abort();
      };
    }
    if (stage === "before") controller.abort();
    await assert.rejects(
      f.sandbox.execute(
        alice,
        w.id,
        "cancel",
        "default",
        "ls",
        {},
        controller.signal,
      ),
      ["create", "connect"].includes(stage)
        ? { code: "REMOTE_CANCEL_UNCONFIRMED" }
        : { name: "AbortError" },
    );
    await until(async () => !(await f.sandbox.capacity.get("one", w.id)));
    assert.equal(commands, 0);
    assert.equal(f.provider.boxes.size, 0);
    assert.equal((await f.sandbox.capacity.usage(alice)).user.active, 0);
    assert.equal((await f.sandbox.status(alice, w.id)).state, "released");
    if (stage === "before") assert.equal(creations, 0);
  });

for (const killFails of [false, true])
  test(`cancellation during blocked create ${killFails ? "retains unknown capacity" : "confirms cleanup"}`, async () => {
    const f = await fixture();
    const w = await f.make();
    let started!: () => void, release!: () => void;
    const begun = new Promise<void>((r) => {
        started = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const create = f.provider.create.bind(f.provider);
    f.provider.create = async (...args) => {
      started();
      await gate;
      return create(...args);
    };
    if (killFails)
      f.provider.kill = async () => {
        throw Error("Kill unknown");
      };
    const controller = new AbortController();
    const execution = f.sandbox.execute(
      alice,
      w.id,
      "cancel",
      "default",
      "ls",
      {},
      controller.signal,
    );
    const checked = assert.rejects(execution, {
      code: "REMOTE_CANCEL_UNCONFIRMED",
    });
    try {
      await begun;
      controller.abort();
      assert.equal(
        (await f.sandbox.capacity.get("one", w.id))!.state,
        "reserved",
      );
      assert.equal((await f.sandbox.capacity.usage(alice)).user.active, 1);
    } finally {
      release();
    }
    await checked;
    await until(async () => {
      const entry = await f.sandbox.capacity.get("one", w.id);
      return killFails
        ? entry?.state === "unknown" && !!entry.sandboxId
        : !entry;
    });
    const entry = await f.sandbox.capacity.get("one", w.id);
    if (killFails) {
      assert.equal(entry!.state, "unknown");
      assert.ok(entry!.sandboxId);
      assert.equal(f.provider.boxes.has(entry!.sandboxId!), true);
      assert.equal((await f.sandbox.capacity.usage(alice)).user.active, 1);
    } else {
      assert.equal(entry, undefined);
      assert.equal(f.provider.boxes.size, 0);
      assert.equal((await f.sandbox.capacity.usage(alice)).user.active, 0);
    }
  });

test("cancelled create with no returned ID keeps an unknown charged reservation", async () => {
  const f = await fixture();
  const w = await f.make();
  const controller = new AbortController();
  f.provider.create = async () => {
    controller.abort();
    throw Error("create outcome unknown");
  };
  await assert.rejects(
    f.sandbox.execute(
      alice,
      w.id,
      "cancel",
      "default",
      "ls",
      {},
      controller.signal,
    ),
    { code: "REMOTE_CANCEL_UNCONFIRMED" },
  );
  const entry = await f.sandbox.capacity.get("one", w.id);
  assert.equal(entry!.state, "unknown");
  assert.equal(entry!.sandboxId, undefined);
  assert.equal((await f.sandbox.capacity.usage(alice)).user.active, 1);
});

test("late Agent cancellation cannot kill a reused instance or clear the successor generation", async () => {
  const f = await fixture();
  const w = await f.make();
  await f.seed(w.id);
  let enteredA!: () => void,
    enteredB!: () => void,
    releaseA!: () => void,
    releaseB!: () => void;
  const startedA = new Promise<void>((r) => {
      enteredA = r;
    }),
    startedB = new Promise<void>((r) => {
      enteredB = r;
    });
  const gateA = new Promise<void>((r) => {
      releaseA = r;
    }),
    gateB = new Promise<void>((r) => {
      releaseB = r;
    });
  const controller = new AbortController();
  const a = f.sandbox.withLease(
    alice,
    w.id,
    "same-run",
    "default",
    async () => {
      enteredA();
      await gateA;
    },
    [],
    controller.signal,
  );
  const checkedA = assert.rejects(a, { code: "CAPACITY_LEASE_LOST" });
  let b: Promise<void> | undefined;
  try {
    await startedA;
    const old = await f.sandbox.capacity.get("one", w.id);
    await f.store.tx("one", (s) => {
      s.workspaces[w.id]!.lock!.expires = 0;
    });
    b = f.sandbox.withLease(alice, w.id, "same-run", "default", async () => {
      enteredB();
      await gateB;
    });
    await startedB;
    const before = await f.sandbox.capacity.get("one", w.id);
    assert.notEqual(before!.operation, old!.operation);
    assert.equal(before!.sandboxId, old!.sandboxId);
    controller.abort();
    releaseA();
    await checkedA;
    assert.deepEqual(await f.sandbox.capacity.get("one", w.id), before);
    assert.equal(f.provider.boxes.has(before!.sandboxId!), true);
    assert.equal((await f.sandbox.status(alice, w.id)).state, "active");
  } finally {
    releaseA();
    releaseB();
    await checkedA;
    if (b) await b;
  }
});

async function until(check: () => Promise<boolean>, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Late cleanup did not settle");
}
