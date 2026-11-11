import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import OSS from "ali-oss";
import { Sandbox, type SandboxOpts } from "e2b";
import { buildAPI } from "../src/api/server.js";
import { Fault, type Skill, type State } from "../src/domain/model.js";
import { HarnessService } from "../src/domain/service.js";
import { MemoryStore } from "../src/storage/store.js";
import { collectionId, collectionPath } from "../src/skills/collection.js";
import { SandboxManager } from "../src/sandbox/manager.js";
import {
  AliyunConfigSchema,
  AliyunE2BProvider,
} from "../src/sandbox/aliyun-provider.js";
import {
  OssSkillPackages,
  ossPackageWriter,
  type OssPackageWriter,
} from "../src/skills/oss-packages.js";
import {
  uploadedOssSkillBinding,
  ossSkillStorageId,
  uploadedOssSkillPath,
} from "../src/skills/oss-storage.js";
import { uploadedSkillBinding } from "../src/skills/packages.js";
import { telemetry } from "../src/observability/telemetry.js";
import { skillZip, skillMarkdown } from "./helpers/skill-zip.js";

const config = () =>
  AliyunConfigSchema.parse({
    apiKey: "test-sandbox-key",
    apiUrl: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
    domain: "cn-hangzhou.sandbox.aliyuncs.com",
    template: "pi-flow-test",
    user: "user",
    bucket: "pi-flow-test",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    roleArn: "acs:ram::123456789:role/pi-flow",
  });
const fields = {
  id: "review@v1",
  name: "Review",
  description: "Review",
  bundle: "default",
};
const binary = Buffer.from([0, 1, 255]);
const archive = () =>
  skillZip([
    { path: "review/SKILL.md", content: skillMarkdown },
    {
      path: "review/scripts/review.sh",
      content: "#!/bin/sh\necho review\n",
      mode: 0o100755,
    },
    { path: "review/references/input.bin", content: binary },
  ]);
const actor = { tenantId: "one", userId: "admin", admin: true };
function memoryWriter() {
  const objects = new Map<string, Buffer>();
  const attempts: string[] = [],
    deleted: string[][] = [];
  const writer: OssPackageWriter = {
    async put(key, data) {
      assert.ok(!objects.has(key), "must not overwrite existing objects");
      attempts.push(key);
      objects.set(key, Buffer.from(data));
    },
    async remove(keys) {
      deleted.push([...keys]);
      for (const key of keys) objects.delete(key);
    },
  };
  return { writer, objects, attempts, deleted };
}
function multipart(zip = archive(), values = fields) {
  const boundary = "oss-skill-test";
  const parts = Object.entries(values).map(([key, value]) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
    ),
  );
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="skill.zip"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(parts),
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      authorization: "admin",
    },
  };
}
async function fixture(t: TestContext, disabled = false) {
  const transport = memoryWriter();
  const storage = config(),
    packages = new OssSkillPackages(
      storage,
      disabled ? undefined : transport.writer,
    );
  const store = new MemoryStore(),
    service = new HarnessService(store, [], ["default"]);
  const provider = new AliyunE2BProvider(storage, async (r) => ({
      selectionId: collectionId(r.volume, r.scope),
      artifact: "a".repeat(32),
    })),
    manager = new SandboxManager(store, provider);
  const app = buildAPI(
    service,
    async (header) => {
      if (!header) throw new Fault(401, "UNAUTHENTICATED");
      return {
        ...actor,
        tenantId: header === "other" ? "two" : "one",
        admin: header !== "user",
      };
    },
    manager,
    undefined,
    packages,
  );
  t.after(async () => {
    await app.close();
    await store.close();
  });
  const upload = (zip = archive(), values = fields) =>
    app.inject({
      method: "POST",
      url: "/api/v1/admin/skills/upload",
      ...multipart(zip, values),
    });
  return {
    ...transport,
    storage,
    packages,
    store,
    service,
    provider,
    manager,
    app,
    upload,
  };
}

