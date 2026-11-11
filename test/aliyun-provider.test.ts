import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  Sandbox,
  CommandExitError,
  SandboxNotFoundError,
  AuthenticationError,
  type SandboxOpts,
} from "e2b";
import {
  AliyunE2BProvider,
  AliyunConfigSchema,
  aliyunConfig,
} from "../src/sandbox/aliyun-provider.js";
import { SandboxCreationError } from "../src/sandbox/provider.js";
import { SandboxManager } from "../src/sandbox/manager.js";
import { MemoryStore } from "../src/storage/store.js";
import { HarnessService } from "../src/domain/service.js";
import { remoteScript } from "../src/sandbox/remote-script.js";
import type { Skill } from "../src/domain/model.js";

const skill: Skill = {
  id: "review@v1",
  name: "review",
  description: "review",
  bundle: "default",
  path: "/skills/review/v1/SKILL.md",
  digest: "a".repeat(64),
  enabled: true,
};
const config = (extra = {}) =>
  AliyunConfigSchema.parse({
    apiKey: "test-only-key",
    apiUrl: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
    domain: "cn-hangzhou.sandbox.aliyuncs.com",
    template: "pi-flow-v1",
    user: "user",
    bucket: "pi-flow-test",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    roleArn: "acs:ram::123456789:role/pi-flow",
    skills: {
      [skill.id]: {
        bundle: skill.bundle,
        path: skill.path,
        bucketPath: "/skills/review/v1",
      },
    },
    ...extra,
  });
const decode = (command: string) =>
  JSON.parse(Buffer.from(command.split("'").at(-2)!, "base64").toString());
const result = (stdout = '{"entries":[]}') => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

test("Aliyun uses secure E2B creation and isolated OSS prefixes with only selected read-only skills", async (t) => {
  const created: SandboxOpts[] = [],
    commands: any[] = [];
  t.mock.method(
    Sandbox,
    "create",
    async (_template: string, opts: SandboxOpts) => {
      assert.equal(_template, "pi-flow-v1");
      created.push(opts);
      return {
        sandboxId: "sb1",
        trafficAccessToken: "traffic",
        commands: {
          run: async (cmd: string, options: unknown) => {
            commands.push({ ...decode(cmd), options });
            return result();
          },
        },
      };
    },
  );
  const p = new AliyunE2BProvider(
    config({
      allowInternetAccess: true,
      network: { denyOut: ["evil.example"] },
    }),
  );
  const v1 = await p.createVolume("ws-one"),
    v2 = await p.createVolume("ws-two");
  assert.equal(
    v1,
    await new AliyunE2BProvider(config()).createVolume("ws-one"),
  );
  assert.notEqual(v1, v2);
  assert.deepEqual(
    await p.create(v1, "default", [skill], undefined, "op-one"),
    { sandboxId: "sb1", trafficToken: "traffic" },
  );
  await p.create(v2, "default", []);
  assert.equal(created[0]!.secure, true);
  assert.deepEqual(created[0]!.network, {
    allowPublicTraffic: false,
    denyOut: ["evil.example"],
    allowOut: ["pi-flow-test.oss-cn-hangzhou.aliyuncs.com"],
  });
  assert.equal(created[0]!.allowInternetAccess, true);
  assert.equal(created[0]!.apiUrl, config().apiUrl);
  assert.equal(created[0]!.validateApiKey, false);
  assert.equal(created[0]!.metadata!.harnessOperation, "op-one");
  assert.equal(created[0]!.metadata!["fc.sandbox.auth.role"], config().roleArn);
  const mounts = created.map(
    (o) => JSON.parse(o.metadata!["fc.sandbox.storage.oss"]!).mountPoints,
  );
  assert.deepEqual(mounts[0], [
    {
      bucketName: config().bucket,
      endpoint: config().endpoint,
      mountDir: "/workspace",
      bucketPath: "/pi-flow/workspaces/ws-one",
      readOnly: false,
    },
    {
      bucketName: config().bucket,
      endpoint: config().endpoint,
      mountDir: "/skills/review/v1",
      bucketPath: "/skills/review/v1",
      readOnly: true,
    },
  ]);
  assert.equal(mounts[1].length, 1);
  assert.equal(mounts[1][0].bucketPath, "/pi-flow/workspaces/ws-two");
  assert.deepEqual(commands[0].args._hostSkillMounts, ["/skills/review/v1"]);
  assert.equal(commands[0].args._requireWorkspaceMount, true);
  assert.equal(commands[0].options.user, "user");
  assert.equal(created[0]!.volumeMounts, undefined);
});

