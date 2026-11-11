import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Sandbox, type SandboxOpts } from "e2b";
import OSS from "ali-oss";
import { Fault, type Skill } from "../src/domain/model.js";
import {
  AliyunConfigSchema,
  AliyunE2BProvider,
} from "../src/sandbox/aliyun-provider.js";
import { SandboxManager } from "../src/sandbox/manager.js";
import { MemoryStore } from "../src/storage/store.js";
import { HarnessService } from "../src/domain/service.js";
import { buildAPI } from "../src/api/server.js";
import { collectionService } from "../src/skills/collection-service.js";
import {
  collectionId,
  collectionPath,
  collectionRoute,
  remoteCollectionResolver,
} from "../src/skills/collection.js";
import {
  OssSkillCollections,
  collectionIO,
  type CollectionIO,
} from "../src/skills/oss-collections.js";
import { OssSkillPackages } from "../src/skills/oss-packages.js";
import { uploadedOssSkillBinding } from "../src/skills/oss-storage.js";
import { skillZip } from "./helpers/skill-zip.js";
import { telemetry } from "../src/observability/telemetry.js";

const hash = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const actor = { tenantId: "tenant", userId: "alice", admin: true };
function fixture(count = 20) {
  const data = new Map<string, { data: Buffer; executable: boolean }>();
  const puts: string[] = [],
    lists: string[] = [],
    removals: string[][] = [];
  const skills: Skill[] = Array.from({ length: count }, (_, i) => ({
    id: `skill${i}@v1`,
    name: `Skill ${i}`,
    description: "test",
    enabled: true,
    bundle: "default",
    path: `/skills/skill${i}/v1/SKILL.md`,
    digest: hash(`manifest-${i}`),
  }));
  const config = AliyunConfigSchema.parse({
    apiKey: "test-only",
    apiUrl: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
    domain: "cn-hangzhou.sandbox.aliyuncs.com",
    template: "test",
    user: "user",
    bucket: "pi-flow-test",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    roleArn: "acs:ram::123456789:role/test",
    skills: Object.fromEntries(
      skills.map((s, i) => [
        s.id,
        { bundle: s.bundle, path: s.path, bucketPath: `/published/skill${i}` },
      ]),
    ),
  });
  for (let i = 0; i < count; i++) {
    data.set(`published/skill${i}/SKILL.md`, {
      data: Buffer.from(`manifest-${i}`),
      executable: false,
    });
    data.set(`published/skill${i}/scripts/run.bin`, {
      data: Buffer.from([i, 0, 255]),
      executable: true,
    });
    if (i === 0)
      data.set("published/skill0/.gitkeep", {
        data: Buffer.alloc(0),
        executable: false,
      });
  }
  data.set("published/unselected/secret.txt", {
    data: Buffer.from("must-not-be-exposed"),
    executable: false,
  });
  const io: CollectionIO = {
    async get(key, limit) {
      const v = data.get(key);
      if (v && v.data.length > limit)
        throw new Fault(413, "SKILL_COLLECTION_LIMIT");
      return v;
    },
    async list(prefix) {
      lists.push(prefix);
      return {
        files: [...data]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, v]) => ({ key, size: v.data.length })),
      };
    },
    async put(key, buffer, executable) {
      if (data.has(key))
        throw Object.assign(new Error("exists"), { status: 409 });
      puts.push(key);
      data.set(key, { data: Buffer.from(buffer), executable });
    },
    async remove(keys) {
      removals.push([...keys]);
      for (const key of keys) data.delete(key);
    },
  };
  const publisher = new OssSkillCollections(config.skillCollectionPrefix, io);
  const provider = new AliyunE2BProvider(config);
  const scope = provider.scope("default", skills);
  const sources = skills.map((skill) => ({
    skill,
    bucketPath: config.skills[skill.id]!.bucketPath,
  }));
  return {
    config,
    skills,
    data,
    io,
    publisher,
    provider,
    scope,
    sources,
    puts,
    lists,
    removals,
  };
}

