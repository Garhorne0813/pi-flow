import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  lstat,
} from "node:fs/promises";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { buildAPI } from "../src/api.js";
import { Fault, type Skill } from "../src/domain.js";
import { MemoryStore } from "../src/store.js";
import { HarnessService } from "../src/service.js";
import {
  DemoSandbox,
  SandboxManager,
  CubeProvider,
} from "../src/adapters/sandbox.js";
import {
  HostSkillPackages,
  readSkillZip,
  skillZipLimits,
  skillUploadRoot,
  uploadedSkillBinding,
} from "../src/skill-packages.js";
import { skillZip, skillMarkdown, type ZipInput } from "./helpers/skill-zip.js";
import { Sandbox, Volume, type CreateOptions } from "@cubesandbox/sdk";

async function rootFor(t: TestContext) {
  await mkdir("work", { recursive: true });
  const root = await mkdtemp(resolve("work/skill-upload-"));
  t.after(async () => {
    async function unseal(dir: string) {
      await chmod(dir, 0o755);
      for (const entry of await readdir(dir, { withFileTypes: true }))
        if (entry.isDirectory()) await unseal(dir + "/" + entry.name);
    }
    await unseal(root);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
const fields = {
  id: "review@v1",
  name: "Code review",
  description: "Review code",
  bundle: "default",
};
const archive = () =>
  skillZip([
    { path: "review/SKILL.md", content: skillMarkdown },
    {
      path: "review/scripts/review.sh",
      content: "#!/bin/sh\necho review\n",
      mode: 0o100755,
    },
    { path: "review/references/sample.bin", content: Buffer.from([0, 1, 255]) },
  ]);
function multipartBody(
  zip: Buffer,
  values: Record<string, string> = fields,
  fileField = "archive",
) {
  const boundary = "skill-upload-test";
  const parts = Object.entries(values).map(([key, value]) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
    ),
  );
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="review.zip"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  };
}
async function fixture(t: TestContext) {
  const root = await rootFor(t),
    store = new MemoryStore();
  const service = new HarnessService(
    store,
    [],
    ["default", "private"],
    undefined,
    {
      one: { bundles: ["default"], endpoints: [] },
      two: { bundles: ["private"], endpoints: [] },
    },
  );
  const packages = new HostSkillPackages(root);
  const app = buildAPI(
    service,
    async (header) => {
      if (!header) throw new Fault(401, "UNAUTHENTICATED");
      return {
        tenantId: header === "two" ? "two" : "one",
        userId: "admin",
        admin: header !== "user",
      };
    },
    new SandboxManager(store, new DemoSandbox()),
    undefined,
    packages,
  );
  t.after(async () => {
    await app.close();
    await store.close();
  });
  const upload = (
    zip = archive(),
    values: Record<string, string> = fields,
    auth = "admin",
  ) => {
    const body = multipartBody(zip, values);
    return app.inject({
      method: "POST",
      url: "/api/v1/admin/skills/upload",
      ...body,
      headers: { ...body.headers, authorization: auth },
    });
  };
  return { root, store, service, packages, app, upload };
}

test("ZIP accepts a root manifest or a single wrapper and preserves support files", async () => {
  const wrapped = await readSkillZip(archive());
  assert.deepEqual(
    wrapped.map((f) => f.path),
    ["SKILL.md", "scripts/review.sh", "references/sample.bin"],
  );
  assert.equal(wrapped[1]!.executable, true);
  assert.deepEqual(wrapped[2]!.data, Buffer.from([0, 1, 255]));
  const root = await readSkillZip(
    skillZip([
      { path: "SKILL.md", content: skillMarkdown },
      { path: ".DS_Store", content: "metadata" },
    ]),
  );
  assert.equal(root.length, 1);
  assert.equal(root[0]!.data.toString(), skillMarkdown);
});

const invalidCases: [string, ZipInput[]][] = [
  ["traversal", [{ path: "../escape", content: "bad" }]],
  ["absolute", [{ path: "/tmp/escape", content: "bad" }]],
  ["backslash", [{ path: "skill\\SKILL.md", content: skillMarkdown }]],
  ["symlink", [{ path: "link", content: "/etc/passwd", mode: 0o120777 }]],
  ["special file", [{ path: "device", mode: 0o20666 }]],
  [
    "encrypted",
    [{ path: "SKILL.md", content: skillMarkdown, encrypted: true }],
  ],
  [
    "CRC mismatch",
    [{ path: "SKILL.md", content: skillMarkdown, badCRC: true }],
  ],
  ["missing manifest", [{ path: "README.md", content: "No skill" }]],
  [
    "multiple skills",
    [
      { path: "one/SKILL.md", content: skillMarkdown },
      { path: "two/SKILL.md", content: skillMarkdown },
    ],
  ],
  [
    "duplicate",
    [
      { path: "SKILL.md", content: skillMarkdown },
      { path: "SKILL.md", content: skillMarkdown },
    ],
  ],
  [
    "case conflict",
    [
      { path: "SKILL.md", content: skillMarkdown },
      { path: "skill.md", content: "bad" },
    ],
  ],
  [
    "file-directory collision",
    [
      { path: "SKILL.md", content: skillMarkdown },
      { path: "scripts", content: "file" },
      { path: "scripts/run.py", content: "print(1)" },
    ],
  ],
  [
    "outside wrapper",
    [
      { path: "skill/SKILL.md", content: skillMarkdown },
      { path: "extra.txt", content: "bad" },
    ],
  ],
  ["nested manifest", [{ path: "a/b/SKILL.md", content: skillMarkdown }]],
  ["invalid UTF-8", [{ path: "SKILL.md", content: Buffer.from([0xff]) }]],
];
for (const [name, entries] of invalidCases)
  test(`rejects ${name} without extracting files`, async () => {
    await assert.rejects(readSkillZip(skillZip(entries)), {
      status: 400,
      code: "INVALID_SKILL_ZIP",
    });
  });
test("bounds compressed size, declared file size, expanded data and file count", async () => {
  await assert.rejects(
    readSkillZip(Buffer.alloc(skillZipLimits.maxArchiveBytes + 1)),
    { status: 413 },
  );
  await assert.rejects(
    readSkillZip(
      skillZip([
        {
          path: "SKILL.md",
          content: skillMarkdown,
          size: skillZipLimits.maxFileBytes + 1,
        },
      ]),
    ),
    { status: 413 },
  );
  const many = [
    { path: "SKILL.md", content: skillMarkdown },
    ...Array.from({ length: 1000 }, (_, i) => ({
      path: `files/${i}`,
      content: "x",
    })),
  ];
  await assert.rejects(readSkillZip(skillZip(many)), { status: 413 });
  const expanded = [
    { path: "SKILL.md", content: skillMarkdown },
    ...Array.from({ length: 5 }, (_, i) => ({
      path: `files/${i}`,
      content: Buffer.alloc(7 * 1024 * 1024),
    })),
  ];
  await assert.rejects(readSkillZip(skillZip(expanded)), { status: 413 });
});

test("admin upload stores immutable isolated contents and immediately registers a selectable Skill", async (t) => {
  const f = await fixture(t);
  const response = await f.upload();
  assert.equal(response.statusCode, 201, response.body);
  const skill = response.json<Skill>();
  assert.equal(skill.id, fields.id);
  assert.equal(skill.hostUpload!.files, 3);
  assert.equal(
    skill.digest,
    createHash("sha256").update(skillMarkdown).digest("hex"),
  );
  const binding = uploadedSkillBinding(skill, f.root)!;
  assert.ok("hostPath" in binding);
  assert.equal(
    await readFile(binding.hostPath + "/SKILL.md", "utf8"),
    skillMarkdown,
  );
  assert.deepEqual(
    await readFile(binding.hostPath + "/references/sample.bin"),
    Buffer.from([0, 1, 255]),
  );
  assert.equal(
    (await lstat(binding.hostPath + "/scripts/review.sh")).mode & 0o777,
    0o555,
  );
  assert.equal((await lstat(binding.hostPath + "/SKILL.md")).mode & 0o222, 0);
  const second = await f.upload();
  assert.equal(second.statusCode, 409);
  assert.equal(
    await readFile(binding.hostPath + "/SKILL.md", "utf8"),
    skillMarkdown,
  );
  const listed = await f.app.inject({
    url: "/api/v1/admin/skills",
    headers: { authorization: "admin" },
  });
  assert.equal(listed.json().items.length, 1);
  assert.ok(!listed.body.includes(f.root));
  const agent = await f.service.publish(
    { tenantId: "one", userId: "admin", admin: true },
    {
      name: "Review",
      systemPrompt: "Review",
      model: { provider: "demo", modelId: "demo" },
      tools: ["read"],
      skills: [skill.id],
      skillBundle: "default",
    },
  );
  assert.deepEqual(agent.config.skills, [skill.id]);
  const audit = await f.store.read("one", (s) => s.audit);
  assert.ok(audit.some((e) => e.action === "skill.upload"));
});

test("authentication, tenant grants and storage availability are enforced before host writes", async (t) => {
  const f = await fixture(t);
  const unauth = multipartBody(archive());
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/v1/admin/skills/upload",
        ...unauth,
      })
    ).statusCode,
    401,
  );
  assert.equal((await f.upload(archive(), fields, "user")).statusCode, 403);
  assert.equal(
    (await f.upload(archive(), { ...fields, bundle: "private" })).statusCode,
    400,
  );
  assert.equal(
    (
      await f.upload(archive(), {
        id: fields.id,
        name: fields.name,
        bundle: fields.bundle,
        hostPath: "/etc/escape",
      })
    ).statusCode,
    400,
  );
  assert.deepEqual(await readdir(f.root), []);
  const first = (await f.upload()).json<Skill>();
  const second = (
    await f.upload(archive(), { ...fields, bundle: "private" }, "two")
  ).json<Skill>();
  assert.notEqual(first.hostUpload!.key, second.hostUpload!.key);
  assert.equal(
    (
      await f.app.inject({
        url: "/api/v1/admin/skills",
        headers: { authorization: "two" },
      })
    ).json().items.length,
    1,
  );
  assert.equal(
    (
      await f.upload(skillZip([{ path: "../outside", content: "bad" }]), {
        ...fields,
        id: "bad@v1",
      })
    ).statusCode,
    400,
  );
  const missing = new HostSkillPackages(f.root + "/missing");
  await assert.rejects(missing.prepare("one", fields, archive()), {
    status: 503,
  });
});