test("Aliyun default-deny includes the exact OSS storage host and rejects explicit domain conflicts", async (t) => {
  const requests: SandboxOpts[] = [];
  t.mock.method(
    Sandbox,
    "create",
    async (_template: string, opts: SandboxOpts) => {
      requests.push(opts);
      return { sandboxId: "box", commands: { run: async () => result() } };
    },
  );
  const p = new AliyunE2BProvider(config());
  await p.create(await p.createVolume("ws-one"), "default", []);
  assert.equal(requests[0]!.allowInternetAccess, false);
  assert.deepEqual(requests[0]!.network, {
    allowPublicTraffic: false,
    allowOut: ["pi-flow-test.oss-cn-hangzhou.aliyuncs.com"],
  });
  const host = "pi-flow-test.oss-cn-hangzhou.aliyuncs.com";
  for (const denied of [
    host,
    "*.aliyuncs.com",
    "*.oss-cn-hangzhou.aliyuncs.com",
  ])
    assert.throws(
      () => config({ network: { denyOut: [denied] } }),
      /explicitly denied/,
    );
  const selected = config({
    network: {
      allowOut: ["api.example.com", host],
      denyOut: ["0.0.0.0/0", host],
    },
  });
  assert.deepEqual(selected.network.allowOut, ["api.example.com", host]);
  assert.deepEqual(selected.network.denyOut, ["0.0.0.0/0", host]);
  assert.deepEqual(
    config({ endpoint: "https://oss-cn-shanghai-internal.aliyuncs.com" })
      .network.allowOut,
    ["pi-flow-test.oss-cn-shanghai-internal.aliyuncs.com"],
  );
  assert.throws(() => config({ endpoint: "https://oss.example.com:8443" }));
});

test("Aliyun allows four Skills and rejects a fifth before any remote creation", async (t) => {
  const skills = Array.from({ length: 5 }, (_, n) => ({
    ...skill,
    id: `skill${n}@v1`,
    path: `/skills/skill${n}/SKILL.md`,
  }));
  const bindings = Object.fromEntries(
    skills.map((s, n) => [
      s.id,
      { bundle: s.bundle, path: s.path, bucketPath: `/published/skill${n}` },
    ]),
  );
  const create = t.mock.method(
    Sandbox,
    "create",
    async (_template: string, opts: SandboxOpts) => {
      assert.equal(
        JSON.parse(opts.metadata!["fc.sandbox.storage.oss"]!).mountPoints
          .length,
        5,
      );
      return { sandboxId: "box", commands: { run: async () => result() } };
    },
  );
  const p = new AliyunE2BProvider(config({ skills: bindings }));
  const volume = await p.createVolume("ws-one");
  await p.create(volume, "default", skills.slice(0, 4));
  assert.throws(() => p.scope("default", skills), {
    code: "ALIYUN_OSS_MOUNT_LIMIT",
  });
  await assert.rejects(
    p.create(volume, "default", skills),
    (e: unknown) =>
      e instanceof SandboxCreationError &&
      e.cleanupConfirmed &&
      e.code === "ALIYUN_OSS_MOUNT_LIMIT",
  );
  assert.equal(create.mock.callCount(), 1);
});

test("Aliyun rejects overlapping manual sources and bounds mount directories and OSS prefixes", async () => {
  const bindings = (a: string, b: string) => ({
    a: { bundle: "default", path: "/skills/a/SKILL.md", bucketPath: a },
    b: { bundle: "default", path: "/skills/b/SKILL.md", bucketPath: b },
  });
  for (const [a, b] of [
    ["/published/a", "/published/a"],
    ["/published", "/published/private"],
    ["/published/private", "/published"],
  ])
    assert.throws(
      () => new AliyunE2BProvider(config({ skills: bindings(a!, b!) })),
      /sources must not overlap/,
    );
  new AliyunE2BProvider(
    config({ skills: bindings("/published/a", "/published/ab") }),
  );
  const path = "/skills/" + "a".repeat(56);
  assert.equal(path.length, 64);
  config({
    skills: {
      a: {
        bundle: "default",
        path: path + "/SKILL.md",
        bucketPath: "/published/a",
      },
    },
  });
  assert.throws(() =>
    config({
      skills: {
        a: {
          bundle: "default",
          path: path + "a/SKILL.md",
          bucketPath: "/published/a",
        },
      },
    }),
  );
  assert.throws(() => config({ skillUploadPrefix: "/" + "a".repeat(63) }));
  assert.throws(() =>
    config({
      skills: {
        a: {
          bundle: "default",
          path: "/skills/a/SKILL.md",
          bucketPath: "/" + "a".repeat(128),
        },
      },
    }),
  );
  const p = new AliyunE2BProvider(
    config({ workspacePrefix: "/" + "w".repeat(125) }),
  );
  await assert.rejects(p.createVolume("ws-one"), {
    code: "ALIYUN_OSS_PATH_TOO_LONG",
  });
});