test("twenty selected Skills share one isolated immutable collection; cache and workspace scopes remain exact", async () => {
  const beforeMetrics = telemetry.snapshot();
  const f = fixture();
  const location = await f.publisher.resolve("volume-one", f.scope, f.sources);
  const root =
    collectionPath(f.config.skillCollectionPrefix, location).slice(1) + "/";
  const copied = [...f.data].filter(([k]) => k.startsWith(root));
  assert.equal(copied.length, 41);
  assert.equal(f.lists.length, 20);
  assert.ok(f.lists.every((p) => !p.includes("unselected")));
  assert.ok(copied.every(([k]) => !k.includes("unselected")));
  assert.deepEqual(f.data.get(root + "skill0/v1/scripts/run.bin"), {
    data: Buffer.from([0, 0, 255]),
    executable: true,
  });
  const before = f.puts.length;
  assert.deepEqual(
    await new OssSkillCollections(f.config.skillCollectionPrefix, f.io).resolve(
      "volume-one",
      f.scope,
      [...f.sources].reverse(),
    ),
    location,
  );
  assert.equal(f.puts.length, before);
  const other = await f.publisher.resolve("volume-two", f.scope, f.sources);
  assert.notEqual(other.selectionId, location.selectionId);
  const subsetScope = f.provider.scope("default", f.skills.slice(0, 1));
  const subset = await f.publisher.resolve(
    "volume-one",
    subsetScope,
    f.sources.slice(0, 1),
  );
  assert.notEqual(subset.selectionId, location.selectionId);
  const subsetRoot =
    collectionPath(f.config.skillCollectionPrefix, subset).slice(1) + "/";
  assert.equal(
    [...f.data.keys()].filter((k) => k.startsWith(subsetRoot)).length,
    3,
  );
  assert.notEqual(
    f.scope,
    f.provider.scope("default", [
      { ...f.skills[0]!, digest: "a".repeat(64) },
      ...f.skills.slice(1),
    ]),
  );
  const metrics = telemetry.snapshot();
  assert.equal(
    (metrics.skill_collections_published_total ?? 0) -
      (beforeMetrics.skill_collections_published_total ?? 0),
    3,
  );
  assert.equal(
    (metrics.skill_collections_cache_hits_total ?? 0) -
      (beforeMetrics.skill_collections_cache_hits_total ?? 0),
    1,
  );
  assert.ok(
    (metrics.skill_collections_published_bytes_total ?? 0) >
      (beforeMetrics.skill_collections_published_bytes_total ?? 0),
  );
});

test("concurrent API publishers commit one ready pointer and delete only the losing private artifact", async () => {
  const f = fixture(2);
  const [a, b] = await Promise.all([
    f.publisher.resolve("volume", f.scope, f.sources),
    new OssSkillCollections(f.config.skillCollectionPrefix, f.io).resolve(
      "volume",
      f.scope,
      f.sources,
    ),
  ]);
  assert.deepEqual(a, b);
  assert.equal(f.removals.length, 1);
  const root = collectionPath(f.config.skillCollectionPrefix, a).slice(1) + "/";
  assert.ok(
    f.removals[0]!.every(
      (k) => !k.startsWith(root) && !k.startsWith("published/"),
    ),
  );
  assert.equal(
    [...f.data.keys()].filter((k) =>
      k.startsWith(f.config.skillCollectionPrefix.slice(1)),
    ).length,
    6,
  );
});

test("ambiguous ready-pointer commit retains the referenced artifact and is recovered on the next request", async () => {
  const f = fixture(1),
    put = f.io.put.bind(f.io);
  f.io.put = async (...args) => {
    await put(...args);
    if (args[0].includes("/ready/")) throw new Error("lost acknowledgement");
  };
  await assert.rejects(f.publisher.resolve("volume", f.scope, f.sources), {
    code: "SKILL_COLLECTION_COMMIT_UNCONFIRMED",
  });
  assert.equal(f.removals.length, 0);
  const location = await f.publisher.resolve("volume", f.scope, f.sources);
  assert.equal(location.selectionId, collectionId("volume", f.scope));
  assert.equal(
    [...f.data.keys()].filter((k) =>
      k.startsWith(
        collectionPath(f.config.skillCollectionPrefix, location).slice(1),
      ),
    ).length,
    3,
  );
});

for (const mode of [
  "bad-manifest",
  "missing-manifest",
  "traversal",
  "oversize",
  "failed-put",
  "repeated-page",
] as const)
  test(`collection publication fails before ready and cleans its private attempt (${mode})`, async () => {
    const f = fixture(1);
    if (mode === "bad-manifest")
      f.data.get("published/skill0/SKILL.md")!.data = Buffer.from("changed");
    if (mode === "missing-manifest") f.data.delete("published/skill0/SKILL.md");
    if (mode === "traversal")
      f.data.set("published/skill0/../escape", {
        data: Buffer.from("escape"),
        executable: false,
      });
    if (mode === "oversize")
      f.io.list = async () => ({
        files: [{ key: "published/skill0/large", size: 9000000 }],
      });
    if (mode === "failed-put")
      f.io.put = async () => {
        throw new Error("SDK secret must not escape");
      };
    if (mode === "repeated-page")
      f.io.list = async () => ({ files: [], cursor: "same-token" });
    await assert.rejects(
      f.publisher.resolve("volume", f.scope, f.sources),
      (e: any) => e instanceof Fault && !e.message.includes("SDK secret"),
    );
    assert.ok(
      [...f.data.keys()].every(
        (k) => !k.startsWith(f.config.skillCollectionPrefix.slice(1)),
      ),
    );
    assert.ok(f.data.has("published/unselected/secret.txt"));
  });

