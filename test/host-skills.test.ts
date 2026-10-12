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
  assert.throws(
    () =>
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
      ),
    { code: "SKILL_MOUNT_CONFLICT" },
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

test("host validation rejects missing sources, ancestor symlinks and links to other skill directories", (t) => {
  const root = source(t);
  const binding = {
    bundle: "default",
    path: a.path,
    hostPath: root + "/missing",
  };
  assert.throws(() => validateSkillBindings({ [a.id]: binding }, [root]), {
    code: "SKILL_HOST_SOURCE_UNSAFE",
  });
  symlinkSync(root + "/a", root + "/alias");
  assert.throws(
    () =>
      validateSkillBindings(
        { [a.id]: { ...binding, hostPath: root + "/alias" } },
        [root],
      ),
    { code: "SKILL_HOST_SOURCE_UNSAFE" },
  );
  symlinkSync(root + "/b", root + "/a/other");
  assert.throws(
    () =>
      validateSkillBindings({ [a.id]: { ...binding, hostPath: root + "/a" } }, [
        root,
      ]),
    { code: "SKILL_HOST_SOURCE_UNSAFE" },
  );
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