test("Aliyun rejects unpublished, changed, revoked and host-upload skills before creation", async (t) => {
  const create = t.mock.method(Sandbox, "create", async () => {
    throw Error("must not create");
  });
  const p = new AliyunE2BProvider(config());
  const volume = await p.createVolume("ws-one");
  for (const selected of [
    { ...skill, id: "unknown" },
    { ...skill, path: "/skills/other/SKILL.md" },
    { ...skill, enabled: false },
    { ...skill, hostUpload: { key: "uploads/local" } },
  ]) {
    await assert.rejects(
      p.create(volume, "default", [selected as Skill]),
      (e: unknown) => e instanceof SandboxCreationError && e.cleanupConfirmed,
    );
  }
  await assert.rejects(p.create("cube-volume", "default", []), {
    code: "SANDBOX_STORAGE_PROVIDER_MISMATCH",
  });
  await assert.rejects(p.create(volume, "default", [], "snapshot"), {
    code: "SANDBOX_SNAPSHOT_UNSUPPORTED",
  });
  await assert.rejects(p.createVolume("ws-../other"));
  const moved = new AliyunE2BProvider(
    config({ workspacePrefix: "/different" }),
  );
  await assert.rejects(moved.create(volume, "default", []), {
    code: "SANDBOX_STORAGE_PROVIDER_MISMATCH",
  });
  assert.equal(create.mock.callCount(), 0);
  assert.notEqual(
    p.scope("default", [skill]),
    p.scope("default", [{ ...skill, digest: "b".repeat(64) }]),
  );
  assert.notEqual(p.scope("default", []), moved.scope("default", []));
});

for (const cleanupFails of [false, true])
  test(`Aliyun mount preflight failure preserves cleanup certainty (${cleanupFails})`, async (t) => {
    const error = new CommandExitError({
      exitCode: 1,
      stdout: "",
      stderr: "WORKSPACE_MOUNT_UNCONFIRMED",
      error: "failure",
    });
    t.mock.method(Sandbox, "create", async () => ({
      sandboxId: "broken",
      commands: {
        run: async () => {
          throw error;
        },
      },
    }));
    const kill = t.mock.method(Sandbox, "kill", async () => {
      if (cleanupFails) throw new Error("offline");
      return true;
    });
    const p = new AliyunE2BProvider(config());
    await assert.rejects(
      p.create(await p.createVolume("ws-one"), "default", []),
      (e: unknown) => {
        assert.ok(e instanceof SandboxCreationError);
        assert.equal(e.code, "WORKSPACE_MOUNT_UNCONFIRMED");
        assert.equal(e.sandboxId, "broken");
        assert.equal(e.cleanupConfirmed, !cleanupFails);
        return true;
      },
    );
    assert.equal(kill.mock.callCount(), 1);
  });

test("Aliyun reconnects through envd auth, translates command exits and kills without connect", async (t) => {
  let fail: Error | undefined;
  const commands: any[] = [];
  const connect = t.mock.method(
    Sandbox,
    "connect",
    async (_sid: string, options: any) => {
      assert.equal(options.apiUrl, config().apiUrl);
      if (fail) throw fail;
      return {
        commands: {
          run: async (cmd: string) => {
            commands.push(decode(cmd));
            throw new CommandExitError({
              exitCode: 1,
              stdout: "",
              stderr: "EDIT_CONFLICT",
              error: "failure",
            });
          },
        },
      };
    },
  );
  const p = new AliyunE2BProvider(config());
  await p.connect("box");
  await assert.rejects(
    p.execute("box", "edit", {
      _skillIds: [skill.id],
      _skillManifests: [{ path: skill.path, digest: skill.digest }],
      _hostSkillMounts: ["/attacker"],
      _requireWorkspaceMount: false,
    }),
    { code: "EDIT_CONFLICT" },
  );
  assert.deepEqual(commands[0].args._hostSkillMounts, ["/skills/review/v1"]);
  assert.equal(commands[0].args._requireWorkspaceMount, true);
  await assert.rejects(p.execute("box", "read", { _skillIds: ["unknown"] }), {
    code: "ALIYUN_SKILL_NOT_PUBLISHED",
  });
  fail = new SandboxNotFoundError("gone");
  await assert.rejects(p.connect("box"), { code: "SANDBOX_GONE" });
  fail = new AuthenticationError("denied");
  await assert.rejects(p.connect("box"), AuthenticationError);
  const before = connect.mock.callCount();
  const kill = t.mock.method(
    Sandbox,
    "kill",
    async (_sid: string, options: any) => {
      assert.equal(options.apiUrl, config().apiUrl);
      throw new SandboxNotFoundError("gone");
    },
  );
  await p.kill("box");
  assert.equal(connect.mock.callCount(), before);
  assert.equal(kill.mock.callCount(), 1);
  kill.mock.mockImplementation(async () => {
    throw new AuthenticationError("denied");
  });
  await assert.rejects(p.kill("box"), AuthenticationError);
});

