import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  Sandbox,
  Volume,
  VolumeMount,
  type CreateOptions,
} from "@cubesandbox/sdk";
import { CubeProvider } from "../src/sandbox/cube-provider.js";
import {
  SkillVolumeSchema,
  validateSkillBindings,
  validateHostSkillSource,
  type SkillVolume,
} from "../src/adapters/skill-mounts.js";
import type { Skill } from "../src/domain.js";

const skill = (name: string): Skill => ({
  id: name + "@v1",
  name,
  description: name,
  bundle: "default",
  path: `/skills/${name}/v1/SKILL.md`,
  digest: "a".repeat(64),
  enabled: true,
});
const a = skill("a"),
  b = skill("b");
function source(t: { after: (fn: () => void) => void }) {
  mkdirSync("work", { recursive: true });
  const root = mkdtempSync(resolve("work/host-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["a", "b"]) {
    mkdirSync(root + "/" + name);
    writeFileSync(root + "/" + name + "/SKILL.md", "skill");
  }
  return root;
}
const decode = (cmd: string) =>
  JSON.parse(Buffer.from(cmd.split("'").at(-2)!, "base64").toString()) as {
    op: string;
    args: Record<string, unknown>;
  };

test("host schema and allowlist reject missing/ambiguous backends and non-canonical paths", (t) => {
  const root = source(t);
  const binding = { bundle: "default", path: a.path, hostPath: root + "/a" };
  for (const value of [
    { ...binding, volume: "v" },
    { bundle: "default", path: a.path },
    ...[
      "relative",
      "/",
      "/data/../etc",
      "/data//a",
      "/data/a/",
      "/data/a\0",
      "/data/./a",
    ].map((hostPath) => ({ ...binding, hostPath })),
    { ...binding, path: "/workspace/SKILL.md" },
  ])
    assert.equal(SkillVolumeSchema.safeParse(value).success, false);
  assert.throws(() => validateSkillBindings({ [a.id]: binding }), {
    code: "SKILL_HOST_PATH_DENIED",
  });
  assert.throws(
    () =>
      validateSkillBindings(
        { [a.id]: { ...binding, hostPath: root + "-sibling/a" } },
        [root],
      ),
    { code: "SKILL_HOST_PATH_DENIED" },
  );
  assert.throws(
    () =>
      validateSkillBindings({ [a.id]: { ...binding, hostPath: root } }, [root]),
    { code: "SKILL_HOST_PATH_DENIED" },
  );
  validateSkillBindings({ [a.id]: binding }, [root]);
  validateSkillBindings(
    {
      [a.id]: binding,
      [b.id]: {
        bundle: "default",
        path: "/skills/a/v1/nested/SKILL.md",
        volume: "v",
      },
    },
    [root],
  );
  assert.throws(
    () =>
      validateSkillBindings(
        { [a.id]: binding, [b.id]: { ...binding, path: b.path } },
        [root],
      ),
    { code: "SKILL_HOST_SOURCE_CONFLICT" },
  );
});

test("host validation rejects missing sources, ancestor symlinks and links to other skill directories", async (t) => {
  const root = source(t);
  const binding = {
    bundle: "default",
    path: a.path,
    hostPath: root + "/missing",
  };
  await assert.rejects(validateHostSkillSource(binding.hostPath), {
    code: "SKILL_HOST_SOURCE_UNSAFE",
  });
  symlinkSync(root + "/a", root + "/alias");
  await assert.rejects(validateHostSkillSource(root + "/alias"), {
    code: "SKILL_HOST_SOURCE_UNSAFE",
  });
  symlinkSync(root + "/b", root + "/a/other");
  await assert.rejects(validateHostSkillSource(root + "/a"), {
    code: "SKILL_HOST_SOURCE_UNSAFE",
  });
});

test("pure host, mixed and empty selections use the SDK metadata contract; restored mounts are inherited and checked", async (t) => {
  const root = source(t),
    options: CreateOptions[] = [],
    connects: string[] = [],
    calls: ReturnType<typeof decode>[] = [];
  const box = {
    sandboxId: "box",
    commands: {
      run: async (cmd: string) => {
        calls.push(decode(cmd));
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    },
  } as unknown as Sandbox;
  t.mock.method(Volume, "connect", async (v: string) => {
    connects.push(v);
    return { volumeId: v } as Volume;
  });
  t.mock.method(Sandbox, "create", async (o: CreateOptions) => {
    options.push(o);
    return box;
  });
  t.mock.method(Sandbox, "connect", async () => box);
  const provider = new CubeProvider(
    {
      [a.id]: { bundle: a.bundle, path: a.path, hostPath: root + "/a" },
      [b.id]: { bundle: b.bundle, path: b.path, volume: "skill-b" },
    },
    "sandbox",
    "nfs",
    [root],
  );
  await provider.create("workspace", "default", [a, b]);
  assert.deepEqual(connects, ["workspace", "skill-b"]);
  assert.deepEqual(JSON.parse(options[0]!.metadata!["host-mount"]!), [
    { hostPath: root + "/a", mountPath: "/skills/a/v1", readOnly: true },
  ]);
  assert.equal(
    (options[0]!.volumeMounts!["/skills/b/v1"] as VolumeMount).readOnly,
    true,
  );
  assert.deepEqual(
    calls[0]!.args._skillManifests,
    [a, b].map((s) => ({ path: s.path, digest: s.digest })),
  );
  await provider.create("workspace", "default", [a]);
  assert.deepEqual(Object.keys(options[1]!.volumeMounts!), ["/workspace"]);
  await provider.create("workspace", "default", []);
  assert.equal(options[2]!.metadata!["host-mount"], undefined);
  assert.equal(calls.length, 2);
  await provider.create("workspace", "default", [a], "snapshot");
  assert.equal(options[3]!.volumeMounts, undefined);
  assert.equal(options[3]!.metadata!["host-mount"], undefined);
  assert.equal(options[3]!.templateId, "snapshot");
  assert.deepEqual(calls[2]!.args._hostSkillMounts, ["/skills/a/v1"]);
  // execute after auto-resume checks mounts again; caller cannot suppress it.
  await provider.execute("box", "ls", {
    _hostSkillMounts: [],
    _skillIds: [a.id],
    _skillManifests: [{ path: a.path, digest: a.digest }],
  });
  assert.deepEqual(calls[3]!.args._hostSkillMounts, ["/skills/a/v1"]);
  await assert.rejects(
    provider.create("workspace", "default", [{ ...a, id: "unknown@v1" }]),
    { code: "SKILL_VOLUME_NOT_REGISTERED" },
  );
});

test("host source/backend/digest changes invalidate scope, while pure volume scope stays compatible", (t) => {
  const root = source(t);
  const bindings: Record<string, SkillVolume> = {
    [a.id]: { bundle: a.bundle, path: a.path, hostPath: root + "/a" },
  };
  const provider = new CubeProvider(bindings, "sandbox", "nfs", [root]);
  const old = provider.scope("default", [a]);
  bindings[a.id] = { bundle: a.bundle, path: a.path, hostPath: root + "/b" };
  assert.notEqual(provider.scope("default", [a]), old);
  assert.notEqual(
    provider.scope("default", [{ ...a, digest: "b".repeat(64) }]),
    old,
  );
  bindings[a.id] = { bundle: a.bundle, path: a.path, volume: "v" };
  assert.notEqual(provider.scope("default", [a]), old);
  assert.equal(
    provider.scope("default", [a]),
    new CubeProvider(bindings, "sandbox", "nfs").scope("default", [a]),
  );
});

test("failed or unsupported host mount and digest preflights kill the new/restored instance before returning it", async (t) => {
  const root = source(t);
  let failure = "SKILL_HOST_MOUNT_UNCONFIRMED",
    killed = 0;
  t.mock.method(
    Volume,
    "connect",
    async () => ({ volumeId: "workspace" }) as Volume,
  );
  t.mock.method(
    Sandbox,
    "create",
    async () =>
      ({
        sandboxId: "bad",
        commands: {
          run: async () => ({ exitCode: 1, stderr: failure, stdout: "" }),
        },
      }) as unknown as Sandbox,
  );
  const provider = new CubeProvider(
    { [a.id]: { bundle: a.bundle, path: a.path, hostPath: root + "/a" } },
    "sandbox",
    "nfs",
    [root],
  );
  t.mock.method(provider, "kill", async () => {
    killed++;
  });
  for (const code of [
    "SKILL_HOST_MOUNT_UNCONFIRMED",
    "SKILL_DIGEST_MISMATCH",
    "SKILL_IDENTITY_UNCONFIRMED",
    "SKILL_HOST_SOURCE_UNSAFE",
  ]) {
    failure = code;
    await assert.rejects(provider.create("workspace", "default", [a]), {
      code,
    });
    await assert.rejects(
      provider.create("workspace", "default", [a], "snapshot"),
      { code },
    );
  }
  assert.equal(killed, 8);
});

test("host scope changes rebuild existing instances and prevent stale snapshot restore", async (t) => {
  const { MemoryStore } = await import("../src/store.js");
  const { HarnessService } = await import("../src/service.js");
  const { SandboxManager } = await import("../src/adapters/sandbox.js");
  const root = source(t),
    store = new MemoryStore();
  const actor = { tenantId: "host", userId: "owner", admin: true };
  await store.tx(actor.tenantId, (s) => {
    s.skills[a.id] = a;
  });
  const service = new HarnessService(store, [], ["default"]);
  const workspace = await service.createWorkspace(actor, "host");
  const bindings: Record<string, SkillVolume> = {
    [a.id]: { bundle: a.bundle, path: a.path, hostPath: root + "/a" },
  };
  const provider = new CubeProvider(bindings, "sandbox", "nfs", [root]);
  let creates = 0;
  const killed: string[] = [];
  t.mock.method(
    Volume,
    "connect",
    async (name: string) => ({ volumeId: name }) as Volume,
  );
  t.mock.method(
    Sandbox,
    "create",
    async () =>
      ({
        sandboxId: `box-${++creates}`,
        trafficAccessToken: "token",
        commands: {
          run: async () => ({ exitCode: 0, stderr: "", stdout: "{}" }),
        },
      }) as unknown as Sandbox,
  );
  t.mock.method(provider, "connect", async () => {});
  t.mock.method(provider, "kill", async (sid: string) => {
    killed.push(sid);
  });
  t.mock.method(provider, "snapshot", async () => "snapshot");
  const manager = new SandboxManager(store, provider);
  const lease = () =>
    manager.withLease(actor, workspace.id, "owner", "default", async () => {}, [
      a.id,
    ]);
  await lease();
  const first = await manager.status(actor, workspace.id);
  const snapshot = await manager.createSnapshot(actor, workspace.id);
  bindings[a.id] = { bundle: a.bundle, path: a.path, hostPath: root + "/b" };
  await assert.rejects(
    manager.restoreSnapshot(actor, workspace.id, snapshot.id),
    { code: "SNAPSHOT_SKILL_SCOPE_MISMATCH" },
  );
  assert.equal(creates, 1);
  await lease();
  const second = await manager.status(actor, workspace.id);
  assert.notEqual(second.sandboxId, first.sandboxId);
  assert.deepEqual(killed, [first.sandboxId]);
  assert.equal(creates, 2);
});

test("vendored SDK sends host-mount string metadata alongside readonly volumeMounts on the wire", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  let payload: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payload = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ sandboxID: "wire-test" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as import("node:net").AddressInfo;
  const host = JSON.stringify([
    {
      hostPath: "/data/agent-skills/a",
      mountPath: "/skills/a/v1",
      readOnly: true,
    },
  ]);
  await Sandbox.create({
    apiUrl: `http://127.0.0.1:${address.port}`,
    templateId: "template",
    metadata: { "host-mount": host },
    volumeMounts: {
      "/workspace": "workspace",
      "/skills/b/v1": new VolumeMount("skill-b", { readOnly: true }),
    },
  });
  assert.deepEqual(payload!.metadata, { "host-mount": host });
  assert.deepEqual(payload!.volumeMounts, [
    { name: "workspace", path: "/workspace" },
    { name: "skill-b", path: "/skills/b/v1", readOnly: true },
  ]);
});

async function lifecycle(t: import("node:test").TestContext, timeout = 30000) {
  const { MemoryStore } = await import("../src/store.js");
  const { HarnessService } = await import("../src/service.js");
  const { SandboxManager } = await import("../src/adapters/sandbox.js");
  const root = source(t),
    store = new MemoryStore();
  const actor = { tenantId: "cleanup", userId: "owner", admin: true };
  await store.tx(actor.tenantId, (s) => {
    s.skills[a.id] = a;
  });
  const workspace = await new HarnessService(
    store,
    [],
    ["default"],
  ).createWorkspace(actor, "host");
  const provider = new CubeProvider(
    { [a.id]: { bundle: a.bundle, path: a.path, hostPath: root + "/a" } },
    "sandbox",
    "nfs",
    [root],
  );
  const behavior = {
    failure: "",
    cleanupFailure: false,
    gate: undefined as Promise<void> | undefined,
  };
  let created = 0;
  const killed: string[] = [];
  t.mock.method(
    Volume,
    "connect",
    async (name: string) => ({ volumeId: name }) as Volume,
  );
  t.mock.method(Sandbox, "create", async () => {
    const failure = behavior.failure,
      gate = behavior.gate;
    return {
      sandboxId: `box-${++created}`,
      trafficAccessToken: "token",
      commands: {
        run: async () => {
          await gate;
          return { exitCode: failure ? 1 : 0, stderr: failure, stdout: "{}" };
        },
      },
    } as unknown as Sandbox;
  });
  t.mock.method(provider, "connect", async () => {});
  t.mock.method(provider, "kill", async (sid: string) => {
    if (behavior.cleanupFailure) throw new Error("kill outcome unknown");
    killed.push(sid);
  });
  t.mock.method(provider, "snapshot", async () => "snapshot");
  const manager = new SandboxManager(
    store,
    provider,
    { maxActivePerUser: 1 },
    undefined,
    { remoteTimeoutMs: timeout, cleanupTimeoutMs: 1000 },
  );
  const run = () =>
    manager.withLease(
      actor,
      workspace.id,
      crypto.randomUUID(),
      "default",
      async () => {},
      [a.id],
    );
  return {
    root,
    store,
    actor,
    workspace,
    provider,
    behavior,
    killed,
    manager,
    run,
  };
}

test("preflight failure with confirmed deletion releases capacity and retry succeeds", async (t) => {
  for (const code of [
    "SKILL_HOST_MOUNT_UNCONFIRMED",
    "SKILL_DIGEST_MISMATCH",
    "SKILL_HOST_SOURCE_UNSAFE",
  ]) {
    await t.test(code, async (t) => {
      const f = await lifecycle(t);
      f.behavior.failure = code;
      await assert.rejects(f.run(), { code });
      assert.deepEqual(f.killed, ["box-1"]);
      assert.equal(
        (await f.manager.capacity.inspect(f.actor.tenantId, f.workspace.id))!
          .state,
        "released",
      );
      assert.equal((await f.manager.capacity.usage(f.actor)).user.active, 0);
      assert.equal(
        (await f.manager.status(f.actor, f.workspace.id)).state,
        "released",
      );
      f.behavior.failure = "";
      await f.run();
      assert.equal((await f.manager.capacity.usage(f.actor)).user.active, 1);
      assert.equal(
        (await f.manager.status(f.actor, f.workspace.id)).sandboxId,
        "box-2",
      );
    });
  }
});

test("unconfirmed preflight deletion retains charged unknown capacity and instance identity for reconciliation", async (t) => {
  const f = await lifecycle(t);
  f.behavior.failure = "SKILL_DIGEST_MISMATCH";
  f.behavior.cleanupFailure = true;
  await assert.rejects(f.run(), { code: "SKILL_DIGEST_MISMATCH" });
  const entry = await f.manager.capacity.inspect(
    f.actor.tenantId,
    f.workspace.id,
  );
  assert.equal(entry!.state, "unknown");
  assert.equal(entry!.sandboxId, "box-1");
  assert.equal((await f.manager.capacity.usage(f.actor)).user.active, 1);
  await assert.rejects(f.run(), { code: "SANDBOX_OUTCOME_UNKNOWN" });
  const audit = await f.store.read(f.actor.tenantId, (s) => s.audit);
  assert.ok(
    audit.some(
      (e) =>
        e.action === "sandbox.creation.cleanup_unconfirmed" &&
        e.result.includes('"sandboxId":"box-1"'),
    ),
  );
});

test("failed snapshot restore with confirmed cleanup releases capacity and permits restore retry", async (t) => {
  const f = await lifecycle(t);
  await f.run();
  const snapshot = await f.manager.createSnapshot(f.actor, f.workspace.id);
  f.behavior.failure = "SKILL_HOST_MOUNT_UNCONFIRMED";
  await assert.rejects(
    f.manager.restoreSnapshot(f.actor, f.workspace.id, snapshot.id),
    { code: f.behavior.failure },
  );
  assert.equal((await f.manager.capacity.usage(f.actor)).user.active, 0);
  f.behavior.failure = "";
  await f.manager.restoreSnapshot(f.actor, f.workspace.id, snapshot.id);
  assert.equal((await f.manager.capacity.usage(f.actor)).user.active, 1);
});

async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("reconciliation did not settle");
}