test("parallel duplicate IDs never replace an installed version", async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all([f.upload(), f.upload()]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 409]);
  const skill = responses.find((r) => r.statusCode === 201)!.json<Skill>();
  assert.equal(
    await readFile(
      (uploadedSkillBinding(skill, f.root)! as { hostPath: string }).hostPath +
        "/SKILL.md",
      "utf8",
    ),
    skillMarkdown,
  );
  assert.equal(
    (await f.store.read("one", (s) => Object.keys(s.skills))).length,
    1,
  );
});

test("upload roots cannot escape approvals, overlap deployment sources or follow symlinks", async (t) => {
  const root = await rootFor(t),
    outside = await rootFor(t);
  assert.equal(skillUploadRoot([root]), root);
  assert.equal(skillUploadRoot([]), undefined);
  assert.throws(() => skillUploadRoot([root], outside), {
    code: "SKILL_HOST_PATH_DENIED",
  });
  assert.throws(
    () =>
      skillUploadRoot([root], root, {
        one: {
          bundle: "default",
          path: "/skills/a/SKILL.md",
          hostPath: root + "/uploads",
        },
      }),
    { code: "SKILL_HOST_SOURCE_CONFLICT" },
  );
  await symlink(outside, root + "/uploads");
  await assert.rejects(
    new HostSkillPackages(root).prepare("one", fields, archive()),
    { code: "SKILL_HOST_SOURCE_UNSAFE" },
  );
  assert.deepEqual(await readdir(outside), []);
});