test("OSS console ZIP upload publishes binary and auxiliary files and works in a fresh Worker without mappings", async (t) => {
  const f = await fixture(t);
  const response = await f.upload();
  assert.equal(response.statusCode, 201, response.body);
  const skill = response.json<Skill>();
  assert.equal(skill.hostUpload, undefined);
  assert.equal(skill.ossUpload!.files, 3);
  const mountDir = skill.path.slice(0, -"/SKILL.md".length);
  assert.equal(mountDir.length, 60);
  assert.equal(
    Buffer.from(mountDir.split("/").at(-1)!, "base64url").toString("hex"),
    skill.ossUpload!.key,
  );
  assert.notEqual(
    uploadedOssSkillPath("a".repeat(64)),
    uploadedOssSkillPath("a".repeat(63) + "b"),
  );
  assert.equal(skill.ossUpload!.storageId, ossSkillStorageId(f.storage));
  assert.equal(
    skill.digest,
    createHash("sha256").update(skillMarkdown).digest("hex"),
  );
  const binding = uploadedOssSkillBinding(skill, f.storage)!;
  assert.equal(
    f.objects.get(binding.bucketPath.slice(1) + "/SKILL.md")!.toString(),
    skillMarkdown,
  );
  assert.deepEqual(
    f.objects.get(binding.bucketPath.slice(1) + "/references/input.bin"),
    binary,
  );
  const uploadedConfig = await f.app.inject({
    url: "/api/v1/admin/configuration",
    headers: { authorization: "admin" },
  });
  assert.equal(uploadedConfig.json().skillUploads.enabled, true);
  const options: SandboxOpts[] = [],
    commands: any[] = [];
  const run = async (command: string) => {
    commands.push(
      JSON.parse(Buffer.from(command.split("'").at(-2)!, "base64").toString()),
    );
    return {
      stdout: JSON.stringify({ text: skillMarkdown }),
      stderr: "",
      exitCode: 0,
    };
  };
  t.mock.method(
    Sandbox,
    "create",
    async (_template: string, opts: SandboxOpts) => {
      options.push(opts);
      return { sandboxId: "box", commands: { run } };
    },
  );
  t.mock.method(Sandbox, "connect", async () => ({ commands: { run } }));
  const w = await f.service.createWorkspace(actor, "test");
  await f.manager.execute(
    actor,
    w.id,
    "first",
    "default",
    "read",
    { path: skill.path },
    undefined,
    [skill.id],
  );
  const worker = new SandboxManager(f.store, new AliyunE2BProvider(config()));
  assert.deepEqual(
    await worker.execute(
      actor,
      w.id,
      "fresh-worker",
      "default",
      "read",
      {
        path: skill.path,
        _skillOssUploads: [
          {
            id: skill.id,
            path: "/skills/evil/SKILL.md",
            ossUpload: { key: "evil" },
          },
        ],
      },
      undefined,
      [skill.id],
    ),
    { text: skillMarkdown },
  );
  assert.equal(options.length, 1);
  const mounts = JSON.parse(
    options[0]!.metadata!["fc.sandbox.storage.oss"]!,
  ).mountPoints;
  assert.deepEqual(mounts[1], {
    bucketName: f.storage.bucket,
    endpoint: f.storage.endpoint,
    mountDir: "/skills",
    bucketPath: collectionPath(f.storage.skillCollectionPrefix, {
      selectionId: collectionId(
        (await f.store.read("one", (s) => s.workspaces[w.id]!.volumeId))!,
        f.provider.scope("default", [skill]),
      ),
      artifact: "a".repeat(32),
    }),
    readOnly: true,
  });
  assert.deepEqual(commands.at(-1).args._hostSkillMounts, [mounts[1].mountDir]);
  await assert.rejects(
    worker.execute(
      { ...actor, tenantId: "two" },
      w.id,
      "other",
      "default",
      "read",
      { path: skill.path },
      undefined,
      [skill.id],
    ),
  );
  await f.store.tx("one", (s) => {
    s.skills[skill.id]!.enabled = false;
  });
  await assert.rejects(
    worker.execute(
      actor,
      w.id,
      "revoked",
      "default",
      "read",
      { path: skill.path },
      undefined,
      [skill.id],
    ),
    { code: "SKILL_DENIED" },
  );
});