test("late confirmed preflight cleanup releases timed-out capacity", async (t) => {
  const f = await lifecycle(t, 100);
  let finish!: () => void;
  f.behavior.gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.behavior.failure = "SKILL_DIGEST_MISMATCH";
  await assert.rejects(f.run());
  assert.equal(
    (await f.manager.capacity.inspect(f.actor.tenantId, f.workspace.id))!.state,
    "unknown",
  );
  finish();
  await waitFor(
    async () =>
      (await f.manager.capacity.inspect(f.actor.tenantId, f.workspace.id))!
        .state === "released",
  );
  f.behavior.gate = undefined;
  f.behavior.failure = "";
  await f.run();
  assert.equal((await f.manager.capacity.usage(f.actor)).user.active, 1);
});

test("late cleanup cannot release or clear a successor's instance", async (t) => {
  const f = await lifecycle(t, 100);
  let finish!: () => void;
  f.behavior.gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.behavior.failure = "SKILL_DIGEST_MISMATCH";
  await assert.rejects(f.run());
  const old = (await f.manager.capacity.inspect(
    f.actor.tenantId,
    f.workspace.id,
  ))!;
  await f.manager.capacity.released(
    f.actor.tenantId,
    f.workspace.id,
    old.operation,
  );
  f.behavior.gate = undefined;
  f.behavior.failure = "";
  await f.run();
  finish();
  await waitFor(async () =>
    (await f.store.read(f.actor.tenantId, (s) => s.audit)).some(
      (e) => e.action === "sandbox.creation.cleanup_confirmed",
    ),
  );
  const current = (await f.manager.capacity.inspect(
    f.actor.tenantId,
    f.workspace.id,
  ))!;
  assert.equal(current.state, "active");
  assert.equal(current.sandboxId, "box-2");
  assert.equal(
    (await f.manager.status(f.actor, f.workspace.id)).sandboxId,
    "box-2",
  );
});