test("uploaded auxiliary content is verified against its version digest before collection publication", async () => {
  const f = fixture(0),
    packages = new OssSkillPackages(f.config, f.io);
  const prepared = await packages.prepare(
    "tenant",
    {
      id: "upload@v1",
      name: "upload",
      bundle: "default",
      description: "upload",
    },
    skillZip([
      { path: "SKILL.md", content: "manifest" },
      { path: "scripts/x.bin", content: Buffer.from([0, 255]), mode: 0o100755 },
    ]),
  );
  const binding = uploadedOssSkillBinding(prepared.skill, f.config)!;
  const sources = [{ skill: prepared.skill, bucketPath: binding.bucketPath }];
  const scope = f.provider.scope("default", [prepared.skill]);
  await f.publisher.resolve("first", scope, sources);
  f.data.get(binding.bucketPath.slice(1) + "/scripts/x.bin")!.data =
    Buffer.from([1, 255]);
  await assert.rejects(f.publisher.resolve("other-workspace", scope, sources), {
    code: "SKILL_COLLECTION_SOURCE_CHANGED",
  });
});

test("Worker resolves a selected collection via API machine auth and a current tenant workspace lease", async (t) => {
  const f = fixture(20),
    store = new MemoryStore(),
    service = new HarnessService(store, [], ["default"]);
  const token = "test-machine-token-with-32-characters";
  const resolve = collectionService(
    store,
    f.config,
    f.publisher,
    (bundle) => bundle === "default",
  );
  const app = buildAPI(
    service,
    async () => {
      throw new Fault(401, "UNAUTHENTICATED");
    },
    new SandboxManager(store, f.provider),
    undefined,
    undefined,
    { token, resolve },
  );
  t.after(async () => {
    await app.close();
    await store.close();
  });
  await store.tx(actor.tenantId, (s) => {
    for (const skill of f.skills) s.skills[skill.id] = skill;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (url: URL | string, options: RequestInit) => {
      const response = await app.inject({
        method: "POST",
        url: new URL(url).pathname,
        headers: options.headers as any,
        payload: options.body as string,
      });
      return new Response(response.body, { status: response.statusCode });
    },
  );
  const calls: SandboxOpts[] = [];
  const run = async () => ({
    stdout: '{"entries":[]}',
    stderr: "",
    exitCode: 0,
  });
  t.mock.method(
    Sandbox,
    "create",
    async (_template: string, options: SandboxOpts) => {
      calls.push(options);
      return { sandboxId: "box", commands: { run } };
    },
  );
  t.mock.method(Sandbox, "connect", async () => ({ commands: { run } }));
  const worker = new SandboxManager(
    store,
    new AliyunE2BProvider(
      f.config,
      remoteCollectionResolver("http://127.0.0.1", token),
    ),
  );
  const w = await service.createWorkspace(actor, "workspace");
  await worker.execute(
    actor,
    w.id,
    "run",
    "default",
    "ls",
    {},
    undefined,
    f.skills.map((s) => s.id),
  );
  const mounts = JSON.parse(
    calls[0]!.metadata!["fc.sandbox.storage.oss"]!,
  ).mountPoints;
  assert.equal(mounts.length, 2);
  assert.equal(mounts[1].mountDir, "/skills");
  assert.equal(mounts[1].readOnly, true);
  assert.ok(!JSON.stringify(calls[0]).includes(token));
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: collectionRoute,
        headers: { authorization: "Bearer wrong" },
        payload: {},
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/v1/admin/skills",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
    401,
  );
  const workspace = await store.read(
    actor.tenantId,
    (s) => s.workspaces[w.id]!,
  );
  const req = {
    volume: workspace.volumeId!,
    bundle: "default",
    scope: f.provider.scope("default", f.skills),
    operation: "new-operation",
    context: { tenantId: actor.tenantId, workspaceId: w.id },
    skills: f.skills.map(({ id, path, digest, versionDigest }) => ({
      id,
      path,
      digest,
      versionDigest,
    })),
  };
  await assert.rejects(resolve(req), {
    code: "SKILL_COLLECTION_LEASE_REQUIRED",
  });
  await store.tx(actor.tenantId, (s) => {
    s.workspaces[w.id]!.lock = {
      owner: "new-operation",
      expires: Date.now() + 60000,
      kind: "agent",
    };
  });
  await assert.rejects(
    resolve({ ...req, context: { ...req.context, tenantId: "other" } }),
    { code: "SKILL_COLLECTION_LEASE_REQUIRED" },
  );
  await assert.rejects(resolve({ ...req, skills: req.skills.slice(0, 1) }), {
    code: "SKILL_COLLECTION_SCOPE_CHANGED",
  });
  assert.ok(await resolve(req));
  await store.tx(actor.tenantId, (s) => {
    s.skills[f.skills[0]!.id]!.enabled = false;
  });
  await assert.rejects(resolve(req), { code: "SKILL_DENIED" });
  assert.throws(() =>
    remoteCollectionResolver("http://untrusted.example", token),
  );
  assert.throws(() =>
    remoteCollectionResolver("https://internal.example", "short"),
  );
});