test("OSS packages use separate tenant/attempt namespaces and reject storage or path substitution", async () => {
  const f = memoryWriter(),
    storage = config(),
    publisher = new OssSkillPackages(storage, f.writer);
  const a = await publisher.prepare("one", fields, archive());
  const b = await publisher.prepare("two", fields, archive());
  const retry = await publisher.prepare("one", fields, archive());
  assert.equal(
    new Set([
      a.skill.ossUpload!.key,
      b.skill.ossUpload!.key,
      retry.skill.ossUpload!.key,
    ]).size,
    3,
  );
  assert.equal(a.skill.versionDigest, b.skill.versionDigest);
  for (const skill of [
    { ...a.skill, path: "/skills/evil/SKILL.md" },
    { ...a.skill, ossUpload: { ...a.skill.ossUpload!, key: "../escape" } },
    { ...a.skill, ossUpload: { ...a.skill.ossUpload!, storageId: "other" } },
  ])
    assert.throws(() => uploadedOssSkillBinding(skill, storage), {
      code: "ALIYUN_SKILL_NOT_PUBLISHED",
    });
  assert.throws(() => uploadedSkillBinding(a.skill), {
    code: "SKILL_STORAGE_PROVIDER_MISMATCH",
  });
  assert.throws(
    () =>
      new AliyunE2BProvider({
        ...storage,
        skillUploadPrefix: "/elsewhere",
      }).scope("default", [a.skill]),
    { code: "ALIYUN_SKILL_NOT_PUBLISHED" },
  );
  await a.discard();
  assert.equal(f.objects.size, 6);
  assert.ok(
    [...f.objects.keys()].every((key) => !key.includes(a.skill.ossUpload!.key)),
  );
});

test("concurrent OSS uploads of the same ID clean only the losing package", async (t) => {
  const f = await fixture(t),
    put = f.writer.put.bind(f.writer);
  let starts = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  f.writer.put = async (...args) => {
    await put(...args);
    if (args[0].endsWith("/SKILL.md")) {
      if (++starts === 2) release();
      await gate;
    }
  };
  const results = await Promise.all([f.upload(), f.upload()]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  const skill = await f.store.read("one", (s) => s.skills[fields.id]!);
  assert.equal(f.deleted.length, 1);
  assert.equal(f.objects.size, 3);
  assert.ok(
    [...f.objects.keys()].every((key) => key.includes(skill.ossUpload!.key)),
  );
});

test("OSS upload validates archives and authentication before creating objects", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/v1/admin/skills/upload",
        ...multipart(),
        headers: { ...multipart().headers, authorization: "user" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.upload(
        skillZip([
          { path: "SKILL.md", content: skillMarkdown, mode: 0o120777 },
        ]),
      )
    ).statusCode,
    400,
  );
  assert.equal((await f.upload(Buffer.from("invalid"))).statusCode, 400);
  assert.equal(
    (await f.upload(archive(), { ...fields, bundle: "unknown" })).statusCode,
    400,
  );
  assert.equal(f.attempts.length, 0);
  assert.equal((await fixture(t, true)).packages.configuration.enabled, false);
  assert.equal((await (await fixture(t, true)).upload()).statusCode, 503);
});

test("token expiry during OSS publication removes the package and refuses registration", async (t) => {
  const f = await fixture(t);
  const identity = { ...actor, expiresAt: Date.now() + 60000 };
  const app = buildAPI(
    f.service,
    async () => identity,
    f.manager,
    undefined,
    f.packages,
  );
  t.after(() => app.close());
  const put = f.writer.put.bind(f.writer);
  f.writer.put = async (...args) => {
    await put(...args);
    identity.expiresAt = Date.now() - 1;
  };
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/skills/upload",
    ...multipart(),
  });
  assert.equal(response.statusCode, 401);
  assert.equal(f.objects.size, 0);
  assert.equal(
    await f.store.read("one", (s) => s.skills[fields.id]),
    undefined,
  );
});

test("partial OSS failure cleans attempted objects including a lost write acknowledgement, with no registration", async (t) => {
  const f = await fixture(t),
    put = f.writer.put.bind(f.writer);
  f.objects.set("unrelated/keep", Buffer.from("safe"));
  let fail = true;
  f.writer.put = async (...args) => {
    await put(...args);
    if (fail && f.attempts.length === 2) {
      fail = false;
      throw new Error("secret-credential-in-sdk-error");
    }
  };
  const response = await f.upload();
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, "SKILL_OSS_PUBLISH_FAILED");
  assert.ok(!response.body.includes("secret-credential"));
  assert.deepEqual(f.deleted[0], f.attempts);
  assert.deepEqual([...f.objects.keys()], ["unrelated/keep"]);
  assert.equal(
    await f.store.read("one", (s) => s.skills[fields.id]),
    undefined,
  );
  assert.equal((await f.upload()).statusCode, 201);
});