test("unselected overlapping Volume targets remain valid and conflicts reject only joint selection", (t) => {
  const bindings = {
    [a.id]: { bundle: a.bundle, path: a.path, volume: "volume-a" },
    [b.id]: { bundle: b.bundle, path: a.path, volume: "volume-b" },
  };
  validateSkillBindings(bindings);
  const provider = new CubeProvider(bindings, "sandbox", "nfs");
  const alias = { ...b, path: a.path };
  provider.scope("default", [a]);
  provider.scope("default", [alias]);
  assert.throws(() => provider.scope("default", [a, alias]), {
    code: "SKILL_MOUNT_CONFLICT",
  });
});

test("asynchronous host source validation allows event-loop work during a scan", async (t) => {
  const root = source(t);
  let done = false;
  const validation = validateHostSkillSource(root + "/a").finally(() => {
    done = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    done,
    false,
    "scan must not synchronously block unrelated event-loop work",
  );
  await validation;
});

test("source validation failure before dispatch releases reservation without creating an instance", async (t) => {
  const { unlinkSync } = await import("node:fs");
  const f = await lifecycle(t);
  symlinkSync(f.root + "/b", f.root + "/a/escape");
  await assert.rejects(f.run(), { code: "SKILL_HOST_SOURCE_UNSAFE" });
  assert.equal((await f.manager.capacity.usage(f.actor)).user.active, 0);
  assert.deepEqual(f.killed, []);
  unlinkSync(f.root + "/a/escape");
  await f.run();
  assert.equal(
    (await f.manager.status(f.actor, f.workspace.id)).sandboxId,
    "box-1",
  );
});

test("late unconfirmed cleanup records the instance ID and keeps capacity charged", async (t) => {
  const f = await lifecycle(t, 100);
  let finish!: () => void;
  f.behavior.gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.behavior.failure = "SKILL_DIGEST_MISMATCH";
  f.behavior.cleanupFailure = true;
  await assert.rejects(f.run());
  finish();
  await waitFor(
    async () =>
      (await f.manager.capacity.inspect(f.actor.tenantId, f.workspace.id))!
        .sandboxId === "box-1",
  );
  assert.equal((await f.manager.capacity.usage(f.actor)).user.active, 1);
  assert.equal(
    (await f.manager.status(f.actor, f.workspace.id)).state,
    "unknown",
  );
});

test("mixed backends with mutually exclusive targets verify only the selected binding", async (t) => {
  const root = source(t),
    calls: ReturnType<typeof decode>[] = [];
  const provider = new CubeProvider(
    {
      [a.id]: { bundle: a.bundle, path: a.path, hostPath: root + "/a" },
      [b.id]: { bundle: b.bundle, path: a.path, volume: "skill-b" },
    },
    "sandbox",
    "nfs",
    [root],
  );
  t.mock.method(
    Sandbox,
    "connect",
    async () =>
      ({
        commands: {
          run: async (cmd: string) => {
            calls.push(decode(cmd));
            return { exitCode: 0, stdout: "{}", stderr: "" };
          },
        },
      }) as unknown as Sandbox,
  );
  const manifest = [{ path: a.path, digest: a.digest }];
  await provider.execute("volume-box", "ls", {
    _skillIds: [b.id],
    _skillManifests: manifest,
  });
  await provider.execute("host-box", "ls", {
    _skillIds: [a.id],
    _skillManifests: manifest,
  });
  assert.deepEqual(calls[0]!.args._hostSkillMounts, []);
  assert.deepEqual(calls[1]!.args._hostSkillMounts, ["/skills/a/v1"]);
});