test("OSS collection transport bounds downloads, rejects link metadata and incomplete pagination", async (t) => {
  const client = new OSS({
    accessKeyId: "test",
    accessKeySecret: "test",
    bucket: "pi-flow-test",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
  });
  const get = t.mock.method(
    client,
    "get",
    async (_key: string, _file: unknown, options: any) => {
      assert.equal(options.headers.Range, "bytes=0-100");
      return {
        content: Buffer.from("data"),
        res: { headers: { "x-oss-meta-mode": String(0o120777) } },
      };
    },
  );
  const io = collectionIO(client);
  await assert.rejects(io.get("object", 100, 20000), {
    code: "SKILL_COLLECTION_UNSAFE_SOURCE",
  });
  get.mock.mockImplementation(async () => {
    throw Object.assign(new Error("missing"), { status: 404 });
  });
  assert.equal(await io.get("missing", 100, 20000), undefined);
  t.mock.method(client, "head", async () => ({
    res: {
      headers: { "content-length": "0", "x-oss-meta-mode": String(0o100444) },
    },
  }));
  assert.deepEqual(await io.get("empty", 0, 20000), {
    data: Buffer.alloc(0),
    executable: false,
  });
  t.mock.method(client, "listV2", async () => ({
    objects: [],
    isTruncated: true,
  }));
  await assert.rejects(io.list("prefix/", undefined, 20000), {
    code: "SKILL_COLLECTION_INVALID_PAGE",
  });
});

test("failed collection preparation never dispatches a Sandbox and releases its capacity reservation", async (t) => {
  const f = fixture(1),
    store = new MemoryStore(),
    service = new HarnessService(store, [], ["default"]);
  const manager = new SandboxManager(store, new AliyunE2BProvider(f.config));
  const create = t.mock.method(Sandbox, "create", async () => {
    throw Error("must not create");
  });
  await store.tx(actor.tenantId, (s) => {
    s.skills[f.skills[0]!.id] = f.skills[0]!;
  });
  const w = await service.createWorkspace(actor, "test");
  await assert.rejects(
    manager.execute(
      actor,
      w.id,
      "prepare-fails",
      "default",
      "ls",
      {},
      undefined,
      [f.skills[0]!.id],
    ),
    { code: "SKILL_COLLECTION_PUBLISHER_REQUIRED" },
  );
  assert.equal(create.mock.callCount(), 0);
  assert.equal((await manager.capacity.usage(actor)).user.active, 0);
  assert.equal((await manager.status(actor, w.id)).state, "released");
});

test("API rechecks the workspace lease after publishing and never returns a locator to a stale operation", async () => {
  const f = fixture(1),
    store = new MemoryStore(),
    service = new HarnessService(store, [], ["default"]);
  const w = await service.createWorkspace(actor, "test");
  await store.tx(actor.tenantId, (s) => {
    s.skills[f.skills[0]!.id] = f.skills[0]!;
    Object.assign(s.workspaces[w.id]!, {
      volumeId: "volume",
      bundle: "default",
      lock: { owner: "operation", expires: Date.now() + 60000, kind: "agent" },
    });
  });
  const put = f.io.put.bind(f.io);
  f.io.put = async (...args) => {
    await put(...args);
    if (args[0].includes("/ready/"))
      await store.tx(actor.tenantId, (s) => {
        s.workspaces[w.id]!.lock!.owner = "successor";
      });
  };
  const resolve = collectionService(store, f.config, f.publisher, () => true);
  const request = {
    volume: "volume",
    bundle: "default",
    scope: f.scope,
    operation: "operation",
    context: { tenantId: actor.tenantId, workspaceId: w.id },
    skills: f.skills.map(({ id, path, digest }) => ({ id, path, digest })),
  };
  await assert.rejects(resolve(request), {
    code: "SKILL_COLLECTION_LEASE_REQUIRED",
  });
  assert.ok(await resolve({ ...request, operation: "successor" }));
  await store.close();
});