test("OSS cleanup failure is explicit and logged without SDK credential details", async (t) => {
  const f = await fixture(t),
    records: Record<string, unknown>[] = [];
  t.mock.method(telemetry, "sink", (record) => {
    records.push(record);
  });
  f.writer.put = async () => {
    throw Error("private-publisher-secret");
  };
  f.writer.remove = async () => {
    throw Error("private-publisher-secret");
  };
  const response = await f.upload();
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, "SKILL_OSS_CLEANUP_UNCONFIRMED");
  assert.equal(records[0]!.operation, "skill_oss_cleanup");
  assert.match(records[0]!.callId as string, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(records).includes("private-publisher-secret"));
  assert.equal(
    await f.store.read("one", (s) => s.skills[fields.id]),
    undefined,
  );
});

test("known registry failure removes the OSS package; ambiguous commit retains it and refuses overwrite", async (t) => {
  const f = await fixture(t),
    tx = f.store.tx.bind(f.store);
  t.mock.method(f.store, "tx", async () => {
    throw new Error("unavailable");
  });
  assert.equal((await f.upload()).statusCode, 500);
  assert.equal(f.objects.size, 0);
  t.mock.restoreAll();
  t.mock.method(
    f.store,
    "tx",
    async (tenant: string, fn: (s: State) => unknown) => {
      await tx(tenant, fn);
      throw new Error("commit acknowledgement lost");
    },
  );
  assert.equal((await f.upload()).statusCode, 500);
  assert.equal(f.objects.size, 3);
  assert.equal((await f.upload()).statusCode, 409);
  const skill = await f.store.read("one", (s) => s.skills[fields.id]!);
  assert.ok(
    [...f.objects.keys()].every((key) => key.includes(skill.ossUpload!.key)),
  );
});

test("OSS SDK transport uses V4, STS, bounded no-overwrite uploads and checks every cleanup acknowledgement", async (t) => {
  let putOptions: OSS.PutObjectOptions | undefined;
  const put = t.mock.method(
    OSS.prototype,
    "put",
    async function (
      this: OSS,
      _key: string,
      _data: Buffer,
      options: OSS.PutObjectOptions,
    ) {
      putOptions = options;
      assert.equal(this.options.authorizationV4, true);
      assert.equal(this.options.stsToken, "test-sts");
    },
  );
  let complete = true;
  t.mock.method(
    OSS.prototype,
    "deleteMulti",
    async (_keys: string[], options: OSS.DeleteMultiOptions) => {
      assert.equal(options.quiet, false);
      assert.equal(options.timeout, 20000);
      return {
        deleted: complete ? _keys.map((Key) => ({ Key })) : [],
        res: {},
      };
    },
  );
  const writer = ossPackageWriter(config(), {
    ALIYUN_OSS_REGION: "oss-cn-hangzhou",
    ALIYUN_OSS_ACCESS_KEY_ID: "test-id",
    ALIYUN_OSS_ACCESS_KEY_SECRET: "test-secret",
    ALIYUN_OSS_SECURITY_TOKEN: "test-sts",
  })!;
  await writer.put("package/script.sh", Buffer.from("script"), true, 1234);
  assert.equal(put.mock.callCount(), 1);
  assert.equal(putOptions!.timeout, 1234);
  assert.deepEqual(putOptions!.headers, {
    "x-oss-forbid-overwrite": "true",
    "x-oss-meta-mode": String(0o100555),
  });
  await writer.remove(["package/script.sh"]);
  complete = false;
  await assert.rejects(writer.remove(["package/script.sh"]), {
    code: "SKILL_OSS_CLEANUP_UNCONFIRMED",
  });
  assert.equal(ossPackageWriter(config(), {}), undefined);
  assert.throws(() =>
    ossPackageWriter(config(), { ALIYUN_OSS_ACCESS_KEY_ID: "partial" }),
  );
  assert.throws(
    () =>
      new AliyunE2BProvider({
        ...config(),
        skillUploadPrefix: "/pi-flow/workspaces/uploads",
      }),
  );
});