const decode = (cmd: string) =>
  JSON.parse(Buffer.from(cmd.split("'").at(-2)!, "base64").toString());
test("a fresh Worker provider derives uploaded host mounts and retains read-only preflight on create and reuse", async (t) => {
  const f = await fixture(t);
  const skill = (await f.upload()).json<Skill>();
  let options: CreateOptions | undefined;
  const calls: { args: Record<string, unknown> }[] = [];
  const instance = {
    sandboxId: "upload-box",
    trafficAccessToken: "token",
    commands: {
      run: async (cmd: string) => {
        calls.push(decode(cmd));
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    },
  } as unknown as Sandbox;
  t.mock.method(
    Volume,
    "connect",
    async () => ({ volumeId: "workspace" }) as Volume,
  );
  t.mock.method(Sandbox, "create", async (input: CreateOptions) => {
    options = input;
    return instance;
  });
  t.mock.method(Sandbox, "connect", async () => instance);
  const provider = new CubeProvider({}, "sandbox", "nfs", [f.root]);
  const created = await provider.create("workspace", "default", [skill]);
  assert.equal(created.sandboxId, "upload-box");
  assert.deepEqual(JSON.parse(options!.metadata!["host-mount"]!), [
    {
      hostPath: `${f.root}/uploads/${skill.hostUpload!.key}/content`,
      mountPath: skill.path.slice(0, -9),
      readOnly: true,
    },
  ]);
  assert.deepEqual(calls[0]!.args._hostSkillMounts, [skill.path.slice(0, -9)]);
  await provider.execute("upload-box", "read", {
    path: "/workspace/a",
    _skillIds: [skill.id],
    _skillManifests: [{ path: skill.path, digest: skill.digest }],
    _skillHostUploads: [skill],
  });
  assert.deepEqual(calls[1]!.args._hostSkillMounts, [skill.path.slice(0, -9)]);
  assert.throws(
    () => new CubeProvider({}, "sandbox", "nfs", []).scope("default", [skill]),
    { code: "SKILL_VOLUME_NOT_REGISTERED" },
  );
});

test("malformed multipart, missing files and oversized uploads never touch host storage", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/v1/admin/skills/upload",
        headers: { authorization: "admin" },
        payload: fields,
      })
    ).statusCode,
    415,
  );
  const wrong = multipartBody(archive(), fields, "hostPath");
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/v1/admin/skills/upload",
        ...wrong,
        headers: { ...wrong.headers, authorization: "admin" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await f.upload(Buffer.alloc(skillZipLimits.maxArchiveBytes + 1)))
      .statusCode,
    413,
  );
  assert.deepEqual(await readdir(f.root), []);
});