test("Aliyun configuration rejects unsafe storage, root execution and ingress overrides", () => {
  assert.throws(() => new AliyunE2BProvider(config({ user: "root" })));
  for (const workspacePrefix of ["/", "/a/../b", "/a//b", "/a/", "/a b"])
    assert.throws(() => config({ workspacePrefix }));
  assert.throws(() => config({ apiUrl: "http://api.example" }));
  assert.throws(() => config({ network: { allowPublicTraffic: true } }));
  assert.throws(
    () => new AliyunE2BProvider(config({ workspacePrefix: "/skills" })),
  );
  assert.throws(() => aliyunConfig({ ALIYUN_ALLOW_INTERNET_ACCESS: "yes" }));
});

test("Remote tools reject an unmounted workspace before touching files", () => {
  const args = Buffer.from(
    JSON.stringify({ op: "ls", args: { _requireWorkspaceMount: true } }),
  ).toString("base64");
  const script = remoteScript.replace(
    "open('/proc/self/mountinfo')",
    "__import__('io').StringIO('')",
  );
  const r = spawnSync("python3", ["-c", script, args], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /WORKSPACE_MOUNT_UNCONFIRMED/);
});

test("Aliyun unsupported lifecycle calls keep capacity active; idle release remounts the same storage", async (t) => {
  let number = 0;
  const prefixes: string[] = [];
  t.mock.method(
    Sandbox,
    "create",
    async (_template: string, opts: SandboxOpts) => {
      prefixes.push(
        JSON.parse(opts.metadata!["fc.sandbox.storage.oss"]!).mountPoints[0]
          .bucketPath,
      );
      return {
        sandboxId: `box${++number}`,
        commands: { run: async () => result() },
      };
    },
  );
  t.mock.method(Sandbox, "connect", async () => ({
    commands: { run: async () => result() },
  }));
  const kill = t.mock.method(Sandbox, "kill", async () => true);
  const store = new MemoryStore(),
    p = new AliyunE2BProvider(config());
  const service = new HarnessService(store, [], ["default"]);
  const manager = new SandboxManager(store, p, {
    idlePauseSeconds: 1,
    idleReleaseSeconds: 60,
  });
  const actor = { tenantId: "test", userId: "alice", admin: true };
  const w = await service.createWorkspace(actor, "test");
  await manager.execute(actor, w.id, "tool", "default", "ls", {});
  for (const call of [
    () => manager.pause(actor, w.id),
    () => manager.createSnapshot(actor, w.id),
    () => manager.restoreSnapshot(actor, w.id, "snapshot"),
  ])
    await assert.rejects(call(), (e: any) => e.status === 409);
  assert.equal((await manager.status(actor, w.id)).state, "active");
  assert.equal((await manager.capacity.usage(actor)).user.active, 1);
  const now = Date.now();
  await store.tx(actor.tenantId, (s) => {
    s.workspaces[w.id]!.sandboxLastUsedAt = now - 2000;
  });
  assert.deepEqual(await manager.reapIdle(now), {
    paused: 0,
    released: 1,
    failed: 0,
  });
  assert.equal(kill.mock.callCount(), 1);
  assert.equal((await manager.status(actor, w.id)).state, "released");
  assert.equal((await manager.capacity.usage(actor)).user.active, 0);
  await manager.execute(actor, w.id, "next", "default", "ls", {});
  assert.equal(number, 2);
  assert.equal(prefixes[0], prefixes[1]);
});