test("known registration failure cleans up, but a possibly committed transaction retains immutable files", async (t) => {
  const f = await fixture(t);
  const original = f.store.tx.bind(f.store);
  let failBefore = true;
  t.mock.method(
    f.store,
    "tx",
    async (
      tenant: string,
      fn: (s: import("../src/domain.js").State) => unknown,
    ) => {
      if (failBefore) {
        failBefore = false;
        throw new Error("transaction unavailable");
      }
      return original(tenant, fn);
    },
  );
  assert.equal((await f.upload()).statusCode, 500);
  assert.deepEqual(await readdir(f.root + "/uploads"), []);
  t.mock.restoreAll();
  let failAfter = true;
  t.mock.method(
    f.store,
    "tx",
    async (
      tenant: string,
      fn: (s: import("../src/domain.js").State) => unknown,
    ) => {
      const result = await original(tenant, fn);
      if (failAfter) {
        failAfter = false;
        throw new Error("commit acknowledgement lost");
      }
      return result;
    },
  );
  assert.equal((await f.upload()).statusCode, 500);
  const skill = await f.store.read("one", (s) => s.skills[fields.id]!);
  const binding = uploadedSkillBinding(skill, f.root)!;
  assert.ok("hostPath" in binding);
  assert.equal(
    await readFile(binding.hostPath + "/SKILL.md", "utf8"),
    skillMarkdown,
  );
  assert.equal((await f.upload()).statusCode, 409);
});

test("upload concurrency is bounded and reservations are released on errors", async () => {
  const packages = new HostSkillPackages(undefined);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const one = packages.withSlot(() => gate),
    two = packages.withSlot(() => gate);
  await assert.rejects(
    packages.withSlot(async () => {}),
    { status: 429, code: "SKILL_UPLOAD_BUSY" },
  );
  release();
  await Promise.all([one, two]);
  await assert.rejects(
    packages.withSlot(async () => {
      throw new Error("failed");
    }),
    /failed/,
  );
  assert.equal(await packages.withSlot(async () => 42), 42);
});

test("expiry while waiting for the registration transaction denies publication and removes the package", async (t) => {
  const f = await fixture(t),
    actor = {
      tenantId: "one",
      userId: "admin",
      admin: true,
      expiresAt: Date.now() + 60000,
    };
  const app = buildAPI(
    f.service,
    async () => actor,
    new SandboxManager(f.store, new DemoSandbox()),
    undefined,
    f.packages,
  );
  t.after(() => app.close());
  const original = f.store.tx.bind(f.store);
  let expire = true;
  t.mock.method(
    f.store,
    "tx",
    async (
      tenant: string,
      fn: (s: import("../src/domain.js").State) => unknown,
    ) => {
      if (expire) {
        expire = false;
        actor.expiresAt = Date.now() - 1;
      }
      return original(tenant, fn);
    },
  );
  const body = multipartBody(archive());
  const result = await app.inject({
    method: "POST",
    url: "/api/v1/admin/skills/upload",
    ...body,
    headers: { ...body.headers, authorization: "admin" },
  });
  assert.equal(result.statusCode, 401);
  assert.deepEqual(await readdir(f.root + "/uploads"), []);
  assert.equal(
    await f.store.read("one", (s) => s.skills[fields.id]),
    undefined,
  );
});
